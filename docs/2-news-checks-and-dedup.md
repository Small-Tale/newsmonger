# 2 — News Checks and Deduplication

How a check turns a topic name into deduplicated, summarized news items.

## AI provider integration

Checks run through a pluggable **provider** abstraction (`src/ai/providers/`, see [6 — AI Providers](6-providers.md)). The provider is a persisted setting; the default `auto` resolves to the best available web-searching provider.

- **FR-2.1** The default provider is Anthropic — Claude (`claude-opus-4-8`) via the Anthropic API with adaptive thinking and the `web_search_20260209` server tool (max 8 searches per check), streamed to avoid HTTP timeouts. OpenAI plugs in behind the same interface. Only platforms that search the web themselves are supported.
- **FR-2.2** The prompt includes: the topic name, the current date, the last-checked time (first checks focus on roughly the past week), and the titles of up to 60 previously reported stories with instructions not to re-report them.
- **FR-2.3** The model returns a fenced JSON block `{"items": [{title, summary, sources: [{title, url}]}]}`; an empty list means "no new news" and is a successful check. Parsing accepts the last fenced block or a bare trailing JSON object; anything else fails the check.
- **FR-2.4** Summaries are 2–4 sentences; each story carries at least one link to a news article.
- **FR-2.5** The active provider must be available (e.g. `ANTHROPIC_API_KEY` set) for real checks; the CLI warns at startup when the Anthropic key is missing under an `auto`/`anthropic` provider. `--ai-test` (or `--provider mock`) substitutes a deterministic mock provider (used by E2E tests and offline development). Which provider ran a check is recorded on the `CheckRun`.
- **FR-2.6** A refusal or unparseable response fails the check; the error is recorded on the run.

## Deduplication

- **FR-2.7** Every stored item has a `dedupeKey`: the normalized URL of its first parseable source (`host+path`, lowercased, `www.` stripped, query/hash/trailing-slash dropped), falling back to the normalized title (lowercased, punctuation stripped, whitespace collapsed).
- **FR-2.8** Found stories whose key matches an already-stored item for that topic are dropped (second line of defense after the prompt-level exclusion). Duplicates within a single batch are also collapsed.
- **FR-2.9** Dedup scope is per-topic: the same story may legitimately appear under two different topics.
- **FR-2.10** If the topic is deleted while its check is in flight, the results are discarded.

### Deduplication is not threading

`dedupeKey` answers **"is this the same article?"** — it is a URL identity with no notion of subject. Grouping stories about the same *developing subject* is a separate concern, computed separately, and documented in [29 — Story Threads](29-story-threads.md).

The distinction is load-bearing rather than pedantic. Two outlets covering one event yield two different dedupe keys, which is exactly why both are stored and both appear in the feed — so key proximity cannot be read as relatedness, and thread membership has to be computed from the titles themselves. The two also have opposite outcomes: dedup **drops** a story, threading **keeps and groups** it. Dedup runs first; threading only ever describes what survived it.

## What a clear resets

- **FR-2.13** *(Shipped, NEWS-291)* **Clearing a topic's stories clears what we have seen for that topic**, and returns the topic to its initial check state. The scheduling half of this rule — why a cleared topic reads as never checked without becoming due — is [FR-1.15](1-topics-and-scheduling.md).

  The question this answers is whether a clear leaves a hidden ledger behind that would stop the same news being found again. It does not, and the reason is worth stating: **`items` *is* the ledger.** There is no separate "stories we have seen" table to forget. Everything derived from it goes when the rows go:

  | Derived from `items` | Read by |
  |---|---|
  | `dedupeKeysForTopic` | the dedup filter (FR-2.8) — so a cleared topic can find the same stories again |
  | `offTopicTitlesForTopic` | the prompt's negative examples (FR-15.x) |
  | `itemStatsByTopic` | the sidebar's today-count badge and the most-recent sort |
  | `flaggedCountsByTopic` | the "Review flagged" badge |
  | `latestItemIds` | new-story notifications |
  | `thread_id` and every thread read off it | story threads (NEWS-280, [29](29-story-threads.md)) — a thread is a set of `items` rows, so there is no thread table to orphan |

  The columns a clear resets, and the one it sets:

  | Column | On a clear | Why |
  |---|---|---|
  | `covered_through_at` | → null | the prompt's window; a cleared topic must ask from scratch, not resume from where the vanished stories left off |
  | `last_checked_at` | → null | what every "checked N ago" surface reads (FR-1.5) |
  | `consecutive_failures` | → 0 | a failure streak is a fact about stories we no longer hold |
  | `retry_after` | → null | a cooldown outranks the schedule, so carrying one in would hold back a check nobody has asked for yet |
  | `cleared_at` | → now | the scheduling baseline that lets `last_checked_at` go to null safely |

  Deliberately untouched: `id`, `created_at`, `name`, `guidance`, `paused`, `high_priority`, `category`/`subcategory`/`category_source`. A clear discards *findings*, not the user's preferences for the topic. Re-classifying in particular would spend a model call to relearn something already known, and would discard a manual classification (FR-22.7).

  **The one thing that survives on purpose is the `runs` history.** It records what the app *did*, not what the topic is about, and Diagnostics (FR-3.25–3.28), the failure banner (FR-3.x) and the falling-behind detector (FR-13.3a) all read it. This is the single respect in which a clear is not the same as deleting and re-adding the topic — a delete cascades its runs, a clear keeps them. Consequence worth knowing: a topic whose last check *failed* keeps that failed run, so the failure banner can still name it after a clear even though the topic's own streak has been reset.

  Both clear paths apply the same reset — `clearItemsForTopic` (per topic, offered with a rename) and `clearAllItems` (app-wide). They are separate implementations for the reasons in FR-27.11, so they share the reset SQL rather than one calling the other.

