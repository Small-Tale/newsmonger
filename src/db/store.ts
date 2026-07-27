import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PriceStore } from '../ai/price-store.js';
import { estimateCostUsd } from '../ai/pricing.js';
import type { TokenUsage } from '../ai/types.js';
import type { CheckRun, DataFile, NewsItem, Settings, Topic } from './schemas.js';
import { DataFileSchema, emptyDataFile, MAX_GUIDANCE_LENGTH } from './schemas.js';

const MAX_RUNS_KEPT = 200;

/** A feed cursor: the last item of a page, for fetching the next (NEWS-74). */
export interface ItemCursor {
  foundAt: string;
  id: string;
}

/** A feed query for `Store.queryItems` (NEWS-74). */
export interface ItemQuery {
  mode: 'normal' | 'review';
  /** Solo topics (normal), or the reviewed topics (review). Empty = all. */
  topicIds?: string[];
  saved?: boolean;
  q?: string;
  limit: number;
  before?: ItemCursor | null;
}

/** Descending string compare: later/greater first. */
function cmpDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

/**
 * JSON-file-backed store for topics, news items, settings, and check runs.
 *
 * All data lives in a single `data.json` inside the data directory. Writes are
 * synchronous and atomic (write to a temp file, then rename).
 */
export class Store {
  private readonly filePath: string;
  private data: DataFile;

  /** Where the data file and image cache live. */
  readonly dataDir: string;

