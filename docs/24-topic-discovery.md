# 24 — Topic Discovery

Naming a topic requires already knowing you want it. That is fine for the two or three subjects anyone can list from memory, and it is the whole reason the sidebar stops at three: the app asks for a search query when what the user actually wants is a *browsing* surface. The gap shows up hardest at first run — onboarding offers six hard-coded starter chips (FR-20.6) and nothing behind them — but it does not close afterwards. A month in, the feed reflects the topics its owner could think of on day one.

See also [1 — Topics and Scheduling](1-topics-and-scheduling.md), [20 — First-Run Onboarding](20-onboarding.md), [22 — Topic Categories](22-topic-categories.md), [18 — Topic Guidance](18-topic-guidance.md), [6 — AI Providers](6-providers.md).

## Status: partial — the provider capability is built (NEWS-124); nothing above it is (NEWS-125–128)

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

- **FR-24.1** Discovery is reachable from **two doors that produce the same result list**: a free-text box ("what are you into?") and a grid of the 11 taxonomy sections. Neither is primary. The box serves the user who sort of knows; the grid serves the user who wants to see what exists. Each covers the other's failure, which is why both ship together rather than one first.

- **FR-24.2** The section grid drills **section → subcategory → suggestions**, reusing the NEWS-97 taxonomy rather than a discovery-specific list. A section offers an "Anything in *X*" escape for the user who doesn't recognise the subcategory names.

- **FR-24.3** The free-text box accepts anything, including nothing: an empty submission means "surprise me" and returns a broad spread across sections rather than an error. The blank-box wall is the one failure mode this door has, and the empty state is where it gets fixed.

- **FR-24.4** Results are **cards, grouped by category**, each carrying: the topic name, a one-line reason, whether it is *ongoing* or *evergreen*, and an **Add** button. The grouping doubles as a preview of where the topic will file itself in the filter bar.

### The tuner (depth)

- **FR-24.5** Any result card offers **⌄ narrower** (more specific than this) and **≈ similar** (adjacent to this). Either enters the tuner scoped to that card. The result *set* offers the same two actions scoped to the whole list.

- **FR-24.6** The tuner presents candidates one at a time with **keep / skip**, and each round re-prompts on the accumulated keeps *and* skips. Skips matter as much as keeps — "not that kind of cycling" is the signal that makes round three worth reaching.

- **FR-24.7** The tuner is **always entered deliberately and always exits back to the result list**, with everything kept added to the list rather than silently created. Nothing is created without an explicit Add, in the tuner or out of it.

- **FR-24.8** Each round shows **why** a candidate is being offered ("because you kept: AI policy, chip design"). Without it the loop is a slot machine; with it, it is legible, and a user who sees the model has misread them can skip out rather than abandon the feature.

- **FR-24.9** The tuner shows its round count and is **bounded** — it does not loop indefinitely, and every round is a billable call. It ends by itself and can be ended at any point.

### Suggestion quality

- **FR-24.10** Every request asks for a deliberate **mix of ongoing and evergreen** topics, and each suggestion is labelled with which it is. An ongoing story burns out and an evergreen topic does not; that is the honest answer to "why is this topic quiet now?" three months later, and it belongs on the card rather than in a support conversation.

- **FR-24.11** **Nothing already followed is ever suggested.** Existing topic names go into the request as exclusions *and* results are matched against the current topics before rendering. Two layers, because the model will occasionally ignore the first and a duplicate suggestion is the most obviously-broken thing this feature could produce.

- **FR-24.12** A suggestion carries a **guidance steer** (FR-18), not just a name — "Formula 1: race results and team news, not driver gossip". Adding the topic stores it, so the *first* check is already narrowed. This costs nothing extra: the model is writing the justification prose anyway.

- **FR-24.13** Suggestions arrive **pre-classified** into the taxonomy, so a topic added from discovery lands in the right filter-bar section without a second classification call. The returned slug is untrusted and validated exactly as FR-22.8 requires — an unresolvable slug degrades to unclassified rather than being written.

### Cost, which is the sharpest constraint here

- **FR-24.14** Discovery is the only surface in the app that can issue **unbounded** AI calls, so every call is **recorded like a check and counted against the spend cap**. A screen that can leak cost must not also be invisible to cost reporting.

- **FR-24.15** Results are **cached in memory per request** (door, section, depth, exclusions) with a short TTL, so the click-in / click-out / click-back pattern does not re-bill. Losing the cache on restart is fine and keeps it out of the schema.

- **FR-24.16** Every call is **user-initiated**. Nothing in discovery refreshes on a timer — that is the property that keeps this affordable, and it is the reason the newsstand variation was deferred rather than built.

### Where it appears

- **FR-24.17** A **Discover** entry point sits beside the add-topic field, for the ongoing case.

- **FR-24.18** Onboarding's **Topics** step (FR-20.6) offers the same surface in place of its six hard-coded chips. Setup is where the need is sharpest, and a new user has no existing topics, which makes it the one place suggestions are guaranteed unfiltered.

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

- **Retries and rate limiting already exist** (`src/ai/retry.ts`) and apply unchanged — discovery is user-initiated and therefore always attended, so the FR-6.5 attendance gate never blocks it.

### Testing

- **Unit** — `tests/unit/suggest-prompt.test.ts` (22): each scope's prompt, the empty-query breadth instruction, skips phrased as a steer rather than an exclusion list, history capping, exclusions, taxonomy-by-slug, and the parser's degrade-don't-fail paths including a bogus slug surviving parsing for the caller to reject. `tests/unit/suggest-providers.test.ts` (12): all five providers through injected runners, the CLI schema wiring, and the mock's determinism scheme.
- No E2E yet — there is no UI to drive until NEWS-126.
