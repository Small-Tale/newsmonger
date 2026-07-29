import type { SafeHtml } from 'kerfjs';
import { delegate, each, mount } from 'kerfjs';

import type { ProviderName } from '../ai/types.js';
import { PROVIDER_INFO, PROVIDER_MODELS, PROVIDER_NAMES } from '../ai/types.js';
import type { TopicSuggestion } from '../api/schemas.js';
import { MAX_DISCOVER_QUERY_LENGTH, MAX_TUNE_ROUNDS } from '../api/schemas.js';
import {
  BUILTIN_CATEGORIES,
  categoryLabel,
  findCategory,
  hasUncategorized,
  NO_SUBCATEGORY_FILTER,
  UNCATEGORIZED_FILTER,
  UNCATEGORIZED_LABEL,
  visibleCategories,
  visibleSubcategories,
} from '../categories.js';
import type { NewsItem, Topic } from '../db/schemas.js';
import { MAX_GUIDANCE_LENGTH } from '../db/schemas.js';
import {
  addSuggestedTopic,
  addTopic,
  deleteKey,
  deleteTopic,
  discoverTopics,
  refreshFeed,
  refreshKeys,
  refreshProviders,
  refreshState,
  reportForeground,
  saveKey,
  setItemOffTopic,
  setItemSaved,
  setNotifyOnNewItems,
  setTopicGuidance,
  setTopicHighPriority,
  setTopicPaused,
  startCheck,
  updateConcurrency,
  updateDailyTimes,
  updateHighPriorityInterval,
  updateInterval,
  updateProviderSettings,
  updateRetention,
  updateScheduleMode,
} from './api.js';
import { outletFor, publishedLabel } from './attribution.js';
import { buildDiagnostics, formatDuration, runRows } from './diagnostics.js';
import type { TunerState } from './discover.js';
import {
  currentCandidate,
  groupSuggestions,
  judgeCandidate,
  kindLabel,
  mergeKept,
  nextRound,
  providerLikelyUsable,
  resultsHeading,
  sectionFor,
  sectionTiles,
  startTuner,
  tunerRationale,
} from './discover.js';
import { currentFailure } from './failure.js';
import { icon } from './icons.js';
import { ensureNotificationPermission, syncTauriNotificationPermission } from './notifications.js';
import { activeBehindWarnings } from './schedule.js';
import { itemMatchesQuery } from './search.js';
import { shareItem } from './share.js';
import { isAllSoloed, toggleSolo } from './solo.js';
import type { AppState, DiscoverSource, DiscoverState, OnboardingStep } from './stores.js';
import {
  appStore,
  FEED_PAGE,
  ONBOARDING_STEPS,
  readOnboardingSeen,
  STARTER_TOPICS,
  TOPIC_SORT_LABELS,
  TOPIC_SORTS,
  writeOnboardingSeen,
} from './stores.js';
import { openExternalUrl } from './tauri.js';
import { sortTopics } from './topic-sort.js';

const INTERVAL_OPTIONS: { label: string; ms: number }[] = [
  { label: 'Every hour', ms: 60 * 60 * 1000 },
  { label: 'Every 3 hours', ms: 3 * 60 * 60 * 1000 },
  { label: 'Every 6 hours', ms: 6 * 60 * 60 * 1000 },
  { label: 'Every 12 hours', ms: 12 * 60 * 60 * 1000 },
  { label: 'Every day', ms: 24 * 60 * 60 * 1000 },
  { label: 'Every 2 days', ms: 48 * 60 * 60 * 1000 },
  { label: 'Every week', ms: 7 * 24 * 60 * 60 * 1000 },
];

/** Story-retention choices (NEWS-87). 0 = keep everything. */
const RETENTION_OPTIONS: { label: string; days: number }[] = [
  { label: '3 months', days: 90 },
  { label: '6 months', days: 180 },
  { label: '1 year', days: 365 },
  { label: '2 years', days: 730 },
  { label: 'Forever', days: 0 },
];

/** How long a toast stays up before it fades out on its own. */
const TOAST_MS = 2600;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** Debounce for the server-side feed search refetch (NEWS-76). */
const SEARCH_DEBOUNCE_MS = 250;
let searchDebounce: ReturnType<typeof setTimeout> | undefined;

/** Show a transient bottom-of-screen notice, replacing any current one. */
function showToast(message: string): void {
  appStore.actions.setToast(message);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    appStore.actions.setToast(null);
  }, TOAST_MS);
}

