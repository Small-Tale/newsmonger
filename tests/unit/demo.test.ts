/**
 * The `--demo` fixture provider (NEWS-212).
 *
 * It exists to make the README hero and stills capturable from the real app, so
 * what matters here is the properties a *screenshot* depends on: the copy is
 * presentable, the second check differs from the first (so dedup is visible),
 * and nothing claims to be real reporting.
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDemoProvider } from '../../src/ai/providers/demo.js';
import type { CategoryOption } from '../../src/ai/types.js';
import { activeCategories, BUILTIN_CATEGORIES } from '../../src/categories.js';
import { THREAD_ROW_CAP } from '../../src/client/thread-view.js';
import { DEMO_TOPICS, demoFaviconFor, demoFixtureDir, demoImageFor, findDemoTopic } from '../../src/demo.js';
import { planThreadIds } from '../../src/threads.js';

/**
 * The taxonomy exactly as the check pipeline offers it (`classifierOptions` in
 * `src/checks.ts`) — the real table, retired rows excluded.
 *
 * Built here rather than hand-written (NEWS-395): a hand-written option list is
 * a second copy of the taxonomy, and it stays green while the real one moves out
 * from under the fixtures. That is how `Science ▸ Energy` survived the move of
 * Energy to Environment.
 */
const OPTIONS: CategoryOption[] = activeCategories(BUILTIN_CATEGORIES).map((c) => ({
  slug: c.slug,
  label: c.label,
  subcategories: c.subcategories.map((s) => ({ slug: s.slug, label: s.label })),
}));

