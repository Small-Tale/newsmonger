import { z } from 'zod';

import { EFFORT_LEVELS, KEYED_PROVIDERS, PROVIDER_NAMES } from '../ai/types.js';
import {
  CheckRunSchema,
  MAX_GUIDANCE_LENGTH,
  NewsItemSchema,
  QuarantineSchema,
  SettingsSchema,
  TopicSchema,
} from '../db/schemas.js';

// Request schemas (validated server-side).

/**
 * Body of a topic creation.
 *
 * The optional fields exist for discovery (NEWS-126): a topic added from a
 * suggestion arrives with a guidance steer (FR-24.12) and a pre-validated
 * classification (FR-24.13). They are set **in the same request** rather than
 * PATCHed afterwards because creating a topic fires its first check immediately
 * (FR-1.12) — a follow-up PATCH would land after that check had already run
 * unsteered, which is precisely what FR-24.12 exists to prevent.
 */
export const CreateTopicReqSchema = z.object({
  name: z.string().min(1).max(200),
  guidance: z.string().max(MAX_GUIDANCE_LENGTH).optional(),
  category: z.string().min(1).optional(),
  subcategory: z.string().min(1).optional(),
});
export type CreateTopicReq = z.infer<typeof CreateTopicReqSchema>;

/**
 * A shared topic list, on its way back in (FR-30.5–30.9, NEWS-318).
 *
 * The file `GET /api/export-topics.json` writes (FR-30.2) — and, deliberately, a
 * file a person may have edited by hand, since being hand-editable is the point
 * of that format. So this is **lenient about what it ignores and strict about
 * what it accepts**: an `exportedAt` it does not need, or a future field it does
 * not know, must not make a usable list unreadable, but a name that is not a
 * string is a file this cannot honestly import.
 *
 * `guidance`, `category` and `subcategory` are optional so the smallest useful
 * file someone could type — `{"topics":[{"name":"Fusion energy"}]}` — is valid.
 *
 * Bounds match `CreateTopicReqSchema`, because these are the same fields
 * arriving by a different door; a list that could carry a 10,000-character name
 * past the limit the form enforces would be a way around it.
 */
export const ImportTopicsReqSchema = z.object({
  topics: z.array(
    z.object({
      name: z.string().min(1).max(200),
      guidance: z.string().max(MAX_GUIDANCE_LENGTH).optional(),
      category: z.string().min(1).nullish(),
      subcategory: z.string().min(1).nullish(),
    }),
  ),
});
export type ImportTopicsReq = z.infer<typeof ImportTopicsReqSchema>;

/**
 * An exported story archive, on its way back in (FR-30.10–30.14, NEWS-319).
 *
 * **The file `GET /api/export.json` already writes** (FR-21.4), not a new one.
 * "An export nothing can read" is the whole complaint behind this, and inventing
 * a second shape would leave the first still unreadable.
 *
 * `topic` is the topic's **name**, which is why the export carries a name rather
 * than an id — an id means nothing on another install. `null` is what the export
 * writes for a story whose topic was deleted before the file was made.
 *
 * `saved` is optional and defaults false; `offTopic` is absent by construction,
 * because FR-21.2 keeps flagged stories out of every export. Nothing here can
 * carry one, which is the point (FR-30.13).
 */
export const ImportStoriesReqSchema = z.object({
  stories: z.array(
    z.object({
      topic: z.string().min(1).nullable(),
      title: z.string().min(1),
      summary: z.string().default(''),
      sources: z
        .array(
          z.object({
            title: z.string().default(''),
            url: z.string(),
            outlet: z.string().nullish(),
            publishedAt: z.string().nullish(),
          }),
        )
        .default([]),
      foundAt: z.string(),
      saved: z.boolean().default(false),
    }),
  ),
});
export type ImportStoriesReq = z.infer<typeof ImportStoriesReqSchema>;

/** What a story import did (FR-30.7, FR-30.12). */
export const ImportStoriesRespSchema = z.object({
  added: z.number().int(),
  skipped: z.number().int(),
  /** Topics the import had to create, named so the report can say so. */
  topicsCreated: z.array(z.string()),
});
export type ImportStoriesResp = z.infer<typeof ImportStoriesRespSchema>;

