import { describe, expect, it } from 'vitest';

import {
  buildSuggestPrompt,
  MAX_SUGGESTIONS,
  parseSuggestResult,
  suggestSystemPrompt,
} from '../../src/ai/suggest-prompt.js';
import type { CategoryOption, SuggestRequest } from '../../src/ai/types.js';

/** Discovery prompting and result parsing (NEWS-124, docs/24-topic-discovery.md). */

const OPTIONS: CategoryOption[] = [
  { slug: 'sports', label: 'Sports', subcategories: [{ slug: 'motorsport', label: 'Motorsport' }] },
  { slug: 'technology', label: 'Technology', subcategories: [] },
];

function req(partial: Partial<SuggestRequest> & Pick<SuggestRequest, 'scope'>): SuggestRequest {
  return { exclude: [], ...partial };
}

describe('suggestSystemPrompt', () => {
  it('asks for both suggestion kinds and makes classification conditional', () => {
    const system = suggestSystemPrompt();
    expect(system).toContain('ongoing');
    expect(system).toContain('evergreen');
    // The classification fields must be opt-in, or a provider with structured
    // output gets asked for a taxonomy it was never given (FR-24.13).
    expect(system).toContain('If — and only if — the user message lists sections');
  });
});

describe('buildSuggestPrompt — the describe door', () => {
  it('carries the query through', () => {
    const prompt = buildSuggestPrompt(req({ scope: { kind: 'describe', query: 'i cycle and work in biotech' } }));
    expect(prompt).toContain('i cycle and work in biotech');
  });

  it('an empty query asks for breadth rather than erroring (FR-24.3)', () => {
    const prompt = buildSuggestPrompt(req({ scope: { kind: 'describe', query: '   ' } }));
    // "Surprise me" is a real request, and the breadth instruction is the whole
    // difference between it and an unprompted model reaching for its defaults.
    expect(prompt).toContain('has not said what they are interested in');
    expect(prompt).toContain('broad spread');
  });
});

describe('buildSuggestPrompt — the section door', () => {
  it('names both levels when a subcategory is chosen', () => {
    const prompt = buildSuggestPrompt(req({ scope: { kind: 'section', category: 'Sports', subcategory: 'Motorsport' } }));
    expect(prompt).toContain('"Motorsport" within the "Sports" section');
  });

  it('a null subcategory means the whole section', () => {
    const prompt = buildSuggestPrompt(req({ scope: { kind: 'section', category: 'Sports', subcategory: null } }));
    expect(prompt).toContain('ranging across the whole of it');
  });
});

describe('buildSuggestPrompt — the tuner', () => {
  const tune = (over: Partial<Extract<SuggestRequest['scope'], { kind: 'tune' }>> = {}): SuggestRequest =>
    req({
      scope: {
        kind: 'tune',
        anchor: 'Formula 1',
        direction: 'narrower',
        kept: [],
        skipped: [],
        round: 1,
        ...over,
      },
    });

  it('narrower and similar ask for different things', () => {
    expect(buildSuggestPrompt(tune({ direction: 'narrower' }))).toContain('NARROWER than "Formula 1"');
    expect(buildSuggestPrompt(tune({ direction: 'similar' }))).toContain('SIMILAR to "Formula 1"');
  });

  it('states the round so successive rounds are not identical prompts', () => {
    expect(buildSuggestPrompt(tune({ round: 3 }))).toContain('round 3');
  });

  it('sends skips as a steer, not merely as omissions (FR-24.6)', () => {
    const prompt = buildSuggestPrompt(tune({ kept: ['F1 tech rules'], skipped: ['Driver gossip'] }));
    expect(prompt).toContain('KEPT these');
    expect(prompt).toContain('F1 tech rules');
    expect(prompt).toContain('SKIPPED these');
    expect(prompt).toContain('Driver gossip');
    // The distinction that makes round three worth reaching: a skip rules out a
    // direction, so it must not be phrased as a simple exclusion list.
    expect(prompt).toContain('steer away from that direction');
  });

  it('caps a long keep/skip history rather than resending everything', () => {
    const many = Array.from({ length: 50 }, (_, i) => `skipped ${String(i)}`);
    const prompt = buildSuggestPrompt(tune({ skipped: many }));
    expect(prompt).not.toContain('skipped 0');
    expect(prompt).toContain('skipped 49');
  });
});

