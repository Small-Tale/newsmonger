import { describe, expect, it } from 'vitest';

import { createAnthropicProvider } from '../../src/ai/providers/anthropic.js';
import { createClaudeCliProvider } from '../../src/ai/providers/claude-cli.js';
import { createCodexCliProvider } from '../../src/ai/providers/codex-cli.js';
import { createMockProvider } from '../../src/ai/providers/mock.js';
import { createOpenAIProvider } from '../../src/ai/providers/openai.js';
import { SUGGEST_JSON_SCHEMA } from '../../src/ai/suggest-prompt.js';
import type { CategoryOption, SuggestRequest } from '../../src/ai/types.js';

/**
 * `suggestTopics` across all five providers (NEWS-124).
 *
 * Every provider is exercised through its injected runner, so nothing here
 * spawns a process or touches the network.
 */

const RESULT = JSON.stringify({
  suggestions: [{ name: 'Formula 1', reason: 'Race weekends', kind: 'evergreen', guidance: 'Not gossip' }],
});

const NEWS_RESULT = JSON.stringify({
  items: [{ title: 'A race happened', summary: 'It did.', sources: [{ title: 'Wire', url: 'https://e.com/a' }] }],
});

const DESCRIBE: SuggestRequest = { scope: { kind: 'describe', query: 'motorsport' }, exclude: [] };

describe('createAnthropicProvider.suggestTopics', () => {
  it('sends the discovery system prompt, not the news one, and reports usage', async () => {
    const seen: { system: string; prompt: string }[] = [];
    const usage = { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, webSearches: 1 };
    const provider = createAnthropicProvider({
      getApiKey: () => Promise.resolve('k'),
      runner: {
        run: (system, prompt) => {
          seen.push({ system, prompt });
          return Promise.resolve({ text: RESULT, usage });
        },
      },
    });

    const result = await provider.suggestTopics(DESCRIBE);

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].name).toBe('Formula 1');
    expect(result.usage).toEqual(usage);
    // The two calls must not share a system prompt — that is the bug where
    // discovery quietly asks for news instead of topics.
    expect(seen[0].system).toContain('You do not report news; you propose subjects');
    expect(seen[0].prompt).toContain('motorsport');
  });
});

describe('createOpenAIProvider.suggestTopics', () => {
  it('parses the injected runner’s result', async () => {
    const provider = createOpenAIProvider({
      getApiKey: () => Promise.resolve('k'),
      runner: { run: () => Promise.resolve({ text: RESULT, usage: null }) },
    });
    const result = await provider.suggestTopics(DESCRIBE);
    expect(result.suggestions[0].guidance).toBe('Not gossip');
    expect(result.usage).toBeNull();
  });
});

describe('the subscription CLIs', () => {
  it('claude-cli asks for the suggestion schema, not the news schema', async () => {
    const schemas: object[] = [];
    const provider = createClaudeCliProvider({
      runner: {
        run: (_system, _prompt, _model, schema) => {
          schemas.push(schema);
          // Answer in the shape the schema asked for, so a provider that sent
          // the wrong one fails the way the real CLI would.
          return Promise.resolve(schema === SUGGEST_JSON_SCHEMA ? RESULT : NEWS_RESULT);
        },
        available: () => Promise.resolve(true),
      },
    });

    await provider.suggestTopics(DESCRIBE);
    await provider.checkTopic('Formula 1', [], null);

    // Handing the CLI the news schema for a discovery call makes it reject a
    // perfectly good answer — the failure this parameter exists to prevent.
    expect(schemas[0]).toBe(SUGGEST_JSON_SCHEMA);
    expect(schemas[1]).not.toBe(SUGGEST_JSON_SCHEMA);
  });

  it('codex-cli does the same, and reports usage as unknown rather than zero', async () => {
    const schemas: object[] = [];
    const provider = createCodexCliProvider({
      runner: {
        run: (_system, _prompt, _model, schema) => {
          schemas.push(schema);
          return Promise.resolve(RESULT);
        },
        available: () => Promise.resolve(true),
      },
    });

    const result = await provider.suggestTopics(DESCRIBE);

    expect(schemas[0]).toBe(SUGGEST_JSON_SCHEMA);
    // Plan quota, not metered dollars — null means "unknown", never "free".
    expect(result.usage).toBeNull();
  });
});

