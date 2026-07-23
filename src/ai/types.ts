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

/** The set of provider ids the user can select. `auto` picks the best available. */
export const PROVIDER_NAMES = ['auto', 'anthropic', 'openai', 'ollama', 'mock'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];
export type ConcreteProviderName = Exclude<ProviderName, 'auto'>;

/**
 * A selectable news backend.
 *
 * `searchesWeb` is the key capability: providers that browse the live web
 * (Anthropic, OpenAI) can find genuinely new news, while local models
 * (Ollama, the test mock) answer from training data only. `auto` selection
 * prefers web-searching providers and never picks a non-searching one.
 */
export interface NewsProvider extends NewsService {
  readonly name: ConcreteProviderName;
  readonly searchesWeb: boolean;
  /** Human-facing model id in use (for display / run records); '' if not applicable. */
  readonly model: string;
  /** Whether this provider is usable right now (key present, endpoint reachable, …). */
  isAvailable(): Promise<boolean>;
}
