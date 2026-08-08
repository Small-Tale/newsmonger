import { describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/index.js';
import { CheckRunner } from '../../src/checks.js';
import type { Store } from '../../src/db/store.js';
import { createApp } from '../../src/server.js';
import { asResolver } from '../helpers/provider.js';
import { tmpStore } from '../helpers/tmp.js';

/** Renaming a topic, and the optional clearing that goes with it (NEWS-139). */

function makeApp() {
  const store = tmpStore();
  const runner = new CheckRunner(store, asResolver(createMockProvider()));
  return { app: createApp({ store, runner }), store };
}

async function patch(app: ReturnType<typeof makeApp>['app'], id: string, body: unknown): Promise<Response> {
  return app.request(`/api/topics/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A topic with stories attached, which is what makes clearing meaningful. */
function seed(store: Store, name: string, stories = 2) {
  const topic = store.addTopic(name);
  store.addItems(
    Array.from({ length: stories }, (_, i) => ({
      topicId: topic.id,
      title: `${name} story ${String(i)}`,
      summary: 's',
      sources: [{ title: 't', url: `https://e.com/${name}/${String(i)}`, outlet: null, publishedAt: null, favicon: null }],
      dedupeKey: `${name}-${String(i)}`,
      foundAt: new Date().toISOString(),
    })),
  );
  store.markTopicCovered(topic.id, new Date());
  return topic;
}

describe('renaming', () => {
  it('changes the name and leaves the stories alone by default', async () => {
    const { app, store } = makeApp();
    const topic = seed(store, 'Apple');

    const res = await patch(app, topic.id, { name: 'Apple Inc' });

    expect(res.status).toBe(200);
    expect(store.getTopic(topic.id)?.name).toBe('Apple Inc');
    expect(store.countItemsForTopic(topic.id)).toBe(2);
  });

  it('trims, and accepts renaming a topic to the name it already has', async () => {
    // Not a collision with itself — a no-op rename must not 409.
    const { app, store } = makeApp();
    const topic = seed(store, 'Apple');
    expect((await patch(app, topic.id, { name: '  Apple  ' })).status).toBe(200);
    expect(store.getTopic(topic.id)?.name).toBe('Apple');
  });

  it('rejects a name another topic already has, as a conflict not a 404', async () => {
    // 404 would send the user looking for a missing topic; this is a name they
    // can change, and the message has to say which one.
    const { app, store } = makeApp();
    seed(store, 'Apple');
    const other = seed(store, 'Oranges');

    const res = await patch(app, other.id, { name: 'apple' });

    expect(res.status).toBe(409);
    expect(store.getTopic(other.id)?.name).toBe('Oranges');
  });

  it('rejects a blank name', async () => {
    const { app, store } = makeApp();
    const topic = seed(store, 'Apple');
    expect((await patch(app, topic.id, { name: '   ' })).status).toBe(409);
    expect(store.getTopic(topic.id)?.name).toBe('Apple');
  });

  it('404s for a topic that does not exist', async () => {
    const { app } = makeApp();
    expect((await patch(app, 'nope', { name: 'Anything' })).status).toBe(404);
  });
});

describe('clearing previous results', () => {
  it('drops the stories and resets the check window', async () => {
    // Clearing the stories alone would leave the topic looking fresh while still
    // behaving as though it had been covered up to now — so the next check would
    // report nothing.
    const { app, store } = makeApp();
    const topic = seed(store, 'Apple');
    expect(store.getTopic(topic.id)?.coveredThroughAt).not.toBeNull();

    await patch(app, topic.id, { name: 'Apple Inc', clearItems: true });

    expect(store.countItemsForTopic(topic.id)).toBe(0);
    expect(store.getTopic(topic.id)?.coveredThroughAt).toBeNull();
  });

  it('keeps the run history, which is about the app and not the topic', async () => {
    const { app, store } = makeApp();
    const topic = seed(store, 'Apple');
    const run = store.startRun(topic.id);
    store.finishRun(run.id, { status: 'succeeded', newItems: 2 });

    await patch(app, topic.id, { name: 'Apple Inc', clearItems: true });

    expect(store.listRuns(10).some((r) => r.id === run.id)).toBe(true);
  });

  it('touches only the renamed topic', async () => {
    const { app, store } = makeApp();
    const apple = seed(store, 'Apple');
    const oranges = seed(store, 'Oranges');

    await patch(app, apple.id, { name: 'Apple Inc', clearItems: true });

    expect(store.countItemsForTopic(apple.id)).toBe(0);
    expect(store.countItemsForTopic(oranges.id)).toBe(2);
  });

  it('refuses to clear without a rename to justify it', async () => {
    // There is a delete for wiping a topic. `PATCH` must not become a second
    // one that happens to leave the topic behind.
    const { app, store } = makeApp();
    const topic = seed(store, 'Apple');

    const res = await patch(app, topic.id, { clearItems: true });

    expect(res.status).toBe(400);
    expect(store.countItemsForTopic(topic.id)).toBe(2);
  });

  it('clears nothing when the rename itself is rejected', async () => {
    // The order matters: a 409 that had already discarded the stories would be
    // the worst outcome this route could produce.
    const { app, store } = makeApp();
    seed(store, 'Apple');
    const other = seed(store, 'Oranges');

    const res = await patch(app, other.id, { name: 'Apple', clearItems: true });

    expect(res.status).toBe(409);
    expect(store.countItemsForTopic(other.id)).toBe(2);
  });
});

describe('the story count behind the clear option', () => {
  it('comes from the feed endpoint per topic, not from a per-poll aggregate', async () => {
    // Deliberately not on `/api/state`: that is polled every four seconds by
    // every client, and a `GROUP BY` over every story measurably slowed the
    // settings round trip when it lived there.
    const { app, store } = makeApp();
    const apple = seed(store, 'Apple', 3);
    const empty = store.addTopic('Nothing yet');

    const count = async (id: string): Promise<number> => {
      const body = (await (await app.request(`/api/items?topics=${id}&limit=1`)).json()) as { total: number };
      return body.total;
    };

    expect(await count(apple.id)).toBe(3);
    expect(await count(empty.id)).toBe(0);
  });
});
