import { describe, expect, it } from 'vitest';

import type { RunOptions } from '../../src/ai/providers/anthropic.js';
import { createAnthropicProvider, DEFAULT_ANTHROPIC_MODEL, messageParams } from '../../src/ai/providers/anthropic.js';
import { createClaudeCliProvider } from '../../src/ai/providers/claude-cli.js';
import { createCodexCliProvider } from '../../src/ai/providers/codex-cli.js';
import { createMockProvider } from '../../src/ai/providers/mock.js';
import { createOpenAIProvider, DEFAULT_OPENAI_MODEL } from '../../src/ai/providers/openai.js';
import { SUGGEST_JSON_SCHEMA } from '../../src/ai/suggest-prompt.js';
import type { CategoryOption, SuggestRequest } from '../../src/ai/types.js';
import { DISCOVERY_MODELS, usesLegacyRequestShape } from '../../src/ai/types.js';

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

/**
 * Discovery runs on a fast, cheap model (NEWS-132).
 *
 * Discovery proposes topic *names*; a check researches and cites stories. The
 * lighter question gets the lighter model — and on Anthropic that model predates
 * the request shape checks send, so the shape has to vary too.
 */
describe('the discovery model', () => {
  it('anthropic uses Haiku for discovery and the check model for checks', async () => {
    const seen: { model: string; system: string }[] = [];
    const provider = createAnthropicProvider({
      getApiKey: () => Promise.resolve('k'),
      runner: {
        run: (system, _prompt, model) => {
          seen.push({ model, system });
          return Promise.resolve({ text: system.includes('propose subjects') ? RESULT : NEWS_RESULT, usage: null });
        },
      },
    });

    await provider.suggestTopics(DESCRIBE);
    await provider.checkTopic('Formula 1', [], null);

    expect(seen[0].model).toBe(DISCOVERY_MODELS.anthropic);
    expect(seen[0].model).toContain('haiku');
    // The check path must be untouched — this change is about discovery only.
    expect(seen[1].model).toBe(DEFAULT_ANTHROPIC_MODEL);
  });

  it('asks for fewer searches and less output on a discovery call', async () => {
    // Each web search is money and several seconds; a check needs a digest's
    // worth, discovery needs only enough to keep the "ongoing" half current.
    const seen: (RunOptions | undefined)[] = [];
    const provider = createAnthropicProvider({
      getApiKey: () => Promise.resolve('k'),
      runner: {
        run: (system, _prompt, _model, options) => {
          seen.push(options);
          return Promise.resolve({ text: system.includes('propose subjects') ? RESULT : NEWS_RESULT, usage: null });
        },
      },
    });

    await provider.suggestTopics(DESCRIBE);
    await provider.checkTopic('Formula 1', [], null);

    expect(seen[0]?.maxSearches).toBeLessThan(seen[1]?.maxSearches ?? 0);
    expect(seen[0]?.maxTokens).toBeLessThan(seen[1]?.maxTokens ?? 0);
  });

  it('a model the user chose explicitly still wins', async () => {
    // An explicit setting is an explicit setting; silently ignoring it would be
    // the more surprising behaviour, even in the name of speed.
    const seen: string[] = [];
    const provider = createAnthropicProvider({
      model: 'claude-opus-4-7',
      getApiKey: () => Promise.resolve('k'),
      runner: {
        run: (_system, _prompt, model) => {
          seen.push(model);
          return Promise.resolve({ text: RESULT, usage: null });
        },
      },
    });

    await provider.suggestTopics(DESCRIBE);

    expect(seen[0]).toBe('claude-opus-4-7');
  });

  it('openai uses the mini model for discovery and the check model for checks', async () => {
    const seen: string[] = [];
    const provider = createOpenAIProvider({
      getApiKey: () => Promise.resolve('k'),
      runner: {
        run: (system, _prompt, model) => {
          seen.push(model);
          return Promise.resolve({ text: system.includes('propose subjects') ? RESULT : NEWS_RESULT, usage: null });
        },
      },
    });

    await provider.suggestTopics(DESCRIBE);
    await provider.checkTopic('Formula 1', [], null);

    expect(seen[0]).toBe(DISCOVERY_MODELS.openai);
    expect(seen[1]).toBe(DEFAULT_OPENAI_MODEL);
  });

  it('the subscription CLIs pass the fast model through --model', async () => {
    const seen: (string | undefined)[] = [];
    const runner = {
      run: (_system: string, _prompt: string, model: string | undefined) => {
        seen.push(model);
        return Promise.resolve(RESULT);
      },
      available: () => Promise.resolve(true),
    };

    await createClaudeCliProvider({ runner }).suggestTopics(DESCRIBE);
    await createCodexCliProvider({ runner }).suggestTopics(DESCRIBE);

    expect(seen[0]).toBe(DISCOVERY_MODELS['claude-cli']);
    expect(seen[1]).toBe(DISCOVERY_MODELS['codex-cli']);
  });

  it('a CLI check still uses the CLI’s own default, not the discovery model', async () => {
    const seen: (string | undefined)[] = [];
    const provider = createClaudeCliProvider({
      runner: {
        run: (_system, _prompt, model) => {
          seen.push(model);
          return Promise.resolve(NEWS_RESULT);
        },
        available: () => Promise.resolve(true),
      },
    });

    await provider.checkTopic('Formula 1', [], null);

    expect(seen[0]).toBeUndefined();
  });
});

describe('usesLegacyRequestShape (NEWS-132)', () => {
  it('flags the models that reject adaptive thinking and the current web-search tool', () => {
    // Our own discovery default is on this list, which is why it exists.
    expect(usesLegacyRequestShape('claude-haiku-4-5')).toBe(true);
    expect(usesLegacyRequestShape('claude-haiku-4-5-20251001')).toBe(true);
    expect(usesLegacyRequestShape('claude-sonnet-4-5')).toBe(true);
  });

  it('treats anything else — including models newer than this code — as modern', () => {
    // Listed as exceptions rather than an allow-list on purpose: a model
    // released after this was written should not silently get the old shape.
    expect(usesLegacyRequestShape('claude-opus-4-8')).toBe(false);
    expect(usesLegacyRequestShape('claude-sonnet-5')).toBe(false);
    expect(usesLegacyRequestShape('some-future-model')).toBe(false);
  });
});

describe('the Anthropic request body (NEWS-132)', () => {
  const OPTS = { maxSearches: 3, maxTokens: 4000 };

  it('sends adaptive thinking and the current web-search tool on a modern model', () => {
    const params = messageParams('sys', 'prompt', 'claude-opus-4-8', OPTS);
    expect(params.thinking).toEqual({ type: 'adaptive' });
    expect(params.tools?.[0]).toMatchObject({ type: 'web_search_20260209', max_uses: 3 });
  });

  it('omits thinking and falls back to the basic web-search tool on Haiku', () => {
    // Both are hard requirements, not preferences: adaptive thinking is 4.6+,
    // and `web_search_20260209` is rejected by anything older. Getting either
    // wrong is a vendor 400 on every discovery call.
    const params = messageParams('sys', 'prompt', DISCOVERY_MODELS.anthropic, OPTS);
    expect(params.thinking).toBeUndefined();
    expect(params.tools?.[0]).toMatchObject({ type: 'web_search_20250305', max_uses: 3 });
  });

  it('carries the caller’s budgets through', () => {
    const params = messageParams('sys', 'prompt', 'claude-opus-4-8', { maxSearches: 8, maxTokens: 16000 });
    expect(params.max_tokens).toBe(16000);
    expect(params.tools?.[0]).toMatchObject({ max_uses: 8 });
  });
});
