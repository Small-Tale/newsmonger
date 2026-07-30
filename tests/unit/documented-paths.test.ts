import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { defaultDataDir } from '../../src/config.js';

/**
 * Documented paths match the ones the code actually uses (NEWS-188).
 *
 * The product rename in NEWS-164 swept `news` → `newsmonger` across the tree,
 * and applied it to strings that already read `newsmonger` — producing
 * **`~/.newsmongermonger`** in five places: README.md, CLAUDE.md,
 * docs/7-api-keys.md, a comment in `src/ai/api-keys.ts`, and — the one that
 * actually reached users — the note in the Settings → Keys panel.
 *
 * Nothing caught it, and nothing structurally could have. The code was right the
 * whole time; `defaultDataDir()` never mentioned the wrong name. Only *prose*
 * was wrong, so every test still passed, the app still worked, and the single
 * symptom was a reader going to look in a directory that does not exist. Docs
 * drifting from code is invisible to a test suite that only exercises code.
 *
 * So this test reads the real directory name out of `defaultDataDir()` and holds
 * the prose to it. It is deliberately a *name* check rather than a spelling
 * blacklist: banning the literal `newsmongermonger` would fix yesterday's typo
 * and miss tomorrow's.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The real directory name, derived rather than restated.
 *
 * Read with an empty env so `NEWSMONGER_DATA_DIR` — which the test runner and
 * `tests/helpers/tmp.ts` both set — cannot make this assert against a temp
 * directory and pass for the wrong reason.
 */
const REAL_DIR_NAME = path.basename(defaultDataDir({}));

/**
 * Files whose prose names the data directory to a human.
 *
 * Source files are in scope, not just Markdown: the worst instance of this bug
 * was UI copy in `app.tsx`, which no amount of doc linting would have found.
 */
const FILES = [
  'README.md',
  'CLAUDE.md',
  'docs/4-cli-server-storage.md',
  'docs/5-desktop-app.md',
  'docs/7-api-keys.md',
  'docs/manual-test-plan.md',
  'docs/ai/code-summary.md',
  'docs/ai/requirements-summary.md',
  'src/config.ts',
  'src/ai/api-keys.ts',
  'src/client/app.tsx',
];

/** Every `~/.something` path mentioned in a file, with its line number. */
function tildePaths(rel: string): { line: number; dir: string }[] {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return [];
  const found: { line: number; dir: string }[] = [];
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  for (const [i, text] of lines.entries()) {
    for (const m of text.matchAll(/~\/\.([A-Za-z0-9._-]+)/g)) {
      found.push({ line: i + 1, dir: m[1] });
    }
  }
  return found;
}

/**
 * Is this `~/.x` referring to *our* directory?
 *
 * Matching on the product name rather than on equality is what makes the test
 * useful: `~/.claude` and `~/.codex` are other tools' directories and are
 * legitimately mentioned in docs/9-subscription-providers.md, so a blanket
 * "every tilde path must be ours" rule would be wrong. Anything containing
 * `news` or `monger`, though, is unambiguously meant to be ours.
 */
const looksLikeOurs = (dir: string): boolean => /news|monger/i.test(dir);

describe('documented data-directory paths match the code (NEWS-188)', () => {
  it('derives a plausible directory name to check against', () => {
    // Guards the guard: if `defaultDataDir` is ever refactored such that this
    // basename stops being the dotted app directory, every assertion below
    // would start comparing against nonsense and still pass.
    expect(REAL_DIR_NAME).toBe('.newsmonger');
  });

  it('ignores the env override when deriving it', () => {
    // The E2E and unit runs both set NEWSMONGER_DATA_DIR to a temp path. If it
    // leaked in here, REAL_DIR_NAME would be a pid-scoped temp directory and the
    // real docs would be measured against it.
    expect(path.basename(defaultDataDir({ NEWSMONGER_DATA_DIR: '/tmp/somewhere-else' }))).not.toBe(REAL_DIR_NAME);
  });

  it.each(FILES)('%s spells our data directory correctly', (rel) => {
    const wrong = tildePaths(rel)
      .filter(({ dir }) => looksLikeOurs(dir))
      .filter(({ dir }) => `.${dir}` !== REAL_DIR_NAME)
      .map(({ line, dir }) => `${rel}:${line} says ~/.${dir}, expected ~/${REAL_DIR_NAME}`);
    expect(wrong).toEqual([]);
  });

  it('finds our directory mentioned somewhere, so the check cannot pass vacuously', () => {
    // Every per-file assertion above is satisfied by a file that mentions no
    // paths at all. Without this, renaming the docs out from under the list —
    // or a bad glob — would leave a green suite checking nothing.
    const mentions = FILES.flatMap((rel) => tildePaths(rel)).filter(({ dir }) => looksLikeOurs(dir));
    expect(mentions.length).toBeGreaterThan(5);
  });

  it('still allows other tools’ home directories to be documented', () => {
    // `~/.claude` and `~/.codex` are the subscription providers' own directories
    // (docs/9-subscription-providers.md). A stricter rule would have to be
    // relaxed the moment someone documents one, so pin the intent here.
    for (const dir of ['claude', 'codex']) {
      expect(looksLikeOurs(dir)).toBe(false);
    }
  });
});
