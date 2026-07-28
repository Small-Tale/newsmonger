# 24 — Topic Discovery

Naming a topic requires already knowing you want it. That is fine for the two or three subjects anyone can list from memory, and it is the whole reason the sidebar stops at three: the app asks for a search query when what the user actually wants is a *browsing* surface. The gap shows up hardest at first run — onboarding offers six hard-coded starter chips (FR-20.6) and nothing behind them — but it does not close afterwards. A month in, the feed reflects the topics its owner could think of on day one.

See also [1 — Topics and Scheduling](1-topics-and-scheduling.md), [20 — First-Run Onboarding](20-onboarding.md), [22 — Topic Categories](22-topic-categories.md), [6 — AI Providers](6-providers.md).

## Status: design only — direction not chosen (NEWS-116)

This document is a **brainstorm**, recorded before implementation because the shape is genuinely open. Four variations are described below with wireframes, followed by the decisions that apply whichever one wins, and a recommendation. Nothing here is built.

## What the existing code decides for us

Four constraints are already fixed, and they narrow the design more than any preference does.

- **There is exactly one AI entry point.** `NewsService` has a single method, `checkTopic`. Discovery is a different question ("what might I want to follow?" rather than "what is new about X?"), so it needs a **second capability on the provider interface**, implemented by all five providers — `anthropic`, `openai`, `claude-cli`, `codex-cli`, and the deterministic `mock`. That work is identical across every variation below; only the request shape differs.
- **The taxonomy already exists.** NEWS-97 seeded 11 categories and ~60 subcategories, and the classifier already maps a topic into them. A discovery browser can navigate *that same tree*, which means suggestions arrive pre-classified — the topic created from a suggestion lands in the right filter-bar section without a second AI call to classify it.
- **Every call costs.** Checks are metered against a spend cap, and subscription providers are `attended` — scheduled work is gated on someone being at the app. Discovery is user-initiated, so attendance is never in question, but **the spend has to be visible**: a browsing surface that quietly issues an AI call per click is a cost leak that no existing screen would report.
- **Model output is untrusted.** The classifier already treats a returned category slug as untrusted and validates before storing (FR-22.8). Suggestions are the same: names, categories and any URLs come back through zod, and an unresolvable slug degrades to unclassified rather than being written.

## Cross-cutting decisions (independent of which shape wins)

- **Current-events *and* evergreen, labelled.** The prompt asks for a deliberate mix, and each suggestion carries which kind it is: an *ongoing story* ("2026 midterms") burns out, an *evergreen* topic ("Formula 1") does not. The distinction is worth surfacing rather than hiding, because it tells the user what they are signing up for — and it is the honest answer to "why is this topic quiet now?" three months later.
- **Never suggest what they already follow.** Existing topic names go into the request as exclusions, *and* results are matched against the current topics client-side before rendering. Two layers because the model will occasionally ignore the first, and a duplicate suggestion is the single most obviously-broken thing this feature could do.
- **A suggestion is a name plus a reason plus a steer.** Topics already support `guidance` (FR-18) — a free-text steer stored per topic. A suggestion that fills it in ("Formula 1 — race results and team news, not driver gossip") produces a *better first check* than the bare name, and it costs nothing extra: the model is already writing prose to justify the suggestion.
- **Cache by request, in memory.** Re-opening the same subcategory should not re-bill. An in-process cache keyed by the request (category, depth, exclusions) with a short TTL covers the browsing pattern that actually happens — click in, click out, click back. Losing it on restart is fine and keeps it out of the schema.
- **Discovery calls are recorded and capped.** They appear in the run records like any other spend, distinguished by kind. Without that, the one screen that can issue unbounded calls is also the one screen invisible to the cost reporting.

---

## Variation A — Catalogue (drill-down browser)

Navigate the existing taxonomy deterministically; call the AI only at the leaf.

