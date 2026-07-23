/** A candidate article found by a search provider, before summarization. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** ISO date the source was published, when the provider exposes it. */
  publishedAt: string | null;
}

/** The set of search-provider ids. `none` disables grounding. */
export const SEARCH_PROVIDER_NAMES = ['none', 'tavily', 'brave'] as const;
export type SearchProviderName = (typeof SEARCH_PROVIDER_NAMES)[number];
export type ConcreteSearchProviderName = Exclude<SearchProviderName, 'none'>;

/**
 * A web-search backend, independent of the LLM. Lets providers that can't
 * browse (Ollama, local) still be grounded on live results — see
 * `docs/7-search-grounding.md`.
 */
export interface SearchProvider {
  readonly name: ConcreteSearchProviderName;
  isAvailable(): Promise<boolean>;
  /** Fresh candidate articles for a topic, most-recent bias since `sinceIso`. */
  search(topic: string, sinceIso: string | null, maxResults: number): Promise<SearchResult[]>;
}

export const SEARCH_PROVIDER_INFO: Record<SearchProviderName, { label: string }> = {
  none: { label: 'None (model knowledge only)' },
  tavily: { label: 'Tavily' },
  brave: { label: 'Brave Search' },
};
