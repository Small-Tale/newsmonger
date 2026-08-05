# 24 — Topic Discovery

Naming a topic requires already knowing you want it. That is fine for the two or three subjects anyone can list from memory, and it is the whole reason the sidebar stops at three: the app asks for a search query when what the user actually wants is a *browsing* surface. The gap shows up hardest at first run — onboarding offers six hard-coded starter chips (FR-20.6) and nothing behind them — but it does not close afterwards. A month in, the feed reflects the topics its owner could think of on day one.

See also [1 — Topics and Scheduling](1-topics-and-scheduling.md), [20 — First-Run Onboarding](20-onboarding.md), [22 — Topic Categories](22-topic-categories.md), [18 — Topic Guidance](18-topic-guidance.md), [6 — AI Providers](6-providers.md).

## Status: shipped (NEWS-116, 124–128). Variation D deferred — see NEWS-129

Four variations were wireframed and reviewed (recorded under "Variations considered" below). The approved shape is **two entry doors into one result list, with a keep/skip tuner as the depth control** — not as a third door.

That last part is the decision worth stating plainly, because it is what the brainstorm got wrong. The tuner was proposed as a *rival* entry point, and its problem was that it forced everyone through a slow, expensive round-trip loop before they saw anything. As a **depth control** it costs nothing until someone asks to go deeper, and it answers the two questions a static result list cannot: *narrower than this* and *more like this*.

## The shape

```
                  ┌──────────────────────────┐
   "Discover" ───▶│   describe it (a box)    │──┐
                  └──────────────────────────┘  │
                  ┌──────────────────────────┐  ├──▶  result list  ──▶ [ + Add ]
                  │  browse the 11 sections  │──┘         │
                  └──────────────────────────┘            │  [ ⌄ narrower ] / [ ≈ similar ]
                                                          ▼
                                                   keep / skip tuner
                                                   (rounds, until Done)
                                                          │
                                                          └──▶ back to the list, enriched
```

- **FR-24.1** *(Shipped)* Discovery is reachable from **two doors that produce the same result list**: a free-text box ("what are you into?") and a grid of the 11 taxonomy sections. Neither is primary. The box serves the user who sort of knows; the grid serves the user who wants to see what exists. Each covers the other's failure, which is why both ship together rather than one first.

- **FR-24.2** *(Shipped)* The section grid drills **section → subcategory → suggestions**, reusing the NEWS-97 taxonomy rather than a discovery-specific list. A section offers an "Anything in *X*" escape for the user who doesn't recognise the subcategory names.

- **FR-24.3** *(Shipped)* The free-text box accepts anything, including nothing: an empty submission means "surprise me" and returns a broad spread across sections rather than an error. The blank-box wall is the one failure mode this door has, and the empty state is where it gets fixed.

- **FR-24.4** *(Shipped)* Results are **cards, grouped by category**, each carrying: the topic name, a one-line reason, whether it is *ongoing* or *evergreen*, and an **Add** button. The grouping doubles as a preview of where the topic will file itself in the filter bar.

### The tuner (depth)

