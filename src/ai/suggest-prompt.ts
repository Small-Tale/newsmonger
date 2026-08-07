import { z } from 'zod';

import { stripMarkup } from './sanitize.js';
import type { SuggestRequest, SuggestScope, TopicSuggestion } from './types.js';

/**
 * Prompting for topic *discovery* (NEWS-116), kept out of `prompt.ts` because
 * it asks a different question: `prompt.ts` asks "what is new about X", this
 * asks "what might you want to follow at all".
 */

/** Cap on how many suggestions a single call returns, whatever the caller asks. */
export const MAX_SUGGESTIONS = 12;
const DEFAULT_SUGGESTIONS = 8;

/** Cap on the keep/skip history sent back — the recent signal is the useful one. */
const MAX_TUNE_HISTORY = 20;

const SuggestionSchema = z.object({
  // Models emit citation markup inside these strings even when asked not to;
  // strip it here so nothing downstream has to know that (see `sanitize.ts`).
  name: z.string().min(1).transform(stripMarkup),
  reason: z.string().min(1).transform(stripMarkup),
  // A malformed kind degrades to `evergreen` rather than failing the parse and
  // losing the whole batch. Evergreen is the safer default of the two: labelling
  // a burning-out story as standing merely disappoints later, where the reverse
  // tells the user a good topic will go quiet when it won't.
  kind: z.enum(['ongoing', 'evergreen']).catch('evergreen'),
  guidance: z
    .string()
    .transform(stripMarkup)
    .nullish()
    .catch(null)
    .transform((v) => v ?? ''),
  // Not checked against the taxonomy here — this module has no access to it, and
  // the caller must validate before storing (FR-22.8, FR-24.13).
  category: z.string().min(1).nullish().catch(null).transform((v) => v ?? null),
  subcategory: z.string().min(1).nullish().catch(null).transform((v) => v ?? null),
});

const ResultSchema = z.object({ suggestions: z.array(SuggestionSchema) });

/** JSON Schema for a suggestion result, for providers that support structured output. */
export const SUGGEST_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          reason: { type: 'string' },
          kind: { type: 'string', enum: ['ongoing', 'evergreen'] },
          guidance: { type: ['string', 'null'] },
          // Always allowed *and* always required — `additionalProperties: false`
          // means a structured-output provider would reject a classification that
          // wasn't declared here, and strict mode additionally rejects a declared
          // property missing from `required` (NEWS-272). All three are nullable,
          // so "required" means "emit the key, as null when there is nothing to
          // say".
          category: { type: ['string', 'null'] },
          subcategory: { type: ['string', 'null'] },
        },
        // Every declared key. This schema had the same defect that broke every
        // Codex *check* (NEWS-272) and would have broken every Codex
        // *discovery* call the same way — found by the recursive invariant in
        // `tests/unit/news-schema.test.ts`, not by a second live 400.
        required: ['name', 'reason', 'kind', 'guidance', 'category', 'subcategory'],
      },
    },
  },
  required: ['suggestions'],
} as const;

/** System prompt for topic discovery. */
export function suggestSystemPrompt(): string {
  return [
    'You help someone decide which news topics to follow. You do not report news; you propose subjects.',
    '',
    'Rules:',
    '- Propose topics a person would want to track over time, phrased as someone would name a subject —',
    '  "Formula 1", "EU AI regulation" — not as a headline or a question.',
    '- Return a deliberate MIX of two kinds, and label each one:',
    '    "ongoing"   — a live story that will eventually conclude ("2026 midterms").',
    '    "evergreen" — a standing subject that keeps producing news indefinitely ("Formula 1").',
    '  Use web search for the ongoing half so those reflect what is actually happening now, not what was',
    '  happening when you were trained. Evergreen suggestions do not need searching.',
    '- Give each suggestion a "reason": one plain sentence on why someone would follow it. Not a summary of',
    '  current events, and not a sales pitch.',
    '- Give each suggestion a "guidance": one sentence the user could hand to a news assistant to narrow the',
    '  topic — what to include and what to leave out ("race results and team news, not driver gossip").',
    '- Never propose a topic the user already follows. The exclusions are listed in the user message.',
    '- Vary the specificity. A list where every entry is equally broad is less useful than one that mixes',
    '  a wide subject with a couple of sharper ones inside it.',
    '- Write plain prose. No markup, HTML tags, or citation tags in any field.',
    '',
    'Respond with a JSON object of exactly this shape (and, if your output is free text, put it in a fenced ```json block):',
    '{"suggestions": [{"name": "...", "reason": "...", "kind": "ongoing|evergreen", "guidance": "..."}]}',
    '',
    'If — and only if — the user message lists sections to classify into, add "category" and "subcategory"',
    'fields to each suggestion. Otherwise omit them entirely.',
  ].join('\n');
}

