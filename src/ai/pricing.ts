import type { ModelPrice } from './price-schema.js';
import type { TokenUsage } from './types.js';

/**
 * Costing.
 *
 * Prices are not stored on a `CheckRun`: a run records what it *used*, and
 * money is derived at display time. Otherwise a price change would silently
 * make every historical total wrong, with no way to correct it.
 *
 * The table below is the **seed and fallback** only — the live rates come from
 * `<data-dir>/prices.json`, which is editable by hand and refreshable from a
 * published manifest, so a rate change never needs a new build (NEWS-93). See
 * `src/ai/price-store.ts`.
 */

/**
 * When the built-in rates were last checked against the vendor's own page.
 * The live table carries its own `verifiedOn`, which is what the UI shows.
 */
export const BUILTIN_PRICES_VERIFIED_ON = '2026-07-27';

/** Anthropic bills cache reads at 0.1× and 5-minute cache writes at 1.25× base input. */
function anthropicPrice(inputPerMTok: number, outputPerMTok: number): ModelPrice {
  return {
    inputPerMTok,
    cacheReadPerMTok: inputPerMTok * 0.1,
    cacheWritePerMTok: inputPerMTok * 1.25,
    outputPerMTok,
    // $10 per 1,000 searches, and a search that errors is not billed.
    perThousandSearches: 10,
  };
}

/**
 * Per-model prices, keyed by the exact model id the provider was asked for.
 *
 * Deliberately **not** exhaustive and deliberately **not** guessed: a model
 * absent from the live table yields no estimate at all (see `estimateCostUsd`),
 * which is honest, where a made-up rate would be a number the user might act
 * on. Add entries only from the vendor's published pricing.
 *
 * These are the *shipped defaults*. Users override them by editing
 * `prices.json`, and a published manifest can replace them wholesale — so a
 * missing model here is an inconvenience, not a dead end.
 */
export const BUILTIN_PRICES: Readonly<Record<string, ModelPrice | undefined>> = {
  // Anthropic — verified against the pricing page on PRICES_VERIFIED_ON.
  'claude-fable-5': anthropicPrice(10, 50),
  'claude-opus-5': anthropicPrice(5, 25),
  'claude-opus-4-8': anthropicPrice(5, 25),
  'claude-opus-4-7': anthropicPrice(5, 25),
  'claude-opus-4-6': anthropicPrice(5, 25),
  'claude-opus-4-5': anthropicPrice(5, 25),
  // Introductory pricing through 2026-08-31; $3/$15 after. Deliberately the
  // *higher* of the two — an estimate that overstates is the safe direction for
  // a budget cap, and it stops being an underestimate the moment intro ends.
  'claude-sonnet-5': anthropicPrice(3, 15),
  'claude-sonnet-4-6': anthropicPrice(3, 15),
  'claude-sonnet-4-5': anthropicPrice(3, 15),
  'claude-haiku-4-5': anthropicPrice(1, 5),
  // OpenAI models are intentionally absent from the *shipped defaults*: their
  // rates weren't verifiable from a vendor source at the time of writing, and a
  // wrong price is worse than a missing one. Since NEWS-93 that is no longer a
  // dead end — an OpenAI user can add them to `prices.json` themselves without
  // waiting for a release. See docs/19-cost-visibility.md.
};

/** Whether a cost can be estimated for this model against a given table. */
export function hasPrice(model: string, prices: Readonly<Record<string, ModelPrice | undefined>>): boolean {
  return prices[model] !== undefined;
}

/**
 * Estimated USD cost of one check, or **null** when it cannot be known.
 *
 * Null is a first-class answer with two distinct causes, both real: the
 * provider reported no usage (the CLI providers never do — a subscription
 * check spends plan quota, not dollars), or the model isn't in the price
 * table. Callers must not coerce null to 0; "unknown" and "free" are the two
 * things a spend figure most needs to keep apart.
 */
export function estimateCostUsd(
  model: string,
  usage: TokenUsage | null,
  prices: Readonly<Record<string, ModelPrice | undefined>>,
): number | null {
  if (usage === null) return null;
  const price = prices[model];
  if (price === undefined) return null;
  const perToken = (tokens: number, perMTok: number): number => (tokens / 1_000_000) * perMTok;
  return (
    perToken(usage.inputTokens, price.inputPerMTok) +
    perToken(usage.cacheReadTokens, price.cacheReadPerMTok) +
    perToken(usage.cacheWriteTokens, price.cacheWritePerMTok) +
    perToken(usage.outputTokens, price.outputPerMTok) +
    (usage.webSearches / 1000) * price.perThousandSearches
  );
}

/** Format a cost for display: cents-precision, but never a misleading "$0.00". */
export function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.01) return '<$0.01';
  return `$${amount.toFixed(2)}`;
}
