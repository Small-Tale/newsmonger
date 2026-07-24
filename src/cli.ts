import v8 from 'node:v8';

import { createMockProvider, resolveProvider } from './ai/providers/index.js';
import { Attendance } from './attendance.js';
import type { ProviderResolver } from './checks.js';
import { CheckRunner } from './checks.js';
import { parseArgs } from './config.js';
import type { Settings } from './db/schemas.js';
import { Store } from './db/store.js';
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
        console.warn(`news: warning: ${err instanceof Error ? err.message : String(err)} (or run with --ai-test)`);
      }
    }
  }

  // One tracker, shared: the route records foreground signals and the runner
  // reads them.
  const attendance = new Attendance();
  // No image fetching under --ai-test: the mock provider's URLs are fake, and
  // a test run must not reach out to the network.
  const fetchImage = options.aiTest ? null : createImageFetcher(options.dataDir);
  // Reclaim any orphaned cached images at startup — from a topic deleted in a
  // previous run, a crash mid-download, or an older version (NEWS-36).
  const pruned = pruneImageCache(options.dataDir, liveImageHashes(store.listItems()));
  if (pruned > 0) console.error(`news: pruned ${String(pruned)} orphaned cached image(s)`);
  const runner = new CheckRunner(store, resolve, attendance, fetchImage);
  const app = createApp({ store, runner, attendance, dataDir: options.dataDir });

  const server = await startServer(app, {
    port: options.port ?? undefined,
    strictPort: options.strictPort,
  });
  const url = `http://127.0.0.1:${server.port}`;
  // NOTE: the Tauri shell watches stdout for this exact "running at" line.
  console.log(`news running at ${url}`);

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
    if ((process.env['NODE_V8_COVERAGE'] ?? '') !== '') v8.takeCoverage();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // When the Tauri shell spawns us (NEWS_WATCH_PARENT=1), exit if the parent
  // dies without cleaning us up — a hard kill or a `tauri dev` rebuild restart
  // never fires the shell's exit hook, and each restart would orphan a server.
  if (process.env['NEWS_WATCH_PARENT'] === '1') {
    setInterval(() => {
      if (process.ppid === 1) {
        console.error('news: parent process gone — shutting down');
        shutdown();
      }
    }, 2000).unref();
  }
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
