import v8 from 'node:v8';

import { ClaudeNewsService } from './ai/claude.js';
import { MockNewsService } from './ai/mock.js';
import type { NewsService } from './ai/types.js';
import { CheckRunner } from './checks.js';
import { parseArgs } from './config.js';
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
    console.error('usage: news [--port N] [--data-dir PATH] [--no-open] [--strict-port] [--ai-test]');
    process.exit(1);
  }

  const store = new Store(options.dataDir);
  const service: NewsService = options.aiTest ? new MockNewsService() : new ClaudeNewsService();
  if (!options.aiTest && (process.env['ANTHROPIC_API_KEY'] ?? '') === '') {
    console.warn('news: warning: ANTHROPIC_API_KEY is not set — news checks will fail until it is (or run with --ai-test)');
  }
  const runner = new CheckRunner(store, service);
  const app = createApp({ store, runner });

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