/** What an import did, so the UI can say it (FR-30.7). */
export const ImportTopicsRespSchema = z.object({
  added: z.array(z.string()),
  skipped: z.array(z.string()),
});
export type ImportTopicsResp = z.infer<typeof ImportTopicsRespSchema>;

// A topic PATCH may toggle pause / high-priority, set guidance, and/or set the
// category; at least one is required. Guidance accepts '' — that is how the user
// clears it, and `category: null` is how they clear that.
export const UpdateTopicReqSchema = z
  .object({
    paused: z.boolean(),
    highPriority: z.boolean(),
    /** Rename (NEWS-139). Same bounds as creation — it is the same field. */
    name: z.string().min(1).max(200),
    /**
     * Drop the topic's existing stories (NEWS-139).
     *
     * Only meaningful alongside `name`: it exists so a rename that changes what
     * a topic *means* can discard results that were about the old meaning.
     */
    clearItems: z.boolean(),
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
  })
  // Clearing stories is a consequence of renaming, not an action of its own —
  // there is a delete for that. Accepting it alone would make `PATCH` a way to
  // wipe a topic's history with no rename to justify it.
  .refine((v) => !(v.clearItems === true && v.name === undefined), {
    message: 'clearItems requires name',
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
    // Same closed set as the stored setting; '' = the provider's default.
    effort: z.enum(['', 'low', 'medium', 'high', 'xhigh', 'max']),
    // '' turns backups off. Length-capped like `endpoint`; validity of the path
    // itself is decided when a write is attempted, not here — a folder can be
    // unmounted between the setting and the write anyway.
    backupDir: z.string().max(1000),
    backupPromptNever: z.boolean(),
    // An ISO timestamp, or '' to clear. Bounded so a junk value can't be stored.
    backupPromptSnoozedUntil: z.string().max(64),
    notifyOnNewItems: z.boolean(),
    scheduleMode: z.enum(['interval', 'daily']),
    theme: z.enum(['auto', 'light', 'dark']),
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

/**
 * Hard ceiling on tuner rounds (FR-24.9), enforced at the trust boundary.
 *
 * Declared here rather than in `src/discovery.ts` because the client needs the
 * same number to stop offering another round, and two copies would eventually
 * disagree — the disagreement being a client that offers a button the server
 * rejects. Kept out of the server module so importing it can't pull server-only
 * code into the browser bundle.
 */
export const MAX_TUNE_ROUNDS = 6;

/** Longest free-text description the discover box accepts. */
export const MAX_DISCOVER_QUERY_LENGTH = 500;

/**
 * Body of a discovery request (NEWS-125, `docs/24-topic-discovery.md`).
 *
 * The three entry paths are a discriminated union so an invalid combination —
 * a tuner round with no anchor, a section request carrying a query — is a 400
 * rather than a silently half-honoured call to the model.
 *
 * `exclude` is deliberately **not** part of this: the server fills it in from
 * the topic list so the client cannot forget to (FR-24.11).
 */
export const DiscoverReqSchema = z.object({
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('describe'), query: z.string().max(MAX_DISCOVER_QUERY_LENGTH) }),
    z.object({
      kind: z.literal('section'),
      category: z.string().min(1),
      subcategory: z.string().min(1).nullable(),
    }),
    z.object({
      kind: z.literal('tune'),
      anchor: z.string().min(1),
      direction: z.enum(['narrower', 'similar']),
      kept: z.array(z.string()).max(100).default([]),
      skipped: z.array(z.string()).max(100).default([]),
      // Each round is a billable call, so the bound is enforced server-side and
      // not merely respected by a cooperative client.
      round: z.number().int().min(1).max(MAX_TUNE_ROUNDS),
    }),
  ]),
  limit: z.number().int().min(1).max(50).optional(),
  /**
   * Suggestions the user has already been shown, for "More" (NEWS-136).
   *
   * Deliberately **additive** rather than a way to supply `exclude` wholesale:
   * the server still always adds the topic list itself, so a client that omits
   * this can fail to get fresh ideas but can never be suggested a topic the
   * user already follows. That is FR-24.11's first layer, preserved.
   */
  seen: z.array(z.string()).max(200).optional(),
});
export type DiscoverReq = z.infer<typeof DiscoverReqSchema>;

