import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CliExec, CliExecResult } from '../../src/ai/providers/cli-exec.js';

/**
 * Replaying a real CLI session (NEWS-277).
 *
 * The fixtures in `tests/fixtures/cli-sessions/` are **transcripts of the actual
 * vendor tools**, captured once by `npm run record:cli-sessions` and committed.
 * Replaying one at the process boundary means the provider's argv construction,
 * schema temp file, envelope parsing and error extraction all run for real —
 * which is the code that broke in NEWS-272 and NEWS-274 and which the
 * `config.runner` seam skips entirely.
 *
 * **A recording is fidelity, not currency.** It cannot notice the vendor removing
 * a flag: a frozen fixture would have replayed the old `--search` success forever
 * while every real check failed. That is what the opt-in live spec is for
 * (`npm run test:e2e:real`), and why re-recording after a CLI upgrade is a
 * deliberate act rather than something these tests do for you.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SESSION_DIR = path.resolve(HERE, '../fixtures/cli-sessions');

/** One captured invocation. `argv` is kept for provenance and for assertions. */
export interface CliSession {
  /** Scenario name — the file stem, e.g. `codex-check-success`. */
  name: string;
  /** Which tool, for the reader and for the recorder's own bookkeeping. */
  tool: 'claude' | 'codex';
  /** What the recorder was asked to capture, in prose. */
  describes: string;
  /** The argv the provider actually built, minus machine-specific temp paths. */
  argv: string[];
  code: number | null;
  stdout: string;
  stderr: string;
  /**
   * What the tool wrote to `--output-last-message`, when it writes one.
   *
   * Codex returns its answer in a file rather than on stdout, so a faithful replay
   * has to **write that file** — see `writeLastMessage`. Without it a replayed
   * success fails with "returned no result", which is the provider correctly
   * reporting an empty file.
   */
  lastMessage: string;
  /** When it was captured, so a stale fixture is visible rather than inferred. */
  recordedAt: string;
  /** The tool's own version string, which is what a re-record is checked against. */
  toolVersion: string;
}

export function readSession(name: string): CliSession {
  const file = path.join(SESSION_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `no recorded CLI session "${name}". Run \`npm run record:cli-sessions\` on a machine with the CLI signed in.`,
    );
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as CliSession;
}

export function listSessions(): CliSession[] {
  if (!fs.existsSync(SESSION_DIR)) return [];
  return fs
    .readdirSync(SESSION_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readSession(f.replace(/\.json$/, '')));
}

/**
 * An exec that answers from recordings, and records what it was asked.
 *
 * Matched on the **subcommand** rather than the whole argv, because the argv
 * carries per-run temp file paths and the prompt itself — neither of which a
 * fixture can match on and neither of which decides what the tool would say.
 * `--version` is answered from the version scenario so `available()` works
 * without the binary being installed.
 *
 * `calls` is exposed because the argv is half of what these tests exist to check:
 * a replayed success proves the parsing, and the recorded argv proves we are still
 * sending what the recording was made with.
 */
/**
 * Do what the tool does with `--output-last-message`: write the answer there.
 *
 * The provider reads its result from that path, so a replay that only returns
 * stdout leaves the file empty and the check fails with "returned no result" —
 * which is the provider being right about an empty file. Writing it keeps the
 * provider's own file handling in the tested path rather than stubbing past it.
 */
function writeLastMessage(args: string[], session: CliSession): void {
  const at = args.indexOf('--output-last-message');
  const target = at === -1 ? undefined : args[at + 1];
  if (target === undefined || session.lastMessage === '') return;
  fs.writeFileSync(target, session.lastMessage);
}

export function replayExec(sessions: CliSession[]): CliExec & { calls: string[][] } {
  const calls: string[][] = [];
  const exec = (args: string[]): Promise<CliExecResult> => {
    calls.push(args);
    if (args[0] === '--version') {
      const version = sessions.find((s) => s.name.endsWith('-version'));
      return Promise.resolve({ code: 0, stdout: version?.toolVersion ?? 'unknown', stderr: '' });
    }
    const match = sessions.find((s) => s.argv[0] === args[0]);
    if (match === undefined) {
      return Promise.reject(new Error(`no recorded session matches argv starting "${args[0] ?? '(empty)'}"`));
    }
    writeLastMessage(args, match);
    return Promise.resolve({ code: match.code, stdout: match.stdout, stderr: match.stderr });
  };
  return Object.assign(exec, { calls });
}

/** An exec that replays exactly one session, whatever it is asked. */
export function replayOne(session: CliSession): CliExec & { calls: string[][] } {
  const calls: string[][] = [];
  const exec = (args: string[]): Promise<CliExecResult> => {
    calls.push(args);
    if (args[0] === '--version') return Promise.resolve({ code: 0, stdout: session.toolVersion, stderr: '' });
    writeLastMessage(args, session);
    return Promise.resolve({ code: session.code, stdout: session.stdout, stderr: session.stderr });
  };
  return Object.assign(exec, { calls });
}
