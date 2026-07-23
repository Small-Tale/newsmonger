import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

import type { FoundNewsItem, KnownItem, NewsService } from './types.js';

const MODEL = 'claude-opus-4-8';
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

/**
 * News service backed by the Claude API with web search.
 *
 * Each check is a single streamed request: Claude searches the web for recent
 * news on the topic, skips stories that were already reported on previous
 * checks, and returns a JSON object with the new stories it found.
 */
export class ClaudeNewsService implements NewsService {
  private readonly client: Anthropic;

  constructor(client?: Anthropic) {
    this.client = client ?? new Anthropic();
  }

  async checkTopic(topicName: string, known: KnownItem[], sinceIso: string | null): Promise<FoundNewsItem[]> {
    const stream = this.client.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }],
      system: [
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
        'Your final message must end with a fenced JSON code block of exactly this shape (no other trailing text):',
        '```json',
        '{"items": [{"title": "...", "summary": "...", "sources": [{"title": "...", "url": "https://..."}]}]}',
        '```',
      ].join('\n'),
      messages: [{ role: 'user', content: buildUserPrompt(topicName, known, sinceIso) }],
    });
    const message = await stream.finalMessage();

    if (message.stop_reason === 'refusal') {
      throw new Error('Claude declined to research this topic');
    }
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    return parseNewsResult(text);
  }
}

function buildUserPrompt(topicName: string, known: KnownItem[], sinceIso: string | null): string {
  const lines: string[] = [];
  lines.push(`Topic: ${topicName}`);
  lines.push(`Current date: ${new Date().toISOString().slice(0, 10)}`);
  if (sinceIso !== null) {
    lines.push(`Last checked: ${sinceIso} — focus on developments since then.`);
  } else {
    lines.push('This is the first check for this topic — focus on notable news from roughly the past week.');
  }
  const recentKnown = known.slice(-MAX_KNOWN_ITEMS);
  if (recentKnown.length > 0) {
    lines.push('');
    lines.push('Already reported (do NOT report these stories again):');
    for (const item of recentKnown) {
      lines.push(`- ${item.title} (reported ${item.foundAt.slice(0, 10)})`);
    }
  }
  lines.push('');
  lines.push('Find any new news about this topic and respond with the JSON block described in your instructions.');
  return lines.join('\n');
}

/**
 * Extract and validate the JSON result from Claude's final text. Accepts a
 * fenced json code block (preferred, last one wins) or a bare trailing object.
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
      const parsed = ResultSchema.parse(JSON.parse(candidate));
      return parsed.items;
    } catch {
      // try the next candidate
    }
  }
  throw new Error('could not parse a news result from the model response');
}
