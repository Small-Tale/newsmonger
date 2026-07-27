import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StateResp } from '../../src/api/schemas.js';
import { refreshFeed, refreshState } from '../../src/client/api.js';
import { appStore } from '../../src/client/stores.js';

// Out-of-order refresh responses (NEWS-104).
//
// Refreshes run concurrently by design — a 4-second poll plus one after every
// mutation — and the store used to apply whichever response *resolved* last,
// which is not the one *issued* last. Change a setting while a poll is already
// in flight and the poll's pre-change answer lands second and rewrites the
// control, for up to 4 seconds.
//
// This is the level the bug can actually be pinned at. It surfaced as an E2E
// flake, but E2E cannot schedule the interleaving: 288 repeat-each executions of
// the spec that flaked never reproduced it. Here the ordering is chosen, so the
// test fails deterministically without the guard rather than once in a hundred
// runs with it.

const BASE_SETTINGS: StateResp['settings'] = {
  checkIntervalMs: 86_400_000,
  highPriorityIntervalMs: 86_400_000,
  provider: 'auto',
  model: '',
  endpoint: '',
  notifyOnNewItems: false,
  monthlyBudgetUsd: 0,
  itemRetentionDays: 365,
  scheduleMode: 'interval',
  dailyTimes: ['08:00'],
  checkConcurrency: 3,
  priceManifestUrl: '',
};

function stateBody(checkIntervalMs: number, topicNames: string[] = []): unknown {
  return {
    topics: topicNames.map((name, i) => ({
      id: `t${String(i)}`,
      name,
      paused: false,
      highPriority: false,
      guidance: '',
      createdAt: '2026-07-01T00:00:00.000Z',
      lastCheckedAt: null,
      coveredThroughAt: null,
    })),
    latestItemIds: [],
    flaggedByTopic: {},
    settings: { ...BASE_SETTINGS, checkIntervalMs },
    runs: [],
    checking: [],
    spend: {
      usd: 0,
      pricedRuns: 0,
      unpricedRuns: 0,
      monthlyBudgetUsd: 0,
      overBudget: false,
      pricesVerifiedOn: '2026-07-27',
    },
    appVersion: '',
    prices: {},
  };
}

function feedBody(titles: string[]): unknown {
  return {
    items: titles.map((title, i) => ({
      id: `i${String(i)}`,
      topicId: 't0',
      title,
      summary: 's',
      saved: false,
      offTopic: false,
      sources: [],
      image: null,
      dedupeKey: `k${String(i)}`,
      foundAt: '2026-07-02T00:00:00.000Z',
    })),
    nextCursor: null,
    total: titles.length,
  };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

/** A fetch stub that hands out a manually-resolved promise per matching call. */
function deferredFetch(match: (url: string) => boolean, immediate: (url: string) => unknown) {
  const resolvers: ((body: unknown) => void)[] = [];
  const impl = ((input: string): Promise<Response> => {
    if (match(input)) {
      return new Promise<Response>((resolve) => {
        resolvers.push((body) => {
          resolve(jsonResponse(body));
        });
      });
    }
    return Promise.resolve(jsonResponse(immediate(input)));
  }) as unknown as typeof fetch;
  return { impl, resolvers };
}

describe('concurrent refreshes apply in issue order, not arrival order (NEWS-104)', () => {
  beforeEach(() => {
    appStore.actions.setError(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a slow poll issued first cannot overwrite a newer state response', async () => {
    const { impl, resolvers } = deferredFetch(
      (url) => url.startsWith('/api/state'),
      () => feedBody([]),
    );
    vi.stubGlobal('fetch', impl);

    // Both requests are in flight: the poll, then the refresh a settings PATCH
    // triggers. Two fetches are issued synchronously, so the order is fixed.
    const poll = refreshState();
    const afterPatch = refreshState();
    expect(resolvers).toHaveLength(2);

    // The newer one answers first with the post-change value...
    resolvers[1](stateBody(3_600_000));
    await afterPatch;
    expect(appStore.state.value.settings.checkIntervalMs).toBe(3_600_000);

    // ...and the older, slower one answers second with the stale value. Before
    // the guard this is the assertion that failed: last-to-arrive won.
    resolvers[0](stateBody(86_400_000));
    await poll;
    expect(appStore.state.value.settings.checkIntervalMs).toBe(3_600_000);
  });

  it('the stale response is dropped whole, not merged field by field', async () => {
    // A partial application would be worse than either version: the guard has to
    // discard the entire response, not reconcile it.
    const { impl, resolvers } = deferredFetch(
      (url) => url.startsWith('/api/state'),
      () => feedBody([]),
    );
    vi.stubGlobal('fetch', impl);

    const stale = refreshState();
    const fresh = refreshState();

    resolvers[1](stateBody(3_600_000, ['Newer Topic']));
    await fresh;
    resolvers[0](stateBody(86_400_000, ['Older Topic', 'Also Older']));
    await stale;

    expect(appStore.state.value.settings.checkIntervalMs).toBe(3_600_000);
    expect(appStore.state.value.topics.map((t) => t.name)).toEqual(['Newer Topic']);
  });

  it('a stale failure cannot raise a banner over a newer success', async () => {
    // The error path needs the same guard: an error from a request the user has
    // already superseded is not news, and it would sit there until the next poll.
    const { impl, resolvers } = deferredFetch(
      (url) => url.startsWith('/api/state'),
      () => feedBody([]),
    );
    vi.stubGlobal('fetch', impl);

    const stale = refreshState();
    const fresh = refreshState();

    resolvers[1](stateBody(3_600_000));
    await fresh;
    expect(appStore.state.value.error).toBeNull();

    // The older request answers with something unparseable.
    resolvers[0]({ nonsense: true });
    await stale;
    expect(appStore.state.value.error).toBeNull();
    expect(appStore.state.value.settings.checkIntervalMs).toBe(3_600_000);
  });

  it('responses arriving in order still apply, so the guard is not simply blocking', async () => {
    // The failure mode of an over-eager guard: nothing updates at all.
    const { impl, resolvers } = deferredFetch(
      (url) => url.startsWith('/api/state'),
      () => feedBody([]),
    );
    vi.stubGlobal('fetch', impl);

    const first = refreshState();
    const second = refreshState();

    resolvers[0](stateBody(3_600_000));
    await first;
    expect(appStore.state.value.settings.checkIntervalMs).toBe(3_600_000);

    resolvers[1](stateBody(7_200_000));
    await second;
    expect(appStore.state.value.settings.checkIntervalMs).toBe(7_200_000);
  });

  it('a stale feed page cannot repopulate rows the current filters exclude', async () => {
    // Worse here than for settings: the query is built from the live view, so a
    // response for the *previous* search term would restore excluded rows.
    const { impl, resolvers } = deferredFetch(
      (url) => url.startsWith('/api/items'),
      () => stateBody(86_400_000),
    );
    vi.stubGlobal('fetch', impl);

    const stale = refreshFeed();
    const fresh = refreshFeed();

    resolvers[1](feedBody(['Matches the new search']));
    await fresh;
    resolvers[0](feedBody(['Belongs to the old search', 'And another']));
    await stale;

    expect(appStore.state.value.feedItems.map((i) => i.title)).toEqual(['Matches the new search']);
    expect(appStore.state.value.feedTotal).toBe(1);
  });
});
