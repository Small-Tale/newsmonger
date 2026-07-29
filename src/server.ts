import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import type { KeyVerifier } from './ai/verify-key.js';
import { verifyApiKey } from './ai/verify-key.js';
import { Attendance } from './attendance.js';
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
    // Debug aid (e.g. verifying the Tauri webview actually hits the server).
    if (process.env['NEWS_LOG_REQUESTS'] === '1') {
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
        s.on('error', reject);
      });
      return {
        port,
        close: () => {
          server.close();
        },
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
