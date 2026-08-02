import { filterNewItems } from './ai/dedupe.js';
import type { BackoffConfig, FailureKind } from './ai/retry.js';
import { backoffDelayMs, classifyFailure, DEFAULT_BACKOFF, FAILURE_COOLDOWN, retryAfterMs } from './ai/retry.js';
import type {
  CategoryOption,
  CheckResult,
  Effort,
  FoundNewsItem,
  KnownItem,
  NewsProvider,
  TopicClassification,
  TopicContext,
} from './ai/types.js';
import { PROVIDER_EFFORT_LEVELS } from './ai/types.js';
import type { LinkProbe } from './ai/verify-links.js';
import { verifyItemLinks } from './ai/verify-links.js';
import { Attendance } from './attendance.js';
import type { Backups } from './backup.js';
import { activeCategories, BUILTIN_CATEGORIES, findCategory, findSubcategory } from './categories.js';
import type { NewsItem, NewsSource, Settings, Topic } from './db/schemas.js';
import type { Store } from './db/store.js';
import { originOf } from './images/favicon.js';
import type { FaviconFetcher, ImageFetcher } from './images/index.js';
import { liveImageHashes, pruneImageCache } from './images/index.js';

/**
 * A provider failure that made it through the retry policy, carrying how it was
 * classified so the failure path can tell "throttled" from "broken" (NEWS-109).
 */
class CheckFailure extends Error {
  constructor(
    readonly cause: unknown,
    readonly kind: FailureKind,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'CheckFailure';
  }
}

/**
 * Whether a topic still wants an automatic section (NEWS-97).
 *
 * A manual choice is never revisited — that is what `categorySource` promises.
 * An `auto` topic that already has a category is left alone too: the label is a
 * property of the topic, not of this week's stories, so re-asking every check
 * would just invite it to drift.
 */
function needsClassifying(topic: Topic): boolean {
  return topic.category === null && topic.categorySource === 'auto';
}

/** The sections offered to the model — retired ones excluded (FR-22.4). */
function classifierOptions(): CategoryOption[] {
  return activeCategories(BUILTIN_CATEGORIES).map((c) => ({
    slug: c.slug,
    label: c.label,
    subcategories: c.subcategories.map((s) => ({ slug: s.slug, label: s.label })),
  }));
}

/** Resolves the active provider from current settings, per check. */
export type ProviderResolver = () => Promise<NewsProvider>;

/**
 * Runs news checks for topics: resolves the active AI provider, asks it for
 * stories, drops anything already seen (by dedupe key), records the surviving
 * items, and tracks a check-run record (including which provider ran) for
 * status reporting.
 *
 * A topic is never checked concurrently with itself: while a check for a topic
 * is in flight, further requests for that topic are ignored.
 */
/**
 * A check that was stopped because the user changed provider, model or effort
 * (NEWS-257). Distinct from `CheckFailure`: nothing went wrong.
 */
class CancelledCheck extends Error {}

/** What a check was issued under, so a settings change can tell if it is stale. */
interface InFlightCheck {
  controller: AbortController;
  /** `provider|model|effort` at the moment the request went out. */
  signature: string;
  /** Manual checks are reissued after a cancellation; scheduled ones are not. */
  manual: boolean;
}

export class CheckRunner {
  private readonly inFlight = new Map<string, InFlightCheck>();

  constructor(
    private readonly store: Store,
    private readonly resolveProvider: ProviderResolver,
    /**
     * Foreground tracker for the attendance gate. Defaults to a fresh
     * `Attendance`, which reports "nobody is watching" — so forgetting to wire
     * this up stops scheduled checks rather than silently running a
     * subscription provider unattended.
     */
    private readonly attendance: Attendance = new Attendance(),
    /**
     * Resolves an article URL to a locally cached lead image. Optional so tests
     * and the mock path never touch the network; omitted means no pictures.
     */
    private readonly fetchImage: ImageFetcher | null = null,
    /**
     * Probes a source URL before a story is stored (NEWS-83). Null skips the
     * check — what `--ai-test` passes, since the mock's URLs are fictional.
     */
    private readonly probeLink: LinkProbe | null = null,
    /**
     * Retry tuning (NEWS-109). An object rather than two more positional
     * parameters — this constructor is already five deep, and filling in
     * `undefined, null, null` just to reach a sleep function reads as noise at
     * every call site.
     *
     * `sleep` exists so tests don't wait real seconds; production passes nothing
     * and gets a real timer.
     */
    opts: {
      sleep?: (ms: number) => Promise<void>;
      backoff?: BackoffConfig;
      /**
       * Resolves an origin to a locally cached favicon (NEWS-169). Here rather
       * than as a sixth positional parameter, for exactly the reason stated
       * above — the positional list is already at its limit.
       */
      fetchFavicon?: FaviconFetcher | null;
      /**
       * Snapshots the store into the user's chosen backup folder after a
       * successful check (NEWS-192). Optional: null means backups are off, and
       * it is the same shape of housekeeping as pruning — never allowed to
       * fail a check.
       */
      backups?: Backups | null;
      /**
       * How long to wait before reissuing a cancelled manual check (NEWS-257).
       *
       * Changing provider produces a *burst* of settings writes, not one: the
       * client corrects the model to something the new provider has, and then
       * the effort level to something that model accepts. Reissuing on each
       * would start and kill the same check three times, which on a
       * subscription is quota spent on nothing. Tests pass 0.
       */
      reissueDelayMs?: number;
    } = {},
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.reissueDelayMs = opts.reissueDelayMs ?? 750;
    this.fetchFavicon = opts.fetchFavicon ?? null;
    this.backoff = opts.backoff ?? DEFAULT_BACKOFF;
    this.backups = opts.backups ?? null;
  }

