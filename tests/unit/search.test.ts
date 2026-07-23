import { describe, expect, it, vi } from 'vitest';

import { createFakeSearchProvider, resolveSearchProvider } from '../../src/ai/search/index.js';
import { createTavilyProvider, daysSince, mapTavilyResults } from '../../src/ai/search/tavily.js';

const NOW = new Date('2026-07-24T12:00:00Z');

function fakeFetch(opts: { status?: number; body?: unknown; onBody?: (b: unknown) => void }): typeof fetch {
  return ((_url: string, init?: RequestInit) => {
    if (opts.onBody) opts.onBody(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
    const status = opts.status ?? 200;
    return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(opts.body ?? { results: [] }) } as Response);
  }) as typeof fetch;
}

describe('daysSince', () => {
  it('defaults to 7 with no prior check', () => {
    expect(daysSince(null, NOW)).toBe(7);
  });
  it('computes days since the last check, clamped 1..30', () => {
    expect(daysSince('2026-07-22T12:00:00Z', NOW)).toBe(2);
    expect(daysSince('2026-07-24T06:00:00Z', NOW)).toBe(1); // <1 day rounds up to 1
    expect(daysSince('2026-01-01T00:00:00Z', NOW)).toBe(30); // far past clamps to 30
  });
});

describe('mapTavilyResults', () => {
  it('maps title/url/content/published_date', () => {
    expect(
      mapTavilyResults({ results: [{ title: 'T', url: 'https://a.com/x', content: 'snip', published_date: '2026-07-23' }] }),
    ).toEqual([{ title: 'T', url: 'https://a.com/x', snippet: 'snip', publishedAt: '2026-07-23' }]);
  });
  it('falls back title→url and published_date→null; drops entries without a url', () => {
    expect(mapTavilyResults({ results: [{ url: 'https://a.com/y' }, { title: 'no url' }] })).toEqual([
      { title: 'https://a.com/y', url: 'https://a.com/y', snippet: '', publishedAt: null },
    ]);
  });
  it('is defensive against malformed bodies', () => {
    expect(mapTavilyResults(null)).toEqual([]);
    expect(mapTavilyResults({})).toEqual([]);
    expect(mapTavilyResults({ results: 'nope' })).toEqual([]);
  });
});

describe('createTavilyProvider', () => {
  it('is available iff a key is present', async () => {
    expect(await createTavilyProvider({ apiKey: 'k' }).isAvailable()).toBe(true);
    expect(await createTavilyProvider({ apiKey: '' }).isAvailable()).toBe(false);
  });

  it('throws when searching without a key', async () => {
    await expect(createTavilyProvider({ apiKey: '' }).search('AI', null, 5)).rejects.toThrow(/TAVILY_API_KEY/);
  });

  it('sends query/topic/days/max_results and maps results', async () => {
    let sent: { query?: string; topic?: string; days?: number; max_results?: number } = {};
    const p = createTavilyProvider({
      apiKey: 'k',
      now: () => NOW,
      fetchImpl: fakeFetch({
        onBody: (b) => {
          sent = b as typeof sent;
        },
        body: { results: [{ title: 'T', url: 'https://a.com/x', content: 'c', published_date: '2026-07-23' }] },
      }),
    });
    const results = await p.search('Fusion', '2026-07-22T12:00:00Z', 8);
    expect(sent.query).toBe('Fusion');
    expect(sent.topic).toBe('news');
    expect(sent.days).toBe(2);
    expect(sent.max_results).toBe(8);
    expect(results).toHaveLength(1);
    expect(results[0]?.url).toBe('https://a.com/x');
  });

  it('surfaces a non-ok response', async () => {
    const p = createTavilyProvider({ apiKey: 'k', fetchImpl: fakeFetch({ status: 401 }) });
    await expect(p.search('AI', null, 5)).rejects.toThrow(/Tavily returned 401/);
  });

  it('times out a hung request', async () => {
    vi.useFakeTimers();
    try {
      const hanging = ((_url: string, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener('abort', () => {
            rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        })) as typeof fetch;
      const p = createTavilyProvider({ apiKey: 'k', fetchImpl: hanging });
      const pending = p.search('AI', null, 5);
      const assertion = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(16_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('resolveSearchProvider / fake', () => {
  it('none → null; tavily → provider; brave → null (not implemented)', () => {
    expect(resolveSearchProvider('none', {})).toBeNull();
    expect(resolveSearchProvider('tavily', { TAVILY_API_KEY: 'k' })?.name).toBe('tavily');
    expect(resolveSearchProvider('brave', {})).toBeNull();
  });

  it('fake search provider records calls and returns canned results', async () => {
    const fake = createFakeSearchProvider([{ title: 'T', url: 'https://a.com/x', snippet: 's', publishedAt: null }]);
    const results = await fake.search('AI', null, 5);
    expect(results).toHaveLength(1);
    expect(fake.calls[0]).toEqual({ topic: 'AI', sinceIso: null, maxResults: 5 });
  });
});
