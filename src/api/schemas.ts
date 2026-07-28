import { z } from 'zod';

import { KEYED_PROVIDERS, PROVIDER_NAMES } from '../ai/types.js';
import {
  CheckRunSchema,
  MAX_GUIDANCE_LENGTH,
  NewsItemSchema,
  SettingsSchema,
  TopicSchema,
} from '../db/schemas.js';

// Request schemas (validated server-side).

export const CreateTopicReqSchema = z.object({ name: z.string().min(1).max(200) });
export type CreateTopicReq = z.infer<typeof CreateTopicReqSchema>;

// A topic PATCH may toggle pause / high-priority, set guidance, and/or set the
// category; at least one is required. Guidance accepts '' — that is how the user
// clears it, and `category: null` is how they clear that.
export const UpdateTopicReqSchema = z
  .object({
    paused: z.boolean(),
    highPriority: z.boolean(),
    guidance: z.string().max(MAX_GUIDANCE_LENGTH),
    /**
     * Category slug (NEWS-97). A plain nullable string, not an enum — the
     * taxonomy is edited in code (FR-22.3), and an enum here would start
     * rejecting requests the moment someone renamed a slug.
     */
    category: z.string().nullable(),
    subcategory: z.string().nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' })
  // A subcategory without its parent is meaningless — it would render as the
  // bare category anyway, and storing it would look like a classification.
  .refine((v) => !(v.subcategory !== undefined && v.category === undefined), {
    message: 'subcategory requires category',
  });
export type UpdateTopicReq = z.infer<typeof UpdateTopicReqSchema>;

const MIN_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const UpdateSettingsReqSchema = z
  .object({
    checkIntervalMs: z.number().int().min(MIN_CHECK_INTERVAL_MS),
    // The <= checkIntervalMs constraint is enforced by clamping in the store,
    // not rejected here — clamping is the intended UX (NEWS-56).
    highPriorityIntervalMs: z.number().int().min(MIN_CHECK_INTERVAL_MS),
    provider: z.enum(PROVIDER_NAMES),
    model: z.string().max(200),
    endpoint: z.string().max(500),
    notifyOnNewItems: z.boolean(),
    scheduleMode: z.enum(['interval', 'daily']),
    checkConcurrency: z.number().int().min(1).max(8),
    // '' clears it. Non-empty must be https — a plaintext manifest could be
    // swapped in transit, and it decides what the budget cap acts on.
    priceManifestUrl: z.union([z.literal(''), z.url().startsWith('https://').max(500)]),
    // Capped at 8: this is "a few times a day", and each slot is a full sweep.
    dailyTimes: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).max(8),
    monthlyBudgetUsd: z.number().nonnegative().max(10_000),
    // 0 = keep forever; the 10-year ceiling is a sanity bound, not a policy.
    itemRetentionDays: z.number().int().nonnegative().max(3650),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one setting is required' });
export type UpdateSettingsReq = z.infer<typeof UpdateSettingsReqSchema>;

export const CheckReqSchema = z.object({ topicId: z.string().optional() });
export type CheckReq = z.infer<typeof CheckReqSchema>;

export const OpenExternalReqSchema = z.object({ url: z.url() });
export type OpenExternalReq = z.infer<typeof OpenExternalReqSchema>;

/** Body of an item update: bookmark and/or off-topic flag; at least one. */
export const SaveItemReqSchema = z
  .object({ saved: z.boolean(), offTopic: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' });
export type SaveItemReq = z.infer<typeof SaveItemReqSchema>;

/** Body of a key save. The value is write-only — no endpoint ever returns it. */
export const SaveKeyReqSchema = z.object({ key: z.string().min(1).max(500) });
export type SaveKeyReq = z.infer<typeof SaveKeyReqSchema>;

// Response schemas (shared with the client, which validates on receipt).

/**
 * Estimated spend for a period (NEWS-79).
 *
 * `unpricedRuns` travels with the total on purpose: a bare number would read as
 * complete, and a run whose provider reported no usage (or whose model has no
 * published price) is genuinely *unknown*, not zero. The UI says so.
 */
export const StateRespSchema = z.object({
  topics: z.array(TopicSchema),
  /**
   * Newest item ids across all topics, newest first (NEWS-75). The
   * notification detector reads this; the feed itself comes from `/api/items`
   * (NEWS-76), so `/api/state` no longer carries the full item list.
   */
  latestItemIds: z.array(z.string()).default([]),
  /** Off-topic story count per topic, for the "Review Flagged (N)" badge (NEWS-76). */
  flaggedByTopic: z.record(z.string(), z.number().int()).default({}),
  settings: SettingsSchema,
  runs: z.array(CheckRunSchema),
  checking: z.array(z.string()),
  /** App version, for diagnostics bundles (NEWS-88). '' if it can't be read. */
  appVersion: z.string().default(''),
});
export type StateResp = z.infer<typeof StateRespSchema>;

/** A feed page (server-side pagination, NEWS-74). */
export const ItemCursorSchema = z.object({ foundAt: z.string(), id: z.string() });
export const ItemsRespSchema = z.object({
  items: z.array(NewsItemSchema),
  nextCursor: ItemCursorSchema.nullable(),
  total: z.number().int(),
});
export type ItemsResp = z.infer<typeof ItemsRespSchema>;

export const ProviderInfoSchema = z.object({
  name: z.enum(PROVIDER_NAMES),
  label: z.string(),
  endpointConfigurable: z.boolean(),
  /** null = not probed (auto); otherwise whether the provider is usable now. */
  available: z.boolean().nullable(),
});
export type ProviderInfo = z.infer<typeof ProviderInfoSchema>;

export const ProvidersRespSchema = z.object({ providers: z.array(ProviderInfoSchema) });
export type ProvidersResp = z.infer<typeof ProvidersRespSchema>;

/**
 * Per-provider key status.
 *
 * Deliberately carries no trace of the key itself — not the value, not a masked
 * tail like `sk-…9f2c`. A mask still leaks length and a distinguishing suffix,
 * and it buys nothing the user can't get from `source`: they know which key
 * they saved and where it came from. `configured` + `source` is the whole
 * contract, and it's enforced here rather than left to each route.
 */
export const KeyStatusSchema = z.object({
  provider: z.enum(KEYED_PROVIDERS),
  label: z.string(),
  configured: z.boolean(),
  /** 'env' keys can't be removed from the app — the UI hides Remove for them. */
  source: z.enum(['env', 'keychain']).nullable(),
  envVar: z.string(),
});
export type KeyStatus = z.infer<typeof KeyStatusSchema>;

export const KeysRespSchema = z.object({
  keys: z.array(KeyStatusSchema),
  /** False on a machine with no usable credential store; the UI explains. */
  keychainAvailable: z.boolean(),
  /** Platform-specific name for the store, e.g. 'Keychain'. */
  keychainLabel: z.string(),
});
export type KeysResp = z.infer<typeof KeysRespSchema>;

export const ErrorRespSchema = z.object({ error: z.string() });
export type ErrorResp = z.infer<typeof ErrorRespSchema>;
