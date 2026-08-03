import { describe, expect, it } from 'vitest';

import { NEWS_JSON_SCHEMA } from '../../src/ai/prompt.js';
import { SUGGEST_JSON_SCHEMA } from '../../src/ai/suggest-prompt.js';

/**
 * The JSON schemas satisfy OpenAI **strict** structured outputs (NEWS-272).
 *
 * `NEWS_JSON_SCHEMA` declared `outlet` and `publishedAt` on a source, and
 * `category`/`subcategory` at the top level, without listing them in `required`.
 * Anthropic tolerates that; OpenAI's strict mode does not, and every Codex check
 * died on it:
 *
 *   invalid_json_schema: Invalid schema for response_format
 *   'codex_output_schema': In context=('properties','items','items',
 *   'properties','sources','items'), 'required' is required to be supplied and
 *   to be an array including every key in properties. Missing 'outlet'.
 *
 * **Three instances, and only one was reported.** Fixing the sources object would
 * have moved the same 400 up to the top level on the next run; and writing the
 * rule instead of patching the reported path immediately turned up a third in
 * `SUGGEST_JSON_SCHEMA`, which would have broken every Codex *discovery* call the
 * same way. That third one is the argument for the whole file: it was found here
 * rather than by a second live 400 on someone's subscription.
 *
 * This is a *rule*, not a snapshot: it holds whatever fields anyone adds later,
 * which is the failure mode here — all three defects were introduced by adding a
 * property and forgetting the second half of the edit. Optionality in strict mode
 * is expressed by a **nullable type**, never by omission from `required`, so a new
 * optional field needs `type: ['x', 'null']` and its name in `required`.
 *
 * Cheap and offline, which matters: the alternative is finding out from a live 400
 * on someone's subscription.
 */

type Node = Record<string, unknown>;

/** Every object node in a schema, with a readable path to it. */
function objectNodes(node: unknown, path: string, out: { path: string; node: Node }[] = []): { path: string; node: Node }[] {
  if (typeof node !== 'object' || node === null) return out;
  const n = node as Node;
  if (n['type'] === 'object' && typeof n['properties'] === 'object') out.push({ path, node: n });
  for (const [key, value] of Object.entries(n)) {
    if (key === 'items' || key === 'properties') {
      // `items` is a schema; `properties` is a map of them.
      if (key === 'properties') {
        for (const [prop, sub] of Object.entries(value as Node)) objectNodes(sub, `${path}.${prop}`, out);
      } else {
        objectNodes(value, `${path}[]`, out);
      }
    }
  }
  return out;
}

const SCHEMAS: [string, unknown][] = [
  ['NEWS_JSON_SCHEMA', NEWS_JSON_SCHEMA],
  ['SUGGEST_JSON_SCHEMA', SUGGEST_JSON_SCHEMA],
];

describe('strict structured-output invariants', () => {
  it.each(SCHEMAS)('%s lists every declared property in required', (_name, schema) => {
    const nodes = objectNodes(schema, '$');
    // Guard against a vacuous pass: a walker that finds nothing would assert
    // nothing, and this rule is only worth having if it is actually looking.
    expect(nodes.length).toBeGreaterThan(0);

    for (const { path, node } of nodes) {
      const declared = Object.keys(node['properties'] as Node).sort();
      const required = [...((node['required'] as string[] | undefined) ?? [])].sort();
      expect(required, `${path}: required must name every declared property`).toEqual(declared);
    }
  });

  it.each(SCHEMAS)('%s marks every object closed, which strict mode also demands', (_name, schema) => {
    for (const { path, node } of objectNodes(schema, '$')) {
      expect(node['additionalProperties'], `${path}: must set additionalProperties: false`).toBe(false);
    }
  });

  it('expresses optionality as a nullable type, not as omission', () => {
    // The fields that bit us. Each is genuinely optional — a model often cannot
    // tell an outlet or a date, and classification is only sometimes asked for —
    // so each must be nullable *and* required.
    const source = (NEWS_JSON_SCHEMA.properties.items.items.properties.sources.items.properties) as Record<
      string,
      { type: unknown }
    >;
    expect(source['outlet'].type).toEqual(['string', 'null']);
    expect(source['publishedAt'].type).toEqual(['string', 'null']);
    expect(NEWS_JSON_SCHEMA.properties.category.type).toEqual(['string', 'null']);
    expect(NEWS_JSON_SCHEMA.properties.subcategory.type).toEqual(['string', 'null']);
  });
});
