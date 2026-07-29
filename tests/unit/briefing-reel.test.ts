import { describe, expect, it } from 'vitest';

import {
  assertNoRemoteRefs,
  buildScenes,
  endCardHtml,
  escapeHtml,
  LONG_HEADLINE_CHARS,
  storyboardConfig,
  storyCardHtml,
  storyDurationMs,
  titleCardHtml,
  totalDurationMs,
} from '../../src/briefing/reel.js';
import { reportedLoopMs } from '../../src/briefing/stage.js';
import { type NewsItem, NewsItemSchema, type Topic, TopicSchema } from '../../src/db/schemas.js';

/**
 * Building a briefing reel's scenes (NEWS-167).
 *
 * All string-building, so all testable without a browser — which is the point
 * of splitting it from `stage.ts`. The rule that matters most here is
 * FR-27.8: nothing in a capture page may reference a remote URL, because
 * domotion would dutifully fetch it and the rendered card would look
 * identical, so the breakage leaves no trace in the output.
 */

// Built through the real schemas rather than hand-rolled literals, so the
// project's own defaults fill the fields a card doesn't care about — and a
// future required field breaks these loudly instead of silently arriving
// undefined in a template.
const topic = (over: Record<string, unknown> = {}): Topic =>
  TopicSchema.parse({
    id: 't1',
    name: 'Climate & Environment',
    paused: false,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastCheckedAt: null,
    ...over,
  });

const item = (over: Record<string, unknown> = {}): NewsItem =>
  NewsItemSchema.parse({
    id: 'i1',
    topicId: 't1',
    title: 'Grid operators clear record solar output',
    summary: 'Regional operators reported sustained midday surpluses.',
    sources: [{ title: 'Report', url: 'https://reuters.com/a', outlet: 'Reuters', publishedAt: null }],
    image: null,
    foundAt: '2026-07-29T08:00:00.000Z',
    dedupeKey: 'reuters.com/a',
    ...over,
  });

const cardArgs = (over: Partial<Parameters<typeof storyCardHtml>[0]> = {}) => ({
  item: item(),
  topic: topic(),
  outlet: 'Reuters',
  dateLabel: '29 Jul',
  photo: null,
  ...over,
});

describe('the FR-27.8 remote-reference guard', () => {
  it('rejects a publisher URL smuggled in as an image', () => {
    // The exact mistake the requirement exists to prevent: it renders
    // identically, so nothing about the output would ever reveal it.
    const html = '<img src="https://publisher.example/lead.jpg">';
    expect(() => {
      assertNoRemoteRefs(html, 'scene');
    }).toThrow(/non-local URLs/);
  });

  it.each([
    ['protocol-relative', '<img src="//cdn.example/x.jpg">'],
    ['http', '<img src="http://cdn.example/x.jpg">'],
    ['a remote stylesheet', '<link href="https://fonts.example/f.css">'],
  ])('rejects %s', (_label, html) => {
    expect(() => {
      assertNoRemoteRefs(html, 'scene');
    }).toThrow();
  });

  it('allows the staged local files a real scene uses', () => {
    expect(() => {
      assertNoRemoteRefs('<link href="cards.css"><img src="photo-00.jpg"><img src="wordmark-dark.svg">', 'scene');
    }).not.toThrow();
  });

  it('allows the loopback image route, which is the sanctioned path', () => {
    // `GET /api/image/:hash` serving the local cache is exactly how FR-8.4
    // intends images to reach a page — it must not be caught as an offender.
    expect(() => {
      assertNoRemoteRefs('<img src="http://127.0.0.1:4187/api/image/abc123">', 'scene');
    }).not.toThrow();
  });

  it('names the offending URL, so the message is actionable', () => {
    expect(() => {
      assertNoRemoteRefs('<img src="https://publisher.example/lead.jpg">', 'scene-03');
    }).toThrow(/scene-03.*publisher\.example/s);
  });

  it('runs over every scene a reel builds', () => {
    // The guard is only worth having if the pipeline actually applies it.
    const evil = item({ title: 'x', summary: 'y' });
    expect(() =>
      buildScenes({
        items: [evil],
        topics: [topic()],
        outletFor: () => 'Reuters',
        dateLabelFor: () => '29 Jul',
        photoFor: () => ({ file: 'https://publisher.example/lead.jpg' }),
        headerDateLabel: 'Wednesday, 29 July',
        wordmarkFile: 'wordmark-dark.svg',
      }),
    ).toThrow(/non-local URLs/);
  });
});

