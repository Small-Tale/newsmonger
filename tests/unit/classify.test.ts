import { describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/index.js';
import { buildUserPrompt, NEWS_JSON_SCHEMA, parseNewsResult } from '../../src/ai/prompt.js';
import { CheckRunner } from '../../src/checks.js';
import { Store } from '../../src/db/store.js';
import { asResolver, fakeProvider } from '../helpers/provider.js';
import { tmpDataDir } from '../helpers/tmp.js';

// Automatic topic classification (NEWS-97, FR-22.8). The model's answer is
// untrusted input: an unresolvable slug renders exactly like never having been
// classified, so a bad write would be invisible. Most of what's here is about
// what gets *rejected*.

function runnerWith(): { store: Store; runner: CheckRunner } {
  const store = new Store(tmpDataDir());
  return { store, runner: new CheckRunner(store, asResolver(createMockProvider())) };
}

describe('the classification request', () => {
  it('is only made for a topic that still needs one', async () => {
    const store = new Store(tmpDataDir());
    const provider = createMockProvider();
    const runner = new CheckRunner(store, asResolver(provider));
    const topic = store.addTopic('Soccer transfers');

    await runner.checkTopic(topic.id);
    expect(provider.calls[0]?.context.categoryOptions).toBeDefined();

    // Now classified — a second check must not ask again. Re-asking every time
    // spends tokens on a settled question and lets the answer drift.
    await runner.checkTopic(topic.id);
    expect(provider.calls[1]?.context.categoryOptions).toBeUndefined();
  });

  it('is not made for a topic the user categorised by hand', async () => {
    const store = new Store(tmpDataDir());
    const provider = createMockProvider();
    const runner = new CheckRunner(store, asResolver(provider));
    const topic = store.addTopic('Ambiguous');
    // Manual *and* cleared: the source is what protects it, not the value.
    store.setTopicCategory(topic.id, null, null, 'manual');

    await runner.checkTopic(topic.id);
    expect(provider.calls[0]?.context.categoryOptions).toBeUndefined();
    expect(store.getTopic(topic.id)?.category).toBeNull();
  });

  it('offers the live taxonomy, not a hard-coded list', async () => {
    const store = new Store(tmpDataDir());
    const provider = createMockProvider();
    const runner = new CheckRunner(store, asResolver(provider));
    await runner.checkTopic(store.addTopic('Anything').id);

    const options = provider.calls[0]?.context.categoryOptions ?? [];
    expect(options.map((o) => o.slug)).toContain('sports');
    expect(options.find((o) => o.slug === 'sports')?.subcategories.map((s) => s.slug)).toContain('soccer');
    // Labels travel with slugs — the model picks by slug but reads by label.
    expect(options.find((o) => o.slug === 'sports')?.label).toBe('Sports');
  });
});

describe('applying the model’s answer', () => {
  it('stores a category and subcategory the taxonomy has', async () => {
    const { store, runner } = runnerWith();
    const topic = store.addTopic('Soccer transfers');
    await runner.checkTopic(topic.id);

    const updated = store.getTopic(topic.id);
    expect(updated?.category).toBe('sports');
    expect(updated?.subcategory).toBe('soccer');
    expect(updated?.categorySource).toBe('auto');
  });

  it('stores a category with no subcategory', async () => {
    const { store, runner } = runnerWith();
    const topic = store.addTopic('Sports in general');
    await runner.checkTopic(topic.id);

    expect(store.getTopic(topic.id)?.category).toBe('sports');
    expect(store.getTopic(topic.id)?.subcategory).toBeNull();
  });

  it('drops a category the taxonomy does not have, leaving the topic unclassified', async () => {
    // The case that would otherwise be an invisible bad write: an unresolvable
    // slug renders exactly like "never classified", so the topic would look
    // untouched while the code believed it was done — and it would never be
    // asked again, because `category !== null`.
    const { store, runner } = runnerWith();
    const topic = store.addTopic('Bogus subject');
    await runner.checkTopic(topic.id);

    expect(store.getTopic(topic.id)?.category).toBeNull();
    expect(store.getTopic(topic.id)?.categorySource).toBe('auto');
  });

  it('re-asks on the next check after a rejected answer', async () => {
    // The consequence of dropping rather than storing: the topic stays eligible,
    // so a later check can do better.
    const store = new Store(tmpDataDir());
    const provider = createMockProvider();
    const runner = new CheckRunner(store, asResolver(provider));
    const topic = store.addTopic('Bogus subject');

    await runner.checkTopic(topic.id);
    await runner.checkTopic(topic.id);
    expect(provider.calls[1]?.context.categoryOptions).toBeDefined();
  });

  it('drops a subcategory belonging to a different category, keeping the category', async () => {
    // The category is still a good answer, and Sports-with-no-subcategory is a
    // valid state (FR-22.6) — so a mismatched sub is dropped on its own rather
    // than discarding the whole classification.
    const store = new Store(tmpDataDir());
    const runner = new CheckRunner(
      store,
      asResolver(
        fakeProvider(() =>
          Promise.resolve({ items: [], usage: null, classification: { category: 'sports', subcategory: 'fashion' } }),
        ),
      ),
    );
    const topic = store.addTopic('Mismatched');
    await runner.checkTopic(topic.id);

    expect(store.getTopic(topic.id)?.category).toBe('sports');
    expect(store.getTopic(topic.id)?.subcategory).toBeNull();
  });

  it('drops a subcategory the taxonomy does not have at all', async () => {
    const store = new Store(tmpDataDir());
    const runner = new CheckRunner(
      store,
      asResolver(
        fakeProvider(() =>
          Promise.resolve({ items: [], usage: null, classification: { category: 'sports', subcategory: 'skiing' } }),
        ),
      ),
    );
    const topic = store.addTopic('Skiing');
    await runner.checkTopic(topic.id);

    expect(store.getTopic(topic.id)?.category).toBe('sports');
    expect(store.getTopic(topic.id)?.subcategory).toBeNull();
  });

  it('leaves the topic unclassified when the model declines', async () => {
    const { store, runner } = runnerWith();
    const topic = store.addTopic('Uncategorized thing');
    await runner.checkTopic(topic.id);
    expect(store.getTopic(topic.id)?.category).toBeNull();
  });

  it('never overwrites a manual choice made while the check was in flight', async () => {
    // A check takes minutes. Re-reading the topic after it returns, rather than
    // trusting the copy taken before, is what makes this safe.
    const store = new Store(tmpDataDir());
    const provider = createMockProvider();
    const runner = new CheckRunner(store, asResolver(provider));
    const topic = store.addTopic('Soccer transfers');

    const check = runner.checkTopic(topic.id);
    store.setTopicCategory(topic.id, 'culture', null, 'manual');
    await check;

    const updated = store.getTopic(topic.id);
    expect(updated?.category).toBe('culture');
    expect(updated?.categorySource).toBe('manual');
  });

  it('does not classify a topic deleted mid-check', async () => {
    const { store, runner } = runnerWith();
    const topic = store.addTopic('Soccer transfers');
    const check = runner.checkTopic(topic.id);
    store.deleteTopic(topic.id);
    await expect(check).resolves.not.toThrow();
    expect(store.getTopic(topic.id)).toBeUndefined();
  });

  it('still classifies when the check found no stories', async () => {
    // Classification is about the topic, not this week's news — an empty check
    // is not a failed one.
    const { store, runner } = runnerWith();
    const topic = store.addTopic('Empty soccer desk');
    await runner.checkTopic(topic.id);
    expect(store.getTopic(topic.id)?.category).toBe('sports');
  });
});

describe('the prompt and its parsing', () => {
  it('asks for classification only when options are supplied', () => {
    const bare = buildUserPrompt('Tennis', [], null, {});
    expect(bare).not.toContain('classify this topic');

    const asking = buildUserPrompt('Tennis', [], null, {
      categoryOptions: [{ slug: 'sports', label: 'Sports', subcategories: [{ slug: 'tennis', label: 'Tennis' }] }],
    });
    expect(asking).toContain('classify this topic');
    // Slugs are what the model must return, so both must be in front of it.
    expect(asking).toContain('Sports (sports)');
    expect(asking).toContain('Tennis (tennis)');
    // And it must be told that declining a subcategory is allowed (FR-22.6).
    expect(asking).toContain('null rather than forcing one');
  });

  it('declares the fields in the structured-output schema', () => {
    // `additionalProperties: false` means a provider using this schema would
    // *reject* a classification that wasn't declared — while `required` must
    // stay items-only, since most checks don't ask.
    expect(NEWS_JSON_SCHEMA.properties).toHaveProperty('category');
    expect(NEWS_JSON_SCHEMA.properties).toHaveProperty('subcategory');
    expect(NEWS_JSON_SCHEMA.required).toEqual(['items']);
  });

  it('parses a classification alongside the items', () => {
    const parsed = parseNewsResult(
      JSON.stringify({
        items: [{ title: 'T', summary: 'S', sources: [{ title: 's', url: 'https://a.test/x' }] }],
        category: 'sports',
        subcategory: 'soccer',
      }),
    );
    expect(parsed.items).toHaveLength(1);
    expect(parsed.classification).toEqual({ category: 'sports', subcategory: 'soccer' });
  });

  it('reports no classification when the model omitted it', () => {
    const parsed = parseNewsResult(
      JSON.stringify({ items: [{ title: 'T', summary: 'S', sources: [{ title: 's', url: 'https://a.test/x' }] }] }),
    );
    expect(parsed.classification).toBeNull();
  });

  it('keeps the stories when the classification is malformed', () => {
    // The stories are the expensive part of the response. A bad category must
    // degrade to "not classified", never fail the parse and lose the batch.
    const parsed = parseNewsResult(
      JSON.stringify({
        items: [{ title: 'T', summary: 'S', sources: [{ title: 's', url: 'https://a.test/x' }] }],
        category: 42,
        subcategory: { nonsense: true },
      }),
    );
    expect(parsed.items).toHaveLength(1);
    expect(parsed.classification).toBeNull();
  });

  it('treats a subcategory without a category as no classification', () => {
    const parsed = parseNewsResult(
      JSON.stringify({
        items: [{ title: 'T', summary: 'S', sources: [{ title: 's', url: 'https://a.test/x' }] }],
        subcategory: 'soccer',
      }),
    );
    expect(parsed.classification).toBeNull();
  });
});