  /**
   * Live model rates (NEWS-93). Lives here because spend is computed here, and
   * it reads `<data-dir>/prices.json` — editable without rebuilding the app.
   */
  readonly prices: PriceStore;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.filePath = path.join(dataDir, 'data.json');
    this.data = this.load();
    this.prices = new PriceStore(dataDir);
  }

  private load(): DataFile {
    if (!fs.existsSync(this.filePath)) return emptyDataFile();
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      return DataFileSchema.parse(JSON.parse(raw));
    } catch (err) {
      // Corrupt or incompatible file: back it up and start fresh rather than crash.
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      fs.copyFileSync(this.filePath, backup);
      console.error(`news: data file invalid (${String(err)}); backed up to ${backup} and starting fresh`);
      return emptyDataFile();
    }
  }

  private save(): void {
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  // --- Topics ---

  listTopics(): Topic[] {
    return [...this.data.topics];
  }

  getTopic(id: string): Topic | undefined {
    return this.data.topics.find((t) => t.id === id);
  }

  addTopic(name: string): Topic {
    const trimmed = name.trim();
    if (trimmed === '') throw new Error('topic name must not be empty');
    const existing = this.data.topics.find((t) => t.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) throw new Error(`topic "${trimmed}" already exists`);
    const topic: Topic = {
      id: randomUUID(),
      name: trimmed,
      paused: false,
      highPriority: false,
      guidance: '',
      createdAt: new Date().toISOString(),
      lastCheckedAt: null,
      coveredThroughAt: null,
    };
    this.data.topics.push(topic);
    this.save();
    return topic;
  }

  setTopicPaused(id: string, paused: boolean): Topic {
    const topic = this.getTopic(id);
    if (!topic) throw new Error(`no such topic: ${id}`);
    topic.paused = paused;
    this.save();
    return topic;
  }

  /** Mark a topic high-priority (shorter interval) or normal (NEWS-56). */
  setTopicHighPriority(id: string, highPriority: boolean): Topic {
    const topic = this.getTopic(id);
    if (!topic) throw new Error(`no such topic: ${id}`);
    topic.highPriority = highPriority;
    this.save();
    return topic;
  }

  /**
   * Set (or clear, with '') the topic's free-text guidance (NEWS-80).
   *
   * Trimmed on the way in so whitespace-only input reads as "no guidance"
   * everywhere downstream — the prompt, the UI indicator, and the API response
   * all key off emptiness, and they should agree.
   */
  setTopicGuidance(id: string, guidance: string): Topic {
    const topic = this.getTopic(id);
    if (!topic) throw new Error(`no such topic: ${id}`);
    topic.guidance = guidance.trim().slice(0, MAX_GUIDANCE_LENGTH);
    this.save();
    return topic;
  }

  /**
   * Record a check *attempt*. Call for successes and failures alike — it is
   * what keeps the scheduler from retrying a broken provider every tick.
   */
  /** Bookmark or un-bookmark a story. Returns the updated item, or null if gone. */
  setItemSaved(id: string, saved: boolean): NewsItem | null {
    const item = this.data.items.find((i) => i.id === id);
    if (!item) return null;
    item.saved = saved;
    this.save();
    return item;
  }

  /** Flag or un-flag a story as off-topic (NEWS-61). Null if the item is gone. */
  setItemOffTopic(id: string, offTopic: boolean): NewsItem | null {
    const item = this.data.items.find((i) => i.id === id);
    if (!item) return null;
    item.offTopic = offTopic;
    this.save();
    return item;
  }

  /**
   * Titles of a topic's off-topic stories, most recent first, for the prompt's
   * negative-example list (NEWS-61). Capped by `limit` to keep the prompt bounded.
   */
  offTopicTitlesForTopic(topicId: string, limit = 10): string[] {
    return this.data.items
      .filter((i) => i.topicId === topicId && i.offTopic)
      .sort((a, b) => b.foundAt.localeCompare(a.foundAt))
      .slice(0, limit)
      .map((i) => i.title);
  }

  markTopicChecked(id: string, when: Date): void {
    const topic = this.getTopic(id);
    if (!topic) return; // topic may have been deleted mid-check
    topic.lastCheckedAt = when.toISOString();
    this.save();
  }

  /**
   * Record that news is covered through `when`. Successes only — this is the
   * point the next prompt asks from, so advancing it after a failure would
   * discard however much news was pending.
   */
  markTopicCovered(id: string, when: Date): void {
    const topic = this.getTopic(id);
    if (!topic) return; // topic may have been deleted mid-check
    topic.coveredThroughAt = when.toISOString();
    this.save();
  }

  deleteTopic(id: string): void {
    const before = this.data.topics.length;
    this.data.topics = this.data.topics.filter((t) => t.id !== id);
    if (this.data.topics.length === before) throw new Error(`no such topic: ${id}`);
    this.data.items = this.data.items.filter((i) => i.topicId !== id);
    this.data.runs = this.data.runs.filter((r) => r.topicId !== id);
    this.save();
  }

  // --- Items ---

  listItems(topicId?: string): NewsItem[] {
    const items = topicId === undefined ? this.data.items : this.data.items.filter((i) => i.topicId === topicId);
    return [...items];
  }

  /**
   * Query the feed for a page (server-side pagination, NEWS-74).
   *
   * Filters, sorts newest-first, and cursor-paginates in one place so the
   * server is the single source of truth for what the feed shows. The filter
   * predicates mirror the client's view logic:
   *  - `mode: 'review'` → only off-topic stories for `topicIds` (the reviewed
   *    topics); nothing else applies.
   *  - `mode: 'normal'` → exclude off-topic stories, then apply Solo (`topicIds`),
   *    Saved, and Search (title / summary / topic name).
   *
   * The cursor is the last item of the previous page `(foundAt, id)`; the page is
   * the items strictly *older* than it, so paging is stable as new items arrive.
   */
  queryItems(query: ItemQuery): { items: NewsItem[]; nextCursor: ItemCursor | null; total: number } {
    const topicNames = new Map(this.data.topics.map((t) => [t.id, t.name]));
    const topicSet = query.topicIds && query.topicIds.length > 0 ? new Set(query.topicIds) : null;
    const q = (query.q ?? '').trim().toLowerCase();

    const filtered = this.data.items.filter((item) => {
      if (query.mode === 'review') {
        return item.offTopic && topicSet !== null && topicSet.has(item.topicId);
      }
      if (item.offTopic) return false;
      if (topicSet !== null && !topicSet.has(item.topicId)) return false;
      if (query.saved === true && !item.saved) return false;
      if (q !== '') {
        const name = topicNames.get(item.topicId) ?? '';
        const hit =
          item.title.toLowerCase().includes(q) ||
          item.summary.toLowerCase().includes(q) ||
          name.toLowerCase().includes(q);
        if (!hit) return false;
      }
      return true;
    });

    // Newest first; tie-break on id so a shared timestamp still gives a total,
    // stable order for the cursor.
    filtered.sort((a, b) =>
      a.foundAt === b.foundAt ? cmpDesc(a.id, b.id) : cmpDesc(a.foundAt, b.foundAt),
    );

    const total = filtered.length;
    const c = query.before;
    const afterCursor =
      c === undefined || c === null
        ? filtered
        : filtered.filter((i) => i.foundAt < c.foundAt || (i.foundAt === c.foundAt && i.id < c.id));
    const items = afterCursor.slice(0, query.limit);
    // More remain iff the filtered-after-cursor set exceeded the page.
    const last = afterCursor.length > items.length ? items[items.length - 1] : undefined;
    const nextCursor = last ? { foundAt: last.foundAt, id: last.id } : null;
    return { items, nextCursor, total };
  }

  dedupeKeysForTopic(topicId: string): Set<string> {
    return new Set(this.data.items.filter((i) => i.topicId === topicId).map((i) => i.dedupeKey));
  }

  /**
   * The newest `n` item ids across all topics, newest first (NEWS-75, phase 2a).
   *
   * Small enough to ride the `/api/state` poll: it's the signal the client uses
   * to detect *new* stories for notifications, independent of whatever filtered
   * page the feed is showing — so a new story in a topic you aren't looking at
   * still notifies, once the feed itself moves off `/api/state` (phase 2b).
   */
  latestItemIds(n = 50): string[] {
    return [...this.data.items]
      .sort((a, b) => (a.foundAt === b.foundAt ? cmpDesc(a.id, b.id) : cmpDesc(a.foundAt, b.foundAt)))
      .slice(0, n)
      .map((i) => i.id);
  }

  /**
   * Count of off-topic (flagged) stories per topic (NEWS-76). Drives the
   * "Review Flagged (N)" badge once the feed page no longer carries the full
   * item list. Topics with none are omitted.
   */
  flaggedCountsByTopic(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const item of this.data.items) {
      if (item.offTopic) counts[item.topicId] = (counts[item.topicId] ?? 0) + 1;
    }
    return counts;
  }

  /** `image`/`saved`/`offTopic` are optional: a new story has no picture, isn't saved, and isn't flagged. */
  addItems(
    items: (Omit<NewsItem, 'id' | 'image' | 'saved' | 'offTopic'> & {
      image?: NewsItem['image'];
      saved?: boolean;
      offTopic?: boolean;
    })[],
  ): NewsItem[] {
    const added = items.map((item) => ({ image: null, saved: false, offTopic: false, ...item, id: randomUUID() }));
    this.data.items.push(...added);
    this.save();
    return added;
  }

  // --- Settings ---

  getSettings(): Settings {
    return { ...this.data.settings };
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.data.settings, ...patch };
    // Keep the invariant highPriorityIntervalMs <= checkIntervalMs (NEWS-56) by
    // moving the value the user did NOT just change: shorten the default and the
    // high-priority interval follows down; lengthen the high-priority interval
    // past the default and the default follows up. When both are in one patch,
    // the default is treated as the ceiling.
    if (patch.checkIntervalMs !== undefined || patch.highPriorityIntervalMs !== undefined) {
      if (patch.highPriorityIntervalMs !== undefined && patch.checkIntervalMs === undefined) {
        next.checkIntervalMs = Math.max(next.checkIntervalMs, next.highPriorityIntervalMs);
      } else {
        next.highPriorityIntervalMs = Math.min(next.highPriorityIntervalMs, next.checkIntervalMs);
      }
    }
    // Sorted and de-duplicated once, here, so every reader — the scheduler, the
    // UI, the "next check" hint — sees the same canonical list (NEWS-84).
    if (patch.dailyTimes !== undefined) {
      next.dailyTimes = [...new Set(next.dailyTimes)].sort((a, b) => a.localeCompare(b));
    }
    this.data.settings = next;
    this.save();
    return this.getSettings();
  }

  // --- Check runs ---

  listRuns(limit = 50): CheckRun[] {
    return this.data.runs.slice(-limit).reverse();
  }

  startRun(topicId: string): CheckRun {
    const run: CheckRun = {
      id: randomUUID(),
      topicId,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: 'running',
      newItems: 0,
      error: null,
      provider: null,
      model: null,
      usage: null,
    };
    this.data.runs.push(run);
    if (this.data.runs.length > MAX_RUNS_KEPT) {
      this.data.runs = this.data.runs.slice(-MAX_RUNS_KEPT);
    }
    this.save();
    return run;
  }

  finishRun(
    runId: string,
    result: {
      status: 'succeeded' | 'failed';
      newItems: number;
      error?: string;
      provider?: string | null;
      model?: string | null;
      usage?: TokenUsage | null;
    },
  ): void {
    const run = this.data.runs.find((r) => r.id === runId);
    if (!run) return;
    run.finishedAt = new Date().toISOString();
    run.status = result.status;
    run.newItems = result.newItems;
    run.error = result.error ?? null;
    if (result.provider !== undefined) run.provider = result.provider;
    if (result.model !== undefined) run.model = result.model;
    if (result.usage !== undefined) run.usage = result.usage;
    this.save();
  }

  /**
   * Estimated spend, in USD, over the runs recorded since `sinceIso` (NEWS-79).
   *
   * Returns both the total and how many runs could **not** be priced, because a
   * total alone would quietly read as complete. Runs whose provider reported no
   * usage, or whose model has no published price, are counted as unknown rather
   * than as zero — see `estimateCostUsd`.
   *
   * Note the horizon is `MAX_RUNS_KEPT` runs, not all of history: this is what
   * the app can still see, which for a busy install may be less than a month.
   */
  /**
   * Drop stories older than the retention window (NEWS-87). Returns how many
   * went, so the caller can log it and prune the images they referenced.
   *
   * Two things are deliberately exempt: **bookmarked** stories, which the user
   * marked as worth keeping, and **off-topic flagged** ones, whose titles feed
   * the prompt's negative-example list — pruning those would quietly un-teach
   * the model what the user meant by a topic.
   */
  pruneOldItems(now: Date): number {
    const days = this.data.settings.itemRetentionDays;
    if (days <= 0) return 0;
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    const before = this.data.items.length;
    this.data.items = this.data.items.filter(
      (item) => item.saved || item.offTopic || item.foundAt >= cutoff,
    );
    const removed = before - this.data.items.length;
    if (removed > 0) this.save();
    return removed;
  }

  /** Estimated spend so far in `now`'s calendar month, in the local timezone. */
  spendThisMonth(now: Date): { usd: number; pricedRuns: number; unpricedRuns: number } {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    return this.spendSince(monthStart.toISOString());
  }

  spendSince(sinceIso: string): { usd: number; pricedRuns: number; unpricedRuns: number } {
    // Read once per call, not per run: the file's mtime check is cheap but not
    // free, and every run in a sweep is priced against the same table.
    const table = this.prices.table().models;
    let usd = 0;
    let pricedRuns = 0;
    let unpricedRuns = 0;
    for (const run of this.data.runs) {
      if (run.startedAt < sinceIso) continue;
      if (run.status === 'running') continue;
      const cost = estimateCostUsd(run.model ?? '', run.usage, table);
      if (cost === null) unpricedRuns += 1;
      else {
        usd += cost;
        pricedRuns += 1;
      }
    }
    return { usd, pricedRuns, unpricedRuns };
  }
}
