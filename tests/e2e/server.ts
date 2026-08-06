import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { e2ePort, e2eWorkerRole } from '../helpers/e2e-port.js';

/**
 * One `--ai-test` server per Playwright worker (NEWS-321).
 *
 * Until this, `playwright.config.ts` declared a single `webServer` and the suite
 * ran `workers: 1` because every spec shared it. Playwright's `webServer` is
 * **global** — one instance for the whole run, with no per-worker form — so
 * sharding meant taking the server out of the config entirely and spawning it
 * from a worker-scoped fixture instead. This module is that spawn.
 *
 * Everything a worker owns is worker-scoped: its port (`e2eWorkerRole`, inside
 * the window NEWS-287 derives per checkout), its data directory, and its
 * process. Two workers therefore share nothing at all, which is what makes
 * `resetSharedState` still mean what it says — it empties *this worker's*
 * server, and no other worker can be looking at it.
 *
 * **Coverage needs no per-worker directory.** `NODE_V8_COVERAGE` names its
 * output `coverage-<pid>-…json`, so N servers writing into one
 * `.coverage-tmp/server` produce N distinct files and `scripts/merge-coverage.mjs`
 * picks them all up unchanged. That was the part expected to be hard.
 */

/** A running server and the URL to talk to it. */
export interface E2EServer {
  port: number;
  base: string;
  dataDir: string;
}

/** How long a worker waits for its own server to answer `/healthz`. */
const BOOT_TIMEOUT_MS = 90_000;

async function healthy(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/healthz`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Boot this worker's server and wait for it to answer.
 *
 * The client bundle is **not** built here. It used to ride on the `webServer`
 * command (`npm run build:client:dev && …`), which was fine for one server and
 * is four concurrent esbuild+sass runs writing the same files for four. It moved
 * to `globalSetup`, which runs once before any worker starts.
 */
export async function startServer(parallelIndex: number): Promise<{ server: E2EServer; stop: () => Promise<void> }> {
  const port = e2ePort(e2eWorkerRole(parallelIndex));
  const base = `http://127.0.0.1:${String(port)}`;
  // pid *and* worker: the pid keeps runs apart (a data dir wants to be fresh),
  // the worker index keeps this run's own servers apart.
  const dataDir = path.join(os.tmpdir(), `newsmonger-e2e-${String(process.pid)}-w${String(parallelIndex)}`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });

  // `node --import tsx/esm`, not the `tsx` CLI (NEWS-299) — same loader, same
  // source, same coverage, and no unix socket for a command sandbox to deny.
  // Pinned by `tests/unit/sandboxable.test.ts`.
  const child: ChildProcess = spawn(
    process.execPath,
    [
      '--import',
      'tsx/esm',
      'src/cli.ts',
      '--no-open',
      '--strict-port',
      '--ai-test',
      '--port',
      String(port),
      '--data-dir',
      dataDir,
    ],
    {
      cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Key flows are driven through the real UI, so the server needs a
        // keychain — but never the developer's own, which would leave entries
        // behind and can block on an OS authorization prompt.
        NEWSMONGER_FAKE_KEYCHAIN: '1',
        // No background sweeps for the length of a run (NEWS-238). A scheduled
        // check is an actor no test asked for: it checks never-checked topics —
        // most of what a spec creates — at a phase unrelated to the test in
        // progress, and writes stories, runs and failures into the state those
        // tests assert on. Every check a test sees should be one it triggered.
        NEWSMONGER_SCHEDULER_TICK_MS: String(24 * 60 * 60 * 1000),
        // One directory for every worker; see the note at the top of this file.
        ...(process.env['E2E_COVERAGE'] === '1'
          ? { NODE_V8_COVERAGE: path.join(process.cwd(), '.coverage-tmp/server') }
          : {}),
      },
    },
  );

  // Kept so a boot failure can say what the server said, rather than only that
  // it never answered. A server that dies on `EADDRINUSE` explains itself on
  // stderr and would otherwise surface as a bare timeout.
  let output = '';
  const capture = (buf: Buffer): void => {
    output = (output + buf.toString()).slice(-4000);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);

  // Read through a function: the assignment happens in a callback, which
  // control-flow analysis cannot see, so a plain variable would be narrowed to
  // `null` at every read and the checks below would be flagged as dead.
  let exitCode: number | null = null;
  const exited = (): number | null => exitCode;
  child.on('exit', (code) => {
    exitCode = code ?? -1;
  });

  const stop = async (): Promise<void> => {
    if (exited() === null) {
      child.kill('SIGTERM');
      // Give it a moment to close its database cleanly, then insist.
      await new Promise((r) => setTimeout(r, 300));
      if (exited() === null) child.kill('SIGKILL');
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  };

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    if (await healthy(base)) return { server: { port, base, dataDir }, stop };
    if (exited() !== null) {
      await stop();
      throw new Error(
        `E2E server for worker ${String(parallelIndex)} exited (${String(exited())}) before answering.\n${output}`,
      );
    }
    if (Date.now() >= deadline) {
      await stop();
      throw new Error(
        `E2E server for worker ${String(parallelIndex)} never answered ${base}/healthz within ${String(BOOT_TIMEOUT_MS)}ms.\n${output}`,
      );
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}
