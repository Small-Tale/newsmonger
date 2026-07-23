import type { ConcreteProviderName, NewsProvider, ProviderName } from '../types.js';
import { createAnthropicProvider } from './anthropic.js';
import { createMockProvider } from './mock.js';
import { createOllamaProvider } from './ollama.js';
import { createOpenAIProvider } from './openai.js';

export { createAnthropicProvider } from './anthropic.js';
export { createMockProvider } from './mock.js';
export { createOllamaProvider } from './ollama.js';
export { createOpenAIProvider } from './openai.js';

/** Resolved provider settings (from the persisted `Settings`, seeded by CLI/env). */
export interface ResolveConfig {
  provider: ProviderName;
  /** Model id; '' means "use the provider's default". */
  model: string;
  /** Base URL for endpoint-based providers (Ollama / OpenAI-compatible); '' = default. */
  endpoint: string;
}

export type ProviderFactory = (cfg: ResolveConfig) => NewsProvider;

/**
 * How each concrete provider is constructed from resolved settings. Providers
 * not yet implemented throw an actionable error when selected (their own
 * tickets wire them in).
 */
export const FACTORIES: Record<ConcreteProviderName, ProviderFactory> = {
  anthropic: (c) => createAnthropicProvider({ model: c.model !== '' ? c.model : undefined }),
  openai: (c) =>
    createOpenAIProvider({
      model: c.model !== '' ? c.model : undefined,
      baseURL: c.endpoint !== '' ? c.endpoint : process.env['OPENAI_BASE_URL'],
    }),
  ollama: (c) =>
    createOllamaProvider({
      endpoint: c.endpoint !== '' ? c.endpoint : undefined,
      model: c.model !== '' ? c.model : undefined,
    }),
  mock: () => createMockProvider(),
};

/**
 * Order `auto` tries, most-preferred first. Only web-searching providers —
 * `auto` never selects a provider that answers from training data alone.
 */
export const AUTO_ORDER: ConcreteProviderName[] = ['anthropic', 'openai'];

/** Message shown when an explicitly-requested provider isn't usable. */
export function unavailableMessage(provider: NewsProvider): string {
  switch (provider.name) {
    case 'anthropic':
      return 'Anthropic is not available — set ANTHROPIC_API_KEY.';
    case 'openai':
      return 'OpenAI is not available — set OPENAI_API_KEY.';
    case 'ollama':
      return 'Ollama is not reachable — is it running, and have you pulled a model?';
    case 'mock':
      return 'The mock provider is unavailable (this should not happen).';
  }
}

/**
 * Resolve the active provider from settings. For `auto`, returns the first
 * available web-searching provider; otherwise returns the named provider if
 * available. Throws an actionable error when nothing usable is found.
 */
export async function resolveProvider(
  cfg: ResolveConfig,
  factories: Record<ConcreteProviderName, ProviderFactory> = FACTORIES,
): Promise<NewsProvider> {
  if (cfg.provider === 'auto') {
    for (const name of AUTO_ORDER) {
      let provider: NewsProvider;
      try {
        provider = factories[name]({ ...cfg, provider: name });
      } catch {
        continue; // not implemented / not constructable — skip
      }
      if (await provider.isAvailable()) return provider;
    }
    throw new Error(
      'No web-searching AI provider is available. Set ANTHROPIC_API_KEY (or OPENAI_API_KEY), or choose a provider explicitly.',
    );
  }
  const provider = factories[cfg.provider](cfg);
  if (!(await provider.isAvailable())) throw new Error(unavailableMessage(provider));
  return provider;
}
