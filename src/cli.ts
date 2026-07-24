import v8 from 'node:v8';

import { resolveApiKey } from './ai/api-keys.js';
import { createMockProvider, resolveProvider } from './ai/providers/index.js';
import { KEYED_PROVIDERS } from './ai/types.js';
import { Attendance } from './attendance.js';
import type { ProviderResolver } from './checks.js';
import { CheckRunner } from './checks.js';
import { parseArgs } from './config.js';
import type { Settings } from './db/schemas.js';
import { Store } from './db/store.js';
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
    // Warn only when nothing can authenticate. Checks the keychain too, not
    // just the environment — otherwise every user who saved a key in Settings
    // would be told at startup that they have none.
    const s = store.getSettings();
    if (s.provider !== 'mock') {
      const candidates = s.provider === 'auto' ? KEYED_PROVIDERS : [s.provider];
      const resolved = await Promise.all(candidates.map((p) => resolveApiKey(p)));
      if (!resolved.some((r) => r.key !== null)) {
        console.warn(
          'news: warning: no API key found — add one in Settings, or set ANTHROPIC_API_KEY / OPENAI_API_KEY (or run with --ai-test)',
        );
      }
    }
  }

  // One tracker, shared: the route records foreground signals and the runner
  // reads them.
  const attendance = new Attendance();
  const runner = new CheckRunner(store, resolve, attendance);
  const app = createApp({ store, runner, attendance });

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
