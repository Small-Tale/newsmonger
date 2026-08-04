# 29 — Story Threads

How the app knows that a story is the fourth update on something rather than a standalone item.

A **thread** is the set of stories in one topic about the same *developing subject*. Every story has a `threadId`, and a story that joined nothing carries its own id — so a thread of one is the ordinary case and needs no special handling anywhere downstream.

This is the foundation of the "story so far": once stories are grouped, a card can show its own history (NEWS-281, NEWS-282) instead of presenting the fifth twist in an ongoing saga as though nothing had come before it.

## Threading is not deduplication

They are different questions, and conflating them is the mistake this doc exists to prevent. See [2 — News Checks and Deduplication](2-news-checks-and-dedup.md) for the other half.

| | Dedup (`dedupeKey`) | Threading (`threadId`) |
|---|---|---|
| Question | *Is this the same article?* | *Is this the same story unfolding?* |
| Built from | the first source's normalized URL (`host+path`), falling back to the normalized title | title similarity, entity overlap and recency across the topic's history |
| Compared how | **exact string match** against `store.dedupeKeysForTopic()` | scored, with thresholds |
| Outcome | the story is **dropped** | the story is **kept and grouped** |

- **FR-29.1** Threading is computed, not derived from `dedupeKey`. A dedupe key has no notion of subject: two outlets covering one event produce two different keys, which is precisely why the same event can already appear twice in a feed. Nothing about two keys' proximity says anything about whether the stories are related — `url:news.example.com/a` and `url:times.example.com/b` are as far apart as any two strings.
- **FR-29.2** Dedup runs first and threading second, on what survives. Dedup decides what is *stored*; threading only ever describes stored stories. A story dropped as a duplicate never had a thread to be in.
- **FR-29.3** Threads are **per topic**, like dedup (FR-2.9). The same event under two topics is two stories, and they are in two different threads — because a thread is read within a topic's feed, and "the story so far" for *Flooding* is not the same narrative as for *Infrastructure*.

## The data model

- **FR-29.4** `NewsItem.threadId: string` (`src/db/schemas.ts`), stored as `items.thread_id` with the index `items_topic_thread(topic_id, thread_id)`.
- **FR-29.5** A thread is named by **the id of its first story**, not a synthetic group id. A thread always has a story that started it, so inventing a second kind of identifier would mean two things to keep in step and a group id that could outlive its stories.
- **FR-29.6** **Every story is a thread of one until something joins it.** `threadId` defaults to the story's own id — on write (`Store.addItems`) and on read (`NewsItemSchema`, which reads an empty stored value as the row's own id). So no reader ever has to handle "unthreaded": the thread of a lone story is that story.
- **FR-29.7** Validated on read like every other field. The schema is a `z.object(...).transform(...)` rather than a plain object precisely so the default can refer to a sibling field; nothing crosses the boundary with a cast.
- **FR-29.8** `Store.threadForItem(id)` returns a story's whole thread **oldest first** — a thread is read as a sequence, because the point of showing it is *how we got here*. Flagged stories are left out, matching what the feed shows (see [15 — Off-Topic Flagging](15-off-topic-flagging.md)), except the requested story itself: answering "nothing" about a story someone is looking at would be a worse lie than showing it. An unknown id returns an empty list.

## The signals

All local, in `src/threads.ts`: pure functions, no I/O, no model call, no cost. That is what lets the same code thread stories as they land *and* group rows already in the database.

- **FR-29.9** **Content-word overlap.** Titles are normalized with the same `normalizeTitle` dedup uses, crudely singularized (a trailing `s` dropped, so "recall" and "recalls" are one word), and reduced to words of three characters or more that are not stopwords.
- **FR-29.10** **The topic's own name is a stopword.** Inside a topic, the topic's words are shared by nearly every story it will ever produce, so counting them as evidence would thread the whole topic together. This single subtraction does more for precision than the stopword list does: it is what keeps "Major development in Formula One" and "Formula One: what experts are watching next" apart.
- **FR-29.11** **Capitalized-entity overlap** — a cheap stand-in for proper nouns, taken from the raw title. A headline's first word is capitalized whatever it is, so this over-collects by about one word per title; that is why entity overlap **never authorizes a join on its own**. It only lowers the content-word requirement.
- **FR-29.12** **Shared source host is a tie-breaker only** (a quarter of a point), never what lifts a pair over the line. Within one topic the same outlet recurs constantly, so "both from reuters.com" is nearly no information — and the interesting case is the opposite one, two *different* outlets on one subject.
- **FR-29.13** **A recency window** (`THREAD_MAX_GAP_MS`, 30 days) measured pairwise as an absolute gap. A thread that keeps being updated therefore keeps extending indefinitely — each update is close to the one before — while a subject nothing has touched for a month stops accreting, because the anniversary piece is a new story rather than the next instalment. Absolute, not signed, so a story arriving out of chronological order is judged the same way.
- **FR-29.14** A story whose `foundAt` cannot be parsed joins nothing. An unusable timestamp means the recency window cannot be evaluated, and the bias is to leave it alone.

### The thresholds, and why they are set low-recall

- **FR-29.15** A pair joins only when **all** of these hold: within the recency window; **three shared content words**, or **two** when at least one capitalized entity is also shared; and the shared words are **at least 40%** of the shorter title's content words.
- **FR-29.16** **A false join is worse than a missed one, and the thresholds are tuned accordingly.** Missing a thread leaves a story looking standalone — which is what every story looked like before this existed, so the cost is zero new wrongness. A false join files a story under a headline it has nothing to do with, and presents that with the same confidence as a real one. So every gate is set to leave items unthreaded when the evidence is thin.

