import { z } from 'zod';

import { stripMarkup } from './sanitize.js';
import type { FoundNewsItem, KnownItem, TopicClassification, TopicContext } from './types.js';

const MAX_KNOWN_ITEMS = 60;

const ResultSchema = z.object({
  items: z.array(
    z.object({
      // Models emit their own citation markup inside these strings; strip it
      // here so nothing downstream has to know that (see `sanitize.ts`).
      title: z.string().min(1).transform(stripMarkup),
      summary: z.string().min(1).transform(stripMarkup),
      sources: z.array(
        z.object({
          title: z.string().transform(stripMarkup),
          url: z.string(),
          // Both optional and nullable: the model often can't tell, and
          // `.catch(null)` means a malformed value degrades to "unknown"
          // rather than failing the parse and losing the whole batch.
          outlet: z.string().transform(stripMarkup).nullish().catch(null).transform((v) => v ?? null),
          publishedAt: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .nullish()
            .catch(null)
            .transform((v) => v ?? null),
        }),
      ),
    }),
  ),
  // Topic classification (NEWS-97). Optional in every sense: absent when we
  // didn't ask, and `.catch(null)` so a malformed value degrades to "not
  // classified" instead of failing the parse and losing the whole news batch.
  // A category the taxonomy doesn't have is *not* rejected here — the caller
  // validates against the live table, which is the only place that knows it.
  category: z.string().min(1).nullish().catch(null).transform((v) => v ?? null),
  subcategory: z.string().min(1).nullish().catch(null).transform((v) => v ?? null),
});

/** JSON Schema for the news result, for providers that support structured output. */
export const NEWS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          sources: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string' },
                url: { type: 'string' },
                outlet: { type: ['string', 'null'] },
                publishedAt: { type: ['string', 'null'] },
              },
              // **Every** key, not just the mandatory ones (NEWS-272). OpenAI's
              // strict structured outputs reject a schema whose `required` omits
              // any declared property:
              //
              //   invalid_json_schema: 'required' is required to be supplied and
              //   to be an array including every key in properties.
              //   Missing 'outlet'.
              //
              // Optionality is expressed by the type being nullable, which these
              // already are — so listing them costs nothing and the prompt already
              // tells the model to use null when it cannot tell.
              required: ['title', 'url', 'outlet', 'publishedAt'],
            },
          },
        },
        required: ['title', 'summary', 'sources'],
      },
    },
    // Declared (NEWS-97) *and* required (NEWS-272). `additionalProperties: false`
    // means a structured-output provider would reject a classification that
    // wasn't named here; strict mode additionally rejects a declared property
    // missing from `required`. Both are nullable, so "required" here means "emit
    // the key, as null when there is nothing to say" — which is why the prompt
    // asks for null rather than for the keys to be omitted.
    category: { type: ['string', 'null'] },
    subcategory: { type: ['string', 'null'] },
  },
  required: ['items', 'category', 'subcategory'],
} as const;