/** One suggested topic as it reaches the client. */
export const TopicSuggestionSchema = z.object({
  name: z.string(),
  reason: z.string(),
  kind: z.enum(['ongoing', 'evergreen']),
  guidance: z.string(),
  /** Already validated against the live taxonomy server-side (FR-24.13). */
  classification: z.object({ category: z.string(), subcategory: z.string().nullable() }).nullable(),
});

export type TopicSuggestion = z.infer<typeof TopicSuggestionSchema>;

export const DiscoverRespSchema = z.object({
  suggestions: z.array(TopicSuggestionSchema),
  /** True when this answer cost nothing because it came from the cache (FR-24.15). */
  cached: z.boolean(),
});
export type DiscoverResp = z.infer<typeof DiscoverRespSchema>;

/** What discovery has spent this process lifetime (FR-24.14). */
export const DiscoverUsageRespSchema = z.object({
  calls: z.number().int(),
  recent: z.array(
    z.object({
      at: z.string(),
      scope: z.enum(['describe', 'section', 'tune']),
      provider: z.string().nullable(),
      model: z.string().nullable(),
      status: z.enum(['succeeded', 'failed']),
      returned: z.number().int(),
      cached: z.boolean(),
      error: z.string().nullable(),
    }),
  ),
});
export type DiscoverUsageResp = z.infer<typeof DiscoverUsageRespSchema>;

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
  /** Stories found today per topic, for the sidebar count badge (NEWS-242). Absent = none. */
  todayByTopic: z.record(z.string(), z.number().int()).default({}),
  /** Newest story's `foundAt` per topic, for the most-recent sort (NEWS-241). */
  newestItemAtByTopic: z.record(z.string(), z.string()).default({}),
  settings: SettingsSchema,
  runs: z.array(CheckRunSchema),
  checking: z.array(z.string()),
  /** App version, for diagnostics bundles (NEWS-88). '' if it can't be read. */
  appVersion: z.string().default(''),
  /**
   * When scheduled checking last became possible — the later of server start
   * and the last sweep that was turned away (NEWS-247).
   *
   * The "falling behind" banner measures lateness from here rather than from
   * `lastCheckedAt` alone, because wall-clock cannot tell *we cannot keep up*
   * from *we were not permitted to try*. Defaults to epoch 0 so an old client
   * or a fixture without it behaves exactly as before.
   */
  checksPossibleSince: z.string().default('1970-01-01T00:00:00.000Z'),
  /**
   * An unread notice that a database was set aside as unreadable (NEWS-340).
   * `null` in the overwhelmingly normal case. Defaulted so an older server —
   * or a response cached across an upgrade — parses rather than blanking the
   * whole state on a field the client is only going to render a banner from.
   */
  quarantine: QuarantineSchema.nullable().default(null),
});
export type StateResp = z.infer<typeof StateRespSchema>;

/**
 * Where one story sits in its thread (NEWS-282), for the collapsed card's badge
 * (NEWS-283).
 *
 * The **shape** of a thread, not its contents: three numbers per story, which is
 * what a badge can say without the timeline being fetched. The stories
 * themselves come from `GET /api/items/:id/thread`, on expand — folding them
 * into the feed page would multiply a size-sensitive payload by the average
 * thread length for a pane nobody has opened (`docs/17-server-pagination.md`).
 */
export const ThreadSummarySchema = z.object({
  /** 1-based position in the thread, chronologically. */
  position: z.number().int(),
  /** How many stories the thread holds. Always ≥ 2 — see below. */
  size: z.number().int(),
  /** `foundAt` of the thread's first story: when the subject first appeared. */
  startedAt: z.string(),
});
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;

