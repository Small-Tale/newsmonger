import os from 'node:os';
import path from 'node:path';

export interface CliOptions {
  port: number | null;
  dataDir: string;
  open: boolean;
  strictPort: boolean;
  aiTest: boolean;
}

/** Resolve the data directory: `--data-dir` flag, then NEWS_DATA_DIR, then `~/.news`. */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['NEWS_DATA_DIR'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return path.join(os.homedir(), '.news');
}

/** Parse CLI arguments. Throws on unknown flags or missing flag values. */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const options: CliOptions = {
    port: null,
    dataDir: defaultDataDir(env),
    open: true,
    strictPort: false,
    aiTest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--port': {
        const value = argv.at(++i);
        const port = value !== undefined ? Number.parseInt(value, 10) : Number.NaN;
        if (Number.isNaN(port) || port <= 0 || port > 65535) throw new Error('--port requires a valid port number');
        options.port = port;
        break;
      }
      case '--data-dir': {
        const value = argv.at(++i);
        if (value === undefined) throw new Error('--data-dir requires a path');
        options.dataDir = path.resolve(value);
        break;
      }
      case '--no-open':
        options.open = false;
        break;
      case '--strict-port':
        options.strictPort = true;
        break;
      case '--ai-test':
        options.aiTest = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}