  private readonly sleep: (ms: number) => Promise<void>;
  private readonly reissueDelayMs: number;
  /** Topics whose manual check was cancelled and is waiting to be reissued. */
  private readonly pendingReissue = new Set<string>();
  private reissueTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly backups: Backups | null;
  private readonly fetchFavicon: FaviconFetcher | null;
  private readonly backoff: BackoffConfig;

  /**
   * When set, no *scheduled* check may start until this moment (NEWS-109).
   *
   * Rate limiting is an account-wide condition, not a per-topic one: if one
   * check is limited, every other topic's would be too. Without a shared gate,
   * a sweep of twenty topics answers a 429 by making twenty more requests,
   * which is precisely what the limit is asking us to stop doing.
   *
   * Manual checks deliberately ignore it — the user asked, and one request is
   * how you find out whether the window has reopened.
   */
  private rateLimitedUntil = 0;

  /**
   * When a scheduled sweep last found work and was not allowed to do it
   * (NEWS-247), or 0 if that has not happened this session.
   *
   * The "falling behind" banner needs this. It reads lateness off wall-clock
   * `lastCheckedAt`, and wall-clock does not distinguish *we cannot keep up*
   * from *we were not permitted to try*. Subscription providers only run
   * scheduled checks while the app is attended (FR-6.5–6.8), so leaving the app
   * in the background is enough to make every topic look overdue — and the
   * banner then tells the user to pick fewer topics or a longer interval, which
   * would not have helped and is not what happened.
   *
   * Recorded at the one place that knows: the gate that turned a sweep away.
   * A rate-limit pause counts too, and deliberately — during one, "try fewer
   * topics" is advice about a thing that is not currently the problem either.
   */
  private deferredAt = 0;

  /**
   * When scheduled checking last became possible again — the later of process
   * start and the last deferral. Lateness accrued before this was not the
   * app failing to keep up (NEWS-247).
   */
  checksPossibleSince(): number {
    return Math.max(this.startedAt, this.deferredAt);
  }

  private readonly startedAt = Date.now();

  /** Ask the provider for news, retrying transient failures (NEWS-109). */
  private async checkWithRetry(
    provider: NewsProvider,
    topicName: string,
    known: KnownItem[],
    sinceIso: string | null,
    signal: AbortSignal,
    context: TopicContext,
  ): Promise<{ result: CheckResult; kind: null } | { result: null; kind: FailureKind; error: unknown }> {
    let lastError: unknown;
    let lastKind: FailureKind = 'retryable';
    // Read through a call rather than the property: `signal.aborted` changes
    // under us, and TypeScript would otherwise narrow it to `false` for the
    // rest of an iteration after the first check and flag the second as dead.
    const aborted = (): boolean => signal.aborted;
    for (let attempt = 1; attempt <= this.backoff.maxAttempts; attempt++) {
      // Checked at the top of every attempt as well as after the request: an
      // abort landing during a backoff sleep must not be answered by trying
      // again (NEWS-257).
      if (aborted()) throw new CancelledCheck('check cancelled');
      try {
        return { result: await provider.checkTopic(topicName, known, sinceIso, context, signal), kind: null };
      } catch (err) {
        // The provider's own error is whatever aborting produced — a DOM
        // AbortError from an SDK, a dead child process from a CLI. What settles
        // it is the signal, not the shape of the error.
        if (aborted()) throw new CancelledCheck('check cancelled');
        lastError = err;
        lastKind = classifyFailure(err);
        // A fatal error fails identically however many times it is asked, so
        // retrying only delays the report the user needs to see.
        if (lastKind === 'fatal') break;
        if (lastKind === 'rate-limited') {
          // The server's own answer beats our guess — it knows when the window
          // resets. Recorded globally so other topics stop too, not just this one.
          const asked = retryAfterMs(err, new Date(), this.backoff.maxMs);
          this.rateLimitedUntil = Date.now() + (asked ?? backoffDelayMs(attempt, this.backoff));
        }
        if (attempt === this.backoff.maxAttempts) break;
        const wait =
          lastKind === 'rate-limited'
            ? (retryAfterMs(err, new Date(), this.backoff.maxMs) ?? backoffDelayMs(attempt, this.backoff))
            : backoffDelayMs(attempt, this.backoff);
        await this.sleep(wait);
      }
    }
    return { result: null, kind: lastKind, error: lastError };
  }

