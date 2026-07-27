/**
 * Silence Node's `ExperimentalWarning` for `node:sqlite` — and nothing else (NEWS-94).
 *
 * `node:sqlite` is stable enough to build on but still flagged experimental, so
 * without this every `news` start, every test file and every E2E run prints a
 * warning about a decision the user has no part in. A warning nobody can act on
 * trains people to ignore warnings, which is worse than the noise.
 *
 * Deliberately **not** `process.removeAllListeners('warning')`: that is the
 * usual shortcut and it swallows every warning the process will ever emit,
 * including deprecations we would want to see. This wraps `emitWarning` and
 * filters on both the type *and* the message, so anything else — including
 * another `ExperimentalWarning` — still prints.
 *
 * Imported for its side effect at the top of `sqlite.ts`, above the `node:sqlite`
 * import, because ES module imports evaluate in source order and the warning
 * fires when that module is first evaluated. Anything installed later is too late.
 */
type EmitWarning = (warning: string | Error, ...rest: unknown[]) => void;

const emit = process.emitWarning.bind(process) as EmitWarning;

const filtered: EmitWarning = (warning, ...rest) => {
  const first: unknown = rest[0];
  const type = typeof first === 'string' ? first : (first as { type?: string } | undefined)?.type;
  const text = typeof warning === 'string' ? warning : warning.message;
  if (type === 'ExperimentalWarning' && /SQLite/i.test(text)) return;
  emit(warning, ...rest);
};

process.emitWarning = filtered;
