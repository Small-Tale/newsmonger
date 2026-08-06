import { defineStore } from 'kerfjs';

import type { Effort } from '../ai/types.js';
import type {
  BackupPreview,
  ItemsResp,
  KeysResp,
  ProviderInfo,
  StateResp,
  ThreadSummary,
  TopicSuggestion,
} from '../api/schemas.js';
import type { BackupLocation } from '../backup-locations.js';
import type { TunerState } from './discover.js';
import type { ExportChoice } from './export-url.js';

type NewsItem = ItemsResp['items'][number];

/**
 * One story's thread timeline as the pane knows it (NEWS-282).
 *
 * A three-state union rather than `items | null` plus flags: "asked and waiting",
 * "asked and failed" and "have it" are what the pane draws, and a shape that
 * cannot express them separately is a shape that renders an empty timeline while
 * a request is still in flight.
 */
export type ThreadPane =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; items: NewsItem[]; size: number };

/** How many stories the feed reveals per "Show more" page (NEWS-62). */
export const FEED_PAGE = 100;

/** Sidebar ordering options (NEWS-63). */
export type TopicSort = 'alpha' | 'added' | 'recent' | 'priority' | 'category';
export const TOPIC_SORTS: readonly TopicSort[] = ['alpha', 'added', 'recent', 'priority', 'category'];
export const TOPIC_SORT_LABELS: Record<TopicSort, string> = {
  alpha: 'A → Z',
  added: 'Recently added',
  recent: 'Newest stories',
  priority: 'Priority first',
  category: 'By section',
};

/** Steps of the first-run flow, in order (NEWS-78). */
/**
 * The check-interval presets, in the order the pickers offer them.
 *
 * Here rather than in `app.tsx` because **two views render it** (NEWS-297):
 * Settings → Schedule and onboarding's Schedule step. Its sibling
 * `RETENTION_OPTIONS` stays in `app.tsx`, which is not an inconsistency — only
 * Settings shows that one, and a constant moves when it is shared, not when a
 * neighbour moves.
 */
export const INTERVAL_OPTIONS: { label: string; ms: number }[] = [
  { label: 'Every hour', ms: 60 * 60 * 1000 },
  { label: 'Every 3 hours', ms: 3 * 60 * 60 * 1000 },
  { label: 'Every 6 hours', ms: 6 * 60 * 60 * 1000 },
  { label: 'Every 12 hours', ms: 12 * 60 * 60 * 1000 },
  { label: 'Every day', ms: 24 * 60 * 60 * 1000 },
  { label: 'Every 2 days', ms: 48 * 60 * 60 * 1000 },
  { label: 'Every week', ms: 7 * 24 * 60 * 60 * 1000 },
];

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

/**
 * Where a result list came from, for the heading and for re-running it.
 *
 * Kept as the *request* rather than a rendered string so the pane can re-ask
 * without reconstructing what was asked — which is what a "try again" after a
 * provider failure needs.
 */
export type DiscoverSource =
  | { kind: 'describe'; query: string }
  | { kind: 'section'; category: string; subcategory: string | null };

/** The discovery dialog's state (NEWS-126, `docs/24-topic-discovery.md`). */
export interface DiscoverState {
  /**
   * Which pane is showing. `browse` is the section grid, `results` the cards.
   * Both doors produce `results`, which is the point — neither is primary.
   */
  view: 'browse' | 'results';
  /** The section being drilled into, or null for the 11-tile grid. */
  section: string | null;
  /** Current contents of the free-text box. */
  query: string;
  loading: boolean;
  /**
   * A "More" request is in flight (NEWS-136).
   *
   * Separate from `loading` because the two replace different things: `loading`
   * swaps the whole pane for a status line, while asking for more must leave the
   * list the user is reading exactly where it is.
   */
  loadingMore: boolean;
  /**
   * The last "More" returned nothing new, so stop offering it.
   *
   * Every press is a billable call, so an exhausted seam has to be visible
   * rather than something the user discovers by pressing repeatedly.
   */
  exhausted: boolean;
  error: string | null;
  suggestions: TopicSuggestion[];
  /** What produced the current results, for the heading and for retrying. */
  source: DiscoverSource | null;
  /** True when the last answer came free from the cache (FR-24.15). */
  cached: boolean;
  /**
   * The keep/skip tuner (NEWS-127), or null when not tuning.
   *
   * Nested inside the discovery state rather than beside it: the tuner is a
   * *depth control* reached from a result list, never an entry point, and
   * closing the dialog must end it. A sibling field would allow a tuner that
   * outlives the list it came from, which is the shape variation B was rejected
   * for in the first place.
   */
  tuner: TunerState | null;
  /**
   * Names added during this dialog session.
   *
   * The card shows "Added" rather than vanishing: a row disappearing under the
   * cursor as you click down a list is how the *next* one gets clicked by
   * accident. They also can't simply be re-filtered out of `suggestions`,
   * because the server's exclusion list is what it was when the call was made.
   */
  added: string[];
}

