import type { NewsProvider, NewsService } from '../../src/ai/types.js';
import type { ProviderResolver } from '../../src/checks.js';

/** Wrap a fixed provider as a resolver (the shape CheckRunner now expects). */
export function asResolver(provider: NewsProvider): ProviderResolver {
  return () => Promise.resolve(provider);
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
