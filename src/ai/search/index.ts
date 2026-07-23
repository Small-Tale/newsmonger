import { createTavilyProvider } from './tavily.js';
import type { ConcreteSearchProviderName, SearchProvider, SearchProviderName, SearchResult } from './types.js';

export { createTavilyProvider } from './tavily.js';
export type { SearchProvider, SearchResult } from './types.js';

/**
 * Resolve a search provider from settings, or null when grounding is off
 * (`none`) or the named provider isn't implemented yet.
 *
 * Brave is declared in the union (schema-stable) but not implemented yet;
 * selecting it resolves to null (no grounding) — its impl is a follow-up.
 */
export function resolveSearchProvider(name: SearchProviderName, env: NodeJS.ProcessEnv = process.env): SearchProvider | null {
  switch (name) {
    case 'none':
      return null;
    case 'tavily':
      return createTavilyProvider({ apiKey: env['TAVILY_API_KEY'] ?? '' });
    case 'brave':
      return null; // TODO(NEWS-13 follow-up): Brave implementation
  }
}

/** A deterministic search provider for tests / offline development. */
export function createFakeSearchProvider(
  results: SearchResult[] = [],
  opts: { name?: ConcreteSearchProviderName; available?: boolean } = {},
): SearchProvider & { calls: { topic: string; sinceIso: string | null; maxResults: number }[] } {
  const calls: { topic: string; sinceIso: string | null; maxResults: number }[] = [];
  return {
    name: opts.name ?? 'tavily',
    calls,
    isAvailable: () => Promise.resolve(opts.available ?? true),
    search(topic, sinceIso, maxResults) {
      calls.push({ topic, sinceIso, maxResults });
      return Promise.resolve(results);
    },
  };
}