/** System prompt for a web-searching provider (finds genuinely new news). */
export function searchingSystemPrompt(): string {
  return [
    'You are a news research assistant. You check whether there is any genuinely new news about a topic,',
    'summarize what you find, and cite the news sources you used.',
    '',
    'Rules:',
    '- Use web search to find recent, reputable coverage of the topic.',
    '- Report only stories that are NEW relative to the "already reported" list you are given. If a story is',
    '  substantially the same as one already reported (same event, minor follow-up detail), skip it.',
    '- If there is no genuinely new news, return an empty items list. Do not pad with old or marginal stories.',
    '- Report only the most significant stories — the handful someone can read in one sitting, not an',
    '  exhaustive list. A longer gap since the last check means covering a wider span of time, NOT',
    '  returning proportionally more stories.',
    '- Each summary should be 2-4 sentences, factual, and self-contained.',
    '- Each story must include at least one source link to a news article (not a homepage).',
    '- For each source, give the publishing outlet as "outlet" (e.g. "Reuters") and the article\'s',
    '  publication date as "publishedAt" in YYYY-MM-DD form. If you are not certain of either, use null.',
    '  A guessed date is worse than no date — readers judge news by how recent it is.',
    '- Write plain prose. No markup, HTML tags, or citation tags in the title or summary.',
    '',
    'Respond with a JSON object of exactly this shape (and, if your output is free text, put it in a fenced ```json block):',
    '{"items": [{"title": "...", "summary": "...", "sources": [{"title": "...", "url": "https://...", "outlet": "...", "publishedAt": "YYYY-MM-DD"}]}]}',
    '',
    // "Always include, null when not asked" rather than "omit unless asked"
    // (NEWS-272). A strict structured-output provider requires every declared
    // property to be present, so telling the model to omit these put the prompt
    // and the schema in direct conflict.
    'Always include top-level "category" and "subcategory" fields on that same object. Fill them in',
    'only if the user message asks you to classify the topic; otherwise set both to null.',
  ].join('\n');
}




/**
 * Describe the window to cover, in words the model can act on.
 *
 * A bare "focus on developments since <timestamp>" reads the same whether the
 * gap is two hours or three weeks, and invites the model to report only the
 * most recent day either way. Long gaps are routine now — subscription-backed
 * providers only run scheduled checks while the app is open (see
 * `src/attendance.ts`), so a user who doesn't open it all week genuinely needs
 * the whole week — so the span is stated explicitly and the expectation set.
 */
function windowLine(sinceIso: string | null, now: Date): string {
  if (sinceIso === null) {
    return 'This is the first check for this topic — focus on notable news from roughly the past week.';
  }
  const elapsedMs = now.getTime() - Date.parse(sinceIso);
  const hours = Math.floor(elapsedMs / 3_600_000);
  const days = Math.floor(hours / 24);

  // Two days is the threshold for catch-up phrasing: the default interval is
  // one day, so anything beyond two means at least one cycle was missed.
  if (days >= 2) {
    // The volume bound is restated here, not just in the system prompt: this is
    // the one place the model is told the span is long, and "cover the whole
    // period" reads as an invitation to return proportionally more stories
    // unless it's contradicted in the same breath.
    return (
      `Last checked ${days} days ago (${sinceIso}). Nothing has been reported for this topic in that time, ` +
      `so span the whole period rather than just the last day or two. Still report only the most significant ` +
      `developments — a longer gap means a wider span, not a longer list. Order them oldest to newest.`
    );
  }
  const span =
    days === 1 ? '1 day' : hours >= 1 ? `${hours} hour${hours === 1 ? '' : 's'}` : 'less than an hour';
  return `Last checked ${span} ago (${sinceIso}) — focus on developments since then.`;
}

/**
 * Build the user prompt shared by every provider.
 *
 * Two kinds of steer, stated separately because they carry different authority:
 *
 * - `context.guidance` is what the user *wrote* about this topic (NEWS-80) —
 *   "regulatory news only, not stock moves". It is an instruction, and it is
 *   placed ahead of the negative examples because it should win where the two
 *   seem to disagree.
 * - `context.offTopicTitles` are stories the user marked off-topic (NEWS-61): a
 *   short label like "Apple" can mean the company or the fruit, and these show
 *   which sense the user did NOT mean. Framed as "prefer stories unlike these"
 *   rather than a hard exclusion — the point is to infer intent, not to
 *   blacklist exact stories.
 */
