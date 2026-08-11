import type {
  CategoryOption,
  CheckResult,
  FoundNewsItem,
  KnownItem,
  NewsProvider,
  SuggestRequest,
  SuggestResult,
  ThreadBriefInput,
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
 * One subject, reported six times — the mock's answer for a topic whose name
 * contains "thread" (NEWS-280, extended in NEWS-282).
 *
 * Every headline shares "Riverside" and at least two other content words with the
 * first, and every one of them carries a capitalized entity in common, so they
 * clear `src/threads.ts`'s gates and land in **one** thread. They are deliberately
 * *different articles from different outlets*, which is what dedup cannot relate
 * and threading exists to.
 *
 * **The series grows with what the topic already knows**: two instalments on the
 * first check, two more on each later one. Dedup drops the repeats (same URLs), so
 * repeated checks extend one thread by two stories at a time — which is the only
 * way an E2E flow can build a thread longer than the timeline's row cap
 * (`THREAD_ROW_CAP`) and reach the "show all" affordance. Returning all six at
 * once instead would make the very first check of a brand-new topic produce a
 * six-story thread, which is not what a first check looks like.
 */
function threadSeries(slug: string, knownCount: number): FoundNewsItem[] {
  const series: FoundNewsItem[] = [
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
    {
      title: 'Riverside flood inquiry opens into collapse warnings',
      summary:
        'An inquiry into the Riverside flood has opened, examining warnings issued before the collapse. It will report within the year.',
      sources: [{ title: 'Example Herald', url: `https://herald.example.com/${slug}/riverside-inquiry` }],
    },
    {
      title: 'Riverside Dam engineers detail the collapse sequence',
      summary:
        'Engineers gave the first detailed account of how the Riverside Dam failed, hour by hour. Their account differs from the operator’s.',
      sources: [{ title: 'Example Post', url: `https://post.example.com/${slug}/riverside-engineers` }],
    },
    {
      title: 'Riverside flood recovery begins in three towns',
      summary:
        'Recovery work has begun in the three towns the Riverside flood reached. Rebuilding is expected to take two years.',
      sources: [{ title: 'Example News', url: `https://news.example.com/${slug}/riverside-recovery` }],
    },
    {
      title: 'Riverside Dam collapse inquiry names the contractor',
      summary:
        'The Riverside Dam inquiry has named the contractor responsible for the failed repair. The company disputes the finding.',
      sources: [{ title: 'Example Times', url: `https://times.example.com/${slug}/riverside-contractor` }],
    },
  ];
  return series.slice(0, Math.min(series.length, knownCount + 2));
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
    analyzeThread(items: ThreadBriefInput[]) {
      const latest = items.at(-1);
      const first = items[0];
      return Promise.resolve({
        changed: latest === undefined ? [] : [{ text: `Latest update: ${latest.title}`, sourceIds: [latest.id], support: 'unclear' as const }],
        consistent: latest === undefined ? [] : [{ text: 'Reports consistently describe the same developing event.', sourceIds: [first.id, latest.id], support: 'independent' as const }],
        unknown: latest === undefined ? [] : [{ text: 'The final outcome remains unknown.', sourceIds: [latest.id], support: 'unclear' as const }],
        uncertainty: 'medium' as const,
      });
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
      // "thread" → coverage of *one* subject, so story threading (NEWS-280) and
      // the timeline built on it (NEWS-282) are reachable end to end. The default
      // pair below deliberately shares nothing but the topic's own name, which
      // threading discounts, so without this keyword no E2E flow could ever
      // produce a thread of two.
      if (lower.includes('thread'))
        return Promise.resolve({
          usage,
          classification: classify(lower, context.categoryOptions ?? []),
          items: threadSeries(slug, known.length),
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
