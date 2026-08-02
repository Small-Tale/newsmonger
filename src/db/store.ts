import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { TokenUsage } from '../ai/types.js';
import { NO_SUBCATEGORY_FILTER, UNCATEGORIZED_FILTER } from '../categories.js';
import type { CheckRun, DataFile, NewsItem, Settings, Topic } from './schemas.js';
import {
  CheckRunSchema,
  DataFileSchema,
  emptyDataFile,
  MAX_GUIDANCE_LENGTH,
  NewsItemSchema,
  SettingsSchema,
  TopicSchema,
} from './schemas.js';
import { backupUnreadableDb, dbPath, openDb } from './sqlite.js';

/**
 * Run-history retention (NEWS-103, revised NEWS-119). Two limits, whichever
 * binds first.
 *
 * These numbers were chosen when spend was computed from stored runs, so the run
 * window *was* the spend window and had to cover a billing month. Spend is gone
 * (NEWS-119) and the only reader left is the diagnostics run list, which shows
 * twenty — so the window is now far wider than anything needs.
 *
 * Kept anyway, deliberately: run history is the record of what the app did and
 * when it failed, it costs a few MB at the ceiling, and shrinking it would throw
 * away the evidence a bug report is made of. The justification changed; the
 * value didn't need to.
 *
 * `MAX_RUNS_KEPT` remains the backstop against pathological volume — runs accrue
 * per topic per check, so a short interval across many topics can generate
 * thousands a day, and 400 days of that is millions of rows.
 */
export const RUN_RETENTION_DAYS = 400;
export const MAX_RUNS_KEPT = 25_000;

/** A feed cursor: the last item of a page, for fetching the next (NEWS-74). */
export interface ItemCursor {
  foundAt: string;
  id: string;
}

/**
 * What a clear removed, and therefore what an undo has to put back (NEWS-145).
 *
 * The check window travels with the stories rather than being recomputed on
 * restore: clearing sets it to null so the next check spans a sensible period
 * (FR-25.6), and an undo that left it null would re-report every restored story
 * as new. Its value before the clear is the only correct thing to return to.
 */
export interface ClearedItems {
  items: NewsItem[];
  coveredThroughAt: string | null;
}

/** A feed query for `Store.queryItems` (NEWS-74). */
export interface ItemQuery {
  mode: 'normal' | 'review';
  /** Solo topics (normal), or the reviewed topics (review). Empty = all. */
  topicIds?: string[];
  saved?: boolean;
  q?: string;
  /**
   * Filter-bar selection (NEWS-97). A category slug, or `'uncategorized'` for
   * topics with no category at all. Absent means no category filter.
   */
  category?: string;
  /** Second-level slug within `category`, or `'other'` for topics with none. */
  subcategory?: string;
  limit: number;
  before?: ItemCursor | null;
}

// Re-exported so server-side callers don't need to know the constants live with
// the taxonomy; see `src/categories.ts` for why they do.
export { NO_SUBCATEGORY_FILTER, UNCATEGORIZED_FILTER };

/** SQLite has no boolean type; every column that means one is 0/1. */
function bit(value: boolean): number {
  return value ? 1 : 0;
}

function isTrue(value: unknown): boolean {
  return value === 1 || value === 1n || value === true;
}

/**
 * Read a SQLite integer as a JS number.
 *
 * `node:sqlite` hands back a `bigint` for values outside the safe-integer range,
 * so the column type alone doesn't tell you which you have. Everything counted
 * here (rows, `changes`) is small, and this is the one place that has to know.
 */
function asCount(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
}

/** Parse a JSON column, treating null/empty as absent rather than as an error. */
function parseJson(value: unknown): unknown {
  if (typeof value !== 'string' || value === '') return null;
  return JSON.parse(value) as unknown;
}

/**
 * SQLite-backed store for topics, news items, settings, and check runs (NEWS-94).
 *
 * Replaces a single `data.json` that was rewritten in full on every mutation —
 * toggling one bookmark serialized every topic, story and run — and whose
 * corruption blast radius was therefore everything at once. Writes are now
 * per-row, and the public interface is unchanged, which is what kept this a
 * refactor rather than a rewrite.
 *
 * **Rows are validated, not asserted.** Every read goes through the same zod
 * schemas the JSON file used, so the trust boundary didn't move — it just
 * applies per row instead of per file. That is also what keeps `stripMarkup`
 * cleaning stories stored before it existed.
 *
 * An existing `data.json` is imported once on first open (see `importJsonFile`).
 */
export class Store {
  private readonly db: DatabaseSync;
  private readonly file: string;
  private settingsCache: Settings;

  /** Where the database and image cache live. */
  readonly dataDir: string;


  constructor(dataDir: string) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = dbPath(dataDir);