describe('demo fixtures', () => {
  it('has topics, and enough of them answer a second check to show dedup', () => {
    expect(DEMO_TOPICS.length).toBeGreaterThan(0);
    for (const t of DEMO_TOPICS) {
      expect(t.first.length, `${t.name} first`).toBeGreaterThan(0);
    }
    // Every topic used to be required to have second-check stories. A recorded
    // fixture cannot promise that (NEWS-376): the split is dealt from one real
    // capture, so a genuinely quiet beat — Antarctic ice in midwinter returned a
    // single story — has nothing to hold back. That is the honest behaviour a
    // re-check has anyway.
    //
    // What the hero actually needs is for *some* topic to answer the second
    // check, which is what makes dedup visible.
    expect(DEMO_TOPICS.filter((t) => t.second.length > 0).length).toBeGreaterThan(0);
  });

  it('is recorded from real outlets, with pictures — the NEWS-376 contract', () => {
    // This test replaces one asserting the exact opposite, and the reversal is
    // the ticket. Sources used to be required to be named "Illustrative …" and
    // pointed at example.org, because the summaries were invented and
    // attributing invented reporting to a real masthead would put words in a
    // publication's mouth.
    //
    // The cost of that was not the prose. It was that example.org serves no
    // article and no favicon, so the real image pipeline ran on every capture,
    // correctly found nothing, and every shipped screenshot showed a news reader
    // that cannot display a picture.
    //
    // So the fixture is recorded rather than written, and this asserts the
    // property whose absence was invisible before: that the pictures are there.
    let withImage = 0;
    for (const t of DEMO_TOPICS) {
      for (const story of [...t.first, ...t.second]) {
        for (const source of story.sources) {
          expect(new URL(source.url).hostname, `${source.title} should be a real outlet`).not.toBe('example.org');
          expect(source.title).not.toMatch(/^Illustrative /);
        }
        const lead = story.sources.at(0);
        if (lead !== undefined && demoImageFor(lead.url) !== null) withImage++;
      }
    }
    // Not "every story": roughly a third of real articles carry no usable
    // `og:image`, and a fixture that demanded one from all of them would be
    // asserting something the web does not provide. A card with no picture is a
    // layout the feed has to handle anyway.
    expect(withImage, 'the recording must carry lead images').toBeGreaterThan(4);

    const origins = new Set(
      DEMO_TOPICS.flatMap((t) => [...t.first, ...t.second]).flatMap((s) => s.sources.map((x) => new URL(x.url).origin)),
    );
    expect([...origins].filter((o) => demoFaviconFor(o) !== null).length, 'and favicons').toBeGreaterThan(4);
  });

  it('replays every recorded image from a file that is actually committed', () => {
    // The mapping and the bytes are written by the same script but are separate
    // artifacts, and a fixture that names a hash it does not ship would put the
    // missing pictures back while every other assertion here stayed green.
    for (const t of DEMO_TOPICS) {
      for (const story of [...t.first, ...t.second]) {
        const lead = story.sources.at(0);
        const recorded = lead === undefined ? null : demoImageFor(lead.url);
        if (recorded === null) continue;
        expect(
          fs.existsSync(path.join(demoFixtureDir(), 'images', `${recorded.hash}.bin`)),
          `${story.title} names image ${recorded.hash}, which is not committed`,
        ).toBe(true);
      }
    }
  });

  it('has exactly one topic whose stories are a single unfolding subject (NEWS-292)', () => {
    // The `thread` still is a photograph of a real thread, so the fixture has to
    // actually *form* one — and the threading rules are content-sensitive, so an
    // innocent rewording ("Dogger Bank" → "the North Sea site") would quietly
    // split it and the scene would photograph a card with no timeline. Asserted
    // through `planThreadIds`, the same function the check pipeline uses, rather
    // than by trusting the titles to look related.
    const threadCount = (t: (typeof DEMO_TOPICS)[number]): number => {
      const stories = [...t.first, ...t.second];
      const stored = stories.map((s, i) => ({
        id: `s${String(i)}`,
        title: s.title,
        foundAt: new Date(Date.parse('2026-07-01T00:00:00.000Z') + i * 86_400_000).toISOString(),
        sources: s.sources,
      }));
      return new Set(planThreadIds(stored, { topicName: t.name })).size;
    };

    const threaded = DEMO_TOPICS.filter((t) => threadCount(t) < t.first.length + t.second.length);
    expect(threaded.map((t) => t.name)).toEqual(['Renewable energy buildout']);

    const series = threaded[0];
    // One thread, and long enough that the pane holds some of it back — "Show
    // all N stories" is half of what the timeline does, and a thread at or under
    // the cap never shows it.
    expect(threadCount(series)).toBe(1);
    expect(series.first.length + series.second.length).toBeGreaterThan(THREAD_ROW_CAP);

    // And the topic's name must not contain the series' own words: a topic's
    // words are stopwords inside it (FR-29.10), so naming this topic after the
    // subject would subtract exactly what it threads on.
    const words = new Set(series.name.toLowerCase().split(/\W+/).filter(Boolean));
    for (const s of [...series.first, ...series.second]) {
      const shared = s.title
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => words.has(w));
      expect(shared, `"${s.title}" reuses the topic's own words`).toEqual([]);
    }
  });

  it('leaves every other topic as unrelated stories, so the feed looks like a feed', () => {
    // The counterweight: if everything threaded, the feed still would be one
    // subject repeated and the dedup beat in the hero would lose its contrast.
    for (const t of DEMO_TOPICS) {
      if (t.name === 'Renewable energy buildout') continue;
      const stories = [...t.first, ...t.second];
      const stored = stories.map((s, i) => ({
        id: `s${String(i)}`,
        title: s.title,
        foundAt: new Date(Date.parse('2026-07-01T00:00:00.000Z') + i * 86_400_000).toISOString(),
        sources: s.sources,
      }));
      expect(new Set(planThreadIds(stored, { topicName: t.name })).size, t.name).toBe(stories.length);
    }
  });

  it('never reuses a headline between the two checks', () => {
    // The second check exists to show deduplication. A repeated headline would
    // make the hero demonstrate the opposite of the product's whole claim.
    for (const t of DEMO_TOPICS) {
      const firstTitles = new Set(t.first.map((s) => s.title));
      for (const s of t.second) {
        expect(firstTitles.has(s.title), `${t.name} repeats "${s.title}"`).toBe(false);
      }
    }
  });

  it('reads as real prose, not placeholder filler', () => {
    // The `--ai-test` mock emits "Major development in X" from "Example News",
    // which is right for dedup tests and wrong for a screenshot. Guarding the
    // distinction so nobody later "simplifies" these back into filler.
    for (const t of DEMO_TOPICS) {
      for (const s of [...t.first, ...t.second]) {
        expect(s.title).not.toMatch(/Major development in|what experts are watching/);
        expect(s.title.length).toBeGreaterThan(25);
        expect(s.summary.length).toBeGreaterThan(120);
        expect(s.sources.length).toBeGreaterThan(0);
      }
    }
  });

  it('declares a category and subcategory that both resolve, and neither retired (NEWS-395)', () => {
    // The bug this pins: `classify()` drops a label it cannot resolve, which is
    // the right behaviour (FR-22.8) and the reason nothing complained when the
    // taxonomy moved out from under the fixtures. Two topics claimed `Science ▸
    // Energy` for four months after NEWS-388 moved Energy under Environment, one
    // claimed a `Science ▸ Climate` row that never existed under that name, and a
    // fourth claimed `Business ▸ Technology`, which never existed at all. Every
    // one of them photographed a bare section pill where a subject was meant to
    // be, in screenshots nobody re-reads.
    //
    // Matched on **labels**, against the *active* table, because that is exactly
    // what `classify()` does: a retired row would resolve in `BUILTIN_CATEGORIES`
    // and then vanish from the options the classifier is actually handed.
    for (const topic of DEMO_TOPICS) {
      if (topic.category === undefined) continue;
      const category = OPTIONS.find((c) => c.label.toLowerCase() === topic.category?.toLowerCase());
      expect(category, `${topic.name}: no active category labelled "${topic.category ?? ''}"`).toBeDefined();
      if (topic.subcategory === undefined) continue;
      const sub = category?.subcategories.find((s) => s.label.toLowerCase() === topic.subcategory?.toLowerCase());
      expect(
        sub,
        `${topic.name}: "${topic.category ?? ''}" has no active subcategory labelled "${topic.subcategory}"`,
      ).toBeDefined();
    }
  });

  it('classifies every topic through the real provider, subject and all (NEWS-395)', async () => {
    // The same guarantee stated as behaviour rather than as data: run each topic
    // through the provider the capture actually uses, with the options the check
    // pipeline actually sends, and require a subject to come back out. The
    // resolution check above could pass while `classify()` matched differently;
    // this is the assertion the screenshots depend on.
    const provider = createDemoProvider();
    for (const topic of DEMO_TOPICS) {
      const result = await provider.checkTopic(topic.name, [], null, { categoryOptions: OPTIONS });
      expect(result.classification, `${topic.name} classified as nothing`).not.toBeNull();
      if (topic.subcategory !== undefined) {
        expect(result.classification?.subcategory, `${topic.name} lost its subcategory`).not.toBeNull();
      }
    }
  });

  it('finds topics case-insensitively', () => {
    const first = DEMO_TOPICS[0];
    expect(findDemoTopic(first.name.toUpperCase())?.name).toBe(first.name);
    expect(findDemoTopic(`  ${first.name}  `)?.name).toBe(first.name);
    expect(findDemoTopic('not a demo topic')).toBeUndefined();
  });
});

