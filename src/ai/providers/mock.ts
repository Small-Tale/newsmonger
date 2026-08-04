import type {
  CategoryOption,
  CheckResult,
  KnownItem,
  NewsProvider,
  SuggestRequest,
  SuggestResult,
  TokenUsage,
  TopicClassification,
  TopicContext,
  TopicSuggestion,
} from '../types.js';

/** One recorded check, so tests can assert on what the runner passed through. */
interface MockCall {
  topicName: string;
  known: KnownItem[];
  sinceIso: string | null;
  context: TopicContext;
}

/**
 * The word a suggestion request is keyed off (NEWS-124).
 *
 * Discovery has three entry shapes but only one useful notion of "what was
 * asked for", so they collapse to a single string and the `fail` / `empty`
 * keywords work identically across all three — the same scheme `checkTopic`
 * already uses on the topic name, so there is one convention to learn.
 */
function requestSeed(request: SuggestRequest): string {
  const { scope } = request;
  if (scope.kind === 'describe') return scope.query.trim() === '' ? 'Surprise' : scope.query.trim();
  if (scope.kind === 'section') return scope.subcategory ?? scope.category;
  return scope.anchor;
}

/**
 * Deterministic suggestions for one request (NEWS-124).
 *
 * Two properties matter more than realism here, because the whole discovery UI
 * is tested through this:
 *
 * - **Every field varies with the request.** Names encode the round and
 *   direction for a tuner call, so a test can tell round 2 from round 1 — the
 *   bug where the tuner re-issues the same round is otherwise invisible.
 * - **It deliberately suggests something the user already follows** when
 *   `exclude` is non-empty. That is the one case FR-24.11's *second* layer
 *   exists for — a model ignoring the exclusion list — and a mock that filtered
 *   perfectly would make that layer permanently untestable. The request is also
 *   recorded, so the first layer is assertable independently.
 */
function mockSuggestions(request: SuggestRequest): TopicSuggestion[] {
  const seed = requestSeed(request);
  const options = request.categoryOptions ?? [];
  const count = Math.max(1, Math.min(request.limit ?? 4, 12));
  const { scope } = request;
  const suffix = scope.kind === 'tune' ? ` ${scope.direction} r${String(scope.round)}` : '';

  const names: string[] = [];
  // The planted duplicate goes first, where a filter that only checks the tail
  // of the list would miss it.
  if (request.exclude.length > 0) names.push(request.exclude[0]);
  // Numbering continues past the exclusions (NEWS-136). A real model asked to
  // avoid a list of names answers with different ones; a mock that ignored the
  // list would return the same batch forever, making "More" — and any other
  // ask-again path — impossible to test end to end.
  //
  // A seed containing "repeat" opts out and keeps answering with the same batch,
  // which is the *other* case worth being able to reach: a model that has run
  // out of ideas. Without it the exhausted path is unreachable, the same way
  // "empty" exists so a no-results list can be tested.
  const offset = seed.toLowerCase().includes('repeat') ? 0 : request.exclude.length;
  for (let i = names.length; i < count; i++) {
    names.push(`${seed}${suffix} topic ${String(offset + i + 1)}`);
  }

  return names.map((name, i) => ({
    name,
    reason: `A deterministic mock suggestion for ${seed}.`,
    // Alternating, so the mixed-kind rendering (FR-24.10) is always exercised
    // rather than depending on which fixture a test happened to pick.
    kind: i % 2 === 0 ? ('evergreen' as const) : ('ongoing' as const),
    guidance: `Focus on ${seed}, and skip anything tangential.`,
    classification: classify(name.toLowerCase(), options),
  }));
}

/**
 * Deterministic provider for tests and offline development (`--ai-test` /
 * `--provider mock`).
 *
 * Returns the same two stories for a topic on every call, so a second check
 * exercises the dedupe path. Topics whose name contains "empty" return no
 * stories; topics containing "fail" throw; topics containing "thread" return two
 * outlets' coverage of a single subject, which is what makes story threading
 * (NEWS-280) reachable in E2E. It never touches the network.
 *
 * `suggestTopics` (NEWS-124) follows the same convention keyed off the request
 * seed — see `requestSeed` and `mockSuggestions`. It adds one keyword of its
 * own: "repeat" keeps answering with the same batch, so the out-of-ideas path
 * is reachable (NEWS-136).
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
function classify(lowerName: string, options: CategoryOption[]): TopicClassification | null {
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
): NewsProvider & { calls: MockCall[]; suggestCalls: SuggestRequest[] } {
  // Deterministic and small, so cost assertions read as arithmetic rather than
  // magic. Null is settable so the unknown-usage path is testable too.
  const usage: TokenUsage | null =
    config.usage === undefined
      ? { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500, webSearches: 2 }
      : config.usage;
  const calls: MockCall[] = [];
  const suggestCalls: SuggestRequest[] = [];
  return {
    name: 'mock',
    model: 'mock',
    effort: '',
    attended: config.attended ?? false,
    calls,
    suggestCalls,
    isAvailable: () => Promise.resolve(true),
    suggestTopics(request: SuggestRequest): Promise<SuggestResult> {
      suggestCalls.push(request);
      const seed = requestSeed(request).toLowerCase();
      if (seed.includes('fail')) return Promise.reject(new Error('mock suggestion failure'));
      if (seed.includes('empty')) return Promise.resolve({ suggestions: [], usage });
      return Promise.resolve({ suggestions: mockSuggestions(request), usage });
    },
    checkTopic(
      topicName: string,
      known: KnownItem[],
      sinceIso: string | null,
      context: TopicContext = {},
    ): Promise<CheckResult> {
      calls.push({ topicName, known, sinceIso, context });
      const lower = topicName.toLowerCase();
      if (lower.includes('fail')) return Promise.reject(new Error('mock news service failure'));
      if (lower.includes('empty'))
        return Promise.resolve({ items: [], usage, classification: classify(lower, context.categoryOptions ?? []) });
      const slug = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      // "thread" → two outlets covering *one* subject, so story threading
      // (NEWS-280) is reachable end to end. The default pair below deliberately
      // shares nothing but the topic's own name, which threading discounts, so
      // without this keyword no E2E flow could ever produce a thread of two.
      if (lower.includes('thread'))
        return Promise.resolve({
          usage,
          classification: classify(lower, context.categoryOptions ?? []),
          items: [
            {
              title: 'Riverside Dam collapse floods three towns',
              summary:
                'The Riverside Dam gave way overnight, flooding three towns downstream. Officials have ordered evacuations. Damage assessments are under way.',
              sources: [{ title: 'Example News', url: `https://news.example.com/${slug}/riverside-dam-collapse` }],
            },
            {
              title: 'Rescue teams reach Riverside Dam flood zone',
              summary:
                'Rescue teams have reached the Riverside Dam flood zone and begun searching the worst-hit streets. A relief centre has opened nearby.',
              sources: [{ title: 'Example Times', url: `https://times.example.com/${slug}/riverside-rescue` }],
            },
          ],
        });
      return Promise.resolve({
        usage,
        classification: classify(lower, context.categoryOptions ?? []),
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