export function emptyDiscover(): DiscoverState {
  return {
    view: 'browse',
    section: null,
    query: '',
    loading: false,
    loadingMore: false,
    exhausted: false,
    error: null,
    suggestions: [],
    source: null,
    cached: false,
    tuner: null,
    added: [],
  };
}

/**
 * A toast, and optionally the one thing it lets you do about it (NEWS-145).
 *
 * The action is a **topic id, not a callback**: state here is serialised into
 * the render and diffed, and a function in it would survive neither. There is
 * exactly one actionable toast in the app, so naming its subject beats a generic
 * action shape that would need a registry to interpret.
 */
export interface ToastState {
  message: string;
  /** Topic whose cleared stories are still restorable, or null for a plain toast. */
  undoTopicId: string | null;
}

export interface AppState {
  loaded: boolean;
  /** Last error shown in the banner, or null. */
  error: string | null;
  topics: StateResp['topics'];
  /** The current feed page, fetched from `/api/items` for the active view (NEWS-76). */
  feedItems: NewsItem[];
  /** Total stories matching the active view, from the server — drives "Show more". */
  feedTotal: number;
  /**
   * Thread shape per story id for the current feed page (NEWS-282), keyed by
   * **story** id: position, size, and when the subject first appeared.
   *
   * Arrives with the page rather than being fetched per card — three numbers a
   * story wide, and only for stories whose thread holds more than one, so the
   * ordinary feed carries an empty map. It decides whether a card has a thread
   * badge (NEWS-283) *and* whether expanding it has anything to fetch.
   *
   * `| undefined` in the value type because this is read **by key** and most
   * keys are absent — the same shape as `todayByTopic` in `RowRenderState`, and
   * for the same reason: a lookup that cannot express a miss lies about it.
   */
  threads: Record<string, ThreadSummary | undefined>;
  /**
   * The timeline behind each story whose pane has been opened this session
   * (NEWS-282), keyed by story id.
   *
   * A cache, deliberately: collapsing and re-opening a card must not re-ask the
   * server for something it already answered. `size` is what it was fetched at,
   * so a thread that has since grown — the feed poll would show a bigger badge —
   * is refetched rather than served stale. An `error` entry is never reused, so
   * a failure is retried by re-opening the card as well as by the retry button.
   */
  threadPanes: Record<string, ThreadPane | undefined>;
  /**
   * Whether the open pane is showing its whole thread rather than the last
   * `THREAD_ROW_CAP` rows (NEWS-282).
   *
   * One flag rather than a set, because the feed is an accordion: only one pane
   * can be open, so "showing all" can only be true of that one. Opening any card
   * resets it — a cap the previous card's reader lifted is not a preference.
   */
  threadShowAll: boolean;
  /** Off-topic count per topic, for the "Review Flagged (N)" badge (NEWS-76). */
  flaggedByTopic: Record<string, number>;
  /** Stories found today per topic, for the sidebar badge (NEWS-242). */
  todayByTopic: Record<string, number>;
  /** Newest story's `foundAt` per topic, for the most-recent sort (NEWS-241). */
  newestItemAtByTopic: Record<string, string>;
  settings: StateResp['settings'];
  runs: StateResp['runs'];
  checking: string[];
  /** App version, for the diagnostics bundle (NEWS-88). */
  appVersion: string;
  /**
   * When scheduled checking last became possible (NEWS-247). The falling-behind
   * banner measures lateness from here, so time the app was not permitted to
   * check — backgrounded with a subscription provider, or rate-limited — is not
   * counted against it.
   */
  checksPossibleSince: string;
  /** Whether a copied diagnostics bundle includes topic names (NEWS-88). */
  /** Provider list + availability (fetched on demand, not every poll). */
  providers: ProviderInfo[];
  /**
   * Models the configured provider actually offers, newest first (NEWS-248).
   * Empty means "not fetched, or the provider cannot say" — the picker falls
   * back to the static `PROVIDER_MODELS` suggestions.
   */
  liveModels: string[];
  /**
   * Effort levels the configured provider *and model* accept.
   *
   * Three states (NEWS-254): a list is what to offer, `null` is "not fetched,
   * or could not ask" — offer the whole vocabulary, since a menu with too much
   * is recoverable and one with nothing is broken — and `[]` says this model
   * takes no effort at all, which switches the control off.
   */
  liveEffortLevels: Effort[] | null;
  /**
   * What the configured backup folder holds (NEWS-252). Null means nothing to
   * restore — no folder, or no backup in it — which is a normal state, not an
   * error, so the restore control simply isn't offered.
   */
  backupPreview: BackupPreview | null;
  /** Which settings tab is showing (NEWS-118). Resets to the first on reopen. */
  settingsTab: 'schedule' | 'source' | 'data' | 'app';
  /** Whether the privacy dialog is open (NEWS-121). Ephemeral, like every dialog. */
  privacyOpen: boolean;
  /**
   * The export dialog (NEWS-158, NEWS-160), or null when closed.
   *
   * Scope, topic and format are held together because the export is one choice
   * made in parts — every combination is valid, which is the point of replacing
   * the three fixed buttons that offered three of them.
   */
  export: ExportChoice | null;
  /** Topic discovery (NEWS-126), or null when the dialog is closed. */
  discover: DiscoverState | null;
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
  /**
   * The backup offer (NEWS-230). Null when closed; otherwise the sync folders
   * the server found, which may legitimately be an empty array — a machine with
   * no sync client still gets the offer, just with nothing pre-filled.
   */
  backupOffer: BackupLocation[] | null;
  /**
   * Topics ticked in the onboarding flow, before they're created.
   *
   * Holds both the static starter names and anything picked from the suggestions
   * below them (NEWS-128) — one list, so the running count and the "picking none
   * is fine" wording keep working unchanged, and one toggle handler serves both.
   */
  onboardingTopics: string[];
  /**
   * How many topics existed when onboarding opened (NEWS-146).
   *
   * The Topics step now opens the real discovery dialog, whose Add creates
   * immediately, so the step needs to report topics that already exist as well as
   * ones still only ticked. The difference against `topics.length` is that count.
   * A baseline rather than a literal zero because Settings can reopen onboarding
   * for someone who already has topics.
   */
  onboardingTopicsAtStart: number;
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
  /**
   * Provider whose key is being verified and stored right now, or null (NEWS-156).
   *
   * The Save button was the only sign the app had heard you, and the vendor
   * round-trip that verifies a key (FR-20.9) is not instant. Committing on blur
   * without this would look like nothing happened.
   */
  savingKey: string | null;
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
   * Id of the story whose detail pane is open, or null (NEWS-281).
   *
   * **One at a time — an accordion, not a set.** Two reasons, both about the
   * feed rather than about simplicity: cards lay out in a CSS grid whose rows
   * stretch every card to the tallest on the line (FR-3.37), so a second open
   * pane grows a row that already grew; and the pane is *reading* surface, which
   * is a thing you do to one story at a time. A set would also need a rule for
   * what clears it, and "the story I am reading" clears itself.
   *
   * Ephemeral, like Solo and the filters (`docs/3-ui.md`): every action that
   * replaces the list collapses it, because a pane pinned to a story that is no
   * longer on screen is state nobody can see or dismiss.
   */
  expandedItemId: string | null;
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
  /** Id of the topic being renamed (NEWS-139), or null. Ephemeral, like every dialog. */
  renameTopicId: string | null;
  /**
   * How many stories the topic being renamed has, or null while it is unknown.
   *
   * Fetched when the dialog opens rather than carried on `/api/state`: it is a
   * `GROUP BY` over every story, and `/api/state` is polled every four seconds
   * by every open client. NEWS-75/76 slimmed that payload deliberately, and
   * putting a growing aggregate back on it measurably slowed the settings round
   * trip under a full test suite. The dialog needs one number, once.
   */
  renameItemCount: number | null;
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
  toast: ToastState | null;
  /**
   * Id of the failed check-run whose warning banner the user dismissed. The
   * warning is derived from the runs list (server state), not a piece of
   * dismissable state — so dismissal is remembered by run id. A *different*
   * later failure has a new id and shows again, which is what you want.
   */
  dismissedRunId: string | null;
  /**
   * Version of a desktop update waiting to be installed, or null (NEWS-89).
   *
   * Only ever set inside the Tauri shell — the browser build has nothing to
   * update, so this stays null and the banner never renders.
   */
  updateVersion: string | null;
  /**
   * Whether the update banner has been dismissed this session (NEWS-89).
   *
   * Session-level like `dismissedBehind`, deliberately: an update the user
   * waved off is still worth mentioning next launch, and the banner is the only
   * passive surface telling them a new version exists.
   */
  updateDismissed: boolean;
  /** Progress of the in-place update install, driving the banner's button. */
  updateInstall: UpdateInstallState;
  /** True while a user-initiated update check from Settings is in flight. */
  updateChecking: boolean;
  /**
   * Result of the last Settings update check, or null before the first one.
   *
   * Kept separate from the banner: the banner only ever says an update *exists*,
   * while this line has to be able to say "up to date" and "couldn't check" —
   * answers that are only worth showing to someone who just asked.
   */
  updateCheckMessage: string | null;
}

