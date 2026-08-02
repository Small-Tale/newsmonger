import { describe, expect, it } from 'vitest';

import { rankModels } from '../../src/ai/model-list.js';
import { createAnthropicProvider } from '../../src/ai/providers/anthropic.js';
import { parseAnthropicEfforts, parseAnthropicModels } from '../../src/ai/providers/anthropic-models.js';

/**
 * Anthropic's catalogue (NEWS-251).
 *
 * **Where this fixture comes from matters, so it is stated plainly.** The other
 * two providers' fixtures are captured payloads — 131 real entries from
 * OpenAI's `/v1/models`, a real `~/.codex/models_cache.json`. There is no
 * Anthropic key on this machine, so this one is built from the SDK's **own
 * generated type declarations**: `ModelInfo` (`id`, `created_at` as an RFC 3339
 * string, `display_name`, `capabilities`) and `EffortCapability` (`low`,
 * `medium`, `high`, `max`, and a nullable `xhigh`, each `{ supported }`).
 *
 * That is a better source than memory — it is generated from Anthropic's spec,
 * and in NEWS-250 the same declarations settled a question I had wrongly
 * written off as unanswerable — but it is **not a captured response**, and the
 * difference is worth keeping visible: these tests prove the parsing handles
 * the declared shape, not that the wire matches the declaration.
 */
const CATALOGUE = {
  data: [
    {
      id: 'claude-opus-4-8',
      display_name: 'Claude Opus 4.8',
      created_at: '2026-02-11T00:00:00Z',
      capabilities: {
        effort: {
          supported: true,
          low: { supported: true },
          medium: { supported: true },
          high: { supported: true },
          xhigh: { supported: true },
          max: { supported: true },
        },
      },
    },
    {
      id: 'claude-sonnet-5',
      display_name: 'Claude Sonnet 5',
      created_at: '2025-11-24T00:00:00Z',
      capabilities: {
        effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: null, max: { supported: false } },
      },
    },
    {
      id: 'claude-haiku-4-5',
      display_name: 'Claude Haiku 4.5',
      created_at: '2025-10-01T00:00:00Z',
      // Haiku 4.5 rejects `output_config.effort` outright — the reason
      // discovery must never inherit the setting (FR-6.12).
      capabilities: { effort: { supported: false, low: { supported: false } } },
    },
  ],
};

describe('parseAnthropicModels (NEWS-251)', () => {
  it('converts RFC 3339 to the epoch seconds the ranking sorts on', () => {
    // Anthropic dates its models with a datetime string; OpenAI uses epoch
    // seconds. Converting here keeps `rankModels` vendor-agnostic, which is the
    // property that makes it immune to model naming.
    const parsed = parseAnthropicModels(CATALOGUE);
    expect(parsed[0]).toEqual({ id: 'claude-opus-4-8', created: Date.parse('2026-02-11T00:00:00Z') / 1000 });
  });

  it('ranks newest first through the shared ranking', () => {
    expect(rankModels(parseAnthropicModels(CATALOGUE))).toEqual([
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-haiku-4-5',
    ]);
  });

  it('keeps a model whose date it cannot read', () => {
    // Sorted last by `rankModels`, but offered: a date this app cannot parse is
    // not evidence the model is bad, and dropping it would be inferring quality
    // from metadata — the habit NEWS-243/248 exist to break.
    const parsed = parseAnthropicModels({ data: [{ id: 'mystery' }, { id: 'dated', created_at: 'not-a-date' }] });
    expect(parsed).toEqual([{ id: 'mystery' }, { id: 'dated' }]);
    expect(rankModels(parsed)).toEqual(['mystery', 'dated']);
  });

  it('accepts a bare array as well as a page', () => {
    // The SDK's pagination hands back an object with `data`; a caller holding
    // the array should not have to know the difference.
    expect(parseAnthropicModels([{ id: 'a' }])).toEqual([{ id: 'a' }]);
  });
});

