import { describe, expect, it } from 'vitest';

import { checkCost, MODEL_PRICES, type ModelPrice, monthlyPerTopic, WEB_SEARCH_PRICE_PER_1K } from '../../src/ai/cost.js';
import type { TokenUsage } from '../../src/ai/types.js';

/**
 * The check-cost arithmetic (NEWS-435).
 *
 * These pin the *maths*, not the prices — the prices are a table that will move,
 * and a test that asserted a dollar figure would just have to be edited every
 * time a vendor changes a rate. So the fixtures use a round override table where
 * the right answer is obvious by hand, and only a couple of assertions touch the
 * real `MODEL_PRICES`, to catch a row being deleted or zeroed.
 */

const usage = (over: Partial<TokenUsage> = {}): TokenUsage => ({
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  webSearches: 0,
  ...over,
});

// $2 / M input, $10 / M output, $0.20 / M cache-read, $2.50 / M cache-write.
const TEST_PRICES: Record<string, ModelPrice> = {
  test: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};

describe('checkCost', () => {
  it('prices each token bucket at its own rate', () => {
    const c = checkCost(
      usage({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }),
      'test',
      TEST_PRICES,
    );
    expect(c).not.toBeNull();
    expect(c?.inputCost).toBeCloseTo(2, 6);
    expect(c?.outputCost).toBeCloseTo(10, 6);
    expect(c?.cacheReadCost).toBeCloseTo(0.2, 6);
    expect(c?.cacheWriteCost).toBeCloseTo(2.5, 6);
    expect(c?.total).toBeCloseTo(14.7, 6);
  });

  it('charges web searches at $10 per 1,000, on top of tokens', () => {
    const c = checkCost(usage({ webSearches: 8 }), 'test', TEST_PRICES);
    // 8 × $0.01 = $0.08, and nothing else was used.
    expect(c?.searchCost).toBeCloseTo(0.08, 6);
    expect(c?.total).toBeCloseTo(0.08, 6);
    expect(WEB_SEARCH_PRICE_PER_1K).toBe(10);
  });

  it('is null for a model it cannot price, never zero', () => {
    // The distinction that matters when summing many checks: an unpriced model
    // is "unknown", and a total must be able to tell that from "cost nothing".
    expect(checkCost(usage({ inputTokens: 1_000_000 }), 'no-such-model', TEST_PRICES)).toBeNull();
  });

  it('is null when the provider reported no usage', () => {
    expect(checkCost(null, 'test', TEST_PRICES)).toBeNull();
  });

  it('scales linearly and sub-cent amounts survive', () => {
    // A real Haiku check is a few thousand tokens — fractions of a cent per
    // bucket — so the function must not round them away.
    const c = checkCost(usage({ inputTokens: 10_000, outputTokens: 1_000 }), 'test', TEST_PRICES);
    expect(c?.inputCost).toBeCloseTo(0.00002 * 1000, 9); // 10k/1e6 × 2 = 0.02
    expect(c?.total).toBeGreaterThan(0);
  });
});

describe('the real pricing table', () => {
  it('prices the models the app can run checks on', () => {
    // Not the dollar values — those move — but that the rows exist, so a check
    // on any of these can be costed rather than silently returning null.
    for (const model of ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8']) {
      const c = checkCost(usage({ inputTokens: 1_000_000 }), model);
      expect(c, `${model} should be priceable`).not.toBeNull();
      expect(c?.total).toBeGreaterThan(0);
    }
  });

  it('keeps cache reads cheaper than fresh input, on every model', () => {
    // The whole reason caching is a lever (NEWS-434/436): a cache read must cost
    // a fraction of a fresh input token, or wiring caching buys nothing.
    for (const [model, p] of Object.entries(MODEL_PRICES)) {
      expect(p.cacheRead, `${model} cache read`).toBeLessThan(p.input);
      expect(p.cacheWrite, `${model} cache write`).toBeGreaterThan(p.input);
    }
  });
});

describe('monthlyPerTopic', () => {
  it('projects a per-check cost to dollars per topic per month', () => {
    // Daily cadence → ~30.4 checks/month, so a 1-cent check is ~30 cents/month.
    expect(monthlyPerTopic(0.01, 24)).toBeCloseTo(0.01 * (365.25 / 12), 6);
  });

  it('costs a faster cadence proportionally more', () => {
    // 6h is 4× daily, so 4× the monthly cost of the same check.
    expect(monthlyPerTopic(0.01, 6)).toBeCloseTo(4 * monthlyPerTopic(0.01, 24), 9);
  });
});