```
┌─ Discover topics ────────────────────────────────── ✕ ─┐
│                                                        │
│  Browse by section                                     │
│                                                        │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐           │
│  │ World  │ │Politics│ │Business│ │  Tech  │           │
│  └────────┘ └────────┘ └────────┘ └────────┘           │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐           │
│  │Science │ │ Health │ │ Sports │ │ Enter… │           │
│  └────────┘ └────────┘ └────────┘ └────────┘           │
│  ┌────────┐ ┌────────┐ ┌────────┐                      │
│  │Culture │ │ Style  │ │Society │                      │
│  └────────┘ └────────┘ └────────┘                      │
└────────────────────────────────────────────────────────┘
                          │  click "Sports"
                          ▼
┌─ Discover ▸ Sports ──────────────────────────────── ✕ ─┐
│  ‹ All sections                                        │
│  Soccer · Football · Basketball · Baseball · Hockey     │
│  Tennis · Golf · Motorsport · Combat · Olympics ·       │
│  College                          [ Anything in Sports ]│
└────────────────────────────────────────────────────────┘
                          │  click "Motorsport"  → AI call
                          ▼
┌─ Discover ▸ Sports ▸ Motorsport ─────────────────── ✕ ─┐
│  ‹ Sports                                              │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Formula 1                          [evergreen]   │  │
│  │ Race weekends, team politics, regulation changes │  │
│  │                              [ + Add ]  [ ⌄ ]    │  │
│  ├──────────────────────────────────────────────────┤  │
│  │ 2026 F1 engine regulations        [ongoing]      │  │
│  │ The new power-unit rules and who they favour     │  │
│  │                              [ + Add ]  [ ⌄ ]    │  │
│  ├──────────────────────────────────────────────────┤  │
│  │ MotoGP                             [evergreen]   │  │
│  │ …                                [ + Add ]  [ ⌄ ]│  │
│  └──────────────────────────────────────────────────┘  │
│                                     [ More like these ] │
└────────────────────────────────────────────────────────┘
                          │  click "⌄" (go deeper on F1)
                          ▼
        ┌──────────────────────────────────────────────┐
        │ Formula 1 ▸ narrower                         │
        │  · F1 driver market and contracts            │
        │  · F1 technical regulations                  │
        │  · Formula 1 in the United States            │
        └──────────────────────────────────────────────┘
```

**Progressive depth** = taxonomy depth (2 levels) + an unbounded "⌄ narrower" on any card, which re-prompts scoped to that suggestion.

**Good**: cost is predictable and user-triggered per leaf; the frame renders offline; suggestions arrive pre-classified; trivially cacheable per leaf; "Anything in Sports" covers the user who doesn't know the subcategory names.
**Bad**: the taxonomy is a ceiling — nothing surfaces that doesn't fit a section, which is exactly where the interesting topics live; it reads as a directory, and directories reward people who already know what they're looking for. That is the user this feature is *not* for.

---

## Variation B — Tuner (revealed preference)

No navigation. A stream of candidates; keep or skip; each round re-prompts on the accumulated signal.

```
┌─ Find topics for me ─────────────────────────────── ✕ ─┐
│                                        round 2 of ~4   │
│  ┌──────────────────────────────────────────────────┐  │
│  │                                                  │  │
│  │   Semiconductor supply chains       [ongoing]    │  │
│  │                                                  │  │
│  │   Fabs, export controls, and who can build       │  │
│  │   what where.                                    │  │
│  │                                                  │  │
│  │   because you kept: AI policy, Chip design       │  │
│  │                                                  │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
│        [  ✕  Skip  ]          [  ♥  Follow  ]          │
│                                                        │
│  Kept so far:  AI policy · Chip design · Taiwan        │
│                                            [ Done ]    │
└────────────────────────────────────────────────────────┘
```

**Progressive depth** = each round narrows on what was kept; round 1 is broad, round 4 is specific.

**Good**: the only variation that genuinely serves "I have no idea what I want" — it requires no vocabulary from the user, just reactions. The deeper-and-more-specific requirement falls out of the mechanic rather than being bolted on. It is also the most pleasant to use.
**Bad**: an AI call per round, and the rounds are the point — this is the most expensive shape by a wide margin, on a feature where cost is already the sharpest constraint. No way to jump to a subject you *do* know you want. One card at a time is slow for a user who would happily scan twenty. Hard to E2E-test meaningfully.

---

## Variation C — Describe it (one box)

A single free-text box; the model returns clustered suggestions. The "search engine for topics" shape.

