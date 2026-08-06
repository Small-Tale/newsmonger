/**
 * Types for the merge's exported arithmetic (NEWS-357).
 *
 * The script stays `.mjs` — it is run directly by `test-all.sh` with no build
 * step, and giving it one to satisfy a test would be the tail wagging the dog.
 * A declaration file buys `tests/unit/merge-coverage.test.ts` real types
 * without changing what ships.
 */

/** One file's lcov `DA:` lines, as `[lineNumber, hits]`. */
export type CoverageRecord = { sf: string; lines: [number, number][] };

/** One coverage run — vitest's unit report, or a c8 conversion of a V8 dump. */
export type CoverageSource = { name: string; records: CoverageRecord[] };

/**
 * Combine sources, taking each file's set of executable line numbers from
 * `basisName` and letting the others contribute only hits.
 */
export function mergeSources(
  sources: CoverageSource[],
  basisName?: string,
): { byFile: Map<string, Map<number, number>>; orphans: Set<string> };

/** Line coverage of one file's `Map(lineNumber, hits)`. */
export function coverageOf(lines: Map<number, number>): { lf: number; lh: number; pct: number };

/**
 * True when a source reports no unhit lines at all over a meaningful sample —
 * i.e. it records that files were *loaded*, not which lines ran.
 */
export function looksUnmeasured(records: CoverageRecord[], minLines?: number): boolean;
