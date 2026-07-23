import type { SearchResult } from '../search/types.js';
import type { FoundNewsItem, KnownItem, NewsProvider } from '../types.js';
import type { FetchImpl } from './openaiCompat.js';
import { createOpenAICompatBackend, openAICompatCheckTopic, openAICompatSummarize } from './openaiCompat.js';

/** Ollama's default OpenAI-compatible base URL. */
export const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434/v1';

/**
 * Resolve the Ollama endpoint: explicit config (settings/`--endpoint`), then
 * `NEWS_OLLAMA_ENDPOINT` / `NEWS_OLLAMA_HOST`, then the default. A bare host
 * (no `/v1`) gets `/v1` appended, since that's where Ollama serves the
 * OpenAI-compatible API.
 */
export function resolveOllamaEndpoint(endpoint: string, env: NodeJS.ProcessEnv = process.env): string {
  const raw =
    endpoint !== ''
      ? endpoint
      : (env['NEWS_OLLAMA_ENDPOINT'] ?? env['NEWS_OLLAMA_HOST'] ?? '') !== ''
        ? (env['NEWS_OLLAMA_ENDPOINT'] ?? env['NEWS_OLLAMA_HOST'] ?? '')
        : DEFAULT_OLLAMA_ENDPOINT;
  const trimmed = raw.replace(/\/+$/, '');
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/**
 * Local-model news provider via Ollama's OpenAI-compatible API.
 *
 * `searchesWeb` is false: a local model answers from its training data and
 * cannot browse, so it can't confirm news is genuinely new. `auto` never picks
 * it; the UI badges it (NEWS-10). Grounding it with live search is NEWS-12.
 */
export function createOllamaProvider(config: {
  endpoint?: string;
  model?: string;
  fetchImpl?: FetchImpl;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
} = {}): NewsProvider {
  const env = config.env ?? process.env;
  const endpoint = resolveOllamaEndpoint(config.endpoint ?? '', env);
  const model = config.model !== undefined && config.model !== '' ? config.model : (env['NEWS_OLLAMA_MODEL'] ?? '');
  const backend = createOpenAICompatBackend({
    name: 'ollama',
    endpoint,
    model,
    searchesWeb: false,
    fetchImpl: config.fetchImpl,
    timeoutMs: config.timeoutMs,
  });
  const check = openAICompatCheckTopic(backend, false);
  const summarize = openAICompatSummarize(backend);

  return {
    name: 'ollama',
    searchesWeb: false,
    model,
    async isAvailable(): Promise<boolean> {
      try {
        return (await backend.listModels()).length > 0;
      } catch {
        return false;
      }
    },
    checkTopic(topicName: string, known: KnownItem[], sinceIso: string | null): Promise<FoundNewsItem[]> {
      return check(topicName, known, sinceIso);
    },
    summarize(topicName: string, known: KnownItem[], results: SearchResult[]): Promise<FoundNewsItem[]> {
      return summarize(topicName, known, results);
    },
  };
}
