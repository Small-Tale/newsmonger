/**
 * Setting a topic's section by hand (NEWS-407, FR-22.7a).
 *
 * The server side of this — `PATCH /api/topics/:id { category }` writing
 * `categorySource: 'manual'` — has existed since NEWS-97 and was **unreachable**:
 * FR-22.7 was marked Shipped, the promise was implemented, and no UI could make
 * the choice the promise was about. These tests cover the route as it is now
 * actually used, plus the two rules a UI can get wrong silently.
 */

import { describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/mock.js';
import { activeCategories, BUILTIN_CATEGORIES, categoryLabel, findCategory } from '../../src/categories.js';
import { CheckRunner } from '../../src/checks.js';
import { Store } from '../../src/db/store.js';
import { createApp } from '../../src/server.js';
import { asResolver } from '../helpers/provider.js';
import { tmpDataDir } from '../helpers/tmp.js';

function makeApp() {
  const store = new Store(tmpDataDir());
  const runner = new CheckRunner(store, asResolver(createMockProvider()));
  const app = createApp({ store, runner });
  return { app, store };
}

const patch = (app: ReturnType<typeof makeApp>['app'], id: string, body: unknown) =>
  app.request(`/api/topics/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });

describe('choosing a section by hand', () => {
  it('stores the choice and marks it manual', async () => {
    // `manual` is the whole point: it is what stops the next check's classifier
    // from overwriting a person's decision (FR-22.7).
    const { app, store } = makeApp();
    const topic = store.addTopic('Housing market');
    expect(topic.category).toBeNull();
    expect(topic.categorySource).toBe('auto');

    const res = await patch(app, topic.id, { category: 'money', subcategory: 'housing-property' });
    expect(res.status).toBe(200);

    const after = store.getTopic(topic.id);
    expect(after?.category).toBe('money');
    expect(after?.subcategory).toBe('housing-property');
    expect(after?.categorySource).toBe('manual');
  });

  it('clearing resets the source, so the topic becomes classifiable again', async () => {
    // The half a UI is most likely to get wrong. If clearing left `manual`, the
    // topic would be permanently ineligible for automatic classification — and
    // invisibly so, since nothing renders `categorySource`.
    const { app, store } = makeApp();
    const topic = store.addTopic('Housing market');
    await patch(app, topic.id, { category: 'money', subcategory: 'housing-property' });
    expect(store.getTopic(topic.id)?.categorySource).toBe('manual');

    await patch(app, topic.id, { category: null });
    const after = store.getTopic(topic.id);
    expect(after?.category).toBeNull();
    expect(after?.subcategory).toBeNull();
    expect(after?.categorySource, 'a cleared topic must be classifiable again').toBe('auto');
  });

  it('drops a subject that belonged to the previous section', async () => {
    // A sub from the old parent resolves to nothing, so keeping it would store a
    // pair that renders as the section alone while the row still holds a slug.
    const { app, store } = makeApp();
    const topic = store.addTopic('Streaming wars');
    await patch(app, topic.id, { category: 'money', subcategory: 'housing-property' });
    await patch(app, topic.id, { category: 'media' });
    const after = store.getTopic(topic.id);
    expect(after?.category).toBe('media');
    expect(after?.subcategory).toBeNull();
  });

  it('leaves the section alone when the field is absent', async () => {
    // `undefined` means "don't touch it" and `null` means "clear it". A rename
    // that flattened the two would wipe the section every time someone fixed a
    // typo in the name.
    const { app, store } = makeApp();
    const topic = store.addTopic('Housing market');
    await patch(app, topic.id, { category: 'money', subcategory: 'housing-property' });

    await patch(app, topic.id, { name: 'Housing market and rents' });
    const after = store.getTopic(topic.id);
    expect(after?.name).toBe('Housing market and rents');
    expect(after?.category, 'renaming must not clear the section').toBe('money');
    expect(after?.categorySource).toBe('manual');
  });

  it('accepts a slug the taxonomy does not have, and degrades on render', () => {
    // Deliberate, and the schema says why: `category` is a plain nullable string
    // rather than an enum because the taxonomy is edited in code (FR-22.3), and
    // an enum would start rejecting requests the moment a slug was renamed.
    //
    // So the guard is at *render* time — `categoryLabel` degrades an unresolvable
    // slug to "Uncategorized" rather than showing a broken pill. Asserted here
    // because the picker added in NEWS-407 makes this route reachable from the
    // UI for the first time, and a future reader may assume the boundary rejects.
    expect(categoryLabel(BUILTIN_CATEGORIES, 'not-a-section', null)).toBe('Uncategorized');
    expect(categoryLabel(BUILTIN_CATEGORIES, 'money', 'not-a-subject')).toBe('Money');
  });
});

describe('what the picker can offer', () => {
  it('offers only sections that are not retired', () => {
    // The dialog builds its options from `activeCategories`. A retired row still
    // labels the topics holding it, but offering it would let a user file into a
    // section the filter bar has stopped showing.
    const active = activeCategories(BUILTIN_CATEGORIES);
    expect(active.every((c) => !c.retired)).toBe(true);
    expect(active.length).toBeGreaterThan(0);
  });

  it('finds a section by slug so the dialog can list its subjects', () => {
    const money = findCategory(activeCategories(BUILTIN_CATEGORIES), 'money');
    expect(money?.label).toBe('Money');
    expect(money?.subcategories.some((s) => s.slug === 'housing-property')).toBe(true);
    expect(findCategory(activeCategories(BUILTIN_CATEGORIES), null)).toBeUndefined();
  });
});

describe('recording where the classifier was overruled (NEWS-404, FR-22.18)', () => {
  const corrections = async (app: ReturnType<typeof makeApp>['app']) =>
    (await (await app.request('/api/classifier/corrections')).json()) as {
      corrections: { topic: string; from: string; to: string }[];
      classified: number;
    };

  it('records the pair when a manual choice replaces an automatic one', async () => {
    // The pair, not the count. NEWS-397's hypothesis is about near-neighbours,
    // so from → to is what confirms or refutes it; a bare total cannot.
    const { app, store } = makeApp();
    const topic = store.addTopic('Housing market');
    store.setTopicCategory(topic.id, 'business', 'markets', 'auto');

    await patch(app, topic.id, { category: 'money', subcategory: 'housing-property' });

    const body = await corrections(app);
    expect(body.corrections).toEqual([{ topic: 'Housing market', from: 'business', to: 'money' }]);
  });

  it('records nothing when a manual choice corrects nothing', async () => {
    // A user filing a never-classified topic is not a classifier miss. Counting
    // it would inflate the only number this exists to produce.
    const { app, store } = makeApp();
    const topic = store.addTopic('Never classified');
    await patch(app, topic.id, { category: 'money' });
    expect((await corrections(app)).corrections).toEqual([]);
  });

  it('keeps the first miss when the user corrects twice', async () => {
    // Never overwritten: the disagreement being recorded is with the
    // *classifier*, and a user changing their own mind afterwards is not a
    // second miss. Overwriting would also erase the pair that mattered.
    const { app, store } = makeApp();
    const topic = store.addTopic('Streaming wars');
    store.setTopicCategory(topic.id, 'culture', null, 'auto');

    await patch(app, topic.id, { category: 'media' });
    await patch(app, topic.id, { category: 'entertainment' });

    const body = await corrections(app);
    expect(body.corrections).toEqual([{ topic: 'Streaming wars', from: 'culture', to: 'entertainment' }]);
  });

  it('survives the topic being cleared back to automatic', async () => {
    // Clearing resets `categorySource` to `auto` (FR-22.7) so the topic can be
    // re-classified — but the miss already happened, and forgetting it would
    // make the measurement depend on what the user did next.
    const { app, store } = makeApp();
    const topic = store.addTopic('Housing market');
    store.setTopicCategory(topic.id, 'business', null, 'auto');
    await patch(app, topic.id, { category: 'money' });
    await patch(app, topic.id, { category: null });

    expect(store.getTopic(topic.id)?.autoCategory, 'the record outlives the correction').toBe('business');
  });

  it('reports the denominator, not just the numerator', async () => {
    // Five misses out of six classified topics and five out of five hundred are
    // different facts, and the list length cannot tell them apart.
    const { app, store } = makeApp();
    const a = store.addTopic('One');
    const b = store.addTopic('Two');
    store.setTopicCategory(a.id, 'business', null, 'auto');
    store.setTopicCategory(b.id, 'sports', null, 'auto');
    await patch(app, a.id, { category: 'money' });

    const body = await corrections(app);
    expect(body.corrections).toHaveLength(1);
    expect(body.classified).toBe(2);
  });
});
