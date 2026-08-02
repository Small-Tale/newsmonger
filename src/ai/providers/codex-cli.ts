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
import { DISCOVERY_MODELS } from '../types.js';
import { agentCwd } from './agent-cwd.js';
import { resolveCliBinary } from './cli-path.js';
import { readCodexModels } from './codex-models.js';

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
  run(system: string, prompt: string, model: string | undefined, schema: object, effort?: Effort): Promise<string>;
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
        resolve({ code, stdout, stderr });
      });
    });

  return {
    async run(system, prompt, model, schema, effort) {
      // Both the schema and the final message go through temp files: Codex
      // takes the schema as a path, and reading the answer from a file beats
      // scraping it out of the progress log on stdout.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newsmonger-codex-'));
      const schemaFile = path.join(dir, 'schema.json');
      const outFile = path.join(dir, 'last-message.txt');
      try {
        fs.writeFileSync(schemaFile, JSON.stringify(schema));
        const args = [
          'exec',
          '--search', // the native Responses web_search tool
          '--skip-git-repo-check', // the app doesn't run inside a repo
          '-s',
          // Codex can execute shell commands. A news lookup must not write
          // anything, so it runs sandboxed read-only.
          'read-only',
          '--output-schema',
          schemaFile,
          '--output-last-message',
          outFile,
        ];
        if (model !== undefined && model !== '') args.push('-m', model);
        // Reasoning effort, verified rather than assumed (NEWS-244). Codex has
        // no `--effort` flag — it goes through the generic config override —
        // and the key name was confirmed against the CLI itself: with
        // `--strict-config`, `model_reasoning_effort` is accepted while a made-up
        // key is rejected as an "unknown configuration field". Every level this
        // app offers is in the set the server accepts (`none`, `minimal`, `low`,
        // `medium`, `high`, `xhigh`, `max`), so the value passes straight
        // through with no mapping to drift.
        if (effort !== undefined && effort !== '') args.push('-c', `model_reasoning_effort=${effort}`);
        args.push(combinePrompt(system, prompt));

        const { code, stderr } = await exec(args, CHECK_TIMEOUT_MS);
        if (code !== 0) {
          // stderr carries a benign PATH-alias warning on some installs, so it
          // is only surfaced once the exit code already indicates failure.
          const detail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
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
        effort,
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