    let db: DatabaseSync;
    try {
      db = openDb(this.file);
    } catch (err) {
      // Corrupt or unreadable database: back it up and start fresh rather than
      // crash — the same contract the JSON store had for a bad `data.json`.
      // A database that cannot be opened cannot be repaired from in here, and
      // refusing to start would leave the user with no way in at all.
      const backup = backupUnreadableDb(this.file);
      console.error(`newsmonger: database unreadable (${String(err)}); backed up to ${backup} and starting fresh`);
      db = openDb(this.file);
    }
    this.db = db;

    this.importJsonFile();
    this.settingsCache = this.loadSettings();
  }

  /**
   * One-time import of a legacy `data.json` (NEWS-94).
   *
   * Runs only when the database is empty *and* a JSON file is there, so it
   * can't fire twice or overwrite live data. The file is parsed with the same
   * `DataFileSchema` the JSON store used, which means every migration that
   * schema performs still happens — dropped fields, renamed providers,
   * `stripMarkup` on old citation markup — and an unparseable file still gets
   * backed up rather than taking the app down.
   *
   * The file is renamed afterwards, not deleted: it is the only copy of that
   * data until someone is satisfied the import worked, and leaving it under its
   * original name would make it re-import if the database were ever removed.
   */
  private importJsonFile(): void {
    const jsonFile = path.join(this.dataDir, 'data.json');
    if (!fs.existsSync(jsonFile)) return;
    const populated = this.db.prepare('SELECT count(*) AS c FROM topics').get() as { c: unknown };
    const hasSettings = this.db.prepare(`SELECT count(*) AS c FROM meta WHERE key = 'settings'`).get() as {
      c: unknown;
    };
    if (asCount(populated.c) > 0 || asCount(hasSettings.c) > 0) return;

    let data;
    try {
      data = DataFileSchema.parse(JSON.parse(fs.readFileSync(jsonFile, 'utf8')));
    } catch (err) {
      const backup = `${jsonFile}.corrupt-${String(Date.now())}`;
      fs.copyFileSync(jsonFile, backup);
      fs.rmSync(jsonFile, { force: true });
      console.error(`newsmonger: data file invalid (${String(err)}); backed up to ${backup} and starting fresh`);
      return;
    }

    this.db.exec('BEGIN');
    try {
      for (const topic of data.topics) this.insertTopic(topic);
      for (const item of data.items) this.insertItem(item);
      for (const run of data.runs) this.insertRun(run);
      this.writeSettings(data.settings);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    fs.renameSync(jsonFile, `${jsonFile}.imported-${String(Date.now())}`);
  }

  /**
   * Replace every topic, story, run and setting with a snapshot (NEWS-252).
   *
   * The restore half of backups. Until now the only way back in was the legacy
   * `data.json` importer — which reads a *different filename*, in a *different
   * directory*, and only into an empty database, so a user who had opened the
   * app once on their new machine was silently locked out of their own backup.
   *
   * **One transaction, and it deletes first.** A restore that merged would
   * leave the result depending on what happened to be there, which is not a
   * restore; and a half-applied one — topics replaced, stories not — would be
   * worse than either state on its own. Rolling back on any error means a
   * failure leaves the database exactly as it was found.
   *
   * `settings.backupDir` is **not** taken from the snapshot: it is deliberately
   * left as configured. The path in a backup is where the *old* machine wrote,
   * which on a new one is usually a folder that does not exist — and since
   * backup failures are best-effort and swallowed by design, adopting it would
   * quietly stop backups on exactly the machine that just proved it needs them.
   */
  replaceAll(data: DataFile): void {
    this.db.exec('BEGIN');
    try {
      // Children first: `items` and `runs` reference topics.
      this.db.exec('DELETE FROM items');
      this.db.exec('DELETE FROM runs');
      this.db.exec('DELETE FROM topics');
      for (const topic of data.topics) this.insertTopic(topic);
      for (const item of data.items) this.insertItem(item);
      for (const run of data.runs) this.insertRun(run);
      this.writeSettings({ ...data.settings, backupDir: this.getSettings().backupDir });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.settingsCache = this.loadSettings();
  }

  /** Release the database handle. Tests open many stores; servers hold one. */
  close(): void {
    this.db.close();
  }

  // --- Row mapping ---------------------------------------------------------

  private static rowToTopic(row: Record<string, unknown>): Topic {
    return TopicSchema.parse({
      id: row['id'],
      name: row['name'],
      paused: isTrue(row['paused']),
      highPriority: isTrue(row['high_priority']),
      guidance: row['guidance'],
      createdAt: row['created_at'],
      lastCheckedAt: row['last_checked_at'] ?? null,
      coveredThroughAt: row['covered_through_at'] ?? null,
      category: row['category'] ?? null,
      subcategory: row['subcategory'] ?? null,
      categorySource: row['category_source'] ?? 'auto',
      consecutiveFailures: asCount(row['consecutive_failures']),
      retryAfter: row['retry_after'] ?? null,
    });
  }

  private static rowToItem(row: Record<string, unknown>): NewsItem {
    return NewsItemSchema.parse({
      id: row['id'],
      topicId: row['topic_id'],
      title: row['title'],
      summary: row['summary'],
      saved: isTrue(row['saved']),
      offTopic: isTrue(row['off_topic']),
      sources: parseJson(row['sources']) ?? [],
      image: parseJson(row['image']),
      dedupeKey: row['dedupe_key'],
      foundAt: row['found_at'],
    });
  }

  private static rowToRun(row: Record<string, unknown>): CheckRun {
    return CheckRunSchema.parse({
      id: row['id'],
      topicId: row['topic_id'],
      startedAt: row['started_at'],
      finishedAt: row['finished_at'] ?? null,
      status: row['status'],
      newItems: asCount(row['new_items']),
      error: row['error'] ?? null,
      provider: row['provider'] ?? null,
      model: row['model'] ?? null,
      usage: parseJson(row['usage']),
      effort: row['effort'] ?? null,
    });
  }

  private insertTopic(topic: Topic): void {
    this.db
      .prepare(
        `INSERT INTO topics (id, name, paused, high_priority, guidance, created_at, last_checked_at,
                             covered_through_at, category, subcategory, category_source,
                             consecutive_failures, retry_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        topic.id,
        topic.name,
        bit(topic.paused),
        bit(topic.highPriority),
        topic.guidance,
        topic.createdAt,
        topic.lastCheckedAt,
        topic.coveredThroughAt,
        topic.category,
        topic.subcategory,
        topic.categorySource,
        topic.consecutiveFailures,
        topic.retryAfter,
      );
  }

  private insertItem(item: NewsItem): void {
    this.db
      .prepare(
        `INSERT INTO items (id, topic_id, title, summary, sources, image, dedupe_key, found_at, saved, off_topic)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.topicId,
        item.title,
        item.summary,
        JSON.stringify(item.sources),
        item.image === null ? null : JSON.stringify(item.image),
        item.dedupeKey,
        item.foundAt,
        bit(item.saved),
        bit(item.offTopic),
      );
  }

  private insertRun(run: CheckRun): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, topic_id, started_at, finished_at, status, new_items, error, provider, model, usage, effort)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.topicId,
        run.startedAt,
        run.finishedAt,
        run.status,
        run.newItems,
        run.error,
        run.provider,
        run.model,
        run.usage === null ? null : JSON.stringify(run.usage),
        run.effort,
      );
  }

  // --- Topics --------------------------------------------------------------

  /** Insertion order, which is the implicit rowid — the JSON array's order. */
  listTopics(): Topic[] {
    return (this.db.prepare('SELECT * FROM topics ORDER BY rowid').all() as Record<string, unknown>[]).map((r) =>
      Store.rowToTopic(r),
    );
  }

  getTopic(id: string): Topic | undefined {
    const row = this.db.prepare('SELECT * FROM topics WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : Store.rowToTopic(row);
  }

  /**
   * Create a topic.
   *
   * `init` carries what a topic added from a discovery suggestion already knows
   * (NEWS-126): its guidance steer and its classification. They are applied at
   * creation rather than by a follow-up update because `POST /api/topics` fires
   * the topic's first check immediately (FR-1.12) — a later write would land
   * after that check had already run unsteered.
   *
   * `categorySource` stays `auto`: the classification came from the model, not
   * from the user, so a manual change must still be able to override it
   * (FR-22.7). A topic that arrives already classified is not re-classified on
   * its first check, which is what saves the extra call (FR-24.13).
   */
  addTopic(
    name: string,
    init: { guidance?: string; category?: string | null; subcategory?: string | null } = {},
  ): Topic {
    const trimmed = name.trim();
    if (trimmed === '') throw new Error('topic name must not be empty');
    // Checked here rather than left to the unique index, so the message the API
    // surfaces names the topic instead of quoting a constraint.
    const existing = this.db
      .prepare('SELECT id FROM topics WHERE name = ? COLLATE NOCASE')
      .get(trimmed) as { id: string } | undefined;
    if (existing !== undefined) throw new Error(`topic "${trimmed}" already exists`);
    const topic: Topic = {
      id: randomUUID(),
      name: trimmed,
      paused: false,
      highPriority: false,
      guidance: (init.guidance ?? '').trim(),
      createdAt: new Date().toISOString(),
      lastCheckedAt: null,
      coveredThroughAt: null,
      category: init.category ?? null,
      subcategory: init.category == null ? null : (init.subcategory ?? null),
      categorySource: 'auto',
      consecutiveFailures: 0,
      retryAfter: null,
    };
    this.insertTopic(topic);
    return topic;
  }

  /** Set one topic column and return the reloaded row, or throw if it's gone. */
  private updateTopic(id: string, column: string, value: string | number | null): Topic {
    const info = this.db.prepare(`UPDATE topics SET ${column} = ? WHERE id = ?`).run(value, id);
    if (asCount(info.changes) === 0) throw new Error(`no such topic: ${id}`);
    const topic = this.getTopic(id);
    if (topic === undefined) throw new Error(`no such topic: ${id}`);
    return topic;
  }

  /**
   * Rename a topic (NEWS-139).
   *
   * The uniqueness check is the same one `addTopic` makes, and for the same
   * reason: the message should name the topic rather than quote a constraint.
   * Renaming to the name it already has is allowed — it is a no-op, not a
   * collision with itself.
   */
  renameTopic(id: string, name: string): Topic {
    const trimmed = name.trim();
    if (trimmed === '') throw new Error('topic name must not be empty');
    const existing = this.db
      .prepare('SELECT id FROM topics WHERE name = ? COLLATE NOCASE AND id != ?')
      .get(trimmed, id) as { id: string } | undefined;
    if (existing !== undefined) throw new Error(`topic "${trimmed}" already exists`);
    return this.updateTopic(id, 'name', trimmed);
  }

  /** How many stories a topic currently has — what a rename may be about to discard. */
  countItemsForTopic(id: string): number {
    const row = this.db.prepare('SELECT count(*) AS c FROM items WHERE topic_id = ?').get(id) as { c: unknown };
    return asCount(row.c);
  }

  /**
   * Drop a topic's stories and reset its check window (NEWS-139).
   *
   * Offered after a rename, where the user is saying the topic now means
   * something else. Clearing the stories alone would leave the topic *looking*
   * fresh while still behaving as though it had been covered up to now, so
   * `coveredThroughAt` goes with them — the next check treats it as a first
   * check and spans a sensible window rather than reporting nothing.
   *
   * The run history is deliberately **kept**: it records what the app did, not
   * what the topic is about, and diagnostics would be poorer for losing it.
   */
  clearItemsForTopic(id: string): ClearedItems {
    this.db.exec('BEGIN');
    try {
      // Read before deleting, so the caller can offer an undo (NEWS-145). Both
      // halves have to come back together: restoring the stories while leaving
      // `coveredThroughAt` null would re-report them all on the next check.
      const coveredThroughAt = this.coveredThroughAt(id);
      const items = (this.db.prepare('SELECT * FROM items WHERE topic_id = ? ORDER BY rowid').all(id) as Record<
        string,
        unknown
      >[]).map((r) => Store.rowToItem(r));
      this.db.prepare('DELETE FROM items WHERE topic_id = ?').run(id);
      this.db.prepare('UPDATE topics SET covered_through_at = NULL WHERE id = ?').run(id);
      this.db.exec('COMMIT');
      return { items, coveredThroughAt };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private coveredThroughAt(id: string): string | null {
    const row = this.db.prepare('SELECT covered_through_at AS c FROM topics WHERE id = ?').get(id) as
      | { c: unknown }
      | undefined;
    return typeof row?.c === 'string' ? row.c : null;
  }

  /**
   * Put back what `clearItemsForTopic` took (NEWS-145).
   *
   * Rows go back **with their original ids**, not as fresh inserts: a story's id
   * is what a bookmark, an off-topic flag and an open share dialog all refer to,
   * so re-adding it under a new id would restore the text while quietly breaking
   * every reference to it. `saved` and `offTopic` ride along in the snapshot for
   * the same reason — an undo that silently un-bookmarked a story would be a
   * worse outcome than the clear it was undoing.
   *
   * Ignores rows whose id is already present, which is what a double-submitted
   * undo looks like. The insert would otherwise throw on the primary key and
   * abort the whole restore, losing the rest of the batch to a duplicate click.
   */
  restoreClearedItems(id: string, cleared: ClearedItems): number {
    this.db.exec('BEGIN');
    try {
      let restored = 0;
      for (const item of cleared.items) {
        const exists = this.db.prepare('SELECT 1 FROM items WHERE id = ?').get(item.id);
        if (exists !== undefined) continue;
        this.insertItem(item);
        restored += 1;
      }
      this.db.prepare('UPDATE topics SET covered_through_at = ? WHERE id = ?').run(cleared.coveredThroughAt, id);
      this.db.exec('COMMIT');
      return restored;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  setTopicPaused(id: string, paused: boolean): Topic {
    return this.updateTopic(id, 'paused', bit(paused));
  }

  /** Mark a topic high-priority (shorter interval) or normal (NEWS-56). */
  setTopicHighPriority(id: string, highPriority: boolean): Topic {
    return this.updateTopic(id, 'high_priority', bit(highPriority));
  }

  /**
   * Set (or clear, with '') the topic's free-text guidance (NEWS-80).
   *
   * Trimmed on the way in so whitespace-only input reads as "no guidance"
   * everywhere downstream — the prompt, the UI indicator, and the API response
   * all key off emptiness, and they should agree.
   */
  setTopicGuidance(id: string, guidance: string): Topic {
    return this.updateTopic(id, 'guidance', guidance.trim().slice(0, MAX_GUIDANCE_LENGTH));
  }

  /**
   * Set a topic's category (NEWS-97).
   *
   * `source` records who chose it, and `'manual'` is a promise: an automatic
   * classification must not overwrite it. That check belongs to the caller doing
   * the classifying — this method is the deliberate write, and a "recategorize"
   * action has to be able to replace a manual choice.
   *
   * Slugs are stored as given, without validating them against the taxonomy.
   * The taxonomy is code-side and editable, so a slug that resolves today may
   * not tomorrow; rejecting unknown slugs here would make the store the one
   * place that can't survive an ordinary edit. Unresolvable slugs render as
   * *Uncategorized* (FR-22.3, FR-22.5). Callers accepting a slug from a *model*
   * should still validate it — see NEWS-107.
   */
  setTopicCategory(
    id: string,
    category: string | null,
    subcategory: string | null,
    source: 'auto' | 'manual',
  ): Topic {
    const info = this.db
      .prepare('UPDATE topics SET category = ?, subcategory = ?, category_source = ? WHERE id = ?')
      .run(category, subcategory, source, id);
    if (asCount(info.changes) === 0) throw new Error(`no such topic: ${id}`);
    const topic = this.getTopic(id);
    if (topic === undefined) throw new Error(`no such topic: ${id}`);
    return topic;
  }

  /**
   * Record a failed check and when the topic may be tried again (NEWS-110).
   *
   * Deliberately separate from `markTopicChecked`: that one means "we have news
   * up to here", and moving it for a network outage claims a check happened
   * when none did — which is what made a five-minute outage cost a whole
   * interval. This records the failure without that claim.
   *
   * Silently does nothing for a deleted topic, like the other check-time
   * writers: a check can outlive the topic that started it.
   */
  recordCheckFailure(id: string, retryAfter: Date | null): void {
    this.db
      .prepare(
        `UPDATE topics SET consecutive_failures = consecutive_failures + 1, retry_after = ? WHERE id = ?`,
      )
      .run(retryAfter === null ? null : retryAfter.toISOString(), id);
  }

  /** Clear the failure streak after a success (NEWS-110). */
  clearCheckFailures(id: string): void {
    this.db.prepare('UPDATE topics SET consecutive_failures = 0, retry_after = NULL WHERE id = ?').run(id);
  }

  /**
   * Record a check *attempt*. Call for successes and failures alike — it is
   * what keeps the scheduler from retrying a broken provider every tick.
   *
   * Silently does nothing for a deleted topic: a check can outlive the topic
   * that started it, and that is not an error.
   */
  markTopicChecked(id: string, when: Date): void {
    this.db.prepare('UPDATE topics SET last_checked_at = ? WHERE id = ?').run(when.toISOString(), id);
  }

  /**
   * Record that news is covered through `when`. Successes only — this is the
   * point the next prompt asks from, so advancing it after a failure would
   * discard however much news was pending.
   */
  markTopicCovered(id: string, when: Date): void {
    this.db.prepare('UPDATE topics SET covered_through_at = ? WHERE id = ?').run(when.toISOString(), id);
  }

  /**
   * Delete a topic and everything filed under it.
   *
   * Cascaded by hand rather than by a foreign key — see the note in `sqlite.ts`:
   * a constraint would also reject a *write* for a topic deleted mid-check,
   * turning a harmless race into a thrown error.
   */
  deleteTopic(id: string): void {
    this.db.exec('BEGIN');
    try {
      const info = this.db.prepare('DELETE FROM topics WHERE id = ?').run(id);
      if (asCount(info.changes) === 0) throw new Error(`no such topic: ${id}`);
      this.db.prepare('DELETE FROM items WHERE topic_id = ?').run(id);
      this.db.prepare('DELETE FROM runs WHERE topic_id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // --- Items ---------------------------------------------------------------

  listItems(topicId?: string): NewsItem[] {
    const rows =
      topicId === undefined
        ? this.db.prepare('SELECT * FROM items ORDER BY rowid').all()
        : this.db.prepare('SELECT * FROM items WHERE topic_id = ? ORDER BY rowid').all(topicId);
    return (rows as Record<string, unknown>[]).map((r) => Store.rowToItem(r));
  }

  /**
   * Query the feed for a page (server-side pagination, NEWS-74).
   *
   * Filters, sorts newest-first, and cursor-paginates in one place so the
   * server is the single source of truth for what the feed shows:
   *  - `mode: 'review'` → only off-topic stories for `topicIds` (the reviewed
   *    topics); nothing else applies.
   *  - `mode: 'normal'` → exclude off-topic stories, then apply Solo (`topicIds`),
   *    Saved, and Search (title / summary / topic name).
   *
   * The cursor is the last item of the previous page `(foundAt, id)`; the page is
   * the items strictly *older* than it, so paging is stable as new items arrive.
   *
   * Search is `LIKE '%q%'` rather than FTS5 deliberately. FTS matches tokens and
   * prefixes, so it would stop matching mid-word — and a filter that narrows as
   * you type is exactly where someone types the middle of a word. Preserving the
   * old `String.includes` semantics keeps the behaviour identical to the JSON
   * store; FTS is a separate, user-visible decision (see the follow-up ticket).
   */
  queryItems(query: ItemQuery): { items: NewsItem[]; nextCursor: ItemCursor | null; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    const topicIds = query.topicIds ?? [];

    if (query.mode === 'review') {
      // Review mode shows a named set of topics' flagged stories; with no topics
      // named there is nothing to review, which `IN ()` can't express.
      if (topicIds.length === 0) return { items: [], nextCursor: null, total: 0 };
      where.push('i.off_topic = 1');
      where.push(`i.topic_id IN (${topicIds.map(() => '?').join(',')})`);
      params.push(...topicIds);
    } else {
      where.push('i.off_topic = 0');
      if (topicIds.length > 0) {
        where.push(`i.topic_id IN (${topicIds.map(() => '?').join(',')})`);
        params.push(...topicIds);
      }
      if (query.saved === true) where.push('i.saved = 1');
      // Category filter (NEWS-97). Resolved here rather than in the client
      // because the client holds one page — filtering there would silently miss
      // matches deeper in history, which is the bug NEWS-74 existed to fix.
      if (query.category === UNCATEGORIZED_FILTER) {
        where.push('t.category IS NULL');
      } else if (query.category !== undefined && query.category !== '') {
        where.push('t.category = ?');
        params.push(query.category);
        if (query.subcategory === NO_SUBCATEGORY_FILTER) {
          where.push('t.subcategory IS NULL');
        } else if (query.subcategory !== undefined && query.subcategory !== '') {
          where.push('t.subcategory = ?');
          params.push(query.subcategory);
        }
      }
      const q = (query.q ?? '').trim().toLowerCase();
      if (q !== '') {
        // `escape` keeps a literal % or _ in the query from turning into a
        // wildcard — searching for "100%" should find "100%", not everything.
        const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        where.push(
          `(lower(i.title) LIKE ? ESCAPE '\\' OR lower(i.summary) LIKE ? ESCAPE '\\' OR lower(coalesce(t.name, '')) LIKE ? ESCAPE '\\')`,
        );
        params.push(like, like, like);
      }
    }

    // LEFT JOIN, not JOIN: a story can be filed for a topic deleted mid-check,
    // and the JSON store looked names up in a map that simply missed — it never
    // dropped the row. An inner join would silently hide those.
    const from = 'FROM items i LEFT JOIN topics t ON t.id = i.topic_id';
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const totalRow = this.db.prepare(`SELECT count(*) AS c ${from} ${clause}`).get(...params) as { c: unknown };
    const total = asCount(totalRow.c);

    const pageWhere = [...where];
    const pageParams = [...params];
    const c = query.before;
    if (c !== undefined && c !== null) {
      pageWhere.push('(i.found_at < ? OR (i.found_at = ? AND i.id < ?))');
      pageParams.push(c.foundAt, c.foundAt, c.id);
    }
    // One row more than the page, so "are there more?" is answered by the query
    // rather than by a second count.
    const rows = this.db
      .prepare(
        `SELECT i.* ${from} WHERE ${pageWhere.join(' AND ')} ORDER BY i.found_at DESC, i.id DESC LIMIT ?`,
      )
      .all(...pageParams, query.limit + 1) as Record<string, unknown>[];

    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit).map((r) => Store.rowToItem(r));
    const last = hasMore ? items[items.length - 1] : undefined;
    const nextCursor = last ? { foundAt: last.foundAt, id: last.id } : null;
    return { items, nextCursor, total };
  }

  dedupeKeysForTopic(topicId: string): Set<string> {
    const rows = this.db.prepare('SELECT dedupe_key AS k FROM items WHERE topic_id = ?').all(topicId) as {
      k: string;
    }[];
    return new Set(rows.map((r) => r.k));
  }

  /**
   * The newest `n` item ids across all topics, newest first (NEWS-75, phase 2a).
   *
   * Small enough to ride the `/api/state` poll: it's the signal the client uses
   * to detect *new* stories for notifications, independent of whatever filtered
   * page the feed is showing — so a new story in a topic you aren't looking at
   * still notifies.
   */
  latestItemIds(n = 50): string[] {
    const rows = this.db
      .prepare('SELECT id FROM items ORDER BY found_at DESC, id DESC LIMIT ?')
      .all(n) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /**
   * Count of off-topic (flagged) stories per topic (NEWS-76). Drives the
   * "Review Flagged (N)" badge once the feed page no longer carries the full
   * item list. Topics with none are omitted.
   */
  flaggedCountsByTopic(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT topic_id AS t, count(*) AS c FROM items WHERE off_topic = 1 GROUP BY topic_id')
      .all() as { t: string; c: unknown }[];
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.t] = asCount(row.c);
    return counts;
  }

  /**
   * How many stories each topic turned up **today**, for the sidebar badge
   * (NEWS-242), plus the newest story's timestamp per topic, for the
   * most-recent sort (NEWS-241).
   *
   * One query for both, because both are read by the same `/api/state` poll
   * every four seconds and a second scan of `items` would buy nothing.
   *
   * Three decisions worth stating, since none is forced:
   *
   * - **`found_at`, not the published date.** The feed's day headings already
   *   group on `found_at`, so a badge counting anything else would disagree with
   *   the list it sits beside — "3 today" over two visible rows.
   * - **Off-topic stories are excluded**, exactly as the feed excludes them
   *   (FR-3.x). A badge is a promise about what you will see if you click.
   * - **The day boundary is the caller's.** `startOfDayIso` is passed in rather
   *   than computed here so "today" means the *local* day, and so tests can
   *   pick a boundary instead of waiting for midnight.
   */
  itemStatsByTopic(startOfDayIso: string): {
    today: Record<string, number>;
    newestAt: Record<string, string>;
  } {
    const rows = this.db
      .prepare(
        `SELECT topic_id AS t,
                sum(CASE WHEN found_at >= ? THEN 1 ELSE 0 END) AS today,
                max(found_at) AS newest
           FROM items
          WHERE off_topic = 0
          GROUP BY topic_id`,
      )
      .all(startOfDayIso) as { t: string; today: unknown; newest: unknown }[];
    const today: Record<string, number> = {};
    const newestAt: Record<string, string> = {};
    for (const row of rows) {
      const count = asCount(row.today);
      // Only carry a topic that actually has stories today. A zero would render
      // as a badge saying nothing happened, on every quiet topic, forever.
      if (count > 0) today[row.t] = count;
      if (typeof row.newest === 'string') newestAt[row.t] = row.newest;
    }
    return { today, newestAt };
  }

  /**
   * Titles of a topic's off-topic stories, most recent first, for the prompt's
   * negative-example list (NEWS-61). Capped by `limit` to keep the prompt bounded.
   */
  offTopicTitlesForTopic(topicId: string, limit = 10): string[] {
    const rows = this.db
      .prepare('SELECT title FROM items WHERE topic_id = ? AND off_topic = 1 ORDER BY found_at DESC LIMIT ?')
      .all(topicId, limit) as { title: string }[];
    // Through the schema, not straight off the row: stored titles may predate
    // `stripMarkup`, and the prompt should never be handed citation markup.
    return rows.map((r) => NewsItemSchema.shape.title.parse(r.title));
  }

  /** Toggle one item flag and return the reloaded item, or null if it's gone. */
  private setItemFlag(id: string, column: 'saved' | 'off_topic', value: boolean): NewsItem | null {
    const info = this.db.prepare(`UPDATE items SET ${column} = ? WHERE id = ?`).run(bit(value), id);
    if (asCount(info.changes) === 0) return null;
    const row = this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row === undefined ? null : Store.rowToItem(row);
  }

  /** Bookmark or un-bookmark a story. Returns the updated item, or null if gone. */
  setItemSaved(id: string, saved: boolean): NewsItem | null {
    return this.setItemFlag(id, 'saved', saved);
  }

  /** Flag or un-flag a story as off-topic (NEWS-61). Null if the item is gone. */
  setItemOffTopic(id: string, offTopic: boolean): NewsItem | null {
    return this.setItemFlag(id, 'off_topic', offTopic);
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
    // One transaction: a check's stories arrive together or not at all, and a
    // single commit is also what makes a sweep's writes cheap.
    this.db.exec('BEGIN');
    try {
      for (const item of added) this.insertItem(item);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return added;
  }

  // --- Settings ------------------------------------------------------------

  private loadSettings(): Settings {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'settings'`).get() as
      | { value: string }
      | undefined;
    if (row === undefined) {
      const defaults = emptyDataFile().settings;
      this.writeSettings(defaults);
      return defaults;
    }
    try {
      return SettingsSchema.parse(JSON.parse(row.value));
    } catch (err) {
      // Settings alone are recoverable — falling back to defaults keeps topics
      // and stories, which is the whole point of not storing them together.
      console.error(`newsmonger: settings unreadable (${String(err)}); using defaults`);
      const defaults = emptyDataFile().settings;
      this.writeSettings(defaults);
      return defaults;
    }
  }

  private writeSettings(settings: Settings): void {
    this.db
      .prepare(`INSERT INTO meta (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify(settings));
  }

  getSettings(): Settings {
    return { ...this.settingsCache };
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.settingsCache, ...patch };
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
    this.writeSettings(next);
    this.settingsCache = next;
    return this.getSettings();
  }

  // --- Check runs ----------------------------------------------------------

  listRuns(limit = 50): CheckRun[] {
    const rows = this.db.prepare('SELECT * FROM runs ORDER BY rowid DESC LIMIT ?').all(limit) as Record<
      string,
      unknown
    >[];
    return rows.map((r) => Store.rowToRun(r));
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
      effort: null,
    };
    this.insertRun(run);
    // Retention is applied by `pruneOldRuns` in the housekeeping sweep, not here
    // (NEWS-103): the count ceiling is now 25,000, and re-scanning that many
    // rowids on every check to enforce a bound nothing is close to would be a
    // cost paid constantly for a case that almost never arises.
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
      /** Effort the check ran at (NEWS-226); '' = the model's default. */
      effort?: string | null;
    },
  ): void {
    const sets = ['finished_at = ?', 'status = ?', 'new_items = ?', 'error = ?'];
    const params: (string | number | null)[] = [
      new Date().toISOString(),
      result.status,
      result.newItems,
      result.error ?? null,
    ];
    // Absent means "don't touch", which is why these are conditional rather
    // than defaulted — a retry that reports no model shouldn't erase the one
    // the first attempt recorded.
    if (result.provider !== undefined) {
      sets.push('provider = ?');
      params.push(result.provider);
    }
    if (result.model !== undefined) {
      sets.push('model = ?');
      params.push(result.model);
    }
    if (result.usage !== undefined) {
      sets.push('usage = ?');
      params.push(result.usage === null ? null : JSON.stringify(result.usage));
    }
    // Same "absent means don't touch" rule as the three above.
    if (result.effort !== undefined) {
      sets.push('effort = ?');
      params.push(result.effort);
    }
    this.db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...params, runId);
  }

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
    const days = this.settingsCache.itemRetentionDays;
    if (days <= 0) return 0;
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    const info = this.db
      .prepare('DELETE FROM items WHERE saved = 0 AND off_topic = 0 AND found_at < ?')
      .run(cutoff);
    return asCount(info.changes);
  }

  /**
   * Apply run-history retention (NEWS-103): drop runs older than
   * `RUN_RETENTION_DAYS`, then any beyond `MAX_RUNS_KEPT` oldest-first.
   *
   * See the constants above for why this is a date window with a count backstop
   * rather than either alone.
   */
  pruneOldRuns(now: Date): number {
    const cutoff = new Date(now.getTime() - RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const aged = this.db.prepare('DELETE FROM runs WHERE started_at < ?').run(cutoff);
    // Only pay for the rowid scan when the table is actually over the ceiling;
    // on every ordinary call this is a single indexed count.
    const total = asCount((this.db.prepare('SELECT count(*) AS c FROM runs').get() as { c: unknown }).c);
    let excess = 0;
    if (total > MAX_RUNS_KEPT) {
      excess = asCount(
        this.db
          .prepare('DELETE FROM runs WHERE rowid NOT IN (SELECT rowid FROM runs ORDER BY rowid DESC LIMIT ?)')
          .run(MAX_RUNS_KEPT).changes,
      );
    }
    return asCount(aged.changes) + excess;
  }

  /**
   * Delete stories and runs whose topic no longer exists (NEWS-105).
   *
   * `deleteTopic` already removes everything filed under a topic — but it runs
   * *at deletion time*, and a check in flight can write a story or finish a run
   * afterwards. There are no foreign keys precisely so that write succeeds
   * rather than throwing mid-sweep (see `sqlite.ts`), which leaves this sweep as
   * the thing that collects what the race left behind.
   *
   * Deliberately not solved at the writers: checking the topic exists before
   * every insert costs a query on the hot path and still loses the race, since
   * the topic can go between the check and the insert. Cleaning up after is both
   * cheaper and actually correct.
   *
   * Returns the two counts separately: only the item count means cached images
   * may now be reclaimable, and a caller that logs "pruned 3" without saying
   * three of *what* is not worth logging.
   */
  pruneOrphans(): { items: number; runs: number } {
    const items = this.db
      .prepare('DELETE FROM items WHERE topic_id NOT IN (SELECT id FROM topics)')
      .run();
    const runs = this.db.prepare('DELETE FROM runs WHERE topic_id NOT IN (SELECT id FROM topics)').run();
    return { items: asCount(items.changes), runs: asCount(runs.changes) };
  }

}
