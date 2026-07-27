import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { PriceTable } from '../../src/ai/price-schema.js';
import { builtinTable, PRICES_FILENAME, PriceStore, refreshPricesFromManifest } from '../../src/ai/price-store.js';
import { estimateCostUsd } from '../../src/ai/pricing.js';
import type { TokenUsage } from '../../src/ai/types.js';
import { Store } from '../../src/db/store.js';
import { tmpDataDir } from '../helpers/tmp.js';

const USAGE: TokenUsage = {
  inputTokens: 1_000_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  webSearches: 0,
};

function table(models: PriceTable['models'], verifiedOn = '2030-01-01'): PriceTable {
  return { verifiedOn, sources: ['https://example.test/prices'], models };
}

const CHEAP = { inputPerMTok: 1, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25, outputPerMTok: 5, perThousandSearches: 0 };

describe('PriceStore (NEWS-93)', () => {
  it('seeds prices.json from the built-ins on first run', () => {
    const dir = tmpDataDir();
    const store = new PriceStore(dir);
    const file = path.join(dir, PRICES_FILENAME);
    expect(fs.existsSync(file)).toBe(true);
    // Something concrete for the user to open and edit, rather than a format
    // they'd have to invent.
    expect(store.table().models['claude-opus-4-8'].inputPerMTok).toBe(5);
  });

  it('picks up a hand edit without a restart', () => {
    // The whole point of the ticket: a rate change must not need a new build.
    const dir = tmpDataDir();
    const store = new PriceStore(dir);
    expect(store.table().models['claude-opus-4-8'].inputPerMTok).toBe(5);

    fs.writeFileSync(
      path.join(dir, PRICES_FILENAME),
      JSON.stringify(table({ 'claude-opus-4-8': { ...CHEAP, inputPerMTok: 42 } })),
    );
    expect(store.table().models['claude-opus-4-8'].inputPerMTok).toBe(42);
    expect(store.table().verifiedOn).toBe('2030-01-01');
  });

  it('lets a user price a model the build never shipped', () => {
    // The OpenAI case from this ticket: no longer a dead end.
    const dir = tmpDataDir();
    const store = new PriceStore(dir);
    fs.writeFileSync(path.join(dir, PRICES_FILENAME), JSON.stringify(table({ 'gpt-5': CHEAP })));
    expect(estimateCostUsd('gpt-5', USAGE, store.table().models)).toBeCloseTo(1, 6);
  });

  it('keeps the last good table when the file is edited into nonsense', () => {
    // A typo mustn't silently switch every model to "unknown" and zero out the
    // month's spend.
    const dir = tmpDataDir();
    const store = new PriceStore(dir);
    const before = store.table().models['claude-opus-4-8'].inputPerMTok;

    fs.writeFileSync(path.join(dir, PRICES_FILENAME), '{ this is not json');
    expect(store.table().models['claude-opus-4-8'].inputPerMTok).toBe(before);

    fs.writeFileSync(path.join(dir, PRICES_FILENAME), JSON.stringify({ models: { x: { inputPerMTok: 'free' } } }));
    expect(store.table().models['claude-opus-4-8'].inputPerMTok).toBe(before);
  });

  it('falls back to the built-ins when the file is deleted', () => {
    const dir = tmpDataDir();
    const store = new PriceStore(dir);
    fs.rmSync(path.join(dir, PRICES_FILENAME));
    expect(store.table().models['claude-opus-4-8'].inputPerMTok).toBe(5);
  });

  it('exposes the built-ins as a table with a verification date and sources', () => {
    const built = builtinTable();
    expect(built.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(built.sources[0]).toContain('platform.claude.com');
  });
});

describe('refreshPricesFromManifest (NEWS-93)', () => {
  const ok = (body: unknown): typeof fetch =>
    () => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

  it('replaces the local table from a published manifest', async () => {
    // This is what lets corrected rates reach installs without a release.
    const dir = tmpDataDir();
    const store = new PriceStore(dir);
    const updated = await refreshPricesFromManifest(
      store,
      'https://example.test/prices.json',
      ok(table({ 'claude-opus-4-8': { ...CHEAP, inputPerMTok: 7 } }, '2031-02-03')),
    );
    expect(updated).toBe(true);
    expect(store.table().models['claude-opus-4-8'].inputPerMTok).toBe(7);
    expect(store.table().verifiedOn).toBe('2031-02-03');
  });

  it('refuses a non-https URL', async () => {
    // The manifest decides what the budget cap acts on; plaintext could be
    // swapped in transit.
    const store = new PriceStore(tmpDataDir());
    expect(await refreshPricesFromManifest(store, 'http://example.test/p.json', ok(table({})))).toBe(false);
  });

  it('leaves prices alone when the manifest is unreachable', async () => {
    const store = new PriceStore(tmpDataDir());
    const before = store.table().models['claude-opus-4-8'].inputPerMTok;
    const failing = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    expect(await refreshPricesFromManifest(store, 'https://example.test/p.json', failing)).toBe(false);
    expect(store.table().models['claude-opus-4-8'].inputPerMTok).toBe(before);
  });

  it('leaves prices alone on a non-200', async () => {
    const store = new PriceStore(tmpDataDir());
    const notFound = (() => Promise.resolve(new Response('', { status: 404 }))) as unknown as typeof fetch;
    expect(await refreshPricesFromManifest(store, 'https://example.test/p.json', notFound)).toBe(false);
    expect(store.table().models['claude-opus-4-8'].inputPerMTok).toBe(5);
  });

  it('rejects a manifest of the wrong shape rather than adopting it', async () => {
    const store = new PriceStore(tmpDataDir());
    expect(
      await refreshPricesFromManifest(store, 'https://example.test/p.json', ok({ prices: 'cheap' })),
    ).toBe(false);
    expect(store.table().models['claude-opus-4-8'].inputPerMTok).toBe(5);
  });
});

describe('spend uses the live table (NEWS-93)', () => {
  it('reprices historical runs when the table changes', () => {
    // The reason costs are derived rather than stored: correcting a rate must
    // fix the totals, not leave every past run wrong forever.
    const store = new Store(tmpDataDir());
    const topic = store.addTopic('Fusion');
    const run = store.startRun(topic.id);
    store.finishRun(run.id, {
      status: 'succeeded',
      newItems: 1,
      model: 'model-x',
      usage: USAGE,
    });

    expect(store.spendSince('1970-01-01T00:00:00Z').unpricedRuns).toBe(1);

    fs.writeFileSync(
      path.join(store.dataDir, PRICES_FILENAME),
      JSON.stringify(table({ 'model-x': { ...CHEAP, inputPerMTok: 3 } })),
    );

    const after = store.spendSince('1970-01-01T00:00:00Z');
    expect(after.pricedRuns).toBe(1);
    expect(after.usd).toBeCloseTo(3, 6);
  });
});
