import { spawn } from 'node:child_process';

import { buildUserPrompt, NEWS_JSON_SCHEMA, parseNewsResult, searchingSystemPrompt } from '../prompt.js';
import { buildSuggestPrompt, parseSuggestResult, SUGGEST_JSON_SCHEMA, suggestSystemPrompt } from '../suggest-prompt.js';
import type {
  CheckResult,
  ConcreteProviderName,
  KnownItem,
  NewsProvider,
  SuggestRequest,
  SuggestResult,
  TopicContext,
} from '../types.js';
import { DISCOVERY_MODELS } from '../types.js';
import { agentCwd } from './agent-cwd.js';

/**
 * Run checks against the user's Claude Pro/Max **subscription** rather than an
 * API key, by shelling out to the Claude Code CLI.
 *
 * There is no public OAuth flow letting a third-party app spend someone's
 * subscription quota against `api.anthropic.com` — but the CLI already holds
 * those credentials (`~/.claude/.credentials.json`, `claudeAiOauth`), so
 * invoking it inherits them. Verified working with no `ANTHROPIC_API_KEY` set.
 *
 * The `@anthropic-ai/claude-agent-sdk` package would also work and offers a
 * typed streaming API, but it vendors its own 243 MB copy of Claude Code as a
 * platform-specific dependency — roughly tripling the desktop bundle to avoid
 * one `spawn`. See `docs/9-subscription-providers.md`.
 */

/** Timeout for one check. A Claude Code run is an agentic loop, not one call. */
const CHECK_TIMEOUT_MS = 10 * 60 * 1000;

/** Seam over the CLI so tests never spawn a real process. */
export interface ClaudeCliRunner {
  /**
   * Resolves the agent's final text, or rejects with an actionable message.
   *
   * `schema` is the JSON Schema handed to `--json-schema`. It is a parameter
   * rather than a constant because checks and topic discovery (NEWS-116) return
   * different shapes through the same CLI.
   */
  run(system: string, prompt: string, model: string | undefined, schema: object): Promise<string>;
  /** Whether the CLI is installed and holds usable credentials. */
  available(): Promise<boolean>;
}

interface CliEnvelope {
  is_error?: unknown;
  result?: unknown;
  structured_output?: unknown;
  subtype?: unknown;
}

/** Read the envelope `--output-format json` prints, preferring structured output. */
export function parseCliEnvelope(stdout: string): string {
  let envelope: CliEnvelope;
  try {
    envelope = JSON.parse(stdout) as CliEnvelope;
  } catch {
    throw new Error('Claude CLI returned output that was not JSON');
  }
  if (envelope.is_error === true) {
    const detail = typeof envelope.subtype === 'string' ? `: ${envelope.subtype}` : '';
    throw new Error(`Claude CLI reported an error${detail}`);
  }
  // `--json-schema` makes the CLI emit a validated object, so prefer it over
  // re-parsing prose out of `result`.
  if (envelope.structured_output !== undefined && envelope.structured_output !== null) {
    return JSON.stringify(envelope.structured_output);
  }
  if (typeof envelope.result === 'string') return envelope.result;
  throw new Error('Claude CLI returned no result');
}