describe('parseAnthropicEfforts (NEWS-251)', () => {
  it('reads the levels a model declares', () => {
    expect(parseAnthropicEfforts(CATALOGUE, 'claude-opus-4-8')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('honours per-level support, including a null xhigh', () => {
    // `xhigh` is nullable in the SDK's own declaration and `max` may be
    // unsupported — so the answer really does narrow per model, which is the
    // whole point of NEWS-250.
    expect(parseAnthropicEfforts(CATALOGUE, 'claude-sonnet-5')).toEqual(['low', 'medium', 'high']);
  });

  it('answers **empty** for a model that does no effort at all', () => {
    // Not `null`. Haiku 4.5 says `effort.supported: false` and rejects
    // `output_config.effort` outright, so this is an answer — and NEWS-254
    // makes the caller switch the control *off* on it. Returning `null` would
    // fall back to the provider union and open the menu up on exactly the model
    // that cannot use it.
    expect(parseAnthropicEfforts(CATALOGUE, 'claude-haiku-4-5')).toEqual([]);
  });

  it('answers **null** for an unknown model or a payload without capabilities', () => {
    // "I cannot say", which is a different thing from "takes none" — the caller
    // falls back to the provider union here rather than disabling the control.
    expect(parseAnthropicEfforts(CATALOGUE, 'no-such-model')).toBeNull();
    expect(parseAnthropicEfforts({ data: [{ id: 'x' }] }, 'x')).toBeNull();
  });
});

describe('a catalogue we cannot fetch degrades quietly', () => {
  it.each([
    ['null', null],
    ['not an object', 7],
    ['no data key', { object: 'list' }],
    ['data not an array', { data: 'nope' }],
    ['entries without an id', { data: [{ display_name: 'Claude' }] }],
  ])('%s yields no models', (_label, body) => {
    expect(parseAnthropicModels(body)).toEqual([]);
    // `null` — a payload we cannot read tells us nothing about effort, which is
    // not the same as telling us there is none (NEWS-254).
    expect(parseAnthropicEfforts(body, 'anything')).toBeNull();
  });
});

describe('the provider wiring (NEWS-251)', () => {
  const runner = (over: Record<string, unknown> = {}) => ({
    run: () => Promise.resolve({ text: JSON.stringify({ items: [] }), usage: null }),
    ...over,
  });

  it('offers the catalogue, newest first', async () => {
    const p = createAnthropicProvider({ runner: runner({ listCatalogue: () => Promise.resolve(CATALOGUE) }) });
    expect(await p.listModels?.()).toEqual(['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5']);
  });

  it('fetches the catalogue once for both questions', async () => {
    // `/api/models` asks for models and effort levels together. Without the
    // memo one Settings tab would cost two identical round trips.
    let calls = 0;
    const p = createAnthropicProvider({
      runner: runner({
        listCatalogue: () => {
          calls++;
          return Promise.resolve(CATALOGUE);
        },
      }),
    });
    await Promise.all([p.listModels?.(), p.effortLevelsFor?.('claude-opus-4-8')]);
    await p.listModels?.();
    expect(calls).toBe(1);
  });

  it('falls back to the provider union when the catalogue cannot be fetched', async () => {
    // No key, an outage, a rate limit. Memoised as "no catalogue" rather than
    // retried on every call — a provider that cannot enumerate should not keep
    // paying to rediscover that.
    const p = createAnthropicProvider({
      runner: runner({ listCatalogue: () => Promise.reject(new Error('401 authentication_error')) }),
    });
    expect(await p.listModels?.()).toEqual([]);
    // `null`, and `CheckRunner.modelOptions` is what turns that into the
    // provider union (NEWS-254) — the provider itself does not guess.
    expect(await p.effortLevelsFor?.('claude-opus-4-8')).toBeNull();
  });

  it('falls back for a runner that cannot enumerate at all', async () => {
    // Every existing fake runner in the suite is this shape, so it must not
    // become a required method.
    const p = createAnthropicProvider({ runner: runner() });
    expect(await p.listModels?.()).toEqual([]);
    expect(await p.effortLevelsFor?.('x')).toBeNull();
  });
});
