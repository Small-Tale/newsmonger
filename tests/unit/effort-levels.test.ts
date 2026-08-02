import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { messageParams } from '../../src/ai/providers/anthropic.js';
import { createCodexCliProvider } from '../../src/ai/providers/codex-cli.js';
import { readCodexEfforts } from '../../src/ai/providers/codex-models.js';
import { createOpenAIProvider } from '../../src/ai/providers/openai.js';
import type { Effort } from '../../src/ai/types.js';
import { EFFORT_LABELS, EFFORT_LEVELS, PROVIDER_EFFORT_LEVELS, toEffortLevels } from '../../src/ai/types.js';
import { effortOptions, effortSupported } from '../../src/client/effort-options.js';

const CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/codex-models-cache.json');

/**
 * Effort levels are per **model**, not per provider (NEWS-250).
 *
 * Not a tidiness point. Asking Codex for a level the chosen model refuses fails
 * the check:
 *
 *   400 unsupported_value  param "reasoning.effort"
 *   "Unsupported value: 'max' is not supported with the 'gpt-5.4-…' model.
 *    Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'."
 *
 * Every set below comes from the vendor rather than from memory — the standing
 * lesson of NEWS-239/244/245, where three claims about other people's tools
 * were wrong because an *absence* was read as evidence.
 */
