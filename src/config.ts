import os from 'node:os';
import path from 'node:path';

import type { Effort, ProviderName } from './ai/types.js';
import { EFFORT_LEVELS, PROVIDER_NAMES } from './ai/types.js';

export interface CliOptions {
  port: number | null;
  dataDir: string;
  open: boolean;
  strictPort: boolean;
  aiTest: boolean;
  /** Seed fixture topics and serve curated stories, for capturing the docs (NEWS-212). */
  demo: boolean;
  /** Provider to seed into settings at startup; null = leave settings as-is. */
  provider: ProviderName | null;
  /** Model to seed into settings at startup; null = leave as-is. */
  model: string | null;
  /** Endpoint to seed into settings at startup; null = leave as-is. */
  endpoint: string | null;
  /** Effort to seed into settings at startup; null = leave as-is (NEWS-189). */
  effort: Effort | null;
}

/** Resolve the data directory: `--data-dir` flag, then NEWSMONGER_DATA_DIR, then `~/.newsmonger`. */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['NEWSMONGER_DATA_DIR'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return path.join(os.homedir(), '.newsmonger');
}

function parseEffort(value: string): Effort {
  if ((EFFORT_LEVELS as readonly string[]).includes(value)) return value as Effort;
  throw new Error(`--effort must be one of: ${EFFORT_LEVELS.filter((l) => l !== '').join(', ')}`);
}

function parseProvider(value: string): ProviderName {
  if ((PROVIDER_NAMES as readonly string[]).includes(value)) return value as ProviderName;
  throw new Error(`--provider must be one of: ${PROVIDER_NAMES.join(', ')}`);
}

/** Flags that consume the following argument. */
const VALUE_FLAGS = new Set(['--port', '--data-dir', '--provider', '--model', '--endpoint', '--effort']);

/**
 * The one-line usage, printed to stderr when parsing fails (FR-4.2).
 *
 * The provider list is interpolated from PROVIDER_NAMES rather than written out
 * (NEWS-204). Hardcoded, it had drifted twice over: it advertised `ollama`,
 * which is not a provider, and omitted `claude-cli` and `codex-cli`, which are —
 * so the one place a user goes when they have got the flag wrong was itself
 * wrong.
 */
export const USAGE_LINE =
  `usage: newsmonger [--port N] [--data-dir PATH] [--provider ${PROVIDER_NAMES.join('|')}] ` +
  '[--model ID] [--endpoint URL] [--effort LEVEL] [--no-open] [--strict-port] [--ai-test] [--demo] [--help] [--version]';

/** The full `--help` text, printed to stdout on request (FR-4.1a). */
export const HELP_TEXT = `${USAGE_LINE}

Newsmonger follows topics, not feeds: it asks an AI — with live web search —
whether there is anything genuinely new on each topic you follow, and shows what
is, deduplicated against what it already reported.

Options:
  --port N            port to listen on (default 4187, falls forward if busy)
  --data-dir PATH     where to keep the database (default $NEWSMONGER_DATA_DIR
                      or ~/.newsmonger)
  --provider NAME     seed the provider setting: ${PROVIDER_NAMES.join(', ')}
                      (env NEWSMONGER_PROVIDER)
  --model ID          seed the model setting (env NEWSMONGER_MODEL)
  --endpoint URL      seed the endpoint for OpenAI-compatible gateways
                      (env NEWSMONGER_ENDPOINT)
  --effort LEVEL      how hard the model works on a check: low, medium, high,
                      xhigh, max (env NEWSMONGER_EFFORT; Anthropic only)
  --no-open           do not open a browser at startup
  --strict-port       fail if the port is busy instead of falling forward
  --ai-test           use the offline deterministic mock provider
  --demo              serve fixture stories, for capturing the docs
  -h, --help          print this help and exit
  -v, --version       print the version and exit

No API key is needed if you are signed in to the Claude Code or Codex CLI —
Newsmonger uses that subscription. Provider, model and endpoint can also be
changed in the UI at any time; the flags only seed them at startup.

Docs: https://github.com/Small-Tale/newsmonger`;

/**
 * `--help` / `--version`, which are answered and exited on rather than run
 * (NEWS-216).
 *
 * Scanned ahead of `parseArgs` on purpose: they must work even when the rest of
 * the command line — or the environment, since `NEWSMONGER_PROVIDER` is parsed
 * while building the defaults — is bad. Someone typing `--help` is asking what
 * the valid flags *are*, so answering with "unknown argument" would be exactly
 * backwards.
 */
export function earlyExitFlag(argv: string[]): 'help' | 'version' | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // Skip a flag's value, so `--model -v` seeds a (silly) model rather than
    // printing the version and never starting.
    if (VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg === '--version' || arg === '-v') return 'version';
  }
  return null;
}


/** Parse CLI arguments. Throws on unknown flags or missing flag values. */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const envProvider = env['NEWSMONGER_PROVIDER'];
  const envModel = env['NEWSMONGER_MODEL'];
  const envEndpoint = env['NEWSMONGER_ENDPOINT'];
  const envEffort = env['NEWSMONGER_EFFORT'];
  const options: CliOptions = {
    port: null,
    dataDir: defaultDataDir(env),
    open: true,
    strictPort: false,
    aiTest: false,
    demo: false,
    provider: envProvider !== undefined && envProvider !== '' ? parseProvider(envProvider) : null,
    model: envModel !== undefined && envModel !== '' ? envModel : null,
    endpoint: envEndpoint !== undefined && envEndpoint !== '' ? envEndpoint : null,
    effort: envEffort !== undefined && envEffort !== '' ? parseEffort(envEffort) : null,
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
      case '--effort': {
        const value = argv.at(++i);
        if (value === undefined) throw new Error('--effort requires a value');
        options.effort = parseEffort(value);
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
      case '--demo':
        // Implies --ai-test: both mean "don't make a real AI call", and the demo
        // provider is a fixture provider. Keeping them separate booleans would
        // mean every `options.aiTest` guard (image fetching, link probing, key
        // verification) needed a second condition beside it.
        options.demo = true;
        options.aiTest = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}