export function buildUserPrompt(
  topicName: string,
  known: KnownItem[],
  sinceIso: string | null,
  context: TopicContext = {},
): string {
  const guidance = (context.guidance ?? '').trim();
  const offTopicTitles = context.offTopicTitles ?? [];
  const now = new Date();
  const lines: string[] = [];
  lines.push(`Topic: ${topicName}`);
  lines.push(`Current date: ${now.toISOString().slice(0, 10)}`);
  lines.push(windowLine(sinceIso, now));
  if (guidance !== '') {
    lines.push('');
    lines.push(
      'The user gave these instructions for what they want from this topic. Follow them — they take ' +
        'precedence over your own judgement about what is newsworthy here, and a story that does not fit ' +
        'them should be left out even if it is significant:',
    );
    lines.push(guidance);
  }
  // Stated once, with the rule for using it, rather than resolved into a stored
  // per-topic scope (NEWS-393, FR-35.4). How local a subject is varies by story
  // as much as by topic — a national tour announcement is on-topic for a
  // near-me "Concerts" — so the judgement belongs where the stories are, not in
  // a field set once at classification time.
  //
  // Both halves of the instruction matter. Without the second, every topic
  // drifts local and "Space exploration" starts returning the regional
  // planetarium; without the first, the setting does nothing.
  const location = (context.location ?? '').trim();
  if (location !== '') {
    lines.push('');
    lines.push(
      `The user is in: ${location}. Use this only where the topic is inherently about somewhere — local ` +
        'events, property, schools, transport, jobs, weather, and national politics or law. For a subject ' +
        'that is not tied to a place, ignore it entirely and search globally; a worldwide topic narrowed to ' +
        "the user's town is worse than one that ignored the location. Where it applies, judge the right " +
        'breadth yourself: some subjects mean the immediate area, others the country.',
    );
  }
  const recentKnown = known.slice(-MAX_KNOWN_ITEMS);
  if (recentKnown.length > 0) {
    lines.push('');
    lines.push('Already reported (do NOT report these stories again):');
    for (const item of recentKnown) {
      lines.push(`- ${item.title} (reported ${item.foundAt.slice(0, 10)})`);
    }
  }
  if (offTopicTitles.length > 0) {
    lines.push('');
    lines.push(
      'The user marked these past stories as OFF-TOPIC — they are not what the user means by this topic. ' +
        'Use them to infer the intended sense of the topic and prefer stories unlike these:',
    );
    for (const title of offTopicTitles) {
      lines.push(`- ${title}`);
    }
  }
  const options = context.categoryOptions ?? [];
  if (options.length > 0) {
    lines.push('');
    lines.push(
      'Also classify this topic into one of the sections below, as top-level "category" and "subcategory" ' +
        'fields on the JSON object. Use the slug (the value in parentheses), not the label. Classify the ' +
        'TOPIC ITSELF, not the individual stories you found — the label is permanent and the stories are not.',
    );
    for (const option of options) {
      const subs = option.subcategories.map((s) => `${s.label} (${s.slug})`).join(', ');
      lines.push(`- ${option.label} (${option.slug})${subs === '' ? '' : ` — subcategories: ${subs}`}`);
    }
    lines.push(
      'Pick exactly one category. If no subcategory fits, set "subcategory" to null rather than forcing one — ' +
        'a topic can legitimately belong to a section without matching any of its subsections. If genuinely ' +
        'no section fits, choose "other" — prefer a real section wherever one is defensible, but "other" is a ' +
        'better answer than a section you had to stretch to reach. Never return null for the category.',
    );
  }
  lines.push('');
  lines.push('Find any new news about this topic and respond with the JSON object described in your instructions.');
  return lines.join('\n');
}

/**
 * Extract and validate the news result from a model's text. Accepts a fenced
 * json code block (preferred, last one wins) or a bare object.
 *
 * Returns the classification alongside the items when the model supplied one.
 * The slug is **not** checked against the taxonomy here — this module has no
 * access to it, and the caller must validate before storing (FR-22.8).
 */
export function parseNewsResult(text: string): {
  items: FoundNewsItem[];
  classification: TopicClassification | null;
} {
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
      return {
        items: parsed.items,
        classification: parsed.category === null ? null : { category: parsed.category, subcategory: parsed.subcategory },
      };
    } catch {
      // try the next candidate
    }
  }
  throw new Error('could not parse a news result from the model response');
}
