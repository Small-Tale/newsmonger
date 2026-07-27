import { writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { builtinTable } from '../../src/ai/price-store.js';
import { BUILTIN_PRICES, estimateCostUsd, formatUsd, hasPrice } from '../../src/ai/pricing.js';
import { createMockProvider } from '../../src/ai/providers/index.js';
import type { TokenUsage } from '../../src/ai/types.js';
import { StateRespSchema } from '../../src/api/schemas.js';
import { CheckRunner, isOverBudget } from '../../src/checks.js';
import { Store } from '../../src/db/store.js';
import { createApp } from '../../src/server.js';
import { asResolver } from '../helpers/provider.js';
import { tmpDataDir } from '../helpers/tmp.js';

/** The shipped defaults, as the live table would be on a fresh install. */
const PRICES = builtinTable().models;

const USAGE: TokenUsage = {
  inputTokens: 1_000_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 1_000_000,
  webSearches: 1000,
};

describe('estimateCostUsd (NEWS-79)', () => {
  it('prices tokens and searches against the published rates', () => {
    // Opus 4.8: $5/MTok in, $25/MTok out, $10 per 1,000 searches.
    expect(estimateCostUsd('claude-opus-4-8', USAGE, PRICES)).toBeCloseTo(5 + 25 + 10, 6);
  });

  it('prices cache reads at a tenth of input and writes at 1.25×', () => {
    const cost = estimateCostUsd(
      'claude-opus-4-8',
      {
        inputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
        outputTokens: 0,
        webSearches: 0,
      },
      PRICES,
    );
    expect(cost).toBeCloseTo(0.5 + 6.25, 6);
  });

  it('returns null — not zero — when the provider reported no usage', () => {
    // The distinction the whole feature rests on: a subscription check spends
    // plan quota, and calling that $0.00 would be a lie in the user's favour.
    expect(estimateCostUsd('claude-opus-4-8', null, PRICES)).toBeNull();
  });

  it('returns null for a model with no published price', () => {
    expect(hasPrice('gpt-5', PRICES)).toBe(false);
    expect(estimateCostUsd('gpt-5', USAGE, PRICES)).toBeNull();
    expect(estimateCostUsd('', USAGE, PRICES)).toBeNull();
  });

  it('prices a realistic single check in cents, not dollars', () => {
    // ~30k in / 3k out / 8 searches — the shape of one Anthropic check.
    const cost = estimateCostUsd(
      'claude-opus-4-8',
      {
        inputTokens: 30_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 3_000,
        webSearches: 8,
      },
      PRICES,
    );
    expect(cost).toBeCloseTo(0.15 + 0.075 + 0.08, 6);
  });

  it('keeps every price table entry internally consistent', () => {
    for (const [model, price] of Object.entries(BUILTIN_PRICES)) {
      expect(price, model).toBeDefined();
      if (price === undefined) continue;
      expect(price.cacheReadPerMTok, model).toBeLessThan(price.inputPerMTok);
      expect(price.outputPerMTok, model).toBeGreaterThan(price.inputPerMTok);
    }
  });
});

describe('formatUsd', () => {
  it('never renders a nonzero cost as $0.00', () => {
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(1.239)).toBe('$1.24');
  });
});

describe('run records carry usage (NEWS-79)', () => {
  function makeRunner(usage?: TokenUsage | null) {
    const store = new Store(tmpDataDir());
    const service = createMockProvider(usage === undefined ? {} : { usage });
    return { store, runner: new CheckRunner(store, asResolver(service)) };
  }

  it('records the model and usage the provider reported', async () => {
    const { store, runner } = makeRunner();
    const topic = store.addTopic('Fusion');
    await runner.checkTopic(topic.id);

    const [run] = store.listRuns(5);
    expect(run.status).toBe('succeeded');
    expect(run.model).toBe('mock');
    expect(run.usage?.webSearches).toBe(2);
  });

  it('records null usage rather than zeros when the provider reports nothing', async () => {
    const { store, runner } = makeRunner(null);
    const topic = store.addTopic('Fusion');
    await runner.checkTopic(topic.id);
    expect(store.listRuns(5)[0].usage).toBeNull();
  });

  it('still records the model on a failed check, so the failure is attributable', async () => {
    const { store, runner } = makeRunner();
    const topic = store.addTopic('fail me');
    await runner.checkTopic(topic.id);

    const [run] = store.listRuns(5);
    expect(run.status).toBe('failed');
    expect(run.model).toBe('mock');
    expect(run.usage).toBeNull();
  });

  it('survives a reload — usage is persisted, not in-memory', async () => {
    const { store, runner } = makeRunner();
    const topic = store.addTopic('Fusion');
    await runner.checkTopic(topic.id);
    expect(new Store(store.dataDir).listRuns(5)[0].usage?.outputTokens).toBe(500);
  });

  it('loads a pre-NEWS-79 run record that has no usage or model field', () => {
    // Written as a legacy `data.json`, which the SQLite store imports on first
    // open (NEWS-94) — so this now covers the real path such a record arrives
    // by, rather than round-tripping through a file the store no longer writes.
    const dir = tmpDataDir();
    writeFileSync(
      `${dir}/data.json`,
      JSON.stringify({
        topics: [
          {
            id: 't1',
            name: 'Fusion',
            paused: false,
            createdAt: '2026-07-01T00:00:00.000Z',
            lastCheckedAt: null,
          },
        ],
        items: [],
        settings: { checkIntervalMs: 86_400_000 },
        runs: [
          {
            id: 'r1',
            topicId: 't1',
            startedAt: '2026-07-01T00:00:00.000Z',
            finishedAt: null,
            status: 'running',
            newItems: 0,
            error: null,
          },
        ],
      }),
    );

    const store = new Store(dir);
    expect(store.listRuns(5)).toHaveLength(1);
    expect(store.listRuns(5)[0].usage).toBeNull();
    expect(store.listRuns(5)[0].model).toBeNull();
  });
});