/** A feed page (server-side pagination, NEWS-74). */
export const ItemCursorSchema = z.object({ foundAt: z.string(), id: z.string() });
export const ItemsRespSchema = z.object({
  items: z.array(NewsItemSchema),
  nextCursor: ItemCursorSchema.nullable(),
  total: z.number().int(),
  /**
   * Thread shape per story id (NEWS-282), for the stories on **this page**.
   *
   * **Only stories in a thread of two or more get an entry**, which is what
   * keeps this from growing the payload: a thread of one is the ordinary case
   * (FR-29.6), so on a feed with no threading yet this map is empty and the
   * response is byte-for-byte what it was before. It is also what tells the
   * client there is nothing to fetch when a card is expanded.
   */
  threads: z.record(z.string(), ThreadSummarySchema).default({}),
});
export type ItemsResp = z.infer<typeof ItemsRespSchema>;

/** One story's whole thread, oldest first — `GET /api/items/:id/thread` (NEWS-282). */
export const ThreadRespSchema = z.object({ items: z.array(NewsItemSchema) });
export type ThreadResp = z.infer<typeof ThreadRespSchema>;

export const ProviderInfoSchema = z.object({
  name: z.enum(PROVIDER_NAMES),
  label: z.string(),
  endpointConfigurable: z.boolean(),
  /** null = not probed (auto); otherwise whether the provider is usable now. */
  available: z.boolean().nullable(),
});
export type ProviderInfo = z.infer<typeof ProviderInfoSchema>;

/** `GET /api/backup/locations` — sync folders that exist here (NEWS-230, FR-27.5). */
export const BackupLocationsRespSchema = z.object({
  locations: z.array(z.object({ label: z.string(), path: z.string() })),
});

/** `POST /api/backup` — where the snapshot landed (NEWS-192). */
export const BackupRespSchema = z.object({ ok: z.literal(true), path: z.string() });

export const ProvidersRespSchema = z.object({ providers: z.array(ProviderInfoSchema) });

/**
 * Models the configured provider can use, newest first (NEWS-248).
 *
 * Empty is a normal answer, not a failure: the CLI agents resolve aliases
 * themselves and expose no catalogue, `mock` has no models, and a missing key
 * or a vendor outage lands here too. The client falls back to `PROVIDER_MODELS`.
 */
/**
 * What a backup folder holds (NEWS-252), so the confirmation can say what is
 * about to replace what rather than asking "restore?" and hoping.
 */
export const BackupPreviewSchema = z.object({
  path: z.string(),
  topics: z.number().int(),
  items: z.number().int(),
  savedAt: z.string(),
});
export const BackupPreviewRespSchema = z.object({ preview: BackupPreviewSchema });
export const RestoreRespSchema = z.object({
  ok: z.literal(true),
  preview: BackupPreviewSchema,
  /** Where the pre-restore state was saved, so the toast can say so. */
  safetyCopy: z.string(),
});
export type BackupPreview = z.infer<typeof BackupPreviewSchema>;

/**
 * What `POST /api/items/clear` did (NEWS-255, extended in NEWS-271).
 *
 * `cancelledChecks` is defaulted rather than required so an older client parsing
 * a newer server — or the reverse — does not fail on a field it has no use for.
 */
export const ClearItemsRespSchema = z.object({
  cleared: z.number().int(),
  cancelledChecks: z.number().int().default(0),
});

/** What a bulk topic delete did (FR-31.1, NEWS-328). */
export const ClearTopicsRespSchema = z.object({
  deleted: z.number().int(),
  cancelledChecks: z.number().int().default(0),
});

export const ModelsRespSchema = z.object({
  models: z.array(z.string()).default([]),
  /**
   * Effort levels the configured provider *and model* accept.
   *
   * **Three states** (NEWS-254). A list is what to offer. `null` is "could not
   * ask" — no key, nothing resolvable — and the UI offers the whole vocabulary
   * rather than greying out over a lookup failure. An **empty array** says this
   * model accepts no effort at all, and switches the control off. Collapsing
   * the last two is what made the control offer every level on a model that
   * takes none.
   */
  effortLevels: z.array(z.enum(EFFORT_LEVELS)).nullable().default(null),
});
export type ModelsResp = z.infer<typeof ModelsRespSchema>;
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
