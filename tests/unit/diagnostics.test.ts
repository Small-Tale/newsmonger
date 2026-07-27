import { describe, expect, it } from 'vitest';

import { builtinTable } from '../../src/ai/price-store.js';
import type { StateResp } from '../../src/api/schemas.js';
import { buildDiagnostics, formatDuration, runRows } from '../../src/client/diagnostics.js';

function state(over: Partial<StateResp> = {}): StateResp {
  return {
    topics: [
      {
        id: 't1',
        name: 'My Divorce Proceedings',
        paused: false,
        highPriority: false,
        guidance: '',
        createdAt: '2026-07-01T00:00:00Z',
        lastCheckedAt: null,
        coveredThroughAt: null,
      },
    ],
    latestItemIds: [],
    flaggedByTopic: {},
    settings: {
      checkIntervalMs: 3_600_000,
      highPriorityIntervalMs: 3_600_000,
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      endpoint: '',
      notifyOnNewItems: false,
      monthlyBudgetUsd: 0,
      itemRetentionDays: 365,
      scheduleMode: 'interval',
      dailyTimes: ['08:00'],
      checkConcurrency: 3,
      priceManifestUrl: '',
    },
    runs: [
      {
        id: 'r1',
        topicId: 't1',
        startedAt: '2026-07-27T10:00:00.000Z',
        finishedAt: '2026-07-27T10:04:12.000Z',
        status: 'succeeded',
        newItems: 3,
        error: null,
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        usage: {
          inputTokens: 30_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 3_000,
          webSearches: 8,
        },
      },
    ],
    checking: [],
    spend: { usd: 0.3, pricedRuns: 1, unpricedRuns: 0, monthlyBudgetUsd: 0, overBudget: false, pricesVerifiedOn: '2026-07-27' },
    appVersion: '0.1.0',
    // The shipped defaults, so cost assertions exercise a real rate.
    prices: builtinTable().models,
    ...over,
  };
}

const OPTS = { includeTopicNames: false, userAgent: 'TestAgent/1.0', appVersion: '0.1.0' };

describe('runRows (NEWS-88)', () => {
  it('resolves the topic name and derives a duration and cost', () => {
    const [row] = runRows(state());
    expect(row.topicName).toBe('My Divorce Proceedings');
    expect(row.durationMs).toBe(252_000);
    // 30k in + 3k out + 8 searches on Opus 4.8.
    expect(row.costUsd).toBeCloseTo(0.15 + 0.075 + 0.08, 6);
  });

  it('names a deleted topic rather than showing a bare id', () => {
    const [row] = runRows(state({ topics: [] }));
    expect(row.topicName).toBe('deleted topic');
  });

  it('leaves duration null while a run is still in flight', () => {
    const s = state();
    const [only] = s.runs;
    const [row] = runRows({ ...s, runs: [{ ...only, finishedAt: null, status: 'running' }] });
    expect(row.durationMs).toBeNull();
  });
});

describe('formatDuration', () => {
  it('scales the unit to the magnitude', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(240)).toBe('240ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(252_000)).toBe('4m 12s');
  });

  it('zero-pads the seconds so durations line up in a column', () => {
    expect(formatDuration(65_000)).toBe('1m 05s');
  });
});

describe('buildDiagnostics (NEWS-88)', () => {
  it('carries what makes a failure reproducible', () => {
    const text = buildDiagnostics(state(), OPTS);
    expect(text).toContain('version: 0.1.0');
    expect(text).toContain('TestAgent/1.0');
    expect(text).toContain('provider setting: anthropic');
    expect(text).toContain('claude-opus-4-8');
    expect(text).toContain('succeeded');
  });

  it('redacts topic names by default', () => {
    const text = buildDiagnostics(state(), OPTS);
    expect(text).not.toContain('My Divorce Proceedings');
    expect(text).toContain('topic 1');
    expect(text).toContain('Topic names redacted');
  });

  it('includes them only when explicitly asked', () => {
    const text = buildDiagnostics(state(), { ...OPTS, includeTopicNames: true });
    expect(text).toContain('My Divorce Proceedings');
    expect(text).toContain('at the reporter’s request');
  });

  it('never truncates error text — that is the whole point of the bundle', () => {
    const s = state();
    const [only] = s.runs;
    const long = `overloaded_error: ${'x'.repeat(400)}`;
    const text = buildDiagnostics({ ...s, runs: [{ ...only, status: 'failed', error: long }] }, OPTS);
    expect(text).toContain(long);
  });

  it('warns that redacted output can still leak a name through error text', () => {
    // Honest rather than reassuring: an error string is verbatim provider
    // output and may quote the topic. Better to say so than to imply it can't.
    expect(buildDiagnostics(state(), OPTS)).toContain('may still mention a topic');
  });

  it('reports only whether an endpoint is set, never the URL', () => {
    const s = state();
    const text = buildDiagnostics({ ...s, settings: { ...s.settings, endpoint: 'https://gw.internal.corp/v1' } }, OPTS);
    expect(text).toContain('endpoint set: yes');
    expect(text).not.toContain('gw.internal.corp');
  });

  it('renders with no runs at all', () => {
    expect(buildDiagnostics(state({ runs: [] }), OPTS)).toContain('(none recorded)');
  });

  it('reports unknown cost as unknown rather than as zero', () => {
    const s = state();
    const [only] = s.runs;
    const text = buildDiagnostics({ ...s, runs: [{ ...only, usage: null }] }, OPTS);
    expect(text).toContain('cost unknown');
  });
});
