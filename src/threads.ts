import { normalizeTitle, normalizeUrl } from './ai/dedupe.js';

/**
 * Thread identity: which earlier stories in a topic are about the *same
 * developing subject* as this one (NEWS-280).
 *
 * This is a different question from deduplication, and deliberately a separate
 * module. `dedupeKey` (`src/ai/dedupe.ts`) is a **URL identity** — "have we
 * already stored this exact article?" — with no notion of subject, which is why
 * two outlets covering one event produce two keys and two feed rows. A thread is
 * the opposite question: *these are different articles, and they are the same
 * story unfolding.* Nothing about key proximity answers it, so it is computed.
 *
 * Everything here is **local and pure**: no I/O, no model call, no cost. That is
 * what lets it run over rows already in the database (the backfill) as well as
 * over stories as they land. Model-reported linking is a separate, later signal
 * (NEWS-284) and would raise precision — it cannot replace this layer, because a
 * check only ever sees the last 60 known titles.
 *
 * ## The bias
 *
 * **A false join is worse than a missed one.** Missing a thread leaves a story
 * looking standalone, which is what every story looked like before this existed.
 * A false join files a story under a headline it has nothing to do with, and
 * that is visibly, confidently wrong. Every threshold below is therefore set to
 * leave items unthreaded when the evidence is thin, and a story that joins
 * nothing is simply a thread of one.
 */

/**
 * How long a subject may go quiet before an update starts a *new* thread.
 *
 * Measured pairwise as an absolute gap, so a thread that keeps being updated
 * keeps extending indefinitely (each update is close to the previous one) while
 * a subject nothing has touched for a month stops accreting. A month later the
 * news cycle has moved on and the "same" subject resurfacing is usually a
 * genuinely new story — the anniversary piece, the retrospective, the sequel.
 */
export const THREAD_MAX_GAP_MS = 30 * 24 * 60 * 60 * 1000;

/** Shared content words needed when a shared capitalized entity backs them up. */
export const THREAD_MIN_SHARED_TOKENS = 2;

/** Shared content words needed with no entity overlap at all. */
export const THREAD_MIN_SHARED_TOKENS_ALONE = 3;

/**
 * Minimum share of the *shorter* title's content words that must be shared.
 *
 * The absolute counts above stop thin overlaps; this stops a long, rambling
 * headline that happens to contain three of a short one's words from swallowing
 * it. `min` rather than `max` in the denominator on purpose: a two-sentence
 * headline should not be penalised for its length when the subject really is the
 * same.
 */
export const THREAD_MIN_OVERLAP_RATIO = 0.4;

/**
 * Words that carry no subject identity.
 *
 * Ordinary English function words plus the news-desk filler that appears in
 * every second headline ("says", "report", "amid", "latest"). Without this,
 * "Report: X says Y" and "Report: A says B" share two words and look related.
 *
 * The topic's own name is added per call (see `topicStopwords`) — *within* a
 * topic, the topic's words are shared by nearly every story it ever produces, so
 * counting them as evidence would thread the entire topic together. That single
 * subtraction does more for precision than the rest of this list.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'about', 'after', 'again', 'against', 'all', 'also', 'amid', 'among', 'and', 'announce', 'another', 'any', 'are',
  'around', 'ask', 'back', 'because', 'been', 'before', 'begin', 'being', 'below', 'best', 'between', 'big', 'both',
  'but', 'call', 'can', 'come', 'could', 'day', 'did', 'does', 'down', 'due', 'during', 'each', 'end', 'even', 'ever',
  'every', 'expect', 'few', 'first', 'following', 'for', 'from', 'further', 'get', 'give', 'going', 'got', 'had', 'has',
  'have', 'her', 'here', 'hers', 'him', 'his', 'how', 'however', 'into', 'issue', 'its', 'itself', 'just', 'keep',
  'key', 'know', 'last', 'late', 'later', 'latest', 'least', 'less', 'let', 'like', 'look', 'made', 'major', 'make',
  'many', 'may', 'might', 'more', 'most', 'much', 'must', 'need', 'never', 'new', 'newest', 'news', 'next', 'not',
  'now', 'off', 'old', 'once', 'one', 'only', 'onto', 'other', 'our', 'ours', 'out', 'over', 'own', 'per', 'plan',
  'put', 'report', 'said', 'same', 'say', 'see', 'set', 'she', 'should', 'show', 'since', 'some', 'soon', 'still',
  'such', 'take', 'tell', 'than', 'that', 'the', 'their', 'theirs', 'them', 'then', 'there', 'these', 'they', 'thing',
  'this', 'those', 'though', 'three', 'through', 'time', 'today', 'too', 'took', 'top', 'toward', 'two', 'under',
  'until', 'update', 'use', 'very', 'was', 'watch', 'way', 'week', 'well', 'were', 'what', 'when', 'where', 'whether',
  'which', 'while', 'who', 'why', 'will', 'with', 'within', 'without', 'would', 'year', 'yet', 'you', 'your',
]);

/** The minimum length of a token worth counting; shorter ones are noise. */
const MIN_TOKEN_LENGTH = 3;

