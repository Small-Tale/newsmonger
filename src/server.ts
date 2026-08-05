import fs from 'node:fs';
import { Server as HttpServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import type { ProviderProbe } from './ai/providers/index.js';
import { probeProviders } from './ai/providers/index.js';
import type { KeyVerifier } from './ai/verify-key.js';
import { verifyApiKey } from './ai/verify-key.js';
import type { KeysResp } from './api/schemas.js';
import { Attendance } from './attendance.js';
import type { Backups } from './backup.js';
import type { CheckRunner } from './checks.js';
import type { Store } from './db/store.js';
import type { DiscoveryService } from './discovery.js';
import { originGuard } from './origin-guard.js';
import { registerApi } from './routes/api.js';
import { registerPages } from './routes/pages.js';
import type { AppEnv } from './types.js';
import { ClearUndoBuffer } from './undo.js';

export const DEFAULT_PORT = 4187;
const PORT_FALLBACK_ATTEMPTS = 20;

/**
 * How long an idle connection is held open for reuse (NEWS-246).
 *
 * Node's default is **5 seconds**, and the client polls `/api/state` every
 * **4** (`POLL_INTERVAL_MS`). One second of headroom between "we will keep this
 * socket" and "we will ask again" is not headroom at all: any jitter — a busy
 * machine, a GC pause, an interval drifting late — and the server has already
 * closed the connection, so the next poll opens a fresh TCP connection and
 * leaves the old one in `TIME_WAIT`.
 *
 * A page polling forever therefore churns a socket every 4 seconds instead of
 * reusing one, on exactly the machines least able to afford it. Measured on the
 * E2E suite: **457 sockets in `TIME_WAIT`** at peak against 14 established, on
 * macOS, whose `TIME_WAIT` is 30 s. Windows holds them for **120 s** by default,
 * four times as long from the same rate — which is how a Windows runner reaches
 * `ERR_NO_BUFFER_SPACE` on a `page.goto` while every other platform is fine.
 *
 * 30 seconds is not tuning to the current interval, it is clearing it by a
 * margin no plausible jitter closes. It costs an idle socket per open tab on a
 * localhost-only server, which is nothing; the timeout exists to stop *remote*
 * clients holding connections open, and there are none here.
 *
 * `headersTimeout` must stay above it — Node destroys a socket whose headers
 * have not arrived in time, and setting the two the other way round makes a
 * kept-alive connection abort mid-request. Node's default is 60 s, comfortably
 * clear, but it is set explicitly so the ordering is visible rather than
 * inherited.
 */
const KEEP_ALIVE_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 35_000;

const STATIC_TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
};

/** Locate the built client assets, whether running from source (tsx) or from dist. */
function clientDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, '../dist/client'), path.join(here, 'client')];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return candidates[0] ?? '';
}

