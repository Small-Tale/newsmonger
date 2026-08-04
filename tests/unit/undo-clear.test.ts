import { describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/index.js';
import { CheckRunner } from '../../src/checks.js';
import type { ClearedItems } from '../../src/db/store.js';
import { Store } from '../../src/db/store.js';
import { createApp } from '../../src/server.js';
import { ClearUndoBuffer, UNDO_TTL_MS } from '../../src/undo.js';
import { asResolver } from '../helpers/provider.js';
import { tmpDataDir } from '../helpers/tmp.js';

function snapshot(n: number): ClearedItems {
  return {
    items: Array.from({ length: n }, (_, i) => ({
      id: `i${String(i)}`,
      topicId: 't',
      title: `Story ${String(i)}`,
      summary: 's',
      sources: [],
      image: null,
      dedupeKey: `k${String(i)}`,
      threadId: `i${String(i)}`,
      foundAt: '2026-01-01T00:00:00.000Z',
      saved: false,
      offTopic: false,
    })),
    coveredThroughAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('ClearUndoBuffer (NEWS-145)', () => {
  it('hands back what was stashed, once', () => {
    const buf = new ClearUndoBuffer();
    buf.remember('a', snapshot(2));
    expect(buf.has('a')).toBe(true);
    expect(buf.take('a')?.items).toHaveLength(2);
    // Removing on read is what makes a double-clicked Undo a no-op here rather
    // than a second restore.
    expect(buf.take('a')).toBeNull();
    expect(buf.has('a')).toBe(false);
  });

  it('keeps topics apart, so clearing a second does not eat the first undo', () => {
    const buf = new ClearUndoBuffer();
    buf.remember('a', snapshot(2));
    buf.remember('b', snapshot(3));
    expect(buf.take('a')?.items).toHaveLength(2);
    expect(buf.take('b')?.items).toHaveLength(3);
  });

  it('replaces an earlier snapshot for the same topic', () => {
    // The newer one matches what is on screen; restoring the older would put
    // back stories the user has since cleared again.
    const buf = new ClearUndoBuffer();
    buf.remember('a', snapshot(2));
    buf.remember('a', snapshot(5));
    expect(buf.take('a')?.items).toHaveLength(5);
  });

  it('expires on its own clock', () => {
    let now = 1_000_000;
    const buf = new ClearUndoBuffer(() => now);
    buf.remember('a', snapshot(1));
    now += UNDO_TTL_MS - 1;
    expect(buf.has('a')).toBe(true);
    now += 2;
    expect(buf.has('a')).toBe(false);
    expect(buf.take('a')).toBeNull();
  });

  it('evicts the oldest rather than growing without bound', () => {
    const buf = new ClearUndoBuffer();
    for (let i = 0; i < 12; i += 1) buf.remember(`t${String(i)}`, snapshot(1));
    expect(buf.has('t0')).toBe(false);
    expect(buf.has('t11')).toBe(true);
  });

  it('re-remembering refreshes a topic against eviction', () => {
    // The delete-then-set in `remember` is what makes this work: without it the
    // replaced key keeps its original insertion position and is evicted first,
    // dropping the *freshest* snapshot for that topic.
    const buf = new ClearUndoBuffer();
    buf.remember('keep', snapshot(1));
    for (let i = 0; i < 6; i += 1) buf.remember(`t${String(i)}`, snapshot(1));
    buf.remember('keep', snapshot(9));
    for (let i = 6; i < 12; i += 1) buf.remember(`t${String(i)}`, snapshot(1));
    expect(buf.take('keep')?.items).toHaveLength(9);
  });
});

describe('restoring a cleared topic', () => {
  function app() {
    const store = new Store(tmpDataDir());
    const undo = new ClearUndoBuffer();
    const runner = new CheckRunner(store, asResolver(createMockProvider()));
    return { store, undo, app: createApp({ store, runner, undo }) };
  }

  function seed(store: Store): string {
    const topic = store.addTopic('Formula 1');
    store.addItems(
      ['a', 'b'].map((k) => ({
        topicId: topic.id,
        title: k.toUpperCase(),
        summary: k,
        sources: [{ title: 't', url: `https://e.com/${k}`, outlet: null, publishedAt: null, favicon: null }],
        dedupeKey: k,
        foundAt: new Date().toISOString(),
      })),
    );
    return topic.id;
  }

  it('puts the stories and the check window back', async () => {
    const { store, app: a } = app();
    const id = seed(store);
    const covered = new Date('2026-01-03T00:00:00.000Z');
    store.markTopicCovered(id, covered);
    const coveredIso = store.getTopic(id)?.coveredThroughAt ?? null;
    expect(coveredIso).not.toBeNull();

    await a.request(`/api/topics/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'F1', clearItems: true }),
    });
    expect(store.listItems(id)).toHaveLength(0);
    expect(store.getTopic(id)?.coveredThroughAt).toBeNull();

    const res = await a.request(`/api/topics/${id}/restore-cleared`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ restored: 2 });
    expect(store.listItems(id)).toHaveLength(2);
    // Both halves, or the next check re-reports every restored story as new.
    expect(store.getTopic(id)?.coveredThroughAt).toBe(coveredIso);
  });

  it('restores stories under their original ids, with their flags', async () => {
    const { store, app: a } = app();
    const id = seed(store);
    const first = store.listItems(id)[0];
    store.setItemSaved(first.id, true);

    await a.request(`/api/topics/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'F1', clearItems: true }),
    });
    await a.request(`/api/topics/${id}/restore-cleared`, { method: 'POST' });

    // A new id would restore the text while breaking every reference to the
    // story — a bookmark most of all, which is the thing a user would notice.
    const back = store.listItems(id).find((i) => i.id === first.id);
    expect(back).toBeDefined();
    expect(back?.saved).toBe(true);
  });

  it('is a no-op the second time, not a double restore', async () => {
    const { store, app: a } = app();
    const id = seed(store);
    await a.request(`/api/topics/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'F1', clearItems: true }),
    });
    await a.request(`/api/topics/${id}/restore-cleared`, { method: 'POST' });
    const second = await a.request(`/api/topics/${id}/restore-cleared`, { method: 'POST' });

    expect(second.status).toBe(410);
    expect(store.listItems(id)).toHaveLength(2);
  });

  it('answers 410 when the window has passed — the offer expired, not the topic', async () => {
    const { store, app: a } = app();
    const id = seed(store);
    const res = await a.request(`/api/topics/${id}/restore-cleared`, { method: 'POST' });
    expect(res.status).toBe(410);
  });

  it('answers 404 for a topic that no longer exists, and inserts nothing', async () => {
    const { store, undo, app: a } = app();
    const id = seed(store);
    await a.request(`/api/topics/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'F1', clearItems: true }),
    });
    store.deleteTopic(id);

    const res = await a.request(`/api/topics/${id}/restore-cleared`, { method: 'POST' });
    expect(res.status).toBe(404);
    // `items` has no foreign key on `topic_id`, so a restore here would insert
    // rows belonging to nothing: invisible in the feed, counted by aggregates.
    expect(store.listItems()).toHaveLength(0);
    // And the snapshot is left intact rather than consumed by the failed call.
    expect(undo.has(id)).toBe(true);
  });

  it('offers no undo for a clear that removed nothing', async () => {
    const { store, undo, app: a } = app();
    const topic = store.addTopic('Empty');
    await a.request(`/api/topics/${topic.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Still empty', clearItems: true }),
    });
    expect(undo.has(topic.id)).toBe(false);
  });

  it('does not stash anything for a rename without a clear', async () => {
    const { store, undo, app: a } = app();
    const id = seed(store);
    await a.request(`/api/topics/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'F1' }),
    });
    expect(undo.has(id)).toBe(false);
    expect(store.listItems(id)).toHaveLength(2);
  });

  it('a rejected rename clears nothing and offers no undo', async () => {
    // FR-25.9 applied to the new path: the 409 must leave both the stories and
    // the undo buffer exactly as they were.
    const { store, undo, app: a } = app();
    const id = seed(store);
    store.addTopic('Taken');

    const res = await a.request(`/api/topics/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Taken', clearItems: true }),
    });
    expect(res.status).toBe(409);
    expect(store.listItems(id)).toHaveLength(2);
    expect(undo.has(id)).toBe(false);
  });
});