describe('story cards', () => {
  it('escapes model-written text rather than trusting it', () => {
    // Titles and summaries are model output. `NewsItemSchema` already strips
    // citation markup on the way in — which is why this bypasses the schema to
    // set the raw title. The card is a *second* boundary and has to hold on
    // its own, rather than relying on an upstream transform staying in place.
    const raw = { ...item(), title: 'Chips & "AI" <b>surge</b>' };
    const html = storyCardHtml(cardArgs({ item: raw }));
    expect(html).toContain('Chips &amp; &quot;AI&quot; &lt;b&gt;surge&lt;/b&gt;');
    expect(html).not.toContain('<b>surge</b>');
  });

  it('escapes an ampersand that survives the schema, e.g. in a topic name', () => {
    // "Climate & Environment" is a real category label and reaches the kicker
    // untouched, so this is the everyday case rather than a hostile one.
    expect(storyCardHtml(cardArgs())).toContain('Climate &amp; Environment');
  });

  it('steps a long headline down instead of clamping it', () => {
    const long = 'a'.repeat(LONG_HEADLINE_CHARS + 1);
    expect(storyCardHtml(cardArgs({ item: item({ title: long }) }))).toContain('headline is-long');
  });

  it('leaves a short headline at full size', () => {
    const short = 'a'.repeat(LONG_HEADLINE_CHARS);
    const html = storyCardHtml(cardArgs({ item: item({ title: short }) }));
    expect(html).toContain('class="headline"');
    expect(html).not.toContain('is-long');
  });

  it('renders the designed no-photo card, not a photo card with a hole', () => {
    const html = storyCardHtml(cardArgs({ photo: null }));
    expect(html).toContain('class="no-media"');
    expect(html).not.toContain('<div class="media">');
    // The rule opens the card where the photo would have been.
    expect(html).toContain('class="rule"');
  });

  it('renders the media slot when there is a photo', () => {
    const html = storyCardHtml(cardArgs({ photo: { file: 'photo-00.jpg' } }));
    expect(html).toContain('<div class="media"><img src="photo-00.jpg"');
    expect(html).not.toContain('no-media');
  });

  it('keeps `.rule` in the markup on both card shapes', () => {
    // Always-present container, shown by CSS — the two shapes differ by class,
    // not by structure, mirroring the client's kerf discipline.
    expect(storyCardHtml(cardArgs({ photo: { file: 'p.jpg' } }))).toContain('class="rule"');
    expect(storyCardHtml(cardArgs({ photo: null }))).toContain('class="rule"');
  });

  it('singularises a lone source', () => {
    const one = storyCardHtml(cardArgs());
    expect(one).toContain('1 source ');
    const three = storyCardHtml(
      cardArgs({
        item: item({
          sources: [
            { title: 'a', url: 'https://a.example/1', outlet: null, publishedAt: null },
            { title: 'b', url: 'https://b.example/1', outlet: null, publishedAt: null },
            { title: 'c', url: 'https://c.example/1', outlet: null, publishedAt: null },
          ],
        }),
      }),
    );
    expect(three).toContain('3 sources');
  });

  it('falls back to a label when a story has no topic', () => {
    // A deleted topic leaves its stories behind; an empty kicker would read as
    // a rendering fault.
    expect(storyCardHtml(cardArgs({ topic: undefined }))).toContain('Newsmonger');
  });
});

describe('scene assembly', () => {
  const three = [item({ id: 'a' }), item({ id: 'b', topicId: 't2' }), item({ id: 'c' })];

  const scenes = () =>
    buildScenes({
      items: three,
      topics: [topic(), topic({ id: 't2', name: 'Markets' })],
      outletFor: () => 'Reuters',
      dateLabelFor: () => '29 Jul',
      photoFor: () => null,
      headerDateLabel: 'Wednesday, 29 July',
      wordmarkFile: 'wordmark-dark.svg',
    });

  it('wraps the stories in a title and a closing card', () => {
    const built = scenes();
    expect(built).toHaveLength(3 + 2);
    expect(built[0].file).toContain('title');
    expect(built[built.length - 1].file).toContain('end');
  });

  it('counts distinct topics, not stories, on the title card', () => {
    expect(scenes()[0].html).toContain('across 2 topics');
  });

  it('puts the AI disclosure on the closing card only', () => {
    const built = scenes();
    const end = built[built.length - 1].html;
    expect(end).toContain('Summaries generated by AI');
    for (const scene of built.slice(0, -1)) expect(scene.html).not.toContain('generated by AI');
  });

  it('brands only the closing card', () => {
    // Story cards stay unbranded so the outlet is the only attribution on them.
    const built = scenes();
    expect(built[built.length - 1].html).toContain('wordmark-dark.svg');
    for (const scene of built.slice(1, -1)) expect(scene.html).not.toContain('wordmark');
  });

  it('names scenes so they sort into playing order', () => {
    const files = scenes().map((s) => s.file);
    expect([...files].sort((a, b) => a.localeCompare(b))).toEqual(files);
  });
});

