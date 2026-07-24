import { filterNewItems } from './ai/dedupe.js';
import type { KnownItem, NewsProvider } from './ai/types.js';
import { Attendance } from './attendance.js';
import type { NewsItem } from './db/schemas.js';
import type { Store } from './db/store.js';
import type { ImageFetcher } from './images/index.js';

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
    try {
      const provider = await this.resolveProvider();
      providerName = provider.name;
      const known: KnownItem[] = this.store
        .listItems(topicId)
        .map((i) => ({ title: i.title, foundAt: i.foundAt }));
      // Ask from what we've actually *covered*, not the last attempt: a run
      // that failed with news pending must not shrink the next window.
      const found = await provider.checkTopic(topic.name, known, topic.coveredThroughAt);
      const fresh = filterNewItems(found, this.store.dedupeKeysForTopic(topicId));
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
            sources: item.sources,
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
      this.store.finishRun(run.id, { status: 'succeeded', newItems: fresh.length, provider: providerName });
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
      });
      return 0;
    } finally {
      this.inFlight.delete(topicId);
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
   * Check every non-paused topic that is due, sequentially, and return how many
   * were checked (0 if none were due or the sweep was gated).
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
      .filter((topic) => isDue(topic, effectiveInterval(topic, settings), now))
      .sort(byCheckOrder);
    if (due.length === 0) return 0;
    if (!(await this.mayRunScheduled(now))) return 0;
    let checked = 0;
    for (const topic of due) {
      await this.checkTopic(topic.id);
      checked += 1;
    }
    return checked;
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
    for (const topic of this.store.listTopics()) {
      if (topic.paused) continue;
      await this.checkTopic(topic.id, { manual: true });
    }
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
