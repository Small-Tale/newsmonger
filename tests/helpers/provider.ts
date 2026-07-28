import type { BackoffConfig } from '../../src/ai/retry.js';
import { DEFAULT_BACKOFF } from '../../src/ai/retry.js';
import type { CheckResult, FoundNewsItem, NewsProvider, NewsService } from '../../src/ai/types.js';
import type { ProviderResolver } from '../../src/checks.js';

/** Wrap a fixed provider as a resolver (the shape CheckRunner expects). */
export function asResolver(provider: NewsProvider): ProviderResolver {
  return () => Promise.resolve(provider);
}

/** A minimal NewsProvider around a bare checkTopic, for CheckRunner tests. */
export function fakeProvider(
  checkTopic: NewsService['checkTopic'],
  opts: Partial<Pick<NewsProvider, 'name' | 'model' | 'attended'>> = {},
): NewsProvider {
  return {
    name: opts.name ?? 'mock',
    model: opts.model ?? 'fake',
    attended: opts.attended ?? false,
    isAvailable: () => Promise.resolve(true),
    checkTopic,
  };
}

/** Wrap bare items as a provider result with no usage reported (NEWS-79). */
export function noUsage(items: FoundNewsItem[]): CheckResult {
  return { items, usage: null };
}

/**
 * Retry policy with no waiting (NEWS-109).
 *
 * The real policy sleeps 15 s before the first retry, so any test that drives a
 * *failing* provider would otherwise take a minute and a half. Tests about what
 * a failure records — rather than about the retry timing itself — pass this.
 *
 * Spread from `DEFAULT_BACKOFF` so `maxAttempts` tracks the real value — the
 * number of provider calls a failure produces stays what production produces.
 * It was written out by hand once and went stale the moment the real cap
 * changed, which is the sort of drift a test helper should not have.
 */
export const INSTANT_BACKOFF: BackoffConfig = {
  ...DEFAULT_BACKOFF,
  baseMs: 0,
  stepMs: 0,
  maxMs: 0,
  jitterRatio: 0,
};

/** Options that make a `CheckRunner` retry without waiting. */
export const instantRetry = { backoff: INSTANT_BACKOFF, sleep: () => Promise.resolve() };

/**
 * Real backoff *durations* with no real waiting.
 *
 * Distinct from `instantRetry`, which zeroes the durations too. Anything
 * asserting on the rate-limit gate needs this: the gate's length is derived from
 * the backoff, so a zeroed config produces a gate that has already expired —
 * which looks like the gate not working at all.
 */
export const fastRetry = { sleep: () => Promise.resolve() };
