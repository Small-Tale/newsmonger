import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StateResp, TopicSuggestion } from '../../src/api/schemas.js';
import { updateProviderSettings } from '../../src/client/api.js';
import { appStore } from '../../src/client/stores.js';

/**
 * A provider change drops the suggestions it invalidated (NEWS-258).
 *
 * Settings opens *over* the discovery pane — it sits above it on the Escape
 * ladder — so this sequence is reachable rather than theoretical: get
 * suggestions, open Settings without closing them, change provider, come back.
 * What was on screen is then one model's answer presented under another's name,
 * and the tuner's kept/skipped rounds (FR-24.6) were counted against a list
 * nothing will produce again.
 *
 * Driven through `updateProviderSettings` with a stubbed `fetch` rather than
 * through the browser: the interesting part is *which* changes clear the pane
 * and which leave it alone, and that is four cases chosen by hand.
 */

const BASE_SETTINGS: StateResp['settings'] = {
  checkIntervalMs: 86_400_000,
  highPriorityIntervalMs: 86_400_000,
  provider: 'auto',
  model: '',
  endpoint: '',
  effort: '',
  backupDir: '',
  location: '',
  backupPromptNever: false,
  backupPromptSnoozedUntil: '',
  notifyOnNewItems: false,
  itemRetentionDays: 365,
  scheduleMode: 'interval',
  theme: 'auto',
  dailyTimes: ['08:00'],
  checkConcurrency: 3,
};

function suggestion(name: string): TopicSuggestion {
  return { name, reason: 'because', kind: 'evergreen', guidance: '', classification: null };
}

/**
 * Answer every endpoint the call touches, with `/api/state` reporting the
 * settings the PATCH is taken to have produced.
 *
 * Built on **what the store currently holds**, not on a fixed baseline: the real
 * `/api/state` returns the whole settings object with the unchanged fields
 * intact, and a baseline would instead quietly revert whatever an earlier test
 * changed — which is a signature move of its own, and read as one here.
 *
 * `refreshProviders` and `refreshModels` swallow their own failures, so they need
 * nothing more than valid JSON.
 */
function stubFetch(after: Partial<StateResp['settings']>): void {
  const state = {
    topics: [],
    latestItemIds: [],
    flaggedByTopic: {},
    settings: { ...BASE_SETTINGS, ...appStore.state.value.settings, ...after },
    runs: [],
    checking: [],
    appVersion: '',
  };
  const impl = ((input: string): Promise<Response> => {
    const body = input.startsWith('/api/state') ? state : {};
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response);
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', impl);
}

/** Open the pane and put a list in it, the way a completed query would. */
function openWithSuggestions(): void {
  appStore.actions.openDiscover();
  appStore.actions.patchDiscover({
    view: 'results',
    suggestions: [suggestion('Formula 1'), suggestion('Le Mans')],
    source: { kind: 'describe', query: 'motorsport' },
    added: ['Formula 1'],
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  appStore.actions.closeDiscover();
});

describe('changing the provider clears the suggestions on screen', () => {
  it('drops the list, the tuner state and the added markers', async () => {
    stubFetch({ provider: 'openai' });
    openWithSuggestions();

    await updateProviderSettings({ provider: 'openai' });

    const d = appStore.state.value.discover;
    // Still open — the pane is not closed out from under the user, it is returned
    // to the browse grid a fresh query starts from anyway.
    expect(d).not.toBeNull();
    expect(d?.suggestions).toEqual([]);
    expect(d?.view).toBe('browse');
    expect(d?.tuner).toBeNull();
    expect(d?.added).toEqual([]);
    expect(d?.source).toBeNull();
  });

  it('drops them for a model change and for an effort change too', async () => {
    // Same reasoning as the provider: these are the three fields that change
    // what comes back, which is why the server signs an in-flight check with
    // exactly them (FR-2.11).
    stubFetch({ model: 'gpt-5.4-mini' });
    openWithSuggestions();
    await updateProviderSettings({ model: 'gpt-5.4-mini' });
    expect(appStore.state.value.discover?.suggestions).toEqual([]);

    stubFetch({ effort: 'high' });
    openWithSuggestions();
    await updateProviderSettings({ effort: 'high' });
    expect(appStore.state.value.discover?.suggestions).toEqual([]);
  });

  it('leaves them alone when the save changed none of the three', async () => {
    // Re-saving the same provider, or moving only the endpoint: the model that
    // produced the list is still the model being asked, so throwing the list
    // away would be a cost with nothing bought.
    stubFetch({ endpoint: 'https://gateway.example/v1' });
    openWithSuggestions();

    await updateProviderSettings({ endpoint: 'https://gateway.example/v1' });

    expect(appStore.state.value.discover?.suggestions).toHaveLength(2);
    expect(appStore.state.value.discover?.view).toBe('results');
    expect(appStore.state.value.discover?.added).toEqual(['Formula 1']);
  });

  it('does nothing when the pane is not open', async () => {
    stubFetch({ provider: 'openai' });
    appStore.actions.closeDiscover();

    await updateProviderSettings({ provider: 'openai' });

    // Specifically *not* opened as a side effect of saving a setting.
    expect(appStore.state.value.discover).toBeNull();
  });
});
