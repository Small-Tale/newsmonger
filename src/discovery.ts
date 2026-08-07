import { MAX_SUGGESTIONS } from './ai/suggest-prompt.js';
import type { CategoryOption, SuggestRequest, SuggestScope, TopicSuggestion } from './ai/types.js';
import type { CategoryTable } from './categories.js';
import { activeCategories, BUILTIN_CATEGORIES, findCategory, findSubcategory } from './categories.js';
import type { ProviderResolver } from './checks.js';
import type { Store } from './db/store.js';
import { profileLabels } from './profiles.js';

/**
 * The server half of topic discovery (NEWS-125, `docs/24-topic-discovery.md`).
 *
 * Sits between the route and the provider and owns the four things the provider
 * deliberately does not: who to exclude, how long an answer stays reusable,
 * which classifications are real, and what the call cost.
 *
 * Deliberately **not** part of `CheckRunner`. That class is topic-shaped all the
 * way down — its retry state, its in-flight guard and its run records are all
 * keyed by topic — and a discovery call has no topic.
 */

/** How long a suggestion answer stays reusable (FR-24.15). */
export const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;

/** How many recent calls the in-memory log keeps. */
const LOG_SIZE = 50;

/** One recorded discovery call (FR-24.14). */
export interface DiscoveryCall {
  at: string;
  /** Which entry path — so a runaway tuner is distinguishable from browsing. */
  scope: SuggestScope['kind'];
  provider: string | null;
  model: string | null;
  status: 'succeeded' | 'failed';
  /** Suggestions returned to the client, after filtering. */
  returned: number;
  /** True when the answer came from the cache and cost nothing. */
  cached: boolean;
  error: string | null;
}

export interface DiscoveryResult {
  suggestions: TopicSuggestion[];
  /** Whether this answer was served from the cache (FR-24.15). */
  cached: boolean;
}

interface CacheEntry {
  at: number;
  suggestions: TopicSuggestion[];
}

/**
 * A stable cache key for a request, **and for who was asked** (NEWS-258).
 *
 * The exclusions are part of it on purpose: adding a topic changes what a valid
 * answer looks like, so the entry that would now suggest a topic the user
 * already follows must not survive the change.
 *
 * `providerSignature` is part of it for the same reason, and it was missing.
 * Suggestions are the *model's* answer, so a repeat query after switching
 * provider would have been served the previous provider's ideas — long after
 * every other part of the app had moved on.
 *
 * Keyed rather than cleared on change: a caller cannot forget a key, and
 * switching back finds the earlier answers still there instead of paying for
 * them twice. The parameter is required for the same reason — an optional one
 * would let a future caller silently reinstate the bug.
 */
export function cacheKeyFor(request: SuggestRequest, providerSignature: string): string {
  return JSON.stringify({
    scope: request.scope,
    exclude: [...request.exclude].sort((a, b) => a.localeCompare(b)),
    // In the key for the same reason `exclude` is (NEWS-386): the profiles change
    // what a valid answer *is*, so an entry computed before the user edited them
    // would serve a spread aimed at someone else. Sorted so the key does not
    // depend on the order they happen to arrive in.
    profiles: [...(request.profiles ?? [])].sort((a, b) => a.localeCompare(b)),
    limit: request.limit ?? null,
    provider: providerSignature,
  });
}

/**
 * Whether a request is unscoped enough for the reader profiles to bias it
 * (NEWS-386).
 *
 * **Only where the user has not said what they want.** An empty free-text box is
 * "surprise me" (FR-24.3) and a bare section is "anything in here" (FR-24.2) —
 * both are requests for a spread, and a spread aimed at this reader beats the
 * same generic one everybody gets.
 *
 * A typed query, a drilled-in subcategory or a tuner round is the opposite: the
 * user named the thing. Re-ranking that by something ticked once during setup
 * produces exactly the heading-says-one-thing / results-say-another gap FR-24.12a
 * had to write a "closest matches" note to explain — and here it would be
 * self-inflicted rather than inherent.
 */
