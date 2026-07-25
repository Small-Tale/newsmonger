import { z } from 'zod';

import { stripMarkup } from '../ai/sanitize.js';
import { PROVIDER_NAMES } from '../ai/types.js';

export const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day

/** A topic the user wants news about. */
export const TopicSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  paused: z.boolean(),
  /**
   * Whether the topic is checked on the shorter high-priority interval instead
   * of the default one (NEWS-56). Defaults false. It changes only *cadence* —
   * not ordering within a sweep, and not the attendance gate.
   */
  highPriority: z.boolean().default(false),
  createdAt: z.string(),
  /**
   * ISO timestamp of the last check *attempt*, success or failure; null if
   * never attempted. Drives scheduling — advancing it on failure is what stops
   * a broken provider from being retried every tick.
   */
  lastCheckedAt: z.string().nullable(),
  /**
   * ISO timestamp that news is *covered through* — the last check that
   * actually succeeded. This is what the prompt asks from, so a failed check
   * can't quietly swallow the pending window: fail at 09:00 with news pending
   * since five days ago and the next successful check still asks for all five
   * days. Null until the first success.
   */
  coveredThroughAt: z.string().nullable().default(null),
});
export type Topic = z.infer<typeof TopicSchema>;

export const NewsSourceSchema = z.object({
  title: z.string().transform(stripMarkup),
  url: z.string(),
});
export type NewsSource = z.infer<typeof NewsSourceSchema>;

/** A news story found for a topic. */
export const NewsItemSchema = z.object({
  id: z.string(),
  topicId: z.string(),
  // Sanitized on read as well as on write: items stored before the parse-time
  // strip existed still carry citation markup, and this cleans them the next
  // time the data file is loaded rather than needing a migration.
  title: z.string().transform(stripMarkup),
  summary: z.string().transform(stripMarkup),
  /** Whether the user bookmarked this story (NEWS-42). Defaults false. */
  saved: z.boolean().default(false),
  /**
   * Whether the user flagged this story as off-topic (NEWS-61). Hidden from the
   * feed by default and fed to the topic's prompt as a negative example, so the
   * model can infer what the user actually meant. Defaults false.
   */
  offTopic: z.boolean().default(false),
  sources: z.array(NewsSourceSchema),
  /**
   * Lead image, cached locally. `hash` names the file the image route serves;
   * `sourceUrl` is kept for attribution and debugging, never fetched by the
   * browser. Null when the article had no usable image — most layouts of a
   * news feed need to handle that anyway, since roughly a third don't.
   */
  image: z
    .object({ hash: z.string(), sourceUrl: z.string() })
    .nullable()
    .default(null),
  /** Normalized key used to deduplicate against stories already seen. */
  dedupeKey: z.string(),
  foundAt: z.string(),
});
export type NewsItem = z.infer<typeof NewsItemSchema>;

export const SettingsSchema = z.object({
  /** How often a normal topic is checked for news, in milliseconds. */
  checkIntervalMs: z.number().int().positive(),
  /**
   * How often a *high-priority* topic is checked (NEWS-56). Always kept ≤
   * `checkIntervalMs`: the store clamps whichever value the user didn't just
   * change. Defaults to the same as the default interval, so the feature is
   * inert until the user shortens it. Older data files without the field get
   * this default.
   */
  highPriorityIntervalMs: z.number().int().positive().default(DEFAULT_CHECK_INTERVAL_MS),
  /** Which AI provider performs checks. `auto` picks the best available. */
  provider: z.enum(PROVIDER_NAMES).default('auto').catch('auto'),
  /** Model id for the provider; '' means the provider's default. */
  model: z.string().default(''),
  /** Base URL for endpoint-based providers (Ollama / OpenAI-compatible); '' = default. */
  endpoint: z.string().default(''),
  /**
   * Whether to raise an OS notification (and bounce the dock / flash the
   * taskbar) when new stories arrive while the app isn't focused. Opt-in — off
   * by default, since it needs a browser permission grant and shouldn't
   * surprise anyone.
   */
  notifyOnNewItems: z.boolean().default(false),
}).transform((s) => ({
  // Enforce highPriorityIntervalMs <= checkIntervalMs on every load. The field's
  // default is a fixed 1 day, so a legacy file with a *shorter* default interval
  // (or any file that slipped past the store's clamp) would otherwise make a
  // "high priority" topic check *less* often than a normal one (NEWS-56).
  ...s,
  highPriorityIntervalMs: Math.min(s.highPriorityIntervalMs, s.checkIntervalMs),
}));
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
});
export type CheckRun = z.infer<typeof CheckRunSchema>;

export const DataFileSchema = z.object({
  topics: z.array(TopicSchema),
  items: z.array(NewsItemSchema),
  settings: SettingsSchema,
  runs: z.array(CheckRunSchema),
});
export type DataFile = z.infer<typeof DataFileSchema>;

export function emptyDataFile(): DataFile {
  return {
    topics: [],
    items: [],
    settings: {
      checkIntervalMs: DEFAULT_CHECK_INTERVAL_MS,
      highPriorityIntervalMs: DEFAULT_CHECK_INTERVAL_MS,
      provider: 'auto',
      model: '',
      endpoint: '',
      notifyOnNewItems: false,
    },
    runs: [],
  };
}
