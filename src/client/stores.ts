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
  keychainAvailable: boolean;
  keychainLabel: string;
  /** Error shown inside the dialog, kept separate from the page banner. */
  keyError: string | null;
}


export const appStore = defineStore({
  initial: (): AppState => ({
    loaded: false,
    error: null,
    topics: [],
    items: [],
    settings: { checkIntervalMs: 24 * 60 * 60 * 1000, provider: 'auto', model: '', endpoint: '' },
    runs: [],
    checking: [],
    providers: [],
    settingsOpen: false,
    keys: [],
    keychainAvailable: false,
    keychainLabel: 'system keychain',
    keyError: null,
  }),
  actions: (set, get) => ({
    setSettingsOpen: (settingsOpen: boolean) => {
      set({ ...get(), settingsOpen, keyError: null });
    },
    setKeys: (resp: KeysResp) => {
      set({ ...get(), keys: resp.keys, keychainAvailable: resp.keychainAvailable, keychainLabel: resp.keychainLabel });
    },
    setKeyError: (keyError: string | null) => {
      set({ ...get(), keyError });
    },
    update: (partial: Partial<AppState>) => {
      set({ ...get(), ...partial });
    },
    setState: (state: StateResp) => {
      set({ ...get(), loaded: true, ...state });
    },
    setProviders: (providers: ProviderInfo[]) => {
      set({ ...get(), providers });
    },
    setError: (error: string | null) => {
      set({ ...get(), error });
    },
  }),
});