  /**
   * The models the configured provider can offer, newest first (NEWS-248).
   *
   * On the runner because it already owns provider resolution — the alternative
   * was handing the route its own resolver and having two things that decide
   * which provider is current. Empty when the provider cannot enumerate or the
   * call fails; a dropdown falling back to a static list is not worth an error.
   */
  /**
   * What the Settings picker may offer: the provider's models, and the effort
   * levels its configured model accepts (NEWS-248/250/251).
   *
   * **One resolution for both halves**, deliberately. They are asked together
   * by `/api/models`, and the Anthropic provider answers both from a single
   * catalogue fetch it memoises per instance — resolving twice would build two
   * providers and pay for that catalogue twice for one Settings tab.
   *
   * Never throws. A provider that cannot enumerate, a missing key and a vendor
   * outage all land on the static fallbacks; a dropdown is not worth an error.
   */
  async modelOptions(): Promise<{ models: string[]; effortLevels: Effort[] | null }> {
    try {
      const provider = await this.resolveProvider();
      const model = this.store.getSettings().model;
      const [models, levels] = await Promise.all([
        provider.listModels?.() ?? Promise.resolve([]),
        provider.effortLevelsFor?.(model) ?? Promise.resolve(null),
      ]);
      // `null` from the provider means it has no opinion on this model, so the
      // provider's own union stands. `[]` is an answer — *this model takes no
      // effort* — and is passed through so the control switches off (NEWS-254).
      //
      // An empty *union* is not that answer, though. `PROVIDER_EFFORT_LEVELS`
      // is a static per-provider table, and `mock`'s entry is empty because the
      // table has nothing to say about it — not because a model refused. Only a
      // live per-model reply can mean "takes none", so an empty fallback stays
      // `null`. Without this, `--ai-test` (which resolves to `mock` while the
      // settings still name a real provider) would switch the control off for a
      // reason the user cannot see.
      const union = PROVIDER_EFFORT_LEVELS[provider.name];
      return { models, effortLevels: levels ?? (union.length > 0 ? [...union] : null) };
    } catch {
      // Nothing resolvable, so nothing to say. `null`, not the whole
      // vocabulary: the client treats "could not ask" as "offer everything",
      // and saying it here rather than guessing keeps the two apart.
      return { models: [], effortLevels: null };
    }
  }



  /**
   * The effort levels the configured provider **and model** accept (NEWS-250).
   *
   * Answered beside `listModels` because it is the same question asked of the
   * same resolved provider, and the UI needs both to render one control
   * honestly. Falls back to the provider's declared union, then to the app's
   * whole vocabulary — a control offering too much is recoverable, one offering
   * nothing is broken.
   */


  /**
   * What the current settings mean for a request: provider, model, effort.
   *
   * Only these three (NEWS-257). An interval or a retention change does not
   * make an in-flight answer wrong, and cancelling on every settings write
   * would throw away work for edits that have nothing to do with it.
   */
  private settingsSignature(): string {
    const { provider, model, effort } = this.store.getSettings();
    return `${provider}|${model}|${effort}`;
  }

  /**
   * Stop any check that was issued under different settings, and say which
   * *manual* ones should be reissued (NEWS-257).
   *
   * Called when the user changes provider, model or effort: whatever is in
   * flight is answering a question they have already changed, and on a
   * subscription it is spending quota to do it.
   *
   * **Only manual checks are reissued.** A scheduled sweep needs no help — a
   * cancelled check leaves `lastCheckedAt` untouched, so the topic is still due
   * and the next tick picks it up under the new settings on its own. Reissuing
   * those here would re-spend quota every time someone browsed the dropdowns,
   * which is exactly the interaction this feature invites.
   */
  cancelStaleChecks(): string[] {
    const current = this.settingsSignature();
    const cancelled: string[] = [];
    for (const [topicId, entry] of this.inFlight) {
      if (entry.signature === current) continue;
      entry.controller.abort();
      if (entry.manual) {
        cancelled.push(topicId);
        this.pendingReissue.add(topicId);
      }
    }
    // Coalesced, because a provider change is a *burst* of settings writes —
    // the client then corrects the model, then the effort. Reissuing on each
    // would start and kill the same check three times over.
    if (this.pendingReissue.size > 0) {
      if (this.reissueTimer !== null) clearTimeout(this.reissueTimer);
      this.reissueTimer = setTimeout(() => {
        this.reissueTimer = null;
        const topics = [...this.pendingReissue];
        this.pendingReissue.clear();
        for (const topicId of topics) {
          void this.checkTopic(topicId, { manual: true }).catch((err: unknown) => {
            console.error('newsmonger: reissued check failed:', err);
          });
        }
      }, this.reissueDelayMs);
      // Never hold the process open for a reissue: a CLI that is shutting down
      // should not wait on one.
      this.reissueTimer.unref();
    }
    return cancelled;
  }

