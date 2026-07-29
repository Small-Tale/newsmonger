/**
 * A loosely-estimated progress bar for topic discovery (NEWS-137).
 *
 * A discovery call takes many seconds and the app can't know how many — there
 * is no progress signal to read, only a request that eventually returns. So the
 * bar is an *estimate* built from how long recent calls actually took, and it is
 * shaped so that being wrong is never embarrassing: it decelerates, and it never
 * reaches the end until the results do.
 */

/** How many recent durations to keep. The owner asked for "the last 1-10". */
const HISTORY_SIZE = 10;

/** Assumed duration before this device has ever completed a discovery call. */
export const DEFAULT_TARGET_MS = 30_000;

/** Bounds on the estimate, so one freak call can't poison the next bar. */
const MIN_TARGET_MS = 2_000;
const MAX_TARGET_MS = 90_000;

const STORAGE_KEY = 'news:discover-durations';

/**
 * The target duration to pace the bar against.
 *
 * The **median** rather than the mean: one call that hit a rate limit and took
 * 60 s shouldn't drag every subsequent estimate with it, and with a sample this
 * small a single outlier moves a mean a long way.
 */
export function estimateTargetMs(recent: readonly number[]): number {
  const usable = recent.filter((ms) => Number.isFinite(ms) && ms > 0);
  if (usable.length === 0) return DEFAULT_TARGET_MS;
  const sorted = [...usable].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return Math.min(MAX_TARGET_MS, Math.max(MIN_TARGET_MS, median));
}

/** Recent durations for this device, oldest first. Never throws. */
export function readDurations(): number[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms) && ms > 0);
  } catch {
    // Unparseable, or storage unavailable (private mode, disabled). A missing
    // history costs the default estimate, not an error.
    return [];
  }
}

/** Record how long one call took, keeping the most recent `HISTORY_SIZE`. */
export function recordDuration(ms: number, previous: readonly number[] = readDurations()): number[] {
  if (!Number.isFinite(ms) || ms <= 0) return [...previous];
  const next = [...previous, ms].slice(-HISTORY_SIZE);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage full or unavailable — the in-memory answer is still correct for
    // this session, and losing the history only costs the default estimate.
  }
  return next;
}

/**
 * How long the bar's animation should run for a given target.
 *
 * Three times the estimate, against a keyframe curve that reaches ~85% at the
 * one-third mark and then creeps. That is what makes an estimate safe to be
 * wrong about in either direction: finishing early leaves the bar mid-travel
 * (fine — the results replace it), and running long leaves it inching toward a
 * ceiling it never touches rather than sitting at 100% while nothing happens.
 */
export function animationDurationMs(targetMs: number): number {
  return targetMs * 3;
}