/** A source link, narrowed to the only field threading looks at. */
interface ThreadSource {
  url: string;
}

/**
 * What threading needs to know about a story — a structural subset of
 * `NewsItem`, so a stored item can be passed straight in.
 *
 * `threadId` present and non-empty means **already decided**: the item keeps it
 * and joins the pool other items may match against. Absent (or empty) means
 * "work it out". That one distinction is what makes the same function serve both
 * a check (existing rows decided, new ones not) and the backfill (only the
 * unthreaded rows recomputed).
 */
export interface ThreadInput {
  id: string;
  title: string;
  foundAt: string;
  sources: readonly ThreadSource[];
  offTopic?: boolean;
  threadId?: string | undefined;
}

export interface ThreadOptions {
  /**
   * The topic these stories belong to. Its words are subtracted from both sides
   * of every comparison — see `STOPWORDS`. Optional only so the module can be
   * exercised without one; every real caller has it.
   */
  topicName?: string;
  /** Override the quiet-period cutoff (tests, and nothing else so far). */
  maxGapMs?: number;
}

/** Content, entity and host fingerprints of one title, plus its timestamp. */
interface Fingerprint {
  content: ReadonlySet<string>;
  entities: ReadonlySet<string>;
  hosts: ReadonlySet<string>;
  /** Epoch ms, or null when `foundAt` is unparseable (never joins anything). */
  at: number | null;
}

interface PoolEntry {
  id: string;
  threadId: string;
  fp: Fingerprint;
}

/**
 * Crudest possible singularisation: drop a trailing `s`.
 *
 * "recall" and "recalls" are the same word for this purpose, and a headline
 * pluralises whatever the previous one said in the singular. A real stemmer
 * would be more accurate and would also collapse words that mean different
 * things; this is the smallest change that stops the plural from costing a whole
 * shared token, which is a third of the join threshold.
 */
function singular(token: string): string {
  if (token.length <= MIN_TOKEN_LENGTH + 1) return token;
  if (!token.endsWith('s') || token.endsWith('ss') || token.endsWith('us') || token.endsWith('is')) return token;
  return token.slice(0, -1);
}

function meaningful(token: string, extraStop: ReadonlySet<string>): boolean {
  return token.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(token) && !extraStop.has(token);
}

function wordsOf(title: string): string[] {
  const normalized = normalizeTitle(title);
  return normalized === '' ? [] : normalized.split(' ');
}

/** The topic's own words, which are evidence of nothing inside that topic. */
function topicStopwords(topicName: string | undefined): ReadonlySet<string> {
  if (topicName === undefined || topicName.trim() === '') return new Set<string>();
  return new Set(wordsOf(topicName).map(singular));
}

/**
 * Capitalized words in the raw title — a cheap stand-in for proper nouns.
 *
 * The first word of a headline is capitalized whatever it is, so this
 * over-collects by exactly one word. That is why entity overlap on its own never
 * authorizes a join: it only lowers the shared-content requirement from three
 * words to two (see `matchScore`).
 */