describe('createMockProvider.suggestTopics', () => {
  const OPTIONS: CategoryOption[] = [
    { slug: 'sports', label: 'Sports', subcategories: [{ slug: 'motorsport', label: 'Motorsport' }] },
  ];

  it('records the request so the FR-24.11 first layer is assertable', async () => {
    const mock = createMockProvider();
    await mock.suggestTopics({ scope: { kind: 'describe', query: 'cycling' }, exclude: ['Pro cycling'] });
    expect(mock.suggestCalls).toHaveLength(1);
    expect(mock.suggestCalls[0].exclude).toEqual(['Pro cycling']);
  });

  it('deliberately suggests an already-followed topic, first in the list', async () => {
    // The whole point of FR-24.11's second layer is a model that ignores the
    // exclusions. A mock that filtered perfectly would make that layer
    // permanently untestable, so it plants the duplicate on purpose — and puts
    // it first, where a filter that only checks the tail would miss it.
    const mock = createMockProvider();
    const { suggestions } = await mock.suggestTopics({
      scope: { kind: 'describe', query: 'cycling' },
      exclude: ['Pro cycling', 'Tour de France'],
    });
    expect(suggestions[0].name).toBe('Pro cycling');
  });

  it('honours the fail and empty keywords through every entry shape', async () => {
    const mock = createMockProvider();
    await expect(mock.suggestTopics({ scope: { kind: 'describe', query: 'fail me' }, exclude: [] })).rejects.toThrow(
      /mock suggestion failure/,
    );
    await expect(
      mock.suggestTopics({ scope: { kind: 'section', category: 'x', subcategory: 'fail' }, exclude: [] }),
    ).rejects.toThrow(/mock suggestion failure/);
    await expect(
      mock.suggestTopics({
        scope: { kind: 'tune', anchor: 'fail', direction: 'similar', kept: [], skipped: [], round: 1 },
        exclude: [],
      }),
    ).rejects.toThrow(/mock suggestion failure/);

    const empty = await mock.suggestTopics({ scope: { kind: 'describe', query: 'empty' }, exclude: [] });
    expect(empty.suggestions).toEqual([]);
  });

  it('an empty query still returns suggestions (surprise me is not an error)', async () => {
    const mock = createMockProvider();
    const { suggestions } = await mock.suggestTopics({ scope: { kind: 'describe', query: '' }, exclude: [] });
    expect(suggestions.length).toBeGreaterThan(0);
  });

  it('distinguishes tuner rounds and directions in the names', async () => {
    // Without this a tuner that re-issues the same round looks identical to one
    // that advanced — the bug is invisible unless the fixture varies.
    const mock = createMockProvider();
    const round = async (n: number, direction: 'narrower' | 'similar'): Promise<string> => {
      const { suggestions } = await mock.suggestTopics({
        scope: { kind: 'tune', anchor: 'Formula 1', direction, kept: [], skipped: [], round: n },
        exclude: [],
      });
      return suggestions[0].name;
    };

    const r1 = await round(1, 'narrower');
    const r2 = await round(2, 'narrower');
    const similar = await round(1, 'similar');

    expect(r1).not.toBe(r2);
    expect(r1).not.toBe(similar);
    expect(r2).toContain('r2');
  });

  it('returns a mix of both kinds so the labelled rendering is always exercised', async () => {
    const mock = createMockProvider();
    const { suggestions } = await mock.suggestTopics({
      scope: { kind: 'describe', query: 'motorsport' },
      exclude: [],
      limit: 4,
    });
    expect(suggestions.map((s) => s.kind)).toContain('ongoing');
    expect(suggestions.map((s) => s.kind)).toContain('evergreen');
  });

  it('classifies against the offered taxonomy, and not at all when none is offered', async () => {
    const mock = createMockProvider();
    const classified = await mock.suggestTopics({
      scope: { kind: 'section', category: 'sports', subcategory: 'Motorsport' },
      exclude: [],
      categoryOptions: OPTIONS,
    });
    expect(classified.suggestions[0].classification).toEqual({ category: 'sports', subcategory: 'motorsport' });

    const unasked = await mock.suggestTopics({
      scope: { kind: 'section', category: 'sports', subcategory: 'Motorsport' },
      exclude: [],
    });
    expect(unasked.suggestions[0].classification).toBeNull();
  });

  it('is deterministic across repeated identical requests', async () => {
    const mock = createMockProvider();
    const once = await mock.suggestTopics(DESCRIBE);
    const twice = await mock.suggestTopics(DESCRIBE);
    expect(twice.suggestions).toEqual(once.suggestions);
  });
});