### Pairwise-nearest, never a merge

- **FR-29.17** A story joins the thread of the **single best-matching individual story**: strongest score, then closest in time, then lowest id (so the outcome is deterministic, not dependent on row order).
- **FR-29.18** **Membership is transitive by emergence, not by union.** C matching B takes B's thread, which may be A's, so chains form naturally. But a story resembling two existing threads picks one — the threads are never merged. Merging is where transitive clustering drifts: one weak bridge silently welds two unrelated runs of stories into a single "story so far", and afterwards there is no evidence left of which link was the bad one. Emergent chaining still drifts a little, and the recency window is what bounds it: a subject has to keep being updated to keep growing.
- **FR-29.19** **An already-decided thread id is never rewritten** by threading a new story. A thread the user has already seen cannot reshuffle underneath them.
- **FR-29.20** **Flagged (`offTopic`) stories do not participate.** They neither join threads nor offer themselves as match targets: the user has said the story does not belong to this topic, so it must not become the spine of a thread. Flagging a story *after* it joined one does not un-thread the row — it only stops `threadForItem` showing it (FR-29.8), so unflagging restores the grouping rather than having to recompute it.

## When threading happens

- **FR-29.21** **At check time**, in `CheckRunner.checkTopic` — after `filterNewItems` and before the insert, against the topic's history read fresh at that moment (not the `known` list taken before a multi-minute provider call). Stories in one batch are threaded against each other as well as against history, so two outlets' coverage arriving in the same check lands in one thread. Item ids are minted in the runner rather than by the store, because thread assignment refers to sibling stories by id.
- **FR-29.22** **A backfill at startup** (`Store.backfillThreads()`, called from `src/cli.ts` after the retention prunes so it never threads a story about to be deleted). It groups what is already stored — rows from before this existed, and rows that arrived out of chronological order.
- **FR-29.23** The backfill is **deterministic**: each topic is replayed strictly in `(found_at, id)` order and a story is only ever matched against stories *before* it, so an assignment never depends on what arrived later. Chronological replay is the canonical assignment; a story that arrived late gets the grouping it would have had if it had arrived in order.
- **FR-29.24** The backfill is **idempotent**: `thread_id = id` (a thread of one) is the "not yet grouped" marker, a story that recomputes to a thread of one recomputes to the same thing forever, and rows that already joined a thread are skipped outright. Running it twice changes nothing the second time — which is what makes it safe to run on every start, and what the tests assert directly.
- **FR-29.25** The schema migration (v4 → v5) sets every existing row's `thread_id` to its own id. Existing stories become threads of one, which is exactly what they were, and the invariant "a thread id names a story" holds from the first read; the backfill then groups them for real.

## What this does *not* do

- **FR-29.26** **No model-reported linking.** A check could in principle be asked "does this continue known story X" — it already sees the last 60 titles (`MAX_KNOWN_ITEMS`) — and that would raise precision. It cannot replace this layer: the window will not reach a thread whose last update was months ago, and it cannot label stories already in the database. Filed separately (NEWS-284).
- **FR-29.27** **No UI yet.** `threadId` rides the existing `/api/items` payload because it is part of `NewsItem`, which is what makes it assertable end to end; the expandable card (NEWS-281) and the thread API route (NEWS-282) are separate changes.

## Tests

- **Unit** — `tests/unit/threads.test.ts`: the similarity module directly (same-subject/different-outlet pairs join; unrelated stories in one topic do not; stopword-only and topic-name-only overlap do not; the ratio gate; the recency cutoff on both sides; flagged stories excluded), then the store's round-trip, `threadForItem`, and the backfill's idempotency (run twice, identical mapping and a second-pass count of zero).
- **Transition matrix / adversarial** — in the same file, because this module is stateful across a topic's whole history: empty → thread of one → thread of two → a second thread; a live thread extending past the window from its oldest member; a thread going quiet and reviving (and what follows joining the *revival*, not the stale thread); stories arriving out of chronological order; a topic cleared and refilled (asserting no new story inherits a cleared story's id); an undo restoring the ids it took; a mid-history story arriving late and being regrouped by the next backfill; the same subject twice in one batch; stories orphaned by a deleted topic.
- **Migration** — a pre-thread (v4) database is opened, keeps both stories, and threads them. The regression it pins is **data loss**, not a missing column: `items_topic_thread` was first created alongside the tables, which run *before* the migrations, so opening any existing database threw `no such column: thread_id` — which `Store` correctly reads as corruption and answers by backing the file up and starting fresh. `src/db/sqlite.ts` now runs **TABLES → MIGRATIONS → INDEXES**, and that ordering holds for every future column too.
- **E2E** — `tests/e2e/threads.spec.ts`: a check producing two outlets' coverage of one subject lands both in a single thread named by a real story's id, and the mock's default unrelated pair stays two threads of one. Reachable because the mock provider answers a topic whose name contains **"thread"** with a single-subject pair (see [6 — AI Providers](6-providers.md)).

See also: [2 — News Checks and Deduplication](2-news-checks-and-dedup.md), [15 — Off-Topic Flagging](15-off-topic-flagging.md), [4 — CLI, Server, and Storage](4-cli-server-storage.md).