function entitiesOf(title: string, extraStop: ReadonlySet<string>): Set<string> {
  const found = new Set<string>();
  for (const match of title.matchAll(/\p{Lu}[\p{L}\p{N}'’-]*/gu)) {
    for (const word of wordsOf(match[0])) {
      const token = singular(word);
      if (meaningful(token, extraStop)) found.add(token);
    }
  }
  return found;
}

function hostsOf(sources: readonly ThreadSource[]): Set<string> {
  const hosts = new Set<string>();
  for (const source of sources) {
    const normalized = normalizeUrl(source.url);
    if (normalized === null) continue;
    const host = normalized.split('/').at(0);
    if (host !== undefined && host !== '') hosts.add(host);
  }
  return hosts;
}

function fingerprintOf(item: ThreadInput, extraStop: ReadonlySet<string>): Fingerprint {
  const content = new Set<string>();
  for (const word of wordsOf(item.title)) {
    const token = singular(word);
    if (meaningful(token, extraStop)) content.add(token);
  }
  const at = Date.parse(item.foundAt);
  return {
    content,
    entities: entitiesOf(item.title, extraStop),
    hosts: hostsOf(item.sources),
    at: Number.isNaN(at) ? null : at,
  };
}

function sharedCount(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let shared = 0;
  for (const value of a) if (b.has(value)) shared += 1;
  return shared;
}

function sharesAny(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const value of a) if (b.has(value)) return true;
  return false;
}

/** How strong a match is, or null when the pair doesn't clear the gates. */
function matchScore(a: Fingerprint, b: Fingerprint, maxGapMs: number): { score: number; gap: number } | null {
  if (a.at === null || b.at === null) return null;
  const gap = Math.abs(a.at - b.at);
  if (gap > maxGapMs) return null;

  const shared = sharedCount(a.content, b.content);
  if (shared < THREAD_MIN_SHARED_TOKENS) return null;
  const sharedEntities = sharedCount(a.entities, b.entities);
  if (shared < THREAD_MIN_SHARED_TOKENS_ALONE && sharedEntities === 0) return null;

  const smaller = Math.min(a.content.size, b.content.size);
  if (smaller === 0) return null;
  const ratio = shared / smaller;
  if (ratio < THREAD_MIN_OVERLAP_RATIO) return null;

  // Shared host is a **tie-breaker only**, never what lifts a pair over the
  // line: inside one topic the same outlet recurs constantly, so "both from
  // reuters.com" is close to no information. It earns a quarter point, enough to
  // order two otherwise-equal candidates and not enough to change any verdict.
  const sameHost = sharesAny(a.hosts, b.hosts) ? 0.25 : 0;
  return { score: shared + 2 * sharedEntities + ratio + sameHost, gap };
}

interface Best {
  threadId: string;
  id: string;
  score: number;
  gap: number;
}

/** Deterministic ordering: strongest match, then closest in time, then lowest id. */
function beats(candidate: Best, incumbent: Best): boolean {
  if (candidate.score !== incumbent.score) return candidate.score > incumbent.score;
  if (candidate.gap !== incumbent.gap) return candidate.gap < incumbent.gap;
  return candidate.id < incumbent.id;
}

/**
 * Decide a thread id for every item, in the order given.
 *
 * Items carrying a `threadId` keep it; the rest are matched against everything
 * before them in the list. Pass a topic's items **chronologically** for the
 * canonical result — that ordering is what the backfill replays, and what makes
 * it deterministic.
 *
 * ## Pairwise-nearest, and never a merge
 *
 * A story joins the thread of the single **best-matching individual story**, not
 * the union of everything it resembles. Two consequences, both deliberate:
 *
 * - **Membership is transitive by emergence, not by union.** C matching B joins
 *   B's thread, which may be A's — so chains form. But a story that resembles
 *   two existing threads picks one; the threads are never merged. Merging is
 *   where transitive clustering drifts, because one weak bridge silently welds
 *   two unrelated runs of stories into a single "story so far" and there is then
 *   no evidence left of which link was the bad one.
 * - **Already-decided ids are never rewritten.** Threading a new story cannot
 *   change what an existing story belongs to, so a thread the user has already
 *   seen cannot reshuffle underneath them.
 *
 * Flagged (`offTopic`) stories neither join threads nor offer themselves as
 * matches: the user has said the story does not belong to the topic, and a
 * subject they rejected should not become the spine of a thread. They stay
 * threads of one, which is also what keeps a flag from changing anything else's
 * grouping.
 */
export function planThreadIds(items: readonly ThreadInput[], opts: ThreadOptions = {}): string[] {
  const extraStop = topicStopwords(opts.topicName);
  const maxGapMs = opts.maxGapMs ?? THREAD_MAX_GAP_MS;
  const pool: PoolEntry[] = [];
  const assigned: string[] = [];

  for (const item of items) {
    const decided = item.threadId !== undefined && item.threadId !== '' ? item.threadId : null;
    const flagged = item.offTopic === true;
    const fp = fingerprintOf(item, extraStop);
    let threadId = decided ?? item.id;

    if (decided === null && !flagged) {
      let best: Best | null = null;
      for (const entry of pool) {
        if (entry.id === item.id) continue;
        const match = matchScore(fp, entry.fp, maxGapMs);
        if (match === null) continue;
        const contender: Best = { threadId: entry.threadId, id: entry.id, score: match.score, gap: match.gap };
        if (best === null || beats(contender, best)) best = contender;
      }
      if (best !== null) threadId = best.threadId;
    }

    assigned.push(threadId);
    if (!flagged) pool.push({ id: item.id, threadId, fp });
  }

  return assigned;
}

/**
 * The thread id one candidate should take, given a topic's existing stories.
 *
 * `existing` must already carry thread ids; the candidate's own is ignored. The
 * single-item form of `planThreadIds`, kept because it is what a reader of
 * `checks.ts` or a test actually wants to say.
 */
export function threadIdFor(candidate: ThreadInput, existing: readonly ThreadInput[], opts: ThreadOptions = {}): string {
  const plan = planThreadIds([...existing, { ...candidate, threadId: undefined }], opts);
  return plan.at(-1) ?? candidate.id;
}

/** `items` with a thread id attached to each — what a batch insert needs. */
export function withThreadIds<T extends ThreadInput>(
  candidates: readonly T[],
  existing: readonly ThreadInput[],
  opts: ThreadOptions = {},
): (T & { threadId: string })[] {
  const plan = planThreadIds(
    [...existing, ...candidates.map((c) => ({ ...c, threadId: undefined }))],
    opts,
  );
  const tail = plan.slice(existing.length);
  return candidates.map((candidate, i) => ({ ...candidate, threadId: tail.at(i) ?? candidate.id }));
}
