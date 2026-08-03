import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildUserPrompt, NEWS_JSON_SCHEMA, parseNewsResult, searchingSystemPrompt } from '../prompt.js';
import { buildSuggestPrompt, parseSuggestResult, SUGGEST_JSON_SCHEMA, suggestSystemPrompt } from '../suggest-prompt.js';
import type {
  CheckResult,
  ConcreteProviderName,
  Effort,
  KnownItem,
  NewsProvider,
  SuggestRequest,
  SuggestResult,
  TopicContext,
} from '../types.js';
import { DISCOVERY_MODELS, toEffortLevels } from '../types.js';
import { agentCwd } from './agent-cwd.js';
import { cliErrorDetail } from './cli-error.js';
import { resolveCliBinary } from './cli-path.js';
import { readCodexEfforts, readCodexModels } from './codex-models.js';

/**
 * Run checks against the user's **ChatGPT subscription** rather than an
 * `OPENAI_API_KEY`, by shelling out to the Codex CLI.
 *
 * The OpenAI-side counterpart to `claude-cli.ts`, and the same reasoning: the
 * CLI already holds subscription credentials (`~/.codex/auth.json`, with
 * `auth_mode: "chatgpt"`), and there's no public flow letting a third-party app
 * spend that quota directly.
 *
 * Two things differ from the Claude CLI and drive the shape of this file:
 * `--output-schema` takes a *file* rather than an inline string, and Codex is a
 * coding agent that can execute shell commands — so it is sandboxed read-only.
 */

/** Timeout for one check. Like Claude Code, this is an agentic loop. */
const CHECK_TIMEOUT_MS = 10 * 60 * 1000;

/** Seam over the CLI so tests never spawn a real process. */
export interface CodexCliRunner {
  /** `schema` is written to the file `--output-schema` reads — see `ClaudeCliRunner`. */
  run(
    system: string,
    prompt: string,
    model: string | undefined,
    schema: object,
    effort?: Effort,
    signal?: AbortSignal,
  ): Promise<string>;
  available(): Promise<boolean>;
}

/**
 * Codex has no separate system-prompt flag, so the two are combined into the
 * single positional prompt with a clear boundary between them.
 */
export function combinePrompt(system: string, user: string): string {
  return `${system}\n\n---\n\n${user}`;
}

