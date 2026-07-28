import { defineStore } from 'kerfjs';

import type { ItemsResp, KeysResp, ProviderInfo, StateResp } from '../api/schemas.js';

type NewsItem = ItemsResp['items'][number];

/** How many stories the feed reveals per "Show more" page (NEWS-62). */
export const FEED_PAGE = 100;

/** Sidebar ordering options (NEWS-63). */
export type TopicSort = 'alpha' | 'added' | 'priority';
export const TOPIC_SORTS: readonly TopicSort[] = ['alpha', 'added', 'priority'];
export const TOPIC_SORT_LABELS: Record<TopicSort, string> = {
  alpha: 'A → Z',
  added: 'Recently added',
  priority: 'Priority first',
};

/** Steps of the first-run flow, in order (NEWS-78). */
export const ONBOARDING_STEPS = ['welcome', 'source', 'topics', 'schedule'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/**
 * Suggested starter topics (NEWS-78) — broad enough that any of them returns
 * something on the first check, so the first feed is never empty.
 */
export const STARTER_TOPICS = [
  'Artificial intelligence',
  'Climate and energy',
  'Space exploration',
  'Global economy',
  'Public health',
  'Cybersecurity',
] as const;

export interface AppState {
  loaded: boolean;
  /** Last error shown in the banner, or null. */
  error: string | null;
  topics: StateResp['topics'];
  /** The current feed page, fetched from `/api/items` for the active view (NEWS-76). */
  feedItems: NewsItem[];
  /** Total stories matching the active view, from the server — drives "Show more". */
  feedTotal: number;
  /** Off-topic count per topic, for the "Review Flagged (N)" badge (NEWS-76). */
  flaggedByTopic: Record<string, number>;
  settings: StateResp['settings'];
  runs: StateResp['runs'];
  checking: string[];
  /** Estimated spend this month + the budget cap (NEWS-79). */
  spend: StateResp['spend'];
  /** App version, for the diagnostics bundle (NEWS-88). */
  appVersion: string;
  /** Live model rates, so the client can price runs the same way (NEWS-93). */
  prices: StateResp['prices'];
  /** Whether a copied diagnostics bundle includes topic names (NEWS-88). */
  diagIncludeTopics: boolean;
  /** Provider list + availability (fetched on demand, not every poll). */
  providers: ProviderInfo[];
  /** Whether the settings dialog is open. */
  settingsOpen: boolean;
  /**
   * First-run flow (NEWS-78): the step being shown, or null when closed.
   *
   * `'auto'` is the not-yet-decided state — it opens itself once state and
   * providers have both loaded and the app turns out to be unusable. Without
   * that tri-state the wizard flashes open on every reload before the provider
   * probe has answered.
   */
  onboarding: 'auto' | OnboardingStep | null;
  /** Starter topics ticked in the onboarding flow, before they're created. */
  onboardingTopics: string[];
  /**
   * Per-provider key status. Never holds a key value — the server doesn't
   * return one (see `KeyStatusSchema`), so there is nothing here to leak into
   * the DOM.
   */
  keys: KeysResp['keys'];
  /**
   * Whether `/api/keys` has answered yet.
   *
   * Without this the dialog asserts "no keychain is available" from its
   * initial state — an alarming, usually wrong message that flashes every time
   * the dialog opens, before the fetch has even resolved.
   */
  keysLoaded: boolean;
  keychainAvailable: boolean;
  keychainLabel: string;
  /** Error shown inside the dialog, kept separate from the page banner. */
  keyError: string | null;
  /** Whether the topics sidebar is collapsed (per-device, see `SIDEBAR_KEY`). */
  sidebarCollapsed: boolean;
  /** How the topics sidebar is ordered (per-device, NEWS-63). Default A→Z. */
  topicSort: TopicSort;
  /** Currently selected topic ids. Selection is transient — never persisted. */
  selectedTopicIds: string[];
  /** When true, the feed shows only bookmarked stories (NEWS-42). Ephemeral. */
  savedFilter: boolean;
  /** Live feed search query (NEWS-60). Ephemeral, composes with Solo/Saved. */
  searchQuery: string;
  /** How many stories the feed currently shows; grows by `FEED_PAGE` (NEWS-62). */
  feedLimit: number;
  /**
   * Topics that are solo'd: when non-empty, the feed shows only their stories.
   *
   * Deliberately in-memory and cleared on reload. A solo that survived a
   * restart would silently hide news days later, and "the app stopped finding
   * anything" is a much worse failure than re-applying a filter.
   */
  soloTopicIds: string[];
  /**
   * Filter-bar selection (NEWS-97): a category slug, `'uncategorized'`, or null
   * for "All". `subcategory` is the second-row selection within it.
   *
   * **Ephemeral, like Solo and for the same reason** (`docs/3-ui.md`): a filter
   * that quietly survived a restart would hide news days later, and "the app
   * stopped finding anything" is a far worse failure than re-applying a filter.
   * The sidebar collapse and topic sort *are* persisted — they change how the
   * app looks, not what it is willing to show you.
   */
  categoryFilter: { category: string; subcategory: string | null } | null;
  /** Open topic context menu, positioned in viewport coordinates. */
  contextMenu: { x: number; y: number; topicIds: string[] } | null;
  /** Open story context menu (bookmark / share / flag), viewport coords (NEWS-61). */
  itemMenu: { x: number; y: number; itemId: string } | null;
  /**
   * Stories flagged off-topic **this session** (NEWS-61), full data kept so
   * they can be merged (collapsed) into the server's normal-view page, which
   * now excludes them (NEWS-76). A just-flagged story stays visible as a dimmed
   * one-liner so a mistake is undoable; on reload this is empty, so flagged
   * stories are simply gone.
   */
  recentlyFlaggedItems: NewsItem[];
  /**
   * When non-empty, the feed is in "review flagged" mode (NEWS-61): it shows
   * ONLY the off-topic stories for these topics. Ephemeral; a banner exits it.
   */
  reviewTopicIds: string[];
  /**
   * Open confirmation dialog, or null. In-app rather than `window.confirm`,
   * which is a silent no-op in the Tauri WKWebView — so a native confirm made
   * every guarded action (delete, key removal) do nothing in the desktop app.
   */
  confirm: { message: string; confirmLabel: string; danger: boolean } | null;
  /**
   * Id of the topic whose guidance is being edited (NEWS-80), or null. Only the
   * id is held: the text itself comes from the topic in server state, so the
   * dialog can't drift from what was saved.
   */
  guidanceTopicId: string | null;
  /** True when the user tried to enable notifications but permission was refused. */
  notifyPermissionDenied: boolean;
  /**
   * Whether the "checks are falling behind" banner has been dismissed this
   * session (NEWS-59). Informational, so a plain session-level dismiss — it
   * reappears on reload if the condition persists.
   */
  dismissedBehind: boolean;
  /**
   * Timestamp until which the "falling behind" banner is suppressed (NEWS-67).
   * Set on startup and bumped on an interval change, so shortening the interval
   * doesn't warn before the scheduler has had a chance to re-check topics that
   * were fresh under the old interval.
   */
  behindGraceUntil: number;
  /**
   * Transient one-line notice shown at the bottom of the screen, or null.
   * In-app rather than `window.alert` (a WKWebView no-op), used to confirm a
   * share landed on the clipboard when there's no OS share sheet (NEWS-43).
   */
  toast: string | null;
  /**
   * Id of the failed check-run whose warning banner the user dismissed. The
   * warning is derived from the runs list (server state), not a piece of
   * dismissable state — so dismissal is remembered by run id. A *different*
   * later failure has a new id and shows again, which is what you want.
   */
  dismissedRunId: string | null;
}

/**
 * Persisted per device rather than in the store: how you've sized your own
 * window is a view preference, not something that belongs in the shared data
 * file alongside topics and stories.
 */
/** Grace after startup / an interval change before the falling-behind banner
 *  may appear — long enough for the scheduler to run a sweep (NEWS-67). */
const BEHIND_GRACE_MS = 30 * 60 * 1000;

/**
 * Whether the first-run flow has been dismissed (NEWS-78). Per-device, like the
 * other view preferences: it records what *this* browser has already shown, not
 * anything about the account's data.
 */
const ONBOARDING_KEY = 'news:onboarding-seen';

export function readOnboardingSeen(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(ONBOARDING_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeOnboardingSeen(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(ONBOARDING_KEY, '1');
  } catch {
    // private mode / storage disabled — the flow just reappears next launch
  }
}

const SIDEBAR_KEY = 'news:sidebar-collapsed';

function readSidebarCollapsed(): boolean {
  // Guarded so importing this module outside a browser can't throw.
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1';
  } catch {
    return false; // private mode / storage disabled
  }
}

const TOPIC_SORT_KEY = 'news:topic-sort';

function readTopicSort(): TopicSort {
  if (typeof localStorage === 'undefined') return 'alpha';
  try {
    const v = localStorage.getItem(TOPIC_SORT_KEY);
    return v !== null && (TOPIC_SORTS as readonly string[]).includes(v) ? (v as TopicSort) : 'alpha';
  } catch {
    return 'alpha';
  }
}

/**
 * The dismissed failed-run id is persisted (NEWS-41): the failure warning is
 * derived from server state that outlives a page reload, so an in-memory
 * dismissal meant relaunching the app resurrected a warning the user had
 * already closed. A *new* failure has a new id and still shows.
 */
const DISMISSED_RUN_KEY = 'news:dismissed-run';

function readDismissedRunId(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(DISMISSED_RUN_KEY);
  } catch {
    return null;
  }
}

