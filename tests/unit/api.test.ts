import { describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/index.js';
import { ItemsRespSchema, ProvidersRespSchema, StateRespSchema } from '../../src/api/schemas.js';
import { Attendance } from '../../src/attendance.js';
import { CheckRunner } from '../../src/checks.js';
import { Store } from '../../src/db/store.js';
import { createApp } from '../../src/server.js';
import { asResolver } from '../helpers/provider.js';
import { tmpDataDir } from '../helpers/tmp.js';

function makeApp() {
  const store = new Store(tmpDataDir());
  const service = createMockProvider();
  const runner = new CheckRunner(store, asResolver(service));
  const app = createApp({ store, runner });
  return { app, store, service, runner };
}

async function json(res: Response): Promise<unknown> {
  return (await res.json()) as unknown;
}

/** Poll state until no checks are in flight (checks run async after POST /api/check). */
async function waitForIdle(app: ReturnType<typeof makeApp>['app']): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const res = await app.request('/api/state');
    const state = StateRespSchema.parse(await json(res));
    if (state.checking.length === 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('checks never went idle');
}

describe('API', () => {
  it('serves a valid empty state', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/state');
    expect(res.status).toBe(200);
    const state = StateRespSchema.parse(await json(res));
    expect(state.topics).toEqual([]);
    expect(state.checking).toEqual([]);
  });

  it('creates topics and rejects invalid or duplicate ones', async () => {
    const { app } = makeApp();
    const created = await app.request('/api/topics', {
      method: 'POST',
      body: JSON.stringify({ name: 'Fusion' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(created.status).toBe(201);

    const bad = await app.request('/api/topics', { method: 'POST', body: '{}' });
    expect(bad.status).toBe(400);

    const dupe = await app.request('/api/topics', { method: 'POST', body: JSON.stringify({ name: 'fusion' }) });
    expect(dupe.status).toBe(409);
  });

  it('adds a topic and checks it immediately, without a manual check (NEWS-54)', async () => {
    // The bug: a freshly added topic just sat until the next scheduler tick
    // (up to a minute). Adding it must kick off a check on its own.
    const { app, store, service } = makeApp();
    const res = await app.request('/api/topics', { method: 'POST', body: JSON.stringify({ name: 'Fusion' }) });
    expect(res.status).toBe(201);

    // Nobody called /api/check — the add did.
    await waitForIdle(app);
    expect(service.calls.map((c) => c.topicName)).toEqual(['Fusion']);

    const state = StateRespSchema.parse(await json(await app.request('/api/state')));
    expect(store.listItems()).toHaveLength(2);
    expect(state.runs[0]?.status).toBe('succeeded');
    expect(store.listTopics()[0]?.lastCheckedAt).not.toBeNull();
  });

  it('the initial check counts as attendance, so it runs for a subscription provider unwatched (NEWS-54)', async () => {
    // The initial check is manual — the user is plainly present — so it must run
    // even for an attended provider with no prior foreground signal, and leave
    // attendance fresh (like the Check-now buttons, NEWS-44).
    const store = new Store(tmpDataDir());
    const attendance = new Attendance();
    const service = createMockProvider({ attended: true });
    const runner = new CheckRunner(store, asResolver(service), attendance);
    const app = createApp({ store, runner, attendance });
    expect(attendance.isAttended(Date.now())).toBe(false);

    await app.request('/api/topics', { method: 'POST', body: JSON.stringify({ name: 'Fusion' }) });
    await waitForIdle(app);

    expect(service.calls).toHaveLength(1);
    expect(store.listItems()).toHaveLength(2);
    expect(attendance.isAttended(Date.now())).toBe(true);
  });

  it('a topic that fails to be created is not checked (NEWS-54)', async () => {
    // The check must fire only after a *successful* add — a duplicate (409)
    // must not trigger a spurious check.
    const { app, service } = makeApp();
    await app.request('/api/topics', { method: 'POST', body: JSON.stringify({ name: 'Fusion' }) });
    await waitForIdle(app);
    expect(service.calls).toHaveLength(1);

    const dupe = await app.request('/api/topics', { method: 'POST', body: JSON.stringify({ name: 'fusion' }) });
    expect(dupe.status).toBe(409);
    await waitForIdle(app);
    expect(service.calls).toHaveLength(1); // still one — the dupe checked nothing
  });

  it('full flow: add topic, check, items appear, second check dedupes', async () => {
    const { app, store } = makeApp();
    await app.request('/api/topics', { method: 'POST', body: JSON.stringify({ name: 'Fusion' }) });
    const topicId = store.listTopics()[0]?.id ?? '';

    const check = await app.request('/api/check', { method: 'POST', body: JSON.stringify({ topicId }) });
    expect(check.status).toBe(200);
    await waitForIdle(app);

    const state = StateRespSchema.parse(await json(await app.request('/api/state')));
    expect(store.listItems()).toHaveLength(2);
    // The newest-ids field for notifications tracks the same items (NEWS-75).
    expect([...state.latestItemIds].sort()).toEqual(store.listItems().map((i) => i.id).sort());
    expect(state.runs[0]?.status).toBe('succeeded');
    expect(state.topics[0]?.lastCheckedAt).not.toBeNull();

    await app.request('/api/check', { method: 'POST', body: JSON.stringify({ topicId }) });
    await waitForIdle(app);
    expect(store.listItems()).toHaveLength(2); // dedup kept it at 2
  });

  it('check-all skips paused topics', async () => {
    const { app, store, service } = makeApp();
    store.addTopic('Active');
    const paused = store.addTopic('Sleepy');
    store.setTopicPaused(paused.id, true);

    const res = await app.request('/api/check', { method: 'POST', body: JSON.stringify({}) });
    const body = (await json(res)) as { started: string[] };
    expect(body.started).toHaveLength(1);
    await waitForIdle(app);
    expect(service.calls.map((c) => c.topicName)).toEqual(['Active']);
  });

  it('check of unknown topic 404s', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/check', { method: 'POST', body: JSON.stringify({ topicId: 'nope' }) });
    expect(res.status).toBe(404);
  });

  it('pause, resume, and delete topics over HTTP', async () => {
    const { app, store } = makeApp();
    const topic = store.addTopic('Toggle me');

    let res = await app.request(`/api/topics/${topic.id}`, { method: 'PATCH', body: JSON.stringify({ paused: true }) });
    expect(res.status).toBe(200);
    expect(store.getTopic(topic.id)?.paused).toBe(true);

    await app.request(`/api/topics/${topic.id}`, { method: 'PATCH', body: JSON.stringify({ paused: false }) });
    expect(store.getTopic(topic.id)?.paused).toBe(false);

    res = await app.request(`/api/topics/${topic.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(store.listTopics()).toEqual([]);

    res = await app.request(`/api/topics/${topic.id}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    res = await app.request(`/api/topics/${topic.id}`, { method: 'PATCH', body: JSON.stringify({ paused: true }) });
    expect(res.status).toBe(404);
  });

  it('serves a page of items with filters, cursor, and total (NEWS-74)', async () => {
    const { app, store } = makeApp();
    const topic = store.addTopic('Apple');
    for (let i = 0; i < 3; i++) {
      store.addItems([
        { topicId: topic.id, title: `story ${String(i)}`, summary: 's', sources: [], dedupeKey: `k${String(i)}`, foundAt: `2026-07-24T00:0${String(i)}:00Z` },
      ]);
    }
    const parse = async (url: string) =>
      ItemsRespSchema.parse(await json(await app.request(url)));

    const page1 = await parse('/api/items?limit=2');
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(3);
    expect(page1.nextCursor).not.toBeNull();

    const cursor = page1.nextCursor;
    const page2 = await parse(
      `/api/items?limit=2&beforeAt=${encodeURIComponent(cursor?.foundAt ?? '')}&beforeId=${encodeURIComponent(cursor?.id ?? '')}`,
    );
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    // A search narrows the total.
    const searched = await parse('/api/items?q=story%201');
    expect(searched.items.map((i) => i.title)).toEqual(['story 1']);
    expect(searched.total).toBe(1);
  });

  it('flags and unflags a story off-topic over HTTP (NEWS-61)', async () => {
    const { app, store } = makeApp();
    const topic = store.addTopic('Apple');
    const [item] = store.addItems([
      { topicId: topic.id, title: 'Apple pie', summary: 's', sources: [], dedupeKey: 'k', foundAt: '2026-07-24T00:00:00Z' },
    ]);
    const id = item.id;

    let res = await app.request(`/api/items/${id}`, { method: 'PATCH', body: JSON.stringify({ offTopic: true }) });
    expect(res.status).toBe(200);
    expect(store.listItems()[0]?.offTopic).toBe(true);

    res = await app.request(`/api/items/${id}`, { method: 'PATCH', body: JSON.stringify({ offTopic: false }) });
    expect(res.status).toBe(200);
    expect(store.listItems()[0]?.offTopic).toBe(false);

    // Empty body rejected; unknown item 404s.
    expect((await app.request(`/api/items/${id}`, { method: 'PATCH', body: '{}' })).status).toBe(400);
    expect(
      (await app.request('/api/items/nope', { method: 'PATCH', body: JSON.stringify({ offTopic: true }) })).status,
    ).toBe(404);
  });

  it('toggles a topic high-priority over HTTP (NEWS-56)', async () => {
    const { app, store } = makeApp();
    const topic = store.addTopic('Fusion');
    await waitForIdle(app); // let the add-triggered check settle

    let res = await app.request(`/api/topics/${topic.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ highPriority: true }),
    });
    expect(res.status).toBe(200);
    expect(store.getTopic(topic.id)?.highPriority).toBe(true);

    res = await app.request(`/api/topics/${topic.id}`, { method: 'PATCH', body: JSON.stringify({ highPriority: false }) });
    expect(res.status).toBe(200);
    expect(store.getTopic(topic.id)?.highPriority).toBe(false);

    // A patch with neither field is rejected.
    expect((await app.request(`/api/topics/${topic.id}`, { method: 'PATCH', body: '{}' })).status).toBe(400);
    // A high-priority patch on an unknown topic 404s.
    expect(
      (await app.request('/api/topics/nope', { method: 'PATCH', body: JSON.stringify({ highPriority: true }) })).status,
    ).toBe(404);
  });

  it('clamps the high-priority interval to the default over HTTP (NEWS-56)', async () => {
    const { app, store } = makeApp();
    // Set default to 1h; a longer high-priority value pulls the default up with it.
    await app.request('/api/settings', { method: 'PATCH', body: JSON.stringify({ checkIntervalMs: 3_600_000 }) });
    const res = await app.request('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ highPriorityIntervalMs: 6 * 3_600_000 }),
    });
    expect(res.status).toBe(200);
    expect(store.getSettings().highPriorityIntervalMs).toBe(6 * 3_600_000);
    expect(store.getSettings().checkIntervalMs).toBe(6 * 3_600_000);

    // Below the 5-minute floor is rejected.
    expect(
      (await app.request('/api/settings', { method: 'PATCH', body: JSON.stringify({ highPriorityIntervalMs: 1000 }) })).status,
    ).toBe(400);
  });

  it('updates settings and rejects intervals under five minutes', async () => {
    const { app, store } = makeApp();
    let res = await app.request('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ checkIntervalMs: 3_600_000 }),
    });
    expect(res.status).toBe(200);
    expect(store.getSettings().checkIntervalMs).toBe(3_600_000);

    res = await app.request('/api/settings', { method: 'PATCH', body: JSON.stringify({ checkIntervalMs: 1000 }) });
    expect(res.status).toBe(400);
    expect(store.getSettings().checkIntervalMs).toBe(3_600_000);
  });

  it('updates provider settings', async () => {
    const { app, store } = makeApp();
    const res = await app.request('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ provider: 'openai', model: 'gpt-x', endpoint: 'https://gw/v1' }),
    });
    expect(res.status).toBe(200);
    expect(store.getSettings().provider).toBe('openai');
    expect(store.getSettings().model).toBe('gpt-x');
    expect(store.getSettings().endpoint).toBe('https://gw/v1');
  });


  it('rejects an invalid provider and an empty settings patch', async () => {
    const { app } = makeApp();
    expect((await app.request('/api/settings', { method: 'PATCH', body: JSON.stringify({ provider: 'grok' }) })).status).toBe(400);
    expect((await app.request('/api/settings', { method: 'PATCH', body: JSON.stringify({}) })).status).toBe(400);
  });

  it('lists providers with availability', async () => {
    const { app } = makeApp();
    const resp = ProvidersRespSchema.parse(await json(await app.request('/api/providers')));
    const byName = new Map(resp.providers.map((p) => [p.name, p]));
    expect(byName.get('auto')?.available).toBeNull();
    expect(byName.get('openai')?.endpointConfigurable).toBe(true);
    expect(byName.get('anthropic')?.endpointConfigurable).toBe(false);
    expect(byName.get('mock')?.available).toBe(true);
    // anthropic availability depends on env; assert it's a boolean either way.
    expect(typeof byName.get('anthropic')?.available).toBe('boolean');
  });

  it('failed checks surface in runs with an error message', async () => {
    const { app, store } = makeApp();
    const topic = store.addTopic('please fail');
    await app.request('/api/check', { method: 'POST', body: JSON.stringify({ topicId: topic.id }) });
    await waitForIdle(app);
    const state = StateRespSchema.parse(await json(await app.request('/api/state')));
    expect(state.runs[0]?.status).toBe('failed');
    expect(state.runs[0]?.error).toMatch(/mock/);
    expect(store.listItems()).toEqual([]);
  });

  it('validates open-external urls', async () => {
    const { app } = makeApp();
    let res = await app.request('/api/open-external', { method: 'POST', body: JSON.stringify({ url: 'notaurl' }) });
    expect(res.status).toBe(400);
    res = await app.request('/api/open-external', {
      method: 'POST',
      body: JSON.stringify({ url: 'file:///etc/passwd' }),
    });
    expect(res.status).toBe(400);
  });

  it('serves the index page and blocks static path traversal', async () => {
    const { app } = makeApp();
    const page = await app.request('/');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('id="app"');

    const sneaky = await app.request('/static/..%2F..%2Fpackage.json');
    expect(sneaky.status).toBe(404);
  });

  it('serves the favicon the page asks for (NEWS-115)', async () => {
    // A favicon that 404s is invisible until someone looks at the tab, and the
    // link and the file are produced by different things — the page template and
    // the client build. This asserts they agree.
    const { app } = makeApp();
    const html = await (await app.request('/')).text();
    const href = /<link[^>]+rel="icon"[^>]+href="([^"]+)"/.exec(html)?.[1];
    expect(href, 'the page should reference a favicon').toBeDefined();

    const res = await app.request(href ?? '');
    expect(res.status, `${href ?? ''} should be served`).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(await res.text()).toContain('<svg');
  });

  it('healthz responds ok', async () => {
    const { app } = makeApp();
    const res = await app.request('/healthz');
    expect(((await json(res)) as { ok: boolean }).ok).toBe(true);
  });
});

describe('PATCH /api/topics/:id category (NEWS-97)', () => {
  async function patch(app: ReturnType<typeof makeApp>['app'], id: string, body: unknown): Promise<Response> {
    return app.request(`/api/topics/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('sets a category and marks it manual', async () => {
    const { app, store } = makeApp();
    const topic = store.addTopic('Premier League');

    const res = await patch(app, topic.id, { category: 'sports', subcategory: 'soccer' });
    expect(res.status).toBe(200);

    const updated = store.getTopic(topic.id);
    expect(updated?.category).toBe('sports');
    expect(updated?.subcategory).toBe('soccer');
    // The whole point of the field: a person chose this, so classification
    // must not overwrite it later.
    expect(updated?.categorySource).toBe('manual');
  });

  it('accepts a category with no subcategory', async () => {
    const { app, store } = makeApp();
    const topic = store.addTopic('Skiing');
    expect((await patch(app, topic.id, { category: 'sports' })).status).toBe(200);
    expect(store.getTopic(topic.id)?.subcategory).toBeNull();
  });

  it('clears the category and returns it to automatic', async () => {
    // Clearing has to reset the source too, or a cleared topic would be
    // permanently ineligible for classification — invisible and unfixable.
    const { app, store } = makeApp();
    const topic = store.addTopic('Ambiguous');
    await patch(app, topic.id, { category: 'sports', subcategory: 'soccer' });

    expect((await patch(app, topic.id, { category: null })).status).toBe(200);
    const updated = store.getTopic(topic.id);
    expect(updated?.category).toBeNull();
    expect(updated?.subcategory).toBeNull();
    expect(updated?.categorySource).toBe('auto');
  });

  it('drops the subcategory when the category changes', async () => {
    // Sports · Soccer reclassified to Culture must not keep "soccer" — it would
    // resolve to nothing and silently render as bare "Culture" anyway.
    const { app, store } = makeApp();
    const topic = store.addTopic('Moved');
    await patch(app, topic.id, { category: 'sports', subcategory: 'soccer' });
    await patch(app, topic.id, { category: 'culture' });
    expect(store.getTopic(topic.id)?.subcategory).toBeNull();
  });

  it('rejects a subcategory sent without its category', async () => {
    const { app, store } = makeApp();
    const topic = store.addTopic('Orphan Sub');
    expect((await patch(app, topic.id, { subcategory: 'soccer' })).status).toBe(400);
    expect(store.getTopic(topic.id)?.subcategory).toBeNull();
  });

  it('accepts a slug the taxonomy does not have', async () => {
    // Not an enum, deliberately (FR-22.3): the taxonomy is edited in code, and
    // an enum here would start rejecting requests the moment a slug is renamed.
    const { app, store } = makeApp();
    const topic = store.addTopic('Weather');
    expect((await patch(app, topic.id, { category: 'weather' })).status).toBe(200);
    expect(store.getTopic(topic.id)?.category).toBe('weather');
  });

  it('still 404s for a topic that does not exist', async () => {
    const { app } = makeApp();
    expect((await patch(app, 'nope', { category: 'sports' })).status).toBe(404);
  });

  it('leaves the other patchable fields alone', async () => {
    const { app, store } = makeApp();
    const topic = store.addTopic('Combined');
    await patch(app, topic.id, { paused: true, guidance: 'only finals' });
    await patch(app, topic.id, { category: 'sports' });

    const updated = store.getTopic(topic.id);
    expect(updated?.paused).toBe(true);
    expect(updated?.guidance).toBe('only finals');
    expect(updated?.category).toBe('sports');
  });
});
