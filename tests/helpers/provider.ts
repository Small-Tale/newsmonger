import type { SearchProvider } from '../../src/ai/search/types.js';
import type { NewsProvider, NewsService } from '../../src/ai/types.js';
import type { ProviderResolver } from '../../src/checks.js';

/** Wrap a fixed provider (and optional search backend) as a CheckContext resolver. */
export function asResolver(provider: NewsProvider, search: SearchProvider | null = null): ProviderResolver {
  return () => Promise.resolve({ provider, search });
}

/** A minimal NewsProvider around a bare checkTopic, for CheckRunner tests. */
export function fakeProvider(
  checkTopic: NewsService['checkTopic'],
  opts: Partial<Pick<NewsProvider, 'name' | 'searchesWeb' | 'model'>> = {},
): NewsProvider {
  return {
    name: opts.name ?? 'mock',
    searchesWeb: opts.searchesWeb ?? false,
    model: opts.model ?? 'fake',
    isAvailable: () => Promise.resolve(true),
    checkTopic,
  };
}
