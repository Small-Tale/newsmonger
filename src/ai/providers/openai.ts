import OpenAI from 'openai';

import { resolveApiKey } from '../api-keys.js';
import { buildUserPrompt, parseNewsResult, searchingSystemPrompt } from '../prompt.js';
import { buildSuggestPrompt, parseSuggestResult, suggestSystemPrompt } from '../suggest-prompt.js';
import type {
  CheckResult,
  KnownItem,
  NewsProvider,
  SuggestRequest,
  SuggestResult,
  TokenUsage,
  TopicContext,
} from '../types.js';
import { DISCOVERY_MODELS } from '../types.js';

export const DEFAULT_OPENAI_MODEL = 'gpt-5';

/** Minimal seam over the OpenAI SDK so tests can inject a fake. */
export interface OpenAIRunner {
  run(system: string, prompt: string, model: string): Promise<{ text: string; usage: TokenUsage | null }>;
}

/**
 * Map the Responses API usage block onto our shape (NEWS-79).
 *
 * OpenAI does not report hosted-web-search counts in `usage`, so `webSearches`
 * stays 0 — an undercount, but the alternative is inventing a number. It is
 * moot today anyway: no OpenAI model is in the price table, so no estimate is
 * produced for this provider at all (see `src/ai/pricing.ts`).
 */
function readUsage(usage: OpenAI.Responses.ResponseUsage | undefined): TokenUsage | null {
  if (usage === undefined) return null;
  return {
    inputTokens: usage.input_tokens,
    cacheReadTokens: usage.input_tokens_details.cached_tokens,
    cacheWriteTokens: 0,
    outputTokens: usage.output_tokens,
    webSearches: 0,
  };
}

function sdkRunner(getApiKey: () => Promise<string | null>, baseURL: string | undefined): OpenAIRunner {
  // Cached, but rebuilt when the credential changes — see the note in
  // `anthropic.ts`; a key edited in Settings must take effect immediately.
  let client: OpenAI | undefined;
  let builtWith: string | null = null;

  return {
    async run(system, prompt, model) {
      const apiKey = await getApiKey();
      if (apiKey === null) throw new Error('No OpenAI API key is configured');
      if (client === undefined || builtWith !== apiKey) {
        client = new OpenAI({ apiKey, ...(baseURL !== undefined && baseURL !== '' ? { baseURL } : {}) });
        builtWith = apiKey;
      }
      // Responses API + hosted `web_search` tool → live results, like
      // Anthropic's web_search_20260209. `output_text` aggregates the text.
      const response = await client.responses.create({
        model,
        instructions: system,
        input: prompt,
        tools: [{ type: 'web_search' }],
        max_output_tokens: 16000,
      });
      return { text: response.output_text, usage: readUsage(response.usage) };
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
  baseURL?: string;
  /** Resolves the key at request time; null means none is configured. */
  getApiKey?: () => Promise<string | null>;
  runner?: OpenAIRunner;
} = {}): NewsProvider {
  const model = config.model ?? DEFAULT_OPENAI_MODEL;
  // See `anthropic.ts`: one seam for both "is there a key" and "what is it",
  // resolved per call so a key saved in Settings applies without a restart.
  const getApiKey = config.getApiKey ?? (async () => (await resolveApiKey('openai')).key);
  const runner = config.runner ?? sdkRunner(getApiKey, config.baseURL);
  // See `anthropic.ts`: the fast discovery model is a default, not an override
  // — an explicitly chosen model still wins (NEWS-132). The Responses API takes
  // the same request shape either way, so only the model id changes here.
  const discoveryModel = config.model === undefined || config.model === '' ? DISCOVERY_MODELS.openai : model;

  return {
    name: 'openai',
    model,
    // Metered and billed per token — safe to run on a schedule unattended.
    attended: false,
    isAvailable: async () => (await getApiKey()) !== null,
    async checkTopic(
      topicName: string,
      known: KnownItem[],
      sinceIso: string | null,
      context: TopicContext = {},
    ): Promise<CheckResult> {
      const { text, usage } = await runner.run(
        searchingSystemPrompt(),
        buildUserPrompt(topicName, known, sinceIso, context),
        model,
      );
      return { ...parseNewsResult(text), usage };
    },
    async suggestTopics(request: SuggestRequest): Promise<SuggestResult> {
      const { text, usage } = await runner.run(suggestSystemPrompt(), buildSuggestPrompt(request), discoveryModel);
      return { suggestions: parseSuggestResult(text), usage };
    },
  };
}
