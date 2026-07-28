/**
 * Retry policy for provider calls (NEWS-109).
 *
 * Before this, a check that failed for any reason advanced the topic's attempt
 * clock and waited a **full interval** — up to a day by default. A socket hangup
 * or a momentary 429 therefore cost a whole day of news for that topic, which is
 * the failure this module exists to prevent.
 *
 * Everything here is pure so the policy can be tested without a clock or a
 * network: the caller supplies `random` and does the waiting.
 */

/** How a failure should be treated. */
export type FailureKind = 'rate-limited' | 'retryable' | 'fatal';

export interface BackoffConfig {
  /** Wait before the first retry. */
  baseMs: number;
  /** Added per consecutive failure — linear, not exponential (see below). */
  stepMs: number;
  /** Ceiling before jitter. */
  maxMs: number;
  /** Jitter as a fraction of the delay, applied as ±. */
  jitterRatio: number;
  /** Total attempts including the first, so 4 means 3 retries. */
  maxAttempts: number;
}

/**
 * Retries **inside** one check: one retry after 15 s, ±20 %, capped at 240 s.
 *
 * **Linear rather than exponential** because the thing being retried is a check
 * that takes minutes and may cost money. Exponential backoff is tuned for cheap
 * idempotent requests where the cost of waiting is small and the cost of a
 * thundering herd is large; here the request is expensive and the herd is at
 * most `checkConcurrency` wide.
 *
 * **Two attempts, cut from four in NEWS-110.** Every second spent waiting here
 * holds one of only `checkConcurrency` slots, and the per-topic cooldown
 * (`FAILURE_COOLDOWN`) now brings the scheduler back in about two minutes
 * without holding anything. So this loop only has to cover the genuinely
 * momentary blip — a single dropped socket — and anything longer is cheaper to
 * wait out in the scheduler.
 *
 * The 240 s ceiling still matters: `Retry-After` can ask for a longer wait than
 * the step sequence would ever reach, and this is what bounds honouring it.
 */
export const DEFAULT_BACKOFF: BackoffConfig = {
  baseMs: 15_000,
  stepMs: 15_000,
  maxMs: 240_000,
  jitterRatio: 0.2,
  maxAttempts: 2,
};

/**
 * Delay before retry number `attempt` (1 = the first retry).
 *
 * Jitter is ± a fraction of the delay, so concurrent checks that failed together
 * don't all come back at the same instant. Never returns a negative delay.
 */
export function backoffDelayMs(
  attempt: number,
  config: BackoffConfig = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const linear = config.baseMs + (Math.max(1, attempt) - 1) * config.stepMs;
  const capped = Math.min(linear, config.maxMs);
  // random() is [0,1); (r * 2 - 1) maps it to [-1,1) for a symmetric ±.
  const jitter = capped * config.jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

/** Read a numeric property off an unknown error without asserting its shape. */
function numberProp(err: unknown, key: string): number | null {
  if (typeof err !== 'object' || err === null || !(key in err)) return null;
  const value = (err as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return '';
}

/**
 * Classify a provider failure.
 *
 * The SDK errors carry a numeric `status`; the CLI providers spawn a process and
 * throw whatever it printed, so those are matched on text. Anything unrecognised
 * is **retryable** — an unknown failure is more often a blip than a permanent
 * misconfiguration, and the attempt cap bounds the cost of guessing wrong.
 *
 * `fatal` means "this will fail again identically": a bad key, a malformed
 * request, a model that doesn't exist. Retrying those spends time and quota to
 * produce the same error, and repeatedly presenting bad credentials is its own
 * kind of rude.
 */
export function classifyFailure(err: unknown): FailureKind {
  const status = numberProp(err, 'status');
  if (status !== null) {
    if (status === 429) return 'rate-limited';
    // 408 request timeout and 409 conflict are the SDKs' own retryable set.
    if (status === 408 || status === 409) return 'retryable';
    if (status >= 500) return 'retryable';
    // Every other 4xx is a request we shouldn't repeat unchanged.
    if (status >= 400) return 'fatal';
  }

  const text = messageOf(err).toLowerCase();
  if (text.includes('rate limit') || text.includes('429') || text.includes('too many requests')) {
    return 'rate-limited';
  }
  if (
    text.includes('overloaded') ||
    text.includes('quota') ||
    text.includes('capacity')
  ) {
    return 'rate-limited';
  }
  if (
    text.includes('unauthorized') ||
    text.includes('authentication') ||
    text.includes('invalid api key') ||
    text.includes('invalid_api_key') ||
    text.includes('forbidden') ||
    text.includes('not found') ||
    // The mock provider's deliberate failure. Retrying it three times makes
    // every failure test three times slower for no coverage.
    text.includes('mock news service failure')
  ) {
    return 'fatal';
  }
  return 'retryable';
}

/**
 * How long a server asked us to wait, in ms, or null if it didn't say.
 *
 * `Retry-After` is authoritative and beats any computed backoff: the server
 * knows when the window resets and we are guessing. Both forms are accepted —
 * delta-seconds and an HTTP date — and the result is clamped to `maxMs`, since
 * an hour-long wait inside a check would hold a concurrency slot pointlessly
 * when the scheduler can simply come back later.
 */
export function retryAfterMs(err: unknown, now: Date = new Date(), maxMs = DEFAULT_BACKOFF.maxMs): number | null {
  if (typeof err !== 'object' || err === null || !('headers' in err)) return null;
  const headers = (err as { headers?: unknown }).headers;
  let raw: unknown;
  if (headers instanceof Headers) raw = headers.get('retry-after');
  else if (typeof headers === 'object' && headers !== null) {
    const record = headers as Record<string, unknown>;
    raw = record['retry-after'] ?? record['Retry-After'];
  }
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    if (seconds < 0) return null;
    return Math.min(seconds * 1000, maxMs);
  }
  const at = Date.parse(String(raw));
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(0, at - now.getTime()), maxMs);
}

/**
 * Cooldown between *checks* of a topic whose provider keeps failing (NEWS-110).
 *
 * A different job from `DEFAULT_BACKOFF`, hence different numbers. That one
 * governs retries **inside** one check, where every second spent waiting holds
 * one of only `checkConcurrency` slots — so it is short and gives up quickly.
 * This one governs when the *scheduler* comes back, which costs nothing to
 * wait on, so it can afford to reach into the tens of minutes.
 *
 * 2 min, 4, 6 … capped at 30. A blip recovers on the next tick or two; a
 * provider that has been broken for an hour is asked twice an hour rather than
 * sixty times. Both are enormously better than the previous behaviour, which was
 * to wait a full check interval — up to a day.
 *
 * The floor matters: the scheduler ticks once a minute, so a cooldown shorter
 * than that would be indistinguishable from none.
 */
export const FAILURE_COOLDOWN: BackoffConfig = {
  baseMs: 2 * 60_000,
  stepMs: 2 * 60_000,
  maxMs: 30 * 60_000,
  jitterRatio: 0.2,
  // Unused here — a cooldown has no attempt cap, it just keeps growing to the
  // ceiling. Set to the linear step count that first reaches `maxMs`, so the
  // value is at least meaningful if something ever reads it.
  maxAttempts: 15,
};
