import { describe, expect, it } from 'vitest';

import type { TopicSuggestion } from '../../src/api/schemas.js';
import { MAX_TUNE_ROUNDS } from '../../src/api/schemas.js';
import type { SuggestionGroup, TunerState } from '../../src/client/discover.js';
import {
  currentCandidate,
  groupSuggestions,
  judgeCandidate,
  kindLabel,
  mergeKept,
  nextRound,
  providerLikelyUsable,
  resultsHeading,
  resultsQualifier,
  sectionFor,
  sectionTiles,
  startTuner,
  tunerRationale,
} from '../../src/client/discover.js';

/** The pure half of the discovery dialog (NEWS-126). */

function suggestion(name: string, category: string | null, subcategory: string | null = null): TopicSuggestion {
  return {
    name,
    reason: 'because',
    kind: 'evergreen',
    guidance: '',
    classification: category === null ? null : { category, subcategory },
  };
}

describe('sectionTiles', () => {
  it('offers the whole taxonomy', () => {
    const tiles = sectionTiles();
    expect(tiles).toHaveLength(11);
    expect(tiles.map((t) => t.slug)).toContain('sports');
  });

  it('resolves a section by slug, and nothing for a slug that is not one', () => {
    expect(sectionFor('sports')?.label).toBe('Sports');
    expect(sectionFor('not-a-section')).toBeUndefined();
  });
});

