import { describe, expect, it } from 'vitest';

import type { RunOptions } from '../../src/ai/providers/anthropic.js';
import { createAnthropicProvider, messageParams } from '../../src/ai/providers/anthropic.js';
import { AUTO_ORDER, providerTakesEffort } from '../../src/ai/types.js';

/**
 * The effort setting (NEWS-189).
 *
 * The load-bearing test here is the last one: `effort` must reach a *check* and
 * must never reach *discovery*. Discovery runs on `claude-haiku-4-5`, which
 * rejects `output_config.effort` outright — so leaking the setting there would
 * turn a user preference into a 400 on every suggestion request.
 */

describe('effort is a setting, and a checks-only one (NEWS-189)', () => {
  const MODERN = 'claude-opus-4-8';
  const CHECK: RunOptions = { maxSearches: 8, maxTokens: 16000 };

  it('omits output_config entirely when no level is set', () => {
    // Default '' must mean "whatever the provider does", not a level we picked —
    // so behaviour is unchanged until someone opens the dropdown.
    for (const options of [CHECK, { ...CHECK, effort: '' as const }]) {
      const params = messageParams('sys', 'prompt', MODERN, options);
      expect(params).not.toHaveProperty('output_config');
    }
  });

  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)('sends output_config.effort for %o', (effort) => {
    const params = messageParams('sys', 'prompt', MODERN, { ...CHECK, effort });
    expect(params).toMatchObject({ output_config: { effort } });
  });

  it('never sends it on a legacy-shape model, which would reject it', () => {
    // `claude-haiku-4-5` is the discovery model (DISCOVERY_MODELS) and it does not
    // merely ignore `output_config.effort` — it rejects the request. The same
    // guard that keeps `thinking` off legacy models has to keep effort off them,
    // or a preference set for checks becomes a 400 on every discovery call.
    const params = messageParams('sys', 'prompt', 'claude-haiku-4-5', {
      maxSearches: 3,
      maxTokens: 4000,
      effort: 'max',
    });
    expect(params).not.toHaveProperty('output_config');
    expect(params).not.toHaveProperty('thinking');
  });

  it('applies the configured level to a check and never to discovery', async () => {
    // The end-to-end version of the guard above, through the real provider:
    // suggestTopics must not carry the user's check effort into the Haiku call.
    const seen: { model: string; effort: unknown }[] = [];
    const runner = {
      run: (_s: string, _p: string, model: string, options?: { effort?: string }) => {
        seen.push({ model, effort: options?.effort });
        // Two shapes: a check wants `items`, a suggestion wants `suggestions`.
        // Returning both keeps one fake runner valid for both calls.
        return Promise.resolve({ text: JSON.stringify({ items: [], suggestions: [] }), usage: null });
      },
    };
    const provider = createAnthropicProvider({ runner, effort: 'max', model: MODERN });
    await provider.checkTopic('Fusion', [], null);
    await provider.suggestTopics({ scope: { kind: 'describe', query: 'science' }, exclude: [], limit: 5 });

    expect(seen).toHaveLength(2);
    expect(seen[0], 'the check should carry the setting').toMatchObject({ effort: 'max' });
    expect(seen[1]?.effort, 'discovery must not').not.toBe('max');
  });
});

describe('the effort a run used is recorded (NEWS-226)', () => {
  it('reads the level off the provider, not off settings', () => {
    // A provider is constructed for the check with the settings as they were
    // then, so `provider.effort` is what the request actually carried. Reading
    // settings at record time would report a level the run never used if
    // someone changed the dropdown mid-sweep — worse than recording nothing.
    expect(createAnthropicProvider({ effort: 'xhigh' }).effort).toBe('xhigh');
    expect(createAnthropicProvider({}).effort).toBe('');
  });

  it('reports empty rather than a level for providers that take none', async () => {
    // The CLI providers and OpenAI pass no effort parameter, so a run on them
    // genuinely ran at the model's default — '' says that, and is distinct from
    // the null a pre-NEWS-226 run reads back as.
    const { createOpenAIProvider } = await import('../../src/ai/providers/openai.js');
    const { createMockProvider } = await import('../../src/ai/providers/mock.js');
    expect(createOpenAIProvider({}).effort).toBe('');
    expect(createMockProvider().effort).toBe('');
  });
});

// `effortLabel`, which rendered these in the diagnostics run list, went with
// that section in NEWS-333. The *storage* distinction below is unaffected and
// still matters: it is what keeps runs recorded before the column existed out
// of any later comparison.
describe('null and empty effort mean different things (NEWS-226)', () => {
  it('keeps a historical run distinguishable from a default-effort one', async () => {
    // Collapsing null into '' would make every run recorded before this shipped
    // look like a default-effort data point — poisoning the comparison the
    // column exists to make possible.
    const { CheckRunSchema } = await import('../../src/db/schemas.js');
    const base = {
      id: 'r1',
      topicId: 't1',
      startedAt: '2026-07-31T00:00:00.000Z',
      finishedAt: null,
      status: 'running' as const,
      newItems: 0,
      error: null,
    };
    // A row written before the column existed parses, and reads back as null.
    expect(CheckRunSchema.parse(base).effort).toBe(null);
    expect(CheckRunSchema.parse({ ...base, effort: '' }).effort).toBe('');
    expect(CheckRunSchema.parse({ ...base, effort: 'low' }).effort).toBe('low');
  });
});

describe('the effort list and AUTO_ORDER agree (NEWS-245)', () => {
  it('every provider `auto` can resolve to accepts an effort level', () => {
    // `auto` enables the control, which is a promise that the setting reaches
    // whatever actually runs. That holds today because AUTO_ORDER and
    // EFFORT_PROVIDERS coincide — a coincidence, not a law. Adding a provider
    // to AUTO_ORDER that ignores effort should fail here rather than leave the
    // control lying about what a check will do.
    for (const name of AUTO_ORDER) {
      expect(providerTakesEffort(name), `${name} is in AUTO_ORDER`).toBe(true);
    }
    expect(providerTakesEffort('auto')).toBe(true);
  });
});
