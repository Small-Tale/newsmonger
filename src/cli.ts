import v8 from 'node:v8';

import { createMockProvider, resolveProvider } from './ai/providers/index.js';
import { probeLink } from './ai/verify-links.js';
import { Attendance } from './attendance.js';
import type { ProviderResolver } from './checks.js';
import { CheckRunner } from './checks.js';
import { parseArgs } from './config.js';
import type { Settings } from './db/schemas.js';
import { Store } from './db/store.js';
import { DiscoveryService } from './discovery.js';
import { createImageFetcher, liveImageHashes, pruneImageCache } from './images/index.js';
import { openInBrowser } from './routes/api.js';
import { startScheduler } from './scheduler.js';
import { createApp, startServer } from './server.js';

async function main(): Promise<void> {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(
      'usage: news [--port N] [--data-dir PATH] [--provider auto|anthropic|openai|ollama|mock] [--model ID] [--endpoint URL] [--no-open] [--strict-port] [--ai-test]',
    );
    process.exit(1);
  }

  const store = new Store(options.dataDir);

  // CLI flags / env seed the persisted provider settings (the UI can change
  // them later). --ai-test forces the mock provider without touching settings.
  const patch: Partial<Settings> = {};
  if (options.provider !== null) patch.provider = options.provider;
  if (options.model !== null) patch.model = options.model;
  if (options.endpoint !== null) patch.endpoint = options.endpoint;
  if (Object.keys(patch).length > 0) store.updateSettings(patch);

  let resolve: ProviderResolver;
  if (options.aiTest) {
    const mock = createMockProvider();
    resolve = () => Promise.resolve(mock);
  } else {
    resolve = () => {
      const s = store.getSettings();
      return resolveProvider({ provider: s.provider, model: s.model, endpoint: s.endpoint });
    };
    // Warn only when nothing can authenticate. Probes the same way a check
    // will — which now includes a Claude Code subscription, not just keys, so
    // a signed-in subscriber isn't told at startup that they have no key.
    const s = store.getSettings();
    if (s.provider !== 'mock') {
      try {
        await resolveProvider({ provider: s.provider, model: s.model, endpoint: s.endpoint });
      } catch (err: unknown) {
        console.warn(`newsmonger: warning: ${err instanceof Error ? err.message : String(err)} (or run with --ai-test)`);
      }
    }
  }

  // One tracker, shared: the route records foreground signals and the runner
  // reads them.
  const attendance = new Attendance();
  // No image fetching under --ai-test: the mock provider's URLs are fake, and
  // a test run must not reach out to the network.
  const fetchImage = options.aiTest ? null : createImageFetcher(options.dataDir);
  // Apply the retention window at startup too (NEWS-87): an install that has
  // been closed for months should come back trimmed, not with a year of
  // backlog waiting for the first check to clear it.
  const dropped = store.pruneOldItems(new Date());
  if (dropped > 0) console.error(`newsmonger: pruned ${String(dropped)} stories past the retention window`);
  // And anything a topic deleted mid-check left behind (NEWS-105) — including
  // from a previous run that was killed before its own sweep got there.
  // Run history bounds the spend window (NEWS-103), so it is pruned on the same
  // schedule as stories rather than on every insert.
  store.pruneOldRuns(new Date());
  const orphaned = store.pruneOrphans();
  if (orphaned.items > 0 || orphaned.runs > 0) {
    console.error(
      `newsmonger: swept ${String(orphaned.items)} story/ies and ${String(orphaned.runs)} run(s) left by a deleted topic`,
    );
  }
  // Reclaim any orphaned cached images at startup — from a topic deleted in a
  // previous run, a crash mid-download, or an older version (NEWS-36).
  const pruned = pruneImageCache(options.dataDir, liveImageHashes(store.listItems()));
  if (pruned > 0) console.error(`newsmonger: pruned ${String(pruned)} orphaned cached image(s)`);
  // No link probing under --ai-test either: the mock's URLs are fictional, so
  // every story would be dropped as unreachable.
  const runner = new CheckRunner(store, resolve, attendance, fetchImage, options.aiTest ? null : probeLink);
  // Shares the resolver with the runner so discovery follows the same provider
  // setting, but is its own object: `CheckRunner` is topic-shaped throughout and
  // a discovery call has no topic (NEWS-125).
  const discovery = new DiscoveryService(store, resolve);
  const app = createApp({
    store,
    runner,
    discovery,
    attendance,
    dataDir: options.dataDir,
    // Under --ai-test nothing talks to a vendor, so a live key check would only
    // reject the obviously-fake keys the E2E suite saves on purpose.
    verifyKey: options.aiTest ? null : undefined,
  });

  const server = await startServer(app, {
    port: options.port ?? undefined,
    strictPort: options.strictPort,
  });
  const url = `http://127.0.0.1:${server.port}`;
  // NOTE: the Tauri shell watches stdout for this exact "running at" line.
  console.log(`newsmonger running at ${url}`);

  const stopScheduler = startScheduler(runner);
  if (options.open) openInBrowser(url);

  // Under E2E coverage collection the test runner may kill us without letting
  // the exit hook flush V8 coverage — flush it ourselves periodically.
  if ((process.env['NODE_V8_COVERAGE'] ?? '') !== '') {
    setInterval(() => {
      v8.takeCoverage();
    }, 2000).unref();
  }

  const shutdown = (): void => {
    stopScheduler();
    server.close();
    // Close the database explicitly so WAL is checkpointed into `newsmonger.db`
    // rather than left for the next start to replay (NEWS-94).
    store.close();
    if ((process.env['NODE_V8_COVERAGE'] ?? '') !== '') v8.takeCoverage();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // When the Tauri shell spawns us (NEWSMONGER_WATCH_PARENT=1), exit if the parent
  // dies without cleaning us up — a hard kill or a `tauri dev` rebuild restart
  // never fires the shell's exit hook, and each restart would orphan a server.
  if (process.env['NEWSMONGER_WATCH_PARENT'] === '1') {
    setInterval(() => {
      if (process.ppid === 1) {
        console.error('newsmonger: parent process gone — shutting down');
        shutdown();
      }
    }, 2000).unref();
  }
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
