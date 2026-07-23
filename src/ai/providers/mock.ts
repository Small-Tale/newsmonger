import type { FoundNewsItem, KnownItem, NewsProvider } from '../types.js';

/**
 * Deterministic provider for tests and offline development (`--ai-test` /
 * `--provider mock`).
 *
 * Returns the same two stories for a topic on every call, so a second check
 * exercises the dedupe path. Topics whose name contains "empty" return no
 * stories; topics containing "fail" throw. `searchesWeb` is false — it never
 * touches the network.
 */
export function createMockProvider(): NewsProvider & {
  calls: { topicName: string; known: KnownItem[]; sinceIso: string | null }[];
} {
  const calls: { topicName: string; known: KnownItem[]; sinceIso: string | null }[] = [];
  return {
    name: 'mock',
    searchesWeb: false,
    model: 'mock',
    calls,
    isAvailable: () => Promise.resolve(true),
    checkTopic(topicName: string, known: KnownItem[], sinceIso: string | null): Promise<FoundNewsItem[]> {
      calls.push({ topicName, known, sinceIso });
      const lower = topicName.toLowerCase();
      if (lower.includes('fail')) return Promise.reject(new Error('mock news service failure'));
      if (lower.includes('empty')) return Promise.resolve([]);
      const slug = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      return Promise.resolve([
        {
          title: `Major development in ${topicName}`,
          summary: `A significant new development related to ${topicName} was reported today. Analysts describe it as an important shift. Further details are expected soon.`,
          sources: [{ title: 'Example News', url: `https://news.example.com/${slug}/major-development` }],
        },
        {
          title: `${topicName}: what experts are watching next`,
          summary: `Experts following ${topicName} outlined the key open questions for the coming weeks. Several indicators are being tracked closely.`,
          sources: [{ title: 'Example Times', url: `https://times.example.com/${slug}/experts-watching` }],
        },
      ]);
    },
  };
}
