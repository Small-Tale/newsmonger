import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * `.then(onOk, onErr)` does not catch what `onOk` returns (NEWS-312).
 *
 * The two-argument form's rejection handler covers **the promise it is attached
 * to**, not a promise the success handler hands back. So this shape:
 *
 * ```ts
 * void save(dir).then(
 *   () => writeBackup().then((at) => showToast(at)),   // ← unhandled if this rejects
 *   (err) => showToast(`Couldn't save: ${err}`),
 * );
 * ```
 *
 * reads as fully handled and is not. The backup offer shipped exactly that: a
 * folder that saved fine and then refused the write — an unmounted drive, a sync
 * client owning the directory, a full disk — produced an unhandled rejection and
 * **no toast at all**, while the code visibly intended one.
 *
 * It was found as an E2E *flake*, which is the reason this guard exists rather
 * than a fixed test. An uncaught page error is asserted in the fixture teardown,
 * so the rejection failed whichever test happened to be running when it landed —
 * `backup-prompt.spec.ts` in the run that caught it, and plausibly the
 * `discover.spec.ts` / `keys.spec.ts` pair in two earlier ones. A failure that
 * moves is a failure nobody can bisect.
 *
 * Lint does not catch it: `@typescript-eslint/no-floating-promises` is satisfied
 * by the outer `void`, and the inner promise is *returned*, so it is not
 * floating either.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const clientDir = path.join(root, 'src/client');

/** Every client source file, so a new one is covered without being listed. */
function clientSources(): string[] {
  return fs
    .readdirSync(clientDir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
    .map((e) => path.join(clientDir, e.name));
}

/**
 * A success handler that returns a `.then(…)` chain with only one argument.
 *
 * Deliberately narrow: it matches an arrow whose body is `something(...).then(`
 * — the shape that hides a rejection — rather than trying to understand promise
 * flow in general. A broader rule would fire on correct code and be disabled.
 */
const HIDES_A_REJECTION = /=>\s*\n?\s*[\w.]+\([^)]*\)\s*\.then\(\s*\(/g;

describe('a returned promise inside .then() must handle its own rejection (NEWS-312)', () => {
  it.each(clientSources().map((f) => [path.basename(f), f]))('%s', (_name, file) => {
    const text = fs.readFileSync(file, 'utf8');
    const offenders: string[] = [];
    for (const m of text.matchAll(HIDES_A_REJECTION)) {
      // Count the arguments of the inner `.then(`. One means the rejection has
      // nowhere to go; two means it is handled where it happens.
      const from = m.index + m[0].length - 1;
      let depth = 0;
      let commaAtTop = false;
      for (let i = from; i < text.length; i++) {
        const c = text[i];
        if (c === '(' || c === '{' || c === '[') depth++;
        else if (c === ')' || c === '}' || c === ']') {
          if (depth === 0) break;
          depth--;
        } else if (c === ',' && depth === 0) commaAtTop = true;
      }
      if (!commaAtTop) offenders.push(text.slice(m.index, m.index + 80).split('\n')[0]);
    }
    expect(
      offenders,
      `a promise returned from .then()'s success handler with no rejection handler — ` +
        `the outer .then(onOk, onErr) does NOT catch it`,
    ).toEqual([]);
  });

  it('is not vacuous — the detector fires on the shape that shipped', () => {
    // The exact code that produced "backup failed; see the server log" as an
    // unhandled rejection. If a future refactor makes the regex stop matching,
    // this fails rather than the suite quietly guarding nothing.
    const shipped = `
    void updateBackupDir(dir).then(
      () => backupNow().then((at) => { showToast(\`Backing up to \${at}\`); }),
      (err: unknown) => { showToast('nope'); },
    );`;
    expect([...shipped.matchAll(HIDES_A_REJECTION)]).toHaveLength(1);
  });
});
