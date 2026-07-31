/** A news story returned by a news service, before deduplication. */
export interface FoundNewsItem {
  title: string;
  summary: string;
  sources: { title: string; url: string; outlet?: string | null; publishedAt?: string | null }[];
}

/** A previously-seen story, passed to the service so it can avoid re-reporting. */
export interface KnownItem {
  title: string;
  foundAt: string;
}

/**
 * What one check consumed (NEWS-79). Counts only — money is derived from these
 * at display time via `src/ai/pricing.ts`, so a price change can never make a
 * stored record wrong.
 */
export interface TokenUsage {
  inputTokens: number;
  /** Input tokens served from the prompt cache (billed at a fraction of input). */
  cacheReadTokens: number;
  /** Input tokens written to the prompt cache (billed at a premium). */
  cacheWriteTokens: number;
  outputTokens: number;
  /** Server-side web searches, billed per search on top of tokens. */
  webSearches: number;
}

/**
 * What a provider returns from a check.
 *
 * `usage` is null when the provider cannot report it — the subscription CLIs
 * spend plan quota rather than metered dollars, and they say nothing about
 * tokens. Null means "unknown", never "zero"; see `estimateCostUsd`.
 */
export interface CheckResult {
  items: FoundNewsItem[];
  usage: TokenUsage | null;
  /**
   * The model's section classification for the topic (NEWS-97), when one was
   * asked for. Null when it wasn't asked, or the model declined.
   *
   * Slugs here are **untrusted** — a model can return one that isn't in the
   * taxonomy. The caller validates before storing; an unresolvable slug renders
   * identically to never having been classified, so a silent bad write would be
   * invisible (FR-22.8).
   */
  classification?: TopicClassification | null;
}

/** A section the model assigned to a topic. `subcategory` null means none fit. */
export interface TopicClassification {
  category: string;
  subcategory: string | null;
}

/** A category and its subcategories, as offered to the model. */
export interface CategoryOption {
  slug: string;
  label: string;
  subcategories: { slug: string; label: string }[];
}

/**
 * What the user has told us about a topic beyond its name.
 *
 * The two halves are deliberately different in kind: `guidance` is what the
 * user *said* they want, `offTopicTitles` is what their behaviour revealed they
 * didn't. Both steer the same prompt, so they travel together.
 */
export interface TopicContext {
  /**
   * The user's own free-text steer for this topic (NEWS-80) — "regulatory news
   * only, not stock moves". Empty or absent means the topic name alone.
   */
  guidance?: string;
  /**
   * Stories the user flagged as off-topic (NEWS-61), passed to the prompt as
   * negative examples so the model can infer the topic's intended sense.
   */
  offTopicTitles?: string[];
  /**
   * Sections to classify this topic into (NEWS-97), or absent to not ask.
   *
   * Passed only for a topic that still needs classifying, so an already-labelled
   * topic doesn't spend tokens on the question every check — and can't drift to
   * a different answer each time.
   */
  categoryOptions?: CategoryOption[];
}

/**
 * Whether a suggested topic will keep producing news indefinitely (NEWS-116).
 *
 * `ongoing` is a live story that burns out — "2026 midterms". `evergreen` is a
 * standing subject that doesn't — "Formula 1". Surfaced on the card rather than
 * hidden (FR-24.10), because it is the honest answer to "why is this topic
 * quiet now?" three months after it was added.
 */
export type SuggestionKind = 'ongoing' | 'evergreen';

/** One suggested topic, before anything has been created from it. */
export interface TopicSuggestion {
  name: string;
  /** One line on why this is being offered — shown on the card (FR-24.4). */
  reason: string;
  kind: SuggestionKind;
  /**
   * A ready-made steer for the topic's `guidance` field (FR-24.12), so a topic
   * added from discovery has a narrowed *first* check rather than a bare name.
   * Empty when the model didn't supply one.
   */
  guidance: string;
  /**
   * Where this belongs in the taxonomy (FR-24.13), so an added topic files
   * itself without a second classification call.
   *
   * **Untrusted**, exactly as `CheckResult.classification` is: the slugs come
   * from the model and are validated against the live table by the caller. Null
   * means the model declined or wasn't asked.
   */
  classification: TopicClassification | null;
}

/**
 * Which of the three entry paths a suggestion request came from.
 *
 * They are one union rather than three methods because they are one call to the
 * model with a different framing — which is what makes shipping both doors and
 * the tuner together cheap rather than three times the work.
 */
export type SuggestScope =
  /** The free-text door (FR-24.3). An empty query means "surprise me". */
  | { kind: 'describe'; query: string }
  /** The section grid (FR-24.2). A null subcategory means "anything in here". */
  | { kind: 'section'; category: string; subcategory: string | null }
  /** A tuner round (FR-24.6) — the depth control, never an entry point. */
  | {
      kind: 'tune';
      /** What the tuning is relative to: one suggestion, or the whole result set. */
      anchor: string;
      /** `narrower` = more specific than the anchor; `similar` = adjacent to it. */
      direction: 'narrower' | 'similar';
      /** Names the user kept so far. */
      kept: string[];
      /** Names the user skipped — as much signal as the keeps (FR-24.6). */
      skipped: string[];
      /** 1-based round number. Bounded by the caller (FR-24.9). */
      round: number;
    };

