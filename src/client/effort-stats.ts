import type { StateResp } from '../api/schemas.js';

/**
 * What each effort level actually costs you (NEWS-227).
 *
 * The question this answers is the one NEWS-19 parked: is a higher effort level
 * buying anything? It was deliberately not built with NEWS-226, which added the
 * recording, because a comparison over a handful of runs is noise presented as
 * evidence. It is built now because the data arrived — a live database showed 24
 * succeeded runs at the model default against 23 at `low`, which is a median
 * worth taking.
 *
 * Pure and separate from `app.tsx` for the reason every other rule in this
 * directory is: the interesting parts are the exclusions, and exclusions are
 * cheaper to test by choosing inputs than by accumulating a hundred real checks.
 */

/** One level's row in the comparison. */
export interface EffortStat {
  /** The stored value: `''` for the model default, or a named level. */
  effort: string;
  /** How it reads in the UI. */
  label: string;
  /** Succeeded runs at this level. */
  runs: number;
  /** Median wall-clock duration. */
  medianMs: number;
  /**
   * Median tokens, over the runs that **reported** any — `null` when none did.
   *
   * Null rather than zero, and that distinction is the whole reason this field is
   * shaped like this. Both subscription CLIs return `usage: null` because they
   * genuinely cannot report counts (`CheckRunSchema` says so: "Null means
   * unknown, not zero"). On a subscription-only install *every* run lands here,
   * so a naive average would render a confident **0 tokens** — a measurement the
   * app never made, presented next to a duration it did.
   */
  medianInputTokens: number | null;
  medianOutputTokens: number | null;
  /** How many of `runs` reported tokens, so the UI can say what it is averaging over. */
  tokenRuns: number;
}

/** Middle value, averaging the two middles on an even count. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** `''` is a level — the model's own default — and reads as one. */
export function effortLabel(effort: string): string {
  return effort === '' ? 'model default' : effort;
}

/**
 * Median duration and tokens per effort level, slowest level last.
 *
 * Three exclusions, each of which would otherwise turn the table into a liar:
 *
 * - **`effort === null` runs are dropped entirely.** Null is "we did not record
 *   this", not a level (`CheckRunSchema`). Folding them into `''` would make
 *   every run from before NEWS-226 look like a default-effort data point — and
 *   there are more of those than of anything else in a real database.
 * - **Only `succeeded` runs count.** A check that failed after four seconds is
 *   not evidence that a level is fast, and a level that fails often would
 *   otherwise look like the quickest.
 * - **A run with no `finishedAt` is skipped**, since it has no duration yet.
 *
 * **Median, not mean.** Check durations have a long tail — a stalled provider, a
 * retry, a topic that searched twelve sources — and one outlier moves a mean far
 * enough to invert the comparison this table exists to make.
 */
export function effortComparison(runs: StateResp['runs']): EffortStat[] {
  const byLevel = new Map<string, { durations: number[]; input: number[]; output: number[] }>();

  for (const run of runs) {
    if (run.effort === null) continue;
    if (run.status !== 'succeeded') continue;
    if (run.finishedAt === null) continue;
    const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
    if (!Number.isFinite(ms) || ms < 0) continue;

    const bucket = byLevel.get(run.effort) ?? { durations: [], input: [], output: [] };
    bucket.durations.push(ms);
    if (run.usage !== null) {
      // Cache reads and writes are input the provider billed differently, not a
      // separate thing the reader is choosing between — so they are folded in.
      bucket.input.push(run.usage.inputTokens + run.usage.cacheReadTokens + run.usage.cacheWriteTokens);
      bucket.output.push(run.usage.outputTokens);
    }
    byLevel.set(run.effort, bucket);
  }

  return [...byLevel.entries()]
    .map(([effort, { durations, input, output }]) => ({
      effort,
      label: effortLabel(effort),
      runs: durations.length,
      medianMs: median(durations),
      medianInputTokens: input.length === 0 ? null : median(input),
      medianOutputTokens: output.length === 0 ? null : median(output),
      tokenRuns: input.length,
    }))
    .sort((a, b) => a.medianMs - b.medianMs);
}

/**
 * Whether the table is worth rendering at all.
 *
 * One level is not a comparison — it is a number with no second number to be
 * read against, and NEWS-227 was held back specifically to avoid shipping a view
 * that looks broken on first open. Below two levels the caller shows nothing and
 * says why.
 */
export function hasEffortComparison(stats: EffortStat[]): boolean {
  return stats.length >= 2;
}