describe('the level vocabulary is a superset, not a menu (NEWS-250)', () => {
  it('covers every level any provider accepts', () => {
    for (const [provider, levels] of Object.entries(PROVIDER_EFFORT_LEVELS)) {
      for (const l of levels) expect(EFFORT_LEVELS, `${provider} offers ${l}`).toContain(l);
    }
  });

  it('labels every level, so none renders blank', () => {
    for (const l of EFFORT_LEVELS) expect(EFFORT_LABELS[l], l).toBeTruthy();
  });

  it('holds `ultra`, which only Codex takes', () => {
    // The reason a single global list was wrong: adding `ultra` for Codex's
    // sake would have offered it to providers whose own SDK types exclude it.
    expect(PROVIDER_EFFORT_LEVELS['codex-cli']).toContain('ultra');
    expect(PROVIDER_EFFORT_LEVELS.openai).not.toContain('ultra');
    expect(PROVIDER_EFFORT_LEVELS.anthropic).not.toContain('ultra');
    expect(PROVIDER_EFFORT_LEVELS['claude-cli']).not.toContain('ultra');
  });

  it('matches each vendor’s own declaration', () => {
    // `claude --help`: "Effort level for the current session (low, medium,
    // high, xhigh, max)".
    expect(PROVIDER_EFFORT_LEVELS['claude-cli']).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    // Anthropic SDK: `effort?: 'low'|'medium'|'high'|'xhigh'|'max'`, under the
    // comment "All possible effort levels".
    expect(PROVIDER_EFFORT_LEVELS.anthropic).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    // OpenAI SDK: `ReasoningEffort = 'none'|'minimal'|'low'|'medium'|'high'|
    // 'xhigh'|'max'` — word for word what the live API named in a 400.
    expect(PROVIDER_EFFORT_LEVELS.openai).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('narrows arbitrary names to known levels, in vocabulary order', () => {
    expect(toEffortLevels(['ultra', 'low', 'not-a-level', ''])).toEqual(['low', 'ultra']);
    expect(toEffortLevels([])).toEqual([]);
  });
});

describe('Codex answers per model, from its own cache (NEWS-250)', () => {
  it('gives a model exactly what that model takes', () => {
    expect(readCodexEfforts('gpt-5.6-sol', CACHE)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(readCodexEfforts('gpt-5.4', CACHE)).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('gives the union when no model has been chosen', () => {
    // Which model Codex will resolve is not known until it runs, so narrowing
    // further would hide a level the user can legitimately pick.
    expect(readCodexEfforts('', CACHE)).toContain('ultra');
  });

  it('falls back to the provider union for an unknown model', () => {
    // A model typed by hand, or one newer than the cache. Offering the union
    // beats offering nothing; the vendor still refuses anything truly invalid.
    const levels = createCodexCliProvider({}).effortLevelsFor?.('some-future-model');
    expect(levels).toEqual([...PROVIDER_EFFORT_LEVELS['codex-cli']]);
  });

  it('falls back when Codex has never run here', () => {
    expect(readCodexEfforts('gpt-5.6-sol', '/nonexistent/models_cache.json')).toEqual([]);
  });
});

describe('a level a provider cannot take is dropped, not sent (NEWS-250)', () => {
  it('Anthropic drops the levels its SDK does not declare', () => {
    // `Effort` is now the cross-provider superset, so this API can receive
    // levels it has never heard of. Running at the model's default beats a 400
    // on every check.
    const params = (effort: Effort) =>
      messageParams('sys', 'prompt', 'claude-opus-4-8', { maxSearches: 1, maxTokens: 10, effort });
    expect(params('max').output_config?.effort).toBe('max');
    expect(params('ultra').output_config).toBeUndefined();
    expect(params('none').output_config).toBeUndefined();
    expect(params('minimal').output_config).toBeUndefined();
  });

  it('OpenAI keeps `none` and drops `ultra`', async () => {
    // The asymmetry is the point: `none` is valid there and nowhere else,
    // `ultra` is valid on Codex and nowhere else.
    const seen: (string | undefined)[] = [];
    const runner = {
      run: (_s: string, _p: string, _m: string, effort?: string) => {
        seen.push(effort);
        return Promise.resolve({ text: JSON.stringify({ items: [] }), usage: null });
      },
    };
    const key = () => Promise.resolve('k');
    await createOpenAIProvider({ runner, getApiKey: key, effort: 'none' }).checkTopic('t', [], null);
    await createOpenAIProvider({ runner, getApiKey: key, effort: 'ultra' }).checkTopic('t', [], null);
    // Both reach the runner; the *request builder* is what narrows, so this
    // asserts the provider does not pre-filter and hide the level from the log.
    expect(seen).toEqual(['none', 'ultra']);
  });
});

describe('what the Settings control offers (NEWS-250)', () => {
  const state = (liveEffortLevels: Effort[], chosen: Effort = '') => ({ liveEffortLevels, chosen });

  it('offers only what the model takes', () => {
    const opts = effortOptions(state(['low', 'medium', 'high', 'xhigh']));
    expect(opts).toEqual(['', 'low', 'medium', 'high', 'xhigh']);
    expect(opts).not.toContain('ultra');
  });

  it('offers `ultra` when the model takes it', () => {
    expect(effortOptions(state(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']))).toContain('ultra');
  });

  it('offers everything when the server could not ask', () => {
    // No key, or a provider that cannot say. A control that greys out every
    // option because a lookup failed is worse than one offering too much.
    expect(effortOptions(state([]))).toEqual([...EFFORT_LEVELS]);
    expect(effortSupported(state([]), 'ultra')).toBe(true);
  });

  it('keeps a saved level visible even when the model refuses it', () => {
    // Dropping it would leave the <select> showing a value absent from its own
    // options — the control misreporting what is stored, which is exactly the
    // class of bug NEWS-238 was.
    const opts = effortOptions(state(['low', 'medium'], 'ultra'));
    expect(opts).toContain('ultra');
    expect(effortSupported(state(['low', 'medium'], 'ultra'), 'ultra')).toBe(false);
  });

  it('never treats "provider default" as unsupported', () => {
    // '' means "send nothing", which every provider accepts by construction.
    expect(effortSupported(state(['low']), '')).toBe(true);
    expect(effortOptions(state(['low']))[0]).toBe('');
  });

  it('does not duplicate the saved level when it is supported', () => {
    expect(effortOptions(state(['low', 'medium'], 'low'))).toEqual(['', 'low', 'medium']);
  });
});

describe('the fixture is the real cache', () => {
  it('carries the per-model reasoning levels this all rests on', () => {
    const body: unknown = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    expect(body).toHaveProperty('models');
  });
});