/** One request for topic suggestions. */
export interface SuggestRequest {
  scope: SuggestScope;
  /**
   * Topic names the user already follows. Never suggest these (FR-24.11) — the
   * first of the two layers, the second being the caller's own filter, because
   * a model will occasionally ignore this one.
   */
  exclude: string[];
  /** Taxonomy to classify into (FR-24.13). Absent or empty means don't ask. */
  categoryOptions?: CategoryOption[];
  /** How many suggestions to aim for. The provider may return fewer. */
  limit?: number;
}

/** What one suggestion call produced. `usage` is null when unknowable — see `CheckResult`. */
export interface SuggestResult {
  suggestions: TopicSuggestion[];
  usage: TokenUsage | null;
}

/** Abstraction over "ask an LLM for news" so tests can substitute a mock. */
export interface NewsService {
  /** `context` is optional so callers and tests need not supply it. */
  checkTopic(
    topicName: string,
    known: KnownItem[],
    sinceIso: string | null,
    context?: TopicContext,
  ): Promise<CheckResult>;
  /**
   * Suggest topics the user might want to follow (NEWS-116).
   *
   * Required rather than optional: discovery has no "this provider can't do it"
   * state in the design, and making it optional would push a capability check
   * into the UI that FR-24 never describes. Every provider implements it.
   */
  suggestTopics(request: SuggestRequest): Promise<SuggestResult>;
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

/**
 * Curated model suggestions per provider, for the Settings combobox.
 *
 * These populate a `<datalist>`, so they are *suggestions* — the field stays
 * free-text, which a custom OpenAI-compatible gateway or a model newer than
 * this list still needs. An empty list means "no suggestions", not "no models".
 * Kept short and current rather than exhaustive; the default (empty model) uses
 * each provider's own default, so the list is discovery, not a requirement.
 */
export const PROVIDER_MODELS: Record<ProviderName, readonly string[]> = {
  auto: [],
  'claude-cli': ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'],
  'codex-cli': ['gpt-5', 'gpt-5-mini', 'o3'],
  anthropic: ['claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5', 'claude-haiku-4-5'],
  openai: ['gpt-5', 'gpt-5-mini', 'o3', 'o4-mini'],
  mock: [],
};

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

/**
 * The order `auto` tries providers in.
 *
 * Subscription-backed CLIs first: someone already paying for Claude or ChatGPT
 * should not need an API key. `mock` is deliberately absent — it always reports
 * itself available, so including it would make an unconfigured app look ready.
 *
 * Declared here rather than in `providers/index.ts` because the **client** needs
 * it too (to predict whether a request would resolve a provider, NEWS-128), and
 * that module pulls in `node:child_process` via the CLI providers.
 */
export const AUTO_ORDER: ConcreteProviderName[] = ['claude-cli', 'codex-cli', 'anthropic', 'openai'];

/**
 * The model each provider uses for **topic discovery** (NEWS-132).
 *
 * Discovery asks a much lighter question than a news check — propose topic
 * *names* with a one-line reason, rather than research and cite stories — so it
 * runs on a fast, cheap model. On Anthropic that is roughly a fifth the price of
 * the check model and noticeably quicker.
 *
 * These are **defaults**, not overrides: a model the user has explicitly chosen
 * in Settings still wins, because an explicit setting is an explicit setting.
 * Empty means "the provider's own default" (the subscription CLIs, where we
 * don't pick the model, and `mock`).
 */
/**
 * How hard the model works on a check (NEWS-189). '' = the provider's default.
 *
 * Declared here rather than in the Anthropic provider because the client renders
 * the dropdown from it and the settings schema validates against it — three
 * copies of a five-item list would eventually disagree.
 *
 * The levels are **named, not numeric, and not evenly spaced**: NEWS-19 measured
 * medium and low at the same 72s while low used ~3x the input tokens. That is why
 * this is a `<select>` and not a slider.
 */
export const EFFORT_LEVELS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/** What each level says to a person choosing one. */
export const EFFORT_LABELS: Record<Effort, string> = {
  '': 'Provider default',
  low: 'Low — fastest, cheapest',
  medium: 'Medium',
  high: 'High — the provider default for most models',
  xhigh: 'Extra high',
  max: 'Max — slowest, most thorough',
};

export const DISCOVERY_MODELS: Record<ConcreteProviderName, string> = {
  'claude-cli': 'claude-haiku-4-5',
  'codex-cli': 'gpt-5-mini',
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-5-mini',
  mock: '',
};

/**
 * Models that predate the request shape `checkTopic` sends (NEWS-132).
 *
 * Two things arrived with the 4.6 generation and are **rejected** by anything
 * older: adaptive thinking (`{type: 'adaptive'}` — the older models take a
 * `budget_tokens` budget instead, and `effort` errors outright), and the
 * `web_search_20260209` tool, which older models replace with the basic
 * `web_search_20250305`.
 *
 * Listed as the *exceptions* rather than enumerating every current model, so a
 * model released after this code was written gets the modern shape by default
 * — the failure mode of guessing wrong on a new model is a 400 the user sees
 * immediately, where guessing wrong on an old one is the same. The list exists
 * because our own discovery default is on it.
 */
const LEGACY_REQUEST_MODELS = ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-5'];

/** Whether a model takes the pre-4.6 request shape (no adaptive thinking, basic web search). */
export function usesLegacyRequestShape(model: string): boolean {
  return LEGACY_REQUEST_MODELS.some((legacy) => model.startsWith(legacy));
}

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
