import { describe, expect, it } from 'vitest';

import type { RunOptions } from '../../src/ai/providers/anthropic.js';
import { createAnthropicProvider, messageParams } from '../../src/ai/providers/anthropic.js';

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
