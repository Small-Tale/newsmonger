import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildUserPrompt } from '../../src/ai/prompt.js';
import { createMockProvider } from '../../src/ai/providers/index.js';
import { CheckRunner } from '../../src/checks.js';
import { MAX_GUIDANCE_LENGTH } from '../../src/db/schemas.js';
import { createApp } from '../../src/server.js';
import { asResolver } from '../helpers/provider.js';
import { tmpDataDir, tmpStore } from '../helpers/tmp.js';

const GUIDANCE = 'Regulatory and safety news only — not stock price moves.';

describe('buildUserPrompt guidance (NEWS-80)', () => {
  it('omits the section entirely when there is none', () => {
    const prompt = buildUserPrompt('Tesla', [], null);
    expect(prompt).not.toMatch(/gave these instructions/i);
    // The no-guidance prompt must be byte-identical to the pre-NEWS-80 one, so
    // adding the feature can't quietly change results for topics without it.
    expect(buildUserPrompt('Tesla', [], null, {})).toBe(prompt);
    expect(buildUserPrompt('Tesla', [], null, { guidance: '' })).toBe(prompt);
  });

  it('treats whitespace-only guidance as none', () => {
    expect(buildUserPrompt('Tesla', [], null, { guidance: '   \n  ' })).toBe(
      buildUserPrompt('Tesla', [], null),
    );
  });

  it('includes the text as an instruction the model should follow', () => {
    const prompt = buildUserPrompt('Tesla', [], null, { guidance: GUIDANCE });
    expect(prompt).toContain(GUIDANCE);
    expect(prompt).toMatch(/take[s]? precedence/i);
  });

  it('puts guidance ahead of the off-topic examples', () => {
    // Guidance is what the user *said*; flagged titles are what they implied.
    // The explicit instruction should be read first.
    const prompt = buildUserPrompt('Apple', [], null, {
      guidance: GUIDANCE,
      offTopicTitles: ['Apple pie recipe'],
    });
    expect(prompt.indexOf(GUIDANCE)).toBeLessThan(prompt.indexOf('OFF-TOPIC'));
  });

  it('composes with the already-reported list without disturbing it', () => {
    const prompt = buildUserPrompt(
      'Apple',
      [{ title: 'Old story', foundAt: '2026-07-01T00:00:00Z' }],
      null,
      { guidance: GUIDANCE },
    );
    expect(prompt).toContain(GUIDANCE);
    expect(prompt).toContain('- Old story');
  });
});

describe('Store guidance (NEWS-80)', () => {
  it('defaults to empty and round-trips through the data file', () => {
    const store = tmpStore();
    const topic = store.addTopic('Tesla');
    expect(topic.guidance).toBe('');

    store.setTopicGuidance(topic.id, GUIDANCE);
    expect(tmpStore(store.dataDir).getTopic(topic.id)?.guidance).toBe(GUIDANCE);
  });

  it('trims, so whitespace-only input clears rather than half-sets', () => {
    const store = tmpStore();
    const topic = store.addTopic('Tesla');
    store.setTopicGuidance(topic.id, `  ${GUIDANCE}  `);
    expect(store.getTopic(topic.id)?.guidance).toBe(GUIDANCE);

    store.setTopicGuidance(topic.id, '   ');
    expect(store.getTopic(topic.id)?.guidance).toBe('');
  });

  it('caps overlong guidance instead of rejecting it', () => {
    const store = tmpStore();
    const topic = store.addTopic('Tesla');
    store.setTopicGuidance(topic.id, 'x'.repeat(MAX_GUIDANCE_LENGTH + 500));
    expect(store.getTopic(topic.id)?.guidance).toHaveLength(MAX_GUIDANCE_LENGTH);
    // And the capped value must survive a reload — a data file the schema
    // rejects gets backed up and reset, which would lose every topic.
    expect(tmpStore(store.dataDir).getTopic(topic.id)?.guidance).toHaveLength(MAX_GUIDANCE_LENGTH);
  });

  it('loads a pre-NEWS-80 topic that has no guidance field at all', () => {
    // Arrives as a legacy `data.json`, which the SQLite store imports on first
    // open (NEWS-94). The column is NOT NULL, so this also proves the import
    // applies the schema's default rather than writing a null.
    const dir = tmpDataDir();
    fs.writeFileSync(
      `${dir}/data.json`,
      JSON.stringify({
        topics: [
          { id: 't1', name: 'Tesla', paused: false, createdAt: '2026-07-01T00:00:00.000Z', lastCheckedAt: null },
        ],
        items: [],
        settings: { checkIntervalMs: 86_400_000 },
        runs: [],
      }),
    );

    const reloaded = tmpStore(dir);
    expect(reloaded.getTopic('t1')?.guidance).toBe('');
    expect(reloaded.listTopics()).toHaveLength(1);
  });
});