/**
 * Install progress for a pending update (NEWS-89). `installed` is terminal for
 * this process — the new binary is on disk but only takes effect on restart.
 */
export type UpdateInstallState = 'idle' | 'installing' | 'installed' | 'failed';

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
    threads: {},
    threadPanes: {},
    threadShowAll: false,
    flaggedByTopic: {},
    todayByTopic: {},
    newestItemAtByTopic: {},
    settings: {
      checkIntervalMs: 24 * 60 * 60 * 1000,
      highPriorityIntervalMs: 24 * 60 * 60 * 1000,
      provider: 'auto',
      model: '',
      endpoint: '',
      effort: '',
      backupDir: '',
      backupPromptNever: false,
      backupPromptSnoozedUntil: '',
      notifyOnNewItems: false,
      itemRetentionDays: 365,
      scheduleMode: 'interval',
      theme: 'auto',
      dailyTimes: ['08:00'],
      checkConcurrency: 3,
    },
    runs: [],
    checking: [],
    appVersion: '',
    // Epoch until the first poll answers: "checking has always been possible",
    // which is the pre-NEWS-247 behaviour and the right thing to assume before
    // the server has said otherwise.
    checksPossibleSince: '1970-01-01T00:00:00.000Z',
    providers: [],
    liveModels: [],
    liveEffortLevels: null,
    backupPreview: null,
    settingsTab: 'schedule',
    privacyOpen: false,
    export: null,
    discover: null,
    settingsOpen: false,
    onboarding: 'auto',
    backupOffer: null,
    onboardingTopics: [],
    onboardingTopicsAtStart: 0,
    keys: [],
    keysLoaded: false,
    keychainAvailable: false,
    keychainLabel: 'system keychain',
    keyError: null,
    savingKey: null,
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
    expandedItemId: null,
    recentlyFlaggedItems: [],
    reviewTopicIds: [],
    confirm: null,
    guidanceTopicId: null,
    renameTopicId: null,
    renameItemCount: null,
    notifyPermissionDenied: false,
    dismissedRunId: readDismissedRunId(),
    updateVersion: null,
    updateDismissed: false,
    updateInstall: 'idle',
    updateChecking: false,
    updateCheckMessage: null,
    dismissedBehind: false,
    behindGraceUntil: Date.now() + BEHIND_GRACE_MS,
    toast: null,
  }),
  actions: (set, get) => ({
    setBackupOffer: (backupOffer: BackupLocation[] | null) => {
      set({ ...get(), backupOffer });
    },
    setOnboarding: (onboarding: 'auto' | OnboardingStep | null) => {
      const current = get();
      // Entering the flow snapshots the topic count, so the Topics step can tell
      // "added just now, via discovery" from "already had these" (NEWS-146).
      const entering = current.onboarding === null || current.onboarding === 'auto';
      const onboardingTopicsAtStart =
        entering && onboarding !== null && onboarding !== 'auto'
          ? current.topics.length
          : current.onboardingTopicsAtStart;
      set({ ...current, onboarding, onboardingTopicsAtStart });
    },
    toggleOnboardingTopic: (name: string) => {
      const current = get();
      const chosen = current.onboardingTopics.includes(name)
        ? current.onboardingTopics.filter((t) => t !== name)
        : [...current.onboardingTopics, name];
      set({ ...current, onboardingTopics: chosen });
    },
    setSettingsTab: (settingsTab: AppState['settingsTab']) => {
      set({ ...get(), settingsTab });
    },
    openExport: () => {
      // Always reopens on All + Markdown. A dialog that remembers the last
      // choice is a dialog that exports something different from what the last
      // press did, for a reason nothing on screen explains.
      set({ ...get(), export: { scope: 'all', topicId: null, format: 'md' } });
    },
    closeExport: () => {
      set({ ...get(), export: null });
    },
    patchExport: (patch: Partial<ExportChoice>) => {
      const current = get();
      if (current.export === null) return;
      const next = { ...current.export, ...patch };
      // Choosing "one topic" lands on the first one rather than on nothing, so
      // the option is usable the moment it is picked. Leaving it null would show
      // a picker with no selection and a disabled Export, which reads as broken
      // rather than as waiting.
      if (next.scope === 'topic' && next.topicId === null) next.topicId = current.topics[0]?.id ?? null;
      if (next.scope !== 'topic') next.topicId = null;
      set({ ...current, export: next });
    },
    setPrivacyOpen: (privacyOpen: boolean) => {
      set({ ...get(), privacyOpen });
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
    setSavingKey: (savingKey: string | null) => {
      set({ ...get(), savingKey });
    },
    setKeyError: (keyError: string | null) => {
      set({ ...get(), keyError });
    },
    setSelection: (selectedTopicIds: string[]) => {
      set({ ...get(), selectedTopicIds });
    },
    // The four view-changing actions reset the feed page: a different view is a
    // fresh list, shown from the top (NEWS-62). They also collapse an expanded
    // story (NEWS-281) — the pane belongs to the list being read, and one left
    // open behind a filter change is state with nothing on screen to close it.
    setSolo: (soloTopicIds: string[]) => {
      set({ ...get(), soloTopicIds, feedLimit: FEED_PAGE, expandedItemId: null });
    },
    setCategoryFilter: (categoryFilter: AppState['categoryFilter']) => {
      set({ ...get(), categoryFilter, feedLimit: FEED_PAGE, expandedItemId: null });
    },
    setSavedFilter: (savedFilter: boolean) => {
      set({ ...get(), savedFilter, feedLimit: FEED_PAGE, expandedItemId: null });
    },
    setSearchQuery: (searchQuery: string) => {
      set({ ...get(), searchQuery, feedLimit: FEED_PAGE, expandedItemId: null });
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
    /**
     * Open `id`'s detail pane, or close it if it is the one already open (NEWS-281).
     *
     * Opening a second story closes the first — see `expandedItemId` for why the
     * feed is an accordion rather than a set of open cards.
     */
    toggleItemExpanded: (id: string) => {
      const s = get();
      // `threadShowAll` belongs to the pane being opened, not to the reader, so
      // every open (and every close) starts capped again — see the field.
      set({ ...s, expandedItemId: s.expandedItemId === id ? null : id, threadShowAll: false });
    },
    /**
     * Collapse `id` specifically. A **no-op** when some other story — or none —
     * is expanded, so a caller acting on one card (flagging it off-topic) can't
     * close a pane the user opened on a different one.
     */
    collapseItem: (id: string) => {
      const s = get();
      if (s.expandedItemId !== id) return;
      set({ ...s, expandedItemId: null });
    },
    /** Collapse whatever is expanded (the Escape key). No-op when nothing is. */
    collapseExpandedItem: () => {
      const s = get();
      if (s.expandedItemId === null) return;
      set({ ...s, expandedItemId: null });
    },
    setFeed: (feed: { items: NewsItem[]; total: number; threads: Record<string, ThreadSummary> }) => {
      set({ ...get(), feedItems: feed.items, feedTotal: feed.total, threads: feed.threads });
    },
    /** Record what the thread route said (or that it is still being asked). */
    setThreadPane: (id: string, pane: ThreadPane) => {
      const s = get();
      set({ ...s, threadPanes: { ...s.threadPanes, [id]: pane } });
    },
    /** Lift the row cap on the open pane (NEWS-282). */
    showAllThread: () => {
      set({ ...get(), threadShowAll: true });
    },
    // Hold a just-flagged story (full data) so it can render collapsed even
    // though the server's normal-view page now excludes it (NEWS-76).
    addRecentlyFlagged: (item: NewsItem) => {
      const s = get();
      // Flagging collapses that story's pane (NEWS-281): the card becomes a
      // dimmed one-liner, which has no pane and no expander to close one with.
      const expandedItemId = s.expandedItemId === item.id ? null : s.expandedItemId;
      if (s.recentlyFlaggedItems.some((i) => i.id === item.id)) {
        if (expandedItemId !== s.expandedItemId) set({ ...s, expandedItemId });
        return;
      }
      set({ ...s, expandedItemId, recentlyFlaggedItems: [...s.recentlyFlaggedItems, { ...item, offTopic: true }] });
    },
    removeRecentlyFlagged: (id: string) => {
      const s = get();
      set({ ...s, recentlyFlaggedItems: s.recentlyFlaggedItems.filter((i) => i.id !== id) });
    },
    /**
     * Drop the client-only story state after every story has been cleared
     * (NEWS-291).
     *
     * `refreshState` cannot do this. `recentlyFlaggedItems` is an overlay the
     * *client* owns — full copies of stories flagged this session, merged into
     * the feed so a misclick stays undoable (NEWS-61) — so a server refresh
     * emptying `feedItems` leaves it untouched, and the overlay goes on rendering
     * rows whose database rows are gone. A clear that visibly leaves a story on
     * screen is the same bug this ticket is about, one layer up.
     *
     * Review mode goes with it: it shows only flagged stories, and there are
     * none, so staying in it would strand the user on a permanently empty feed
     * behind a banner.
     *
     * So does the expanded card (NEWS-281) and its thread state (NEWS-282):
     * `expandedItemId` would otherwise name a story that no longer exists. Every
     * other view change in this store already nulls it, and a clear is the most
     * drastic view change there is.
     *
     * `threadPanes` goes too. Its invalidation rule is the thread's **size** — a
     * thread that has grown is refetched — and a clear does not change a size, it
     * removes the thread entirely, so nothing about that rule would ever evict
     * these entries. No visible bug today, because story ids are UUIDs and a new
     * story cannot collide with a cached one; dropped because the store should not
     * go on holding fetched data about stories the user has deleted.
     */
    clearStoryOverlays: () => {
      set({
        ...get(),
        recentlyFlaggedItems: [],
        reviewTopicIds: [],
        feedLimit: FEED_PAGE,
        expandedItemId: null,
        threadShowAll: false,
        threadPanes: {},
      });
    },
    /**
     * The same rule as `clearStoryOverlays`, narrowed to one topic (NEWS-303).
     *
     * The per-topic clear — rename-with-clear, `PATCH /api/topics/:id` — had no
     * cleanup at all, so flagging a story and then clearing that topic left the
     * flagged row rendering over a feed whose database rows were gone. NEWS-273
     * fixed the app-wide clear and left this one; same bug, one topic's worth.
     *
     * **Not `clearStoryOverlays()` with a different name.** A per-topic clear
     * deletes exactly one topic's stories, so dropping every topic's overlay
     * would throw away rows the action did not touch: another topic's
     * just-flagged story, a review of a topic still holding flagged stories, an
     * expanded card belonging to somewhere else. Wiping state an action did not
     * invalidate is the same class of untruth as leaving state it did.
     *
     * Which is why membership is read from `feedItems` and the overlay rather
     * than taken from the server: both carry `topicId`, and the question here is
     * only *which of the stories the client is currently describing belonged to
     * that topic*. `feedLimit` is deliberately **not** reset — the user's "show
     * more" spans every topic, and one topic's clear is no reason to undo it.
     */
    clearStoryOverlaysForTopic: (topicId: string) => {
      const s = get();
      const gone = new Set(
        [...s.feedItems, ...s.recentlyFlaggedItems].filter((i) => i.topicId === topicId).map((i) => i.id),
      );
      const collapsing = s.expandedItemId !== null && gone.has(s.expandedItemId);
      set({
        ...s,
        recentlyFlaggedItems: s.recentlyFlaggedItems.filter((i) => i.topicId !== topicId),
        // Emptying this list is what leaves review mode, which is right when the
        // only topic under review has just lost every story it had to show.
        reviewTopicIds: s.reviewTopicIds.filter((id) => id !== topicId),
        expandedItemId: collapsing ? null : s.expandedItemId,
        threadShowAll: collapsing ? false : s.threadShowAll,
        threadPanes: Object.fromEntries(Object.entries(s.threadPanes).filter(([id]) => !gone.has(id))),
      });
    },
    setReviewTopicIds: (reviewTopicIds: string[]) => {
      set({ ...get(), reviewTopicIds, feedLimit: FEED_PAGE, expandedItemId: null });
    },
    openDiscover: () => {
      set({ ...get(), discover: emptyDiscover() });
    },
    closeDiscover: () => {
      set({ ...get(), discover: null });
    },
    /**
     * Patch the discovery pane.
     *
     * A patch rather than a whole-state setter because every caller changes one
     * or two fields of a six-field object, and a full replace is how the
     * in-flight `loading` flag or the `added` list gets silently reset by an
     * unrelated update. Ignored when the dialog is closed, so a response
     * arriving after the user closed it cannot reopen it.
     */
    patchDiscover: (patch: Partial<DiscoverState>) => {
      const current = get().discover;
      if (current === null) return;
      set({ ...get(), discover: { ...current, ...patch } });
    },
    openConfirm: (confirm: { message: string; confirmLabel: string; danger: boolean }) => {
      set({ ...get(), confirm });
    },
    closeConfirm: () => {
      set({ ...get(), confirm: null });
    },
    openRename: (renameTopicId: string) => {
      set({ ...get(), renameTopicId, renameItemCount: null });
    },
    setRenameItemCount: (renameItemCount: number) => {
      set({ ...get(), renameItemCount });
    },
    closeRename: () => {
      set({ ...get(), renameTopicId: null, renameItemCount: null });
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
    /**
     * Record a pending update (NEWS-89). Re-announcing the *same* version leaves
     * a dismissal alone; a newer version un-dismisses, since it's news again.
     */
    setUpdateVersion: (updateVersion: string | null) => {
      const prev = get();
      if (prev.updateVersion === updateVersion) return;
      set({ ...prev, updateVersion, updateDismissed: false, updateInstall: 'idle' });
    },
    dismissUpdate: () => {
      set({ ...get(), updateDismissed: true });
    },
    setUpdateInstall: (updateInstall: UpdateInstallState) => {
      set({ ...get(), updateInstall });
    },
    setUpdateChecking: (updateChecking: boolean) => {
      set({ ...get(), updateChecking, updateCheckMessage: updateChecking ? null : get().updateCheckMessage });
    },
    setUpdateCheckMessage: (updateCheckMessage: string | null) => {
      set({ ...get(), updateChecking: false, updateCheckMessage });
    },
    bumpBehindGrace: () => {
      set({ ...get(), behindGraceUntil: Date.now() + BEHIND_GRACE_MS });
    },
    /**
     * Set the toast text with **no dismiss timer** (NEWS-141).
     *
     * Named `raw` because calling it directly is almost always a bug: the timer
     * lives in `showToast` in `app.tsx`, so a direct call puts a message on
     * screen and leaves it there. Use `showToast` unless you are it.
     */
    setToastRaw: (toast: ToastState | null) => {
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
    setBackupPreview: (backupPreview: BackupPreview | null) => {
      set({ ...get(), backupPreview });
    },
    setLiveModels: (liveModels: string[], liveEffortLevels: Effort[] | null) => {
      set({ ...get(), liveModels, liveEffortLevels });
    },
    setError: (error: string | null) => {
      set({ ...get(), error });
    },
  }),
});
