import { filterNewItems } from './ai/dedupe.js';
import type { FoundNewsItem, KnownItem, NewsProvider } from './ai/types.js';
import type { LinkProbe } from './ai/verify-links.js';
import { verifyItemLinks } from './ai/verify-links.js';
import { Attendance } from './attendance.js';
import type { NewsItem, Settings } from './db/schemas.js';
import type { Store } from './db/store.js';
import type { ImageFetcher } from './images/index.js';
import { liveImageHashes, pruneImageCache } from './images/index.js';

/**
 * Whether the month's estimated spend has crossed the user's cap (NEWS-79).
 *
 * A cap of 0 means "no cap". **Unpriced runs count as unknown, not as zero** —
 * the gate can only act on what it can price, so a provider that reports no
 * usage is never held back by a budget it cannot be measured against. That is
 * stated plainly in the UI rather than papered over.
 */
export function isOverBudget(spend: { usd: number }, settings: Pick<Settings, 'monthlyBudgetUsd'>): boolean {
  return settings.monthlyBudgetUsd > 0 && spend.usd >= settings.monthlyBudgetUsd;
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
export class CheckRunner {
  private readonly inFlight = new Set<string>();

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
  ) {}

  /** Topic ids currently being checked. */
  checking(): string[] {
    return [...this.inFlight];
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
    this.inFlight.add(topicId);
    const run = this.store.startRun(topicId);
    let providerName: string | null = null;
    let modelName: string | null = null;
    try {
      const provider = await this.resolveProvider();
      providerName = provider.name;
      modelName = provider.model;
      const known: KnownItem[] = this.store
        .listItems(topicId)
        .map((i) => ({ title: i.title, foundAt: i.foundAt }));
      // Stories the user flagged off-topic become negative examples in the
      // prompt, so the model can infer the topic's intended sense (NEWS-61).
      const offTopicTitles = this.store.offTopicTitlesForTopic(topicId);
      // Ask from what we've actually *covered*, not the last attempt: a run
      // that failed with news pending must not shrink the next window.
      const found = await provider.checkTopic(topic.name, known, topic.coveredThroughAt, {
        guidance: topic.guidance,
        offTopicTitles,
      });
      // Check the citations resolve before anything is stored (NEWS-83). Done
      // *before* dedup so a story kept only by a dead link can't claim a dedupe
      // key that then blocks the real version of the same story later.
      const verified = await this.verifyLinks(found.items);
      const fresh = filterNewItems(verified, this.store.dedupeKeysForTopic(topicId));
      // Fetch lead images before storing, so an item never appears without one
      // and then pops a picture in a moment later. Failures are silent by
      // design: a missing image is cosmetic, and must not fail the check.
      const images = await this.resolveImages(fresh.map(({ item }) => item.sources[0]?.url));

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
            })),
            image: images[i] ?? null,
            dedupeKey,
            foundAt: now,
          })),
        );
        const checkedAt = new Date();
        this.store.markTopicChecked(topicId, checkedAt);
        // Succeeded, so news is now covered through this moment.
        this.store.markTopicCovered(topicId, checkedAt);
      }
      // Prune here rather than only at startup: an always-on install would
      // otherwise never reclaim anything (NEWS-87). Cheap — a filter over an
      // already-in-memory array, and it only writes when something went.
      this.pruneAfterCheck();
      this.store.finishRun(run.id, {
        status: 'succeeded',
        newItems: fresh.length,
        provider: providerName,
        model: modelName,
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
      this.store.markTopicChecked(topicId, new Date());
      this.store.finishRun(run.id, {
        status: 'failed',
        newItems: 0,
        error: err instanceof Error ? err.message : String(err),
        provider: providerName,
        model: modelName,
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
          `news: dropped ${String(result.droppedItems)} story/stories and ` +
            `${String(result.droppedSources)} source link(s) that did not resolve`,
        );
      }
      return result.items;
    } catch (err: unknown) {
      console.error('news: link verification failed, keeping stories unverified:', err);
      return items;
    }
  }

  /**
   * Apply the retention window, and reclaim the images the dropped stories
   * were holding (NEWS-87).
   *
   * Best-effort: pruning is housekeeping, and a failure here must never turn a
   * successful check into a failed one.
   */
  private pruneAfterCheck(): void {
    try {
      if (this.store.pruneOldItems(new Date()) > 0) {
        pruneImageCache(this.store.dataDir, liveImageHashes(this.store.listItems()));
      }
    } catch (err: unknown) {
      console.error('news: pruning old stories failed:', err);
    }
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
    // The budget cap gates *scheduled* work only, exactly like the attendance
    // gate: manual checks stay available so a capped month doesn't lock the
    // user out of their own app, it just stops it spending on its own.
    if (isOverBudget(this.store.spendThisMonth(now), settings)) return 0;
    if (!(await this.mayRunScheduled(now))) return 0;
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
  topic: { paused: boolean; lastCheckedAt: string | null; highPriority: boolean },
  settings: Settings,
  now: Date,
): boolean {
  if (settings.scheduleMode === 'daily' && !topic.highPriority && settings.dailyTimes.length > 0) {
    return isDueDaily(topic, settings.dailyTimes, now);
  }
  return isDue(topic, effectiveInterval(topic, settings), now);
}
