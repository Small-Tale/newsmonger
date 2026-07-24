import { filterNewItems } from './ai/dedupe.js';
import type { KnownItem, NewsProvider } from './ai/types.js';
import { Attendance } from './attendance.js';
import type { Store } from './db/store.js';

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
  ) {}

  /** Topic ids currently being checked. */
  checking(): string[] {
    return [...this.inFlight];
  }

  /**
   * Check one topic now. Resolves with the number of new items added, or null
   * if the topic is unknown or a check for it is already in flight.
   */
  async checkTopic(topicId: string): Promise<number | null> {
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
      // The topic may have been deleted while the check was in flight.
      if (this.store.getTopic(topicId)) {
        const now = new Date().toISOString();
        this.store.addItems(
          fresh.map(({ item, dedupeKey }) => ({
            topicId,
            title: item.title,
            summary: item.summary,
            sources: item.sources,
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
   * Check every non-paused topic that is due, sequentially.
   *
   * Deferred topics are left untouched — `lastCheckedAt` does not advance — so
   * they stay due and run as soon as someone opens the app.
   */
  async checkDue(now: Date): Promise<void> {
    const { checkIntervalMs } = this.store.getSettings();
    const due = this.store.listTopics().filter((topic) => isDue(topic, checkIntervalMs, now));
    if (due.length === 0) return;
    if (!(await this.mayRunScheduled(now))) return;
    for (const topic of due) {
      await this.checkTopic(topic.id);
    }
  }

  /** Check every non-paused topic immediately, sequentially. */
  async checkAll(): Promise<void> {
    for (const topic of this.store.listTopics()) {
      if (topic.paused) continue;
      await this.checkTopic(topic.id);
    }
  }
}

/** Whether a topic is due for a scheduled check at `now`. */
export function isDue(
  topic: { paused: boolean; lastCheckedAt: string | null },
  checkIntervalMs: number,
  now: Date,
): boolean {
  if (topic.paused) return false;
  if (topic.lastCheckedAt === null) return true;
  return now.getTime() - Date.parse(topic.lastCheckedAt) >= checkIntervalMs;
}