function spawnRunner(binary: string): ClaudeCliRunner {
  const exec = async (args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      let child;
      try {
        // `cwd` is explicit, never inherited (NEWS-219): a CLI agent reads the
        // directory it starts in, and macOS attributes that read to Newsmonger.
        child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: agentCwd() });
      } catch {
        reject(new Error(`Could not run "${binary}" — is Claude Code installed?`));
        return;
      }
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
      }, timeoutMs);
      child.stdout.setEncoding('utf-8');
      child.stderr.setEncoding('utf-8');
      child.stdout.on('data', (d: string) => (stdout += d));
      child.stderr.on('data', (d: string) => (stderr += d));
      child.on('error', () => {
        clearTimeout(timer);
        reject(new Error(`Could not run "${binary}" — is Claude Code installed and on PATH?`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });

  return {
    async run(system, prompt, model, schema) {
      const args = [
        '-p',
        prompt,
        '--append-system-prompt',
        system,
        // Only web search. This is a news lookup; the agent has no business
        // reading or writing the user's files to do it.
        '--allowed-tools',
        'WebSearch',
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(schema),
      ];
      if (model !== undefined && model !== '') args.push('--model', model);

      const { code, stdout, stderr } = await exec(args, CHECK_TIMEOUT_MS);
      if (code !== 0) {
        // stderr is noisy on success for some installs, so it's only surfaced
        // when the exit code already says something went wrong.
        const detail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
        throw new Error(`Claude CLI exited with code ${String(code)}${detail !== '' ? `: ${detail}` : ''}`);
      }
      return parseCliEnvelope(stdout);
    },

    async available() {
      // `--version` proves the binary exists but says nothing about login, so
      // read the credential file directly. Cheaper than a probe request, and a
      // probe would burn subscription quota just to answer "are you signed in".
      try {
        const { code } = await exec(['--version'], 10_000);
        if (code !== 0) return false;
      } catch {
        return false;
      }
      return hasSubscriptionCredentials();
    },
  };
}

/**
 * Whether Claude Code holds subscription credentials.
 *
 * Only the *shape* is inspected — never the token values. A key set in the
 * environment doesn't count: that's the `anthropic` provider's business, and
 * this one exists specifically to use a subscription.
 */
export async function hasSubscriptionCredentials(): Promise<boolean> {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  try {
    const file = path.join(os.homedir(), '.claude', '.credentials.json');
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return false;
    const oauth = (parsed as { claudeAiOauth?: unknown }).claudeAiOauth;
    if (typeof oauth !== 'object' || oauth === null) return false;
    return typeof (oauth as { accessToken?: unknown }).accessToken === 'string';
  } catch {
    return false; // not installed, not logged in, or unreadable
  }
}

/**
 * Claude via the Claude Code CLI, authenticated by the user's subscription.
 *
 * `attended: true` — a check spends plan quota rather than metered credit, so
 * scheduled runs only happen while the app is foregrounded (`src/attendance.ts`).
 */
export function createClaudeCliProvider(
  config: { model?: string; binary?: string; runner?: ClaudeCliRunner } = {},
): NewsProvider {
  const runner = config.runner ?? spawnRunner(config.binary ?? 'claude');
  const model = config.model ?? '';
  // Discovery runs on a fast, cheap model unless the user chose one (NEWS-132).
  // The CLI owns its own thinking and web-search configuration, so unlike the
  // API provider there is no request shape to vary — only `--model` changes.
  const discoveryModel = model !== '' ? model : DISCOVERY_MODELS['claude-cli'];

  return {
    name: 'claude-cli' satisfies ConcreteProviderName,
    model: model !== '' ? model : 'claude-code default',
    effort: '',
    attended: true,
    isAvailable: () => runner.available(),
    async checkTopic(
      topicName: string,
      known: KnownItem[],
      sinceIso: string | null,
      context: TopicContext = {},
    ): Promise<CheckResult> {
      const text = await runner.run(
        searchingSystemPrompt(),
        buildUserPrompt(topicName, known, sinceIso, context),
        model !== '' ? model : undefined,
        NEWS_JSON_SCHEMA,
      );
      // A subscription check spends plan quota, not metered dollars, and the
      // CLI reports no token counts — so usage is genuinely unknown, not zero.
      return { ...parseNewsResult(text), usage: null };
    },
    async suggestTopics(request: SuggestRequest): Promise<SuggestResult> {
      const text = await runner.run(
        suggestSystemPrompt(),
        buildSuggestPrompt(request),
        discoveryModel !== '' ? discoveryModel : undefined,
        SUGGEST_JSON_SCHEMA,
      );
      return { suggestions: parseSuggestResult(text), usage: null };
    },
  };
}
