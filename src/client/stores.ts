import { defineStore } from 'kerfjs';

import type { ProviderInfo, StateResp } from '../api/schemas.js';

export interface AppState {
  loaded: boolean;
  /** Last error shown in the banner, or null. */
  error: string | null;
  topics: StateResp['topics'];
  items: StateResp['items'];
  settings: StateResp['settings'];
  runs: StateResp['runs'];
  checking: string[];
  /** Whether the selected provider searches the live web. */
  searchesWeb: boolean;
  /** Provider list + availability (fetched on demand, not every poll). */
  providers: ProviderInfo[];
}

export const appStore = defineStore({
  initial: (): AppState => ({
    loaded: false,
    error: null,
    topics: [],
    items: [],
    settings: { checkIntervalMs: 24 * 60 * 60 * 1000, provider: 'auto', model: '', endpoint: '', searchProvider: 'none' },
    runs: [],
    checking: [],
    searchesWeb: true,
    providers: [],
  }),
  actions: (set, get) => ({
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
