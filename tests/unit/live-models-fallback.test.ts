import { afterEach, describe, expect, it, vi } from 'vitest';

import { PROVIDER_MODELS } from '../../src/ai/types.js';
import { refreshModels } from '../../src/client/api.js';
import { appStore } from '../../src/client/stores.js';

/**
 * The model picker's live-vs-static fallback, across a *sequence* (NEWS-361).
 *
 * `settings.tsx` chooses with `liveModels.length > 0 ? liveModels : PROVIDER_MODELS[provider]`,
 * so "which list am I looking at" is a piece of state, and the interesting
 * question is not any one fetch but what happens across several: the vendor is
 * down, then up, then down again.
 *
 * The audit that produced NEWS-361 found every fallback in the codebase tested
 * one-way — fallback engaged, once, with the world held still. The code here
 * turned out to be right; nothing asserted it. A later failure resetting to
 * `[]` is the half most likely to be "optimised" away by someone who reads it
 * as a redundant write, and stale live models would then be shown as though
 * they had just been fetched.
 */

function stubFetch(sequence: unknown[]): void {
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      const next = sequence[Math.min(i++, sequence.length - 1)];
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(next) });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  appStore.actions.setLiveModels([], null);
});

describe('live models fall back and come back (NEWS-361)', () => {
  it('shows the static list when the catalogue cannot be fetched', async () => {
    stubFetch([new Error('vendor down')]);
    await refreshModels();
    expect(appStore.state.value.liveModels).toEqual([]);
    // Empty is what makes the picker use `PROVIDER_MODELS`; assert the premise
    // rather than only the value, so this still means something if the
    // selection rule moves.
    expect(PROVIDER_MODELS['anthropic'].length).toBeGreaterThan(0);
  });

  it('switches to the live list once the fetch succeeds', async () => {
    stubFetch([new Error('vendor down'), { models: ['claude-opus-9'], effortLevels: null }]);

    await refreshModels();
    expect(appStore.state.value.liveModels).toEqual([]);

    await refreshModels();
    expect(appStore.state.value.liveModels).toEqual(['claude-opus-9']);
  });

  it('goes back to static when a later fetch fails, rather than serving a stale list', async () => {
    // The edge that matters most. Keeping the previous answer would show models
    // the vendor may have retired, with nothing on screen saying it is old.
    stubFetch([{ models: ['claude-opus-9'], effortLevels: null }, new Error('vendor down')]);

    await refreshModels();
    expect(appStore.state.value.liveModels).toEqual(['claude-opus-9']);

    await refreshModels();
    expect(appStore.state.value.liveModels).toEqual([]);
  });

  it('survives down → up → down → up', async () => {
    stubFetch([
      new Error('down'),
      { models: ['a'], effortLevels: null },
      new Error('down again'),
      { models: ['b'], effortLevels: null },
    ]);
    const seen: string[][] = [];
    for (let i = 0; i < 4; i++) {
      await refreshModels();
      seen.push([...appStore.state.value.liveModels]);
    }
    expect(seen).toEqual([[], ['a'], [], ['b']]);
  });

  it('drops the effort levels with the models, not separately', async () => {
    // They are read together by the picker; a failure that cleared one and kept
    // the other would offer levels for a model list that is no longer shown.
    stubFetch([{ models: ['a'], effortLevels: ['low', 'high'] }, new Error('down')]);

    await refreshModels();
    expect(appStore.state.value.liveEffortLevels).toEqual(['low', 'high']);

    await refreshModels();
    expect(appStore.state.value.liveEffortLevels).toBeNull();
  });
});
