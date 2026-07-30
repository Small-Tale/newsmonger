import type { NewsItem, Topic } from './db/schemas.js';

/** Stories plus the topics they belong to, ready to render (NEWS-85). */
export interface ExportInput {
  items: NewsItem[];
  topics: Topic[];
  /** Human label for the selection, e.g. "Saved stories" or a topic name. */
  title: string;
  /** The app's own base URL, for feed self-links. */
  baseUrl: string;
  /** Stamped into the output; passed in so rendering stays pure. */
  now: Date;
}

function topicNames(topics: Topic[]): Map<string, string> {
  return new Map(topics.map((t) => [t.id, t.name]));
}

/**
 * Markdown export — what people paste into a notes app.
 *
 * Grouped by topic rather than strictly chronological: an export is read as a
 * document, and a document about six subjects wants six sections. (The feed
 * below is the opposite — a reader is a timeline, so it stays newest-first.)
 */
export function toMarkdown(input: ExportInput): string {
  const names = topicNames(input.topics);
  const lines: string[] = [`# ${input.title}`, '', `Exported ${input.now.toISOString().slice(0, 10)} from Newsmonger.`, ''];
  const byTopic = new Map<string, NewsItem[]>();
  for (const item of input.items) {
    const list = byTopic.get(item.topicId);
    if (list === undefined) byTopic.set(item.topicId, [item]);
    else list.push(item);
  }
  if (byTopic.size === 0) lines.push('_No stories._');
  for (const [topicId, items] of byTopic) {
    lines.push(`## ${names.get(topicId) ?? 'Deleted topic'}`, '');
    for (const item of items) {
      lines.push(`### ${item.title}`, '');
      lines.push(`_${item.foundAt.slice(0, 10)}_`, '');
      lines.push(item.summary, '');
      for (const source of item.sources) lines.push(`- [${source.title}](${source.url})`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

/** JSON export — the escape hatch, so nothing is trapped in the app. */
export function toJson(input: ExportInput): string {
  const names = topicNames(input.topics);
  return JSON.stringify(
    {
      exportedAt: input.now.toISOString(),
      title: input.title,
      stories: input.items.map((item) => ({
        topic: names.get(item.topicId) ?? null,
        title: item.title,
        summary: item.summary,
        sources: item.sources,
        foundAt: item.foundAt,
        saved: item.saved,
      })),
    },
    null,
    2,
  );
}

/** Escape the five XML metacharacters. Applied to every interpolated value. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * An Atom feed of the selection (NEWS-85).
 *
 * Atom rather than RSS 2.0: dates are ISO-8601 rather than RFC-822, `id` is a
 * required stable field rather than an optional convention, and content type is
 * declared rather than guessed. Every reader that speaks RSS speaks Atom.
 *
 * Story bodies go out as `type="text"`, not HTML — the summaries are plain
 * prose (they are stripped of markup on the way in, see `sanitize.ts`), and
 * declaring text means no reader has to decide whether to trust them as markup.
 */
export function toAtom(input: ExportInput): string {
  const names = topicNames(input.topics);
  const updated = input.items.at(0)?.foundAt ?? input.now.toISOString();
  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title>Newsmonger — ${escapeXml(input.title)}</title>`,
    `  <id>${escapeXml(`${input.baseUrl}/feed.xml`)}</id>`,
    `  <updated>${escapeXml(updated)}</updated>`,
    `  <link rel="self" href="${escapeXml(`${input.baseUrl}/feed.xml`)}"/>`,
    `  <link rel="alternate" href="${escapeXml(input.baseUrl)}"/>`,
  ];
  for (const item of input.items) {
    // A story is required to cite at least one source, but the schema doesn't
    // enforce it — so treat an empty list as "no alternate link" rather than
    // emitting an empty href.
    const link = item.sources.at(0)?.url;
    lines.push('  <entry>');
    lines.push(`    <title>${escapeXml(item.title)}</title>`);
    // The item id, not the article URL: two stories can cite the same source,
    // and a reader keyed on a duplicate id would drop one of them.
    lines.push(`    <id>urn:news:item:${escapeXml(item.id)}</id>`);
    lines.push(`    <updated>${escapeXml(item.foundAt)}</updated>`);
    if (link !== undefined && link !== '') {
      lines.push(`    <link rel="alternate" href="${escapeXml(link)}"/>`);
    }
    lines.push(`    <category term="${escapeXml(names.get(item.topicId) ?? 'unknown')}"/>`);
    lines.push(`    <content type="text">${escapeXml(item.summary)}</content>`);
    lines.push('  </entry>');
  }
  lines.push('</feed>');
  return lines.join('\n');
}
