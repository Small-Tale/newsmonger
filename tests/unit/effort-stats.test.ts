import { describe, expect, it } from 'vitest';

import type { StateResp } from '../../src/api/schemas.js';
import { effortComparison, effortLabel, hasEffortComparison } from '../../src/client/effort-stats.js';

/**
 * What each effort level costs (NEWS-227).
 *
 * Held back twice on the grounds that a comparison over a handful of runs is
 * noise; built once a live database showed 24 succeeded runs at the model default
 * against 23 at `low`. The interesting parts are all *exclusions*, which is
 * exactly what a unit test can choose and a real database cannot.
 */

type Run = StateResp['runs'][number];

let seq = 0;

/** A succeeded run of `seconds`, at `effort`, optionally reporting tokens. */
function run(over: Partial<Run> & { seconds?: number } = {}): Run {
  const { seconds = 60, ...rest } = over;
  const started = new Date(Date.UTC(2026, 7, 3, 0, 0, seq++)).toISOString();
  return {
    id: `r${String(seq)}`,
    topicId: 't1',
    startedAt: started,
    finishedAt: new Date(Date.parse(started) + seconds * 1000).toISOString(),
    status: 'succeeded',
    newItems: 1,
    error: null,
    provider: 'anthropic',
    model: 'claude',
    usage: null,
    effort: '',
    ...rest,
  };
}

function usage(input: number, output: number): Run['usage'] {
  return { inputTokens: input, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: output, webSearches: 0 };
}

describe('effortComparison', () => {
  it('reports a median per level, fastest first', () => {
    const stats = effortComparison([
      run({ effort: 'high', seconds: 100 }),
      run({ effort: 'high', seconds: 200 }),
      run({ effort: 'high', seconds: 300 }),
      run({ effort: 'low', seconds: 10 }),
      run({ effort: 'low', seconds: 20 }),
      run({ effort: 'low', seconds: 30 }),
    ]);
    expect(stats.map((s) => s.effort)).toEqual(['low', 'high']);
    expect(stats[0].medianMs).toBe(20_000);
    expect(stats[1].medianMs).toBe(200_000);
    expect(stats[0].runs).toBe(3);
  });

  it('takes the median, not the mean — one stalled check must not invert the ranking', () => {
    // The reason the ticket specified median. With a mean, `low` here reads as
    // 340s and looks like the *slowest* level on the strength of one outlier.
    const stats = effortComparison([
      run({ effort: 'low', seconds: 10 }),
      run({ effort: 'low', seconds: 10 }),
      run({ effort: 'low', seconds: 1000 }), // a stall, or a retry
      run({ effort: 'high', seconds: 50 }),
      run({ effort: 'high', seconds: 50 }),
      run({ effort: 'high', seconds: 50 }),
    ]);
    expect(stats.map((s) => s.effort)).toEqual(['low', 'high']);
    expect(stats[0].medianMs).toBe(10_000);
  });

  it('averages the two middles on an even count', () => {
    const stats = effortComparison([run({ seconds: 10 }), run({ seconds: 21 })]);
    expect(stats[0].medianMs).toBe(15_500);
  });

  it('drops runs recorded before effort was tracked, rather than calling them defaults', () => {
    // `null` is "we did not record this"; `''` is "it ran at the model's
    // default" (`CheckRunSchema`). Folding them together would make every
    // historical run a default-effort data point — and in a real database those
    // outnumber everything else.
    const stats = effortComparison([
      run({ effort: null, seconds: 999 }),
      run({ effort: null, seconds: 999 }),
      run({ effort: '', seconds: 10 }),
    ]);
    expect(stats).toHaveLength(1);
    expect(stats[0].effort).toBe('');
    expect(stats[0].runs).toBe(1);
    expect(stats[0].medianMs).toBe(10_000);
  });

  it('ignores failed and running checks', () => {
    // A check that failed after four seconds is not evidence that a level is
    // fast, and a level that fails often would otherwise look like the quickest.
    const stats = effortComparison([
      run({ effort: 'low', seconds: 4, status: 'failed', error: 'boom' }),
      run({ effort: 'low', seconds: 60 }),
      run({ effort: 'low', status: 'running', finishedAt: null }),
    ]);
    expect(stats[0].runs).toBe(1);
    expect(stats[0].medianMs).toBe(60_000);
  });

  it('says tokens are unreported rather than zero', () => {
    // The distinction that decides whether this view lies. Both subscription CLIs
    // return `usage: null` because they genuinely cannot report counts, so on
    // those installs *every* run lands here — and a 0 would be a measurement the
    // app never made, printed beside a duration it did.
    const stats = effortComparison([run({ effort: 'low' }), run({ effort: 'low' })]);
    expect(stats[0].medianInputTokens).toBeNull();
    expect(stats[0].medianOutputTokens).toBeNull();
    expect(stats[0].tokenRuns).toBe(0);
  });

  it('medians tokens over only the runs that reported them, and says how many', () => {
    // A mixed history — an install that used an API key and later a subscription.
    // The token median must not be diluted by the runs that reported nothing.
    const stats = effortComparison([
      run({ effort: 'low', usage: usage(1000, 100) }),
      run({ effort: 'low', usage: usage(3000, 300) }),
      run({ effort: 'low', usage: null }),
    ]);
    expect(stats[0].runs).toBe(3);
    expect(stats[0].tokenRuns).toBe(2);
    expect(stats[0].medianInputTokens).toBe(2000);
    expect(stats[0].medianOutputTokens).toBe(200);
  });

  it('counts cache reads and writes as input', () => {
    // They are input the provider billed differently, not a separate thing the
    // reader is choosing between.
    const stats = effortComparison([
      run({
        effort: 'low',
        usage: { inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 10, webSearches: 1 },
      }),
    ]);
    expect(stats[0].medianInputTokens).toBe(1050);
  });

  it('skips a run whose timestamps make no sense', () => {
    // Rather than contributing a negative duration that drags a median below zero.
    const backwards = run({ effort: 'low', seconds: 60 });
    const stats = effortComparison([
      { ...backwards, finishedAt: backwards.startedAt, startedAt: backwards.finishedAt as string },
      run({ effort: 'low', seconds: 60 }),
    ]);
    expect(stats[0].runs).toBe(1);
  });

  it('is empty when there is nothing recorded at all', () => {
    expect(effortComparison([])).toEqual([]);
    expect(effortComparison([run({ effort: null })])).toEqual([]);
  });
});

describe('hasEffortComparison', () => {
  it('needs two levels, because one is not a comparison', () => {
    // NEWS-227 was held back specifically to avoid rendering one bar and looking
    // broken. The caller shows a note explaining what to do instead.
    expect(hasEffortComparison(effortComparison([run({ effort: 'low' })]))).toBe(false);
    expect(hasEffortComparison(effortComparison([run({ effort: 'low' }), run({ effort: 'high' })]))).toBe(true);
  });
});

describe('effortLabel', () => {
  it('names the empty level rather than showing a blank', () => {
    expect(effortLabel('')).toBe('model default');
    expect(effortLabel('xhigh')).toBe('xhigh');
  });
});
