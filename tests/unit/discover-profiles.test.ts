/**
 * Reader profiles biasing discovery (NEWS-386, `docs/24-topic-discovery.md`).
 *
 * Three separable things, and each has its own way of going quietly wrong:
 *
 * - **Which requests get the bias.** Applying it to a scoped request is the
 *   failure mode — the user named what they wanted and got something adjacent.
 * - **The cache key.** Omitting the profiles there is invisible for ten minutes
 *   and then serves a spread aimed at who the user used to be.
 * - **The prompt.** The wording has to steer without filtering.
 */

import { describe, expect, it } from 'vitest';

import { buildSuggestPrompt } from '../../src/ai/suggest-prompt.js';
import type { SuggestRequest } from '../../src/ai/types.js';
import { cacheKeyFor, profilesApplyTo } from '../../src/discovery.js';

const base: SuggestRequest = { scope: { kind: 'describe', query: '' }, exclude: [] };

describe('which requests the profiles apply to', () => {
  it('applies to an empty box — the "surprise me" case', () => {
    // FR-24.3. This is the request the feature exists for: the answer was
    // previously identical for everyone.
    expect(profilesApplyTo({ kind: 'describe', query: '' })).toBe(true);
    expect(profilesApplyTo({ kind: 'describe', query: '   ' })).toBe(true);
  });

  it('does not apply once the user has typed what they want', () => {
    expect(profilesApplyTo({ kind: 'describe', query: 'fusion power' })).toBe(false);
  });

  it('applies to a bare section but not a drilled-in subcategory', () => {
    // "Anything in Business" is still a request for a spread; "Business ▸
    // Markets" is the user naming the thing, and re-ranking that is how the
    // FR-24.12a heading/label contradiction gets made on purpose.
    expect(profilesApplyTo({ kind: 'section', category: 'business', subcategory: null })).toBe(true);
    expect(profilesApplyTo({ kind: 'section', category: 'business', subcategory: 'markets' })).toBe(false);
  });

  it('never applies to a tuner round', () => {
    // The anchor *is* the scope — the user is six rounds into narrowing one
    // idea, and a profile steer there would undo the narrowing they paid for.
    expect(
      profilesApplyTo({ kind: 'tune', anchor: 'Formula 1', direction: 'narrower', kept: [], skipped: [], round: 2 }),
    ).toBe(false);
  });
});

describe('the cache key', () => {
  it('separates two different profile sets', () => {
    // Otherwise editing profiles serves the previous reader's spread for the
    // rest of the TTL — the same class of bug the exclusions-in-the-key note
    // under FR-24.15 exists to prevent.
    const a = cacheKeyFor({ ...base, profiles: ['Foodie'] }, 'anthropic||');
    const b = cacheKeyFor({ ...base, profiles: ['Gamer'] }, 'anthropic||');
    expect(a).not.toBe(b);
  });

  it('does not depend on the order the profiles arrive in', () => {
    const a = cacheKeyFor({ ...base, profiles: ['Foodie', 'Gamer'] }, 'anthropic||');
    const b = cacheKeyFor({ ...base, profiles: ['Gamer', 'Foodie'] }, 'anthropic||');
    expect(a).toBe(b);
  });

  it('treats absent and empty the same, so no-profiles does not split the cache', () => {
    expect(cacheKeyFor(base, 'anthropic||')).toBe(cacheKeyFor({ ...base, profiles: [] }, 'anthropic||'));
  });

  it('still separates on everything it separated on before', () => {
    // Guard against the new field displacing an existing one in the key.
    expect(cacheKeyFor(base, 'anthropic||')).not.toBe(cacheKeyFor(base, 'openai||'));
    expect(cacheKeyFor(base, 'anthropic||')).not.toBe(cacheKeyFor({ ...base, exclude: ['AI'] }, 'anthropic||'));
  });
});

describe('the prompt', () => {
  it('names the profiles when they apply', () => {
    const prompt = buildSuggestPrompt({ ...base, profiles: ['Foodie', 'Runner'] });
    expect(prompt).toContain('The user describes themselves as: Foodie, Runner.');
  });

  it('says nothing when there are none', () => {
    // Absent must leave the prompt as it was before the feature, or every
    // existing user's suggestions change on upgrade for no reason.
    for (const profiles of [undefined, []]) {
      const prompt = buildSuggestPrompt(profiles === undefined ? base : { ...base, profiles });
      expect(prompt).not.toContain('describes themselves');
    }
  });

  it('steers without filtering, and asks for spread rather than a monoculture', () => {
    // Both halves matter. Without "not a filter" the model returns only
    // on-profile ideas and discovery stops being able to surprise anyone; without
    // the spread instruction, ticking six profiles returns six variations on the
    // first one.
    const prompt = buildSuggestPrompt({ ...base, profiles: ['Foodie', 'Runner'] });
    expect(prompt).toContain('a steer, not a filter');
    expect(prompt).toContain('spread the suggestions across several');
  });

  it('keeps the exclusions doing their own job alongside it', () => {
    // FR-24.11 is untouched by this feature and must stay that way.
    const prompt = buildSuggestPrompt({ ...base, profiles: ['Foodie'], exclude: ['Sourdough'] });
    expect(prompt).toContain('The user ALREADY follows these');
    expect(prompt).toContain('- Sourdough');
  });
});
