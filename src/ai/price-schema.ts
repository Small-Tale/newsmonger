import { z } from 'zod';

/**
 * Price shapes, kept in their own module because **the browser bundle imports
 * them** (via `api/schemas.ts`) and `price-store.ts` reaches for `node:fs`.
 * Same reason `KEYED_PROVIDERS` lives in `ai/types.ts` rather than beside the
 * keychain code: a schema shared with the client must not drag Node built-ins
 * into esbuild's graph.
 */

export const ModelPriceSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  cacheReadPerMTok: z.number().nonnegative(),
  cacheWritePerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  perThousandSearches: z.number().nonnegative(),
});
export type ModelPrice = z.infer<typeof ModelPriceSchema>;

export const PriceTableSchema = z.object({
  /** When these rates were checked against the vendors, `YYYY-MM-DD`. */
  verifiedOn: z.string(),
  /** Where they came from, shown in the UI so an undated number isn't trusted blind. */
  sources: z.array(z.string()).default([]),
  models: z.record(z.string(), ModelPriceSchema),
});
export type PriceTable = z.infer<typeof PriceTableSchema>;