  /** Topic ids currently being checked. */
  checking(): string[] {
    return [...this.inFlight.keys()];
  }

  /**
   * Check one topic now. Resolves with the number of new items added, or null
   * if the topic is unknown or a check for it is already in flight.
   *
   * A *manual* check (`manual: true` — the Check / Check all now buttons)
   * records attendance: the user explicitly asked for this, so they are active
   * by definition, and the scheduler shouldn't defer the rest of a long sweep
   * just because the window lost focus mid-fetch (NEWS-44).
   */
  async checkTopic(topicId: string, opts: { manual?: boolean } = {}): Promise<number | null> {
    if (opts.manual === true) this.attendance.record();
    const topic = this.store.getTopic(topicId);
    if (!topic) return null;
    if (this.inFlight.has(topicId)) return null;
    const controller = new AbortController();
    // Captured *before* the request goes out, so a settings change arriving
    // mid-check can tell whether this one is answering the old question
    // (NEWS-257).
    this.inFlight.set(topicId, {
      controller,
      signature: this.settingsSignature(),
      manual: opts.manual === true,
    });
    const run = this.store.startRun(topicId);
    let providerName: string | null = null;
    let modelName: string | null = null;
    // Read off the provider, not off settings: the provider was built for this
    // check, so this is the level the request actually carried even if the
    // setting changes mid-sweep (NEWS-226).
    let effortUsed: string | null = null;
    try {
      const provider = await this.resolveProvider();
      providerName = provider.name;
      modelName = provider.model;
      effortUsed = provider.effort;
      const known: KnownItem[] = this.store
        .listItems(topicId)
        .map((i) => ({ title: i.title, foundAt: i.foundAt }));
      // Stories the user flagged off-topic become negative examples in the
      // prompt, so the model can infer the topic's intended sense (NEWS-61).
      const offTopicTitles = this.store.offTopicTitlesForTopic(topicId);
      // Ask from what we've actually *covered*, not the last attempt: a run
      // that failed with news pending must not shrink the next window.
      const attempt = await this.checkWithRetry(provider, topic.name, known, topic.coveredThroughAt, controller.signal, {
        guidance: topic.guidance,
        offTopicTitles,
        // Only asked for while the topic still needs it (NEWS-97): a labelled
        // topic would otherwise spend tokens on the question every check, and
        // could answer differently each time.
        ...(needsClassifying(topic) ? { categoryOptions: classifierOptions() } : {}),
      });
      if (attempt.result === null) throw new CheckFailure(attempt.error, attempt.kind);
      const found = attempt.result;
      // Check the citations resolve before anything is stored (NEWS-83). Done
      // *before* dedup so a story kept only by a dead link can't claim a dedupe
      // key that then blocks the real version of the same story later.
      const verified = await this.verifyLinks(found.items);
      const fresh = filterNewItems(verified, this.store.dedupeKeysForTopic(topicId));
      // Fetch lead images before storing, so an item never appears without one
      // and then pops a picture in a moment later. Failures are silent by
      // design: a missing image is cosmetic, and must not fail the check.
      const images = await this.resolveImages(fresh.map(({ item }) => item.sources[0]?.url));
      // Favicons are resolved per distinct ORIGIN across the whole batch
      // (NEWS-169), not per source: an outlet cited by six stories is one icon,
      // and the same outlets recur every check. Same silence policy as images.
      const favicons = await this.resolveFavicons(fresh.flatMap(({ item }) => item.sources.map((s) => s.url)));

      // The topic may have been deleted while the check was in flight.
      if (this.store.getTopic(topicId)) {
        const now = new Date().toISOString();
        this.store.addItems(
          fresh.map(({ item, dedupeKey }, i) => ({
            topicId,
            title: item.title,
            summary: item.summary,
            sources: item.sources.map((source) => ({
              ...source,
              // Absent means "the model didn't say"; normalise to null so the
              // stored shape is uniform and the UI has one case to handle.
              outlet: source.outlet ?? null,
              publishedAt: source.publishedAt ?? null,
              favicon: favicons.get(originOf(source.url) ?? '') ?? null,
            })),
            image: images[i] ?? null,
            dedupeKey,
            foundAt: now,
          })),
        );
        this.applyClassification(topicId, found.classification ?? null);
        const checkedAt = new Date();
        this.store.markTopicChecked(topicId, checkedAt);
        // Succeeded, so news is now covered through this moment.
        this.store.markTopicCovered(topicId, checkedAt);
        // ...and the failure streak is over, so the next failure starts its
        // cooldown from the bottom rather than from wherever it left off
        // (NEWS-110).
        this.store.clearCheckFailures(topicId);
      }
      // Prune here rather than only at startup: an always-on install would
      // otherwise never reclaim anything (NEWS-87). Cheap — a filter over an
      // already-in-memory array, and it only writes when something went.
      this.pruneAfterCheck();
      // After the prune, so the snapshot reflects what the store actually keeps
      // rather than a set of stories that were about to expire. Throttled
      // internally, so a sweep of twenty topics writes once, not twenty times.
      this.backups?.maybeWrite();
      this.store.finishRun(run.id, {
        status: 'succeeded',
        newItems: fresh.length,
        provider: providerName,
        model: modelName,
        effort: effortUsed,
        // Recorded even when null: the run happened, and "we don't know what it
        // cost" is a fact worth keeping (NEWS-79).
        usage: found.usage,
      });
      return fresh.length;
    } catch (err) {
      // Advance the *attempt* clock so the scheduler waits a full interval
      // before retrying instead of hammering a broken provider — but leave
      // `coveredThroughAt` alone, so whatever news was pending is still asked
      // for on the next successful check.
      //
      // **Except when we were rate-limited** (NEWS-109). That is a temporary
      // condition of the account, not a problem with the topic, and advancing
      // the clock for it would turn a few seconds of throttling into a whole
      // interval — up to a day — of missed news. Leaving the clock alone makes
      // the topic due again immediately; `rateLimitedUntil` is what stops that
      // becoming a hot loop, and it is set from `Retry-After` when the server
      // supplied one.
      const kind = err instanceof CheckFailure ? err.kind : 'retryable';
      if (kind === 'rate-limited') {
        // Handled entirely by the account-wide gate — no per-topic cooldown,
        // or the two would compound into a much longer wait than either meant.
        this.store.recordCheckFailure(topicId, null);
      } else if (kind === 'fatal') {
        // Nothing will change until a human does something (a bad key, a model
        // that doesn't exist), so this keeps the old behaviour: advance the
        // clock and wait a full interval. A cooldown here would just be a
        // shorter wait for the same certain failure, and "Check now" is the
        // route back the moment the user fixes it.
        this.store.markTopicChecked(topicId, new Date());
        this.store.recordCheckFailure(topicId, null);
      } else {
        // Retryable and still failing after the in-process attempts (NEWS-110).
        // Leave `lastCheckedAt` alone — no check happened, and claiming one did
        // is what made a five-minute outage cost a whole interval — and set a
        // cooldown that grows with the streak so a broken provider isn't asked
        // every tick.
        const streak = (this.store.getTopic(topicId)?.consecutiveFailures ?? 0) + 1;
        this.store.recordCheckFailure(topicId, new Date(Date.now() + backoffDelayMs(streak, FAILURE_COOLDOWN)));
      }
      if (err instanceof CancelledCheck) {
        // Neither a success nor a failure: the user changed their mind. Recording
        // it as failed would raise the failure banner and feed the
        // falling-behind detector over something they chose to stop, and
        // `lastCheckedAt` is untouched so the topic stays due — which is what
        // makes a cancelled *scheduled* check need no reissuing (NEWS-257).
        this.store.deleteRun(run.id);
        return null;
      }
      this.store.finishRun(run.id, {
        status: 'failed',
        newItems: 0,
        error: err instanceof Error ? err.message : String(err),
        provider: providerName,
        model: modelName,
        effort: effortUsed,
      });
      return 0;
    } finally {
      this.inFlight.delete(topicId);
    }
  }

