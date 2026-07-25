import { defineStore } from 'kerfjs';

import type { KeysResp, ProviderInfo, StateResp } from '../api/schemas.js';

export interface AppState {
  loaded: boolean;
  /** Last error shown in the banner, or null. */
  error: string | null;
  topics: StateResp['topics'];
  items: StateResp['items'];
  settings: StateResp['settings'];
  runs: StateResp['runs'];
  checking: string[];
  /** Provider list + availability (fetched on demand, not every poll). */
  providers: ProviderInfo[];
  /** Whether the settings dialog is open. */
  settingsOpen: boolean;
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
  /** Currently selected topic ids. Selection is transient — never persisted. */
  selectedTopicIds: string[];
  /** When true, the feed shows only bookmarked stories (NEWS-42). Ephemeral. */
  savedFilter: boolean;
  /** Live feed search query (NEWS-60). Ephemeral, composes with Solo/Saved. */
  searchQuery: string;
  /**
   * Topics that are solo'd: when non-empty, the feed shows only their stories.
   *
   * Deliberately in-memory and cleared on reload. A solo that survived a
   * restart would silently hide news days later, and "the app stopped finding
   * anything" is a much worse failure than re-applying a filter.
   */
  soloTopicIds: string[];
  /** Open topic context menu, positioned in viewport coordinates. */
  contextMenu: { x: number; y: number; topicIds: string[] } | null;
  /** Open story context menu (bookmark / share / flag), viewport coords (NEWS-61). */
  itemMenu: { x: number; y: number; itemId: string } | null;
  /**
   * Ids of stories flagged off-topic **this session** (NEWS-61). A just-flagged
   * story stays visible as a dimmed one-liner so the user can undo a mistake;
   * on reload this set is empty, so flagged stories are simply hidden.
   */
  recentlyFlagged: string[];
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
  /** True when the user tried to enable notifications but permission was refused. */
  notifyPermissionDenied: boolean;
  /**
   * Whether the "checks are falling behind" banner has been dismissed this
   * session (NEWS-59). Informational, so a plain session-level dismiss — it
   * reappears on reload if the condition persists.
   */
  dismissedBehind: boolean;
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
 * Persisted per device rather than in `data.json`: how you've sized your own
 * window is a view preference, not something that belongs in the shared data
 * file alongside topics and stories.
 */
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
    items: [],
    settings: { checkIntervalMs: 24 * 60 * 60 * 1000, highPriorityIntervalMs: 24 * 60 * 60 * 1000, provider: 'auto', model: '', endpoint: '', notifyOnNewItems: false },
    runs: [],
    checking: [],
    providers: [],
    settingsOpen: false,
    keys: [],
    keysLoaded: false,
    keychainAvailable: false,
    keychainLabel: 'system keychain',
    keyError: null,
    sidebarCollapsed: readSidebarCollapsed(),
    selectedTopicIds: [],
    savedFilter: false,
    searchQuery: '',
    soloTopicIds: [],
    contextMenu: null,
    itemMenu: null,
    recentlyFlagged: [],
    reviewTopicIds: [],
    confirm: null,
    notifyPermissionDenied: false,
    dismissedRunId: readDismissedRunId(),
    dismissedBehind: false,
    toast: null,
  }),
  actions: (set, get) => ({
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
    setSolo: (soloTopicIds: string[]) => {
      set({ ...get(), soloTopicIds });
    },
    setSavedFilter: (savedFilter: boolean) => {
      set({ ...get(), savedFilter });
    },
    setSearchQuery: (searchQuery: string) => {
      set({ ...get(), searchQuery });
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
    markRecentlyFlagged: (id: string) => {
      const s = get();
      if (s.recentlyFlagged.includes(id)) return;
      set({ ...s, recentlyFlagged: [...s.recentlyFlagged, id] });
    },
    setReviewTopicIds: (reviewTopicIds: string[]) => {
      set({ ...get(), reviewTopicIds });
    },
    openConfirm: (confirm: { message: string; confirmLabel: string; danger: boolean }) => {
      set({ ...get(), confirm });
    },
    closeConfirm: () => {
      set({ ...get(), confirm: null });
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
