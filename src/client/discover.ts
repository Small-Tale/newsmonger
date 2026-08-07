import { AUTO_ORDER } from '../ai/types.js';
import type { TopicSuggestion } from '../api/schemas.js';
import { MAX_TUNE_ROUNDS } from '../api/schemas.js';
import type { Category } from '../categories.js';
import { activeCategories, BUILTIN_CATEGORIES, NO_SUBCATEGORY_LABEL, UNCATEGORIZED_LABEL } from '../categories.js';

/**
 * Pure helpers behind the discovery dialog (NEWS-126).
 *
 * Kept out of `app.tsx` so the grouping and labelling rules are unit-testable
 * without a DOM — the same split `search.ts` and `solo.ts` already use.
 */

/** The section tiles, retired ones excluded (FR-24.2). */
export function sectionTiles(): Category[] {
  return activeCategories(BUILTIN_CATEGORIES);
}

/** The subcategories of one section, or null when the slug isn't one. */
export function sectionFor(slug: string): Category | undefined {
  return sectionTiles().find((c) => c.slug === slug);
}

export interface SuggestionGroup {
  /** Section heading — "Sports · Motorsport", or the uncategorized label. */
  label: string;
  /** Stable key for the row, since a label can repeat across renders. */
  key: string;
  suggestions: TopicSuggestion[];
}

/**
 * Group suggestions by section for display (FR-24.4).
 *
 * The grouping doubles as a preview of where each topic will file itself in the
 * filter bar, so the labels are deliberately the *same* ones that bar uses
 * rather than a discovery-specific wording — a suggestion shown under "Sports ·
 * Motorsport" lands exactly there.
 *
 * Order follows the taxonomy, not the model's output order, so browsing twice
 * doesn't reshuffle the page. Unclassified suggestions sort last: they are the
 * ones the model couldn't place, and leading with them buries the rest.
 */
export function groupSuggestions(suggestions: TopicSuggestion[]): SuggestionGroup[] {
  const table = sectionTiles();
  const groups = new Map<string, SuggestionGroup>();

  const push = (key: string, label: string, suggestion: TopicSuggestion): void => {
    const existing = groups.get(key);
    if (existing) existing.suggestions.push(suggestion);
    else groups.set(key, { key, label, suggestions: [suggestion] });
  };

  for (const suggestion of suggestions) {
    const classification = suggestion.classification;
    if (classification === null) {
      push('~uncategorized', UNCATEGORIZED_LABEL, suggestion);
      continue;
    }
    const category = table.find((c) => c.slug === classification.category);
    if (category === undefined) {
      // The server validates against the same table, so this is unreachable in
      // practice — but rendering *something* beats dropping a suggestion the
      // user might have wanted because a slug went stale mid-session.
      push('~uncategorized', UNCATEGORIZED_LABEL, suggestion);
      continue;
    }
    const sub = category.subcategories.find((s) => s.slug === classification.subcategory);
    const key = `${category.slug}/${sub?.slug ?? ''}`;
    // A section with no subcategories at all renders its name alone (NEWS-405).
    // "· Other" answers "which subject?" for a section that has none to offer,
    // and for the *Other* section specifically it would read "Other · Other".
    // `categoryLabel` already behaves this way; this brings the grouping in line.
    const label =
      category.subcategories.length === 0
        ? category.label
        : `${category.label} · ${sub?.label ?? NO_SUBCATEGORY_LABEL}`;
    push(key, label, suggestion);
  }

  // Sorted by *both* levels: ordering only by category would leave two
  // subcategories of the same section in whatever order the model happened to
  // emit them, which is exactly the reshuffling this is meant to prevent.
  const order = (key: string): [number, number] => {
    if (key === '~uncategorized') return [Number.MAX_SAFE_INTEGER, 0];
    const [categorySlug, subSlug] = key.split('/');
    const categoryIndex = table.findIndex((c) => c.slug === categorySlug);
    const subs = table[categoryIndex]?.subcategories ?? [];
    // A category with no subcategory sorts after its named subsections: "Other"
    // is the leftovers, and leading with it reads as the section's headline.
    const subIndex = subSlug === '' ? subs.length : subs.findIndex((s) => s.slug === subSlug);
    return [categoryIndex, subIndex];
  };
  return [...groups.values()].sort((a, b) => {
    const [ac, as] = order(a.key);
    const [bc, bs] = order(b.key);
    return ac === bc ? as - bs : ac - bc;
  });
}

