import type { CheckResult, FoundNewsItem, NewsProvider, NewsService } from '../../src/ai/types.js';
import type { ProviderResolver } from '../../src/checks.js';

/** Wrap a fixed provider as a resolver (the shape CheckRunner expects). */
export function asResolver(provider: NewsProvider): ProviderResolver {
  return () => Promise.resolve(provider);
}

/** A minimal NewsProvider around a bare checkTopic, for CheckRunner tests. */
export function fakeProvider(
  checkTopic: NewsService['checkTopic'],
  opts: Partial<Pick<NewsProvider, 'name' | 'model' | 'attended'>> = {},
): NewsProvider {
  return {
    name: opts.name ?? 'mock',
    model: opts.model ?? 'fake',
    attended: opts.attended ?? false,
    isAvailable: () => Promise.resolve(true),
    checkTopic,
  };
}

/** Wrap bare items as a provider result with no usage reported (NEWS-79). */
export function noUsage(items: FoundNewsItem[]): CheckResult {
  return { items, usage: null };
}