  /**
   * Drop stories whose citations don't resolve (NEWS-83).
   *
   * Best-effort in the same sense as image fetching: if the verifier itself
   * throws, the stories go through unverified rather than the check failing.
   * A story with an unchecked link is a smaller harm than no news at all.
   */
  private async verifyLinks(items: FoundNewsItem[]): Promise<FoundNewsItem[]> {
    if (this.probeLink === null) return items;
    try {
      const result = await verifyItemLinks(items, this.probeLink);
      if (result.droppedItems > 0 || result.droppedSources > 0) {
        console.error(
          `newsmonger: dropped ${String(result.droppedItems)} story/stories and ` +
            `${String(result.droppedSources)} source link(s) that did not resolve`,
        );
      }
      return result.items;
    } catch (err: unknown) {
      console.error('newsmonger: link verification failed, keeping stories unverified:', err);
      return items;
    }
  }

  /**
   * Apply the retention window, sweep up anything orphaned by a topic deleted
   * mid-check, and reclaim the images the dropped stories were holding
   * (NEWS-87, NEWS-105).
   *
   * The orphan sweep belongs *here* rather than on a timer of its own: this is
   * the moment right after the write that can create an orphan, so the window
   * in which one exists is as short as it can be.
   *
   * Best-effort: pruning is housekeeping, and a failure here must never turn a
   * successful check into a failed one.
   */
  private pruneAfterCheck(): void {
    try {
      const now = new Date();
      const expired = this.store.pruneOldItems(now);
      this.store.pruneOldRuns(now);
      const orphaned = this.store.pruneOrphans();
      if (orphaned.items > 0 || orphaned.runs > 0) {
        console.error(
          `newsmonger: swept ${String(orphaned.items)} story/ies and ${String(orphaned.runs)} run(s) left by a deleted topic`,
        );
      }
      // Only items hold images, so a run-only sweep has nothing to reclaim.
      if (expired > 0 || orphaned.items > 0) {
        pruneImageCache(this.store.dataDir, liveImageHashes(this.store.listItems()));
      }
    } catch (err: unknown) {
      console.error('newsmonger: pruning old stories failed:', err);
    }
  }

