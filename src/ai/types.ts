/** A news story returned by a news service, before deduplication. */
export interface FoundNewsItem {
  title: string;
  summary: string;
  sources: { title: string; url: string }[];
}

/** A previously-seen story, passed to the service so it can avoid re-reporting. */
export interface KnownItem {
  title: string;
  foundAt: string;
}

/** Abstraction over "ask an LLM for news" so tests can substitute a mock. */
export interface NewsService {
  checkTopic(topicName: string, known: KnownItem[], sinceIso: string | null): Promise<FoundNewsItem[]>;
}

/**
 * The set of provider ids the user can select. `auto` picks the best available.
 *
 * Only platforms that perform their own web search are supported — finding
 * genuinely *new* news requires live browsing, and we don't carry a search
 * backend to compensate for models that can't. (`mock` is test-only.)
 */
export const PROVIDER_NAMES = ['auto', 'anthropic', 'openai', 'mock'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];
export type ConcreteProviderName = Exclude<ProviderName, 'auto'>;

/** Static, no-probe metadata for each selectable provider (for the UI). */
export const PROVIDER_INFO: Record<ProviderName, { label: string; endpointConfigurable: boolean }> = {
  auto: { label: 'Auto', endpointConfigurable: false },
  anthropic: { label: 'Anthropic (Claude)', endpointConfigurable: false },
  openai: { label: 'OpenAI', endpointConfigurable: true },
  mock: { label: 'Mock (offline test)', endpointConfigurable: false },
};

/** A selectable news backend. Every real provider searches the web itself. */
export interface NewsProvider extends NewsService {
  readonly name: ConcreteProviderName;
  /** Human-facing model id in use (for display / run records); '' if not applicable. */
  readonly model: string;
  /** Whether this provider is usable right now (key present, endpoint reachable, …). */
  isAvailable(): Promise<boolean>;
}
