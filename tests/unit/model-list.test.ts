import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { CatalogueModel } from '../../src/ai/model-list.js';
import { MODEL_SUGGESTION_LIMIT, rankModels } from '../../src/ai/model-list.js';

/**
 * Ranking a vendor catalogue into model suggestions (NEWS-248).
 *
 * The fixture is **131 real entries** from `GET /v1/models`, captured with a
 * live key. That matters: the bug this replaces was a hardcoded array that had
 * drifted two and a half generations behind, and a test written against an
 * invented catalogue would have been just as detached from what OpenAI actually
 * serves.
 */
const CATALOGUE = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/openai-models.json'),
    'utf8',
  ),
) as CatalogueModel[];

describe('rankModels against a real OpenAI catalogue (NEWS-248)', () => {
  it('puts the current frontier at the top, from `created` alone', () => {
    // The whole point: this ordering comes from a timestamp the vendor
    // maintains, not from anything this repo knows about model naming. When
    // OpenAI ships gpt-5.7 it arrives here on its own.
    expect(rankModels(CATALOGUE).slice(0, 3)).toEqual(['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol']);
  });

  it('offers what the hardcoded list was missing', () => {
    // The array this replaces was `['gpt-5', 'gpt-5-mini', 'o3', 'o4-mini']`.
    const top = rankModels(CATALOGUE);
    for (const id of ['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']) {
      expect(top, `${id} should be suggested`).toContain(id);
    }
  });

  it('drops the families that are not text models', () => {
    const top = rankModels(CATALOGUE, 200);
    for (const noise of ['tts-1', 'whisper-1', 'dall-e-3', 'babbage-002', 'gpt-transcribe']) {
      expect(top, `${noise} should not be suggested`).not.toContain(noise);
    }
    // Sharper than "the list is shorter": `gpt-realtime-2.1` is *newer* than
    // every gpt-5.6 model, so without the filter it would lead the dropdown.
    expect(top.some((id) => id.includes('realtime'))).toBe(false);
  });

  it('keeps the tracking id and drops its dated snapshots', () => {
    const top = rankModels(CATALOGUE, 200);
    expect(top).toContain('gpt-5.4');
    expect(top).not.toContain('gpt-5.4-2026-03-05');
    expect(top.filter((id) => /-\d{4}-\d{2}-\d{2}$/.test(id))).toEqual([]);
  });

  it('returns no duplicates and respects the limit', () => {
    const top = rankModels(CATALOGUE);
    expect(top).toHaveLength(MODEL_SUGGESTION_LIMIT);
    expect(new Set(top).size).toBe(top.length);
  });
});

describe('rankModels edge cases', () => {
  it('sorts a model with no timestamp last rather than dropping it', () => {
    // Absent metadata is not evidence a model is bad, and inferring quality
    // from an id is the exact habit this module exists to break.
    const ranked = rankModels([{ id: 'mystery' }, { id: 'new', created: 2000 }, { id: 'old', created: 1000 }]);
    expect(ranked).toEqual(['new', 'old', 'mystery']);
  });

  it('handles an empty or fully-filtered catalogue', () => {
    // A caller gets [] and falls back to the static list; it must not throw on
    // a key whose catalogue is all image models, or on an outage returning none.
    expect(rankModels([])).toEqual([]);
    expect(rankModels([{ id: 'dall-e-3', created: 1 }])).toEqual([]);
  });

  it('does not mutate the caller’s array', () => {
    // It sorts, and the caller may well be holding the SDK's own page data.
    const input: CatalogueModel[] = [
      { id: 'a', created: 1 },
      { id: 'b', created: 2 },
    ];
    rankModels(input);
    expect(input.map((m) => m.id)).toEqual(['a', 'b']);
  });
});
