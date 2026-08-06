import { execFileSync } from 'node:child_process';
import os from 'node:os';

import { defineConfig } from '@playwright/test';

import { E2E_MAX_WORKERS, E2E_REAL_SERVER, E2E_SERVER, e2ePort, e2eWorkerPorts } from './tests/helpers/e2e-port.js';

// Derived from the checkout path, not hardcoded (NEWS-287) — two worktrees, or an
// agent and a developer, can now run E2E at the same time. See
// tests/helpers/e2e-port.ts for why the path and not the pid.
const PORT = e2ePort(E2E_SERVER);

/**
 * How many workers, and so how many servers (NEWS-321).
 *
 * Each worker boots its own `--ai-test` server and data dir from a worker-scoped
 * fixture (`tests/e2e/server.ts`), because Playwright's `webServer` is global
 * and has no per-worker form. Whole *files* go to workers — every spec is still
 * `mode: 'serial'` internally — so parallelism is bounded by the file count and,
 * below that, by the longest single file.
 *
 * Capped by cores as well as by `E2E_MAX_WORKERS`: four browsers and four Node
 * servers on a 2-core CI runner is contention, not concurrency, and the failure
 * it produces is a timeout in whichever spec was unlucky.
 *
 * `E2E_WORKERS=1` restores the old serial run, which is the first thing to try
 * when a failure smells like a shard interacting with another.
 */
const WORKERS = (() => {
  const asked = Number(process.env['E2E_WORKERS'] ?? '');
  if (Number.isInteger(asked) && asked > 0) return Math.min(asked, E2E_MAX_WORKERS);
  return Math.max(1, Math.min(E2E_MAX_WORKERS, Math.floor((os.cpus().length - 1) / 2)));
})();

const realRun = process.env['NEWSMONGER_E2E_REAL'] === '1';

/**
 * Clear the port before Playwright's own check gets to it.
 *
 * At config load, which is still the earliest point available. It was written
 * when a `webServer` plugin would throw on a held port before `globalSetup` ever
 * ran; the servers now start from a worker fixture (NEWS-321), so the deadline
 * is later, but running here keeps the diagnosis *before* the client build and
 * before any browser starts — which is the difference between one sentence and a
 * minute of setup followed by a confusing failure.
 *
 * **Guarded to the main process.** Worker processes re-import this config file,
 * and by then our own servers are legitimately listening — an unguarded
 * pre-flight would see them and abort the run it is meant to protect.
 * `TEST_WORKER_INDEX` is set by Playwright's worker entry before it loads the
 * config; verified by logging pid/ppid/worker from here across a real run (main:
 * `worker=undefined`, worker: `worker=0`).
 */
if (process.env['TEST_WORKER_INDEX'] === undefined) {
  // Every port a worker might bind, not just the first (NEWS-321). Checking only
  // worker 0's would let the run boot, shard, and then fail inside whichever
  // spec landed on the held one — exactly the failure the pre-flight exists to
  // replace with a sentence.
  const ports = realRun ? [...e2eWorkerPorts(WORKERS), e2ePort(E2E_REAL_SERVER)] : e2eWorkerPorts(WORKERS);
  try {
    execFileSync(process.execPath, ['scripts/e2e-preflight.mjs', ...ports.map(String)], {
      cwd: import.meta.dirname,
      stdio: 'inherit',
    });
  } catch {
    // The script has already explained itself on stderr; this only stops the run.
    throw new Error(`E2E pre-flight failed for port ${ports.join(', ')} — see the message above.`);
  }
}

