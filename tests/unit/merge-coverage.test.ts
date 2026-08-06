import { describe, expect, it } from 'vitest';

import { coverageOf, looksUnmeasured, mergeSources } from '../../scripts/merge-coverage.mjs';

/**
 * The coverage merge's arithmetic (NEWS-357).
 *
 * This was a script with no tests, and it was wrong in both directions at once:
 * it took each file's denominator from whichever source counted the most lines
 * (c8, whose `LF` is literally the file's total line count — comments and
 * blanks included), and it accepted a source that marked every line hit.
 *
 * The result reported a file with 26 tests and 100% coverage as 61%, and it
 * sent me to write redundant tests for it. A metric nobody checks is a metric
 * that can lie for months; these are the two lies it told.
 */

/** An lcov-shaped record: `[lineNo, hits]` pairs for one file. */
const rec = (sf: string, lines: [number, number][]): { sf: string; lines: [number, number][] } => ({ sf, lines });

/**
 * The merged lines for one file, asserted present.
 *
 * `expect(...)` rather than a `!`: this project validates instead of asserting,
 * and a missing file here should fail as "src/a.ts is not in the merged output"
 * rather than as a TypeError three lines later.
 */
function linesFor(merged: { byFile: Map<string, Map<number, number>> }, sf: string): Map<number, number> {
  const lines = merged.byFile.get(sf);
  expect(lines, `${sf} is in the merged output`).toBeDefined();
  return lines ?? new Map<number, number>();
}

describe('mergeSources — the unit run defines what a line is (NEWS-357)', () => {
  it('does not let a permissive source inflate the denominator', () => {
    // The exact failure: vitest says 2 executable lines, both covered; c8 says
    // 5 lines (it counts the comments) and misses 3. The answer is 2/2, not
    // 2/5 — the extra three are not code.
    const merged = mergeSources([
      { name: 'unit', records: [rec('src/a.ts', [[10, 1], [11, 1]])] },
      { name: 'e2e-server', records: [rec('src/a.ts', [[9, 0], [10, 0], [11, 0], [12, 0], [13, 0]])] },
    ]);
    expect(coverageOf(linesFor(merged, 'src/a.ts'))).toEqual({ lf: 2, lh: 2, pct: 100 });
  });

  it('still credits a line the E2E run covered and the unit run did not', () => {
    // The reason to merge at all. Line 11 is executable (unit says so) and only
    // the E2E run reaches it.
    const merged = mergeSources([
      { name: 'unit', records: [rec('src/a.ts', [[10, 1], [11, 0]])] },
      { name: 'e2e-server', records: [rec('src/a.ts', [[10, 0], [11, 4]])] },
    ]);
    expect(coverageOf(linesFor(merged, 'src/a.ts'))).toEqual({ lf: 2, lh: 2, pct: 100 });
  });

  it('reproduces the reported case: 100% must not become 61%', () => {
    // suggest-prompt.ts — 62 executable lines, all covered by unit tests; c8
    // reported the file's full 241 lines with 94 hit. It came out at 147/241.
    const unitLines: [number, number][] = Array.from({ length: 62 }, (_, i) => [i + 1, 1]);
    const c8Lines: [number, number][] = Array.from({ length: 241 }, (_, i) => [i + 1, i < 94 ? 1 : 0]);
    const merged = mergeSources([
      { name: 'unit', records: [rec('src/ai/suggest-prompt.ts', unitLines)] },
      { name: 'e2e-server', records: [rec('src/ai/suggest-prompt.ts', c8Lines)] },
    ]);
    expect(coverageOf(linesFor(merged, 'src/ai/suggest-prompt.ts')).pct).toBe(100);
  });

  it('keeps a file the basis never saw, rather than dropping it silently', () => {
    // Losing coverage would be a worse failure than an odd denominator, so an
    // orphan keeps its own lines — and is named, because more than zero means
    // the basis is no longer complete.
    const merged = mergeSources([
      { name: 'unit', records: [rec('src/a.ts', [[1, 1]])] },
      { name: 'e2e-server', records: [rec('src/only-e2e.ts', [[1, 1], [2, 0]])] },
    ]);
    expect(merged.orphans).toEqual(new Set(['src/only-e2e.ts']));
    expect(coverageOf(linesFor(merged, 'src/only-e2e.ts'))).toEqual({ lf: 2, lh: 1, pct: 50 });
  });

  it('sums hits rather than taking the last writer', () => {
    const merged = mergeSources([
      { name: 'unit', records: [rec('src/a.ts', [[1, 2]])] },
      { name: 'e2e-server', records: [rec('src/a.ts', [[1, 3]])] },
    ]);
    expect(linesFor(merged, 'src/a.ts').get(1)).toBe(5);
  });

  it('is a no-op shape when only the basis exists', () => {
    const merged = mergeSources([{ name: 'unit', records: [rec('src/a.ts', [[1, 1], [2, 0]])] }]);
    expect(coverageOf(linesFor(merged, 'src/a.ts'))).toEqual({ lf: 2, lh: 1, pct: 50 });
  });
});

describe('looksUnmeasured — a source that cannot miss is not measuring (NEWS-357)', () => {
  it('rejects a large source with no unhit lines', () => {
    // `e2e-browser`: 11,510 lines across 41 files, zero of them unhit. That is
    // "the bundle loaded", and merging it marks every file it touches 100%.
    const all = Array.from({ length: 500 }, (_, i): [number, number] => [i + 1, 1]);
    expect(looksUnmeasured([rec('src/a.ts', all)])).toBe(true);
  });

  it('accepts a large source that misses even one line', () => {
    // A real suite always misses something — an error branch, a guard. One miss
    // is enough to show the source can tell the difference.
    const lines = Array.from({ length: 500 }, (_, i): [number, number] => [i + 1, i === 0 ? 0 : 1]);
    expect(looksUnmeasured([rec('src/a.ts', lines)])).toBe(false);
  });

  it('does not punish a small fully-covered source', () => {
    // Three covered lines is unremarkable; eleven thousand is not. The floor is
    // on sample size for exactly this reason.
    expect(looksUnmeasured([rec('src/a.ts', [[1, 1], [2, 1], [3, 1]])])).toBe(false);
  });

  it('treats an empty source as measurable, not broken', () => {
    expect(looksUnmeasured([])).toBe(false);
  });
});
