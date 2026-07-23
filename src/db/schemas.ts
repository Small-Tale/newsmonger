import { z } from 'zod';

/** A topic the user wants news about. */
export const TopicSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  paused: z.boolean(),
  createdAt: z.string(),
  /** ISO timestamp of the last completed check (success or failure); null if never checked. */
  lastCheckedAt: z.string().nullable(),
});
export type Topic = z.infer<typeof TopicSchema>;

export const NewsSourceSchema = z.object({
  title: z.string(),
  url: z.string(),
});
export type NewsSource = z.infer<typeof NewsSourceSchema>;

/** A news story found for a topic. */
export const NewsItemSchema = z.object({
  id: z.string(),
  topicId: z.string(),
  title: z.string(),
  summary: z.string(),
  sources: z.array(NewsSourceSchema),
  /** Normalized key used to deduplicate against stories already seen. */
  dedupeKey: z.string(),
  foundAt: z.string(),
});
export type NewsItem = z.infer<typeof NewsItemSchema>;

export const SettingsSchema = z.object({
  /** How often each topic is checked for news, in milliseconds. */
  checkIntervalMs: z.number().int().positive(),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const CheckRunSchema = z.object({
  id: z.string(),
  topicId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  status: z.enum(['running', 'succeeded', 'failed']),
  newItems: z.number().int(),
  error: z.string().nullable(),
});
export type CheckRun = z.infer<typeof CheckRunSchema>;

export const DataFileSchema = z.object({
  topics: z.array(TopicSchema),
  items: z.array(NewsItemSchema),
  settings: SettingsSchema,
  runs: z.array(CheckRunSchema),
});
export type DataFile = z.infer<typeof DataFileSchema>;

export const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day

export function emptyDataFile(): DataFile {
  return {
    topics: [],
    items: [],
    settings: { checkIntervalMs: DEFAULT_CHECK_INTERVAL_MS },
    runs: [],
  };
}