## Sanitizing model output

Titles, summaries and source titles are stripped of markup at the boundary (`src/ai/sanitize.ts`), on both write and read.

Web-searching models emit their own citation markup inside the JSON strings we asked for — Claude's `web_search` tool wraps cited sentences in `<cite index="11-2,11-3">…</cite>`. The UI escapes everything it renders, as it should, so those tags surfaced as literal text in the middle of a summary.

- **Tags are removed, contents kept.** The text inside a `<cite>` is the actual sentence, not decoration.
- **Applied at parse time** (`ResultSchema`) so nothing downstream needs to know, **and at read time** (`NewsItemSchema`) so items stored before the fix are cleaned when the data file loads — no migration needed. `stripMarkup` is idempotent, which is what makes applying it twice safe.
- **URLs are never touched.** A URL is data; mangling it breaks the link rather than tidying it.
- **Conservative about what counts as a tag** — the pattern requires a letter straight after `<`, so a summary containing `profits fell < 5%` survives intact.

The prompt also asks for plain prose, but that is belt-and-braces: the markup comes from the tool layer rather than the model's own writing, so instructions don't reliably suppress it. Cleaning at the boundary doesn't depend on the model cooperating.

## How much comes back

A check returns a **digest, not an archive**: the handful of significant stories someone can read in one sitting. A longer gap means covering a **wider span of time, not proportionally more stories** — what bounds a useful check is how much a person will actually read, and that doesn't grow because they were away longer.

That rule lives in the shared system prompt (`searchingSystemPrompt()`), which is the only layer every provider inherits:

- `anthropic` also caps its server tool at `max_uses: 8` — a cost/latency guard, kept as belt-and-braces.
- `openai`'s hosted `web_search` takes **no equivalent cap**, so without the prompt rule a long catch-up there would be unbounded.
- The CLI providers (see [6 — AI Providers](6-providers.md)) run their own agentic loops and likewise have no tool-level ceiling.

The existing anti-padding rule ("Do not pad with old or marginal stories") is a different constraint: it prevents **filler** when there's little news, whereas this bounds **volume** when there's a lot.

The catch-up wording below restates the bound rather than relying on the system prompt alone. "Cover the whole period" is exactly the instruction that reads as an invitation to return proportionally more, so it has to be contradicted in the same breath.

## Describing the window to cover

The prompt states the gap in words, not just a timestamp, and changes shape with its size:

| Gap | Line sent |
|---|---|
| never checked | "This is the first check for this topic — focus on notable news from roughly the past week." |
| < 1 hour | "Last checked less than an hour ago (`<iso>`) — focus on developments since then." |
| hours | "Last checked 5 hours ago (`<iso>`) — …" |
| ~1 day | "Last checked 1 day ago (`<iso>`) — …" (the default interval; an ordinary cadence, not a backlog) |
| ≥ 2 days | "Last checked 5 days ago (`<iso>`). Nothing has been reported for this topic in that time, so cover the significant developments across the whole period — not just the last day or two. Order them oldest to newest." |

A bare "focus on developments since `<timestamp>`" reads identically whether the gap is two hours or three weeks, and invites the model to report only the most recent day either way. Long gaps stopped being exceptional once subscription-backed providers were gated on the app being foregrounded — a user who doesn't open the app all week genuinely needs the whole week — so past two days the span is named and the expectation set explicitly. Two days is the threshold because the default interval is one day, so anything beyond it means a cycle was missed.

## Verifying citations (NEWS-83)

Source URLs come from the model. The live-API check on 2026-07-24 found every citation resolved, but that is one good run on one provider — and a dead or hallucinated link is the failure mode that most damages trust in an AI news product.

> **These were FR-2.6–2.10 until NEWS-302**, which is what FR-2.6–2.10 at the top of this document also say — five ids naming two unrelated sets of requirements each. The originals keep their numbers because they are the more widely cited; this block moved to **FR-2.14–2.18**. Not 2.11–2.15 as the ticket proposed: 2.11–2.13 were taken by NEWS-257 and NEWS-291 in the interval. An old citation of "FR-2.6–2.10 citation verification" means the block below.

