import os from 'node:os';
import path from 'node:path';

import type { ProviderName } from './ai/types.js';
import { PROVIDER_NAMES } from './ai/types.js';

export interface CliOptions {
  port: number | null;
  dataDir: string;
  open: boolean;
  strictPort: boolean;
  aiTest: boolean;
  /** Provider to seed into settings at startup; null = leave settings as-is. */
  provider: ProviderName | null;
  /** Model to seed into settings at startup; null = leave as-is. */
  model: string | null;
  /** Endpoint to seed into settings at startup; null = leave as-is. */
  endpoint: string | null;
}

/** Resolve the data directory: `--data-dir` flag, then NEWS_DATA_DIR, then `~/.news`. */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['NEWS_DATA_DIR'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return path.join(os.homedir(), '.news');
}

function parseProvider(value: string): ProviderName {
  if ((PROVIDER_NAMES as readonly string[]).includes(value)) return value as ProviderName;
  throw new Error(`--provider must be one of: ${PROVIDER_NAMES.join(', ')}`);
}

/** Parse CLI arguments. Throws on unknown flags or missing flag values. */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const envProvider = env['NEWS_PROVIDER'];
  const envModel = env['NEWS_MODEL'];
  const envEndpoint = env['NEWS_ENDPOINT'];
  const options: CliOptions = {
    port: null,
    dataDir: defaultDataDir(env),
    open: true,
    strictPort: false,
    aiTest: false,
    provider: envProvider !== undefined && envProvider !== '' ? parseProvider(envProvider) : null,
    model: envModel !== undefined && envModel !== '' ? envModel : null,
    endpoint: envEndpoint !== undefined && envEndpoint !== '' ? envEndpoint : null,
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
      case '--provider': {
        const value = argv.at(++i);
        if (value === undefined) throw new Error('--provider requires a value');
        options.provider = parseProvider(value);
        break;
      }
      case '--model': {
        const value = argv.at(++i);
        if (value === undefined) throw new Error('--model requires a value');
        options.model = value;
        break;
      }
      case '--endpoint': {
        const value = argv.at(++i);
        if (value === undefined) throw new Error('--endpoint requires a value');
        options.endpoint = value;
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
