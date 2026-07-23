import { z } from 'zod';

import type { FoundNewsItem, KnownItem } from './types.js';

const MAX_KNOWN_ITEMS = 60;

const ResultSchema = z.object({
  items: z.array(
    z.object({
      title: z.string().min(1),
      summary: z.string().min(1),
      sources: z.array(z.object({ title: z.string(), url: z.string() })),
    }),
  ),
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
              properties: { title: { type: 'string' }, url: { type: 'string' } },
              required: ['title', 'url'],
            },
          },
        },
        required: ['title', 'summary', 'sources'],
      },
    },
  },
  required: ['items'],
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
    '- Each summary should be 2-4 sentences, factual, and self-contained.',
    '- Each story must include at least one source link to a news article (not a homepage).',
    '',
    'Respond with a JSON object of exactly this shape (and, if your output is free text, put it in a fenced ```json block):',
    '{"items": [{"title": "...", "summary": "...", "sources": [{"title": "...", "url": "https://..."}]}]}',
  ].join('\n');
}




/** Build the user prompt shared by every provider. */
export function buildUserPrompt(topicName: string, known: KnownItem[], sinceIso: string | null): string {
  const lines: string[] = [];
  lines.push(`Topic: ${topicName}`);
  lines.push(`Current date: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(
    sinceIso !== null
      ? `Last checked: ${sinceIso} — focus on developments since then.`
      : 'This is the first check for this topic — focus on notable news from roughly the past week.',
  );
  const recentKnown = known.slice(-MAX_KNOWN_ITEMS);
  if (recentKnown.length > 0) {
    lines.push('');
    lines.push('Already reported (do NOT report these stories again):');
    for (const item of recentKnown) {
      lines.push(`- ${item.title} (reported ${item.foundAt.slice(0, 10)})`);
    }
  }
  lines.push('');
  lines.push('Find any new news about this topic and respond with the JSON object described in your instructions.');
  return lines.join('\n');
}

/**
 * Extract and validate the news result from a model's text. Accepts a fenced
 * json code block (preferred, last one wins) or a bare object.
 */
export function parseNewsResult(text: string): FoundNewsItem[] {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const candidates: string[] = fenced.map((m) => m[1]);
  if (candidates.length === 0) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  }
  for (const candidate of candidates.reverse()) {
    try {
      return ResultSchema.parse(JSON.parse(candidate)).items;
    } catch {
      // try the next candidate
    }
  }
  throw new Error('could not parse a news result from the model response');
}