- **FR-24.5** *(Shipped)* Any result card offers **narrower** (more specific than this) and **similar** (adjacent to this). Either enters the tuner scoped to that card. The result *set* offers the same two actions scoped to the whole list, worded **narrow these** and **more like these** (*NEWS-265*).

  **The two scopes must be tellable apart without hovering.** They used to be byte-identical — same `link-btn` class, same Lucide icon, same word — sitting about 470px apart with a heading and a group label between them, so the only cue for which anchor a click committed to was position, and `margin-left: auto` had put the set-level pair as far from its heading as the row would allow. Both start a six-round tuner that spends a billable call per round (FR-24.6, FR-24.14), which makes a wrong guess expensive rather than merely annoying.

  Three things now separate them, and `discover.spec.ts` asserts all three because any one of them can revert silently: plural wording for the set against singular for the row (and a check that the set label is not merely a superstring of the row's); a `title` on **both** pairs naming the anchor — the set-level pair previously had none, so the *less* obvious control was the one with no explanation; and the set-level pair sitting beside the heading it acts on rather than at the far edge.

  The icons in this doc were written as `⌄` and `≈`; they are Lucide `funnel` and `blend` from `icons.tsx`, per the NEWS-133/134/135 rule that icons never come from glyphs.

- **FR-24.6** *(Shipped)* The tuner presents candidates one at a time with **keep / skip**, and each round re-prompts on the accumulated keeps *and* skips. Skips matter as much as keeps — "not that kind of cycling" is the signal that makes round three worth reaching.

- **FR-24.7** *(Shipped)* The tuner is **always entered deliberately and always exits back to the result list**, with everything kept added to the list rather than silently created. Nothing is created without an explicit Add, in the tuner or out of it.

- **FR-24.8** *(Shipped)* Each round shows **why** a candidate is being offered ("because you kept: AI policy, chip design"). Without it the loop is a slot machine; with it, it is legible, and a user who sees the model has misread them can skip out rather than abandon the feature.

- **FR-24.9** *(Shipped)* The tuner shows its round count and is **bounded** — it does not loop indefinitely, and every round is a billable call. It ends by itself and can be ended at any point.

### Suggestion quality

- **FR-24.10** *(Shipped)* Every request asks for a deliberate **mix of ongoing and evergreen** topics, and each suggestion is labelled with which it is. An ongoing story burns out and an evergreen topic does not; that is the honest answer to "why is this topic quiet now?" three months later, and it belongs on the card rather than in a support conversation.

- **FR-24.11** *(Shipped)* **Nothing already followed is ever suggested.** Existing topic names go into the request as exclusions *and* results are matched against the current topics before rendering. Two layers, because the model will occasionally ignore the first and a duplicate suggestion is the most obviously-broken thing this feature could produce.

- **FR-24.12** *(Shipped)* A suggestion carries a **guidance steer** (FR-18), not just a name — "Formula 1: race results and team news, not driver gossip". Adding the topic stores it, so the *first* check is already narrowed. This costs nothing extra: the model is writing the justification prose anyway.

- **FR-24.12a** *(Shipped, NEWS-269)* **The heading and the group labels must not contradict each other.** A section drill-in whose results classify themselves elsewhere shows a **"closest matches"** note beside the heading.

  Drilling into "Business · Markets" and getting a lone result grouped under "Business · Other" puts two labels eight pixels apart that disagree, and the honest reading is that the filter failed. Both are true — the heading is the *request*, the group label is where the topic will actually file itself in the filter bar (FR-24.13) — so the fix **explains** the gap rather than hiding it. Suppressing the group label would have been easier and would have discarded the more useful of the two facts.

  `resultsQualifier` is silent for a free-text query (no section to disagree with), for an empty result, and when every group matches — a hedge on an exact match is noise. The E2E asserts the *invariant* rather than a fixed string: if any group differs from the section asked for, the note must be present; if none do, it must be absent.

  Related: the tuner's own rationale line no longer says `narrower than “X”` when X **is** the candidate. A set-level tune anchors on the heading, and a heading can be the same string as a topic in the list, which shipped a card explaining itself as narrower than itself. Saying nothing beats saying something circular; the reason line above it still carries the substance.

- **FR-24.13** *(Shipped)* Suggestions arrive **pre-classified** into the taxonomy, so a topic added from discovery lands in the right filter-bar section without a second classification call. The returned slug is untrusted and validated exactly as FR-22.8 requires — an unresolvable slug degrades to unclassified rather than being written.

### Cost, which is the sharpest constraint here

- **FR-24.14** *(Shipped, NEWS-125)* Discovery is the only surface in the app that can issue **unbounded** AI calls, so every call is **recorded** — entry path, provider, model, outcome, and whether it was served free from the cache. `GET /api/discover/usage`.

  **This was originally written as "counted against the spend cap", which is not possible: [NEWS-119](ai/requirements-summary.md) removed spend estimation, the monthly budget and the price table outright.** There is no cap to count against, so the recording is for *visibility* and the actual protection against runaway cost is structural — the round ceiling (FR-24.9), the cache (FR-24.15), and user-initiated-only (FR-24.16). Those three are load-bearing precisely because no budget backstops them.

  It is surfaced in the redacted diagnostics bundle (NEWS-130, [7 — API Keys](7-api-keys.md) FR-7.13): a bug report about unexpected cost needs exactly "how many calls, and how many were free". The log holds the scope **kind** only, never the free-text query — that query is what a user said about their own interests, and a bundle is usually pasted somewhere public. Safe by construction rather than by filtering, and a test pins it that way.

  The log is **in memory, not in the database**. Persisting it would mean either a schema migration or reusing the `runs` table, and `runs` is topic-shaped throughout — it drives the per-topic failure banner, the falling-behind detector and the diagnostics table, all of which would need a filter that someone will eventually forget to add. A discovery call has no topic.

- **FR-24.15** *(Shipped, NEWS-125)* Results are **cached in memory per request** (scope, exclusions, limit) with a 10-minute TTL, so the click-in / click-out / click-back pattern does not re-bill. Losing the cache on restart is fine and keeps it out of the schema.

  **The exclusions are part of the cache key**, which matters more than it looks: adding a topic changes what a valid answer is, so an entry computed before the change could otherwise suggest the topic the user just added — the one thing FR-24.11 exists to prevent.

  **So is who was asked** — provider, model and effort (*NEWS-258*). This was missing: the key described the *request* and not the answerer, so a repeat query after switching provider was served the previous provider's ideas, long after every other part of the app had moved on. Those are the same three fields an in-flight check is signed with ([2 — Checks](2-checks.md) FR-2.11), for the same reason — they are the ones that change what comes back. Keyed rather than cleared on change: a key cannot be forgotten by a caller the way a `clear()` can, and switching back finds the earlier answers still there instead of paying for them twice. The signature is read from settings rather than by resolving the provider, so a cache hit still costs nothing and still works with no key configured.

- **FR-24.15a** *(Shipped, NEWS-258)* Changing provider, model or effort **clears the suggestions currently on screen**, returning the pane to its browse grid.

  Reachable rather than theoretical: Settings opens *over* the discovery pane — it is above it on the Escape ladder — so a user can get suggestions, change provider without closing them, and come back to one model's answer presented under another's name, with tuner rounds (FR-24.6) counted against a list nothing will produce again.

  Cleared rather than relabelled, because a suggestion list is one cheap call to regenerate and there is no honest label for "these came from somewhere you are no longer asking". An `endpoint`-only change does **not** clear them: it moves which host answers, not which model does.

- **FR-24.16** *(Shipped)* Every call is **user-initiated**. Nothing in discovery refreshes on a timer — that is the property that keeps this affordable, and it is the reason the newsstand variation was deferred rather than built.

### Where it appears

- **FR-24.17** *(Shipped)* A **Discover** entry point sits beside the add-topic field, for the ongoing case.

- **FR-24.18** *(Shipped, NEWS-128; reworked NEWS-146)* Onboarding's **Topics** step (FR-20.6) opens **this dialog** — the same one, not a version of it. Setup is where the need is sharpest, and a new user has no existing topics, which makes it the one place suggestions are guaranteed unfiltered.

  NEWS-128 first built the step its own describe-box whose results were chips. That was a second, smaller discovery answering the same question with a fraction of the answer: no section grid, no reason or ongoing/evergreen label, no narrower/similar, no More. The half it was missing — browsing by section — is the half a user who cannot yet name what they want needs most, and this was the copy they met first. NEWS-146 replaced it with a **Discover topics** button carrying the *same* `data-action=open-discover` as the sidebar's compass: one attribute, one delegate (the NEWS-126 lesson applied rather than re-learned), and one implementation to keep good.

  The consequence is that **Add creates immediately here too** (FR-24.26), which collides with the wizard's "nothing exists until Finish". Immediate creation won: it is what carries the guidance and classification into the topic, and therefore what makes the first check narrowed and already running by the time the user reaches the schedule step. The wizard reports the two honestly instead of hiding the difference — see FR-20.6a.

  The starter chips stay as a **documented fallback**: onboarding runs before a provider is necessarily configured, and the gate mirrors `resolveProvider` — an explicitly-chosen provider must itself be available, since asking merely whether *any* provider is available offers a button that cannot work to someone who picked OpenAI without a key. `AUTO_ORDER` moved to `src/ai/types.ts` so the client can share the one definition instead of keeping a copy that drifts.

## Variations considered

Four shapes were wireframed before the one above was chosen. Recorded because the rejected ones explain the approved one.

- **A — Catalogue.** Drill the taxonomy, AI only at the leaf. Cheap, predictable, pre-classified. Rejected *alone* because the taxonomy is a ceiling: nothing surfaces that doesn't fit a section, and a directory rewards people who already know what they want — the user this feature is not for. **Approved as the second door.**
- **B — Tuner.** Keep/skip rounds from the start. The best experience for "I have no idea", but an AI call per round made it the most expensive shape by a wide margin, and there was no way to jump to something you *did* know you wanted. **Approved as the depth control instead of an entry point** — the mechanic survives, the cost profile doesn't.
- **C — Describe it.** One free-text box, clustered results. Fastest path for a vague idea; handles subjects the taxonomy has no section for. Weak alone: the blank box is a wall for a user with no idea at all. **Approved as the first door.**
- **D — Newsstand.** A persistent front-page view rather than a dialog: trending / evergreen / "because you follow X" / a browse strip. The only shape that serves discovery *after* setup, and the only one that spends on a schedule for a screen nobody may open. **Deferred** — it reuses everything the approved shape builds, so it stays cheap to add later.

## The provider capability (NEWS-124, shipped)

`NewsService` gained a second method, `suggestTopics(request)`, implemented by all five providers — `anthropic`, `openai`, `claude-cli`, `codex-cli`, and `mock`. Both doors and the tuner are the *same* call with a different request shape (`SuggestScope`), which is what makes shipping them together cheap rather than three times the work.

- **FR-24.19** *(Shipped)* Prompting lives in `src/ai/suggest-prompt.ts`, kept out of `prompt.ts` because it asks a different question. Malformed model output degrades rather than failing the batch: an unrecognised `kind` becomes `evergreen` (the safer default — mislabelling a burning-out story as standing merely disappoints later, where the reverse promises news that won't come), and a missing guidance becomes empty.

- **FR-24.20** *(Shipped)* The two subscription CLIs take the JSON Schema as a **runner parameter** rather than a module constant, since checks and discovery return different shapes through the same binary. See [6 — AI Providers](6-providers.md) FR-6.11.

- **FR-24.21** *(Shipped)* The **mock is deterministic, keyed off a single "request seed"** derived from whichever scope was used, so the existing `fail` / `empty` keyword convention works identically across all three entry shapes and there is one convention to learn.

  Two properties of the mock matter more than realism, because the whole discovery UI will be tested through it. Tuner names encode the round and direction, so a tuner that re-issues the same round is distinguishable from one that advanced — otherwise that bug is invisible. And **it deliberately suggests a topic the user already follows** whenever exclusions are present, placed *first* in the list. That is the exact case FR-24.11's second layer exists for, and a mock that filtered perfectly would make that layer permanently untestable. The request is recorded separately (`suggestCalls`), so the first layer stays assertable on its own.

- **FR-24.33** *(Shipped, NEWS-132)* Discovery runs on a **fast, cheap model** — Haiku on Claude, `gpt-5-mini` on OpenAI — with a smaller search and output budget than a check. See [6 — AI Providers](6-providers.md) FR-6.12 for the model table and the pre-4.6 request-shape handling Haiku requires.

- **Retries and rate limiting already exist** (`src/ai/retry.ts`) and apply unchanged — discovery is user-initiated and therefore always attended, so the FR-6.5 attendance gate never blocks it.

## The server (NEWS-125, shipped)

`src/discovery.ts` sits between the route and the provider and owns the four things the provider deliberately does not: who to exclude, how long an answer stays reusable, which classifications are real, and what the call cost. It is **not** part of `CheckRunner` — that class is topic-shaped all the way down (retry state, in-flight guard, run records all keyed by topic) and a discovery call has no topic.

- **FR-24.22** *(Shipped)* `POST /api/discover` takes the three entry shapes as a **zod discriminated union**, so an invalid combination — a tuner round with no anchor, a section with no category — is a 400 rather than a silently half-honoured call to the model. A provider failure is a **502 carrying the provider's own message**: no key, offline, rate-limited are ordinary outcomes the user needs to read, not server faults.

- **FR-24.23** *(Shipped)* The tuner round ceiling (FR-24.9) is enforced **in the schema**, so an out-of-range round never reaches the provider. `MAX_TUNE_ROUNDS` lives in `src/api/schemas.ts` rather than the server module because the client needs the same number to stop offering another round, and two copies would eventually disagree — the disagreement being a button the server rejects.

- **FR-24.24** *(Shipped)* Both exclusion layers are server-side. The route fills `exclude` from the topic list so the client **cannot** forget (layer 1), and the response is filtered against the same list (layer 2). Matching uses `normalizeTopicName`, deliberately *not* `normalizeTitle` from `ai/dedupe.ts`: that one deletes punctuation because it compares news headlines, whereas in a topic name a hyphen stands in for a space, so "formula-1" and "Formula 1" are the same subject. Using the headline rule would let a re-punctuated duplicate straight through. The same pass also drops a name the model repeated within one batch.

## The dialog (NEWS-126, shipped)

- **FR-24.25** *(Shipped)* Both doors live in one dialog, opened from a compass button beside the add-topic field (FR-24.17). The box and the section grid are visible together — neither is presented as the primary route.

- **FR-24.26** *(Shipped)* Adding a suggestion sends the name, guidance and classification in a **single** `POST /api/topics`. Creating a topic fires its first check immediately (FR-1.12), so a follow-up PATCH would land *after* that check had already run unsteered — which is exactly what FR-24.12's guidance exists to prevent. `categorySource` stays `auto`: the classification came from the model, so a manual change must still win (FR-22.7).

- **FR-24.27** *(Shipped)* An added card **stays in place** and marks itself "Added" rather than disappearing. A row vanishing under the cursor is how the *next* row gets clicked by accident.

- **FR-24.34** *(Shipped, NEWS-136)* **More suggestions** appends another batch to the bottom of the list rather than replacing it — the list the user is reading stays where it is. The names already on screen go up as `seen`, which the server *adds* to the topic exclusions rather than replacing them, so asking for more can never weaken FR-24.11's first layer.

  When a batch comes back with nothing the list doesn't already have, the button is **replaced by a plain statement** rather than left to be pressed again. Every press is a billable call, so an exhausted seam has to be visible rather than discovered.

- **FR-24.28** *(Shipped)* A provider failure renders **inside the dialog** with a retry, not in the global banner: the user is mid-task, and the message is about that one request.

- **FR-24.35** *(Shipped, NEWS-137)* A discovery call takes many seconds and there is **no progress signal to read** — only a request that eventually returns. So the wait shows an *estimated* bar, paced against the **median** of the last ten real call durations on this device (30 s before there is any history, and clamped to 2–90 s so one freak call can't poison the next bar). Cache hits are excluded: they return instantly and would drag the estimate to nothing.

  The curve reaches ~85% at the point the estimate predicts and then creeps toward a ceiling it **never reaches**. That is what makes an estimate safe to be wrong about in both directions: finishing early leaves the bar mid-travel, which the results simply replace, and running long leaves it inching rather than sitting at 100% while nothing happens.

  Paced entirely by CSS from a `--discover-duration` custom property — no timer, no per-frame re-render, because a 10 Hz re-render of the whole mount would fight the morph for something decorative by construction. The bar is `aria-hidden` with the status line beside it doing the announcing: a progress value that is an estimate has nothing truthful to report, and "37%" would be a claim the app cannot stand behind.

## The tuner (NEWS-127, shipped)

The depth control, and **still not an entry point** — the distinction the whole shape was chosen for. It costs nothing until someone asks to go deeper.

- **FR-24.29** *(Shipped)* The state machine is a pure module (`src/client/discover.ts`: `startTuner` / `judgeCandidate` / `nextRound` / `mergeKept` / `tunerRationale`), separate from the dialog because it is the one genuinely stateful part of discovery and every interesting failure in it is a *sequence*.

- **FR-24.30** *(Shipped)* A verdict on a drained queue is a **no-op**. That is what a double-click on the last card is, and it must not push a phantom entry or advance a round on its own.

- **FR-24.31** *(Shipped)* The tuner is nested **inside** the discovery state, not beside it, so closing the dialog ends the session. A sibling field would allow a tuner that outlived the list it came from — which is precisely the tuner-first shape that was rejected.

- **FR-24.32** *(Shipped)* Ending merges the keeps into the result list via `mergeKept`, which dedupes: the user can keep something they already added, and reverting that card to an un-added duplicate is the bug this prevents.

### Two lessons from building it

Both were caught by the E2E suite and neither would have been caught by typecheck, lint or unit tests.

- **A nested `each()` never binds.** Rendering the grouped result list as `each(groups, … each(group.suggestions, …))` throws in the dev bundle: an inner list inside a row render is flattened to static HTML and silently stops updating. The inner collection is a `.map()`; the outer stays keyed.
- **Two delegates must never match nodes the morph can turn into each other** — the section tile and the subcategory chip are both buttons in the same slot, so one click fired both handlers. Written up in [3 — Web UI](3-ui.md); it is a general rule, not a discovery quirk.

### Testing

- **E2E (tuner)** — 10 more in `discover.spec.ts`, written as sequences per the transition-matrix rule: entering from a card and then from the set without a reload, a drained round advancing, skipping everything, exiting mid-round and re-entering (must not resume the old round or carry its keeps), Done returning the keeps to the list *uncreated*, and closing the dialog mid-tune ending the session.
- **Unit (tuner)** — 15 more in `discover-client.test.ts`: the whole run to the round bound without drift, a verdict on a drained queue, skip-everything, the rationale's fallback in round one, and `mergeKept`'s three duplicate cases.
- **E2E** — `tests/e2e/discover.spec.ts` (14): both doors through to a created topic, the empty-box "surprise me" path, drilling and stepping back, grouping and the ongoing/evergreen badges, the added card staying put, an already-followed topic never being suggested (the mock plants one on purpose), a provider failure showing a retry, backdrop-vs-inside click handling, and the topics list surviving the dialog opening and closing.
- **Unit** — `tests/unit/discover-client.test.ts` (15): grouping, taxonomy ordering at both levels, "Other" vs unclassified, and the headings.
- **Unit** — `tests/unit/discovery.test.ts` (27): all three entry shapes and their malformed variants, the round bound (including that a rejected round never reaches the provider), both exclusion layers, normalized and within-batch duplicates, classification validation (bad category dropped, bad subcategory degrading to category-only), cache hit / miss / expiry / invalidation-by-new-topic, the recording of succeeded, failed and unresolvable-provider calls, and the 503 when discovery isn't wired up. Verified non-vacuous by removing the layer-2 filter — three tests fail.
- **Unit** — `tests/unit/suggest-prompt.test.ts` (22): each scope's prompt, the empty-query breadth instruction, skips phrased as a steer rather than an exclusion list, history capping, exclusions, taxonomy-by-slug, and the parser's degrade-don't-fail paths including a bogus slug surviving parsing for the caller to reject. `tests/unit/suggest-providers.test.ts` (12): all five providers through injected runners, the CLI schema wiring, and the mock's determinism scheme.
- **Manual** — the real-provider path is in `docs/manual-test-plan.md`. The suite proves the plumbing against the mock; whether the model's *answers* are good — a genuine ongoing/evergreen mix, near-duplicates avoided, the tuner actually narrowing — can only be judged by a person.
- The discovery route is exercised through `createApp(...)` + `app.request(...)`, this project's server-test convention.
