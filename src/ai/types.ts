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
export const PROVIDER_NAMES = ['auto', 'claude-cli', 'codex-cli', 'anthropic', 'openai', 'mock'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];
export type ConcreteProviderName = Exclude<ProviderName, 'auto'>;

/** Static, no-probe metadata for each selectable provider (for the UI). */
export const PROVIDER_INFO: Record<ProviderName, { label: string; endpointConfigurable: boolean }> = {
  auto: { label: 'Auto', endpointConfigurable: false },
  'claude-cli': { label: 'Claude subscription (Claude Code)', endpointConfigurable: false },
  'codex-cli': { label: 'ChatGPT subscription (Codex)', endpointConfigurable: false },
  anthropic: { label: 'Anthropic API key', endpointConfigurable: false },
  openai: { label: 'OpenAI API key', endpointConfigurable: true },
  mock: { label: 'Mock (offline test)', endpointConfigurable: false },
};

/**
 * Providers that authenticate with an API key. `mock` needs none.
 *
 * Declared here rather than beside the keychain code because the shared API
 * schemas reference it, and those are parsed by the browser client too — which
 * must not pull `node:child_process` into its bundle.
 */
export const KEYED_PROVIDERS = ['anthropic', 'openai'] as const;
export type KeyedProvider = (typeof KEYED_PROVIDERS)[number];

/** Environment variable each provider's key can be supplied through. */
export const KEY_ENV_VARS: Record<KeyedProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

/** Narrows an untrusted value (e.g. a URL path segment) to a keyed provider. */
export function isKeyedProvider(name: string): name is KeyedProvider {
  return (KEYED_PROVIDERS as readonly string[]).includes(name);
}

/** A selectable news backend. Every real provider searches the web itself. */
export interface NewsProvider extends NewsService {
  /**
   * Whether this provider may only run *scheduled* checks while the app is
   * foregrounded (see `src/attendance.ts`).
   *
   * True for providers backed by a personal subscription, where a check spends
   * the user's plan quota; false for API-key providers, whose usage is metered
   * and billed and so is fine to schedule unattended. Manual checks are never
   * gated — clicking the button is itself proof someone is there.
   */
  readonly attended: boolean;
  readonly name: ConcreteProviderName;
  /** Human-facing model id in use (for display / run records); '' if not applicable. */
  readonly model: string;
  /** Whether this provider is usable right now (key present, endpoint reachable, …). */
  isAvailable(): Promise<boolean>;
}
