import { describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/index.js';
import { ProvidersRespSchema, StateRespSchema } from '../../src/api/schemas.js';
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

  it('full flow: add topic, check, items appear, second check dedupes', async () => {
    const { app, store } = makeApp();
    await app.request('/api/topics', { method: 'POST', body: JSON.stringify({ name: 'Fusion' }) });
    const topicId = store.listTopics()[0]?.id ?? '';

    const check = await app.request('/api/check', { method: 'POST', body: JSON.stringify({ topicId }) });
    expect(check.status).toBe(200);
    await waitForIdle(app);

    let state = StateRespSchema.parse(await json(await app.request('/api/state')));
    expect(state.items).toHaveLength(2);
    expect(state.runs[0]?.status).toBe('succeeded');
    expect(state.topics[0]?.lastCheckedAt).not.toBeNull();

    await app.request('/api/check', { method: 'POST', body: JSON.stringify({ topicId }) });
    await waitForIdle(app);
    state = StateRespSchema.parse(await json(await app.request('/api/state')));
    expect(state.items).toHaveLength(2);
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

  it('updates provider settings and reflects searchesWeb in state', async () => {
    const { app, store } = makeApp();
    let res = await app.request('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ provider: 'ollama', model: 'llama3.2', endpoint: 'http://h/v1' }),
    });
    expect(res.status).toBe(200);
    expect(store.getSettings().provider).toBe('ollama');
    expect(store.getSettings().model).toBe('llama3.2');

    let state = StateRespSchema.parse(await json(await app.request('/api/state')));
    expect(state.searchesWeb).toBe(false); // ollama doesn't search the web

    res = await app.request('/api/settings', { method: 'PATCH', body: JSON.stringify({ provider: 'anthropic' }) });
    expect(res.status).toBe(200);
    state = StateRespSchema.parse(await json(await app.request('/api/state')));
    expect(state.searchesWeb).toBe(true);
  });

  it('a configured search provider makes a local provider count as web-searching (grounded)', async () => {
    const { app } = makeApp();
    await app.request('/api/settings', { method: 'PATCH', body: JSON.stringify({ provider: 'ollama' }) });
    let state = StateRespSchema.parse(await json(await app.request('/api/state')));
    expect(state.searchesWeb).toBe(false); // ollama alone: not live

    await app.request('/api/settings', { method: 'PATCH', body: JSON.stringify({ searchProvider: 'tavily' }) });
    state = StateRespSchema.parse(await json(await app.request('/api/state')));
    expect(state.searchesWeb).toBe(true); // grounded on live search → effectively live
  });

  it('rejects an invalid provider and an empty settings patch', async () => {
    const { app } = makeApp();
    expect((await app.request('/api/settings', { method: 'PATCH', body: JSON.stringify({ provider: 'grok' }) })).status).toBe(400);
    expect((await app.request('/api/settings', { method: 'PATCH', body: JSON.stringify({}) })).status).toBe(400);
  });

  it('lists providers with capability + availability', async () => {
    const { app } = makeApp();
    const resp = ProvidersRespSchema.parse(await json(await app.request('/api/providers')));
    const byName = new Map(resp.providers.map((p) => [p.name, p]));
    expect(byName.get('auto')?.available).toBeNull();
    expect(byName.get('anthropic')?.searchesWeb).toBe(true);
    expect(byName.get('ollama')?.searchesWeb).toBe(false);
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
    expect(state.items).toEqual([]);
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

  it('healthz responds ok', async () => {
    const { app } = makeApp();
    const res = await app.request('/healthz');
    expect(((await json(res)) as { ok: boolean }).ok).toBe(true);
  });
});
