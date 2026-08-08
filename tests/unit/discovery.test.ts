import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createMockProvider } from '../../src/ai/providers/index.js';
import type { SuggestRequest, SuggestResult } from '../../src/ai/types.js';
import { DiscoverRespSchema, DiscoverUsageRespSchema, MAX_TUNE_ROUNDS } from '../../src/api/schemas.js';
import { CheckRunner } from '../../src/checks.js';
import { TopicSchema } from '../../src/db/schemas.js';
import { DiscoveryService } from '../../src/discovery.js';
import { createApp } from '../../src/server.js';
import { asResolver, fakeProvider } from '../helpers/provider.js';
import { tmpStore } from '../helpers/tmp.js';

/**
 * The server half of topic discovery (NEWS-125, `docs/24-topic-discovery.md`).
 *
 * Everything goes through `createApp(...)` + `app.request(...)` — no real server.
 */

function makeApp(opts: { now?: () => number; ttlMs?: number } = {}) {
  const store = tmpStore();
  const service = createMockProvider();
  const runner = new CheckRunner(store, asResolver(service));
  const discovery = new DiscoveryService(store, asResolver(service), opts);
  const app = createApp({ store, runner, discovery });
  return { app, store, service, discovery };
}

/** Parse a discovery response with the same schema the client will use. */
async function body(res: Response): Promise<z.infer<typeof DiscoverRespSchema>> {
  return DiscoverRespSchema.parse((await res.json()) as unknown);
}

async function usage(res: Response): Promise<z.infer<typeof DiscoverUsageRespSchema>> {
  return DiscoverUsageRespSchema.parse((await res.json()) as unknown);
}

async function errorOf(res: Response): Promise<string> {
  const parsed = z.object({ error: z.string() }).parse((await res.json()) as unknown);
  return parsed.error;
}