describe('pacing', () => {
  it('gives a longer story more time to be read', () => {
    const short = storyDurationMs(item({ title: 'Short', summary: 'Brief.' }));
    const long = storyDurationMs(item({ title: 'A'.repeat(90), summary: 'B'.repeat(200) }));
    expect(long).toBeGreaterThan(short);
  });

  it('floors a very short card so it still lands', () => {
    expect(storyDurationMs(item({ title: 'a', summary: 'b' }))).toBeGreaterThanOrEqual(3200);
  });

  it('caps a very long card so it cannot stall the reel', () => {
    expect(storyDurationMs(item({ title: 'A'.repeat(500), summary: 'B'.repeat(2000) }))).toBeLessThanOrEqual(7000);
  });
});

describe('the storyboard config', () => {
  const scenes = [
    { file: 'a.html', html: '', durationMs: 1000 },
    { file: 'b.html', html: '', durationMs: 2000 },
    { file: 'c.html', html: '', durationMs: 3000 },
  ];

  it('gives every scene an explicit duration', () => {
    // Domotion needs one for a static capture scene, and it is also what lets
    // the caller pass an exact --duration to svg-to-video (FR-27.13).
    const config = storyboardConfig({ scenes, width: 1080, height: 1920, output: 'r.svg', background: '#000' }) as {
      scenes: { duration: number }[];
    };
    expect(config.scenes.map((s) => s.duration)).toEqual([1000, 2000, 3000]);
  });

  it('leaves the last scene without a transition', () => {
    // A storyboard loops; a transition on the final scene would animate the
    // end card back into the title, which reads as a glitch, not a loop.
    const config = storyboardConfig({ scenes, width: 1080, height: 1920, output: 'r.svg', background: '#000' }) as {
      scenes: { transition?: unknown }[];
    };
    expect(config.scenes[0].transition).toBeDefined();
    expect(config.scenes[1].transition).toBeDefined();
    expect(config.scenes[2].transition).toBeUndefined();
  });

  it('references scenes by relative file, never by URL', () => {
    const config = storyboardConfig({ scenes, width: 1080, height: 1920, output: 'r.svg', background: '#000' }) as {
      scenes: { capture: { file: string } }[];
    };
    for (const scene of config.scenes) expect(scene.capture.file).not.toMatch(/^[a-z]+:\/\//i);
  });

  it('totals the play length for --duration', () => {
    expect(totalDurationMs(scenes)).toBe(6000);
  });
});

describe('escaping', () => {
  it('covers all five HTML-significant characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('escapes the title and end cards too, not just story cards', () => {
    expect(titleCardHtml({ dateLabel: '<b>x</b>', storyCount: 1, topicCount: 1 })).toContain('&lt;b&gt;');
    expect(endCardHtml({ dateLabel: '<b>x</b>', storyCount: 1, wordmarkFile: 'w.svg' })).toContain('&lt;b&gt;');
  });
});

describe('the reel play length handed to svg-to-video', () => {
  it('reads the loop length domotion reports', () => {
    // Observed for real: six scenes totalling 34.0s of card time actually play
    // for 36.4s, because transitions add time on top. Summing scene durations
    // and passing that to `svg-to-video --duration` truncates the export
    // mid-reel — the exact FR-27.13 class of failure this whole area is about.
    expect(reportedLoopMs('Storyboard: 6 scenes → 1080×1920px, 36.4s loop\nWrote x.svg — 177.1 KB')).toBe(36_400);
  });

  it('falls back to null when a future release phrases it differently', () => {
    // The caller then uses the scene sum, which is slightly short but still a
    // reel — better than refusing to produce one over a changed log line.
    expect(reportedLoopMs('Wrote x.svg')).toBeNull();
  });

  it('ignores a nonsensical figure rather than trusting it', () => {
    expect(reportedLoopMs('0s loop')).toBeNull();
  });
});