  /**
   * Store the model's section for a topic, if it gave a usable one (NEWS-97).
   *
   * **Validated against the live taxonomy, not trusted.** An unresolvable slug
   * renders exactly like never having been classified, so storing one would be
   * an invisible bad write — the topic would look unlabelled forever while the
   * code believed it was done. A slug that doesn't resolve is dropped, leaving
   * the topic eligible for a better answer on the next check.
   *
   * Never overwrites a manual choice. Re-read rather than reusing the topic
   * captured before the check, since a check takes minutes and the user may have
   * categorised it by hand in the meantime.
   */
  private applyClassification(topicId: string, classification: TopicClassification | null): void {
    if (classification === null) return;
    const topic = this.store.getTopic(topicId);
    if (topic === undefined || !needsClassifying(topic)) return;

    const table = activeCategories(BUILTIN_CATEGORIES);
    const category = findCategory(table, classification.category);
    if (category === undefined) return;
    // A subcategory that doesn't belong to the chosen category is dropped on its
    // own — the category is still good, and Sports with no sub is a valid answer
    // (FR-22.6) rather than a reason to discard the whole classification.
    const sub = findSubcategory(table, category.slug, classification.subcategory);
    this.store.setTopicCategory(topicId, category.slug, sub?.slug ?? null, 'auto');
  }

  /**
   * Resolve a favicon per distinct origin, in parallel, never throwing.
   *
   * Deduplicating by origin first is the whole point: a batch of ten stories
   * citing three outlets is three requests, not ten (or thirty). The map is
   * keyed by origin so every source sharing an outlet reads the same entry.
   */
  private async resolveFavicons(urls: readonly string[]): Promise<Map<string, NewsSource['favicon']>> {
    const resolved = new Map<string, NewsSource['favicon']>();
    const fetchFavicon = this.fetchFavicon;
    if (fetchFavicon === null) return resolved;

    const origins = [...new Set(urls.map((url) => originOf(url)).filter((o): o is string => o !== null))];
    const results = await Promise.all(
      origins.map(async (origin) => {
        try {
          return [origin, await fetchFavicon(origin)] as const;
        } catch {
          return [origin, null] as const; // an icon is never worth failing a check over
        }
      }),
    );
    for (const [origin, favicon] of results) resolved.set(origin, favicon);
    return resolved;
  }

  /** Resolve a lead image per story, in parallel, never throwing. */
  private async resolveImages(urls: (string | undefined)[]): Promise<(NewsItem['image'] | null)[]> {
    const fetchImage = this.fetchImage;
    if (fetchImage === null) return urls.map(() => null);
    return Promise.all(
      urls.map(async (url) => {
        if (url === undefined) return null;
        try {
          return await fetchImage(url);
        } catch {
          return null; // a picture is never worth failing a check over
        }
      }),
    );
  }

