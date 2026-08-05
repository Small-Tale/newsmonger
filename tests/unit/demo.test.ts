/**
 * The `--demo` fixture provider (NEWS-212).
 *
 * It exists to make the README hero and stills capturable from the real app, so
 * what matters here is the properties a *screenshot* depends on: the copy is
 * presentable, the second check differs from the first (so dedup is visible),
 * and nothing claims to be real reporting.
 */

import { describe, expect, it } from 'vitest';

import { createDemoProvider } from '../../src/ai/providers/demo.js';
import type { CategoryOption } from '../../src/ai/types.js';
import { THREAD_ROW_CAP } from '../../src/client/thread-view.js';
import { DEMO_TOPICS, findDemoTopic } from '../../src/demo.js';
import { planThreadIds } from '../../src/threads.js';

const OPTIONS: CategoryOption[] = [
  { slug: 'science', label: 'Science', subcategories: [{ slug: 'energy', label: 'Energy' }, { slug: 'climate', label: 'Climate' }] },
  { slug: 'business', label: 'Business', subcategories: [{ slug: 'technology', label: 'Technology' }] },
];

describe('demo fixtures', () => {
  it('has topics, each with first and second stories', () => {
    expect(DEMO_TOPICS.length).toBeGreaterThan(0);
    for (const t of DEMO_TOPICS) {
      expect(t.first.length, `${t.name} first`).toBeGreaterThan(0);
      expect(t.second.length, `${t.name} second`).toBeGreaterThan(0);
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
    expect(threaded.map((t) => t.name)).toEqual(['Offshore wind']);

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
      if (t.name === 'Offshore wind') continue;
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

  it('uses transparently illustrative sources, never a real outlet', () => {
    // These summaries are invented. Attributing invented reporting to a real
    // masthead would be putting words in a publication's mouth, so every source
    // is both named as illustrative and pointed at example.org.
    for (const t of DEMO_TOPICS) {
      for (const s of [...t.first, ...t.second]) {
        for (const src of s.sources) {
          expect(src.title, `${src.title} should be marked illustrative`).toMatch(/^Illustrative /);
          expect(new URL(src.url).hostname).toBe('example.org');
        }
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
    expect(r.classification).toEqual({ category: 'science', subcategory: 'energy' });
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
