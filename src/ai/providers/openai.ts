import OpenAI from 'openai';

import { buildUserPrompt, parseNewsResult, searchingSystemPrompt } from '../prompt.js';
import type { FoundNewsItem, KnownItem, NewsProvider } from '../types.js';

export const DEFAULT_OPENAI_MODEL = 'gpt-5';

/** Minimal seam over the OpenAI SDK so tests can inject a fake. */
export interface OpenAIRunner {
  run(system: string, prompt: string, model: string): Promise<string>;
}

function sdkRunner(getClient: () => OpenAI): OpenAIRunner {
  return {
    async run(system, prompt, model) {
      // Responses API + hosted `web_search` tool → live results, like
      // Anthropic's web_search_20260209. `output_text` aggregates the text.
      const response = await getClient().responses.create({
        model,
        instructions: system,
        input: prompt,
        tools: [{ type: 'web_search' }],
        max_output_tokens: 16000,
      });
      return response.output_text;
    },
  };
}

/**
 * OpenAI-backed news provider: the Responses API with the hosted `web_search`
 * tool, so it finds genuinely new news. `OPENAI_BASE_URL` can target an
 * OpenAI-compatible gateway that also offers web search.
 */
export function createOpenAIProvider(config: {
  model?: string;
  apiKey?: string;
  baseURL?: string;
  runner?: OpenAIRunner;
  hasApiKey?: () => boolean;
} = {}): NewsProvider {
  const model = config.model ?? DEFAULT_OPENAI_MODEL;
  // Lazy client: `new OpenAI()` throws without a key, but the provider must be
  // constructable for availability probing.
  let client: OpenAI | undefined;
  const runner =
    config.runner ??
    sdkRunner(
      () =>
        (client ??= new OpenAI({
          ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
          ...(config.baseURL !== undefined && config.baseURL !== '' ? { baseURL: config.baseURL } : {}),
        })),
    );
  const hasApiKey = config.hasApiKey ?? (() => (process.env['OPENAI_API_KEY'] ?? '') !== '');

  return {
    name: 'openai',
    searchesWeb: true,
    model,
    isAvailable: () => Promise.resolve(hasApiKey()),
    async checkTopic(topicName: string, known: KnownItem[], sinceIso: string | null): Promise<FoundNewsItem[]> {
      const text = await runner.run(
        searchingSystemPrompt(),
        buildUserPrompt(topicName, known, sinceIso, { searchesWeb: true }),
        model,
      );
      return parseNewsResult(text);
    },
  };
}