  /**
   * Whether a *scheduled* sweep may run right now.
   *
   * Only subscription-backed providers are gated; metered API-key providers
   * run on schedule as always. The provider comes from global settings, so one
   * resolution covers the whole sweep rather than one per topic.
   */
  private async mayRunScheduled(now: Date): Promise<boolean> {
    // Account-wide throttling gate (NEWS-109). Checked before anything else,
    // because the point is to make *no* request until the window reopens —
    // resolving a provider is harmless, but a sweep that proceeds is not.
    if (now.getTime() < this.rateLimitedUntil) return false;
    let provider: NewsProvider;
    try {
      provider = await this.resolveProvider();
    } catch {
      // Nothing usable is configured. Proceed so `checkTopic` resolves again
      // and records the failure against each topic, as it did before the gate.
      return true;
    }
    return !provider.attended || this.attendance.isAttended(now.getTime());
  }

  /**
   * Run `checkTopic` over `topics` with at most `limit` in flight, and return
   * how many were actually checked (NEWS-81).
   *
   * Workers pull from a shared cursor rather than the list being sliced into
   * fixed chunks, so a slow topic never leaves a worker idle while others wait
   * behind it — which is the whole point when one check can take minutes.
   *
   * **Order is still respected**: workers start topics in `byCheckOrder`
   * sequence, so the most-overdue and high-priority ones begin first (NEWS-58).
   * They may finish in any order, which doesn't matter — nothing downstream
   * depends on completion order.
   *
   * Safe against the single-file store because every `Store` mutation is
   * synchronous: a check's `addItems` runs to completion, save included, before
   * the event loop can hand control to another check. The awaits are all in the
   * provider and image fetches, never inside a read-modify-write.
   */
  private async runPool(topics: { id: string }[], limit: number, manual: boolean): Promise<number> {
    let cursor = 0;
    let checked = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, topics.length)) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= topics.length) return;
        const topic = topics[index];
        // Stamped per topic, not once per sweep: a sweep can outlast the 5-minute
        // attendance window, and a scheduler tick firing mid-sweep must not
        // defer the topics still queued behind it (NEWS-44).
        await this.checkTopic(topic.id, manual ? { manual: true } : {});
        checked += 1;
      }
    });
    await Promise.all(workers);
    return checked;
  }

  /**
   * Check every non-paused topic that is due and return how many were checked
   * (0 if none were due or the sweep was gated).
   *
   * Deferred topics are left untouched — `lastCheckedAt` does not advance — so
   * they stay due and run as soon as someone opens the app.
   *
   * Due topics are serviced **most-overdue-first** (NEWS-58): high-priority
   * topics ahead of normal ones, then never-checked, then the longest-waiting.
   * With a backlog too big to clear within the interval, this is what keeps the
   * order fair (and high-priority topics ahead of the pack) rather than frozen
   * in insertion order. The count is what lets the scheduler restart an overrun
   * cycle immediately instead of idling (NEWS-57).
   */
  async checkDue(now: Date): Promise<number> {
    const settings = this.store.getSettings();
    const due = this.store
      .listTopics()
      .filter((topic) => isDueUnderSchedule(topic, settings, now))
      .sort(byCheckOrder);
    if (due.length === 0) return 0;
    if (!(await this.mayRunScheduled(now))) {
      // Work was waiting and we were not allowed to do it. Recorded only in
      // that order: no due topics is not a deferral, it is an idle sweep, and
      // counting it would reset the clock every minute and silence the banner
      // for good.
      this.deferredAt = now.getTime();
      return 0;
    }
    return this.runPool(due, settings.checkConcurrency, false);
  }

  /**
   * Check every non-paused topic immediately, sequentially.
   *
   * Always a manual action, so each check records attendance — a long sweep
   * (a subscription provider takes minutes per topic) keeps the user counted as
   * active for its whole duration, so a scheduler tick that fires mid-sweep
   * isn't gated and the remaining topics aren't deferred (NEWS-44).
   */
  async checkAll(): Promise<void> {
    const topics = this.store.listTopics().filter((t) => !t.paused).sort(byCheckOrder);
    await this.runPool(topics, this.store.getSettings().checkConcurrency, true);
  }
}

/**
 * The interval a topic is checked on: the shorter high-priority interval when
 * it's flagged, otherwise the default (NEWS-56). `highPriorityIntervalMs` is
 * always kept ≤ `checkIntervalMs` by the store, so a high-priority topic is
 * never checked *less* often than a normal one.
 */
export function effectiveInterval(
  topic: { highPriority: boolean },
  settings: { checkIntervalMs: number; highPriorityIntervalMs: number },
): number {
  return topic.highPriority ? settings.highPriorityIntervalMs : settings.checkIntervalMs;
}