describe('Store.spendSince (NEWS-79)', () => {
  it('sums priced runs and counts the unpriced ones separately', async () => {
    const store = new Store(tmpDataDir());
    const priced = new CheckRunner(store, asResolver(createMockProvider()));
    const unpriced = new CheckRunner(store, asResolver(createMockProvider({ usage: null })));
    const a = store.addTopic('A');
    const b = store.addTopic('B');

    await priced.checkTopic(a.id);
    await unpriced.checkTopic(b.id);

    const spend = store.spendSince('1970-01-01T00:00:00Z');
    // The mock's model ('mock') has no published price, so nothing is priceable
    // — which is itself the point: an unknown model must not be counted as free.
    expect(spend.pricedRuns).toBe(0);
    expect(spend.unpricedRuns).toBe(2);
    expect(spend.usd).toBe(0);
  });

  it('ignores runs that started before the window', async () => {
    const store = new Store(tmpDataDir());
    const runner = new CheckRunner(store, asResolver(createMockProvider()));
    await runner.checkTopic(store.addTopic('A').id);

    const future = new Date(Date.now() + 60_000).toISOString();
    expect(store.spendSince(future)).toEqual({ usd: 0, pricedRuns: 0, unpricedRuns: 0 });
  });

  it('ignores in-flight runs, which have consumed nothing yet', () => {
    const store = new Store(tmpDataDir());
    store.startRun(store.addTopic('A').id);
    expect(store.spendSince('1970-01-01T00:00:00Z').unpricedRuns).toBe(0);
  });
});

describe('the budget cap (NEWS-79)', () => {
  it('is off at 0, however much has been spent', () => {
    expect(isOverBudget({ usd: 999 }, { monthlyBudgetUsd: 0 })).toBe(false);
  });

  it('trips on reaching the cap, not only on exceeding it', () => {
    expect(isOverBudget({ usd: 4.99 }, { monthlyBudgetUsd: 5 })).toBe(false);
    expect(isOverBudget({ usd: 5 }, { monthlyBudgetUsd: 5 })).toBe(true);
    expect(isOverBudget({ usd: 5.01 }, { monthlyBudgetUsd: 5 })).toBe(true);
  });

  it('pauses a scheduled sweep once the cap is reached', async () => {
    const store = new Store(tmpDataDir());
    const service = createMockProvider();
    const runner = new CheckRunner(store, asResolver(service));
    store.addTopic('Fusion');

    // A due topic runs normally...
    expect(await runner.checkDue(new Date())).toBe(1);
    const callsBefore = service.calls.length;

    // ...but not once spend has crossed the cap. Forced by fiat here — the
    // mock's model has no price, so real spend can't be accumulated; the gate
    // itself is what this asserts.
    store.updateSettings({ monthlyBudgetUsd: 1 });
    stubSpend(store, 2);
    expect(await runner.checkDue(new Date(Date.now() + 10 * 24 * 3600_000))).toBe(0);
    expect(service.calls).toHaveLength(callsBefore);
  });

  it('never gates a manual check — a capped month must not lock the user out', async () => {
    const store = new Store(tmpDataDir());
    const service = createMockProvider();
    const runner = new CheckRunner(store, asResolver(service));
    const topic = store.addTopic('Fusion');
    store.updateSettings({ monthlyBudgetUsd: 1 });
    stubSpend(store, 99);

    expect(await runner.checkTopic(topic.id, { manual: true })).toBe(2);
    const callsAfterManual = service.calls.length;
    // checkAll returns void; the proof it ran is that the provider was asked.
    await runner.checkAll();
    expect(service.calls.length).toBeGreaterThan(callsAfterManual);
  });
});

/** Force `spendThisMonth` to a fixed figure, so gate tests don't need real prices. */
function stubSpend(store: Store, usd: number): void {
  store.spendThisMonth = () => ({ usd, pricedRuns: 1, unpricedRuns: 0 });
}

describe('/api/state spend block (NEWS-79)', () => {
  function makeApp() {
    const store = new Store(tmpDataDir());
    const runner = new CheckRunner(store, asResolver(createMockProvider()));
    return { app: createApp({ store, runner }), store };
  }

  it('reports zero spend, no cap, and a verification date on a fresh install', async () => {
    const { app } = makeApp();
    const state = StateRespSchema.parse(await (await app.request('/api/state')).json());
    expect(state.spend.usd).toBe(0);
    expect(state.spend.monthlyBudgetUsd).toBe(0);
    expect(state.spend.overBudget).toBe(false);
    expect(state.spend.pricesVerifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('echoes the cap and flags the over-budget state', async () => {
    const { app, store } = makeApp();
    store.updateSettings({ monthlyBudgetUsd: 5 });
    stubSpend(store, 6);

    const state = StateRespSchema.parse(await (await app.request('/api/state')).json());
    expect(state.spend.monthlyBudgetUsd).toBe(5);
    expect(state.spend.overBudget).toBe(true);
  });

  it('accepts a budget through PATCH /api/settings and rejects a negative one', async () => {
    const { app, store } = makeApp();
    const patch = async (body: unknown) =>
      app.request('/api/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    expect((await patch({ monthlyBudgetUsd: 25 })).status).toBe(200);
    expect(store.getSettings().monthlyBudgetUsd).toBe(25);
    expect((await patch({ monthlyBudgetUsd: -1 })).status).toBe(400);
    expect(store.getSettings().monthlyBudgetUsd).toBe(25);
  });
});
