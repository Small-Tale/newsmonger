import { describe, expect, it } from 'vitest';

import { buildThreadBriefPrompt, parseThreadBriefResult, threadBriefSystemPrompt } from '../../src/ai/thread-brief.js';

describe('thread brief prompt and validation', () => {
  const items = [
    { id: 'a', title: 'First report', summary: 'A thing happened.', sources: [{ title: 'One', url: 'https://one.example/a', outlet: 'One' }] },
    { id: 'b', title: 'Update', summary: 'The response began.', sources: [{ title: 'Two', url: 'https://two.example/b', outlet: 'Two' }] },
  ];

  it('supplies ordered stored evidence and explicitly forbids browsing and repetition-as-consensus', () => {
    expect(JSON.parse(buildThreadBriefPrompt(items))).toMatchObject({ stories: [{ order: 1, id: 'a' }, { order: 2, id: 'b' }] });
    expect(threadBriefSystemPrompt()).toContain('Never browse');
    expect(threadBriefSystemPrompt()).toContain('Do not turn repetition into consensus');
  });

  it('accepts evidence-linked claims and strips model markup', () => {
    const parsed = parseThreadBriefResult(JSON.stringify({
      changed: [{ text: '<b>Response began</b>', sourceIds: ['b'], support: 'unclear' }],
      consistent: [{ text: 'Event occurred', sourceIds: ['a', 'b'], support: 'independent' }],
      unknown: [], uncertainty: 'medium',
    }), new Set(['a', 'b']));
    expect(parsed.changed[0]?.text).toBe('Response began');
  });

  it('rejects missing evidence, invented story ids, and invalid uncertainty', () => {
    expect(() => parseThreadBriefResult('{"changed":[{"text":"x","sourceIds":[],"support":"unclear"}],"consistent":[],"unknown":[],"uncertainty":"low"}', new Set(['a']))).toThrow();
    expect(() => parseThreadBriefResult('{"changed":[{"text":"x","sourceIds":["z"],"support":"unclear"}],"consistent":[],"unknown":[],"uncertainty":"low"}', new Set(['a']))).toThrow('unknown story');
    expect(() => parseThreadBriefResult('{"changed":[],"consistent":[],"unknown":[],"uncertainty":"certain"}', new Set(['a']))).toThrow();
  });
});