function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Label for a feed day group: Today, Yesterday, or "Jul 20". */
function dayLabel(dateKey: string): string {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const keyOf = (d: Date): string => d.toLocaleDateString('en-CA'); // YYYY-MM-DD, local tz
  if (dateKey === keyOf(today)) return 'Today';
  if (dateKey === keyOf(yesterday)) return 'Yesterday';
  const d = new Date(`${dateKey}T12:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const DIAL_R = 8;
const DIAL_C = 2 * Math.PI * DIAL_R;

/**
 * The watch dial: a ring that fills as the next scheduled check approaches.
 * Spins while checking; dashed while paused; empty when never checked.
 */
function dialJsx(topic: Topic, checking: boolean, intervalMs: number): SafeHtml {
  let fraction = 0;
  if (topic.lastCheckedAt !== null && !topic.paused) {
    fraction = Math.min(1, Math.max(0, (Date.now() - Date.parse(topic.lastCheckedAt)) / intervalMs));
  }
  const filled = (fraction * DIAL_C).toFixed(1);
  const state = checking ? 'checking' : topic.paused ? 'paused' : 'watching';
  const title = checking
    ? 'Checking now'
    : topic.paused
      ? 'Paused'
      : topic.lastCheckedAt === null
        ? 'Waiting for first check'
        : `${Math.round(fraction * 100)}% of the way to the next check`;
  return (
    <span class={`dial ${state}`} title={title} aria-hidden="true">
      <svg viewBox="0 0 20 20" width="20" height="20">
        <circle class="dial-track" cx="10" cy="10" r={String(DIAL_R)} />
        <circle
          class="dial-fill"
          cx="10"
          cy="10"
          r={String(DIAL_R)}
          stroke-dasharray={checking ? `${(DIAL_C * 0.3).toFixed(1)} ${DIAL_C.toFixed(1)}` : `${filled} ${DIAL_C.toFixed(1)}`}
        />
      </svg>
    </span>
  );
}

/**
 * A topic row. Actions live in the right-click menu rather than inline
 * buttons — those were hidden until hover but still reserved their width, so
 * every topic name was truncated to pay for controls nobody could see.
 */
function topicRowJsx(
  topic: Topic,
  checking: boolean,
  intervalMs: number,
  selected: boolean,
  soloed: boolean,
  dimmed: boolean,
): SafeHtml {
  const classes = [
    'topic',
    topic.paused ? 'paused' : '',
    topic.highPriority ? 'high-priority' : '',
    selected ? 'selected' : '',
    soloed ? 'soloed' : '',
    dimmed ? 'solo-dimmed' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <li
      class={classes}
      data-key={topic.id}
      data-topic-row={topic.id}
      role="option"
      // Every row is tabbable rather than a roving tabindex: the list is short
      // (a sidebar of topics), and roving focus would need the arrow-key
      // handling this app doesn't otherwise have.
      tabindex="0"
      aria-selected={selected ? 'true' : 'false'}
    >
      {dialJsx(topic, checking, intervalMs)}
      <div class="topic-main">
        <span class="topic-name">{topic.name}</span>
        <span class="topic-meta">
          {checking
            ? 'checking…'
            : topic.paused
              ? 'paused'
              : topic.lastCheckedAt !== null
                ? `checked ${relativeTime(topic.lastCheckedAt)}`
                : 'not checked yet'}
        </span>
        {/* Its own line, below the name and status (NEWS-111). Sharing the row
            meant the label and the topic name competed for the same ~320px and
            both lost — "Consumer Tech" truncated to "CONSUMER …" while "Apple
            (the company…)" lost its tail. A full line fits the whole path and
            gives the name back the width the badge was taking. */}
        {topic.category === null ? (
          ''
        ) : (
          <span class="topic-category">
            {categoryLabel(BUILTIN_CATEGORIES, topic.category, topic.subcategory)}
          </span>
        )}
      </div>
      {/* Always-present slot so the badge appearing can't restructure the row. */}
      <span class="topic-flags">
        {topic.guidance !== '' ? (
          <span class="flag guided" title={`Guidance: ${topic.guidance}`}>
            {icon('guidance', 13)}
          </span>
        ) : (
          ''
        )}
        {topic.highPriority ? (
          <span class="flag high-priority" title="High priority: checked on the shorter interval">
            {icon('star', 13)}
          </span>
        ) : (
          ''
        )}
        {soloed ? <span class="flag">{icon('solo', 13)}</span> : ''}
      </span>
    </li>
  );
}

/**
 * The section filter bar (NEWS-97) — a newspaper's section navigation.
 *
 * Two rows, and the second is deliberately styled unlike the first: the top row
 * is the masthead's sections, the sub-row is that section's subsections. Same
 * shape a newspaper uses, and it keeps "which level am I on" legible without a
 * label saying so.
 *
 * The sub-row only appears once a category is selected — 11 categories plus
 * their ~60 subcategories in one bar would be a wall rather than navigation.
 */
function filterBarJsx(selected: AppState['categoryFilter'], topics: readonly Topic[]): SafeHtml {
  // Only sections something is filed under (NEWS-114) — a pill for a section
  // nobody watches can only ever produce an empty feed.
  const table = visibleCategories(BUILTIN_CATEGORIES, topics, selected?.category ?? null);
  const current = selected === null ? null : findCategory(table, selected.category);
  const subs =
    current === undefined || current === null
      ? []
      : visibleSubcategories(BUILTIN_CATEGORIES, current.slug, topics, selected?.subcategory ?? null);
  return (
    <nav class="filter-bar" aria-label="Filter by section">
      <div class="filter-row filter-row-top">
        <button
          class={`filter-pill${selected === null ? ' active' : ''}`}
          type="button"
          data-filter-category=""
          aria-pressed={selected === null ? 'true' : 'false'}
        >
          All
        </button>
        {table.map((category) => (
          <button
            class={`filter-pill${selected?.category === category.slug ? ' active' : ''}`}
            type="button"
            data-filter-category={category.slug}
            aria-pressed={selected?.category === category.slug ? 'true' : 'false'}
          >
            {category.label}
          </button>
        ))}
        {/* Selects the absence of a category, which no table row can express —
            hence a sentinel slug rather than an entry in the taxonomy. Shown
            only when something is actually unclassified (NEWS-114). */}
        {hasUncategorized(topics, selected?.category ?? null) ? (
          <button
            class={`filter-pill${selected?.category === UNCATEGORIZED_FILTER ? ' active' : ''}`}
            type="button"
            data-filter-category={UNCATEGORIZED_FILTER}
            aria-pressed={selected?.category === UNCATEGORIZED_FILTER ? 'true' : 'false'}
          >
            {UNCATEGORIZED_LABEL}
          </button>
        ) : (
          ''
        )}
      </div>
      {/* Always present, even when empty: this sits above the keyed topics list,
          and a row that comes and going would be a conditional sibling
          (docs/3-ui.md). It also keeps the bar's height from jumping. */}
      <div class="filter-row filter-row-sub">
        {subs.length === 0
          ? ''
          : [
              <button
                class={`filter-subpill${selected?.subcategory === null ? ' active' : ''}`}
                type="button"
                data-filter-subcategory=""
                aria-pressed={selected?.subcategory === null ? 'true' : 'false'}
              >
                All {current?.label ?? ''}
              </button>,
              ...subs.map((sub) => {
                // A null slug is the "Other" pill — topics in this section with
                // no subcategory. The sentinel travels in the attribute because
                // an absence has no slug of its own (FR-22.6).
                const value = sub.slug ?? NO_SUBCATEGORY_FILTER;
                const active = (selected?.subcategory ?? '') === value;
                return (
                  <button
                    class={`filter-subpill${active ? ' active' : ''}`}
                    type="button"
                    data-filter-subcategory={value}
                    aria-pressed={active ? 'true' : 'false'}
                  >
                    {sub.label}
                  </button>
                );
              }),
            ]}
      </div>
    </nav>
  );
}

/** The "off topic" pill. As a button it prompts to unflag (hover reveals an ×
 *  and reddens); as a plain label (review mode) it just marks the card. */
function offTopicPill(itemId: string, interactive: boolean): SafeHtml {
  if (interactive) {
    return (
      <button class="off-topic-pill" type="button" data-unflag-prompt={itemId} title="Off topic — click to unflag">
        {icon('clear', 12)}
        {icon('flag', 12)}
        <span>off topic</span>
      </button>
    );
  }
  return (
    <span class="off-topic-pill label">
      {icon('flag', 12)}
      <span>off topic</span>
    </span>
  );
}

/** A flagged story in the normal feed: a dimmed one-liner the user can undo.
 *  Its `data-key` is deliberately distinct from the full card's (`flag-` prefix)
 *  so kerf morph *swaps* the two structures rather than trying to reshape one
 *  into the other in place — which it botches, given how different they are. */
function flaggedRowJsx(item: NewsItem, topicName: string): SafeHtml {
  return (
    <article class="item flagged-row" data-key={`flag-${item.id}`} data-item-id={item.id}>
      {/* Topic + badge on one line, the title below — a long topic name next to
          the title read as cramped and confusing (NEWS-71). */}
      <div class="flagged-head">
        <span class="item-topic">{topicName}</span>
        {offTopicPill(item.id, true)}
      </div>
      <span class="flagged-title">{item.title}</span>
    </article>
  );
}

function itemJsx(item: NewsItem, topicName: string, variant: 'normal' | 'review' = 'normal'): SafeHtml {
  // A just-flagged story collapses to a dimmed one-liner in the normal feed.
  if (variant === 'normal' && item.offTopic) return flaggedRowJsx(item, topicName);
  const review = variant === 'review';
  return (
    <article class={`item${item.saved ? ' saved' : ''}`} data-key={item.id} data-item-id={item.id}>
      <header>
        <span class="item-topic">{topicName}</span>
        <span class="item-time">{relativeTime(item.foundAt)}</span>
        {review ? (
          offTopicPill(item.id, false)
        ) : (
          <span class="item-actions">
            <button
              class={`item-action bookmark${item.saved ? ' on' : ''}`}
              type="button"
              data-save-item={item.id}
              data-saved={item.saved ? 'true' : 'false'}
              aria-pressed={item.saved ? 'true' : 'false'}
              aria-label={item.saved ? 'Remove bookmark' : 'Save story'}
              title={item.saved ? 'Saved — click to remove' : 'Save story'}
            >
              {icon('bookmark', 15)}
            </button>
            <button
              class="item-action share"
              type="button"
              data-share-item={item.id}
              aria-label="Share story"
              title="Share story"
            >
              {icon('share', 15)}
            </button>
          </span>
        )}
      </header>
      {/* Always-present slot: the picture coming and going must not restructure
          the card (kerf KF-377 — see docs/3-ui.md). Roughly a third of articles
          publish no og:image, so "no picture" is the normal case, not an edge. */}
      <div class="item-media">
        {item.image !== null ? (
          <img
            src={`/api/image/${item.image.hash}`}
            alt=""
            loading="lazy"
            decoding="async"
            data-morph-skip-children
          />
        ) : (
          ''
        )}
      </div>
      <h3>{item.title}</h3>
      <p>{item.summary}</p>
      <ul class="sources">
        {/* `.map()`, not `each()`: sources are static per item (kerf Hard Rule 14),
            and keeping `each()` calls to a fixed set keeps list ids stable. */}
        {item.sources.map((source, i) => (
          <li data-key={`${item.id}-${i}`}>
            <a href={source.url} target="_blank" rel="noopener noreferrer" data-external="1">
              {icon('arrow', 13)}
              {source.title !== '' ? source.title : source.url}
            </a>
            <span class="source-meta">
              <span class="source-outlet">{outletFor(source)}</span>
              {source.publishedAt !== null ? (
                <span class="source-date" title={`Published ${source.publishedAt}`}>
                  {publishedLabel(source.publishedAt, item.foundAt)}
                </span>
              ) : (
                ''
              )}
            </span>
          </li>
        ))}
      </ul>
    </article>
  );
}

function feedJsx(items: NewsItem[], topicNames: Map<string, string>, variant: 'normal' | 'review' = 'normal'): SafeHtml[] {
  // Group by local calendar day, newest first. Groups are dynamic, so plain
  // `.map()` (no memoization); items keep data-key for keyed morphing.
  const groups = new Map<string, NewsItem[]>();
  for (const item of items) {
    const key = new Date(item.foundAt).toLocaleDateString('en-CA');
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()].map(([dateKey, dayItems]) => (
    <section class="day" data-key={`day-${dateKey}`}>
      <h2 class="eyebrow">{dayLabel(dateKey)}</h2>
      {dayItems.map((item) => itemJsx(item, topicNames.get(item.topicId) ?? 'unknown topic', variant))}
    </section>
  ));
}

/**
 * "Is the current source usable" line.
 *
 * Lives in the settings dialog beside the provider picker rather than in the
 * sidebar: the provider is chosen here, so this is where knowing whether it
 * actually works is useful. A provider that can't run still surfaces on the
 * page through the failed-check warning banner, so nothing is lost by not
 * repeating it in the sidebar.
 */
function sourceStatusJsx(): SafeHtml {
  const s = appStore.state.value;
  // The provider's name is not repeated here — the picker directly above says
  // it. This line carries only what the picker can't: whether it works.
  const availability = s.providers.find((p) => p.name === s.settings.provider)?.available ?? null;
  const lastProvider = s.runs.find((r) => r.provider !== null)?.provider ?? null;

  return (
    <p class="source-status">
      <span class="source-state">
        {availability === false ? <span class="state warn">{icon('warn', 12)} no API key</span> : ''}
        {availability === true ? <span class="state ok">{icon('ok', 12)} ready</span> : ''}
      </span>
      <span class="source-last">{lastProvider !== null ? `last check via ${lastProvider}` : ''}</span>
    </p>
  );
}

/**
 * One provider's key row.
 *
 * Three states, because they call for different controls: supplied by the
 * environment (nothing to do here — the app can't unset a variable it didn't
 * set), stored in the keychain (offer removal), or absent (offer an input).
 * The stored key is never rendered; when one exists there is no field at all,
 * so there's nothing for a screenshot or a password manager to pick up.
 */
function keyRowJsx(key: AppState['keys'][number], keychainLabel: string, keychainAvailable: boolean): SafeHtml {
  const inputId = `key-input-${key.provider}`;

  if (key.source === 'env') {
    return (
      <div class="key-row" data-key={`key-${key.provider}`}>
        <span class="key-provider">{key.label}</span>
        <span class="key-state ok">
          {icon('ok', 13)} from {key.envVar}
        </span>
        <span class="key-hint">Set in the environment — unset the variable to change it.</span>
      </div>
    );
  }

  if (key.source === 'keychain') {
    return (
      <div class="key-row" data-key={`key-${key.provider}`}>
        <span class="key-provider">{key.label}</span>
        <span class="key-state ok">
          {icon('ok', 13)} stored in {keychainLabel}
        </span>
        <button class="btn subtle" type="button" data-remove-key={key.provider}>
          Remove
        </button>
      </div>
    );
  }

  return (
    <div class="key-row" data-key={`key-${key.provider}`}>
      <span class="key-provider">{key.label}</span>
      <form class="key-form" data-save-key={key.provider}>
        <input
          type="password"
          id={inputId}
          name="api-key"
          class="key-input"
          placeholder={keychainAvailable ? 'Paste API key' : `Set ${key.envVar} instead`}
          autocomplete="off"
          spellcheck="false"
          disabled={keychainAvailable ? undefined : true}
          data-morph-skip-children
        />
        <button class="btn" type="submit" disabled={keychainAvailable ? undefined : true}>
          Save
        </button>
      </form>
    </div>
  );
}

/**
 * Whether a provider spends a personal subscription rather than a metered key.
 *
 * Kept as a small client-side list rather than plumbed through `/api/providers`:
 * it's static metadata, and the dialog only needs it to decide what to explain.
 */
function providerIsAttended(provider: ProviderName): boolean {
  return provider === 'claude-cli' || provider === 'codex-cli';
}

/**
 * In-app confirmation dialog. Replaces `window.confirm`, which is a silent
 * no-op in the Tauri WKWebView — a native confirm returns falsy without ever
 * showing, so every guarded action (delete a topic, remove a key) quietly did
 * nothing in the desktop app. This works identically in a browser and in Tauri.
 */
function confirmDialogJsx(c: NonNullable<AppState['confirm']>): SafeHtml {
  return (
    <div class="dialog-backdrop" data-action="confirm-backdrop">
      <div class="dialog confirm" role="alertdialog" aria-modal="true" aria-label="Confirm">
        <p class="confirm-message">{c.message}</p>
        <div class="confirm-actions">
          <button class="btn" type="button" data-action="confirm-cancel">
            Cancel
          </button>
          <button class={`btn ${c.danger ? 'danger-solid' : 'primary'}`} type="button" data-action="confirm-ok">
            {c.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Show the confirmation dialog and resolve with the user's choice.
 *
 * The resolver lives at module scope rather than in the store: it's a callback,
 * not renderable state, and only ever one dialog is open. Opening a second
 * before the first resolves cancels the first, so no promise is left dangling.
 */
let confirmResolver: ((ok: boolean) => void) | null = null;

function confirm(message: string, opts: { confirmLabel?: string; danger?: boolean } = {}): Promise<boolean> {
  confirmResolver?.(false);
  appStore.actions.openConfirm({
    message,
    confirmLabel: opts.confirmLabel ?? 'OK',
    danger: opts.danger ?? false,
  });
  return new Promise<boolean>((resolve) => {
    confirmResolver = resolve;
  });
}

function resolveConfirm(ok: boolean): void {
  appStore.actions.closeConfirm();
  const resolve = confirmResolver;
  confirmResolver = null;
  resolve?.(ok);
}

/**
 * Editor for a topic's guidance (NEWS-80).
 *
 * The textarea is uncontrolled — its JSX children seed it from server state and
 * nothing re-renders it while the user types. Binding it to a signal would fight
 * the 4 s state poll for the cursor, and there is nothing to derive from the
 * draft until it's saved.
 */
function guidanceDialogJsx(topic: Topic): SafeHtml {
  return (
    <div class="dialog-backdrop" data-action="guidance-backdrop">
      <div class="dialog guidance" role="dialog" aria-modal="true" aria-label={`Guidance for ${topic.name}`}>
        <form data-save-guidance={topic.id}>
          <h2>Guidance for “{topic.name}”</h2>
          <p class="dialog-hint">
            Say what you want from this topic — and what you don’t. It’s sent with every check, so the
            model narrows to your sense of the topic instead of guessing from the name alone.
          </p>
          <textarea
            name="guidance"
            rows={5}
            maxLength={MAX_GUIDANCE_LENGTH}
            placeholder="e.g. Regulatory and safety news only — not stock price moves or product rumours."
          >
            {topic.guidance}
          </textarea>
          <div class="confirm-actions">
            <button class="btn" type="button" data-action="close-guidance">
              Cancel
            </button>
            <button class="btn primary" type="submit">
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}


/**
 * Discovery inside onboarding's Topics step (NEWS-128, FR-24.18).
 *
 * Setup is where the need is sharpest, and a brand-new user has no topics yet —
 * which makes this the one place suggestions are guaranteed unfiltered by the
 * FR-24.11 exclusions.
 *
 * Suggestions render as the **same chips** the static starters do, and carry the
 * same `data-starter-topic` attribute. That is deliberate on two counts: picking
 * one is the same act as ticking a starter (nothing is created until Finish), and
 * one attribute means one delegate — two handlers over chips the morph can turn
 * into each other is the bug from NEWS-126 (see `docs/3-ui.md`).
 */
function onboardingSuggestJsx(s: AppState): SafeHtml {
  // Onboarding runs before a provider is necessarily configured — Source comes
  // first but is skippable — so this degrades to the static starters above
  // rather than offering a button that can only fail.
  //
  // The question is precisely "would a request resolve a provider", so this
  // mirrors `resolveProvider`: an explicitly-chosen provider must itself be
  // available, and `auto` falls back to the same order that does. Asking merely
  // whether *any* provider is available gets the explicit case wrong — someone
  // who picked OpenAI and hasn't added a key would be offered a button that
  // cannot work, because an unrelated signed-in CLI happens to be present.
  const usable = providerLikelyUsable(s);
  if (!usable) {
    return (
      <p class="suggest-note">
        Set up a source above and News can suggest topics for you — or just pick from the list.
      </p>
    );
  }
  return (
    <div>
      <form class="onboarding-suggest-form" data-action="onboarding-suggest">
        <input
          type="text"
          name="onboarding-query"
          placeholder="Or describe what you’re into — “i cycle and work in biotech”"
          maxLength={MAX_DISCOVER_QUERY_LENGTH}
          autocomplete="off"
          data-morph-skip-children
        />
        <button class="btn" type="submit" disabled={s.onboardingLoading ? true : undefined}>
          Suggest
        </button>
      </form>
      <div class="onboarding-suggest-results">
        {s.onboardingLoading ? <p class="suggest-note">Asking…</p> : ''}
        {s.onboardingError !== null ? <p class="suggest-note error-note">{s.onboardingError}</p> : ''}
        <div class="starter-topics">
          {s.onboardingSuggestions.map((suggestion) => (
            <button
              class={`chip starter ${s.onboardingTopics.includes(suggestion.name) ? 'on' : ''}`}
              type="button"
              data-starter-topic={suggestion.name}
              title={suggestion.reason}
              aria-pressed={s.onboardingTopics.includes(suggestion.name) ? 'true' : 'false'}
            >
              {suggestion.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Topic discovery (NEWS-126, `docs/24-topic-discovery.md`).
 *
 * Two doors into one result list, and deliberately neither is primary: the box
 * serves someone who sort of knows what they're into, the section grid serves
 * someone who wants to see what exists, and each covers the other's failure. An
 * empty box is "surprise me" (FR-24.3), not an error — which is what stops the
 * blank field being a wall for the very user this feature is for.
 */
function discoverDialogJsx(d: DiscoverState): SafeHtml {
  return (
    <div class="dialog-backdrop" data-action="discover-backdrop">
      <div class="dialog discover" role="dialog" aria-modal="true" aria-label="Discover topics">
        <div class="discover-head">
          <h2>Discover topics</h2>
          <button class="icon-btn" type="button" data-action="close-discover" aria-label="Close">
            {icon('clear')}
          </button>
        </div>

        <form class="discover-search" data-action="discover-search">
          <input
            type="text"
            name="discover-query"
            placeholder="What are you into? — “i cycle and work in biotech”"
            maxLength={MAX_DISCOVER_QUERY_LENGTH}
            autocomplete="off"
            data-morph-skip-children
          />
          <button class="btn primary" type="submit" disabled={d.loading ? true : undefined}>
            Suggest
          </button>
        </form>

        <div class="discover-body">{discoverBodyJsx(d)}</div>
      </div>
    </div>
  );
}

/**
 * The pane below the box: the section grid, a section's subcategories, or results.
 *
 * One always-present container in the caller holds this, so switching panes
 * never restructures the dialog's siblings (see `docs/3-ui.md`).
 */
function discoverBodyJsx(d: DiscoverState): SafeHtml {
  if (d.tuner !== null) return tunerJsx(d.tuner);
  if (d.loading) return <p class="discover-status">Asking…</p>;
  if (d.error !== null) {
    return (
      <div class="discover-status error">
        <p>{d.error}</p>
        <button class="btn" type="button" data-action="discover-retry">
          Try again
        </button>
      </div>
    );
  }
  if (d.view === 'results') return discoverResultsJsx(d);
  return d.section === null ? sectionGridJsx() : subsectionsJsx(d.section);
}

/**
 * The 11 section tiles (FR-24.2).
 *
 * `.map()`, not `each()` — the sections are a constant array, and `each()`
 * memoizes per item by object identity, so a constant list would cache forever
 * and stop re-rendering (kerf hard rule 14).
 */
function sectionGridJsx(): SafeHtml {
  return (
    <div class="discover-pane">
      <p class="discover-hint">…or browse by section.</p>
      <div class="section-grid">
        {sectionTiles().map((category) => (
          <button class="section-tile" type="button" data-discover-nav={`section:${category.slug}`}>
            {category.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** One section's subcategories, plus the escape for someone who knows none of them. */
function subsectionsJsx(slug: string): SafeHtml {
  const category = sectionFor(slug);
  if (category === undefined) return sectionGridJsx();
  return (
    <div class="discover-pane">
      <button class="btn subtle back" type="button" data-action="discover-back">
        ‹ All sections
      </button>
      <h3>{category.label}</h3>
      <div class="section-chips">
        {category.subcategories.map((sub) => (
          <button class="chip" type="button" data-discover-nav={`sub:${slug}/${sub.slug}`}>
            {sub.label}
          </button>
        ))}
        <button class="chip anything" type="button" data-discover-nav={`sub:${slug}/`}>
          Anything in {category.label}
        </button>
      </div>
    </div>
  );
}

/**
 * The result list (FR-24.4), grouped by section.
 *
 * The grouping doubles as a preview of where each topic will file itself in the
 * filter bar once added.
 */
function discoverResultsJsx(d: DiscoverState): SafeHtml {
  const groups = groupSuggestions(d.suggestions);
  return (
    <div class="discover-pane">
      <div class="discover-results-head">
        <button class="btn subtle back" type="button" data-action="discover-back">
          ‹ Back
        </button>
        <h3>{d.source === null ? 'Suggestions' : resultsHeading(d.source)}</h3>
        {d.suggestions.length === 0 || d.source === null ? (
          ''
        ) : (
          <span class="results-depth">
            <button class="link-btn" type="button" data-tune={`narrower:${resultsHeading(d.source)}`}>
              ⌄ narrower
            </button>
            <button class="link-btn" type="button" data-tune={`similar:${resultsHeading(d.source)}`}>
              ≈ similar
            </button>
          </span>
        )}
      </div>
      {groups.length === 0 ? (
        <p class="discover-status">
          Nothing new to suggest here — you may already follow everything this turned up.
        </p>
      ) : (
        <div class="suggestion-groups">
          {/* Outer `each()` for the keyed group list; inner `.map()` because a
              nested `each()` is never reconciled — the row is flattened to HTML,
              so the inner list would render as static markup and silently stop
              updating. kerf throws on this in dev, which is how it was caught. */}
          {each(
            groups,
            (group) => (
              <div class="suggestion-group" data-key={group.key}>
                <h4 class="suggestion-group-label">{group.label}</h4>
                {group.suggestions.map((suggestion) =>
                  suggestionCardJsx(suggestion, d.added.includes(suggestion.name)),
                )}
              </div>
            ),
            { key: 'suggestion-groups' },
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The keep/skip tuner (NEWS-127, FR-24.5–24.9).
 *
 * A **depth control**, never an entry point — that distinction is the whole
 * reason this shape was chosen over a tuner-first design. It costs nothing until
 * someone asks to go deeper, and it answers the two questions a static list
 * cannot: *narrower than this* and *more like this*.
 */
function tunerJsx(t: TunerState): SafeHtml {
  const candidate = currentCandidate(t);
  return (
    <div class="discover-pane tuner">
      <div class="tuner-head">
        <span class="tuner-round">
          Round {String(t.round)} of {String(MAX_TUNE_ROUNDS)}
        </span>
        {/* Endable at any point (FR-24.9) — and the only way out, so it is
            never hidden behind a state the user has to reach first. */}
        <button class="btn subtle" type="button" data-tuner="done">
          Done
        </button>
      </div>

      <div class="tuner-body">{tunerCardJsx(t, candidate)}</div>

      <div class="tuner-kept">
        {t.kept.length === 0 ? (
          <span class="tuner-kept-empty">Nothing kept yet.</span>
        ) : (
          <span>
            Kept: {t.kept.map((s) => s.name).join(' · ')}
          </span>
        )}
      </div>
    </div>
  );
}

function tunerCardJsx(t: TunerState, candidate: TopicSuggestion | undefined): SafeHtml {
  if (t.error !== null) {
    return (
      <div class="discover-status error">
        <p>{t.error}</p>
        <button class="btn" type="button" data-tuner="done">
          Back to the list
        </button>
      </div>
    );
  }
  if (t.loading) return <p class="discover-status">Thinking…</p>;
  if (candidate === undefined) {
    return <p class="discover-status">That’s everything — anything you kept is waiting in the list.</p>;
  }
  return (
    <div class="tuner-card">
      <div class="suggestion-main">
        <span class="suggestion-name">{candidate.name}</span>
        <span class={`suggestion-kind ${candidate.kind}`}>{kindLabel(candidate.kind)}</span>
      </div>
      <p class="suggestion-reason">{candidate.reason}</p>
      {/* Why this is being offered (FR-24.8). Without it the loop is a slot
          machine; with it, a user who can see the model has misread them can
          skip out rather than abandon the feature. */}
      <p class="tuner-why">{tunerRationale(t)}</p>
      <div class="tuner-actions">
        <button class="btn" type="button" data-tuner="skip">
          ✕ Skip
        </button>
        <button class="btn primary" type="button" data-tuner="keep">
          ♥ Keep
        </button>
      </div>
    </div>
  );
}

/** One suggestion. Stays put once added — see `DiscoverState.added`. */
function suggestionCardJsx(suggestion: TopicSuggestion, added: boolean): SafeHtml {
  return (
    <div class={`suggestion ${added ? 'added' : ''}`} data-key={suggestion.name}>
      <div class="suggestion-main">
        <span class="suggestion-name">{suggestion.name}</span>
        <span class={`suggestion-kind ${suggestion.kind}`}>{kindLabel(suggestion.kind)}</span>
      </div>
      <p class="suggestion-reason">{suggestion.reason}</p>
      {added ? (
        <span class="suggestion-added">{icon('ok')} Added</span>
      ) : (
        <button class="btn" type="button" data-add-suggestion={suggestion.name}>
          + Add
        </button>
      )}
      {/* The depth controls (FR-24.5). One attribute, one delegate — see the
          delegate/morph rule in docs/3-ui.md. */}
      <span class="suggestion-depth">
        <button class="link-btn" type="button" data-tune={`narrower:${suggestion.name}`} title="More specific than this">
          ⌄ narrower
        </button>
        <button class="link-btn" type="button" data-tune={`similar:${suggestion.name}`} title="Adjacent to this">
          ≈ similar
        </button>
      </span>
    </div>
  );
}

/**
 * First-run flow (NEWS-78).
 *
 * Four steps, because a new user has four things to learn or decide and no
 * reason to guess at any of them: what the app does, how it authenticates,
 * what to watch, and how often. Skippable at every step — an onboarding you
 * can't escape is worse than none.
 */
function onboardingJsx(step: OnboardingStep): SafeHtml {
  const s = appStore.state.value;
  const index = ONBOARDING_STEPS.indexOf(step);
  return (
    <div class="dialog-backdrop onboarding-backdrop">
      <div class="dialog onboarding" role="dialog" aria-modal="true" aria-label="Set up News">
        <div class="onboarding-body">{onboardingStepJsx(step, s)}</div>
        <div class="onboarding-foot">
          <span class="onboarding-dots" aria-hidden="true">
            {ONBOARDING_STEPS.map((name) => (
              <span class={`dot ${name === step ? 'on' : ''}`} />
            ))}
          </span>
          <span class="onboarding-actions">
            <button class="btn subtle" type="button" data-action="onboarding-skip">
              {index === ONBOARDING_STEPS.length - 1 ? 'Close' : 'Skip setup'}
            </button>
            <button class="btn primary" type="button" data-action="onboarding-next">
              {index === ONBOARDING_STEPS.length - 1 ? 'Start watching' : 'Continue'}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

function onboardingStepJsx(step: OnboardingStep, s: AppState): SafeHtml {
  if (step === 'welcome') {
    return (
      <div>
        <h2>News watches topics, not feeds.</h2>
        <p class="onboarding-lead">
          Name the things you want to keep up with. On a schedule you choose, News asks an AI — with live web
          search — whether anything genuinely new has happened, and shows you only that, with links to the
          sources.
        </p>
        <p class="note">
          Nothing is scraped or subscribed to. Each check is a fresh look, and stories you have already been
          shown are never repeated.
        </p>
        <p class="note">
          A check sends the topic’s name and the titles already reported for it — nothing else leaves this
          machine, and News has no servers of its own. The full note is in Settings → Privacy.
        </p>
      </div>
    );
  }
  if (step === 'source') return onboardingSourceJsx(s);
  if (step === 'topics') {
    return (
      <div>
        <h2>What should News watch?</h2>
        <p class="onboarding-lead">
          Pick a few to start with — you can add your own, rename them, or delete them at any time.
        </p>
        <div class="starter-topics">
          {STARTER_TOPICS.map((name) => (
            <button
              class={`chip starter ${s.onboardingTopics.includes(name) ? 'on' : ''}`}
              type="button"
              data-starter-topic={name}
              aria-pressed={s.onboardingTopics.includes(name) ? 'true' : 'false'}
            >
              {name}
            </button>
          ))}
        </div>
        {/* Always-present container: the suggestions block appearing must not
            restructure its siblings (see docs/3-ui.md). */}
        <div class="onboarding-suggest">{onboardingSuggestJsx(s)}</div>
        <p class="note">
          {s.onboardingTopics.length === 0
            ? 'None chosen — that’s fine, you can add topics from the sidebar.'
            : `${String(s.onboardingTopics.length)} chosen. Each is checked on its own, so more topics means more checks.`}
        </p>
      </div>
    );
  }
  return (
    <div>
      <h2>How often should it check?</h2>
      <p class="onboarding-lead">
        Every check costs a little — in API credit, or in your subscription’s quota — so this is the dial that
        matters most. Once a day suits most topics.
      </p>
      <label class="field">
        <span>Check every</span>
        <select data-action="interval">
          {INTERVAL_OPTIONS.map((o) => (
            <option value={String(o.ms)} selected={o.ms === s.settings.checkIntervalMs ? true : undefined}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <p class="note">You can change this in Settings later.</p>
    </div>
  );
}

/**
 * The "how do you want to pay for this" step.
 *
 * Subscription providers come first when they're actually available: someone
 * already paying for Claude or ChatGPT needs no key at all, and that is by far
 * the shortest path to a working app. Burying it under two key fields would
 * hide the easy answer behind the hard one.
 */
function onboardingSourceJsx(s: AppState): SafeHtml {
  const ready = s.providers.filter((p) => p.name !== 'auto' && p.name !== 'mock' && p.available === true);
  const subscriptions = ready.filter((p) => p.name === 'claude-cli' || p.name === 'codex-cli');
  return (
    <div>
      <h2>Where should the news come from?</h2>
      {subscriptions.length > 0 ? (
        <div>
          <p class="onboarding-lead">
            Found a signed-in subscription on this machine — nothing else to set up. Checks will use it, and
            run while News is open.
          </p>
          <ul class="detected">
            {subscriptions.map((p) => (
              <li>
                {icon('ok', 14)}
                <span>{p.label}</span>
              </li>
            ))}
          </ul>
          <p class="note">Prefer to use an API key instead? Add one in Settings — it takes precedence.</p>
        </div>
      ) : ready.length > 0 ? (
        <div>
          <p class="onboarding-lead">A provider is already configured on this machine. You’re ready to go.</p>
          <ul class="detected">
            {ready.map((p) => (
              <li>
                {icon('ok', 14)}
                <span>{p.label}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div>
          <p class="onboarding-lead">
            News needs an AI that can search the web. Either sign in to the Claude or Codex CLI on this
            machine, or paste an API key below — it’s stored in your {s.keychainLabel}, never in a file.
          </p>
          <div class="keys">{s.keys.map((k) => keyRowJsx(k, s.keychainLabel, s.keychainAvailable))}</div>
          <div class="key-notes">{s.keyError !== null ? <p class="banner error">{s.keyError}</p> : ''}</div>
          <p class="note">
            Keys are checked with the provider before they’re saved, so a typo shows up here rather than as a
            failed check tomorrow.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * What leaves this machine, stated plainly (NEWS-91).
 *
 * Checking a topic means sending its name to a third party — the user asks for
 * that by using the app, but nowhere did the app actually say so. This is the
 * disclosure, written to be read rather than to be technically sufficient, and
 * it names the *unobvious* parts: the flagged titles and the already-reported
 * titles both go too, because that is how dedup and steering work.
 */
/**
 * Recent check history (NEWS-88).
 *
 * The store has kept the last 200 runs all along — status, timing, provider,
 * error text — and the UI showed a spinner and one dismissable banner. When
 * something breaks for someone who isn't the author, this is the difference
 * between "it stopped working" and a report anyone can act on.
 */
function diagnosticsJsx(s: AppState): SafeHtml {
  const rows = runRows(s);
  return (
    <div class="diagnostics">
      {rows.length === 0 ? (
        <p class="note">No checks have run yet.</p>
      ) : (
        <ul class="runs">
          {rows.slice(0, 10).map((row) => (
            <li class={`run ${row.status}`}>
              <span class="run-when" title={row.startedAt}>
                {relativeTime(row.startedAt)}
              </span>
              <span class="run-topic">{row.topicName}</span>
              <span class="run-meta">
                {row.status === 'running'
                  ? 'running…'
                  : row.status === 'failed'
                    ? (row.error ?? 'failed')
                    : `${String(row.newItems)} new · ${formatDuration(row.durationMs)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      <label class="field checkbox-field">
        <input type="checkbox" data-action="diag-topics" checked={s.diagIncludeTopics ? true : undefined} />
        <span>Include topic names when copying</span>
      </label>
      <p class="note">
        <button class="btn subtle" type="button" data-action="copy-diagnostics">
          Copy diagnostics
        </button>{' '}
        Puts versions, settings and the recent check outcomes on the clipboard for a bug report. Topic names are
        left out unless you tick the box; error text is copied verbatim and may still mention one.
      </p>
    </div>
  );
}

/**
 * Privacy, as its own dialog reached from the footer (NEWS-121).
 *
 * It was a section at the bottom of Settings, which is the wrong place twice
 * over: it isn't a setting — nothing on it can be changed — and burying "what
 * leaves this machine" under six screens of configuration is the opposite of
 * how a privacy note earns trust. A footer link is where people look for one.
 */
function privacyDialogJsx(s: AppState): SafeHtml {
  return (
    <div class="dialog-backdrop" data-action="privacy-backdrop">
      <div class="dialog privacy-dialog" role="dialog" aria-modal="true" aria-labelledby="privacy-title">
        <div class="dialog-head">
          <h2 id="privacy-title">Privacy</h2>
          <button class="btn icon" type="button" data-action="close-privacy" aria-label="Close privacy">
            {icon('clear', 17)}
          </button>
        </div>
        {privacyNoteJsx(s)}
      </div>
    </div>
  );
}

function privacyNoteJsx(s: AppState): SafeHtml {
  const provider = PROVIDER_INFO[s.settings.provider].label;
  return (
    <div class="privacy">
      <p class="note">
        <strong>Sent on every check</strong>, to {s.settings.provider === 'auto' ? 'whichever provider is active' : provider}:
        the topic’s name, its guidance if you wrote any, the titles of stories already reported for it (that is
        how repeats are avoided), and the titles of stories you flagged off-topic (that is how it learns what
        you meant). Nothing else — not the feed, not your other topics, not anything you bookmarked.
      </p>
      <p class="note">
        <strong>Stored on this machine only</strong>, in ~/.news: your topics, the stories found, and cached
        article images. <strong>API keys are not stored there</strong> — they live in your {s.keychainLabel}.
      </p>
      <p class="note">
        <strong>News has no servers and collects no telemetry.</strong> The only outbound traffic is the check
        itself, fetching article images, and opening links you click.
      </p>
    </div>
  );
}

/**
 * Settings tabs (NEWS-118).
 *
 * The dialog had grown to roughly two screens of unrelated controls in one
 * column — scheduling next to API keys next to export links — so nothing was
 * findable except by scrolling past everything else. Four groups, each of which
 * answers a different question:
 *
 * | Tab | Answers |
 * |---|---|
 * | Schedule | *when* does it check |
 * | Source | *who* does it ask |
 * | Data | *what* is kept, and how do I get it out |
 * | App | everything about the app itself |
 *
 * Lucide icons, from the same set as the rest of the UI (`icons.tsx`) — a label
 * alone made the strip read as prose rather than as controls.
 */
const SETTINGS_TABS = [
  { id: 'schedule', label: 'Schedule', icon: 'clock' },
  { id: 'source', label: 'Source', icon: 'bot' },
  { id: 'data', label: 'Data', icon: 'database' },
  { id: 'app', label: 'App', icon: 'bell' },
] as const;

type SettingsTab = (typeof SETTINGS_TABS)[number]['id'];

function settingsTabsJsx(active: SettingsTab): SafeHtml {
  return (
    <div class="settings-tabs" role="tablist" aria-label="Settings sections">
      {SETTINGS_TABS.map((tab) => (
        <button
          class={`settings-tab${tab.id === active ? ' active' : ''}`}
          type="button"
          role="tab"
          id={`settings-tab-${tab.id}`}
          aria-selected={tab.id === active ? 'true' : 'false'}
          aria-controls="settings-panel"
          // Only the selected tab is in the tab order; the rest are reached with
          // the arrow keys, which is the WAI-ARIA tabs pattern.
          tabindex={tab.id === active ? '0' : '-1'}
          data-settings-tab={tab.id}
        >
          {icon(tab.icon, 14)}
          <span>{tab.label}</span>
        </button>
      ))}
    </div>
  );
}

function settingsPanelJsx(s: AppState): SafeHtml {
  const provider = s.settings.provider;
  const info = PROVIDER_INFO[provider];
  switch (s.settingsTab) {
    case 'schedule':
      return (
        <div>
        <label class="field">
          <span class="field-label">Schedule</span>
          <select data-action="schedule-mode">
            <option value="interval" selected={s.settings.scheduleMode === 'interval' ? true : undefined}>
              Every so often
            </option>
            <option value="daily" selected={s.settings.scheduleMode === 'daily' ? true : undefined}>
              At set times of day
            </option>
          </select>
        </label>

        {/* Always-present container: swapping the two controls must not
            restructure the fields around them (kerf KF-377). */}
        <div id="schedule-slot">
          {s.settings.scheduleMode === 'daily' ? (
            <div>
              <label class="field">
                <span class="field-label">Check at</span>
                <input type="text" data-action="daily-times" value={s.settings.dailyTimes.join(', ')} placeholder="08:00, 18:00" />
              </label>
              <p class="note">
                Local times, 24-hour, comma separated. A slot missed while News was closed is served when it
                next opens rather than skipped — so a morning briefing is still there at lunchtime.
              </p>
            </div>
          ) : (
            <label class="field">
              <span class="field-label">Check every</span>
              <select data-action="interval">
                {INTERVAL_OPTIONS.map((opt) => (
                  <option value={String(opt.ms)} selected={opt.ms === s.settings.checkIntervalMs ? true : undefined}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <label class="field">
          <span class="field-label">
            {/* Just "High-priority" (NEWS-117): the row sits directly under
                "Check every", so "topics every" was restating the column it is in —
                and it wrapped to a second line to do it. */}
            {icon('star', 13)} High-priority
          </span>
          <select data-action="hp-interval">
            {INTERVAL_OPTIONS.map((opt) => (
              <option value={String(opt.ms)} selected={opt.ms === s.settings.highPriorityIntervalMs ? true : undefined}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <p class="field-hint">
          Kept at or below the default interval — changing either adjusts the other to keep that true.
        </p>
        <label class="field">
          <span class="field-label">Check at once</span>
          <select data-action="concurrency">
            {[1, 2, 3, 4, 6, 8].map((n) => (
              <option value={String(n)} selected={n === s.settings.checkConcurrency ? true : undefined}>
                {n === 1 ? 'One topic at a time' : `${String(n)} topics`}
              </option>
            ))}
          </select>
        </label>
        <p class="note">
          A real check takes minutes, so a sweep over many topics runs for a long time one at a time. Raising
          this finishes sooner — up to a point: too high and the provider starts refusing requests instead.
        </p>
        </div>
      );
    case 'source':
      return (
        <div>
        <label class="field">
          <span class="field-label">Provider</span>
          <select data-action="provider" title="Which AI finds and summarizes news">
            {PROVIDER_NAMES.map((name) => (
              <option value={name} selected={name === provider ? true : undefined}>
                {PROVIDER_INFO[name].label}
              </option>
            ))}
          </select>
        </label>

        {sourceStatusJsx()}

        {/* Always-present slot: the note appears only for subscription-backed
            providers (kerf KF-377 — see docs/3-ui.md). */}
        <div class="source-note">
          {providerIsAttended(s.settings.provider) ? (
            <p class="note">
              Checks use your subscription, not an API key. Scheduled checks run only while News is open; “Check now”
              always works.
            </p>
          ) : (
            ''
          )}
        </div>

        {/* Always-present container: conditional fields must not appear and
            disappear as siblings (kerf KF-377 — see docs/3-ui.md). */}
        <div class="source-fields">
          {provider !== 'auto' && provider !== 'mock' ? (
            <label class="field">
              <span class="field-label">Model</span>
              <input
                type="text"
                class="source-field"
                name="model"
                value={s.settings.model}
                placeholder="default"
                autocomplete="off"
                list="model-suggestions"
                data-action="model"
                data-morph-skip-children
              />
              {/* Suggestions only — the field stays free-text for custom
                  gateways and models newer than this list (NEWS-37). */}
              <datalist id="model-suggestions">
                {PROVIDER_MODELS[provider].map((m) => (
                  <option value={m} data-key={m} />
                ))}
              </datalist>
            </label>
          ) : (
            ''
          )}
          {info.endpointConfigurable ? (
            <label class="field">
              <span class="field-label">Endpoint</span>
              <input
                type="text"
                class="source-field"
                name="endpoint"
                value={s.settings.endpoint}
                placeholder="default"
                autocomplete="off"
                data-action="endpoint"
                data-morph-skip-children
              />
            </label>
          ) : (
            ''
          )}
        </div>
        <h3 class="eyebrow">API keys</h3>
        <div class="keys">{s.keys.map((k) => keyRowJsx(k, s.keychainLabel, s.keychainAvailable))}</div>

        <div class="key-notes">
          {s.keyError !== null ? <p class="banner error">{s.keyError}</p> : ''}
          {s.keysLoaded && !s.keychainAvailable ? (
            <p class="note warn">
              No {s.keychainLabel} is available here, so keys can't be saved from the app. Set the environment
              variables above instead.
            </p>
          ) : (
            ''
          )}
        </div>
        <p class="note">
          Keys are stored in your {s.keychainLabel} — never in ~/.news/news.db, and never sent anywhere but the
          provider you chose.
        </p>
        </div>
      );
    case 'data':
      return (
        <div>
        <label class="field">
          <span>Keep stories for</span>
          <select data-action="retention">
            {RETENTION_OPTIONS.map((o) => (
              <option value={String(o.days)} selected={o.days === s.settings.itemRetentionDays ? true : undefined}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <p class="note">
          Older stories are dropped so the data file doesn’t grow without bound. Bookmarked stories are always
          kept, and so are ones you flagged off-topic — those still teach each topic what you meant.
        </p>
        <div class="export-row">
          <a class="btn" href="/api/export.md?scope=all" download="">
            All stories (.md)
          </a>
          <a class="btn" href="/api/export.json?scope=all" download="">
            All stories (.json)
          </a>
          <a class="btn" href="/api/export.md?scope=saved" download="">
            Saved only (.md)
          </a>
        </div>
        <p class="note">
          Nothing here is trapped in the app. Markdown is for pasting into notes; JSON is the escape hatch.
        </p>
        <p class="note">
          Subscribe in any feed reader: <code>{`${location.origin}/feed.xml`}</code> (add{' '}
          <code>?scope=saved</code> for bookmarks only). It works from this machine — the app listens on
          localhost, so a reader on another device can’t reach it.
        </p>

        </div>
      );
    case 'app':
      return (
        <div>
        <label class="field checkbox-field">
          <input
            type="checkbox"
            data-action="notify-toggle"
            checked={s.settings.notifyOnNewItems ? true : undefined}
          />
          <span>Notify me when new stories arrive while News isn’t focused</span>
        </label>
        {/* Always-present slot for the permission note (KF-377). */}
        <div class="notify-note">
          {s.notifyPermissionDenied ? (
            <p class="note warn">
              Notifications are blocked for this app in your browser or system settings. Enable them there to turn
              this on.
            </p>
          ) : (
            ''
          )}
        </div>
        <p class="note">
          <button class="btn subtle" type="button" data-action="rerun-onboarding">
            Show the setup guide again
          </button>
        </p>
        {/* Collapsed by default (NEWS-120): a bug-report bundle is an advanced,
            rarely-used tool, and an always-open run log is the loudest thing on
            a settings screen while being the least often wanted. Inside the App
            tab *and* collapsed, so it takes two deliberate steps — but it stays
            nameable in support ("open Settings → App and expand Diagnostics")
            rather than hidden behind a gesture nobody can be talked through. */}
        <details class="advanced">
          <summary>
            {icon('bug', 13)}
            <span>Diagnostics</span>
          </summary>
          {diagnosticsJsx(s)}
        </details>
        </div>
      );
  }
}

function settingsDialogJsx(): SafeHtml {
  const s = appStore.state.value;

  return (
    <div class="dialog-backdrop" data-action="settings-backdrop">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div class="dialog-head">
          <h2 id="settings-title">Settings</h2>
          <button class="btn icon" type="button" data-action="close-settings" aria-label="Close settings">
            {icon('clear', 17)}
          </button>
        </div>

        {settingsTabsJsx(s.settingsTab)}
        <div class="settings-panel" id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${s.settingsTab}`}>
          {settingsPanelJsx(s)}
        </div>
      </div>
    </div>
  );
}

/**
 * Right-click menu for the topic rows.
 *
 * Acts on `topicIds`, which is the whole selection when the click landed on a
 * selected row and just that row otherwise — the behaviour every OS file
 * manager has, and the reason bulk actions need no separate affordance.
 */
function contextMenuJsx(menu: NonNullable<AppState['contextMenu']>, topics: Topic[]): SafeHtml {
  const targets = topics.filter((t) => menu.topicIds.includes(t.id));
  const count = targets.length;
  const suffix = count > 1 ? ` ${String(count)} topics` : '';
  // With a mixed selection, offer the action that changes the most rows.
  const anyActive = targets.some((t) => !t.paused);
  const anyNormal = targets.some((t) => !t.highPriority);
  const allSoloed = isAllSoloed(appStore.state.value.soloTopicIds, targets.map((t) => t.id));
  // Guidance is a paragraph about *one* topic, so it's offered only when
  // exactly one is targeted — there is nothing sensible to write across a mix.
  const only = count === 1 ? targets[0] : undefined;
  // Flagged-story count across the targeted topics, for "Review Flagged"
  // (NEWS-61) — from the server aggregate now that the feed is paginated (NEWS-76).
  const flaggedByTopic = appStore.state.value.flaggedByTopic;
  const flaggedCount = menu.topicIds.reduce((sum, id) => sum + (flaggedByTopic[id] ?? 0), 0);

  return (
    <div class="menu-backdrop" data-action="close-menu">
      <div class="menu" role="menu" style={`left:${String(menu.x)}px;top:${String(menu.y)}px`}>
        <button class="menu-item" role="menuitem" type="button" data-menu-action="check">
          {icon('check')}
          <span>Check now{suffix}</span>
        </button>
        <button class="menu-item" role="menuitem" type="button" data-menu-action="pause">
          {icon(anyActive ? 'pause' : 'play')}
          <span>
            {anyActive ? 'Pause' : 'Resume'}
            {suffix}
          </span>
        </button>
        <button class="menu-item" role="menuitem" type="button" data-menu-action="priority">
          {icon('star')}
          <span>
            {anyNormal ? 'High priority' : 'Normal priority'}
            {suffix}
          </span>
        </button>
        <button
          class="menu-item"
          role="menuitem"
          type="button"
          data-menu-action="guidance"
          disabled={only === undefined ? true : undefined}
        >
          {icon('guidance')}
          <span>{only !== undefined && only.guidance !== '' ? 'Edit guidance' : 'Add guidance'}</span>
        </button>
        <div class="menu-sep" role="separator" />
        <button class="menu-item" role="menuitem" type="button" data-menu-action="solo">
          {icon('solo')}
          <span>{allSoloed ? 'Unsolo' : 'Solo'}{suffix}</span>
        </button>
        <button
          class="menu-item"
          role="menuitem"
          type="button"
          data-menu-action="review-flagged"
          disabled={flaggedCount === 0 ? true : undefined}
        >
          {icon('flag')}
          <span>Review Flagged News Items</span>
          {flaggedCount > 0 ? <span class="count-badge">{String(flaggedCount)}</span> : ''}
        </button>
        <div class="menu-sep" role="separator" />
        <button class="menu-item danger" role="menuitem" type="button" data-menu-action="delete">
          {icon('delete')}
          <span>Delete{suffix}</span>
        </button>
      </div>
    </div>
  );
}

/** Right-click menu for a story card: bookmark, share, and the off-topic flag. */
function itemMenuJsx(menu: NonNullable<AppState['itemMenu']>, items: NewsItem[]): SafeHtml {
  const item = items.find((i) => i.id === menu.itemId);
  if (item === undefined) return <div id="item-menu-empty" />;
  // A flagged story only offers Unflag — bookmarking or sharing something you've
  // marked as noise makes no sense (NEWS-70).
  return (
    <div class="menu-backdrop" data-action="close-item-menu">
      <div class="menu" role="menu" style={`left:${String(menu.x)}px;top:${String(menu.y)}px`}>
        {item.offTopic ? (
          ''
        ) : (
          <button class="menu-item" role="menuitem" type="button" data-item-menu-action="bookmark">
            {icon('bookmark')}
            <span>{item.saved ? 'Remove bookmark' : 'Bookmark'}</span>
          </button>
        )}
        {item.offTopic ? (
          ''
        ) : (
          <button class="menu-item" role="menuitem" type="button" data-item-menu-action="share">
            {icon('share')}
            <span>Share</span>
          </button>
        )}
        {item.offTopic ? '' : <div class="menu-sep" role="separator" />}
        <button class="menu-item" role="menuitem" type="button" data-item-menu-action="flag">
          {icon('flag')}
          <span>{item.offTopic ? 'Unflag off topic' : 'Flag: Off topic'}</span>
        </button>
      </div>
    </div>
  );
}

function appJsx(): SafeHtml {
  const s = appStore.state.value;
  const topicNames = new Map(s.topics.map((t) => [t.id, t.name]));
  const solo = new Set(s.soloTopicIds);
  const selected = new Set(s.selectedTopicIds);
  // The feed page is filtered + sorted + paginated by the server for the active
  // view (NEWS-76). Review mode shows ONLY the flagged stories for its topics.
  const reviewMode = s.reviewTopicIds.length > 0;
  const searching = s.searchQuery.trim() !== '';
  const feedVariant: 'normal' | 'review' = reviewMode ? 'review' : 'normal';
  // In the normal view the server excludes off-topic stories, so merge in any
  // flagged *this session* — collapsed, and only if they match the active
  // Solo/Saved/Search — so a misclick stays undoable until reload (NEWS-61).
  let feedItems = s.feedItems;
  if (!reviewMode && s.recentlyFlaggedItems.length > 0) {
    const seen = new Set(s.feedItems.map((i) => i.id));
    const overlay = s.recentlyFlaggedItems.filter(
      (it) =>
        !seen.has(it.id) &&
        (solo.size === 0 || solo.has(it.topicId)) &&
        (!s.savedFilter || it.saved) &&
        itemMatchesQuery(it, topicNames.get(it.topicId) ?? '', s.searchQuery),
    );
    if (overlay.length > 0) {
      feedItems = [...s.feedItems, ...overlay].sort((a, b) => b.foundAt.localeCompare(a.foundAt));
    }
  }
  // "Show more" reflects what the *server* still holds for this view (the
  // session overlay is separate and always shown).
  const moreCount = Math.max(0, s.feedTotal - s.feedItems.length);
  const savedCount = s.feedTotal; // meaningful only while the Saved filter is on
  // Resolved from server state, so a topic deleted while its dialog is open
  // simply closes it rather than rendering a stale name.
  const guidanceTarget = s.topics.find((t) => t.id === s.guidanceTopicId);
  const anyChecking = s.checking.length > 0;
  // Only warn about a topic whose *latest* run failed — not a stale failure from
  // one that has since recovered (NEWS-41).
  const lastFailure = currentFailure(s.runs);
  // Topics whose real cadence has fallen well behind the interval the user set
  // (NEWS-59). Informational only — the scheduler already cycles as fast as it
  // can; this just explains why freshness may lag.
  const behind = activeBehindWarnings(s.topics, s.settings, Date.now(), s.behindGraceUntil);

  return (
    <div class={`shell${s.sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <header class="app-header">
        <div class="header-left">
          <button
            class="btn icon"
            data-action="toggle-sidebar"
            aria-expanded={s.sidebarCollapsed ? 'false' : 'true'}
            aria-controls="topics-panel"
            aria-label={s.sidebarCollapsed ? 'Show topics' : 'Hide topics'}
            title={s.sidebarCollapsed ? 'Show topics' : 'Hide topics'}
          >
            {icon('panel', 17)}
          </button>
          <h1 class="wordmark">
            News<span class="mark-dot">.</span>
          </h1>
        </div>
        <div class="header-controls">
          {/* Small by design; grows on focus or when it has a query (NEWS-60).
              Clear button is always rendered and shown via CSS so the input's
              siblings never restructure (kerf morph safety). */}
          <div class={`search${searching ? ' has-query' : ''}`}>
            {icon('search', 16)}
            <input
              type="text"
              class="search-input"
              placeholder="Search stories"
              aria-label="Search stories"
              data-action="search"
            />
            <button class="search-clear" type="button" data-action="clear-search" aria-label="Clear search">
              {icon('clear', 14)}
            </button>
          </div>
          <button
            class={`btn icon${s.savedFilter ? ' active' : ''}`}
            data-action="toggle-saved-filter"
            aria-pressed={s.savedFilter ? 'true' : 'false'}
            aria-label={s.savedFilter ? 'Show all stories' : 'Show saved stories'}
            title={s.savedFilter ? 'Showing saved — click to show all' : 'Show saved only'}
          >
            {icon('bookmark', 17)}
          </button>
          <button class="btn icon" data-action="open-settings" aria-label="Settings" title="Settings">
            {icon('settings', 17)}
          </button>
          <button
            class="btn primary"
            data-action="check-all"
            disabled={anyChecking ? true : undefined}
            aria-live="polite"
          >
            {anyChecking ? 'Checking…' : 'Check all now'}
          </button>
        </div>
      </header>

      {/* Always-present container — the dialog appearing must not restructure
          its siblings (kerf KF-377 — see docs/3-ui.md). */}
      <div id="onboarding-slot">{s.onboarding !== null && s.onboarding !== 'auto' ? onboardingJsx(s.onboarding) : ''}</div>
      <div id="settings-slot">{s.settingsOpen ? settingsDialogJsx() : ''}</div>
      <div id="menu-slot">{s.contextMenu !== null ? contextMenuJsx(s.contextMenu, s.topics) : ''}</div>
      <div id="item-menu-slot">{s.itemMenu !== null ? itemMenuJsx(s.itemMenu, feedAndFlagged()) : ''}</div>
      <div id="confirm-slot">{s.confirm !== null ? confirmDialogJsx(s.confirm) : ''}</div>
      <div id="guidance-slot">{guidanceTarget !== undefined ? guidanceDialogJsx(guidanceTarget) : ''}</div>
      <div id="privacy-slot">{s.privacyOpen ? privacyDialogJsx(s) : ''}</div>
      <div id="discover-slot">{s.discover !== null ? discoverDialogJsx(s.discover) : ''}</div>
      {/* Always present because it is a **live region**: assistive technology
          announces mutations to a region it is already observing, so a slot
          created in the same render as its own text has nothing watching it and
          the announcement is lost. (It also predates kerf 3.0.0, where it
          doubled as a KF-377 workaround — that reason is gone; this one isn't.
          See docs/3-ui.md, NEWS-99.) */}
      <div id="toast-slot" aria-live="polite">
        {s.toast !== null ? <div class="toast">{s.toast}</div> : ''}
      </div>

      {/* Section navigation sits directly under the masthead, as a newspaper's
          does — above the banners and above the sidebar+feed area (FR-22.10). */}
      <div id="filter-slot">{filterBarJsx(s.categoryFilter, s.topics)}</div>

      {/* Banners appear in response to background events (a failed check, a
          a failing topic), so they have to announce rather than wait to be found —
          which is why the container is always present. A live region has to
          exist *before* its content for the announcement to happen at all.
          (Also a KF-377 workaround once; that reason expired in kerf 3.0.0 and
          this one did not. See docs/3-ui.md, NEWS-99.) */}
      <div id="banners" role="status" aria-live="polite">
        {s.savedFilter ? (
          <div class="banner saved">
            {icon('bookmark', 14)}
            <span class="banner-text">
              Showing {String(savedCount)} saved {savedCount === 1 ? 'story' : 'stories'}
            </span>
            <button class="btn subtle" type="button" data-action="clear-saved-filter">
              Show all
            </button>
          </div>
        ) : (
          ''
        )}
        {solo.size > 0 ? (
          <div class="banner solo">
            {icon('solo', 14)}
            <span>
              Showing {String(solo.size)} of {String(s.topics.length)} topics
            </span>
            <button class="btn subtle" type="button" data-action="clear-solo">
              Show all
            </button>
          </div>
        ) : (
          ''
        )}
        {s.error !== null ? (
          <div class="banner error">
            <span class="banner-text">{s.error}</span>
            <button class="banner-dismiss" type="button" data-action="dismiss-error" aria-label="Dismiss">
              {icon('clear', 15)}
            </button>
          </div>
        ) : (
          ''
        )}
        {lastFailure !== null && s.error === null && lastFailure.id !== s.dismissedRunId ? (
          <div class="banner warn">
            <span class="banner-text">
              Last check for “{topicNames.get(lastFailure.topicId) ?? 'deleted topic'}” failed:{' '}
              {lastFailure.error ?? 'unknown error'}
            </span>
            <button
              class="banner-dismiss"
              type="button"
              data-action="dismiss-warn"
              data-run-id={lastFailure.id}
              aria-label="Dismiss"
            >
              {icon('clear', 15)}
            </button>
          </div>
        ) : (
          ''
        )}
        {behind.length > 0 && !s.dismissedBehind ? (
          <div class="banner warn">
            <span class="banner-text">
              Checks are falling behind your schedule — {String(behind.length)}{' '}
              {behind.length === 1 ? 'topic is' : 'topics are'} refreshing slower than the interval you picked. Try
              fewer topics, a longer interval, or a faster provider.
            </span>
            <button class="banner-dismiss" type="button" data-action="dismiss-behind" aria-label="Dismiss">
              {icon('clear', 15)}
            </button>
          </div>
        ) : (
          ''
        )}
        {reviewMode ? (
          <div class="banner review">
            {icon('flag', 14)}
            <span class="banner-text">
              Reviewing {String(s.feedTotal)} flagged {s.feedTotal === 1 ? 'story' : 'stories'}
              {s.reviewTopicIds.length === 1
                ? ` for ${topicNames.get(s.reviewTopicIds[0] ?? '') ?? 'a topic'}`
                : ''}
            </span>
            <button class="btn subtle" type="button" data-action="exit-review">
              Exit review
            </button>
          </div>
        ) : (
          ''
        )}
      </div>

      {/* Always rendered, hidden via CSS when collapsed. The header's toggle
          carries aria-controls="topics-panel", so unmounting this would leave
          that attribute pointing at nothing — verified: doing so fails
          a11y.spec.ts on an axe `aria-valid-attr-value` violation. Collapsing
          also sets aria-hidden here, which a removed element cannot express.
          (Originally the KF-377 workaround too; see docs/3-ui.md, NEWS-99.) */}
      <section id="topics-panel" class="topics-panel" aria-hidden={s.sidebarCollapsed ? 'true' : undefined}>
        <div class="topics-head">
          <h2 class="eyebrow">Watching</h2>
          {s.topics.length > 1 ? (
            <select class="sort-select" data-action="topic-sort" aria-label="Sort topics">
              {TOPIC_SORTS.map((opt) => (
                <option value={opt} selected={opt === s.topicSort ? true : undefined}>
                  {TOPIC_SORT_LABELS[opt]}
                </option>
              ))}
            </select>
          ) : (
            ''
          )}
        </div>
        {/* A multi-select listbox: rows are the options, so a screen reader
            announces selection state and roving focus works (NEWS-90). */}
        <ul class="topics" role="listbox" aria-multiselectable="true" aria-label="Topics">
          {each(
            sortTopics(s.topics, s.topicSort),
            (topic) =>
              topicRowJsx(
                topic,
                s.checking.includes(topic.id),
                topic.highPriority ? s.settings.highPriorityIntervalMs : s.settings.checkIntervalMs,
                selected.has(topic.id),
                solo.has(topic.id),
                solo.size > 0 && !solo.has(topic.id),
              ),
            {
              // `each()` memoizes per row on object identity, and selection/solo
              // live outside the topic object — so without this comparator a row
              // keeps its cached HTML and selecting it appears to do nothing until
              // the next poll happens to replace `topics` with fresh objects.
              // `highPriority` is in the key too so toggling it re-renders the
              // star and the dial's interval without waiting for the next poll.
              cacheKey: (topic: Topic) =>
                // The category is part of the row now, so it belongs in the memo
              // key — a topic classified by a background check would otherwise
              // keep its stale row until something else changed.
              `${String(topic.category)}|${String(topic.subcategory)}|${String(selected.has(topic.id))}|${String(solo.has(topic.id))}|${String(solo.size)}|${String(
                  s.checking.includes(topic.id),
                )}|${String(topic.highPriority)}`,
              // A stable list identity (kerf 3.x). Unkeyed lists are identified by
              // their position among a render's `each()` calls, so a conditional
              // list appearing above this one would rebuild it and cost the rows
              // their focus and scroll. This is the only `each()` in the app today
              // — the feed uses `.map()` — so the position can't currently shift;
              // the key means adding a second list later can't silently break this
              // one either.
              key: 'topics',
            },
          )}
        </ul>
        <div class="empty-slot">
          {s.loaded && s.topics.length === 0 ? (
            <p class="empty">Nothing is being watched yet. Add a topic below — News checks it on your schedule and reports only what's new.</p>
          ) : (
            ''
          )}
        </div>
        <form class="add-topic" data-action="add-topic-form">
          <input
            type="text"
            name="topic-name"
            placeholder="Watch a topic — “solid-state batteries”"
            autocomplete="off"
            data-morph-skip-children
          />
          <button class="btn" type="submit">
            Add
          </button>
          <button
            class="icon-btn discover-open"
            type="button"
            data-action="open-discover"
            aria-label="Discover topics"
            title="Discover topics"
          >
            {icon('compass')}
          </button>
        </form>
      </section>

      <section id="feed" class="feed">
        {feedJsx(feedItems, topicNames, feedVariant)}
        <div class="empty-slot">
          {s.loaded && feedItems.length === 0 && reviewMode ? (
            <p class="empty">No flagged stories for these topics.</p>
          ) : s.loaded && feedItems.length === 0 && searching ? (
            <p class="empty">No stories match your search.</p>
          ) : s.loaded && feedItems.length === 0 && s.savedFilter ? (
            <p class="empty">No saved stories yet. Use the bookmark button on a story to keep it here.</p>
          ) : s.loaded && feedItems.length === 0 && s.topics.length > 0 ? (
            <p class="empty">No stories yet. Check now, or let the next scheduled check run — only genuinely new news lands here.</p>
          ) : (
            ''
          )}
        </div>
        {/* Always-present slot so the button appearing can't shift a keyed list
            above it (kerf KF-377). */}
        <div class="show-more-slot">
          {moreCount > 0 ? (
            <button class="btn show-more" type="button" data-action="show-more">
              Show {String(Math.min(moreCount, FEED_PAGE))} more
              {moreCount > FEED_PAGE ? ` (${String(moreCount)} left)` : ''}
            </button>
          ) : (
            ''
          )}
        </div>
      </section>

      {/* Site footer (NEWS-121). Where a privacy note belongs: findable without
          hunting, and not filed under "settings" — nothing on it is settable. */}
      <footer class="app-footer">
        <button class="btn link" type="button" data-action="open-privacy">
          {icon('shield', 13)}
          <span>Privacy</span>
        </button>
      </footer>
    </div>
  );
}


/** Anchor for shift-range selection — the last row clicked without shift. */
let anchorId: string | null = null;

function selectTopic(id: string, mods: { toggle: boolean; range: boolean }): void {
  const { topics, selectedTopicIds, topicSort } = appStore.state.value;
  if (mods.range && anchorId !== null) {
    // Range is over the *displayed* order, which the sort determines (NEWS-63).
    const ids = sortTopics(topics, topicSort).map((t) => t.id);
    const from = ids.indexOf(anchorId);
    const to = ids.indexOf(id);
    if (from !== -1 && to !== -1) {
      const [lo, hi] = from < to ? [from, to] : [to, from];
      appStore.actions.setSelection(ids.slice(lo, hi + 1));
      return;
    }
  }
  if (mods.toggle) {
    const next = selectedTopicIds.includes(id)
      ? selectedTopicIds.filter((x) => x !== id)
      : [...selectedTopicIds, id];
    appStore.actions.setSelection(next);
    anchorId = id;
    return;
  }
  appStore.actions.setSelection([id]);
  anchorId = id;
}

/** Prompt for and delete `ids`, naming what's about to go. */
function confirmDelete(ids: string[]): void {
  const { topics } = appStore.state.value;
  const names = topics.filter((t) => ids.includes(t.id)).map((t) => t.name);
  if (names.length === 0) return;
  const what =
    names.length === 1 ? `\u201c${names[0] ?? ''}\u201d` : `${String(names.length)} topics`;
  void (async () => {
    if (!(await confirm(`Delete ${what} and all of their stories?`, { confirmLabel: 'Delete', danger: true }))) return;
    appStore.actions.setSelection([]);
    for (const id of ids) await deleteTopic(id);
  })();
}

/** Every story the client currently holds: the server feed page plus the
 *  just-flagged session overlay (NEWS-76) — the pool for id lookups. */
function feedAndFlagged(): NewsItem[] {
  const s = appStore.state.value;
  return [...s.feedItems, ...s.recentlyFlaggedItems];
}

/** Share one story, toasting only when it fell back to the clipboard/failed. */
async function shareOne(item: NewsItem): Promise<void> {
  const result = await shareItem(item);
  // The OS share sheet is its own feedback, and a cancelled share needs none.
  if (result === 'copied') showToast('Copied to clipboard');
  else if (result === 'failed') showToast("Couldn't share this story");
}

/** Flag/unflag a story off-topic (NEWS-61). Flagging holds the item this session
 *  (via `recentlyFlaggedItems`) so it stays visible-but-collapsed after the
 *  server drops it from the normal page; unflagging releases it (NEWS-76). */
function flagItem(item: NewsItem, offTopic: boolean): void {
  if (offTopic) appStore.actions.addRecentlyFlagged(item);
  else appStore.actions.removeRecentlyFlagged(item.id);
  void setItemOffTopic(item.id, offTopic).then(refreshFeed);
}

/**
 * Open the topic menu anchored to a row rather than to a pointer (NEWS-90).
 *
 * The mouse path positions the menu at the cursor; a keyboard has no cursor, so
 * it is anchored to the row's own box. Shared with the mouse handler's
 * selection rules so the two can't drift apart.
 */
function openTopicMenuFor(id: string, row: Element): void {
  const current = appStore.state.value.selectedTopicIds;
  const topicIds = current.includes(id) ? current : [id];
  if (!current.includes(id)) appStore.actions.setSelection([id]);
  const box = row.getBoundingClientRect();
  appStore.actions.openContextMenu({ x: box.left + 24, y: box.bottom - 4, topicIds });
}

/** Dismiss the first-run flow and remember that it has been seen. */
function closeOnboarding(): void {
  appStore.actions.setOnboarding(null);
  writeOnboardingSeen();
}

/**
 * Open the first-run flow the first time the app is plainly unusable.
 *
 * Gated on *both* `/api/state` and `/api/providers` having answered: the
 * provider list starts empty, so acting before it loads would flash the wizard
 * at every existing user on every reload. Once dismissed it is remembered
 * per-device and only Settings reopens it.
 */
function maybeOpenOnboarding(): void {
  const s = appStore.state.value;
  if (s.onboarding !== 'auto') return;
  if (!s.loaded || s.providers.length === 0) return;
  const usable = s.providers.some((p) => p.name !== 'auto' && p.name !== 'mock' && p.available === true);
  appStore.actions.setOnboarding(s.topics.length === 0 && !usable && !readOnboardingSeen() ? 'welcome' : null);
}

/** Apply a context-menu action to every targeted topic. */
function runTopicAction(action: string, ids: string[]): void {
  const { topics, soloTopicIds } = appStore.state.value;
  const targets = topics.filter((t) => ids.includes(t.id));
  switch (action) {
    case 'check':
      for (const t of targets) void startCheck(t.id);
      break;
    case 'pause': {
      // Mixed selections resolve toward the action that changes the most rows,
      // matching the label the menu showed.
      const pause = targets.some((t) => !t.paused);
      for (const t of targets) {
        if (t.paused === pause) continue;
        void setTopicPaused(t.id, pause);
      }
      break;
    }
    case 'priority': {
      // Mixed selections resolve toward high-priority (the label the menu showed).
      const high = targets.some((t) => !t.highPriority);
      for (const t of targets) {
        if (t.highPriority === high) continue;
        void setTopicHighPriority(t.id, high);
      }
      break;
    }
    case 'solo':
      appStore.actions.setSolo(toggleSolo(soloTopicIds, targets.map((t) => t.id)));
      void refreshFeed();
      break;
    case 'guidance': {
      // Single-target only; the menu item is disabled for a multi-selection.
      const only = targets.length === 1 ? targets[0] : undefined;
      if (only !== undefined) appStore.actions.openGuidance(only.id);
      break;
    }
    case 'review-flagged':
      // Enter review mode for the targeted topics (the menu item is disabled
      // when none of them have flagged stories).
      appStore.actions.setReviewTopicIds(ids);
      void refreshFeed();
      break;
    case 'delete':
      confirmDelete(ids);
      break;
    default:
      break;
  }
}

/**
 * Run one discovery request and fold the answer into the pane (NEWS-126).
 *
 * The `discover === null` guards are the point of doing this in one place: the
 * user can close the dialog while a request is in flight, and a response that
 * reopened it — or wrote into a fresh session's state — is the kind of bug that
 * only shows up on a slow provider.
 */
async function runDiscovery(source: DiscoverSource): Promise<void> {
  appStore.actions.patchDiscover({ loading: true, error: null, view: 'results', source });
  try {
    const { suggestions, cached } = await discoverTopics(source);
    if (appStore.state.value.discover === null) return;
    appStore.actions.patchDiscover({ loading: false, suggestions, cached, view: 'results' });
  } catch (err) {
    if (appStore.state.value.discover === null) return;
    // Shown inside the dialog next to a retry, not in the global banner: the
    // user is mid-task here, and the message is about this request.
    appStore.actions.patchDiscover({
      loading: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Fetch one tuner round and install it (NEWS-127).
 *
 * Every round is a billable call, so the server-side bound (FR-24.9) is the
 * backstop; this stops asking on its own once `judgeCandidate` says exhausted.
 */
async function fetchTunerRound(tuner: TunerState, advance: boolean): Promise<void> {
  appStore.actions.patchDiscover({ tuner: { ...tuner, loading: true, error: null } });
  try {
    const { suggestions } = await discoverTopics({
      kind: 'tune',
      anchor: tuner.anchor,
      direction: tuner.direction,
      kept: tuner.kept.map((s) => s.name),
      skipped: tuner.skipped,
      round: advance ? tuner.round + 1 : tuner.round,
    });
    // The user can close the dialog or end the session while a round is in
    // flight; installing it then would resurrect a tuner they walked away from.
    if (appStore.state.value.discover?.tuner === null) return;
    appStore.actions.patchDiscover({
      tuner: advance ? nextRound(tuner, suggestions) : { ...tuner, queue: suggestions, index: 0, loading: false },
    });
  } catch (err) {
    if (appStore.state.value.discover?.tuner === null) return;
    appStore.actions.patchDiscover({
      tuner: { ...tuner, loading: false, error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * Fetch suggestions for the onboarding Topics step (NEWS-128).
 *
 * Errors render as a note beside the chips rather than in the global banner:
 * the static starters above are still perfectly usable, so a failure here should
 * read as "that didn't work" and not as "setup is broken".
 */
async function suggestOnboardingTopics(query: string): Promise<void> {
  appStore.actions.setOnboardingSuggestions({ loading: true, error: null });
  try {
    const { suggestions } = await discoverTopics({ kind: 'describe', query }, 8);
    appStore.actions.setOnboardingSuggestions({ suggestions, loading: false });
  } catch (err) {
    appStore.actions.setOnboardingSuggestions({
      loading: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Enter the tuner, scoped to a card or to the whole result set (FR-24.5). */
async function enterTuner(anchor: string, direction: 'narrower' | 'similar'): Promise<void> {
  const tuner = startTuner(anchor, direction);
  appStore.actions.patchDiscover({ tuner });
  await fetchTunerRound(tuner, false);
}

/** Record a verdict and do whatever the state machine says comes next. */
async function judgeTunerCandidate(verdict: 'keep' | 'skip'): Promise<void> {
  const tuner = appStore.state.value.discover?.tuner;
  if (tuner === undefined || tuner === null || tuner.loading) return;
  const { tuner: updated, next } = judgeCandidate(tuner, verdict);
  appStore.actions.patchDiscover({ tuner: updated });
  if (next === 'fetch-round') await fetchTunerRound(updated, true);
}

/**
 * End the session and return to the list (FR-24.7).
 *
 * Kept suggestions are merged into the list, **not** created — nothing in
 * discovery creates a topic without an explicit Add, inside the tuner or out.
 */
function finishTuner(): void {
  const current = appStore.state.value.discover;
  if (current?.tuner == null) return;
  appStore.actions.patchDiscover({
    tuner: null,
    view: 'results',
    suggestions: mergeKept(current.suggestions, current.tuner.kept),
  });
}

/** Create a topic from a suggestion, keeping its card in place (FR-24.12/24.13). */
async function addSuggestion(name: string): Promise<void> {
  const current = appStore.state.value.discover;
  const suggestion = current?.suggestions.find((s) => s.name === name);
  if (current === null || suggestion === undefined) return;
  if (current.added.includes(name)) return;
  try {
    await addSuggestedTopic(suggestion);
    if (appStore.state.value.discover === null) return;
    appStore.actions.patchDiscover({ added: [...appStore.state.value.discover.added, name] });
    appStore.actions.setToast(`Added “${name}” — checking now`);
  } catch (err) {
    if (appStore.state.value.discover === null) return;
    appStore.actions.patchDiscover({ error: err instanceof Error ? err.message : String(err) });
  }
}

function wireEvents(root: HTMLElement): void {
  void delegate(root, 'submit', '[data-action=add-topic-form]', (e, form) => {
    e.preventDefault();
    const input = form.querySelector<HTMLInputElement>('input[name=topic-name]');
    if (!input) return;
    const name = input.value.trim();
    if (name === '') return;
    input.value = '';
    void addTopic(name);
  });

  // --- Topic discovery (NEWS-126) -----------------------------------------

  void delegate(root, 'click', '[data-action=open-discover]', () => {
    appStore.actions.openDiscover();
  });

  void delegate(root, 'click', '[data-action=close-discover]', () => {
    appStore.actions.closeDiscover();
  });

  void delegate(root, 'click', '[data-action=discover-backdrop]', (e, el) => {
    // Only a click on the backdrop itself, never one that bubbled out of the
    // dialog — the same rule the settings dialog needed (see keys.spec.ts).
    if (e.target === el) appStore.actions.closeDiscover();
  });

  void delegate(root, 'submit', '[data-action=discover-search]', (e, form) => {
    e.preventDefault();
    const input = form.querySelector<HTMLInputElement>('input[name=discover-query]');
    // An empty query is a real request — "surprise me" (FR-24.3) — so this
    // deliberately does not bail out on a blank field the way add-topic does.
    void runDiscovery({ kind: 'describe', query: input?.value.trim() ?? '' });
  });

  /**
   * One delegate for both browse steps, on one attribute — deliberately not two.
   *
   * The section tiles and the subcategory chips are both `<button>`s in the same
   * position of the same container, so the morph **reuses the node** and merely
   * rewrites its attributes when the pane switches. Two delegates keyed on two
   * different attributes then both match the *same* click: the first handler
   * re-renders synchronously, the tile becomes a chip, and the second handler —
   * still walking up from that very node — sees the chip's attribute and fires
   * too. One physical click ran two different actions, jumping the user from
   * "Sports" straight into results for whichever subcategory landed under the
   * cursor. Caught by the E2E suite; see `docs/3-ui.md`.
   */
  void delegate(root, 'click', '[data-discover-nav]', (_e, el) => {
    const value = el.getAttribute('data-discover-nav');
    if (value === null) return;
    if (value.startsWith('section:')) {
      appStore.actions.patchDiscover({ section: value.slice('section:'.length), view: 'browse' });
      return;
    }
    if (!value.startsWith('sub:')) return;
    // "sub:category/subcategory", with an empty tail meaning the whole section.
    const [category, sub] = value.slice('sub:'.length).split('/');
    void runDiscovery({ kind: 'section', category, subcategory: sub === '' ? null : sub });
  });

  void delegate(root, 'click', '[data-action=discover-back]', () => {
    const current = appStore.state.value.discover;
    if (current === null) return;
    // From results, step back to wherever they came from; from a section's
    // subcategories, back to the grid.
    if (current.view === 'results' && current.source?.kind === 'section') {
      appStore.actions.patchDiscover({ view: 'browse', section: current.source.category, error: null });
      return;
    }
    appStore.actions.patchDiscover({ view: 'browse', section: null, error: null });
  });

  void delegate(root, 'click', '[data-action=discover-retry]', () => {
    const source = appStore.state.value.discover?.source;
    if (source) void runDiscovery(source);
    else appStore.actions.patchDiscover({ error: null, view: 'browse', section: null });
  });

  /**
   * Enter the tuner from a card or from the whole set (FR-24.5).
   *
   * One attribute, one delegate — see the delegate/morph rule in `docs/3-ui.md`.
   */
  void delegate(root, 'click', '[data-tune]', (_e, el) => {
    const value = el.getAttribute('data-tune');
    if (value === null) return;
    const separator = value.indexOf(':');
    const direction = value.slice(0, separator);
    const anchor = value.slice(separator + 1);
    if (direction !== 'narrower' && direction !== 'similar') return;
    void enterTuner(anchor, direction);
  });

  /** Keep / skip / done, all on one attribute for the same reason. */
  void delegate(root, 'click', '[data-tuner]', (_e, el) => {
    const action = el.getAttribute('data-tuner');
    if (action === 'done') {
      finishTuner();
      return;
    }
    if (action === 'keep' || action === 'skip') void judgeTunerCandidate(action);
  });

  void delegate(root, 'click', '[data-add-suggestion]', (_e, el) => {
    const name = el.getAttribute('data-add-suggestion');
    if (name !== null) void addSuggestion(name);
  });

  void delegate(root, 'change', '[data-action=interval]', (_e, el) => {
    const ms = Number.parseInt((el as HTMLSelectElement).value, 10);
    if (Number.isNaN(ms)) return;
    // Give the scheduler a grace before the falling-behind banner may fire —
    // a just-shortened interval otherwise flags topics that are merely awaiting
    // their next check (NEWS-67).
    appStore.actions.bumpBehindGrace();
    void updateInterval(ms);
  });

  void delegate(root, 'change', '[data-action=hp-interval]', (_e, el) => {
    const ms = Number.parseInt((el as HTMLSelectElement).value, 10);
    if (Number.isNaN(ms)) return;
    appStore.actions.bumpBehindGrace();
    void updateHighPriorityInterval(ms);
  });

  void delegate(root, 'change', '[data-action=topic-sort]', (_e, el) => {
    const value = (el as HTMLSelectElement).value;
    if (TOPIC_SORTS.includes(value as (typeof TOPIC_SORTS)[number])) {
      appStore.actions.setTopicSort(value as (typeof TOPIC_SORTS)[number]);
    }
  });

  void delegate(root, 'change', '[data-action=provider]', (_e, el) => {
    void updateProviderSettings({ provider: (el as HTMLSelectElement).value as ProviderName });
  });

  // Persist model / endpoint on change (blur or Enter), not every keystroke.
  void delegate(root, 'change', '[data-action=model]', (_e, el) => {
    void updateProviderSettings({ model: (el as HTMLInputElement).value.trim() });
  });
  void delegate(root, 'change', '[data-action=endpoint]', (_e, el) => {
    void updateProviderSettings({ endpoint: (el as HTMLInputElement).value.trim() });
  });

  void delegate(root, 'click', '[data-action=check-all]', () => {
    void startCheck();
  });

  void delegate(root, 'click', '[data-action=toggle-sidebar]', () => {
    appStore.actions.setSidebarCollapsed(!appStore.state.value.sidebarCollapsed);
  });

  void delegate(root, 'click', '[data-action=rerun-onboarding]', () => {
    appStore.actions.setSettingsOpen(false);
    appStore.actions.setOnboarding('welcome');
    void refreshKeys();
    void refreshProviders();
  });

  void delegate(root, 'click', '[data-action=open-settings]', () => {
    // Always reopen on the first tab: wherever you left off is rarely where you
    // want to be next time, and a dialog that remembers is a dialog that opens
    // somewhere surprising.
    appStore.actions.setSettingsTab('schedule');
    appStore.actions.setSettingsOpen(true);
    // Status can go stale while the dialog is closed — a key added in another
    // window, or an environment variable set since load.
    void refreshKeys();
    void refreshProviders();
  });

  void delegate(root, 'click', '[data-settings-tab]', (_e, el) => {
    const tab = el.getAttribute('data-settings-tab');
    if (tab !== null) appStore.actions.setSettingsTab(tab as AppState['settingsTab']);
  });

  // Arrow keys move between tabs, which the WAI-ARIA tabs pattern requires:
  // only the selected tab is in the tab order, so without this the others are
  // unreachable from the keyboard entirely.
  void delegate(root, 'keydown', '[data-settings-tab]', (e, el) => {
    if (!(e instanceof KeyboardEvent)) return;
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const tabs = [...root.querySelectorAll<HTMLElement>('[data-settings-tab]')];
    const here = tabs.indexOf(el as HTMLElement);
    // Wraps at both ends, as the pattern specifies.
    const next = tabs[(here + step + tabs.length) % tabs.length];
    const id = next.getAttribute('data-settings-tab');
    if (id !== null) {
      appStore.actions.setSettingsTab(id as AppState['settingsTab']);
      // Focus follows selection here; the panel is rendered fresh, so the tab
      // element is replaced and has to be re-found after the render.
      queueMicrotask(() => root.querySelector<HTMLElement>(`[data-settings-tab="${id}"]`)?.focus());
    }
  });

  void delegate(root, 'click', '[data-action=open-privacy]', () => {
    appStore.actions.setPrivacyOpen(true);
  });

  void delegate(root, 'click', '[data-action=close-privacy]', () => {
    appStore.actions.setPrivacyOpen(false);
  });

  // Only a click on the backdrop itself dismisses — the backdrop wraps the
  // dialog, so matching descendants would close it before any inner control
  // could act (docs/3-ui.md).
  void delegate(root, 'click', '[data-action=privacy-backdrop]', (e, el) => {
    if (e.target === el) appStore.actions.setPrivacyOpen(false);
  });

  void delegate(root, 'click', '[data-action=close-settings]', () => {
    appStore.actions.setSettingsOpen(false);
  });

  // Backdrop click-away. This deliberately does NOT share the close action:
  // delegation matches against the target's ancestors, and the backdrop wraps
  // the whole dialog — so every click inside it, including Save, would match a
  // `[data-action=close-settings]` backdrop and dismiss the dialog mid-submit.
  // Only a click that landed on the backdrop itself should close.
  void delegate(root, 'click', '[data-action=settings-backdrop]', (e, el) => {
    if (e.target === el) appStore.actions.setSettingsOpen(false);
  });

  void delegate(root, 'submit', '[data-save-key]', (e, form) => {
    e.preventDefault();
    const provider = form.getAttribute('data-save-key');
    const input = form.querySelector<HTMLInputElement>('input[name=api-key]');
    if (provider === null || !input) return;
    const key = input.value.trim();
    if (key === '') return;
    void saveKey(provider, key).then((ok) => {
      // Clear the field either way: on success it's stored, and on failure
      // leaving a key sitting in the DOM serves no purpose.
      input.value = '';
      return ok;
    });
  });

  void delegate(root, 'click', '[data-remove-key]', (_e, el) => {
    const provider = el.getAttribute('data-remove-key');
    if (provider === null) return;
    const label = appStore.state.value.keys.find((k) => k.provider === provider)?.label ?? provider;
    void (async () => {
      if (await confirm(`Remove the stored ${label} API key?`, { confirmLabel: 'Remove', danger: true })) {
        await deleteKey(provider);
      }
    })();
  });

  // Budget is committed on `change` (blur / Enter), not `input` — a PATCH per
  // keystroke would round-trip "1", "12", "125" and fight the 4 s state poll
  // for the field. Blank means no limit.

  void delegate(root, 'change', '[data-action=schedule-mode]', (_e, el) => {
    if (el instanceof HTMLSelectElement && (el.value === 'interval' || el.value === 'daily')) {
      void updateScheduleMode(el.value);
    }
  });

  // Committed on `change`, not per keystroke: "08:0" is not a time, and a PATCH
  // per character would fight the 4 s poll for the field.
  void delegate(root, 'change', '[data-action=daily-times]', (_e, el) => {
    if (!(el instanceof HTMLInputElement)) return;
    const times = el.value
      .split(',')
      .map((t) => t.trim())
      .filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t));
    if (times.length === 0) {
      // Nothing parseable — put the saved value back rather than silently
      // clearing the schedule out from under the user.
      el.value = appStore.state.value.settings.dailyTimes.join(', ');
      showToast('Times must look like 08:00 — nothing changed');
      return;
    }
    void updateDailyTimes(times);
  });


  void delegate(root, 'change', '[data-action=concurrency]', (_e, el) => {
    if (el instanceof HTMLSelectElement) void updateConcurrency(Number(el.value));
  });

  void delegate(root, 'change', '[data-action=retention]', (_e, el) => {
    if (el instanceof HTMLSelectElement) void updateRetention(Number(el.value));
  });

  void delegate(root, 'change', '[data-action=diag-topics]', (_e, el) => {
    if (el instanceof HTMLInputElement) appStore.actions.setDiagIncludeTopics(el.checked);
  });

  void delegate(root, 'click', '[data-action=copy-diagnostics]', () => {
    const s = appStore.state.value;
    const text = buildDiagnostics(
      { ...s, latestItemIds: [] },
      {
        includeTopicNames: s.diagIncludeTopics,
        userAgent: navigator.userAgent,
        appVersion: s.appVersion === '' ? 'unknown' : s.appVersion,
      },
    );
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        showToast('Diagnostics copied');
      })
      .catch(() => {
        showToast('Could not copy — clipboard unavailable');
      });
  });

  // --- first-run flow (NEWS-78) ---------------------------------------------

  void delegate(root, 'click', '[data-starter-topic]', (_e, el) => {
    const name = el.getAttribute('data-starter-topic');
    if (name !== null) appStore.actions.toggleOnboardingTopic(name);
  });

  void delegate(root, 'submit', '[data-action=onboarding-suggest]', (e, form) => {
    e.preventDefault();
    const input = form.querySelector<HTMLInputElement>('input[name=onboarding-query]');
    void suggestOnboardingTopics(input?.value.trim() ?? '');
  });

  void delegate(root, 'click', '[data-action=onboarding-skip]', () => {
    closeOnboarding();
  });

  void delegate(root, 'click', '[data-action=onboarding-next]', () => {
    const current = appStore.state.value.onboarding;
    if (current === null || current === 'auto') return;
    // Past the end means "done" — indexing a readonly tuple past its length is
    // typed as never-undefined, so the bound is checked explicitly.
    const at = ONBOARDING_STEPS.indexOf(current) + 1;
    if (at >= ONBOARDING_STEPS.length) {
      // Last step: create whatever was chosen, then get out of the way. Topics
      // are added one at a time because each POST fires its own first check.
      const { onboardingTopics: chosen, onboardingSuggestions } = appStore.state.value;
      closeOnboarding();
      void (async () => {
        for (const name of chosen) {
          // A pick that came from a suggestion is created *with* its guidance and
          // classification (FR-24.12/24.13) — creating it by name alone would
          // throw away the steer that makes its first check narrowed, which is
          // the whole reason the suggestion carries one.
          const suggestion = onboardingSuggestions.find((item) => item.name === name);
          if (suggestion === undefined) await addTopic(name);
          else await addSuggestedTopic(suggestion);
        }
      })();
      return;
    }
    const next = ONBOARDING_STEPS[at];
    appStore.actions.setOnboarding(next);
    // Entering the source step, re-read what's actually configured: a key may
    // have been added in another window since load.
    if (next === 'source') {
      void refreshKeys();
      void refreshProviders();
    }
  });

  // --- topic guidance (NEWS-80) --------------------------------------------

  void delegate(root, 'submit', '[data-save-guidance]', (e, form) => {
    e.preventDefault();
    const id = form.getAttribute('data-save-guidance');
    const field = form.querySelector<HTMLTextAreaElement>('textarea[name=guidance]');
    if (id === null || !field) return;
    const guidance = field.value.trim();
    appStore.actions.closeGuidance();
    void setTopicGuidance(id, guidance).then(() => {
      // Guidance only takes effect on the *next* check, so say so — otherwise
      // saving looks like it did nothing until tomorrow's sweep.
      showToast(guidance === '' ? 'Guidance cleared' : 'Guidance saved — applies from the next check');
    });
  });

  void delegate(root, 'click', '[data-action=close-guidance]', () => {
    appStore.actions.closeGuidance();
  });

  // Only a click that landed on the backdrop itself closes — matching
  // descendants would dismiss the dialog on the way to Save (see docs/3-ui.md).
  void delegate(root, 'click', '[data-action=guidance-backdrop]', (e, el) => {
    if (e.target === el) appStore.actions.closeGuidance();
  });

  // --- topic selection -----------------------------------------------------

  void delegate(root, 'click', '[data-topic-row]', (e, el) => {
    const id = el.getAttribute('data-topic-row');
    if (id === null || !(e instanceof MouseEvent)) return;
    // Cmd on macOS, Ctrl elsewhere — reading both is simpler and more forgiving
    // than sniffing the platform, and no OS uses them for conflicting meanings.
    selectTopic(id, { toggle: e.metaKey || e.ctrlKey, range: e.shiftKey });
  });

  // --- section filter bar (NEWS-97) ----------------------------------------

  void delegate(root, 'click', '[data-filter-category]', (_e, el) => {
    const slug = el.getAttribute('data-filter-category') ?? '';
    // Selecting a category always resets the sub-row: the previous subcategory
    // belongs to a different parent and would match nothing.
    appStore.actions.setCategoryFilter(slug === '' ? null : { category: slug, subcategory: null });
    void refreshFeed();
  });

  void delegate(root, 'click', '[data-filter-subcategory]', (_e, el) => {
    const current = appStore.state.value.categoryFilter;
    if (current === null) return;
    const slug = el.getAttribute('data-filter-subcategory') ?? '';
    appStore.actions.setCategoryFilter({ category: current.category, subcategory: slug === '' ? null : slug });
    void refreshFeed();
  });

  // Double-click toggles solo (NEWS-95) — the one topic action common enough to
  // deserve a gesture instead of a trip through the right-click menu.
  //
  // Acts on the double-clicked row alone, never the wider selection: the two
  // clicks that make up the gesture have already collapsed the selection to
  // this row (a plain click sets it), so anything else would act on rows the
  // user can no longer see are targeted.
  //
  // Routed through `runTopicAction` rather than reimplemented, so the gesture
  // and the menu item can't drift apart — including the additive behaviour,
  // where soloing a second topic widens the filter instead of replacing it.
  // `.topic` is `user-select: none`, so this can't leave a stray text selection.
  void delegate(root, 'dblclick', '[data-topic-row]', (e, el) => {
    const id = el.getAttribute('data-topic-row');
    if (id === null || !(e instanceof MouseEvent)) return;
    runTopicAction('solo', [id]);
  });

  // Keyboard equivalents for the row (NEWS-90). The context menu is the only
  // route to check / pause / priority / guidance / solo / delete, so without
  // these the whole topic action set is mouse-only.
  void delegate(root, 'keydown', '[data-topic-row]', (e, el) => {
    const id = el.getAttribute('data-topic-row');
    if (id === null || !(e instanceof KeyboardEvent)) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selectTopic(id, { toggle: e.metaKey || e.ctrlKey, range: e.shiftKey });
      return;
    }
    // The platform gesture for "open this element's menu": macOS has no Menu
    // key, so Shift+F10 is the one that has to work everywhere.
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      openTopicMenuFor(id, el);
    }
  });

  void delegate(root, 'contextmenu', '[data-topic-row]', (e, el) => {
    const id = el.getAttribute('data-topic-row');
    if (id === null || !(e instanceof MouseEvent)) return;
    e.preventDefault();
    const current = appStore.state.value.selectedTopicIds;
    // Right-clicking inside the selection acts on all of it; right-clicking
    // outside it selects that row first, so the menu never acts on rows the
    // user can't see are targeted.
    const topicIds = current.includes(id) ? current : [id];
    if (!current.includes(id)) {
      appStore.actions.setSelection([id]);
      anchorId = id;
    }
    appStore.actions.openContextMenu({ x: e.clientX, y: e.clientY, topicIds });
  });

  // Only a click that landed on the backdrop itself dismisses. The backdrop
  // wraps the menu, so matching descendants too would close the menu before the
  // item handler below could read `contextMenu` — the same trap the settings
  // dialog hit (see docs/3-ui.md).
  void delegate(root, 'click', '[data-action=close-menu]', (e, el) => {
    if (e.target === el) appStore.actions.closeContextMenu();
  });

  void delegate(root, 'click', '[data-menu-action]', (_e, el) => {
    const action = el.getAttribute('data-menu-action');
    const menu = appStore.state.value.contextMenu;
    if (action === null || menu === null) return;
    appStore.actions.closeContextMenu();
    runTopicAction(action, menu.topicIds);
  });

  // --- Story context menu (bookmark / share / flag), NEWS-61 ---
  void delegate(root, 'contextmenu', '[data-item-id]', (e, el) => {
    const id = el.getAttribute('data-item-id');
    if (id === null || !(e instanceof MouseEvent)) return;
    e.preventDefault();
    appStore.actions.openItemMenu({ x: e.clientX, y: e.clientY, itemId: id });
  });
  void delegate(root, 'click', '[data-action=close-item-menu]', (e, el) => {
    if (e.target === el) appStore.actions.closeItemMenu();
  });
  void delegate(root, 'click', '[data-item-menu-action]', (_e, el) => {
    const action = el.getAttribute('data-item-menu-action');
    const menu = appStore.state.value.itemMenu;
    if (action === null || menu === null) return;
    const item = feedAndFlagged().find((i) => i.id === menu.itemId);
    appStore.actions.closeItemMenu();
    if (item === undefined) return;
    if (action === 'bookmark') void setItemSaved(item.id, !item.saved);
    else if (action === 'share') void shareOne(item);
    else if (action === 'flag') flagItem(item, !item.offTopic);
  });
  // Clicking the "off topic" pill on a collapsed row prompts to unflag.
  void delegate(root, 'click', '[data-unflag-prompt]', (_e, el) => {
    const id = el.getAttribute('data-unflag-prompt');
    if (id === null) return;
    void (async () => {
      if (await confirm('Unflag this story? It will return to the feed.', { confirmLabel: 'Unflag' })) {
        appStore.actions.removeRecentlyFlagged(id);
        await setItemOffTopic(id, false);
        await refreshFeed();
      }
    })();
  });
  void delegate(root, 'click', '[data-action=exit-review]', () => {
    appStore.actions.setReviewTopicIds([]);
    void refreshFeed();
  });

  void delegate(root, 'click', '[data-action=clear-solo]', () => {
    appStore.actions.setSolo([]);
    void refreshFeed();
  });

  void delegate(root, 'click', '[data-save-item]', (_e, el) => {
    const id = el.getAttribute('data-save-item');
    if (id === null) return;
    const saved = el.getAttribute('data-saved') === 'true';
    void setItemSaved(id, !saved);
  });
  void delegate(root, 'click', '[data-share-item]', (_e, el) => {
    const id = el.getAttribute('data-share-item');
    if (id === null) return;
    const item = feedAndFlagged().find((i) => i.id === id);
    if (item !== undefined) void shareOne(item);
  });
  void delegate(root, 'click', '[data-action=toggle-saved-filter]', () => {
    appStore.actions.setSavedFilter(!appStore.state.value.savedFilter);
    void refreshFeed();
  });
  void delegate(root, 'click', '[data-action=clear-saved-filter]', () => {
    appStore.actions.setSavedFilter(false);
    void refreshFeed();
  });

  // Live feed search (NEWS-60/76). The input is uncontrolled — no `value`
  // binding — so re-rendering can't fight the cursor. Search is now a server
  // query (NEWS-76), so the refetch is debounced rather than per-keystroke.
  void delegate(root, 'input', '[data-action=search]', (_e, el) => {
    appStore.actions.setSearchQuery((el as HTMLInputElement).value);
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => void refreshFeed(), SEARCH_DEBOUNCE_MS);
  });
  void delegate(root, 'click', '[data-action=show-more]', () => {
    appStore.actions.showMoreFeed();
    void refreshFeed();
  });

  void delegate(root, 'click', '[data-action=clear-search]', (_e, el) => {
    // Clear the store AND the uncontrolled input's live value, then refocus it.
    clearTimeout(searchDebounce);
    appStore.actions.setSearchQuery('');
    const input = el.closest('.search')?.querySelector<HTMLInputElement>('[data-action=search]');
    if (input) {
      input.value = '';
      input.focus();
    }
    void refreshFeed();
  });

  void delegate(root, 'click', '[data-action=dismiss-error]', () => {
    appStore.actions.setError(null);
  });
  // The warning is derived from the runs list, so dismissal is by run id — a
  // later, different failure has a new id and shows again.
  void delegate(root, 'click', '[data-action=dismiss-warn]', (_e, el) => {
    const id = el.getAttribute('data-run-id');
    if (id !== null) appStore.actions.dismissRun(id);
  });
  void delegate(root, 'click', '[data-action=dismiss-behind]', () => {
    appStore.actions.dismissBehind();
  });

  // Notification toggle. Enabling requires a permission grant, and the request
  // must ride the user gesture that is this change event.
  void delegate(root, 'change', '[data-action=notify-toggle]', (_e, el) => {
    const wantsOn = (el as HTMLInputElement).checked;
    if (!wantsOn) {
      appStore.actions.setNotifyPermissionDenied(false);
      void setNotifyOnNewItems(false);
      return;
    }
    void (async () => {
      const granted = await ensureNotificationPermission();
      appStore.actions.setNotifyPermissionDenied(!granted);
      if (granted) {
        // Persist only when we can actually deliver — otherwise the box would
        // read "on" while nothing ever fires.
        await setNotifyOnNewItems(true);
      } else {
        // The user's click already checked the box. The stored setting stays
        // false, but false→false is no attribute change, so morph won't reset
        // the live `checked` property — do it by hand.
        (el as HTMLInputElement).checked = false;
      }
    })();
  });

  void delegate(root, 'click', '[data-action=confirm-ok]', () => {
    resolveConfirm(true);
  });
  void delegate(root, 'click', '[data-action=confirm-cancel]', () => {
    resolveConfirm(false);
  });
  // Backdrop click-away cancels. Same nesting caveat as the settings dialog:
  // only a click on the backdrop element itself, not a bubbled one from inside.
  void delegate(root, 'click', '[data-action=confirm-backdrop]', (e, el) => {
    if (e.target === el) resolveConfirm(false);
  });

  void delegate(root, 'click', 'a[data-external]', (e, el) => {
    const url = el.getAttribute('href');
    if (url !== null && openExternalUrl(url)) e.preventDefault();
  });
}

/**
 * Global interactions that aren't scoped to one element: dismissing the
 * selection and menu, and the Delete key.
 */
function wireGlobalKeysAndDismiss(): void {
  document.addEventListener('mousedown', (e) => {
    if (!(e.target instanceof Element)) return;
    // A click on a row, or inside the menu, is handled by its own delegate.
    if (e.target.closest('[data-topic-row]') !== null) return;
    if (e.target.closest('.menu') !== null) return;
    const { selectedTopicIds, contextMenu, itemMenu } = appStore.state.value;
    if (contextMenu !== null) appStore.actions.closeContextMenu();
    if (itemMenu !== null && e.target.closest('[data-item-id]') === null) appStore.actions.closeItemMenu();
    if (selectedTopicIds.length > 0) appStore.actions.setSelection([]);
  });

  document.addEventListener('keydown', (e) => {
    // Tab is trapped inside an open dialog (NEWS-90): without it, tabbing walks
    // out of the modal into the page behind, which a screen-reader user cannot
    // see is still there.
    if (e.key === 'Tab' && trapTabInDialog(e)) return;
    if (e.key === 'Escape') {
      const s = appStore.state.value;
      if (s.confirm !== null) {
        resolveConfirm(false);
        return;
      }
      // Innermost first: a dialog opened over another closes alone.
      if (s.guidanceTopicId !== null) {
        appStore.actions.closeGuidance();
        return;
      }
      if (s.privacyOpen) {
        appStore.actions.setPrivacyOpen(false);
        return;
      }
      if (s.settingsOpen) {
        appStore.actions.setSettingsOpen(false);
        return;
      }
      if (s.onboarding !== null && s.onboarding !== 'auto') {
        closeOnboarding();
        return;
      }
      appStore.actions.closeContextMenu();
      appStore.actions.closeItemMenu();
      appStore.actions.setSelection([]);
      return;
    }
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    // Never steal Backspace from the add-topic field — deleting a character
    // must not delete a topic.
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
    const { selectedTopicIds } = appStore.state.value;
    if (selectedTopicIds.length === 0) return;
    e.preventDefault();
    confirmDelete(selectedTopicIds);
  });
}

/**
 * Keep Tab inside the frontmost dialog. Returns true when it handled the event.
 *
 * Reads the DOM rather than mirroring dialog state in the store: what is
 * actually focusable is a DOM question (a disabled Save button isn't), and a
 * duplicate model of it would drift.
 */
function trapTabInDialog(e: KeyboardEvent): boolean {
  const dialogs = [...document.querySelectorAll<HTMLElement>('.dialog-backdrop .dialog')];
  const dialog = dialogs.at(-1);
  if (dialog === undefined) return false;
  const focusable = [...dialog.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]')]
    .filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1 && el.offsetParent !== null);
  const first = focusable.at(0);
  const last = focusable.at(-1);
  if (first === undefined || last === undefined) return false;
  const active = document.activeElement;
  // Focus outside the dialog (including on <body> right after it opened) gets
  // pulled to an end of the cycle rather than left to wander the page.
  if (!(active instanceof HTMLElement) || !dialog.contains(active)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
    return true;
  }
  if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
    return true;
  }
  if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

function startPolling(): void {
  setInterval(() => {
    if (document.visibilityState === 'visible') void refreshState();
  }, 4000);
}

/** Is the app actually in front of the user right now? */
function isForegrounded(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

/**
 * Heartbeat that permits scheduled checks on subscription-backed providers.
 *
 * Sent on an interval comfortably shorter than the server's window, plus
 * immediately on the events that can make the app foregrounded, so returning
 * to it takes effect at once instead of after the next tick.
 */
function startForegroundHeartbeat(): void {
  const beat = (): void => {
    if (isForegrounded()) void reportForeground();
  };
  beat();
  setInterval(beat, 60_000);
  window.addEventListener('focus', beat);
  document.addEventListener('visibilitychange', beat);
}

/**
 * Compile-time flag, substituted by esbuild (`--define:__KERF_DEV__`). False in
 * `build:client`, true in `build:client:dev`.
 *
 * A literal `false` lets esbuild drop the whole block *and* the `import()` with
 * it, so the dev chunk is never emitted in a production build — that is the
 * point of a define rather than a runtime check. It cannot be
 * `process.env.NODE_ENV`, kerf's own documented form: this is an IIFE browser
 * bundle, `process` doesn't exist, and the read would throw at startup.
 */
declare const __KERF_DEV__: boolean;

/**
 * kerf development diagnostics (NEWS-100). kerf 3.x no longer infers dev mode —
 * installing these is the app's decision, made here.
 *
 * `invariants: 'throw'` is the valuable one: it audits kerf's list bookkeeping
 * against the live DOM after every render and fails at the render that broke
 * it, rather than leaving a wrong picture to be discovered several interactions
 * later. That is exactly the shape KF-377 had.
 *
 * `enableWarnings()` rather than the `KERF_DEV_WARN_*` env vars, which cannot
 * be reached from a browser at all.
 */
if (__KERF_DEV__) {
  void import('kerfjs/dev').then((dev) => {
    dev.enableWarnings({
      invariants: 'throw',
      staleBinding: true,
      narrowSet: true,
      duplicateEachKeys: true,
      listRebind: true,
      staleIndex: true,
      eachInMorphSkip: true,
      delegateInEffect: true,
      rebuiltListeners: true,
      parserRepair: true,
    });
    return dev;
  });
}

const root = document.getElementById('app');
if (root) {
  mount(root, () => appJsx());
  wireEvents(root);
  wireGlobalKeysAndDismiss();
  void refreshState().then(maybeOpenOnboarding);
  void refreshProviders().then(maybeOpenOnboarding);
  // Learn the OS notification permission up front in the desktop shell, so a
  // session that already had notifications on keeps firing them (NEWS-66).
  void syncTauriNotificationPermission();
  startPolling();
  startForegroundHeartbeat();
}
