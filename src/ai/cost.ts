import type { TokenUsage } from './types.js';

/**
 * What a check actually cost, in dollars (NEWS-435).
 *
 * The app records `TokenUsage` per run but has never converted it to money —
 * user-facing spend was removed deliberately (NEWS-119), and the mock/CLI
 * providers report no usage anyway. This is the missing piece: a pure function
 * from usage + model to a dollar figure, so the cloud/business-model work
 * (NEWS-434) can be argued from measurement rather than estimate.
 *
 * **The prices below are a table you must confirm before trusting a total.**
 * They are the published Anthropic rates at time of writing; vendors move them,
 * and a wrong row here is a wrong P&L. They live in code, not a doc, so a stale
 * one fails a test rather than misleading a spreadsheet — see
 * `tests/unit/cost.test.ts`, which pins the arithmetic, not the prices.
 */

/** Dollars per **million** tokens, per model. Confirm against current pricing. */
export interface ModelPrice {
  /** Fresh input tokens. */
  input: number;
  /** Output tokens. */
  output: number;
  /**
   * Cached-input reads. Anthropic bills these at 0.1× base input; kept explicit
   * rather than derived so a model that prices caching differently just changes
   * its row.
   */
  cacheRead: number;
  /** Cache writes (the 5-minute breakpoint), billed at 1.25× base input. */
  cacheWrite: number;
}

/**
 * The pricing table. Per **million** tokens.
 *
 * Keyed by the model id the provider records on a run (`runs.model`). A model
 * absent here is priced at `null` by {@link checkCost} — an unknown model must
 * read as "cannot price", never as free, or a total silently understates.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Anthropic cache convention: read = 0.1× input, write(5m) = 1.25× input.
  'claude-haiku-4-5': { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-sonnet-5': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-opus-4-8': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
};

/** Anthropic's server-side web-search tool: $10 per 1,000 searches. */
export const WEB_SEARCH_PRICE_PER_1K = 10.0;

/** A cost broken into its parts, so a caller can see where the money went. */
export interface CostBreakdown {
  inputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  outputCost: number;
  searchCost: number;
  total: number;
}

/**
 * Dollars for one check's `TokenUsage` at `model`'s prices.
 *
 * Returns `null` when the model is not in {@link MODEL_PRICES} — the honest
 * answer to "what did an unpriced model cost" is "unknown", and a caller
 * summing many checks must be able to tell that apart from zero.
 *
 * @param usage - as recorded on the run, or null when the provider reported none
 * @param model - the run's model id
 * @param prices - override table, for tests or a what-if
 */
export function checkCost(
  usage: TokenUsage | null,
  model: string,
  prices: Record<string, ModelPrice> = MODEL_PRICES,
): CostBreakdown | null {
  // `Object.hasOwn`, not `prices[model] === undefined`: this repo doesn't run
  // `noUncheckedIndexedAccess`, so a `Record` index is typed as present and the
  // undefined check reads as dead code to the linter. The `hasOwn` guard is the
  // honest one — an unpriced model returns null, never a spurious zero.
  if (usage === null || !Object.hasOwn(prices, model)) return null;
  const price = prices[model];

  const perToken = (tokens: number, dollarsPerMillion: number): number => (tokens / 1_000_000) * dollarsPerMillion;

  const inputCost = perToken(usage.inputTokens, price.input);
  const cacheReadCost = perToken(usage.cacheReadTokens, price.cacheRead);
  const cacheWriteCost = perToken(usage.cacheWriteTokens, price.cacheWrite);
  const outputCost = perToken(usage.outputTokens, price.output);
  const searchCost = (usage.webSearches / 1000) * WEB_SEARCH_PRICE_PER_1K;

  return {
    inputCost,
    cacheReadCost,
    cacheWriteCost,
    outputCost,
    searchCost,
    total: inputCost + cacheReadCost + cacheWriteCost + outputCost + searchCost,
  };
}

/**
 * A per-check cost projected to a monthly per-topic figure at a check cadence.
 *
 * The one number the business model is actually about: a check costs cents, but
 * the bill is checks × cadence × topics, so the memo (NEWS-434) argues in
 * dollars-per-topic-per-month. This does that projection and nothing else.
 *
 * @param perCheck - dollars for a single check
 * @param intervalHours - hours between checks (24 = daily, the app's default)
 */
export function monthlyPerTopic(perCheck: number, intervalHours: number): number {
  const checksPerMonth = (24 / intervalHours) * (365.25 / 12);
  return perCheck * checksPerMonth;
}