/**
 * Order due topics for a sweep (NEWS-58): high-priority first, then the most
 * overdue — never-checked before ever-checked, then oldest `lastCheckedAt`
 * first. Deterministic and total, so a large backlog is serviced fairly rather
 * than in insertion order, and high-priority topics jump ahead of it.
 *
 * Caveat: under a backlog so large that high-priority topics are *always* due,
 * strict priority-first can starve normal topics. That's an extreme-overload
 * corner (surfaced to the user by the falling-behind signal, NEWS-59), and
 * high-priority topics are hand-picked and few — so the simple, predictable
 * ordering is the right call over a fancier anti-starvation scheme.
 */
export function byCheckOrder(
  a: { highPriority: boolean; lastCheckedAt: string | null },
  b: { highPriority: boolean; lastCheckedAt: string | null },
): number {
  if (a.highPriority !== b.highPriority) return a.highPriority ? -1 : 1;
  if (a.lastCheckedAt === null && b.lastCheckedAt === null) return 0;
  if (a.lastCheckedAt === null) return -1; // never checked = most overdue
  if (b.lastCheckedAt === null) return 1;
  return Date.parse(a.lastCheckedAt) - Date.parse(b.lastCheckedAt); // oldest first
}

/** Whether a topic is due for a scheduled check at `now`, given its interval. */
export function isDue(
  topic: { paused: boolean; lastCheckedAt: string | null },
  intervalMs: number,
  now: Date,
): boolean {
  if (topic.paused) return false;
  if (topic.lastCheckedAt === null) return true;
  return now.getTime() - Date.parse(topic.lastCheckedAt) >= intervalMs;
}

/**
 * The most recent `HH:MM` slot that has already come round, as a timestamp
 * (NEWS-84). Null when none of today's slots have passed *and* there is no
 * usable slot yesterday — i.e. the list is empty.
 *
 * Slots are evaluated in **local** time on purpose: "8am" means eight o'clock
 * where the user is, and it should keep meaning that across a DST change. That
 * is also why this walks back to yesterday's last slot rather than doing
 * arithmetic on a fixed 24-hour period.
 */
export function lastSlotBefore(times: string[], now: Date): Date | null {
  const parsed = times
    .map((t) => t.split(':').map(Number))
    .filter((parts): parts is [number, number] => parts.length === 2 && parts.every((n) => !Number.isNaN(n)))
    .sort((a, b) => a[0] * 60 + a[1] - (b[0] * 60 + b[1]));
  if (parsed.length === 0) return null;

  const at = (dayOffset: number, [h, m]: [number, number]): Date =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, h, m, 0, 0);

  for (let i = parsed.length - 1; i >= 0; i--) {
    const slot = at(0, parsed[i]);
    if (slot.getTime() <= now.getTime()) return slot;
  }
  // Before the first slot of the day — the standing obligation is yesterday's
  // last one, so a topic checked the day before yesterday still reads as due.
  return at(-1, parsed[parsed.length - 1]);
}

/**
 * Whether a topic is due under a daily schedule (NEWS-84).
 *
 * Due when the most recent slot has passed and the topic has not been checked
 * since it. Deliberately **not** "run at 08:00 exactly": the scheduler ticks
 * once a minute and the app may be closed at 08:00, so a missed slot stays
 * outstanding until it is served rather than being skipped to tomorrow.
 */
export function isDueDaily(
  topic: { paused: boolean; lastCheckedAt: string | null },
  times: string[],
  now: Date,
): boolean {
  if (topic.paused) return false;
  if (topic.lastCheckedAt === null) return true;
  const slot = lastSlotBefore(times, now);
  if (slot === null) return false;
  return Date.parse(topic.lastCheckedAt) < slot.getTime();
}

/**
 * Whether a topic is due, honouring the configured schedule mode (NEWS-84).
 *
 * High-priority topics always use the interval — "every 2 hours" is the right
 * mental model there, and it is the whole point of the tier (FR-12.4). An empty
 * `dailyTimes` falls back to the interval, so the mode can never leave a topic
 * unscheduled forever.
 */
export function isDueUnderSchedule(
  topic: {
    paused: boolean;
    lastCheckedAt: string | null;
    highPriority: boolean;
    /** Failure cooldown (NEWS-110); absent in callers that predate it. */
    retryAfter?: string | null;
  },
  settings: Settings,
  now: Date,
): boolean {
  // The cooldown outranks the schedule: a topic whose checks are failing is
  // still *due* by the schedule every tick, and that is exactly what would
  // hammer a broken provider. It gates rather than replaces, so once it expires
  // the normal rules apply and an overdue topic runs immediately.
  const cooldown = topic.retryAfter ?? null;
  if (cooldown !== null && now.getTime() < Date.parse(cooldown)) return false;
  if (settings.scheduleMode === 'daily' && !topic.highPriority && settings.dailyTimes.length > 0) {
    return isDueDaily(topic, settings.dailyTimes, now);
  }
  return isDue(topic, effectiveInterval(topic, settings), now);
}
