import { z } from 'zod';

import { KEYED_PROVIDERS, PROVIDER_NAMES } from '../ai/types.js';
import { CheckRunSchema, NewsItemSchema, SettingsSchema, TopicSchema } from '../db/schemas.js';

// Request schemas (validated server-side).

export const CreateTopicReqSchema = z.object({ name: z.string().min(1).max(200) });
export type CreateTopicReq = z.infer<typeof CreateTopicReqSchema>;

// A topic PATCH may toggle pause and/or high-priority; at least one is required.
export const UpdateTopicReqSchema = z
  .object({ paused: z.boolean(), highPriority: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' });
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

export const StateRespSchema = z.object({
  topics: z.array(TopicSchema),
  items: z.array(NewsItemSchema),
  settings: SettingsSchema,
  runs: z.array(CheckRunSchema),
  checking: z.array(z.string()),
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
