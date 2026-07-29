import Anthropic from '@anthropic-ai/sdk';

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
import { DISCOVERY_MODELS, usesLegacyRequestShape } from '../types.js';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-8';

/**
 * How one request should be shaped (NEWS-132).
 *
 * A news check and a topic-discovery call ask very different questions, so they
 * get different budgets — and because discovery runs on an older, cheaper model
 * by default, they also get different *request shapes*.
 */
export interface RunOptions {
  /** Cap on server-side web searches. A cost and latency guard, not a coverage one. */
  maxSearches: number;
  maxTokens: number;
}

/** Minimal seam over the Anthropic SDK so tests can inject a fake. */
export interface AnthropicRunner {
  run(
    system: string,
    prompt: string,
    model: string,
    options?: RunOptions,
  ): Promise<{ text: string; usage: TokenUsage | null }>;
}

/** A news check: long summaries, and enough searches to cover a catch-up window. */
const CHECK_RUN: RunOptions = { maxSearches: 8, maxTokens: 16000 };

/**
 * Topic discovery: a short list of names and one-line reasons.
 *
 * Three searches rather than eight — discovery only needs enough live browsing
 * to keep the *ongoing* half of the mix current (FR-24.10), and each search is
 * both money and multiple seconds of latency. The output cap is a quarter of a
 * check's for the same reason: nothing here writes paragraphs.
 */
const DISCOVER_RUN: RunOptions = { maxSearches: 3, maxTokens: 4000 };

/** Map the SDK's usage block onto our provider-neutral shape (NEWS-79). */
function readUsage(usage: Anthropic.Usage): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    outputTokens: usage.output_tokens,
    webSearches: usage.server_tool_use?.web_search_requests ?? 0,
  };
}

/**
 * Build the request body for one call (NEWS-132).
 *
 * Extracted and exported because this is where a wrong answer costs a vendor
 * 400 rather than a wrong-looking result — and it is the one part of the SDK
 * path a test can reach without a real client.
 *
 * Pre-4.6 models reject both of the modern request's distinguishing features,
 * so the shape is chosen from the model rather than fixed. Adaptive thinking is
 * **omitted** on those models rather than swapped for a `budget_tokens` budget:
 * the only call that runs on an older model is discovery, which needs no
 * thinking and is faster for skipping it.
 */
export function messageParams(
  system: string,
  prompt: string,
  model: string,
  options: RunOptions,
): Anthropic.MessageStreamParams {
  const legacy = usesLegacyRequestShape(model);
  return {
    model,
    max_tokens: options.maxTokens,
    ...(legacy ? {} : { thinking: { type: 'adaptive' as const } }),
    // The search cap is a digest-size choice, not a coverage one, and is
    // deliberately NOT scaled with the size of the catch-up window: what bounds
    // a useful check is how much a person will read, and that doesn't grow
    // because they were away longer. The portable version of this rule lives in
    // `searchingSystemPrompt()`, since OpenAI's hosted web_search takes no
    // equivalent cap; this stays as a cost guard.
    tools: [
      legacy
        ? { type: 'web_search_20250305' as const, name: 'web_search' as const, max_uses: options.maxSearches }
        : { type: 'web_search_20260209' as const, name: 'web_search' as const, max_uses: options.maxSearches },
    ],
    system,
    messages: [{ role: 'user', content: prompt }],
  };
}

function sdkRunner(getApiKey: () => Promise<string | null>): AnthropicRunner {
  // Cache the client, but key it on the credential it was built with: the user
  // can change the key in Settings mid-session, and a client built with the
  // previous one would keep authenticating as the old key.
  let client: Anthropic | undefined;
  let builtWith: string | null = null;

  return {
    async run(system, prompt, model, options = CHECK_RUN) {
      const apiKey = await getApiKey();
      if (apiKey === null) throw new Error('No Anthropic API key is configured');
      if (client === undefined || builtWith !== apiKey) {
        client = new Anthropic({ apiKey });
        builtWith = apiKey;
      }
      const stream = client.messages.stream(messageParams(system, prompt, model, options));
      const message = await stream.finalMessage();
      if (message.stop_reason === 'refusal') {
        throw new Error('Claude declined to research this topic');
      }
      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      return { text, usage: readUsage(message.usage) };
    },
  };
}

/**
 * Anthropic-backed news provider: `claude-opus-4-8` with adaptive thinking and
 * the `web_search_20260209` server tool, so it finds genuinely new news.
 */
export function createAnthropicProvider(config: {
  model?: string;
  /** Resolves the key at request time; null means none is configured. */
  getApiKey?: () => Promise<string | null>;
  runner?: AnthropicRunner;
} = {}): NewsProvider {
  const model = config.model ?? DEFAULT_ANTHROPIC_MODEL;
  // One seam for "is there a key" and "what is it", so the two can't disagree.
  // Resolved per call rather than at construction, so a key saved in Settings
  // takes effect without a restart — and so constructing a provider to probe
  // its availability never needs credentials.
  const getApiKey = config.getApiKey ?? (async () => (await resolveApiKey('anthropic')).key);
  const runner = config.runner ?? sdkRunner(getApiKey);
  // Discovery gets the fast model *only when the user hasn't chosen one*
  // (NEWS-132) — an explicit setting is an explicit setting, and silently
  // ignoring it would be the more surprising behaviour.
  const discoveryModel = config.model === undefined || config.model === '' ? DISCOVERY_MODELS.anthropic : model;

  return {
    name: 'anthropic',
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
        CHECK_RUN,
      );
      return { ...parseNewsResult(text), usage };
    },
    async suggestTopics(request: SuggestRequest): Promise<SuggestResult> {
      const { text, usage } = await runner.run(
        suggestSystemPrompt(),
        buildSuggestPrompt(request),
        discoveryModel,
        DISCOVER_RUN,
      );
      return { suggestions: parseSuggestResult(text), usage };
    },
  };
}
