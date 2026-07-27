import { z } from 'zod';

import { stripMarkup } from '../ai/sanitize.js';
import { PROVIDER_NAMES } from '../ai/types.js';

export const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day

/**
 * Cap on a topic's guidance text (NEWS-80).
 *
 * Generous enough for a paragraph of real instructions, small enough that it
 * can't crowd out the rest of the prompt or bloat the data file. It is a
 * *storage* bound, not a stylistic one — the model is not told about it.
 */
export const MAX_GUIDANCE_LENGTH = 1000;

/**
 * Default story-retention window, in days (NEWS-87).
 *
 * A year: long enough that nobody hits it by surprise, short enough that the
 * data file stops growing without bound. `runs` has been capped at 200 all
 * along and images are already pruned — items were the one collection with no
 * ceiling at all.
 */
export const DEFAULT_RETENTION_DAYS = 365;

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
  /**
   * The user's free-text steer for what they want from this topic (NEWS-80) —
   * "regulatory and safety news only, not stock moves". Fed to the prompt as an
   * instruction. Empty (the default) means the topic name alone, which is
   * exactly the pre-NEWS-80 behaviour.
   */
  guidance: z.string().max(MAX_GUIDANCE_LENGTH).default(''),
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
  /**
   * The outlet that published it (NEWS-82), e.g. "Reuters". Null when the model
   * didn't say; the UI falls back to the URL's registrable domain, which is
   * usually close enough to be useful and never wrong in a misleading way.
   */
  outlet: z.string().nullable().default(null),
  /**
   * When the article was published, as `YYYY-MM-DD` (NEWS-82). **Null is the
   * normal case** — the model often doesn't know, and inventing a date would be
   * worse than showing none, since recency is exactly what a reader is judging.
   *
   * Distinct from the item's `foundAt`: a catch-up check after a week's
   * downtime files week-old articles under today.
   */
  publishedAt: z.string().nullable().default(null),
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
  /**
   * How normal-priority topics are scheduled (NEWS-84).
   *
   * `interval` is the original behaviour: a duration since the last check.
   * `daily` checks at fixed local times instead — "the 8am briefing" is how
   * people actually think about a digest, and an interval anchored to whenever
   * the last check happened to run slowly walks around the clock.
   *
   * High-priority topics always use the interval, where "every 2 hours" is the
   * right mental model (see FR-12.4).
   */
  scheduleMode: z.enum(['interval', 'daily']).default('interval').catch('interval'),
  /**
   * Local times of day for `daily` mode, as `HH:MM` in 24-hour form. Sorted and
   * de-duplicated by the store. An empty list falls back to the interval, so
   * the mode can never leave a topic unscheduled forever.
   */
  dailyTimes: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).default(['08:00']),
  /**
   * How many topics a sweep checks at once (NEWS-81). Default 3.
   *
   * A real check takes minutes, so a strictly sequential sweep over 20 topics
   * runs for over an hour. Kept modest rather than unbounded: too high just
   * converts a slow sweep into provider rate-limit errors, and the point is to
   * finish sooner, not to finish with 429s.
   */
  checkConcurrency: z.number().int().min(1).max(8).default(3).catch(3),
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
  /**
   * Monthly ceiling on estimated spend, in USD (NEWS-79). 0 means no cap.
   * Crossing it pauses *scheduled* checks only — manual ones still run, so a
   * capped month never locks the user out of their own app.
   */
  monthlyBudgetUsd: z.number().nonnegative().default(0),
  /**
   * HTTPS URL of a published price manifest (NEWS-93). Empty = don't fetch.
   *
   * Fetched at startup and once a day, replacing `<data-dir>/prices.json`, so
   * corrected rates can reach installs without shipping a new build. Rates
   * change on the vendors' schedule, not on a release schedule.
   */
  priceManifestUrl: z.string().default(''),
  /**
   * How long a story is kept, in days (NEWS-87). 0 means forever, which was the
   * behaviour before this existed. **Bookmarked stories are never pruned** — the
   * user marked those as worth keeping, and a retention window is about the
   * pile that accumulates on its own, not about the things they chose.
   */
  itemRetentionDays: z.number().int().nonnegative().default(DEFAULT_RETENTION_DAYS),
}).transform((s) => ({
  // Enforce highPriorityIntervalMs <= checkIntervalMs on every load. The field's
  // default is a fixed 1 day, so a legacy file with a *shorter* default interval
  // (or any file that slipped past the store's clamp) would otherwise make a
  // "high priority" topic check *less* often than a normal one (NEWS-56).
  ...s,
  highPriorityIntervalMs: Math.min(s.highPriorityIntervalMs, s.checkIntervalMs),
}));
export type Settings = z.infer<typeof SettingsSchema>;

/**
 * What a check consumed (NEWS-79). Counts only — cost is derived from these at
 * display time, so a price change can't make a stored record wrong.
 */
export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  webSearches: z.number().int().nonnegative(),
});

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
  /** Model the check ran on, for pricing the usage below; null if unknown. */
  model: z.string().nullable().default(null),
  /**
   * Tokens and searches this check consumed, or null when the provider can't
   * report them (the subscription CLIs never do). Null means **unknown**, not
   * zero — spend figures must keep the two apart.
   */
  usage: TokenUsageSchema.nullable().default(null),
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
      scheduleMode: 'interval',
      dailyTimes: ['08:00'],
      checkConcurrency: 3,
      priceManifestUrl: '',
      monthlyBudgetUsd: 0,
      itemRetentionDays: DEFAULT_RETENTION_DAYS,
    },
    runs: [],
  };
}