async function post(app: ReturnType<typeof makeApp>['app'], body: unknown): Promise<Response> {
  return app.request('/api/discover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const DESCRIBE = { scope: { kind: 'describe', query: 'motorsport' } };

describe('POST /api/discover — the three entry shapes', () => {
  it('accepts a free-text query, including an empty one', async () => {
    const { app } = makeApp();
    expect((await post(app, DESCRIBE)).status).toBe(200);
    // "Surprise me" is a real request, not a malformed one (FR-24.3).
    const res = await post(app, { scope: { kind: 'describe', query: '' } });
    expect(res.status).toBe(200);
    expect((await body(res)).suggestions.length).toBeGreaterThan(0);
  });

  it('accepts a section, with or without a subcategory', async () => {
    const { app } = makeApp();
    expect((await post(app, { scope: { kind: 'section', category: 'sports', subcategory: 'motorsport' } })).status).toBe(200);
    expect((await post(app, { scope: { kind: 'section', category: 'sports', subcategory: null } })).status).toBe(200);
  });

  it('accepts a tuner round', async () => {
    const { app } = makeApp();
    const res = await post(app, {
      scope: { kind: 'tune', anchor: 'Formula 1', direction: 'narrower', kept: ['F1 tech'], skipped: [], round: 2 },
    });
    expect(res.status).toBe(200);
  });

  it('rejects a malformed or mixed-up scope rather than half-honouring it', async () => {
    const { app } = makeApp();
    // A tuner round with no anchor, and a section with no category: both are
    // requests the model would be asked to guess at.
    expect((await post(app, { scope: { kind: 'tune', direction: 'narrower', round: 1 } })).status).toBe(400);
    expect((await post(app, { scope: { kind: 'section', subcategory: 'motorsport' } })).status).toBe(400);
    expect((await post(app, { scope: { kind: 'nonsense' } })).status).toBe(400);
    expect((await post(app, {})).status).toBe(400);
  });
});

describe('the tuner round bound (FR-24.9)', () => {
  it('rejects a round past the ceiling, so a client cannot bill indefinitely', async () => {
    const { app, service } = makeApp();
    const round = (n: number): Promise<Response> =>
      post(app, {
        scope: { kind: 'tune', anchor: 'Formula 1', direction: 'similar', kept: [], skipped: [], round: n },
      });

    expect((await round(MAX_TUNE_ROUNDS)).status).toBe(200);
    expect((await round(MAX_TUNE_ROUNDS + 1)).status).toBe(400);
    expect((await round(0)).status).toBe(400);

    // The rejected rounds must not have reached the provider — a 400 that still
    // spent money would defeat the point of the bound.
    expect(service.suggestCalls.every((c) => c.scope.kind === 'tune' && c.scope.round <= MAX_TUNE_ROUNDS)).toBe(true);
  });
});

describe('exclusions (FR-24.11)', () => {
  it('layer 1: the server fills in existing topic names, so the client cannot forget', async () => {
    const { app, store, service } = makeApp();
    store.addTopic('Formula 1');
    store.addTopic('Pro cycling');

    await post(app, DESCRIBE);

    expect(service.suggestCalls[0].exclude.sort()).toEqual(['Formula 1', 'Pro cycling']);
  });

  it('layer 2: a suggestion the model returned anyway is filtered out', async () => {
    const { app, store } = makeApp();
    store.addTopic('Formula 1');

    // The mock deliberately suggests the first excluded name (NEWS-124), which
    // is exactly the model-ignored-the-exclusions case this layer exists for.
    const { suggestions } = await body(await post(app, DESCRIBE));

    expect(suggestions.some((s) => s.name === 'Formula 1')).toBe(false);
    expect(suggestions.length).toBeGreaterThan(0);
  });

  it('matches on the normalized name, not the exact string', async () => {
    const { store } = makeApp();
    store.addTopic('Formula 1');
    const provider = fakeProvider(() => Promise.reject(new Error('unused')), {
      suggestTopics: () =>
        Promise.resolve({
          suggestions: [
            { name: 'formula-1!', reason: 'r', kind: 'evergreen' as const, guidance: '', classification: null },
            { name: 'MotoGP', reason: 'r', kind: 'ongoing' as const, guidance: '', classification: null },
          ],
          usage: null,
        } satisfies SuggestResult),
    });
    const service = new DiscoveryService(store, () => Promise.resolve(provider));

    const { suggestions } = await service.suggest({ kind: 'describe', query: 'x' });

    expect(suggestions.map((s) => s.name)).toEqual(['MotoGP']);
  });

  it('drops a name the model repeated within one batch', async () => {
    const { store } = makeApp();
    const dup = { reason: 'r', kind: 'evergreen' as const, guidance: '', classification: null };
    const provider = fakeProvider(() => Promise.reject(new Error('unused')), {
      suggestTopics: () =>
        Promise.resolve({
          suggestions: [
            { name: 'Formula 1', ...dup },
            { name: 'Formula 1', ...dup },
          ],
          usage: null,
        }),
    });
    const service = new DiscoveryService(store, () => Promise.resolve(provider));

    expect((await service.suggest({ kind: 'describe', query: 'x' })).suggestions).toHaveLength(1);
  });
});

describe('classification validation (FR-24.13)', () => {
  const withClassification = (category: string | null, subcategory: string | null) =>
    fakeProvider(() => Promise.reject(new Error('unused')), {
      suggestTopics: () =>
        Promise.resolve({
          suggestions: [
            {
              name: 'Formula 1',
              reason: 'r',
              kind: 'evergreen' as const,
              guidance: '',
              classification: category === null ? null : { category, subcategory },
            },
          ],
          usage: null,
        }),
    });

  const classify = async (category: string | null, subcategory: string | null) => {
    const store = tmpStore();
    const service = new DiscoveryService(store, () => Promise.resolve(withClassification(category, subcategory)));
    const { suggestions } = await service.suggest({ kind: 'describe', query: 'x' });
    return suggestions[0].classification;
  };

  it('keeps a classification the taxonomy resolves', async () => {
    expect(await classify('sports', 'motorsport')).toEqual({ category: 'sports', subcategory: 'motorsport' });
  });

  it('drops a category the taxonomy does not have', async () => {
    // The model can return anything; storing it would produce a topic filed
    // under a section that doesn't exist.
    expect(await classify('not-a-real-category', null)).toBeNull();
  });

  it('drops only the subcategory when the category is good', async () => {
    // Sports with no subcategory is a valid answer (FR-22.6), so a bad sub is
    // not a reason to throw away a usable category.
    expect(await classify('sports', 'quidditch')).toEqual({ category: 'sports', subcategory: null });
  });

  it('drops a subcategory belonging to a different category', async () => {
    expect(await classify('sports', 'ai')).toEqual({ category: 'sports', subcategory: null });
  });
});

describe('the cache (FR-24.15)', () => {
  it('serves a repeat request without calling the provider again', async () => {
    const { app, service } = makeApp();

    const first = await body(await post(app, DESCRIBE));
    const second = await body(await post(app, DESCRIBE));

    expect(service.suggestCalls).toHaveLength(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.suggestions).toEqual(first.suggestions);
  });

  it('does not confuse two different requests', async () => {
    const { app, service } = makeApp();
    await post(app, DESCRIBE);
    await post(app, { scope: { kind: 'describe', query: 'cycling' } });
    await post(app, { scope: { kind: 'section', category: 'sports', subcategory: null } });
    expect(service.suggestCalls).toHaveLength(3);
  });

  it('re-asks once the entry has expired', async () => {
    let clock = 1_000_000;
    const { app, service } = makeApp({ now: () => clock, ttlMs: 60_000 });

    await post(app, DESCRIBE);
    clock += 59_000;
    await post(app, DESCRIBE);
    expect(service.suggestCalls).toHaveLength(1);

    clock += 2_000;
    await post(app, DESCRIBE);
    expect(service.suggestCalls).toHaveLength(2);
  });

  it('is invalidated by adding a topic, because the valid answer changed', async () => {
    // The cached answer was computed against a different exclusion set. Serving
    // it after the user adds a topic can suggest the topic they just added,
    // which is the one thing FR-24.11 exists to prevent.
    const { app, store, service } = makeApp();

    await post(app, DESCRIBE);
    store.addTopic('Formula 1');
    await post(app, DESCRIBE);

    expect(service.suggestCalls).toHaveLength(2);
  });

  // NEWS-258. The key covered the *request* and not who was asked, so a repeat
  // query after switching provider answered with the previous provider's ideas
  // — long after every other part of the app had moved on.
  it('is invalidated by a provider change, because suggestions are the model\'s answer', async () => {
    const { app, store, service } = makeApp();

    await post(app, DESCRIBE);
    store.updateSettings({ provider: 'openai' });
    await post(app, DESCRIBE);

    expect(service.suggestCalls).toHaveLength(2);
  });

  it('is invalidated by a model change, and by an effort change', async () => {
    const { app, store, service } = makeApp();

    await post(app, DESCRIBE);
    store.updateSettings({ model: 'gpt-5.4-mini' });
    await post(app, DESCRIBE);
    expect(service.suggestCalls).toHaveLength(2);

    store.updateSettings({ effort: 'high' });
    await post(app, DESCRIBE);
    expect(service.suggestCalls).toHaveLength(3);
  });

  // Keyed, not cleared: the reason to key it is that switching back does not pay
  // for the same answer twice.
  it('still has the earlier answer after switching back', async () => {
    const { app, store, service } = makeApp();

    const first = await body(await post(app, DESCRIBE));
    store.updateSettings({ provider: 'openai' });
    await post(app, DESCRIBE);
    store.updateSettings({ provider: 'auto' }); // back to the default it started on
    const back = await body(await post(app, DESCRIBE));

    expect(service.suggestCalls).toHaveLength(2);
    expect(back.cached).toBe(true);
    expect(back.suggestions).toEqual(first.suggestions);
  });
});

describe('cost recording (FR-24.14)', () => {
  it('records every call, and marks the free ones as cached', async () => {
    const { app } = makeApp();
    await post(app, DESCRIBE);
    await post(app, DESCRIBE);

    const log = await usage(await app.request('/api/discover/usage'));

    expect(log.calls).toBe(2);
    expect(log.recent).toHaveLength(2);
    // Newest first, so the cache hit leads.
    expect(log.recent[0].cached).toBe(true);
    expect(log.recent[1].cached).toBe(false);
    expect(log.recent[1].provider).toBe('mock');
    expect(log.recent[1].scope).toBe('describe');
  });

  it('records a failed call too, with the reason', async () => {
    const { app, discovery } = makeApp();
    // The mock throws on a seed containing "fail" (NEWS-124).
    const res = await post(app, { scope: { kind: 'describe', query: 'fail please' } });

    expect(res.status).toBe(502);
    const [latest] = discovery.recentCalls();
    expect(latest.status).toBe('failed');
    expect(latest.error).toMatch(/mock suggestion failure/);
  });

  it('records a provider that could not be resolved at all', async () => {
    const store = tmpStore();
    const service = new DiscoveryService(store, () => Promise.reject(new Error('No API key is configured')));

    await expect(service.suggest({ kind: 'describe', query: 'x' })).rejects.toThrow(/No API key/);

    const [latest] = service.recentCalls();
    expect(latest.status).toBe('failed');
    expect(latest.provider).toBeNull();
  });
});

describe('when discovery is not wired up', () => {
  it('says so rather than crashing', async () => {
    const store = tmpStore();
    const runner = new CheckRunner(store, asResolver(createMockProvider()));
    const app = createApp({ store, runner });

    expect((await post(app, DESCRIBE)).status).toBe(503);
    expect((await usage(await app.request('/api/discover/usage'))).calls).toBe(0);
  });
});

describe('a failing provider', () => {
  it('is a 502 with the provider’s own message, not a 500', async () => {
    const { app } = makeApp();
    const res = await post(app, { scope: { kind: 'describe', query: 'fail' } });
    expect(res.status).toBe(502);
    // Offline, no key, rate limited — ordinary outcomes the user must be able
    // to read, not an internal fault.
    expect(await errorOf(res)).toMatch(/mock suggestion failure/);
  });
});

describe('the request the provider actually receives', () => {
  it('carries the taxonomy so suggestions come back pre-classified', async () => {
    const { app, service } = makeApp();
    await post(app, DESCRIBE);
    const request: SuggestRequest = service.suggestCalls[0];
    expect(request.categoryOptions?.length).toBeGreaterThan(0);
    expect(request.categoryOptions?.some((c) => c.slug === 'sports')).toBe(true);
  });

  it('clamps an over-large limit', async () => {
    const { app, service } = makeApp();
    await post(app, { ...DESCRIBE, limit: 50 });
    expect(service.suggestCalls[0].limit).toBeLessThanOrEqual(12);
  });
});

describe('creating a topic from a suggestion (FR-24.12 / FR-24.13)', () => {
  it('stores the guidance and classification in the same request as the name', async () => {
    // Not a follow-up PATCH: creating a topic fires its first check immediately
    // (FR-1.12), so a second request would land after that check had already
    // run unsteered — which is the whole thing the guidance exists to prevent.
    const { app, store } = makeApp();

    const res = await app.request('/api/topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Formula 1',
        guidance: 'Race results and team news, not driver gossip.',
        category: 'sports',
        subcategory: 'motorsport',
      }),
    });

    expect(res.status).toBe(201);
    const [topic] = store.listTopics();
    expect(topic.name).toBe('Formula 1');
    expect(topic.guidance).toBe('Race results and team news, not driver gossip.');
    expect(topic.category).toBe('sports');
    expect(topic.subcategory).toBe('motorsport');
    // `auto`, not `manual`: the classification came from the model, so a later
    // manual change must still win (FR-22.7).
    expect(topic.categorySource).toBe('auto');
  });

  it('still accepts a bare name, unchanged', async () => {
    // Asserted on the creation response, not on the store: creating a topic
    // fires its first check (FR-1.12), and that check classifies an unlabelled
    // topic — so a later store read races with it.
    const { app } = makeApp();
    const res = await app.request('/api/topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Plain topic' }),
    });
    expect(res.status).toBe(201);
    const created = TopicSchema.parse((await res.json()) as unknown);
    expect(created.guidance).toBe('');
    expect(created.category).toBeNull();
  });

  it('ignores a subcategory sent without its category', async () => {
    // Storing it would look like a classification while rendering as none.
    const { app } = makeApp();
    const res = await app.request('/api/topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Orphaned', subcategory: 'motorsport' }),
    });
    const created = TopicSchema.parse((await res.json()) as unknown);
    expect(created.subcategory).toBeNull();
    expect(created.category).toBeNull();
  });
});
