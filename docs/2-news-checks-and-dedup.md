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

See also: [1 — Topics and Scheduling](1-topics-and-scheduling.md).
