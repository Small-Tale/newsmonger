/**
 * The process boundary of a CLI provider (NEWS-277).
 *
 * `argv` in, `{ code, stdout, stderr }` out — and nothing else. Extracted so it
 * can be **replaced by a recording** of what the real vendor said, which is the
 * only way to test the code that has actually broken here.
 *
 * The existing seam is one level too high: `config.runner` replaces the whole
 * runner, so every unit test skips the argv construction, the schema temp file,
 * the envelope parsing and the error extraction. That is precisely the list of
 * things that failed in production:
 *
 * - `codexExecArgs` passed `--search`, a flag the CLI had removed (NEWS-272).
 * - The schema in that temp file omitted declared properties from `required`,
 *   which strict structured outputs reject (NEWS-272, second cause).
 * - `cliErrorDetail` sliced the last three lines of a JSON error and got its
 *   closing braces (NEWS-274).
 *
 * Swap the exec instead and all of that runs for real against a byte-exact
 * transcript. **What a recording cannot do is notice the vendor changing** — a
 * frozen fixture would have replayed the old `--search` success forever. That is
 * why the live spec stays, opt-in, as the currency check.
 */
export interface CliExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type CliExec = (args: string[], timeoutMs: number, signal?: AbortSignal) => Promise<CliExecResult>;