describe('groupSuggestions', () => {
  it('groups by section and labels with the same wording the filter bar uses', () => {
    const groups = groupSuggestions([
      suggestion('Formula 1', 'sports', 'motorsport'),
      suggestion('MotoGP', 'sports', 'motorsport'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Sports · Motorsport');
    expect(groups[0].suggestions.map((s) => s.name)).toEqual(['Formula 1', 'MotoGP']);
  });

  it('separates two subcategories of the same section', () => {
    const groups = groupSuggestions([
      suggestion('Formula 1', 'sports', 'motorsport'),
      suggestion('Premier League', 'sports', 'soccer'),
    ]);
    expect(groups.map((g) => g.label)).toEqual(['Sports · Soccer', 'Sports · Motorsport']);
  });

  it('labels a category with no subcategory as Other, not as unclassified', () => {
    // A topic can legitimately belong to a section without matching any of its
    // subsections (FR-22.6), and that is a different thing from unclassified.
    const [group] = groupSuggestions([suggestion('Skiing', 'sports', null)]);
    expect(group.label).toBe('Sports · Other');
  });

  it('orders by the taxonomy, not by the order the model returned', () => {
    // Browsing twice must not reshuffle the page.
    const groups = groupSuggestions([
      suggestion('Skiing', 'sports', null),
      suggestion('EU AI Act', 'technology', 'ai'),
      suggestion('Elections', 'politics', 'elections'),
    ]);
    expect(groups.map((g) => g.label)).toEqual(['Politics · Elections', 'Technology · AI', 'Sports · Other']);
  });

  it('sorts unclassified last, so it never buries the rest', () => {
    const groups = groupSuggestions([suggestion('Something odd', null), suggestion('Formula 1', 'sports', 'motorsport')]);
    expect(groups.map((g) => g.label)).toEqual(['Sports · Motorsport', 'Uncategorized']);
  });

  it('renders a suggestion whose slug went stale rather than dropping it', () => {
    // The server validates against the same table, so this shouldn't happen —
    // but losing a suggestion the user might have wanted is the worse failure.
    const [group] = groupSuggestions([suggestion('Mystery', 'not-a-real-category')]);
    expect(group.label).toBe('Uncategorized');
    expect(group.suggestions).toHaveLength(1);
  });

  it('gives every group a key distinct from its label', () => {
    const groups = groupSuggestions([suggestion('Skiing', 'sports', null), suggestion('Something', null)]);
    expect(new Set(groups.map((g) => g.key)).size).toBe(2);
  });

  it('returns nothing for nothing', () => {
    expect(groupSuggestions([])).toEqual([]);
  });
});

describe('resultsHeading', () => {
  it('quotes what the user actually typed', () => {
    expect(resultsHeading({ kind: 'describe', query: 'i cycle' })).toContain('i cycle');
  });

  it('reads an empty query as a deliberate answer, not a failed search (FR-24.3)', () => {
    expect(resultsHeading({ kind: 'describe', query: '   ' })).toBe('A bit of everything');
  });

  it('names both taxonomy levels, or the whole section', () => {
    expect(resultsHeading({ kind: 'section', category: 'sports', subcategory: 'motorsport' })).toBe('Sports · Motorsport');
    expect(resultsHeading({ kind: 'section', category: 'sports', subcategory: null })).toBe('Anything in Sports');
  });

  it('degrades rather than throwing on a slug that is not a section', () => {
    expect(resultsHeading({ kind: 'section', category: 'nope', subcategory: null })).toBe('Suggestions');
    expect(resultsHeading({ kind: 'section', category: 'sports', subcategory: 'nope' })).toBe('Sports');
  });
});

describe('kindLabel', () => {
  it('distinguishes a story that will end from a subject that will not', () => {
    expect(kindLabel('ongoing')).toBe('Ongoing story');
    expect(kindLabel('evergreen')).toBe('Evergreen');
  });
});

/**
 * The tuner state machine (NEWS-127).
 *
 * Written as *sequences* rather than single operations, per the project's
 * transition-matrix rule: every interesting failure here lives in an ordering —
 * a queue draining, a bound arriving, a verdict landing twice — and none of them
 * are reachable by testing each operation from a clean start.
 */

function candidate(name: string): TopicSuggestion {
  return { name, reason: 'r', kind: 'evergreen', guidance: '', classification: null };
}

function loaded(names: string[], over: Partial<TunerState> = {}): TunerState {
  return { ...startTuner('Formula 1', 'narrower'), queue: names.map(candidate), loading: false, ...over };
}

describe('the tuner state machine', () => {
  it('starts on round 1 with nothing judged', () => {
    const tuner = startTuner('Formula 1', 'similar');
    expect(tuner.round).toBe(1);
    expect(tuner.kept).toEqual([]);
    expect(tuner.skipped).toEqual([]);
    expect(tuner.loading).toBe(true);
  });

  it('walks a round one candidate at a time', () => {
    let tuner = loaded(['a', 'b', 'c']);
    expect(currentCandidate(tuner)?.name).toBe('a');

    let step = judgeCandidate(tuner, 'keep');
    tuner = step.tuner;
    expect(step.next).toBe('continue');
    expect(currentCandidate(tuner)?.name).toBe('b');

    step = judgeCandidate(tuner, 'skip');
    tuner = step.tuner;
    expect(currentCandidate(tuner)?.name).toBe('c');
    expect(tuner.kept.map((s) => s.name)).toEqual(['a']);
    expect(tuner.skipped).toEqual(['b']);
  });

  it('asks for another round once the queue drains', () => {
    const step = judgeCandidate(loaded(['only']), 'keep');
    expect(step.next).toBe('fetch-round');
  });

  it('keeps the accumulated verdicts across a round boundary (FR-24.6)', () => {
    // The skips are the half a naive implementation drops, and they are what
    // makes round three worth reaching.
    let tuner = loaded(['a', 'b']);
    tuner = judgeCandidate(tuner, 'keep').tuner;
    tuner = judgeCandidate(tuner, 'skip').tuner;
    tuner = nextRound(tuner, [candidate('c')]);

    expect(tuner.round).toBe(2);
    expect(tuner.index).toBe(0);
    expect(tuner.kept.map((s) => s.name)).toEqual(['a']);
    expect(tuner.skipped).toEqual(['b']);
    expect(currentCandidate(tuner)?.name).toBe('c');
  });

  it('stops at the round bound instead of looping forever (FR-24.9)', () => {
    // Every round is a billable call, so "it ends by itself" is a cost property,
    // not a nicety.
    let tuner = loaded(['a'], { round: MAX_TUNE_ROUNDS });
    const step = judgeCandidate(tuner, 'skip');
    tuner = step.tuner;
    expect(step.next).toBe('exhausted');
    expect(tuner.round).toBe(MAX_TUNE_ROUNDS);
  });

  it('runs the whole way to the bound without drifting', () => {
    let tuner = loaded(['r1']);
    for (let round = 1; round < MAX_TUNE_ROUNDS; round++) {
      const step = judgeCandidate(tuner, 'keep');
      expect(step.next).toBe('fetch-round');
      tuner = nextRound(step.tuner, [candidate(`r${String(round + 1)}`)]);
      expect(tuner.round).toBe(round + 1);
    }
    expect(judgeCandidate(tuner, 'keep').next).toBe('exhausted');
    expect(tuner.kept).toHaveLength(MAX_TUNE_ROUNDS - 1);
  });

  it('ignores a verdict on a drained queue', () => {
    // What a double-click on the last card is. It must not push a phantom entry
    // or advance a round on its own.
    const drained = judgeCandidate(loaded(['only']), 'keep').tuner;
    const again = judgeCandidate(drained, 'keep');
    expect(again.tuner.kept).toHaveLength(1);
    expect(again.tuner.index).toBe(1);
    expect(again.next).toBe('fetch-round');
  });

  it('skipping every candidate still advances, and records every skip', () => {
    let tuner = loaded(['a', 'b', 'c']);
    for (let i = 0; i < 3; i++) tuner = judgeCandidate(tuner, 'skip').tuner;
    expect(tuner.kept).toEqual([]);
    expect(tuner.skipped).toEqual(['a', 'b', 'c']);
    expect(currentCandidate(tuner)).toBeUndefined();
  });
});

describe('tunerRationale (FR-24.8)', () => {
  it('cites what was kept, most recent first-hand', () => {
    const tuner = loaded(['x'], { kept: [candidate('AI policy'), candidate('Chip design')] });
    expect(tunerRationale(tuner)).toBe('because you kept: AI policy, Chip design');
  });

  it('cites only the most recent few, so the line stays readable', () => {
    const kept = ['a', 'b', 'c', 'd', 'e'].map(candidate);
    expect(tunerRationale(loaded(['x'], { kept }))).toBe('because you kept: c, d, e');
  });

  it('falls back to the anchor in round one, when nothing is kept yet', () => {
    expect(tunerRationale(startTuner('Formula 1', 'narrower'))).toContain('narrower than');
    expect(tunerRationale(startTuner('Formula 1', 'similar'))).toContain('similar to');
  });

  // NEWS-269. A set-level tune anchors on the *heading*, and a heading can be the
  // same string as a topic in the list — which shipped a card titled
  // "Semiconductor supply chain" explaining itself as `narrower than
  // “Semiconductor supply chain”`.
  it('says nothing rather than something circular about the candidate', () => {
    const tuner = loaded(['Formula 1']); // anchor is 'Formula 1' too
    expect(tunerRationale(tuner)).toBe('');
  });

  it('ignores surrounding whitespace when deciding that', () => {
    expect(tunerRationale(loaded(['  Formula 1  ']))).toBe('');
  });

  it('still cites the anchor for a genuinely different candidate', () => {
    expect(tunerRationale(loaded(['Formula 1 tyre rules']))).toContain('narrower than');
  });

  it('a kept citation wins even when the candidate matches the anchor', () => {
    // The kept list is the better explanation whenever there is one, and it is
    // never circular — so the suppression must not swallow it.
    const tuner = loaded(['Formula 1'], { kept: [candidate('AI policy')] });
    expect(tunerRationale(tuner)).toBe('because you kept: AI policy');
  });
});

describe('resultsQualifier (NEWS-269)', () => {
  const group = (key: string): SuggestionGroup => ({ key, label: key, suggestions: [candidate('x')] });

  it('flags a section drill-in whose results file themselves elsewhere', () => {
    // The observed bug: a "Business · Markets" heading over a lone result grouped
    // under "Business · Other". Both labels are true; presented as peers they
    // read as the filter having failed.
    const source = { kind: 'section' as const, category: 'business', subcategory: 'markets' };
    expect(resultsQualifier(source, [group('business/other')])).toBe('closest matches');
  });

  it('says nothing when every group matches the section asked for', () => {
    const source = { kind: 'section' as const, category: 'business', subcategory: 'markets' };
    expect(resultsQualifier(source, [group('business/markets')])).toBe('');
  });

  it('flags a partial match, since one stray group is the confusing case', () => {
    const source = { kind: 'section' as const, category: 'business', subcategory: 'markets' };
    expect(resultsQualifier(source, [group('business/markets'), group('business/other')])).toBe('closest matches');
  });

  it('handles a whole-section drill-in, where no subcategory was asked for', () => {
    const source = { kind: 'section' as const, category: 'business', subcategory: null };
    expect(resultsQualifier(source, [group('business/')])).toBe('');
    expect(resultsQualifier(source, [group('business/markets')])).toBe('closest matches');
  });

  it('says nothing for free text or an empty result', () => {
    // A query has no section to disagree with, and an empty list has nothing to
    // qualify — a note there would be noise on an already-empty pane.
    expect(resultsQualifier({ kind: 'describe', query: 'cycling' }, [group('sports/')])).toBe('');
    expect(resultsQualifier({ kind: 'section', category: 'business', subcategory: 'markets' }, [])).toBe('');
    expect(resultsQualifier(null, [group('business/other')])).toBe('');
  });
});

describe('mergeKept (FR-24.7)', () => {
  it('appends kept suggestions to the list rather than creating them', () => {
    const merged = mergeKept([candidate('existing')], [candidate('kept')]);
    expect(merged.map((s) => s.name)).toEqual(['existing', 'kept']);
  });

  it('does not duplicate one that is already in the list', () => {
    // The user can keep something they already added from the list; reverting
    // that card to an un-added duplicate is the bug this prevents.
    const merged = mergeKept([candidate('Formula 1')], [candidate('Formula 1')]);
    expect(merged).toHaveLength(1);
  });

  it('does not duplicate one kept twice across rounds', () => {
    const merged = mergeKept([], [candidate('dup'), candidate('dup')]);
    expect(merged).toHaveLength(1);
  });

  it('preserves list order so nothing reshuffles under the user', () => {
    const merged = mergeKept([candidate('a'), candidate('b')], [candidate('c')]);
    expect(merged.map((s) => s.name)).toEqual(['a', 'b', 'c']);
  });
});

describe('providerLikelyUsable (NEWS-128)', () => {
  const state = (provider: string, available: Record<string, boolean>) => ({
    settings: { provider },
    providers: Object.entries(available).map(([name, ok]) => ({ name, available: ok })),
  });

  it('auto is usable when any provider in the automatic order is', () => {
    expect(providerLikelyUsable(state('auto', { 'claude-cli': true }))).toBe(true);
    expect(providerLikelyUsable(state('auto', { openai: true }))).toBe(true);
  });

  it('auto is not usable when nothing in that order is available', () => {
    expect(providerLikelyUsable(state('auto', { 'claude-cli': false, openai: false }))).toBe(false);
  });

  it('mock never counts, because it always reports itself available', () => {
    // Counting it would make an unconfigured app look ready — the same reason
    // the onboarding auto-open decision excludes it.
    expect(providerLikelyUsable(state('auto', { mock: true }))).toBe(false);
  });

  it('an explicitly chosen provider must itself be available', () => {
    // The case a bare "is anything available?" gets wrong: someone who picked
    // OpenAI and has no key would be offered a button that cannot work, because
    // an unrelated signed-in CLI happens to be present.
    expect(providerLikelyUsable(state('openai', { 'claude-cli': true, openai: false }))).toBe(false);
    expect(providerLikelyUsable(state('openai', { openai: true }))).toBe(true);
  });

  it('is false when the probe has not answered yet', () => {
    expect(providerLikelyUsable({ settings: { provider: 'auto' }, providers: [] })).toBe(false);
  });
});
