import { defineStore } from 'kerfjs';

import type { StateResp } from '../api/schemas.js';

export interface AppState {
  loaded: boolean;
  /** Last error shown in the banner, or null. */
  error: string | null;
  topics: StateResp['topics'];
  items: StateResp['items'];
  settings: StateResp['settings'];
  runs: StateResp['runs'];
  checking: string[];
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
  }),
  actions: (set, get) => ({
    update: (partial: Partial<AppState>) => {
      set({ ...get(), ...partial });
    },
    setState: (state: StateResp) => {
      set({ ...get(), loaded: true, ...state });
    },
    setError: (error: string | null) => {
      set({ ...get(), error });
    },
  }),
});