export function profilesApplyTo(scope: SuggestScope): boolean {
  if (scope.kind === 'describe') return scope.query.trim() === '';
  if (scope.kind === 'section') return scope.subcategory === null;
  return false;
}

/**
 * The stored profiles as prompt-ready labels, or nothing at all.
 *
 * Returns a spreadable object rather than an array so the caller can omit the
 * field entirely when there is nothing to say — an empty `profiles: []` would
 * still enter the cache key as a distinct value from absent, splitting the cache
 * for no reason.
 */
function profilesFor(store: Store): { profiles?: string[] } {
  const labels = profileLabels(store.getSettings().profiles);
  return labels.length === 0 ? {} : { profiles: labels };
}

/**
 * Normalize a topic name for "do we already follow this?" (FR-24.11).
 *
 * Deliberately not `normalizeTitle` from `ai/dedupe.ts`, which *deletes*
 * punctuation because it compares news headlines. In a topic name a hyphen or a
 * slash stands in for a space — "formula-1" and "Formula 1" are the same
 * subject — so punctuation becomes a separator here instead. Using the headline
 * rule would let a re-punctuated duplicate through, which is exactly the
 * suggestion this layer exists to catch.
 */
export function normalizeTopicName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export class DiscoveryService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly log: DiscoveryCall[] = [];

  constructor(
    private readonly store: Store,
    private readonly resolveProvider: ProviderResolver,
    private readonly options: {
      ttlMs?: number;
      /** Injectable clock, so cache-expiry tests need not sleep. */
      now?: () => number;
      categories?: CategoryTable;
    } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * Who a suggestion would be asked of: provider, model, effort (NEWS-258).
   *
   * The same three fields that cancel an in-flight check (FR-2.11), for the same
   * reason — they are the ones that change *what comes back*.
   */
  private providerSignature(): string {
    const { provider, model, effort } = this.store.getSettings();
    return `${provider}|${model}|${effort}`;
  }

  /** Recent calls, newest first (FR-24.14). */
  recentCalls(): DiscoveryCall[] {
    return [...this.log].reverse();
  }

  /** How many calls have been made this process lifetime. */
  callCount(): number {
    return this.calls;
  }

  private calls = 0;

  private record(entry: DiscoveryCall): void {
    this.calls += 1;
    this.log.push(entry);
    if (this.log.length > LOG_SIZE) this.log.shift();
  }

  /**
   * Ask for topic suggestions.
   *
   * `scope` comes from the client; everything else is filled in here so the
   * client cannot forget it — which is the entire point of the first exclusion
   * layer (FR-24.11).
   */
  async suggest(scope: SuggestScope, limit?: number, seen: string[] = []): Promise<DiscoveryResult> {
    const topics = this.store.listTopics();
    const request: SuggestRequest = {
      scope,
      // Topic names first and always; `seen` only *adds* to them (NEWS-136), so
      // asking for more ideas can never weaken the FR-24.11 guarantee.
      exclude: [...topics.map((t) => t.name), ...seen],
      // Resolved here, not sent by the client, so no path can forget them — and
      // resolved to *labels*, since ids are storage and the model reads prose.
      // Unknown ids drop out on the way through (`profileLabels`).
      ...(profilesApplyTo(scope) ? profilesFor(this.store) : {}),
      categoryOptions: this.categoryOptions(),
      ...(limit === undefined ? {} : { limit: Math.min(limit, MAX_SUGGESTIONS) }),
    };

    // Read from settings rather than by resolving the provider: a cache hit is
    // meant to cost nothing, and resolving would both build a client and throw
    // when nothing is configured — which would take away the ability to look at
    // suggestions you already have without a key.
    const key = cacheKeyFor(request, this.providerSignature());
    const hit = this.cache.get(key);
    if (hit !== undefined && this.now() - hit.at < (this.options.ttlMs ?? DEFAULT_CACHE_TTL_MS)) {
      // Recorded like any other call, but flagged as free — otherwise the log
      // reads as though discovery were far more expensive than it is.
      this.record({
        at: new Date(this.now()).toISOString(),
        scope: scope.kind,
        provider: null,
        model: null,
        status: 'succeeded',
        returned: hit.suggestions.length,
        cached: true,
        error: null,
      });
      return { suggestions: hit.suggestions, cached: true };
    }

    let provider;
    try {
      provider = await this.resolveProvider();
    } catch (err) {
      this.record({
        at: new Date(this.now()).toISOString(),
        scope: scope.kind,
        provider: null,
        model: null,
        status: 'failed',
        returned: 0,
        cached: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    try {
      const result = await provider.suggestTopics(request);
      const suggestions = this.clean(result.suggestions, [...topics.map((t) => t.name), ...seen]);
      this.cache.set(key, { at: this.now(), suggestions });
      this.record({
        at: new Date(this.now()).toISOString(),
        scope: scope.kind,
        provider: provider.name,
        model: provider.model,
        status: 'succeeded',
        returned: suggestions.length,
        cached: false,
        error: null,
      });
      return { suggestions, cached: false };
    } catch (err) {
      this.record({
        at: new Date(this.now()).toISOString(),
        scope: scope.kind,
        provider: provider.name,
        model: provider.model,
        status: 'failed',
        returned: 0,
        cached: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /** The taxonomy offered to the model for pre-classification (FR-24.13). */
  private categoryOptions(): CategoryOption[] {
    return this.categories().map((c) => ({
      slug: c.slug,
      label: c.label,
      subcategories: c.subcategories.map((s) => ({ slug: s.slug, label: s.label })),
    }));
  }

  /** Retired sections excluded, exactly as the check-time classifier does (FR-22.4). */
  private categories(): CategoryTable {
    return activeCategories(this.options.categories ?? BUILTIN_CATEGORIES);
  }

  /**
   * The second exclusion layer, plus classification validation.
   *
   * The request already told the model what not to suggest, and this assumes it
   * ignored that — because it sometimes does, and a suggestion for a topic the
   * user already follows is the most obviously-broken thing this feature can
   * produce. Matching is on the normalized name (see `normalizeTopicName`), so
   * "Formula 1" and "formula-1" are the same topic.
   *
   * Classification is validated against the live table here rather than trusted
   * (FR-22.8 / FR-24.13): a slug the taxonomy doesn't have is dropped, leaving
   * the suggestion unclassified, which is exactly what it is.
   */
  private clean(suggestions: TopicSuggestion[], existingNames: string[]): TopicSuggestion[] {
    const taken = new Set(existingNames.map(normalizeTopicName));
    const table = this.categories();
    const out: TopicSuggestion[] = [];
    for (const suggestion of suggestions) {
      const normalized = normalizeTopicName(suggestion.name);
      // Also guards against the model returning the same name twice in one
      // batch, which no amount of prompting reliably prevents.
      if (normalized === '' || taken.has(normalized)) continue;
      taken.add(normalized);
      out.push({ ...suggestion, classification: validateClassification(suggestion.classification, table) });
    }
    return out;
  }
}

/** Drop a classification the live taxonomy can't resolve (FR-24.13). */
export function validateClassification(
  classification: TopicSuggestion['classification'],
  table: CategoryTable,
): TopicSuggestion['classification'] {
  if (classification === null) return null;
  const category = findCategory(table, classification.category);
  if (category === undefined) return null;
  // A subcategory that doesn't belong to the chosen category is dropped on its
  // own — the same rule `CheckRunner` applies to a check-time classification:
  // the category is still good, and Sports with no sub is a valid answer
  // (FR-22.6) rather than a reason to discard the whole thing.
  const sub = findSubcategory(table, category.slug, classification.subcategory);
  return { category: category.slug, subcategory: sub?.slug ?? null };
}
