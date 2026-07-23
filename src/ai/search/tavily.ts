import type { SearchProvider, SearchResult } from './types.js';

export type FetchImpl = typeof fetch;

const TAVILY_URL = 'https://api.tavily.com/search';
const TIMEOUT_MS = 15_000;

/** Days of lookback from `sinceIso` (Tavily's `days` param), clamped to 1..30. */
export function daysSince(sinceIso: string | null, now: Date): number {
  if (sinceIso === null) return 7;
  const ms = now.getTime() - Date.parse(sinceIso);
  const days = Math.ceil(ms / (24 * 60 * 60 * 1000));
  return Math.min(30, Math.max(1, Number.isFinite(days) ? days : 7));
}

/** Map Tavily's response to SearchResult[], defensively. */
export function mapTavilyResults(body: unknown): SearchResult[] {
  if (typeof body !== 'object' || body === null || !('results' in body)) return [];
  const { results } = body;
  if (!Array.isArray(results)) return [];
  const out: SearchResult[] = [];
  for (const r of results) {
    if (typeof r !== 'object' || r === null) continue;
    const rec = r as Record<string, unknown>;
    const url = typeof rec['url'] === 'string' ? rec['url'] : '';
    if (url === '') continue;
    out.push({
      title: typeof rec['title'] === 'string' ? rec['title'] : url,
      url,
      snippet: typeof rec['content'] === 'string' ? rec['content'] : '',
      publishedAt: typeof rec['published_date'] === 'string' && rec['published_date'] !== '' ? rec['published_date'] : null,
    });
  }
  return out;
}

/**
 * Tavily-backed search provider (news-focused). Raw fetch; `TAVILY_API_KEY`.
 * See https://docs.tavily.com/ — `POST /search` with `topic: 'news'`.
 */
export function createTavilyProvider(config: {
  apiKey?: string;
  fetchImpl?: FetchImpl;
  now?: () => Date;
} = {}): SearchProvider {
  const apiKey = config.apiKey ?? process.env['TAVILY_API_KEY'] ?? '';
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? ((): Date => new Date());

  return {
    name: 'tavily',
    isAvailable: () => Promise.resolve(apiKey !== ''),
    async search(topic: string, sinceIso: string | null, maxResults: number): Promise<SearchResult[]> {
      if (apiKey === '') throw new Error('Tavily is not configured — set TAVILY_API_KEY');
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, TIMEOUT_MS);
      try {
        const res = await fetchImpl(TAVILY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            query: topic,
            topic: 'news',
            max_results: Math.min(20, Math.max(1, maxResults)),
            days: daysSince(sinceIso, now()),
            include_raw_content: false,
          }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`Tavily returned ${res.status}`);
        return mapTavilyResults((await res.json()) as unknown);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new Error('Tavily search timed out', { cause: err });
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