function writeDismissedRunId(id: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(DISMISSED_RUN_KEY, id);
  } catch {
    // private mode / storage disabled — dismissal just won't persist
  }
}


export const appStore = defineStore({
  initial: (): AppState => ({
    loaded: false,
    error: null,
    topics: [],
    feedItems: [],
    feedTotal: 0,
    flaggedByTopic: {},
    settings: {
      checkIntervalMs: 24 * 60 * 60 * 1000,
      highPriorityIntervalMs: 24 * 60 * 60 * 1000,
      provider: 'auto',
      model: '',
      endpoint: '',
      notifyOnNewItems: false,
      monthlyBudgetUsd: 0,
      itemRetentionDays: 365,
      scheduleMode: 'interval',
      dailyTimes: ['08:00'],
      checkConcurrency: 3,
      priceManifestUrl: '',
    },
    runs: [],
    checking: [],
    spend: {
      usd: 0,
      pricedRuns: 0,
      unpricedRuns: 0,
      monthlyBudgetUsd: 0,
      overBudget: false,
      pricesVerifiedOn: '',
    },
    appVersion: '',
    prices: {},
    diagIncludeTopics: false,
    providers: [],
    settingsOpen: false,
    onboarding: 'auto',
    onboardingTopics: [],
    keys: [],
    keysLoaded: false,
    keychainAvailable: false,
    keychainLabel: 'system keychain',
    keyError: null,
    sidebarCollapsed: readSidebarCollapsed(),
    topicSort: readTopicSort(),
    selectedTopicIds: [],
    savedFilter: false,
    searchQuery: '',
    feedLimit: FEED_PAGE,
    soloTopicIds: [],
    categoryFilter: null,
    contextMenu: null,
    itemMenu: null,
    recentlyFlaggedItems: [],
    reviewTopicIds: [],
    confirm: null,
    guidanceTopicId: null,
    notifyPermissionDenied: false,
    dismissedRunId: readDismissedRunId(),
    dismissedBehind: false,
    behindGraceUntil: Date.now() + BEHIND_GRACE_MS,
    toast: null,
  }),
  actions: (set, get) => ({
    setDiagIncludeTopics: (diagIncludeTopics: boolean) => {
      set({ ...get(), diagIncludeTopics });
    },
    setOnboarding: (onboarding: 'auto' | OnboardingStep | null) => {
      set({ ...get(), onboarding });
    },
    toggleOnboardingTopic: (name: string) => {
      const current = get();
      const chosen = current.onboardingTopics.includes(name)
        ? current.onboardingTopics.filter((t) => t !== name)
        : [...current.onboardingTopics, name];
      set({ ...current, onboardingTopics: chosen });
    },
    setSettingsOpen: (settingsOpen: boolean) => {
      set({ ...get(), settingsOpen, keyError: null });
    },
    setKeys: (resp: KeysResp) => {
      set({
        ...get(),
        keys: resp.keys,
        keysLoaded: true,
        keychainAvailable: resp.keychainAvailable,
        keychainLabel: resp.keychainLabel,
      });
    },
    setKeyError: (keyError: string | null) => {
      set({ ...get(), keyError });
    },
    setSelection: (selectedTopicIds: string[]) => {
      set({ ...get(), selectedTopicIds });
    },
    // The four view-changing actions reset the feed page: a different view is a
    // fresh list, shown from the top (NEWS-62).
    setSolo: (soloTopicIds: string[]) => {
      set({ ...get(), soloTopicIds, feedLimit: FEED_PAGE });
    },
    setCategoryFilter: (categoryFilter: AppState['categoryFilter']) => {
      set({ ...get(), categoryFilter, feedLimit: FEED_PAGE });
    },
    setSavedFilter: (savedFilter: boolean) => {
      set({ ...get(), savedFilter, feedLimit: FEED_PAGE });
    },
    setSearchQuery: (searchQuery: string) => {
      set({ ...get(), searchQuery, feedLimit: FEED_PAGE });
    },
    showMoreFeed: () => {
      set({ ...get(), feedLimit: get().feedLimit + FEED_PAGE });
    },
    openContextMenu: (menu: { x: number; y: number; topicIds: string[] }) => {
      set({ ...get(), contextMenu: menu });
    },
    closeContextMenu: () => {
      set({ ...get(), contextMenu: null });
    },
    openItemMenu: (menu: { x: number; y: number; itemId: string }) => {
      set({ ...get(), itemMenu: menu });
    },
    closeItemMenu: () => {
      set({ ...get(), itemMenu: null });
    },
    setFeed: (feed: { items: NewsItem[]; total: number }) => {
      set({ ...get(), feedItems: feed.items, feedTotal: feed.total });
    },
    // Hold a just-flagged story (full data) so it can render collapsed even
    // though the server's normal-view page now excludes it (NEWS-76).
    addRecentlyFlagged: (item: NewsItem) => {
      const s = get();
      if (s.recentlyFlaggedItems.some((i) => i.id === item.id)) return;
      set({ ...s, recentlyFlaggedItems: [...s.recentlyFlaggedItems, { ...item, offTopic: true }] });
    },
    removeRecentlyFlagged: (id: string) => {
      const s = get();
      set({ ...s, recentlyFlaggedItems: s.recentlyFlaggedItems.filter((i) => i.id !== id) });
    },
    setReviewTopicIds: (reviewTopicIds: string[]) => {
      set({ ...get(), reviewTopicIds, feedLimit: FEED_PAGE });
    },
    openConfirm: (confirm: { message: string; confirmLabel: string; danger: boolean }) => {
      set({ ...get(), confirm });
    },
    closeConfirm: () => {
      set({ ...get(), confirm: null });
    },
    openGuidance: (guidanceTopicId: string) => {
      set({ ...get(), guidanceTopicId });
    },
    closeGuidance: () => {
      set({ ...get(), guidanceTopicId: null });
    },
    setNotifyPermissionDenied: (notifyPermissionDenied: boolean) => {
      set({ ...get(), notifyPermissionDenied });
    },
    dismissRun: (dismissedRunId: string) => {
      writeDismissedRunId(dismissedRunId);
      set({ ...get(), dismissedRunId });
    },
    dismissBehind: () => {
      set({ ...get(), dismissedBehind: true });
    },
    bumpBehindGrace: () => {
      set({ ...get(), behindGraceUntil: Date.now() + BEHIND_GRACE_MS });
    },
    setToast: (toast: string | null) => {
      set({ ...get(), toast });
    },
    setSidebarCollapsed: (sidebarCollapsed: boolean) => {
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(SIDEBAR_KEY, sidebarCollapsed ? '1' : '0');
        } catch {
          // Storage unavailable — the toggle still works for this session.
        }
      }
      set({ ...get(), sidebarCollapsed });
    },
    setTopicSort: (topicSort: TopicSort) => {
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(TOPIC_SORT_KEY, topicSort);
        } catch {
          // Storage unavailable — the choice still applies for this session.
        }
      }
      set({ ...get(), topicSort });
    },
    update: (partial: Partial<AppState>) => {
      set({ ...get(), ...partial });
    },
    setState: (state: StateResp) => {
      const current = get();
      const live = new Set(state.topics.map((t) => t.id));
      // Drop ids for topics that no longer exist: a stale solo id would keep
      // the feed filtered against a topic that has been deleted, with nothing
      // in the sidebar to explain why the feed is empty.
      set({
        ...current,
        loaded: true,
        ...state,
        selectedTopicIds: current.selectedTopicIds.filter((id) => live.has(id)),
        soloTopicIds: current.soloTopicIds.filter((id) => live.has(id)),
      });
    },
    setProviders: (providers: ProviderInfo[]) => {
      set({ ...get(), providers });
    },
    setError: (error: string | null) => {
      set({ ...get(), error });
    },
  }),
});