/** Heading describing where a result list came from, for the results pane. */
export function resultsHeading(from: { kind: 'describe'; query: string } | { kind: 'section'; category: string; subcategory: string | null }): string {
  if (from.kind === 'describe') {
    const query = from.query.trim();
    // The empty box is "surprise me" (FR-24.3), so it needs a heading that
    // reads as a deliberate answer rather than a failed search.
    return query === '' ? 'A bit of everything' : `Because you said “${query}”`;
  }
  const category = sectionFor(from.category);
  if (category === undefined) return 'Suggestions';
  if (from.subcategory === null) return `Anything in ${category.label}`;
  const sub = category.subcategories.find((s) => s.slug === from.subcategory);
  return sub === undefined ? category.label : `${category.label} · ${sub.label}`;
}

/** Label for the ongoing/evergreen badge (FR-24.10). */
export function kindLabel(kind: TopicSuggestion['kind']): string {
  return kind === 'ongoing' ? 'Ongoing story' : 'Evergreen';
}

/**
 * The keep/skip tuner's state machine (NEWS-127, FR-24.5–24.9).
 *
 * Pure and separate from the dialog because it is the one genuinely *stateful*
 * part of discovery: a round advances, a queue drains, a bound is reached, and
 * the interesting failures are all sequences rather than single operations.
 */

/** One tuner session. Null on `DiscoverState` when the user isn't tuning. */
export interface TunerState {
  /** What the tuning is relative to — one suggestion, or the whole result set. */
  anchor: string;
  direction: 'narrower' | 'similar';
  /** 1-based, and never past `MAX_TUNE_ROUNDS` (FR-24.9). */
  round: number;
  /** Candidates for this round, in order. */
  queue: TopicSuggestion[];
  /** How far into `queue` the user has judged. */
  index: number;
  /** Kept suggestions, in full — they are merged back into the list on exit. */
  kept: TopicSuggestion[];
  /** Skipped names. As much signal as the keeps (FR-24.6), so they are kept too. */
  skipped: string[];
  loading: boolean;
  error: string | null;
}

export function startTuner(anchor: string, direction: 'narrower' | 'similar'): TunerState {
  return { anchor, direction, round: 1, queue: [], index: 0, kept: [], skipped: [], loading: true, error: null };
}

/** The candidate awaiting a verdict, or undefined when the round is drained. */
export function currentCandidate(tuner: TunerState): TopicSuggestion | undefined {
  return tuner.queue[tuner.index];
}

/** What the caller must do after a verdict. */
export type TunerNext =
  /** More candidates in this round — just render the next one. */
  | 'continue'
  /** Round drained and the bound allows another — fetch it. */
  | 'fetch-round'
  /** Round drained and the bound is reached — the session is over (FR-24.9). */
  | 'exhausted';

export interface TunerAdvance {
  tuner: TunerState;
  next: TunerNext;
}

/**
 * Record a verdict on the current candidate.
 *
 * Returns the new state rather than mutating, so an in-flight round arriving
 * late can be discarded by comparing against the state the caller still holds.
 * A verdict on a drained queue is a no-op — that is what a double-click on the
 * last card is, and it must not skip a round or push a phantom entry.
 */
export function judgeCandidate(tuner: TunerState, verdict: 'keep' | 'skip'): TunerAdvance {
  const candidate = currentCandidate(tuner);
  if (candidate === undefined) {
    return { tuner, next: tuner.round < MAX_TUNE_ROUNDS ? 'fetch-round' : 'exhausted' };
  }
  const next: TunerState = {
    ...tuner,
    index: tuner.index + 1,
    kept: verdict === 'keep' ? [...tuner.kept, candidate] : tuner.kept,
    skipped: verdict === 'skip' ? [...tuner.skipped, candidate.name] : tuner.skipped,
  };
  if (next.index < next.queue.length) return { tuner: next, next: 'continue' };
  return { tuner: next, next: next.round < MAX_TUNE_ROUNDS ? 'fetch-round' : 'exhausted' };
}