- **FR-2.14** *(Shipped)* Before anything is stored, each source URL is probed: `HEAD` first, falling back to a **ranged `GET`**, because a surprising number of news sites answer HEAD with 403 or 405 while serving the page perfectly well — treating those as dead would delete good stories, which is worse than the problem being solved. 6-second timeout, at most 4 probes in flight, and each distinct URL probed **once per batch** (several stories routinely cite the same outlet).

- **FR-2.15** *(Shipped)* **A dead source is pruned; a story is dropped only when *nothing* it cites resolves.** A story with three citations where one 404s is still a real story. A story that cites nothing reachable is the one that shouldn't be shown.

- **FR-2.16** *(Shipped)* Verification runs **before** deduplication, not after. If a dropped story still claimed its dedupe key, the real version of the same story would be filtered out as a duplicate on the next check and never appear at all.

- **FR-2.17** *(Shipped)* It **reuses the image pipeline's SSRF vetting** (`src/images/safety.ts`) rather than opening a second fetch path — these URLs come from a model, so the same protocol / hostname / post-DNS-address rules apply.

- **FR-2.18** *(Shipped)* Best-effort, like image fetching: if the verifier itself throws, stories go through **unverified** rather than the check failing. No news at all is a worse outcome than a story with an unchecked link. A story that arrived with *no* sources is passed through untouched — that is a prompt-compliance problem, not something to silently delete here.

  The probe is injected (`CheckRunner`'s 5th argument); `--ai-test` passes null, since the mock's URLs are fictional and every story would otherwise be dropped.

## Cancelling a check the settings have outrun (NEWS-257)

- **FR-2.11** *(Shipped, NEWS-257)* **Changing provider, model or effort cancels any check already in flight.** Those requests were issued under settings the user has since changed, so the answer would be to a question they had already changed — and on a subscription it spends plan quota to produce it. `PATCH /api/settings` calls `CheckRunner.cancelStaleChecks()` when one of those three fields moves; an interval or retention edit does not cancel anything, because it does not make an in-flight answer wrong.

  Each in-flight check records the `provider|model|effort` it went out under, so "stale" is a comparison rather than a guess — a check already running under the *new* settings is left alone.

  **It is a real abort, not a discarded result.** An `AbortSignal` reaches both SDKs (`messages.stream(…, { signal })`, `responses.create(…, { signal })`), and for the CLI agents it kills the child process — the same `SIGTERM` the ten-minute timeout already used, because a subscription agent left running keeps spending quota on the abandoned question. The retry loop checks the signal at the top of every attempt as well as after the request, so an abort landing during a backoff sleep is not answered by trying again.

  **A cancelled check records nothing.** Its run row is deleted rather than marked failed: `runs` feeds the failure banner and the falling-behind detector (FR-13.3a), and neither should fire over something the user chose to stop. No `cancelled` status was added — that would widen an enum older builds validate on read, and a check that produced nothing may as well leave nothing.

  *Nothing* has been literal only since NEWS-291. The cancellation path used to fall through the ordinary failure bookkeeping on its way out, so stopping a check gave its topic a `consecutiveFailures` of 1 and a two-minute `retryAfter` — invisible, because the run row was then deleted, but real. It made FR-2.12's promise below false (the cooldown outranks the schedule, so the topic was *not* left due), and after a clear it landed a microtask **after** the reset and quietly undid it. The cancellation now returns before any of that runs.

- **FR-2.12** *(Shipped, NEWS-257)* **Only *manual* checks are reissued.** `lastCheckedAt` is untouched by a cancellation, so a cancelled scheduled check leaves its topic due and the next tick picks it up under the new settings unaided. Reissuing those here would re-spend quota every time someone browsed the dropdowns — which is precisely the interaction this feature invites.

  Reissues are **coalesced** over a short window (750 ms; tests pass 0). Changing provider is never one settings write: the client then corrects the model to something the new provider offers, and the effort to something that model accepts (FR-6.15, FR-6.13a). Reissuing per write would start and kill the same check three times.

## Steering what a check looks for

Beyond the topic name, two user signals reach the prompt through `TopicContext`:

- the topic's **guidance** — what the user wrote they want (see [18 — Topic Guidance](18-topic-guidance.md)), stated as an instruction that takes precedence over the model's own sense of what is newsworthy;
- the titles of stories they **flagged off-topic** (see [15 — Off-Topic Flagging](15-off-topic-flagging.md)), as negative examples.

Guidance comes first in the prompt: it is what the user said, where the flags are only what their behaviour implied.

See also: [1 — Topics and Scheduling](1-topics-and-scheduling.md), [15 — Off-Topic Flagging](15-off-topic-flagging.md), [18 — Topic Guidance](18-topic-guidance.md), [29 — Story Threads](29-story-threads.md).
