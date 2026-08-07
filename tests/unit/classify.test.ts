import { describe, expect, it } from 'vitest';

import { buildUserPrompt, NEWS_JSON_SCHEMA, parseNewsResult } from '../../src/ai/prompt.js';
import { createMockProvider } from '../../src/ai/providers/index.js';
import { BUILTIN_CATEGORIES, categoryLabel } from '../../src/categories.js';
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

  /**
   * The taxonomy's real budget, measured (NEWS-397).
   *
   * NEWS-392 moved the constraint on how big `BUILTIN_CATEGORIES` may get: an
   * unpopulated section costs nothing in the filter bar (NEWS-114), so what a
   * wider table actually costs is **this option list**, written into the check
   * prompt for every topic that still needs a section. NEWS-388 then took the
   * table from 11 sections / 63 subcategories to 20 / 132 — and nothing
   * measured the constraint it had just become, which is worse than having the
   * wrong constraint, because it leaves no argument against the next widening.
   *
   * So: a **budget, not a fingerprint.** The counts are exact, because adding a
   * section or a subject is a deliberate act that should appear in a diff. The
   * character ceiling carries headroom, because rewording a label is not a
   * structural change and should not fail a gate.
   *
   * What the current numbers cost, so the next person widening this has a
   * figure rather than a feeling: the block is ~5.4k characters, on the order
   * of 1,300–1,800 tokens (see the ticket for the estimation method) — more
   * than the system prompt and the rest of the user prompt put together. It is
   * paid **once per topic**, not once per check: `needsClassifying` stops
   * asking as soon as an answer resolves. Fractions of a cent per topic. The
   * question worth arguing about is not the tokens; it is whether a 20-way
   * choice with 132 leaves is one a model makes as well as an 11-way one, and
   * nothing here can answer that.
   */
  it('keeps the classifier option list inside its measured budget (NEWS-397)', async () => {
    const store = new Store(tmpDataDir());
    const provider = createMockProvider();
    const runner = new CheckRunner(store, asResolver(provider));
    await runner.checkTopic(store.addTopic('Anything').id);
    const options = provider.calls[0]?.context.categoryOptions ?? [];

    // 21 sections since NEWS-405 added `other` as the explicit fallback. Its
    // subcategory count is deliberately zero, so the subject total is unchanged
    // — the widening costs one line, not a section's worth.
    expect(options).toHaveLength(21);
    expect(options.reduce((n, o) => n + o.subcategories.length, 0)).toBe(132);

    // Isolate the block by difference: the same prompt with and without the
    // options differs by exactly the section list and its two instructions.
    const bare = buildUserPrompt('Anything', [], null, {});
    const asking = buildUserPrompt('Anything', [], null, { categoryOptions: options });
    // Ceiling unchanged by NEWS-405: `- Other (other)` is ~16 characters, and
    // the reworded closing instruction is a wash. If a change ever needs this
    // number raised, that is the signal to argue about the taxonomy rather than
    // to edit the constant.
    expect(asking.length - bare.length).toBeLessThanOrEqual(5700);
  });
});

describe('the explicit fallback section (NEWS-405)', () => {
  /** The options as the runner actually sends them, not a hand-built copy. */
  async function optionsSent() {
    const store = new Store(tmpDataDir());
    const provider = createMockProvider();
    const runner = new CheckRunner(store, asResolver(provider));
    await runner.checkTopic(store.addTopic('Anything').id);
    return provider.calls[0]?.context.categoryOptions ?? [];
  }

  it('offers the fallback to the classifier, with no subjects', async () => {
    const other = (await optionsSent()).find((o) => o.slug === 'other');
    expect(other?.label).toBe('Other');
    expect(other?.subcategories, 'the fallback must offer no subjects').toEqual([]);
  });

  it('tells the model to choose it rather than returning null', async () => {
    // The row alone would fix nothing. The prompt used to end "If no category
    // fits either, set both to null" — a deliberately-supported answer that left
    // the topic unclassified, so the whole option list was re-sent on every
    // check, forever, with no signal. Rewording it is the actual fix.
    const prompt = buildUserPrompt('Anything', [], null, { categoryOptions: await optionsSent() });
    expect(prompt).toContain('choose "other"');
    expect(prompt).toContain('Never return null for the category');
    expect(prompt, 'the old invitation to decline must be gone').not.toContain('set both to null');
  });

  it('asks the model to prefer a real section over the fallback', async () => {
    // Without this the cheapest answer is always "other" and the taxonomy stops
    // meaning anything. The instruction has to make the fallback available and
    // unattractive at once.
    const prompt = buildUserPrompt('Anything', [], null, { categoryOptions: await optionsSent() });
    expect(prompt).toContain('prefer a real section');
  });

  it('stops re-asking once a topic lands there', async () => {
    // The behaviour the ticket is about, observed rather than asserted through
    // an internal predicate: a topic with a resolved section is not asked again,
    // so the option list is paid once instead of on every check for the life of
    // the topic.
    const store = new Store(tmpDataDir());
    const provider = createMockProvider();
    const runner = new CheckRunner(store, asResolver(provider));
    const topic = store.addTopic('Anything');

    await runner.checkTopic(topic.id);
    expect(provider.calls[0]?.context.categoryOptions, 'the first check asks').toBeDefined();

    // Whatever the mock answered, put it in the fallback and check again.
    store.setTopicCategory(topic.id, 'other', null, 'auto');
    await runner.checkTopic(topic.id);
    expect(
      provider.calls[1]?.context.categoryOptions,
      'a topic already in a section must not be asked again',
    ).toBeUndefined();
  });

  it('renders as its own name, not "Other · Other"', () => {
    // `NO_SUBCATEGORY_LABEL` is also "Other". `categoryLabel` returns the section
    // alone when no subject resolves, so the collision never surfaces there — and
    // `groupSuggestions` was brought into line for the discovery headings.
    expect(categoryLabel(BUILTIN_CATEGORIES, 'other', null)).toBe('Other');
    expect(categoryLabel(BUILTIN_CATEGORIES, 'other', 'anything')).toBe('Other');
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

  it('declares the fields in the structured-output schema, and requires them', () => {
    // `additionalProperties: false` means a provider using this schema would
    // *reject* a classification that wasn't declared.
    expect(NEWS_JSON_SCHEMA.properties).toHaveProperty('category');
    expect(NEWS_JSON_SCHEMA.properties).toHaveProperty('subcategory');

    // This asserted `['items']` until NEWS-272, on the reasoning that most checks
    // don't ask for a classification — so it had pinned the defect as the rule.
    // OpenAI's strict structured outputs reject a schema whose `required` omits a
    // declared property, and every Codex check died on exactly that. Optionality
    // is expressed by the nullable type instead, so a check that doesn't ask gets
    // `null` back rather than an absent key — which `parseNewsResult` has always
    // treated identically (see the test below, which passes either way).
    expect(NEWS_JSON_SCHEMA.required).toEqual(['items', 'category', 'subcategory']);
  });

  it('reads an unasked-for classification as absent whether it is null or missing', () => {
    // The behaviour that makes requiring the keys safe. Both forms must land on
    // `classification: null` rather than one of them inventing a category.
    const items = [{ title: 'T', summary: 'S', sources: [{ title: 's', url: 'https://a.test/x' }] }];
    const asNull = parseNewsResult(JSON.stringify({ items, category: null, subcategory: null }));
    const asMissing = parseNewsResult(JSON.stringify({ items }));
    expect(asNull.classification).toBeNull();
    expect(asMissing.classification).toBeNull();
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
