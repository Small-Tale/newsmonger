import { z } from 'zod';

import { SEARCH_PROVIDER_NAMES } from '../ai/search/types.js';
import { PROVIDER_NAMES } from '../ai/types.js';

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
  /** Which AI provider performs checks. `auto` picks the best available. */
  provider: z.enum(PROVIDER_NAMES).default('auto'),
  /** Model id for the provider; '' means the provider's default. */
  model: z.string().default(''),
  /** Base URL for endpoint-based providers (Ollama / OpenAI-compatible); '' = default. */
  endpoint: z.string().default(''),
  /** Search backend that grounds non-searching providers on live results. */
  searchProvider: z.enum(SEARCH_PROVIDER_NAMES).default('none'),
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
  /** Which provider ran this check (e.g. "anthropic"); null if it never resolved one. */
  provider: z.string().nullable().default(null),
  /** Whether this check was grounded on external search (non-searching provider + search backend). */
  grounded: z.boolean().default(false),
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
    settings: { checkIntervalMs: DEFAULT_CHECK_INTERVAL_MS, provider: 'auto', model: '', endpoint: '', searchProvider: 'none' },
    runs: [],
  };
}