describe('buildSuggestPrompt — shared parts', () => {
  it('lists exclusions as the first FR-24.11 layer', () => {
    const prompt = buildSuggestPrompt(
      req({ scope: { kind: 'describe', query: 'cycling' }, exclude: ['Pro cycling', 'Tour de France'] }),
    );
    expect(prompt).toContain('ALREADY follows');
    expect(prompt).toContain('- Pro cycling');
    expect(prompt).toContain('- Tour de France');
  });

  it('offers the taxonomy by slug, and omits it entirely when not asked', () => {
    const withOptions = buildSuggestPrompt(
      req({ scope: { kind: 'describe', query: 'x' }, categoryOptions: OPTIONS }),
    );
    expect(withOptions).toContain('Motorsport (motorsport)');
    expect(withOptions).toContain('Use the slug');

    const without = buildSuggestPrompt(req({ scope: { kind: 'describe', query: 'x' } }));
    expect(without).not.toContain('Use the slug');
  });

  it('clamps the requested limit to the hard cap', () => {
    const prompt = buildSuggestPrompt(req({ scope: { kind: 'describe', query: 'x' }, limit: 500 }));
    expect(prompt).toContain(`up to ${String(MAX_SUGGESTIONS)} suggestions`);
  });
});

describe('parseSuggestResult', () => {
  const one = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      suggestions: [{ name: 'Formula 1', reason: 'Race weekends', kind: 'evergreen', ...over }],
    });

  it('reads a bare JSON object', () => {
    const [s] = parseSuggestResult(one());
    expect(s.name).toBe('Formula 1');
    expect(s.kind).toBe('evergreen');
    expect(s.classification).toBeNull();
  });

  it('prefers the last fenced block, as parseNewsResult does', () => {
    const text = `thinking\n\`\`\`json\n${one({ name: 'Draft' })}\n\`\`\`\nrevised:\n\`\`\`json\n${one({ name: 'Final' })}\n\`\`\``;
    expect(parseSuggestResult(text)[0].name).toBe('Final');
  });

  it('returns the classification when the model supplied one', () => {
    const [s] = parseSuggestResult(one({ category: 'sports', subcategory: 'motorsport' }));
    expect(s.classification).toEqual({ category: 'sports', subcategory: 'motorsport' });
  });

  it('does NOT validate the slug against a taxonomy — that is the caller’s job (FR-24.13)', () => {
    // This module has no access to the live table. A bogus slug must survive
    // parsing and be dropped later, not fail the parse and lose the batch.
    const [s] = parseSuggestResult(one({ category: 'not-a-real-category' }));
    expect(s.classification).toEqual({ category: 'not-a-real-category', subcategory: null });
  });

  it('a malformed kind degrades to evergreen instead of failing the batch', () => {
    expect(parseSuggestResult(one({ kind: 'sometimes' }))[0].kind).toBe('evergreen');
  });

  it('a missing guidance becomes an empty string, not undefined', () => {
    expect(parseSuggestResult(one())[0].guidance).toBe('');
  });

  it('strips the citation markup the tool layer emits despite the prompt', () => {
    // Same treatment `parseNewsResult` gives titles and summaries: the tags come
    // from the web_search tool, not the model's cooperation, so the prompt can't
    // suppress them. Bracket footnotes are left alone — they are indistinguishable
    // from ordinary prose brackets.
    const [s] = parseSuggestResult(
      one({ name: '<cite index="4">Formula 1</cite>', reason: 'Race weekends &amp; team politics' }),
    );
    expect(s.name).toBe('Formula 1');
    expect(s.reason).toBe('Race weekends & team politics');
  });

  it('caps an over-long list', () => {
    const many = JSON.stringify({
      suggestions: Array.from({ length: 40 }, (_, i) => ({
        name: `Topic ${String(i)}`,
        reason: 'r',
        kind: 'ongoing',
      })),
    });
    expect(parseSuggestResult(many)).toHaveLength(MAX_SUGGESTIONS);
  });

  it('throws when nothing parseable is present', () => {
    expect(() => parseSuggestResult('I could not think of any topics.')).toThrow(/could not parse/);
  });

  it('throws rather than returning junk when a suggestion has no name', () => {
    expect(() => parseSuggestResult(JSON.stringify({ suggestions: [{ reason: 'r', kind: 'ongoing' }] }))).toThrow(
      /could not parse/,
    );
  });
});
