import { filterNewItems } from './ai/dedupe.js';
import type { KnownItem, NewsProvider } from './ai/types.js';
import type { Store } from './db/store.js';

/** Resolves the active news provider from current settings, per check. */
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
      const found = await provider.checkTopic(topic.name, known, topic.lastCheckedAt);
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
        this.store.markTopicChecked(topicId, new Date());
      }
      this.store.finishRun(run.id, { status: 'succeeded', newItems: fresh.length, provider: providerName });
      return fresh.length;
    } catch (err) {
      // Record the failure, but still advance lastCheckedAt so the scheduler
      // waits a full interval before retrying instead of hammering the API.
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

  /** Check every non-paused topic that is due, sequentially. */
  async checkDue(now: Date): Promise<void> {
    const { checkIntervalMs } = this.store.getSettings();
    for (const topic of this.store.listTopics()) {
      if (!isDue(topic, checkIntervalMs, now)) continue;
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