/** The scope-specific instruction — the one part that differs per entry door. */
function scopeLines(scope: SuggestScope): string[] {
  if (scope.kind === 'describe') {
    const query = scope.query.trim();
    if (query === '') {
      // FR-24.3: an empty box is "surprise me", not an error. The breadth
      // instruction matters — without it the model reaches for the same handful
      // of default subjects every time.
      return [
        'The user has not said what they are interested in, so propose a broad spread across different areas',
        'of life — not several variations on one theme. Range widely: world events, science, sport, culture,',
        'business, and so on. Assume nothing about who they are.',
      ];
    }
    return [
      'The user described their interests like this:',
      query,
      '',
      'Propose topics that follow from it. Read it generously — an interest in one thing implies neighbouring',
      'ones worth offering, and a person who names two unrelated interests wants both served, not blended.',
    ];
  }

  if (scope.kind === 'section') {
    const where =
      scope.subcategory === null
        ? `the "${scope.category}" section, ranging across the whole of it`
        : `"${scope.subcategory}" within the "${scope.category}" section`;
    return [`Propose topics from ${where}.`];
  }

  const direction =
    scope.direction === 'narrower'
      ? [
          `Propose topics NARROWER than "${scope.anchor}" — more specific subjects inside it, each of which`,
          'someone could follow on its own without following the whole thing.',
        ]
      : [
          `Propose topics SIMILAR to "${scope.anchor}" — adjacent subjects someone interested in it would`,
          'plausibly also want, without simply restating it in other words.',
        ];
  const lines = [...direction, `This is round ${String(scope.round)} of narrowing down.`];

  const kept = scope.kept.slice(-MAX_TUNE_HISTORY);
  const skipped = scope.skipped.slice(-MAX_TUNE_HISTORY);
  if (kept.length > 0) {
    lines.push('');
    lines.push('The user KEPT these, so move toward them:');
    for (const name of kept) lines.push(`- ${name}`);
  }
  if (skipped.length > 0) {
    lines.push('');
    // The skips are the half a naive implementation drops, and they carry more
    // information per item than the keeps: "not that kind of cycling" rules out
    // a whole direction, where a keep only confirms one.
    lines.push(
      'The user SKIPPED these. Treat them as a steer away from that direction, not merely as items to omit:',
    );
    for (const name of skipped) lines.push(`- ${name}`);
  }
  return lines;
}

/** Build the user prompt for a suggestion request. */
export function buildSuggestPrompt(request: SuggestRequest): string {
  const limit = Math.min(request.limit ?? DEFAULT_SUGGESTIONS, MAX_SUGGESTIONS);
  const lines: string[] = [];
  lines.push(`Current date: ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push(...scopeLines(request.scope));

  // Placed before the exclusions and after the scope: it *widens* what to look
  // for, and reads as a qualifier on the request rather than on the list of
  // things to avoid. Only present for a request the user hasn't already scoped
  // (NEWS-386, `profilesApplyTo`).
  const profiles = request.profiles ?? [];
  if (profiles.length > 0) {
    lines.push('');
    lines.push(
      `The user describes themselves as: ${profiles.join(', ')}. Lean towards subjects such a person would ` +
        'follow, and spread the suggestions across several of those interests rather than crowding them ' +
        'into one. Treat it as a steer, not a filter — an excellent suggestion outside these is still ' +
        'worth making, and a dull one inside them is not.',
    );
  }

  if (request.exclude.length > 0) {
    lines.push('');
    lines.push('The user ALREADY follows these. Do not suggest them, or near-duplicates of them:');
    for (const name of request.exclude) lines.push(`- ${name}`);
  }

  const options = request.categoryOptions ?? [];
  if (options.length > 0) {
    lines.push('');
    lines.push(
      'Classify each suggestion into one of the sections below, as "category" and "subcategory" fields on ' +
        'that suggestion. Use the slug (the value in parentheses), not the label.',
    );
    for (const option of options) {
      const subs = option.subcategories.map((s) => `${s.label} (${s.slug})`).join(', ');
      lines.push(`- ${option.label} (${option.slug})${subs === '' ? '' : ` — subcategories: ${subs}`}`);
    }
    lines.push(
      'Pick exactly one category per suggestion. If no subcategory fits, set "subcategory" to null rather ' +
        'than forcing one. If no category fits either, set both to null.',
    );
  }

  lines.push('');
  lines.push(
    `Return up to ${String(limit)} suggestions as the JSON object described in your instructions. ` +
      'Fewer good ones beats padding the list.',
  );
  return lines.join('\n');
}

/**
 * Extract and validate a suggestion result from a model's text. Accepts a fenced
 * json block (preferred, last one wins) or a bare object — same shape as
 * `parseNewsResult`, and the same reasoning for each half.
 *
 * Classification slugs are **not** checked against the taxonomy here; the caller
 * must validate before storing (FR-22.8, FR-24.13).
 */
export function parseSuggestResult(text: string): TopicSuggestion[] {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const candidates: string[] = fenced.map((m) => m[1]);
  if (candidates.length === 0) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  }
  for (const candidate of candidates.reverse()) {
    try {
      const parsed = ResultSchema.parse(JSON.parse(candidate));
      return parsed.suggestions.slice(0, MAX_SUGGESTIONS).map((s) => ({
        name: s.name,
        reason: s.reason,
        kind: s.kind,
        guidance: s.guidance,
        classification: s.category === null ? null : { category: s.category, subcategory: s.subcategory },
      }));
    } catch {
      // try the next candidate
    }
  }
  throw new Error('could not parse a topic suggestion result from the model response');
}
