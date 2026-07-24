import type { StateResp } from '../api/schemas.js';

type CheckRun = StateResp['runs'][number];

/**
 * The failure to warn about, or null (NEWS-41).
 *
 * Only a topic whose **most recent** run failed counts — a topic that failed
 * once and has since succeeded (or is re-checking now) is not currently
 * failing, and its old failed run must not keep the banner up. Runs arrive
 * most-recent-first, so the first run seen for a topic is its latest; the first
 * topic whose latest run is a failure is the most recent current failure.
 *
 * This replaces a plain `runs.find(status === 'failed')`, which surfaced stale
 * failures from long-recovered topics until they scrolled out of history.
 */
export function currentFailure(runs: CheckRun[]): CheckRun | null {
  const seen = new Set<string>();
  for (const run of runs) {
    if (seen.has(run.topicId)) continue; // an older run for a topic we've already placed
    seen.add(run.topicId);
    if (run.status === 'failed') return run; // this topic's latest run, and it failed
  }
  return null;
}