/** Build the Hono app with its dependencies injected (unit-testable via `app.request`). */
export function createApp(deps: {
  store: Store;
  runner: CheckRunner;
  attendance?: Attendance;
  dataDir?: string;
  /**
   * Checks a key against its vendor before storing it (NEWS-78). Null disables
   * the check — what `--ai-test` passes, so E2E can save obviously-fake keys.
   */
  verifyKey?: KeyVerifier | null;
  /**
   * Topic discovery (NEWS-125). Optional so tests that never touch `/api/discover`
   * need not construct one; the route 503s rather than throwing when it is absent.
   */
  discovery?: DiscoveryService;
  /** Undo buffer for cleared topics (NEWS-145). Defaults to a fresh one per app. */
  undo?: ClearUndoBuffer;
  /**
   * Backup snapshots (NEWS-192). Optional so tests need not construct one; the
   * "back up now" route reports the feature as unconfigured rather than throwing.
   */
  backups?: Backups;
  /**
   * What fills the settings provider picker (NEWS-315). Defaults to the real
   * probe; `--demo` passes a fixed one so a capture photographs the app rather
   * than the capturing machine's signed-in CLIs.
   */
  probe?: ProviderProbe;
  /**
   * A fixed API-key panel for `--demo` (NEWS-315). The real route reports which
   * keys are configured, where each came from, and what the OS calls its
   * credential store — all facts about the capturing machine.
   */
  demoKeys?: KeysResp;
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // Same instance the CheckRunner consults, when the caller passes one; tests
  // that don't care get a standalone tracker.
  const attendance = deps.attendance ?? new Attendance();
  const undo = deps.undo ?? new ClearUndoBuffer();
  // First, before anything reads a body or touches state (NEWS-86).
  app.use('*', originGuard());
  app.use('*', async (c, next) => {
    c.set('store', deps.store);
    c.set('runner', deps.runner);
    c.set('attendance', attendance);
    c.set('dataDir', deps.dataDir ?? deps.store.dataDir);
    c.set('verifyKey', deps.verifyKey === undefined ? verifyApiKey : deps.verifyKey);
    c.set('discovery', deps.discovery ?? null);
    c.set('undo', undo);
    c.set('backups', deps.backups ?? null);
    c.set('probe', deps.probe ?? probeProviders);
    c.set('demoKeys', deps.demoKeys ?? null);
    // Debug aid (e.g. verifying the Tauri webview actually hits the server).
    if (process.env['NEWSMONGER_LOG_REQUESTS'] === '1') {
      console.error(`[req] ${c.req.method} ${c.req.path}`);
    }
    await next();
  });

  const assets = clientDir();
  app.get('/static/:file', (c) => {
    const file = c.req.param('file');
    // Path traversal guard: single flat directory, no separators.
    if (file.includes('/') || file.includes('\\') || file.includes('..')) return c.notFound();
    const full = path.join(assets, file === 'app.js' ? 'app.global.js' : file);
    if (!fs.existsSync(full)) return c.notFound();
    const type = STATIC_TYPES[path.extname(full)] ?? 'application/octet-stream';
    return c.body(fs.readFileSync(full), 200, { 'Content-Type': type });
  });

  registerApi(app);
  registerPages(app);
  return app;
}

export interface StartedServer {
  port: number;
  close(): void;
  /**
   * Idle keep-alive window actually applied, so a test can assert it rather
   * than trusting the assignment above (NEWS-246).
   */
  keepAliveTimeoutMs: number;
}

/**
 * Start the HTTP server bound to 127.0.0.1. Unless `strictPort` is set, falls
 * back to the next port (up to 20 attempts) when the requested one is busy.
 */
export async function startServer(
  app: Hono<AppEnv>,
  options: { port?: number; strictPort?: boolean } = {},
): Promise<StartedServer> {
  const basePort = options.port ?? DEFAULT_PORT;
  const attempts = options.strictPort === true ? 1 : PORT_FALLBACK_ATTEMPTS;
  let lastError: unknown = null;
  for (let i = 0; i < attempts; i++) {
    const port = basePort + i;
    try {
      const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
        const s = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
          resolve(s);
        });
        // Narrowed rather than cast: `serve()` returns a union that includes an
        // HTTP/2 server, which has neither property. We never ask for HTTP/2 —
        // no `createServer` override is passed — so this branch is always the
        // one taken, and if that ever changes the timeouts are skipped instead
        // of a cast lying about the shape.
        if (s instanceof HttpServer) {
          s.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
          s.headersTimeout = HEADERS_TIMEOUT_MS;
        }
        s.on('error', reject);
      });
      // The port the OS actually bound, not the one asked for. They differ only
      // when the caller passes 0 ("any free port"), which is what a test wants
      // so it can never collide with a dev server or another test — and
      // reporting the request rather than the result would hand it a 0.
      const bound = server.address();
      return {
        port: typeof bound === 'object' && bound !== null ? bound.port : port,
        close: () => {
          server.close();
        },
        keepAliveTimeoutMs: server instanceof HttpServer ? server.keepAliveTimeout : 0,
      };
    } catch (err) {
      lastError = err;
      if (!isAddrInUse(err)) throw err;
    }
  }
  throw new Error(`no free port found starting at ${basePort}: ${String(lastError)}`);
}

function isAddrInUse(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
}
