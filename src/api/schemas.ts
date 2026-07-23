import { z } from 'zod';

import { PROVIDER_NAMES } from '../ai/types.js';
import { CheckRunSchema, NewsItemSchema, SettingsSchema, TopicSchema } from '../db/schemas.js';

// Request schemas (validated server-side).

export const CreateTopicReqSchema = z.object({ name: z.string().min(1).max(200) });
export type CreateTopicReq = z.infer<typeof CreateTopicReqSchema>;

export const UpdateTopicReqSchema = z.object({ paused: z.boolean() });
export type UpdateTopicReq = z.infer<typeof UpdateTopicReqSchema>;

const MIN_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const UpdateSettingsReqSchema = z
  .object({
    checkIntervalMs: z.number().int().min(MIN_CHECK_INTERVAL_MS),
    provider: z.enum(PROVIDER_NAMES),
    model: z.string().max(200),
    endpoint: z.string().max(500),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one setting is required' });
export type UpdateSettingsReq = z.infer<typeof UpdateSettingsReqSchema>;

export const CheckReqSchema = z.object({ topicId: z.string().optional() });
export type CheckReq = z.infer<typeof CheckReqSchema>;

export const OpenExternalReqSchema = z.object({ url: z.url() });
export type OpenExternalReq = z.infer<typeof OpenExternalReqSchema>;

// Response schemas (shared with the client, which validates on receipt).

export const StateRespSchema = z.object({
  topics: z.array(TopicSchema),
  items: z.array(NewsItemSchema),
  settings: SettingsSchema,
  runs: z.array(CheckRunSchema),
  checking: z.array(z.string()),
  /** Whether the currently-selected provider searches the live web. */
  searchesWeb: z.boolean(),
});
export type StateResp = z.infer<typeof StateRespSchema>;

export const ProviderInfoSchema = z.object({
  name: z.enum(PROVIDER_NAMES),
  label: z.string(),
  searchesWeb: z.boolean(),
  endpointConfigurable: z.boolean(),
  /** null = not probed (auto); otherwise whether the provider is usable now. */
  available: z.boolean().nullable(),
});
export type ProviderInfo = z.infer<typeof ProviderInfoSchema>;

export const ProvidersRespSchema = z.object({ providers: z.array(ProviderInfoSchema) });
export type ProvidersResp = z.infer<typeof ProvidersRespSchema>;

export const ErrorRespSchema = z.object({ error: z.string() });
export type ErrorResp = z.infer<typeof ErrorRespSchema>;
