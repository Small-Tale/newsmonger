import type { CheckResult, KnownItem, NewsProvider, TokenUsage, TopicContext } from '../types.js';

/** One recorded call, so tests can assert on what the runner passed through. */
interface MockCall {
  topicName: string;
  known: KnownItem[];
  sinceIso: string | null;
  context: TopicContext;
}

/**
 * Deterministic provider for tests and offline development (`--ai-test` /
 * `--provider mock`).
 *
 * Returns the same two stories for a topic on every call, so a second check
 * exercises the dedupe path. Topics whose name contains "empty" return no
 * stories; topics containing "fail" throw. It never touches the network.
 *
 * `attended` is settable so the foreground gate (`src/attendance.ts`) can be
 * tested end to end without a real subscription-backed CLI. It defaults to
 * false, matching the API-key providers, so existing tests are unaffected.
 */
export function createMockProvider(
  config: { attended?: boolean; usage?: TokenUsage | null } = {},
): NewsProvider & { calls: MockCall[] } {
  // Deterministic and small, so cost assertions read as arithmetic rather than
  // magic. Null is settable so the unknown-usage path is testable too.
  const usage: TokenUsage | null =
    config.usage === undefined
      ? { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500, webSearches: 2 }
      : config.usage;
  const calls: MockCall[] = [];
  return {
    name: 'mock',
    model: 'mock',
    attended: config.attended ?? false,
    calls,
    isAvailable: () => Promise.resolve(true),
    checkTopic(
      topicName: string,
      known: KnownItem[],
      sinceIso: string | null,
      context: TopicContext = {},
    ): Promise<CheckResult> {
      calls.push({ topicName, known, sinceIso, context });
      const lower = topicName.toLowerCase();
      if (lower.includes('fail')) return Promise.reject(new Error('mock news service failure'));
      if (lower.includes('empty')) return Promise.resolve({ items: [], usage });
      const slug = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      return Promise.resolve({
        usage,
        items: [
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
        ],
      });
    },
  };
}