describe('the demo provider', () => {
  it('returns the first set, then the second, for the same topic', async () => {
    const p = createDemoProvider();
    const topic = DEMO_TOPICS[0];

    const one = await p.checkTopic(topic.name, [], null, {});
    expect(one.items.map((i) => i.title)).toEqual(topic.first.map((s) => s.title));

    const two = await p.checkTopic(topic.name, [], null, {});
    expect(two.items.map((i) => i.title)).toEqual(topic.second.map((s) => s.title));

    // And stays on the second set — a capture may check more than twice.
    const three = await p.checkTopic(topic.name, [], null, {});
    expect(three.items.map((i) => i.title)).toEqual(topic.second.map((s) => s.title));
  });

  it('tracks first-vs-second per topic, not globally', () => {
    // Two topics interleaved: each gets its own first check. A shared flag would
    // give the second topic the "what's new" set on its very first check.
    const p = createDemoProvider();
    const [a, b] = DEMO_TOPICS;

    return Promise.all([p.checkTopic(a.name, [], null, {}), p.checkTopic(b.name, [], null, {})]).then(
      ([ra, rb]) => {
        expect(ra.items.map((i) => i.title)).toEqual(a.first.map((s) => s.title));
        expect(rb.items.map((i) => i.title)).toEqual(b.first.map((s) => s.title));
      },
    );
  });

  it('returns nothing for a topic the fixtures do not cover', async () => {
    // Rather than generic filler: anything typed live during a capture should
    // stay visibly empty instead of inventing stories about it.
    const p = createDemoProvider();
    const r = await p.checkTopic('Something nobody wrote fixtures for', [], null, {});
    expect(r.items).toEqual([]);
  });

  it('classifies into slugs from the offered taxonomy', async () => {
    // Slugs, not labels — the caller validates against the live table, so a label
    // would be rejected and the topic would file itself as unclassified.
    const p = createDemoProvider();
    const r = await p.checkTopic('Fusion energy', [], null, { categoryOptions: OPTIONS });
    expect(r.classification).toEqual({ category: 'environment', subcategory: 'energy' });
  });

  it('declines to classify when the taxonomy does not match', async () => {
    const p = createDemoProvider();
    const r = await p.checkTopic('Fusion energy', [], null, {
      categoryOptions: [{ slug: 'sport', label: 'Sport', subcategories: [] }],
    });
    expect(r.classification).toBeNull();
  });

  it('suggests the demo topics, minus the ones already followed', async () => {
    const p = createDemoProvider();
    const first = DEMO_TOPICS[0];
    const r = await p.suggestTopics({ scope: { kind: 'describe', query: '' }, exclude: [first.name] });
    const names = r.suggestions.map((s) => s.name);
    expect(names).not.toContain(first.name);
    expect(names.length).toBe(DEMO_TOPICS.length - 1);
  });

  it('reports as the mock provider, not as a selectable one', async () => {
    // `ConcreteProviderName` drives the Settings dropdown, the CLI usage line and
    // the docs. A capture-only mode must not advertise itself there as something
    // a user can pick.
    const p = createDemoProvider();
    expect(p.name).toBe('mock');
    expect(p.attended).toBe(false);
    await expect(p.isAvailable()).resolves.toBe(true);
  });
});