describe('CheckRunner passes guidance to the provider (NEWS-80)', () => {
  it('sends the topic’s guidance with the check', async () => {
    const store = tmpStore();
    const service = createMockProvider();
    const runner = new CheckRunner(store, asResolver(service));
    const topic = store.addTopic('Tesla');
    store.setTopicGuidance(topic.id, GUIDANCE);

    await runner.checkTopic(topic.id);

    expect(service.calls[0]?.context.guidance).toBe(GUIDANCE);
  });

  it('sends empty guidance for a topic that has none', async () => {
    const store = tmpStore();
    const service = createMockProvider();
    const runner = new CheckRunner(store, asResolver(service));
    const topic = store.addTopic('Tesla');

    await runner.checkTopic(topic.id);
    expect(service.calls[0]?.context.guidance).toBe('');
  });

  it('picks up an edit made between checks', async () => {
    // The transition that matters: guidance added after a topic has already
    // been checked must apply to the *next* check, not only to new topics.
    const store = tmpStore();
    const service = createMockProvider();
    const runner = new CheckRunner(store, asResolver(service));
    const topic = store.addTopic('Tesla');

    await runner.checkTopic(topic.id);
    store.setTopicGuidance(topic.id, GUIDANCE);
    await runner.checkTopic(topic.id);
    store.setTopicGuidance(topic.id, '');
    await runner.checkTopic(topic.id);

    expect(service.calls.map((c) => c.context.guidance)).toEqual(['', GUIDANCE, '']);
  });
});

describe('PATCH /api/topics/:id guidance (NEWS-80)', () => {
  function makeApp() {
    const store = tmpStore();
    const runner = new CheckRunner(store, asResolver(createMockProvider()));
    return { app: createApp({ store, runner }), store };
  }

  async function patch(app: ReturnType<typeof makeApp>['app'], id: string, body: unknown) {
    return app.request(`/api/topics/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('sets and clears guidance', async () => {
    const { app, store } = makeApp();
    const topic = store.addTopic('Tesla');

    expect((await patch(app, topic.id, { guidance: GUIDANCE })).status).toBe(200);
    expect(store.getTopic(topic.id)?.guidance).toBe(GUIDANCE);

    expect((await patch(app, topic.id, { guidance: '' })).status).toBe(200);
    expect(store.getTopic(topic.id)?.guidance).toBe('');
  });

  it('applies guidance alongside another field in one request', async () => {
    const { app, store } = makeApp();
    const topic = store.addTopic('Tesla');
    const res = await patch(app, topic.id, { highPriority: true, guidance: GUIDANCE });
    expect(res.status).toBe(200);
    const updated = store.getTopic(topic.id);
    expect(updated?.highPriority).toBe(true);
    expect(updated?.guidance).toBe(GUIDANCE);
  });

  it('rejects guidance past the cap rather than silently truncating at the API', async () => {
    const { app, store } = makeApp();
    const topic = store.addTopic('Tesla');
    const res = await patch(app, topic.id, { guidance: 'x'.repeat(MAX_GUIDANCE_LENGTH + 1) });
    expect(res.status).toBe(400);
    expect(store.getTopic(topic.id)?.guidance).toBe('');
  });

  it('404s for an unknown topic', async () => {
    const { app } = makeApp();
    expect((await patch(app, 'nope', { guidance: GUIDANCE })).status).toBe(404);
  });
});

describe('the prompt sends only what the privacy note discloses (NEWS-91)', () => {
  // Pins the Settings → Privacy claim to the code. If a future change starts
  // sending something else, this fails and the disclosure gets updated with it.
  it('carries the topic name, its guidance, and titles — and nothing else about the user', () => {
    const prompt = buildUserPrompt(
      'Tesla',
      [{ title: 'Reported story', foundAt: '2026-07-01T00:00:00Z' }],
      '2026-07-20T00:00:00Z',
      { guidance: GUIDANCE, offTopicTitles: ['Rejected story'] },
    );

    expect(prompt).toContain('Tesla');
    expect(prompt).toContain(GUIDANCE);
    expect(prompt).toContain('Reported story');
    expect(prompt).toContain('Rejected story');

    // Summaries, source URLs, bookmarks, and other topics are all absent: the
    // known-item list carries titles only, and it is scoped to one topic.
    expect(prompt).not.toMatch(/https?:\/\//);
    expect(prompt.toLowerCase()).not.toContain('bookmark');
    expect(prompt.toLowerCase()).not.toContain('saved');
  });

  it('scopes the already-reported list to the one topic being checked', async () => {
    const store = tmpStore();
    const service = createMockProvider();
    const runner = new CheckRunner(store, asResolver(service));
    const tesla = store.addTopic('Tesla');
    const other = store.addTopic('Baking');
    store.addItems([
      { topicId: other.id, title: 'Sourdough secret', summary: 's', sources: [], dedupeKey: 'k', foundAt: '2026-07-01T00:00:00Z' },
    ]);

    await runner.checkTopic(tesla.id);
    expect(service.calls[0]?.known.map((k) => k.title)).not.toContain('Sourdough secret');
  });
});
