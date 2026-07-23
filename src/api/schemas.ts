import { z } from 'zod';

import { CheckRunSchema, NewsItemSchema, SettingsSchema, TopicSchema } from '../db/schemas.js';

// Request schemas (validated server-side).

export const CreateTopicReqSchema = z.object({ name: z.string().min(1).max(200) });
export type CreateTopicReq = z.infer<typeof CreateTopicReqSchema>;

export const UpdateTopicReqSchema = z.object({ paused: z.boolean() });
export type UpdateTopicReq = z.infer<typeof UpdateTopicReqSchema>;

const MIN_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const UpdateSettingsReqSchema = z.object({
  checkIntervalMs: z.number().int().min(MIN_CHECK_INTERVAL_MS),
});
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
});
export type StateResp = z.infer<typeof StateRespSchema>;

export const ErrorRespSchema = z.object({ error: z.string() });
export type ErrorResp = z.infer<typeof ErrorRespSchema>;
