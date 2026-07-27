import { describe, expect, it } from 'vitest';

import type { StateResp } from '../../src/api/schemas.js';
import { sortTopics } from '../../src/client/topic-sort.js';

type Topic = StateResp['topics'][number];

let seq = 0;
function topic(name: string, over: Partial<Topic> = {}): Topic {
  seq += 1;
  return {
    id: `t${String(seq)}`,
    name,
    paused: false,
    highPriority: false,
    guidance: '',
    createdAt: `2026-07-2${String(seq)}T00:00:00Z`,
    lastCheckedAt: null,
    coveredThroughAt: null,
    ...over,
  };
}

describe('sortTopics (NEWS-63)', () => {
  it('alpha: orders by name A→Z, case-insensitively', () => {
    const t = [topic('Banana'), topic('apple'), topic('Cherry')];
    expect(sortTopics(t, 'alpha').map((x) => x.name)).toEqual(['apple', 'Banana', 'Cherry']);
  });

  it('added: newest createdAt first', () => {
    const a = topic('A', { createdAt: '2026-07-01T00:00:00Z' });
    const b = topic('B', { createdAt: '2026-07-10T00:00:00Z' });
    const c = topic('C', { createdAt: '2026-07-05T00:00:00Z' });
    expect(sortTopics([a, b, c], 'added').map((x) => x.name)).toEqual(['B', 'C', 'A']);
  });

  it('priority: high-priority first, then A→Z within each group', () => {
    const t = [
      topic('Zeta', { highPriority: true }),
      topic('Alpha', { highPriority: false }),
      topic('Beta', { highPriority: true }),
      topic('Yankee', { highPriority: false }),
    ];
    expect(sortTopics(t, 'priority').map((x) => x.name)).toEqual(['Beta', 'Zeta', 'Alpha', 'Yankee']);
  });

  it('never mutates the input array', () => {
    const t = [topic('B'), topic('A')];
    const before = t.map((x) => x.name);
    sortTopics(t, 'alpha');
    expect(t.map((x) => x.name)).toEqual(before);
  });
});