export default defineConfig({
  testDir: 'tests/e2e',
  /**
   * The real-subscription spec is opt-in (NEWS-276).
   *
   * It spends plan quota and takes minutes, so it must not ride along on
   * `npm run test:all` — the thing you run before every commit. `npm run
   * test:e2e:real` sets the flag; nothing else does.
   *
   * The real spec brings its own server. What it still needs from here is the
   * **client bundle**, which `globalSetup` builds for every run — that used to
   * be a side effect of the shared `webServer` command booting, and is now
   * explicit (NEWS-321).
   */
  testIgnore: realRun ? [] : ['**/real-providers.spec.ts'],
  /**
   * Whole **files** in parallel, each on its own server (NEWS-321).
   *
   * It was `workers: 1` because every spec shared one server and one data file.
   * They no longer do: a worker-scoped fixture boots a server per worker, so a
   * file's state is private to whichever worker picked it up.
   *
   * `fullyParallel` stays **off** and every spec keeps `mode: 'serial'`, so the
   * unit of parallelism is the file. That is deliberate — the tests inside a
   * file genuinely build on each other, and it is the property the scrambled-order
   * audit (NEWS-314) verified files *do not* have between them.
   */
  workers: WORKERS,
  // **The retry reasoning below predates sharding and still holds** (NEWS-298).
  //
  // The worry is real in general: a retry cannot restore state a *later* test
  // created, so retrying a state-dependent test can produce a third failure mode
  // instead of a signal. Two things already blunt it here. Every spec file is
  // `mode: 'serial'`, so Playwright replays the **whole group from the top**
  // rather than one test in isolation; and `resetTopics` in each file's
  // `beforeAll` gives that replay the same empty server the first attempt had
  // (NEWS-101) — which is precisely the fix for "a retry cannot restore state".
  //
  // What a retry still cannot reset is settings and run history. That is the
  // residual risk, and it is smaller than the cost of dropping retries: the
  // suite drives a real browser against a real server, and genuine timing flakes
  // on a loaded machine would then fail the commit gate outright. A retry that
  // passes is still evidence; a retry that fails differently now says so, via
  // the `state-dependent` annotation the page fixture attaches on failure.
  retries: 1,
  /**
   * 60s, raised from 30s when sharding landed (NEWS-321).
   *
   * Not a tuning nicety — it is the direct consequence of the change. Four
   * workers means four browsers and four Node servers competing, so a test that
   * legitimately took 12s serially can take 25s under contention, and the
   * longest one in the suite (`discover.spec.ts`'s onboarding walk: store a key,
   * switch provider, open the guide, step to Topics, open discovery, search,
   * add) started intermittently crossing 30s. It failed as a *timeout*, which
   * reads like a hang rather than like a busy machine.
   *
   * The timeout exists to stop a hung test, not to enforce a performance budget.
   * A green run pays nothing for a higher ceiling; what it buys is that the
   * suite's slowest legitimate test is not racing the machine's load.
   */
  timeout: 60_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    // Worker 0's server. Every worker's real value comes from the `baseURL`
    // fixture in `tests/e2e/fixtures.ts`, which reads the server this worker
    // actually booted (NEWS-321); this is the default a single-worker run uses
    // and what anything reading the config sees.
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
  },
  /**
   * The client bundle is built **once**, before any worker starts (NEWS-321).
   *
   * It used to ride on the `webServer` command (`npm run build:client:dev && …`),
   * which is correct for one server and is four concurrent esbuild+sass runs
   * writing the same files for four. `globalSetup` is the one hook that runs
   * before the workers exist.
   *
   * The dev bundle, deliberately: it carries kerf's diagnostics with
   * `invariants: 'throw'`, so a morph/list-bookkeeping bug fails the suite at
   * the render that caused it instead of surfacing as a confusing assertion
   * several steps later (NEWS-100). The `pageerror` guard in fixtures.ts is what
   * makes that throw visible.
   *
   * **The servers themselves are in `tests/e2e/server.ts`**, not here. Playwright
   * has exactly one `webServer` for a whole run and no per-worker form, so a
   * server per worker had to be a worker-scoped fixture. The reasoning that used
   * to live on the `webServer` command moved there with it — including why it is
   * `node --import tsx/esm` and not the `tsx` CLI (NEWS-299), and why the server
   * runs from source rather than from `dist/cli.js` (its `NODE_V8_COVERAGE`
   * output is the E2E server's contribution to the merged report, and coverage
   * of a bundle is not coverage of `src/**`).
   */
  globalSetup: './tests/e2e/global-setup.ts',
});
