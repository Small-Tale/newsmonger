import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  codexModelsCachePath,
  parseCodexEfforts,
  parseCodexModels,
  readCodexEfforts,
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

describe('a cache shape we did not expect (NEWS-360)', () => {
  /**
   * `~/.codex/models_cache.json` is written by the **vendor**, and its shape has
   * already changed under this project twice (NEWS-272/274). The module's own
   * doc promises "any shape that is not what we expect yields no models rather
   * than an error" — that promise was kept by `readCodexModels` and broken by
   * `readCodexEfforts`, because the parse asserted the shape with a double cast
   * and the `try` closed before the parse ran.
   *
   * Each case below is a shape a vendor could plausibly ship. None may throw.
   */
  const CASES: [string, unknown][] = [
    ['reasoning levels as an object, not an array', { models: [{ slug: 'a', supported_reasoning_levels: { effort: 'high' } }] }],
    ['level entries as bare strings', { models: [{ slug: 'a', supported_reasoning_levels: ['high', 'low'] }] }],
    ['priority as a string', { models: [{ slug: 'a', priority: '2' }] }],
    ['visibility as a number', { models: [{ slug: 'a', visibility: 1 }] }],
    ['models not an array', { models: 'nope' }],
    ['no models key at all', { other: true }],
    ['a null entry', { models: [null] }],
    ['body is an array', [{ slug: 'a' }]],
    ['body is a string', 'nope'],
  ];

  it.each(CASES)('%s: parses to empty rather than throwing', (_label, body) => {
    expect(() => parseCodexModels(body)).not.toThrow();
    expect(() => parseCodexEfforts(body, 'a')).not.toThrow();
    expect(parseCodexEfforts(body, 'a')).toEqual([]);
  });

  it('keeps the good models when one entry is malformed', () => {
    // Per-entry parsing, not one `z.array` over the lot: a single bad row must
    // not cost the user the rest of their catalogue.
    expect(parseCodexModels({ models: [{ slug: 'ok1' }, 42, { slug: 'ok2' }] })).toEqual(['ok1', 'ok2']);
  });

  it('sorts an unusable priority last instead of returning NaN', () => {
    // `(a.priority ?? MAX) - (b.priority ?? MAX)` with a string priority yields
    // NaN, and a NaN comparator does not fail — it orders arbitrarily, which is
    // the kind of bug that is only ever noticed as "the list looks wrong".
    expect(parseCodexModels({ models: [{ slug: 'unranked', priority: '2' }, { slug: 'first', priority: 1 }] })).toEqual([
      'first',
      'unranked',
    ]);
  });

  it('reads efforts from a file of any shape without throwing (NEWS-360)', () => {
    // The asymmetry itself: `readCodexEfforts` threw where `readCodexModels`
    // returned `[]`, because its `try` wrapped only the read.
    const dir = tmpDataDir();
    const file = path.join(dir, 'models_cache.json');
    for (const [, body] of CASES) {
      fs.writeFileSync(file, JSON.stringify(body));
      expect(() => readCodexEfforts('a', file)).not.toThrow();
      expect(() => readCodexModels(file)).not.toThrow();
    }
    // And an unreadable file is still `[]`, not a throw.
    expect(readCodexEfforts('a', path.join(dir, 'absent.json'))).toEqual([]);
  });
});
