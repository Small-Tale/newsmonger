import { describe, expect, it } from 'vitest';

import { buildUserPrompt } from '../../src/ai/prompt.js';
import { createMockProvider } from '../../src/ai/providers/index.js';
import { CheckRunner } from '../../src/checks.js';
import { Store } from '../../src/db/store.js';
import { asResolver } from '../helpers/provider.js';
import { tmpDataDir } from '../helpers/tmp.js';

describe('buildUserPrompt off-topic examples (NEWS-61)', () => {
  it('omits the section when there are no flagged titles', () => {
    expect(buildUserPrompt('Apple', [], null)).not.toMatch(/OFF-TOPIC/);
  });

  it('lists flagged titles as negative examples', () => {
    const prompt = buildUserPrompt('Apple', [], null, {
      offTopicTitles: ['Apple pie recipe', 'Apple orchard tour'],
    });
    expect(prompt).toMatch(/OFF-TOPIC/);
    expect(prompt).toContain('- Apple pie recipe');
    expect(prompt).toContain('- Apple orchard tour');
  });
});

describe('CheckRunner feeds flagged titles to the provider (NEWS-61)', () => {
  it('passes a topic’s off-topic titles into checkTopic', async () => {
    const store = new Store(tmpDataDir());
    const service = createMockProvider();
    const runner = new CheckRunner(store, asResolver(service));
    const topic = store.addTopic('Apple');
    const [item] = store.addItems([
      { topicId: topic.id, title: 'Apple pie recipe', summary: 's', sources: [], dedupeKey: 'k1', foundAt: '2026-07-24T00:00:00Z' },
    ]);
    store.setItemOffTopic(item.id, true);

    await runner.checkTopic(topic.id);

    expect(service.calls).toHaveLength(1);
    expect(service.calls[0]?.context.offTopicTitles).toEqual(['Apple pie recipe']);
  });

  it('passes an empty list when nothing is flagged', async () => {
    const store = new Store(tmpDataDir());
    const service = createMockProvider();
    const runner = new CheckRunner(store, asResolver(service));
    const topic = store.addTopic('Apple');

    await runner.checkTopic(topic.id);
    expect(service.calls[0]?.context.offTopicTitles).toEqual([]);
  });
});