function spawnRunner(name: string): CodexCliRunner {
  // Resolved to an absolute path, because a Finder-launched macOS app does not
  // inherit the shell's PATH and these tools live in ~/.local/bin (NEWS-240).
  const binary = resolveCliBinary(name);
  const exec = async (
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      let child;
      try {
        // `cwd` is explicit, never inherited (NEWS-219): a CLI agent reads the
        // directory it starts in, and macOS attributes that read to Newsmonger.
        child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: agentCwd() });
      } catch {
        reject(new Error(`Could not run "${binary}" — is Codex installed?`));
        return;
      }
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
      }, timeoutMs);
      // Same kill the timeout uses (NEWS-257): a CLI agent is a child process,
      // so "cancel" means ending it rather than ignoring its answer — it would
      // otherwise keep spending a subscription's quota on a question the user
      // has already changed.
      const onAbort = (): void => {
        child.kill('SIGTERM');
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.setEncoding('utf-8');
      child.stderr.setEncoding('utf-8');
      child.stdout.on('data', (d: string) => (stdout += d));
      child.stderr.on('data', (d: string) => (stderr += d));
      child.on('error', () => {
        clearTimeout(timer);
        reject(new Error(`Could not run "${binary}" — is Codex installed and on PATH?`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve({ code, stdout, stderr });
      });
    });

  return {
    async run(system, prompt, model, schema, effort, signal) {
      // Both the schema and the final message go through temp files: Codex
      // takes the schema as a path, and reading the answer from a file beats
      // scraping it out of the progress log on stdout.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newsmonger-codex-'));
      const schemaFile = path.join(dir, 'schema.json');
      const outFile = path.join(dir, 'last-message.txt');
      try {
        fs.writeFileSync(schemaFile, JSON.stringify(schema));
        const args = codexExecArgs({ schemaFile, outFile, model, effort, prompt: combinePrompt(system, prompt) });

        const { code, stderr } = await exec(args, CHECK_TIMEOUT_MS, signal);
        if (code !== 0) {
          // stderr carries a benign PATH-alias warning on some installs, so it
          // is only surfaced once the exit code already indicates failure.
          const detail = cliErrorDetail(stderr);
          throw new Error(`Codex CLI exited with code ${String(code)}${detail !== '' ? `: ${detail}` : ''}`);
        }
        const text = fs.readFileSync(outFile, 'utf-8').trim();
        if (text === '') throw new Error('Codex CLI returned no result');
        return text;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },

    async available() {
      try {
        const { code } = await exec(['--version'], 10_000);
        if (code !== 0) return false;
      } catch {
        return false;
      }
      return hasChatGptCredentials();
    },
  };
}

/**
 * Whether Codex is signed in with a ChatGPT subscription.
 *
 * Reads only `auth_mode` — never the tokens sitting beside it. An API key
 * configured in Codex doesn't qualify: this provider exists specifically to
 * spend subscription quota, and `openai` already covers the key path.
 */
/**
 * The argv for one `codex exec` run.
 *
 * **Extracted so it can be tested at all (NEWS-272).** Every test injects a
 * `runner`, so the flag list inside the default one was the one part of this
 * provider no test ever executed — and that is exactly where it rotted: we passed
 * `--search`, which `codex-cli` **no longer has**. Codex answered with its usage
 * text and exit code 2, so every check against a ChatGPT subscription failed with
 * "codex exec [OPTIONS] <COMMAND> [ARGS]".
 *
 * Web search now rides the generic config override, verified the same way
 * NEWS-244 settled the effort key rather than assumed: with `--strict-config`,
 * `tools.web_search` is accepted and an invented field is rejected as an "unknown
 * configuration field" — and, because a recognized-but-inert key would pass that
 * test too, a real query was run end to end and observed performing searches.
 *
 * `features.web_search` is also a recognized field in this version. This uses the
 * one whose effect was actually watched.
 *
 * A vendor CLI can drop a flag under us again, and nothing here can prevent that.
 * What this buys is that the flags are visible to a test and stated in one place,
 * so the next drift is a one-line change rather than an archaeology exercise.
 */
export function codexExecArgs(opts: {
  schemaFile: string;
  outFile: string;
  model: string | undefined;
  effort: string | undefined;
  prompt: string;
}): string[] {
  const args = [
    'exec',
    // Web search, without which this provider cannot do the app's only job.
    '-c',
    'tools.web_search=true',
    '--skip-git-repo-check', // the app doesn't run inside a repo
    '-s',
    // Codex can execute shell commands. A news lookup must not write anything,
    // so it runs sandboxed read-only.
    'read-only',
    '--output-schema',
    opts.schemaFile,
    '--output-last-message',
    opts.outFile,
  ];
  if (opts.model !== undefined && opts.model !== '') args.push('-m', opts.model);
  // Reasoning effort, verified rather than assumed (NEWS-244). Codex has no
  // `--effort` flag — it goes through the generic config override — and the key
  // name was confirmed against the CLI itself. Every level this app offers is in
  // the set the server accepts (`none`, `minimal`, `low`, `medium`, `high`,
  // `xhigh`, `max`), so the value passes straight through with no mapping to
  // drift.
  if (opts.effort !== undefined && opts.effort !== '') args.push('-c', `model_reasoning_effort=${opts.effort}`);
  // Last: the prompt is positional, and anything appended after it would be read
  // as one of `exec`'s subcommands (`resume`, `review`) rather than as a flag.
  args.push(opts.prompt);
  return args;
}

export function hasChatGptCredentials(): boolean {
  try {
    const file = path.join(os.homedir(), '.codex', 'auth.json');
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return false;
    return (parsed as { auth_mode?: unknown }).auth_mode === 'chatgpt';
  } catch {
    return false; // not installed, not logged in, or unreadable
  }
}

/**
 * OpenAI via the Codex CLI, authenticated by the user's ChatGPT subscription.
 *
 * `attended: true` — spends plan quota, so scheduled runs only happen while the
 * app is foregrounded (`src/attendance.ts`).
 */
export function createCodexCliProvider(
  config: { model?: string; effort?: Effort; binary?: string; runner?: CodexCliRunner } = {},
): NewsProvider {
  const runner = config.runner ?? spawnRunner(config.binary ?? 'codex');
  const model = config.model ?? '';
  const effort = config.effort ?? '';
  // Discovery runs on a fast, cheap model unless the user chose one (NEWS-132).
  // As with `claude-cli`, the CLI owns the request shape; only `-m` changes.
  const discoveryModel = model !== '' ? model : DISCOVERY_MODELS['codex-cli'];

  return {
    name: 'codex-cli' satisfies ConcreteProviderName,
    model: model !== '' ? model : 'codex default',
    effort,
    attended: true,
    isAvailable: () => runner.available(),
    // What *this machine's* Codex offers, from the catalogue its own picker
    // reads (NEWS-249). Not the OpenAI API's list — Codex serves models that
    // one never lists and refuses ones it serves.
    listModels: () => Promise.resolve(readCodexModels()),
    // Per model, because they differ: `gpt-5.6-sol` takes `ultra`, `gpt-5.4`
    // does not, and asking for one a model refuses fails the check (NEWS-250).
    effortLevelsFor: (m: string) => {
      // Empty here means the cache has nothing to say — it is absent, or lists
      // no levels for this model — not that the model refuses effort. Codex has
      // no equivalent of Anthropic's `supported: false`, so `null` is the
      // honest answer and the caller falls back to the union (NEWS-254).
      const found = toEffortLevels(readCodexEfforts(m !== '' ? m : model));
      return found.length > 0 ? found : null;
    },
    async checkTopic(
      topicName: string,
      known: KnownItem[],
      sinceIso: string | null,
      context: TopicContext = {},
      signal?: AbortSignal,
    ): Promise<CheckResult> {
      const text = await runner.run(
        searchingSystemPrompt(),
        buildUserPrompt(topicName, known, sinceIso, context),
        model !== '' ? model : undefined,
        NEWS_JSON_SCHEMA,
        effort,
        signal,
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
