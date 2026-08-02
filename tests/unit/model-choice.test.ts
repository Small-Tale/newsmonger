import { describe, expect, it } from 'vitest';

import { correctedModel, modelOptions, preferredModel } from '../../src/client/model-choice.js';

/**
 * Choosing a model for the picker (NEWS-253).
 *
 * Catalogues here are shaped like the real ones — newest first, as `rankModels`
 * and Codex's own `priority` deliver them — because "the most recent Haiku" is
 * only "the first token match" if that ordering holds.
 */
const OPENAI = [
  'gpt-5.6-luna',
  'gpt-5.6-terra',
  'gpt-5.6-sol',
  'gpt-5.5-pro',
  'gpt-5.5',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.4',
];
const CODEX = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'];
const CLAUDE_CLI = ['opus', 'sonnet', 'haiku', 'fable'];
const ANTHROPIC = ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'];

describe('preferredModel (NEWS-253)', () => {
  it('picks the small model for each provider family', () => {
    expect(preferredModel('openai', OPENAI)).toBe('gpt-5.4-mini');
    expect(preferredModel('codex-cli', CODEX)).toBe('gpt-5.4-mini');
    expect(preferredModel('anthropic', ANTHROPIC)).toBe('claude-haiku-4-5');
    expect(preferredModel('claude-cli', CLAUDE_CLI)).toBe('haiku');
  });

  it('takes the most recent of the family, not the first one named', () => {
    // The catalogue is newest-first, so a token match is a *version* match for
    // free — which is what stops this going stale the way `claude-opus-4-8` did.
    expect(preferredModel('anthropic', ['claude-haiku-5', 'claude-haiku-4-5'])).toBe('claude-haiku-5');
    expect(preferredModel('openai', ['gpt-6-mini', 'gpt-5.4-mini'])).toBe('gpt-6-mini');
  });

  it('is not fooled by a longer name containing the token', () => {
    // `gpt-5.1-codex-mini` is a mini; `gpt-5.4-nano` is not. Both would be
    // wrong to skip or to prefer respectively.
    expect(preferredModel('codex-cli', ['gpt-5.4-nano', 'gpt-5.1-codex-mini'])).toBe('gpt-5.1-codex-mini');
  });

  it('falls back to the newest model when no family member exists', () => {
    // A gateway, or a naming scheme nobody has seen yet. Something usable beats
    // nothing, and beats a hardcoded id that would be wrong on that endpoint.
    expect(preferredModel('openai', ['llama-4-70b', 'llama-3-8b'])).toBe('llama-4-70b');
  });

  it('answers empty when there is no catalogue to choose from', () => {
    expect(preferredModel('openai', [])).toBe('');
  });
});

describe('modelOptions (NEWS-253)', () => {
  it('offers the catalogue', () => {
    expect(modelOptions(OPENAI, 'gpt-5.5')).toEqual(OPENAI);
  });

  it('keeps a stored model the catalogue does not list', () => {
    // The concession the dropdown makes for what it takes away. The field was
    // free text so a gateway's own model id could be typed (FR-6.14); a strict
    // select must not *discard* such a setting the moment Settings is opened.
    const opts = modelOptions(OPENAI, 'my-gateway/custom-7b');
    expect(opts[0]).toBe('my-gateway/custom-7b');
    expect(opts).toHaveLength(OPENAI.length + 1);
  });

  it('does not add an entry for "no model chosen"', () => {
    expect(modelOptions(OPENAI, '')).toEqual(OPENAI);
  });

  it('never duplicates a listed model', () => {
    expect(modelOptions(OPENAI, 'gpt-5.4-mini').filter((m) => m === 'gpt-5.4-mini')).toHaveLength(1);
  });
});

describe('correctedModel (NEWS-253)', () => {
  it('replaces a model that belongs to another provider', () => {
    // The case the whole ticket exists for: switch Anthropic → OpenAI and the
    // stored Claude model would fail on the next check.
    expect(correctedModel('openai', 'claude-opus-4-8', OPENAI)).toBe('gpt-5.4-mini');
  });

  it('fills in when nothing is chosen', () => {
    expect(correctedModel('anthropic', '', ANTHROPIC)).toBe('claude-haiku-4-5');
  });

  it('leaves a valid choice alone', () => {
    // Switching provider is not consent to change a model that still works.
    // Silently "helping" here is the failure mode of automatic correction.
    expect(correctedModel('openai', 'gpt-5.6-sol', OPENAI)).toBeNull();
  });

  it('corrects nothing when the catalogue could not be fetched', () => {
    // Empty means "could not ask" — no key, a provider that cannot enumerate —
    // not "every model is invalid". Clobbering a working choice over a lookup
    // failure is the worse error by some distance.
    expect(correctedModel('openai', 'gpt-5.6-sol', [])).toBeNull();
    expect(correctedModel('openai', 'anything-at-all', [])).toBeNull();
    expect(correctedModel('openai', '', [])).toBeNull();
  });

  it('does not fire twice for the same state', () => {
    // Correcting to the value already stored would PATCH settings on every
    // provider refresh, and each PATCH triggers another refresh.
    expect(correctedModel('anthropic', 'claude-haiku-4-5', ANTHROPIC)).toBeNull();
  });

  it('survives a provider round trip', () => {
    // A sequence rather than one operation from a clean start: Anthropic →
    // OpenAI → Anthropic should land somewhere valid each time, not accumulate
    // a value from the provider before last.
    const first = correctedModel('openai', 'claude-haiku-4-5', OPENAI);
    expect(first).toBe('gpt-5.4-mini');
    const back = correctedModel('anthropic', first ?? '', ANTHROPIC);
    expect(back).toBe('claude-haiku-4-5');
    expect(correctedModel('anthropic', back ?? '', ANTHROPIC)).toBeNull();
  });
});

describe('correctedModel and the static fallback (NEWS-253)', () => {
  const FALLBACK = ['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'];

  it('fills in an empty model from the fallback when there is no catalogue', () => {
    // `''` is storable but not representable in a `<select>` — the control
    // would show its first option while the setting said "provider default".
    // So it is always filled, even with no key to fetch a catalogue with.
    expect(correctedModel('openai', '', [], FALLBACK)).toBe('gpt-5.4-mini');
  });

  it('prefers the live catalogue over the fallback when both exist', () => {
    expect(correctedModel('openai', '', OPENAI, FALLBACK)).toBe('gpt-5.4-mini');
    expect(correctedModel('anthropic', '', ANTHROPIC, FALLBACK)).toBe('claude-haiku-4-5');
  });

  it('never overrules a real choice against the fallback alone', () => {
    // The fallback is four entries and could never hold a gateway's own model
    // id. Correcting against it would clobber exactly the setting the old
    // free-text field existed to allow.
    expect(correctedModel('openai', 'my-gateway/custom-7b', [], FALLBACK)).toBeNull();
    expect(correctedModel('openai', 'gpt-5.2', [], FALLBACK)).toBeNull();
  });

  it('does overrule a stale choice once a live catalogue exists', () => {
    expect(correctedModel('openai', 'claude-opus-4-8', OPENAI, FALLBACK)).toBe('gpt-5.4-mini');
  });
});
