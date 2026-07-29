import type { ClearedItems } from './db/store.js';

/**
 * How long a cleared topic stays restorable (NEWS-145).
 *
 * Generous slack over the toast that offers the undo — the toast is the
 * affordance, this is only the thing that must not outlive its usefulness or
 * hold a deleted feed in memory forever. A user who reaches for the mouse and
 * misses should still find the undo live; one who wanders off should not have
 * the app quietly holding their cleared stories a quarter of an hour later.
 */
export const UNDO_TTL_MS = 60_000;

/**
 * How many topics can have an outstanding undo at once.
 *
 * Clearing is a deliberate, one-at-a-time act, so this is a memory backstop
 * rather than a real limit — but it is an unbounded map holding whole feeds
 * otherwise, and the one bug that produces is the one nobody sees until a
 * long-running instance has swallowed a few hundred megabytes.
 */
const MAX_ENTRIES = 8;

interface Entry {
  cleared: ClearedItems;
  at: number;
}

/**
 * In-memory undo for "clear this topic's stories" (NEWS-145).
 *
 * Deliberately **not** persisted. The alternative considered was a soft-delete
 * column swept later, which survives a restart but costs a schema change and a
 * filter on every read path that touches items — real surface area for a
 * mistake, to catch a case (clear, then restart the server, then change your
 * mind) that is not the one the undo exists for. The case it exists for is
 * ticking the clear box without meaning to, and noticing immediately.
 *
 * The consequence is honest and worth stating rather than hiding: a reload
 * during the window forfeits the undo, because the buffer lives in the server
 * process, not in the page.
 *
 * Keyed by topic id, so clearing a *second* topic does not displace the first's
 * undo — and re-clearing the *same* topic replaces its entry, which is right:
 * the newer snapshot is the one that matches what is on screen.
 */
export class ClearUndoBuffer {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Stash what a clear removed. Replaces any earlier snapshot for this topic. */
  remember(topicId: string, cleared: ClearedItems): void {
    this.sweep();
    // Delete before set so a replaced key moves to the end of the insertion
    // order, or the eviction below would drop the freshest entry for that topic.
    this.entries.delete(topicId);
    this.entries.set(topicId, { cleared, at: this.now() });
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  /**
   * Take the snapshot for a topic, if it is still live.
   *
   * Removing on read is what makes a double-submitted undo a no-op at this
   * layer rather than a second restore — `restoreClearedItems` skips rows that
   * already exist too, but the two guards answer different questions and the
   * cheap one should come first.
   */
  take(topicId: string): ClearedItems | null {
    this.sweep();
    const entry = this.entries.get(topicId);
    if (entry === undefined) return null;
    this.entries.delete(topicId);
    return entry.cleared;
  }

  /** Whether an undo is currently on offer for this topic. Does not consume it. */
  has(topicId: string): boolean {
    this.sweep();
    return this.entries.has(topicId);
  }

  private sweep(): void {
    const cutoff = this.now() - UNDO_TTL_MS;
    for (const [id, entry] of this.entries) {
      if (entry.at <= cutoff) this.entries.delete(id);
    }
  }
}