```
┌─ Discover topics ────────────────────────────────── ✕ ─┐
│                                                        │
│  What are you into?                                    │
│  ┌──────────────────────────────────────────────────┐  │
│  │ i cycle and i work in biotech                    │  │
│  └──────────────────────────────────────────────────┘  │
│                    or  [ Surprise me ]  [ Browse ▸ ]   │
│                                                        │
│  ── Sports ─────────────────────────────────────────   │
│   ⊕ Pro cycling — Grand Tours, classics    [evergreen]  │
│   ⊕ Cycling infrastructure & policy        [evergreen]  │
│                                                        │
│  ── Health ─────────────────────────────────────────   │
│   ⊕ Biotech funding & FDA approvals          [ongoing]  │
│   ⊕ CRISPR therapeutics                    [evergreen]  │
│                                                        │
│  ── Business ───────────────────────────────────────   │
│   ⊕ Pharma M&A                               [ongoing]  │
│                                                        │
│                              [ More like these ▾ ]     │
└────────────────────────────────────────────────────────┘
```

**Progressive depth** = refine the box, or "more like these" scoped to a cluster.

**Good**: fastest path for the user with a *vague* idea, which is most of them; one call per query; handles subjects the taxonomy has no section for; the clusters double as a preview of where each topic will file itself.
**Bad**: the blank box is a wall for someone with no idea at all — mitigable with "Surprise me" and a browse affordance, but the empty state is doing a lot of work. Less browsable; you get what you asked for, which is the opposite of discovery.

---

## Variation D — Newsstand (a persistent surface)

Not a dialog. A second view beside the feed, laid out like a front page, refreshed periodically.

```
┌────────────────────────────────────────────────────────────────┐
│  News            [ Feed ]  [ Discover ]                    ⚙   │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌── TRENDING NOW ──────────────┐  ┌── WORTH FOLLOWING ─────┐  │
│  │                              │  │                        │  │
│  │  2026 midterms       ⊕       │  │  Formula 1        ⊕    │  │
│  │  Politics ▸ Elections        │  │  Sports ▸ Motorsport   │  │
│  │                              │  │                        │  │
│  │  EU AI Act enforcement ⊕     │  │  Space launch    ⊕     │  │
│  │  Technology ▸ AI             │  │  Science ▸ Space       │  │
│  │                              │  │                        │  │
│  │  Red Sea shipping     ⊕      │  │  Architecture    ⊕     │  │
│  │  World ▸ Middle East         │  │  Culture ▸ Art         │  │
│  └──────────────────────────────┘  └────────────────────────┘  │
│                                                                │
│  ── Because you follow AI policy ───────────────────────────   │
│   ⊕ Chip export controls   ⊕ AI safety research   ⊕ EU tech…   │
│                                                                │
│  ── Browse ────────────────────────────────────────────────    │
│   World · Politics · Business · Technology · Science · Health   │
│   Sports · Entertainment · Culture · Style · Society            │
│                                                                │
│                                          refreshed 2 hours ago │
└────────────────────────────────────────────────────────────────┘
```

**Progressive depth** = the browse strip drops into Variation A; "because you follow X" is depth the user never had to ask for.

**Good**: the only variation that serves the *after* setup case well — discovery you stumble into rather than go looking for, which is how anyone actually finds a new interest. Matches the newspaper metaphor the rest of the UI already uses. "Because you follow X" is genuinely useful and impossible in the dialog shapes.
**Bad**: refreshing on a schedule spends money for a screen nobody may open — the one shape whose cost is not user-triggered. Largest build by some distance, and it still needs Variation A underneath it for the browse strip. Wrong thing to build first.

---

## Recommendation

**A + C as one surface, with D as the follow-up.** The catalogue and the describe-it box are not competing designs; they are two doors into the same result list, and each one covers the other's failure. The box handles "I sort of know", the section grid handles "no idea, show me what exists", and every card gets the same "⌄ narrower" for depth. One AI capability serves both — the request differs only in whether it carries a section or a free-text steer.

That leaves the tuner and the newsstand as later, independent bets: B is the better *experience* but the worst cost profile, and it can be added as a third door once real usage says whether cost is a live problem. D is the right long-term home for discovery-after-setup, and it reuses everything A+C builds.

Where it appears: the onboarding **Topics** step (FR-20.6) replaces its six hard-coded chips with the same surface, and a **Discover** entry point sits next to the add-topic field for the ongoing case.
