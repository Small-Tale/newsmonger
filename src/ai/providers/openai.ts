import OpenAI from 'openai';

import { resolveApiKey } from '../api-keys.js';
import { buildUserPrompt, parseNewsResult, searchingSystemPrompt } from '../prompt.js';
import { buildSuggestPrompt, parseSuggestResult, suggestSystemPrompt } from '../suggest-prompt.js';
import type {
  CheckResult,
  Effort,
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
  run(
    system: string,
    prompt: string,
    model: string,
    effort?: Effort,
  ): Promise<{ text: string; usage: TokenUsage | null }>;
}

/**
 * Does this error say the request was rejected *for asking about reasoning*
 * (NEWS-245)?
 *
 * The Responses API takes `reasoning: { effort }`, but only reasoning models
 * accept it — and unlike the two CLI providers, this one lets the user type any
 * model id and can point at an OpenAI-compatible gateway through
 * `OPENAI_BASE_URL`. So "is this a reasoning model" is not knowable from the id.
 *
 * **The obvious answer is a list of reasoning-model prefixes, and it is the
 * wrong one.** A list of members goes stale the moment a new family ships, and
 * it fails in the direction that is hardest to notice: the new model silently
 * does *not* get the effort the user asked for. That is the same shape as the
 * hardcoded model list corrected in NEWS-243, and this codebase already prefers
 * the inversion — see `usesLegacyRequestShape`, which enumerates exceptions so
 * anything newer gets the modern treatment by default.
 *
 * Here even the inversion would be a claim about someone else's API. There is
 * no OpenAI key on this machine, so two errors were captured through the Codex
 * CLI's ChatGPT-subscription path instead (pinned in `openai.test.ts`):
 *
 *   400 "[ReasoningEffortParam] [reasoning.effort] [invalid_enum_value] …"
 *   400 "The 'gpt-4o' model is not supported when using Codex with a ChatGPT account."
 *
 * The first shows that a reasoning-parameter error **names the parameter in the
 * message**, which is what this match relies on. The second is a real 400 with
 * nothing to do with reasoning, and confirms the narrowness earns its keep.
 *
 * **What is still unverified is the case this exists for**: a genuine "this
 * model does not do reasoning" refusal. A ChatGPT subscription rejects a
 * non-reasoning model *before* the parameter is evaluated — confirmed against
 * `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `gpt-5-chat-latest` and
 * `gpt-5.1-chat-latest`, all of which answer "not supported when using Codex
 * with a ChatGPT account". Codex offers reasoning models only, so this route
 * cannot produce the response at all; closing the gap needs an OpenAI API key. Hence asserting nothing about which models
 * qualify — ask the API, believe the answer, and if the guess about the
 * rejection shape is wrong the cost is one un-retried check with a clear error
 * rather than a silently wrong request forever.
 *
 * Deliberately narrow. A 400 that says nothing about reasoning is a real error
 * — a bad key, a bad model, a malformed prompt — and retrying those would
 * double every failing request and hide the cause behind a second identical
 * failure.
 */
export function looksLikeEffortRejection(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { status?: unknown; param?: unknown; code?: unknown; message?: unknown };
  if (e.status !== 400) return false;
  const haystack = [e.param, e.code, e.message]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase();
  return haystack.includes('reasoning') || haystack.includes('effort');
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
    async run(system, prompt, model, effort) {
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
        // Omitted entirely at `''` — "provider default" has to mean the request
        // is the one it always was, not a request that names a level called "".
        ...(effort !== undefined && effort !== '' ? { reasoning: { effort } } : {}),
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
  effort?: Effort;
  baseURL?: string;
  /** Resolves the key at request time; null means none is configured. */
  getApiKey?: () => Promise<string | null>;
  runner?: OpenAIRunner;
} = {}): NewsProvider {
  const model = config.model ?? DEFAULT_OPENAI_MODEL;
  const effort = config.effort ?? '';
  /**
   * Models this process has seen reject `reasoning.effort`, so the wasted
   * request is paid once rather than on every check. In memory on purpose:
   * whether a model accepts it is a fact about the vendor today, and a restart
   * is the right moment to ask again.
   */
  const rejectsEffort = new Set<string>();
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
    effort,
    // Metered and billed per token — safe to run on a schedule unattended.
    attended: false,
    isAvailable: async () => (await getApiKey()) !== null,
    async checkTopic(
      topicName: string,
      known: KnownItem[],
      sinceIso: string | null,
      context: TopicContext = {},
    ): Promise<CheckResult> {
      const system = searchingSystemPrompt();
      const prompt = buildUserPrompt(topicName, known, sinceIso, context);
      const wanted = rejectsEffort.has(model) ? '' : effort;
      let result;
      try {
        result = await runner.run(system, prompt, model, wanted);
      } catch (err) {
        // Asked for reasoning and this model does not do reasoning. Rather than
        // deciding in advance which models qualify — a claim about someone
        // else's API, and the exact kind that has been wrong twice today — ask,
        // and take the answer. Remembered so it costs one request, not every one.
        if (wanted === '' || !looksLikeEffortRejection(err)) throw err;
        rejectsEffort.add(model);
        result = await runner.run(system, prompt, model, '');
      }
      return { ...parseNewsResult(result.text), usage: result.usage };
    },
    async suggestTopics(request: SuggestRequest): Promise<SuggestResult> {
      const { text, usage } = await runner.run(suggestSystemPrompt(), buildSuggestPrompt(request), discoveryModel);
      return { suggestions: parseSuggestResult(text), usage };
    },
  };
}
