import { describe, expect, it } from 'vitest';

import type { StateResp } from '../../src/api/schemas.js';
import { currentFailure } from '../../src/client/failure.js';

type CheckRun = StateResp['runs'][number];

let seq = 0;
/** A run for `topic` with `status`. Runs are listed most-recent-first. */
function run(topicId: string, status: CheckRun['status']): CheckRun {
  seq += 1;
  return {
    id: `run-${String(seq)}`,
    topicId,
    startedAt: '2026-07-24T00:00:00Z',
    finishedAt: status === 'running' ? null : '2026-07-24T00:01:00Z',
    status,
    newItems: 0,
    error: status === 'failed' ? 'boom' : null,
    provider: 'mock',
    model: null,
    usage: null,
  };
}

describe('currentFailure (NEWS-41)', () => {
  it('returns null when there are no runs', () => {
    expect(currentFailure([])).toBeNull();
  });

  it('returns the failed run when a topic is currently failing', () => {
    const failed = run('a', 'failed');
    expect(currentFailure([failed])?.id).toBe(failed.id);
  });

  it('ignores a stale failure once the topic has recovered', () => {
    // Most-recent-first: a's latest run succeeded, so its earlier failure is stale.
    const success = run('a', 'succeeded');
    const oldFail = run('a', 'failed');
    expect(currentFailure([success, oldFail])).toBeNull();
  });

  it('does not warn while a failed topic is re-checking', () => {
    // Latest run is 'running' → not currently failed.
    const running = run('a', 'running');
    const oldFail = run('a', 'failed');
    expect(currentFailure([running, oldFail])).toBeNull();
  });

  it('reports the most recent among several currently-failing topics', () => {
    const bFail = run('b', 'failed'); // most recent
    const aFail = run('a', 'failed');
    expect(currentFailure([bFail, aFail])?.id).toBe(bFail.id);
  });

  it('warns about a still-failing topic even when another has recovered', () => {
    const aOk = run('a', 'succeeded'); // most recent overall, but a is fine
    const bFail = run('b', 'failed'); // b's latest run — still failing
    expect(currentFailure([aOk, bFail])?.id).toBe(bFail.id);
  });
});
