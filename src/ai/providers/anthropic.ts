import Anthropic from '@anthropic-ai/sdk';

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
import { DISCOVERY_MODELS, PROVIDER_EFFORT_LEVELS, usesLegacyRequestShape } from '../types.js';
import { parseAnthropicEfforts, parseAnthropicModels } from './anthropic-models.js';

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
  /**
   * How hard the model works (NEWS-189). Absent or '' = the model's own default.
   *
   * **Checks only.** Discovery runs on `claude-haiku-4-5` (DISCOVERY_MODELS),
   * and `output_config.effort` is not merely ignored there — Haiku 4.5 rejects
   * it. Carrying the user's setting into discovery would turn a preference into
   * a 400 on every suggestion request, which is why this rides on RunOptions
   * rather than being read from settings inside `messageParams`.
   */
  effort?: Effort;
}

/** Minimal seam over the Anthropic SDK so tests can inject a fake. */
export interface AnthropicRunner {
  /**
   * The raw model catalogue page (NEWS-251). Optional on the seam so the many
   * fake runners in tests need not grow a method they don't use.
   */
  listCatalogue?(): Promise<unknown>;
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
/** The levels Anthropic's `output_config.effort` accepts, per the SDK's types. */
function isAnthropicEffort(effort: Effort | undefined): effort is Exclude<Effort, '' | 'none' | 'minimal' | 'ultra'> {
  return effort !== undefined && effort !== '' && (PROVIDER_EFFORT_LEVELS.anthropic as readonly string[]).includes(effort);
}

export function messageParams(
  system: string,
  prompt: string,
  model: string,
  options: RunOptions,
): Anthropic.MessageStreamParams {
  const legacy = usesLegacyRequestShape(model);
  // Never on a legacy-shape model: those predate `output_config` and reject it.
  // The same guard that keeps `thinking` off them keeps effort off them.
  //
  // Also narrowed to what Anthropic accepts (NEWS-250). `Effort` is now the
  // *superset* across every provider, and this one takes five of the nine —
  // the SDK's own types say so, `effort?: 'low' | 'medium' | 'high' | 'xhigh' |
  // 'max'` under the comment "All possible effort levels", which is generated
  // from Anthropic's spec and is the closest thing to a vendor answer available
  // without a key. A level this API does not know is dropped rather than sent:
  // silently running at the model's default beats a 400 on every check.
  const effort = !legacy && isAnthropicEffort(options.effort) ? options.effort : null;
  return {
    model,
    max_tokens: options.maxTokens,
    ...(legacy ? {} : { thinking: { type: 'adaptive' as const } }),
    ...(effort === null ? {} : { output_config: { effort } }),
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

    async listCatalogue() {
      const apiKey = await getApiKey();
      if (apiKey === null) throw new Error('No Anthropic API key is configured');
      if (client === undefined || builtWith !== apiKey) {
        client = new Anthropic({ apiKey });
        builtWith = apiKey;
      }
      // One page: the catalogue is short, and the picker shows 20. Paginating
      // would spend requests to rank models nobody scrolls to.
      return client.models.list();
    },
  };
}

/**
 * Anthropic-backed news provider: `claude-opus-4-8` with adaptive thinking and
 * the `web_search_20260209` server tool, so it finds genuinely new news.
 */
export function createAnthropicProvider(config: {
  model?: string;
  /** Effort for *checks* (NEWS-189); '' or absent = the model's default. */
  effort?: Effort;
  /** Resolves the key at request time; null means none is configured. */
  getApiKey?: () => Promise<string | null>;
  runner?: AnthropicRunner;
} = {}): NewsProvider {
  const model = config.model ?? DEFAULT_ANTHROPIC_MODEL;
  // Applied to checks only — see RunOptions.effort for why discovery must not
  // inherit it.
  const checkRun: RunOptions = { ...CHECK_RUN, effort: config.effort ?? '' };
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
  /**
   * The catalogue, fetched at most once per provider instance (NEWS-251).
   *
   * `listModels` and `effortLevelsFor` both need it and are asked together by
   * `/api/models`, so without this a single Settings tab costs two identical
   * round trips. A failure is memoised as "no catalogue" rather than retried on
   * every call: the picker degrades to the static list, and a provider that
   * cannot enumerate should not keep paying for the discovery.
   */
  let catalogueOnce: Promise<unknown> | undefined;
  const catalogue = (): Promise<unknown> => {
    catalogueOnce ??= (runner.listCatalogue?.() ?? Promise.resolve(null)).catch(() => null);
    return catalogueOnce;
  };

  return {
    name: 'anthropic',
    model,
    // What checks will actually run at — read off the provider when recording a
    // run, not off settings, which can change mid-sweep (NEWS-226).
    effort: config.effort ?? '',
    // Metered and billed per token — safe to run on a schedule unattended.
    attended: false,
    isAvailable: async () => (await getApiKey()) !== null,
    listModels: async () => rankModels(parseAnthropicModels(await catalogue())),
    // Per model, from the model's own declared capabilities (NEWS-251) — the
    // same per-model fact Codex keeps in its cache. Falls back to the
    // provider's union when the catalogue cannot be fetched or says nothing.
    effortLevelsFor: async (m: string) => {
      const levels = parseAnthropicEfforts(await catalogue(), m !== '' ? m : model);
      return levels.length > 0 ? levels : [...PROVIDER_EFFORT_LEVELS.anthropic];
    },
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
        checkRun,
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
