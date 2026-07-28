import type {
  CheckResult,
  KnownItem,
  NewsProvider,
  TokenUsage,
  TopicClassification,
  TopicContext,
} from '../types.js';

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
/**
 * Deterministic classification for the mock (NEWS-97), keyed off the topic name
 * the way the story fixtures already are.
 *
 * Matches a category or subcategory **label** appearing in the name, so a test
 * topic called "Soccer transfers" classifies as Sports · Soccer and reads as its
 * own documentation. Two escape hatches keep the other paths testable:
 * a name containing "uncategorized" declines to classify at all, and one
 * containing "bogus" returns a slug the taxonomy doesn't have — which is the
 * case the caller must drop rather than store.
 *
 * Returns null when nothing asked for a classification, which is what a check on
 * an already-labelled topic looks like.
 */
function classify(lowerName: string, context: TopicContext): TopicClassification | null {
  const options = context.categoryOptions ?? [];
  if (options.length === 0) return null;
  if (lowerName.includes('uncategorized')) return null;
  if (lowerName.includes('bogus')) return { category: 'not-a-real-category', subcategory: null };

  for (const option of options) {
    for (const sub of option.subcategories) {
      if (lowerName.includes(sub.label.toLowerCase())) {
        return { category: option.slug, subcategory: sub.slug };
      }
    }
  }
  for (const option of options) {
    if (lowerName.includes(option.label.toLowerCase())) {
      return { category: option.slug, subcategory: null };
    }
  }
  // Nothing matched: fall back to the first offered category with no
  // subcategory — the `sports`/null shape that renders as "Other".
  return { category: options[0]?.slug ?? '', subcategory: null };
}

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
      if (lower.includes('empty')) return Promise.resolve({ items: [], usage, classification: classify(lower, context) });
      const slug = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      return Promise.resolve({
        usage,
        classification: classify(lower, context),
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
