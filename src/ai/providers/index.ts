import type { ConcreteProviderName, Effort, NewsProvider, ProviderName } from '../types.js';
import { AUTO_ORDER, PROVIDER_INFO } from '../types.js';
import { createAnthropicProvider } from './anthropic.js';
import { createClaudeCliProvider } from './claude-cli.js';
import { createCodexCliProvider } from './codex-cli.js';
import { createMockProvider } from './mock.js';
import { createOpenAIProvider } from './openai.js';

export { createAnthropicProvider } from './anthropic.js';
export { createClaudeCliProvider } from './claude-cli.js';
export { createCodexCliProvider } from './codex-cli.js';
export { createMockProvider } from './mock.js';
export { createOpenAIProvider } from './openai.js';

/** Resolved provider settings (from the persisted `Settings`, seeded by CLI/env). */
export interface ResolveConfig {
  provider: ProviderName;
  /** Model id; '' means "use the provider's default". */
  model: string;
  /** Base URL override (OpenAI-compatible endpoints); '' = default. */
  endpoint: string;
  /**
   * Effort for checks (NEWS-189); '' = the provider's default.
   *
   * Optional so every existing caller — including `probeProviders`, which only
   * asks "is this available" — keeps compiling and keeps meaning "default".
   */
  effort?: Effort;
}

export type ProviderFactory = (cfg: ResolveConfig) => NewsProvider;

/** How each concrete provider is constructed from resolved settings. */
export const FACTORIES: Record<ConcreteProviderName, ProviderFactory> = {
  'claude-cli': (c) => createClaudeCliProvider({ model: c.model, effort: c.effort }),
  'codex-cli': (c) => createCodexCliProvider({ model: c.model, effort: c.effort }),
  anthropic: (c) => createAnthropicProvider({ model: c.model !== '' ? c.model : undefined, effort: c.effort }),
  openai: (c) =>
    createOpenAIProvider({
      model: c.model !== '' ? c.model : undefined,
      baseURL: c.endpoint !== '' ? c.endpoint : process.env['OPENAI_BASE_URL'],
    }),
  mock: () => createMockProvider(),
};

/**
 * Order `auto` tries, most-preferred first. `mock` is opt-in only.
 *
 * Subscription-backed providers come first by design: if someone has a Claude
 * subscription, spending its quota is what they'd expect over billing an API
 * key they also happen to hold.
 */
// Lives in `../types.js` so the browser client can import it too (NEWS-128);
// this module pulls in `node:child_process` via the CLI providers.
export { AUTO_ORDER };

/** Message shown when an explicitly-requested provider isn't usable. */
export function unavailableMessage(provider: NewsProvider): string {
  switch (provider.name) {
    case 'claude-cli':
      return 'Claude Code is not signed in — run `claude` and log in, or choose a provider that uses an API key.';
    case 'codex-cli':
      return 'Codex is not signed in — run `codex login` and choose ChatGPT, or pick a provider that uses an API key.';
    case 'anthropic':
      return 'Anthropic has no API key — add one in Settings, or set ANTHROPIC_API_KEY.';
    case 'openai':
      return 'OpenAI has no API key — add one in Settings, or set OPENAI_API_KEY.';
    case 'mock':
      return 'The mock provider is unavailable (this should not happen).';
  }
}

/**
 * Resolve the active provider from settings. For `auto`, returns the first
 * available provider in `AUTO_ORDER`; otherwise returns the named provider if
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
        continue; // not constructable — skip
      }
      if (await provider.isAvailable()) return provider;
    }
    throw new Error(
      'No AI provider is usable. Sign in with `claude`, add an API key in Settings, or set ANTHROPIC_API_KEY / OPENAI_API_KEY.',
    );
  }
  const provider = factories[cfg.provider](cfg);
  if (!(await provider.isAvailable())) throw new Error(unavailableMessage(provider));
  return provider;
}

/** Static + probed metadata for each concrete provider, for the settings UI. */
export async function probeProviders(
  cfg: Pick<ResolveConfig, 'model' | 'endpoint'>,
  factories: Record<ConcreteProviderName, ProviderFactory> = FACTORIES,
): Promise<{ name: ConcreteProviderName; endpointConfigurable: boolean; label: string; available: boolean }[]> {
  const names: ConcreteProviderName[] = ['claude-cli', 'codex-cli', 'anthropic', 'openai', 'mock'];
  return Promise.all(
    names.map(async (name) => {
      const info = PROVIDER_INFO[name];
      let available: boolean;
      try {
        available = await factories[name]({ ...cfg, provider: name }).isAvailable();
      } catch {
        available = false;
      }
      return { name, endpointConfigurable: info.endpointConfigurable, label: info.label, available };
    }),
  );
}
