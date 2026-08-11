import OpenAI from 'openai';

import { resolveApiKey } from '../api-keys.js';
import { rankModels } from '../model-list.js';
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
import { DISCOVERY_MODELS, PROVIDER_EFFORT_LEVELS } from '../types.js';

export const DEFAULT_OPENAI_MODEL = 'gpt-5';

/** Minimal seam over the OpenAI SDK so tests can inject a fake. */
export interface OpenAIRunner {
  /**
   * The models this key can use, newest first (NEWS-248). Optional on the seam
   * so existing fake runners in tests need not grow a method they don't use.
   */
  listModels?(): Promise<string[]>;
  run(
    system: string,
    prompt: string,
    model: string,
    effort?: Effort,
    signal?: AbortSignal,
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
 * Written first from a guess, because there was no OpenAI key here — and then
 * **verified against the live API** with a temporary one. Both branches are
 * pinned to verbatim responses in `openai.test.ts`, and the whole path was run
 * end to end: a real `checkTopic` with `effort: 'high'` against `gpt-4o`, a
 * model that cannot take it, returned two real stories in seven seconds by
 * falling back.
 *
 * What the API actually sends, through the SDK this provider uses:
 *
 *   BadRequestError  status 400
 *   param   "reasoning.effort"
 *   code    "unsupported_parameter"
 *   message "400 Unsupported parameter: 'reasoning.effort' is not supported
 *            with this model."
 *
 * A control request without the parameter succeeded on the same key and model,
 * so that is the parameter being refused rather than the model being
 * unavailable.
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

/** The levels the Responses API accepts, per the SDK's `ReasoningEffort`. */
function isOpenAIEffort(effort: Effort | undefined): effort is Exclude<Effort, '' | 'ultra'> {
  return effort !== undefined && effort !== '' && (PROVIDER_EFFORT_LEVELS.openai as readonly string[]).includes(effort);
}

function sdkRunner(getApiKey: () => Promise<string | null>, baseURL: string | undefined): OpenAIRunner {
  // Cached, but rebuilt when the credential changes — see the note in
  // `anthropic.ts`; a key edited in Settings must take effect immediately.
  let client: OpenAI | undefined;
  let builtWith: string | null = null;

  return {
    async run(system, prompt, model, effort, signal) {
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
        //
        // Narrowed to what this API takes (NEWS-250): `Effort` is the superset
        // across providers and the Responses API takes seven of the nine. Its
        // SDK types say `ReasoningEffort = 'none' | 'minimal' | 'low' |
        // 'medium' | 'high' | 'xhigh' | 'max'` — matching, word for word, the
        // set the live API named in a 400 — and notably **without `ultra`**,
        // which is Codex-only. Dropping an unknown level rather than sending it
        // means a Codex user who picked `ultra` and switched to this provider
        // gets the model's default instead of a failed check.
        ...(isOpenAIEffort(effort) ? { reasoning: { effort } } : {}),
      }, { signal });
      return { text: response.output_text, usage: readUsage(response.usage) };
    },

    async listModels() {
      const apiKey = await getApiKey();
      if (apiKey === null) throw new Error('No OpenAI API key is configured');
      const c = new OpenAI({ apiKey, ...(baseURL !== undefined && baseURL !== '' ? { baseURL } : {}) });
      // One page is plenty — the catalogue is ~130 entries and the picker shows
      // 20. Auto-paginating would spend requests to rank models nobody scrolls to.
      const page = await c.models.list();
      return rankModels(page.data.map((m) => ({ id: m.id, created: m.created })));
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
    effortLevelsFor: () => [...PROVIDER_EFFORT_LEVELS.openai],
    listModels: runner.listModels?.bind(runner),
    async checkTopic(
      topicName: string,
      known: KnownItem[],
      sinceIso: string | null,
      context: TopicContext = {},
      signal?: AbortSignal,
    ): Promise<CheckResult> {
      const system = searchingSystemPrompt();
      const prompt = buildUserPrompt(topicName, known, sinceIso, context);
      const wanted = rejectsEffort.has(model) ? '' : effort;
      let result;
      try {
        result = await runner.run(system, prompt, model, wanted, signal);
      } catch (err) {
        // Asked for reasoning and this model does not do reasoning. Rather than
        // deciding in advance which models qualify — a claim about someone
        // else's API, and the exact kind that has been wrong twice today — ask,
        // and take the answer. Remembered so it costs one request, not every one.
        if (wanted === '' || !looksLikeEffortRejection(err)) throw err;
        rejectsEffort.add(model);
        result = await runner.run(system, prompt, model, '', signal);
      }
      return { ...parseNewsResult(result.text), usage: result.usage };
    },
    async suggestTopics(request: SuggestRequest): Promise<SuggestResult> {
      const { text, usage } = await runner.run(suggestSystemPrompt(), buildSuggestPrompt(request), discoveryModel);
      return { suggestions: parseSuggestResult(text), usage };
    },
  };
}
