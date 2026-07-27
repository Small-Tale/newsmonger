# 19 — Cost Visibility

A check on the default configuration runs `claude-opus-4-8` with web search against every topic, every day. That is real money, and before this the app said nothing about it: the only acknowledgement of cost anywhere in the codebase was a comment on `max_uses: 8` in the Anthropic provider. For a bring-your-own-key product that is both a trust problem and a support problem — "why is my Anthropic bill $40?" is a question the app should be able to answer.

See also [6 — AI Providers](6-providers.md) and [4 — CLI, Server, and Storage](4-cli-server-storage.md).

## Status: shipped

### Capturing usage

- **FR-19.1** *(Shipped)* A provider returns a `CheckResult` — `{ items, usage }` — rather than a bare item list. `usage` is a `TokenUsage`: input, cache-read, cache-write and output token counts, plus the number of server-side web searches.

- **FR-19.2** *(Shipped)* `usage` is **nullable, and null means unknown — never zero.** The subscription CLI providers (`claude-cli`, `codex-cli`) spend plan quota rather than metered dollars and report no token counts at all; calling that $0.00 would be a lie in the user's favour, and a spend figure's whole job is to keep "unknown" and "free" apart.

- **FR-19.3** *(Shipped)* Usage is persisted on the `CheckRun`, alongside the `model` it ran on. Both default to null on load, so a run recorded before this feature simply reads as unpriceable.

  > OpenAI's Responses API reports no hosted-web-search count, so `webSearches` is 0 for that provider — an undercount if OpenAI charges per hosted search. Flagged rather than buried; a user who prices OpenAI models in `prices.json` (FR-19.5a) should know the search line is missing.

### Pricing

- **FR-19.4** *(Shipped)* **Counts are stored; money is derived.** `estimateCostUsd(model, usage, prices)` computes a cost at display time from whatever table is live. Storing dollars instead would mean a vendor price change silently made every historical total wrong, with no way to correct it.

- **FR-19.5** *(Shipped)* The price table is deliberately **not exhaustive and never guessed**. A model absent from it yields no estimate at all, rather than a plausible-looking wrong one — a fabricated rate is a number the user might act on, and the budget cap would act on it too.

- **FR-19.5a** *(Shipped)* **Rates are updatable without a new build** (NEWS-93). They change on the vendors' schedule — introductory pricing ends, models land, tiers move — so a release cycle is the wrong shape for them. Three layers, each falling back to the one beneath:

  1. **`<data-dir>/prices.json`** is the live table. It is seeded from the built-ins on first run (so there is always something concrete to open rather than a format to invent), and **hand edits apply on the next read** — no restart. Cached on mtime so the check is cheap.
  2. **`settings.priceManifestUrl`**, when set, is fetched at startup and daily and replaces the file, so corrected rates can be published centrally. **https only** — the manifest decides what the budget cap acts on, and plaintext could be swapped in transit.
  3. **The compiled-in table** is the floor.

  Failure at any layer costs the *update*, never the estimate: a missing file, a JSON typo, or an unreachable manifest all leave the last good table standing, and a malformed hand edit says so on stderr rather than silently switching every model to "unknown".

  This is also why **OpenAI models being absent from the shipped defaults is no longer a dead end** — an OpenAI user adds them to `prices.json` themselves. The `verifiedOn` shown in the UI comes from the *live* table, so it dates the rates actually in use rather than whenever the build was cut.

- **FR-19.6** *(Shipped)* Cache reads are priced at 0.1× base input and 5-minute cache writes at 1.25×, matching Anthropic's published multipliers; web search is $10 per 1,000 searches. Sonnet 5's **post-introductory** rate is used rather than the promotional one: an estimate that overstates is the safe direction for a spend cap, and it becomes exactly right when the promotion ends.

### Showing it

- **FR-19.7** *(Shipped)* `/api/state` carries a `spend` block for the current calendar month: the total, how many runs were priced, **how many could not be**, the configured cap, whether it has been reached, and the price-verification date.

- **FR-19.8** *(Shipped)* The unpriced count travels *with* the total by design. A bare number reads as complete; the Settings panel names how many checks are missing from it and why ("those are missing from the total, not free"). With nothing priceable at all, the figure is an em dash rather than `$0.00`.

- **FR-19.9** *(Shipped)* A nonzero cost under a cent renders as `<$0.01`, never `$0.00`.

### The budget cap

- **FR-19.10** *(Shipped)* An optional `monthlyBudgetUsd` setting (0 = off), edited in Settings. It commits on `change` rather than on every keystroke — a PATCH per character would round-trip `1`, `12`, `125` and fight the 4 s state poll for the field.

- **FR-19.11** *(Shipped)* Reaching the cap (`>=`, not `>`) pauses **scheduled** checks — the same shape as the attendance gate in [6 — AI Providers](6-providers.md). Manual checks are never gated, so a reached budget stops the app spending on its own without locking the user out of it. A banner says exactly that.

- **FR-19.12** *(Shipped)* The gate can only act on what it can price. Unpriced runs count as unknown, not as zero, so a provider that reports no usage is never held back by a budget it cannot be measured against — stated plainly in the UI rather than papered over.

- **FR-19.13** *(Shipped, revised NEWS-103)* The spend horizon is the calendar month **within the retained run history**, and that history is now **400 days** — so a calendar month, and a rolling year, are complete in ordinary use. It was the last 200 runs, which on a busy install was under an hour: a "this month" total could quietly cover an afternoon.

  The one condition left: run history is also capped at **25,000 rows** as a backstop against unbounded growth (runs accrue per topic per check, so a short interval across many topics can produce thousands a day). Exceeding that inside 400 days shortens the window again. It takes roughly 60 checks a day sustained for over a year — far above normal use, where 20 topics checked daily is ~7,300 runs a year — but the figure remains an estimate and is still labelled one.

  Retention is applied by `Store.pruneOldRuns`, in the same housekeeping sweep as story retention rather than on every `startRun`: enforcing a 25,000-row ceiling on each insert would mean re-scanning 25,000 rowids per check to bound something nothing is near.

## Testing

- **Unit** (`tests/unit/price-store.test.ts`, 12 tests): the file is seeded on first run; **a hand edit applies with no restart**; a user can price a model the build never shipped; a JSON typo *and* a schema-invalid edit both keep the last good table; a deleted file falls back to the built-ins; the manifest replaces the table, refuses non-https, and leaves prices alone on network failure, a 404, or a wrong-shape body; and **historical runs reprice when the table changes** — the reason costs are derived rather than stored.
- **Unit** (`tests/unit/cost.test.ts`, 22 tests): rate arithmetic against the published numbers (tokens, cache multipliers, per-search charge, a realistic single check); null for absent usage *and* for an unpriced model; price-table internal consistency; `formatUsd` never emitting a misleading `$0.00`; usage recorded on success, absent on failure with the model still attributed, persisted across a reload, and a pre-NEWS-79 run record loading cleanly; `spendSince` window and in-flight exclusion; the cap boundary (`4.99` / `5` / `5.01`), a gated scheduled sweep, and **manual checks running anyway**; the `/api/state` spend block and the settings route accepting/rejecting a budget.
- **E2E** (`tests/e2e/app.spec.ts`): the Settings spend section renders with an em dash when nothing is priceable, and a budget typed into the field round-trips to the server and clears back to "no limit".
- The **live** usage-capture path (a real Anthropic response's `usage` block) is manual, like the rest of the real-API path — see `manual-test-plan.md`.