/** Move to the next round with a fresh queue. */
export function nextRound(tuner: TunerState, queue: TopicSuggestion[]): TunerState {
  return { ...tuner, round: tuner.round + 1, queue, index: 0, loading: false, error: null };
}

/**
 * Why the current candidate is being offered (FR-24.8).
 *
 * Without this the loop is a slot machine; with it, a user who can see the model
 * has misread them can skip out rather than abandon the feature. Falls back to
 * the anchor in round one, when there is nothing kept to cite yet.
 */
export function tunerRationale(tuner: TunerState): string {
  const recent = tuner.kept.slice(-3).map((s) => s.name);
  if (recent.length > 0) return `because you kept: ${recent.join(', ')}`;
  // Never "narrower than" the candidate's own name (NEWS-269). A set-level tune
  // anchors on the *heading*, and a heading can be the same string as a topic in
  // the list — which produced a card titled "Semiconductor supply chain"
  // explaining itself as `narrower than “Semiconductor supply chain”`. Saying
  // nothing is better than saying something circular; the reason line above it
  // still carries the substance.
  const candidate = currentCandidate(tuner);
  if (candidate !== undefined && candidate.name.trim() === tuner.anchor.trim()) return '';
  return tuner.direction === 'narrower' ? `narrower than “${tuner.anchor}”` : `similar to “${tuner.anchor}”`;
}

/**
 * A qualifier for the results heading when the answers don't match the question
 * (NEWS-269).
 *
 * Drilling into "Business · Markets" and getting a topic classified
 * "Business · Other" puts two labels eight pixels apart that contradict each
 * other, and the natural reading is that the filter failed. Both are true:
 * the heading is the *request*, the group label is where the topic will actually
 * file itself in the filter bar (FR-24.13), which is information worth keeping.
 *
 * So this explains the gap rather than hiding it. Suppressing the group label
 * would have been easier and would have thrown away the more useful of the two
 * facts.
 *
 * Empty when the request was free text (there is no section to disagree with) or
 * when every group matches — a qualifier on an exact match would be noise.
 */
export function resultsQualifier(
  source: { kind: 'describe'; query: string } | { kind: 'section'; category: string; subcategory: string | null } | null,
  groups: SuggestionGroup[],
): string {
  if (source === null || source.kind !== 'section' || groups.length === 0) return '';
  const wanted = `${source.category}/${source.subcategory ?? ''}`;
  return groups.every((g) => g.key === wanted) ? '' : 'closest matches';
}

/**
 * Fold the kept suggestions back into the result list on exit (FR-24.7).
 *
 * Kept means "show me this in the list", never "create it" — nothing is created
 * without an explicit Add. Existing entries win so a card the user already added
 * doesn't revert to an un-added duplicate, and order is preserved so the list
 * doesn't reshuffle under them.
 */
export function mergeKept(suggestions: TopicSuggestion[], kept: TopicSuggestion[]): TopicSuggestion[] {
  const seen = new Set(suggestions.map((s) => s.name));
  const additions: TopicSuggestion[] = [];
  for (const suggestion of kept) {
    if (seen.has(suggestion.name)) continue;
    seen.add(suggestion.name);
    additions.push(suggestion);
  }
  return [...suggestions, ...additions];
}

/**
 * Whether a discovery request would find a provider to serve it (NEWS-128).
 *
 * Mirrors `resolveProvider` rather than asking "is anything available": an
 * explicitly-chosen provider must itself be usable, and only `auto` falls back
 * to the automatic order. `mock` is excluded from the automatic order for the
 * same reason the auto-open decision excludes it — it always reports available,
 * so counting it would make the app look configured when it is not.
 */
export function providerLikelyUsable(state: {
  providers: { name: string; available: boolean | null }[];
  settings: { provider: string };
}): boolean {
  const available = (name: string): boolean =>
    state.providers.some((p) => p.name === name && p.available === true);
  if (state.settings.provider === 'auto') return AUTO_ORDER.some(available);
  return available(state.settings.provider);
}
