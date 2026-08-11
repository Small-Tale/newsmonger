import { z } from 'zod';

import { stripMarkup } from './sanitize.js';

export interface ThreadBriefInput {
  id: string;
  title: string;
  summary: string;
  sources: { title: string; url: string; outlet?: string | null }[];
}

const ClaimSchema = z.object({
  text: z.string().min(1).transform(stripMarkup),
  sourceIds: z.array(z.string().min(1)).min(1),
  support: z.enum(['independent', 'repeated', 'unclear']),
});

export const ThreadBriefResultSchema = z.object({
  changed: z.array(ClaimSchema),
  consistent: z.array(ClaimSchema),
  unknown: z.array(ClaimSchema),
  uncertainty: z.enum(['low', 'medium', 'high']),
});
export type ThreadBriefResult = z.infer<typeof ThreadBriefResultSchema>;

export const THREAD_BRIEF_JSON_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    changed: { type: 'array', items: claimJsonSchema() },
    consistent: { type: 'array', items: claimJsonSchema() },
    unknown: { type: 'array', items: claimJsonSchema() },
    uncertainty: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['changed', 'consistent', 'unknown', 'uncertainty'],
} as const;

function claimJsonSchema(): object {
  return {
    type: 'object', additionalProperties: false,
    properties: {
      text: { type: 'string' },
      sourceIds: { type: 'array', minItems: 1, items: { type: 'string' } },
      support: { type: 'string', enum: ['independent', 'repeated', 'unclear'] },
    },
    required: ['text', 'sourceIds', 'support'],
  };
}

export function threadBriefSystemPrompt(): string {
  return [
    'You produce a compact evidence-linked brief from stored stories about one developing subject.',
    'Use only the supplied stories. Never browse and never add facts from memory.',
    'Answer what changed, what is consistent, and what remains disputed or unknown.',
    'Every claim must cite one or more supplied story ids. Empty sections are allowed.',
    'support=independent only when distinct outlets independently support the claim; support=repeated for syndicated/repeated wording; otherwise unclear.',
    'Do not turn repetition into consensus. Use high uncertainty when evidence is sparse, conflicting, or provenance is unclear.',
    'Return JSON only.',
  ].join('\n');
}

export function buildThreadBriefPrompt(items: readonly ThreadBriefInput[]): string {
  return JSON.stringify({ stories: items.map((item, index) => ({ order: index + 1, ...item })) });
}

export function parseThreadBriefResult(text: string, allowedIds: ReadonlySet<string>): ThreadBriefResult {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const parsed = ThreadBriefResultSchema.parse(JSON.parse(candidate.trim()));
  for (const section of [parsed.changed, parsed.consistent, parsed.unknown]) {
    for (const claim of section) {
      if (claim.sourceIds.some((id) => !allowedIds.has(id))) throw new Error('Thread brief cited an unknown story');
    }
  }
  return parsed;
}
