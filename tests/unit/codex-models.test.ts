import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  codexModelsCachePath,
  parseCodexEfforts,
  parseCodexModels,
  readCodexModels,
} from '../../src/ai/providers/codex-models.js';
import { tmpDataDir } from '../helpers/tmp.js';

/**
 * Reading the models Codex offers on this machine (NEWS-249).
 *
 * The fixture is a real `~/.codex/models_cache.json`, trimmed to the fields
 * this app reads. That matters for the same reason it did in NEWS-248: the bug
 * being replaced was a hand-written list detached from what the tool actually
 * serves, and a test against an invented cache would be just as detached.
 */
const FIXTURE: unknown = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/codex-models-cache.json'),
    'utf8',
  ),
);

describe('parseCodexModels against a real Codex cache (NEWS-249)', () => {
  it('returns exactly what the CLI would offer, in the CLI’s own order', () => {
    // Ordered by Codex's `priority` so the app agrees with the tool about what
    // comes first, rather than inventing a second opinion.
    expect(parseCodexModels(FIXTURE)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex-spark',
    ]);
  });

  it('honours `visibility: hide`', () => {
    // Not cosmetic: `codex-auto-review` is an internal model Codex lists for
    // its own use, and it sorts *third* by priority — so without this it would
    // sit near the top of the picker, offering the user something never meant
    // to be chosen.
    expect(parseCodexModels(FIXTURE)).not.toContain('codex-auto-review');
  });

  it('offers what neither the static list nor the OpenAI catalogue could', () => {
    // `gpt-5.3-codex-spark` is Codex-only — `GET /v1/models` never lists it —
    // which is the whole reason this cannot reuse the OpenAI enumeration.
    expect(parseCodexModels(FIXTURE)).toContain('gpt-5.3-codex-spark');
  });
});

describe('parseCodexEfforts (NEWS-249)', () => {
  it('reads the levels a model actually accepts', () => {
    // They differ per model, which the single global effort list cannot express:
    // `gpt-5.6-sol` takes six levels, `gpt-5.4` four.
    expect(parseCodexEfforts(FIXTURE, 'gpt-5.6-sol')).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(parseCodexEfforts(FIXTURE, 'gpt-5.4')).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('answers empty for a model it has never heard of', () => {
    expect(parseCodexEfforts(FIXTURE, 'no-such-model')).toEqual([]);
  });
});

describe('a cache we do not own is allowed to surprise us', () => {
  // Every one of these must yield "no models" rather than throw. The file
  // belongs to another tool and can change shape whenever it likes; a dropdown
  // is not worth crashing a settings page over.
  it.each([
    ['not an object', 42],
    ['null', null],
    ['no models key', { fetched_at: 'now' }],
    ['models not an array', { models: 'gpt-5' }],
    ['entries not objects', { models: ['gpt-5', 7] }],
    ['entries without a slug', { models: [{ display_name: 'GPT' }] }],
    ['an empty slug', { models: [{ slug: '' }] }],
  ])('%s', (_label, body) => {
    expect(parseCodexModels(body)).toEqual([]);
  });

  it('keeps the good entries when only some are malformed', () => {
    // Partial garbage should cost the garbage, not the catalogue.
    expect(parseCodexModels({ models: [{ slug: 'good', priority: 1 }, 7, { display_name: 'no slug' }] })).toEqual([
      'good',
    ]);
  });

  it('sorts an unranked model last rather than dropping it', () => {
    // A model Codex ships without a priority is still a model Codex ships.
    expect(parseCodexModels({ models: [{ slug: 'unranked' }, { slug: 'first', priority: 1 }] })).toEqual([
      'first',
      'unranked',
    ]);
  });
});

describe('readCodexModels', () => {
  const saved = process.env['CODEX_HOME'];
  afterEach(() => {
    if (saved === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = saved;
  });

  it('reads a cache from disk', () => {
    const dir = tmpDataDir();
    const file = path.join(dir, 'models_cache.json');
    fs.writeFileSync(file, JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', priority: 1 }] }));
    expect(readCodexModels(file)).toEqual(['gpt-5.6-sol']);
  });

  it('answers empty when Codex has never run here', () => {
    // Not installed, or installed and never used. Both are ordinary, and both
    // must leave the picker on its static suggestions.
    expect(readCodexModels(path.join(tmpDataDir(), 'nothing.json'))).toEqual([]);
  });

  it('answers empty on a corrupt file rather than throwing', () => {
    const file = path.join(tmpDataDir(), 'models_cache.json');
    fs.writeFileSync(file, '{ this is not json');
    expect(readCodexModels(file)).toEqual([]);
  });

  it('follows CODEX_HOME, which moves the whole directory', () => {
    process.env['CODEX_HOME'] = '/somewhere/else';
    expect(codexModelsCachePath()).toBe(path.join('/somewhere/else', 'models_cache.json'));
    delete process.env['CODEX_HOME'];
    expect(codexModelsCachePath('/Users/x')).toBe(path.join('/Users/x', '.codex', 'models_cache.json'));
  });
});
