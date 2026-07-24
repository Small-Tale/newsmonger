import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { CheckRun, DataFile, NewsItem, Settings, Topic } from './schemas.js';
import { DataFileSchema, emptyDataFile } from './schemas.js';

const MAX_RUNS_KEPT = 200;

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

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.filePath = path.join(dataDir, 'data.json');
    this.data = this.load();
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

  dedupeKeysForTopic(topicId: string): Set<string> {
    return new Set(this.data.items.filter((i) => i.topicId === topicId).map((i) => i.dedupeKey));
  }

  /** `image`/`saved` are optional: a new story has no picture and isn't saved. */
  addItems(items: (Omit<NewsItem, 'id' | 'image' | 'saved'> & { image?: NewsItem['image']; saved?: boolean })[]): NewsItem[] {
    const added = items.map((item) => ({ image: null, saved: false, ...item, id: randomUUID() }));
    this.data.items.push(...added);
    this.save();
    return added;
  }

  // --- Settings ---

  getSettings(): Settings {
    return { ...this.data.settings };
  }

  updateSettings(patch: Partial<Settings>): Settings {
    this.data.settings = { ...this.data.settings, ...patch };
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
    },
  ): void {
    const run = this.data.runs.find((r) => r.id === runId);
    if (!run) return;
    run.finishedAt = new Date().toISOString();
    run.status = result.status;
    run.newItems = result.newItems;
    run.error = result.error ?? null;
    if (result.provider !== undefined) run.provider = result.provider;
    this.save();
  }
}
