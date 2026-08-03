---
name: design-review
description: Design-director critique of the Newsmonger UI — visual hierarchy, information architecture, AI-slop tells, affordance, typography, states. Use when the user asks for a design review, a critique, "how does this look", "does this look AI-generated", or wants an outside eye on a screen before shipping it.
---

# Design review

A holistic critique of whether the interface actually *works* — not whether it
technically renders. Think like a design director giving feedback: direct,
specific, prioritised, and ending in tickets rather than adjectives.

Adapted from the `critique` skill (app.mcpmarket.com/brian-westphal/skills/critique).
**Its preparation step and its per-issue "Command" list were dropped, not
copied**: they point at `frontend-design`, `teach-impeccable`, `/animate`,
`/quieter` and friends, **none of which are installed here**. A skill that tells
you to run something that does not exist is the same failure this project has
now hit twice in code (NEWS-260, NEWS-261) — a reference that type-checks, reads
plausibly, and is empty at runtime. Everything below points at something real in
this repo.

---

## 1. Prepare — in this order, before writing a word of critique

**a. Learn what the design is *trying* to be.** Read `docs/3-ui.md` → "Visual
design". This app has a **deliberate design language**, not a default one:

> "The overnight briefing." Two-column layout (sticky **Watching** rail + feed),
> collapsing to one column under 860px. Bookish serif for the stories, quiet
> sans for controls, mono for the "clockwork" (eyebrows, timestamps, tags).
> Cool porcelain paper in light, pre-dawn slate-green in dark. Pine-green
> accent, marigold "active". Signature element: the **watch dial** that counts
> *down* (NEWS-144).

Critique against **that intent**. "Add a hero metric card" is not feedback, it
is a different product. If you think the intent itself is wrong, say so
explicitly as its own finding rather than smuggling it in as a detail.

**b. Learn what is actually built.** `docs/ai/requirements-summary.md` carries
status markers. Flagging a *design-only* or *deferred* feature as a design
failure wastes the review; flagging a **shipped** one that reads as unfinished
is exactly the point.

**c. Look at the real thing.** Do not critique from source. Capture it:

```
npm run demo:stills      # → assets/stills/{feed,topics,discover,tuner,review,settings-source,export}.png
```

Then **Read those PNGs** — you can see images; a critique written from JSX is a
code review wearing a hat. See `docs/28-demo-capture.md`.

Those seven are **light mode at 1440×900** — the two conditions a critique needs
least, since they already work. For the ones that matter, add `--review`:

```
npm run demo:stills -- --review   # → scripts/demo/.review/<scene>-{dark,narrow}.png
```

That captures every scene in **dark mode** and at **720px** (across the 860px
one-column collapse), uncropped, into a gitignored directory. Read those too — a
critique of the light desktop layout alone is a critique of the half that
photographs well. Both runs need to be **outside the command sandbox**
(Chromium needs Mach ports), and the soaking `topics` scene makes a full run take
a couple of minutes.

For anything the scenes do not reach, drive Playwright directly:
`tests/e2e/a11y.spec.ts` shows the `emulateMedia({ colorScheme })` pattern and
`tests/e2e/fixtures.ts` has the helpers (`openSettingsTab`, `topicAction`).

**d. Read the tokens** in `src/client/styles.scss` (`--paper`, `--ink`,
`--pine`, `--marigold`, `--serif`, `--sans`, `--mono`, `--shadow`). Naming a
token beats naming a hex, and a proposal that invents a colour outside the set
needs to justify why the set is insufficient.

**e. Before proposing any client change**, read `.claude/skills/kerf-app/SKILL.md`.
See §4 — several obvious-looking fixes are structurally forbidden here.

---

## 2. AI-slop detection — lead with this

**The test**: if you showed a screen to someone and said "AI made this", would
they believe you immediately?

The usual tells, inlined since there is no `frontend-design` skill to defer to:

- The **AI palette** — indigo/violet on near-black, or the purple→blue gradient.
- **Gradient text**, especially on headings.
- **Glassmorphism**: frosted translucent panels, heavy backdrop blur.
- **Dark mode with glowing accents** — neon on charcoal.
- **Hero metric layouts**: three or four big numbers in a row that nobody asked
  for and nothing acts on.
- **Identical card grids** where every item has the same weight, so nothing does.
- **Generic type**: Inter/Roboto/system-sans everywhere, one weight, no rhythm.
- **Emoji as iconography**, decorative sparkles, "✨ AI-powered" copy.
- **Uniform 8px-everything** spacing with no intentional density changes.
- Centre-aligned everything; pill buttons on every action; a shadow on every box.

**Be specific about this app.** The palette, the serif, and the mono clockwork
mean the crude tells are already absent — saying "good, not AI slop" and moving
on is a wasted section. Look for the subtler version: does a *newer* screen
match the established language, or did it drift toward defaults? Newly added
surfaces are where drift enters — see `docs/3-ui.md` → "New controls must reuse
the established classes (NEWS-133/134/135)", where three visual bugs shipped in
one dialog at once because it invented markup instead of reusing what existed.

---

## 3. The dimensions

Work through these against the captures. Skip nothing silently; if a dimension
has nothing wrong, one line saying so is fine.

1. **Visual hierarchy** — does the eye reach the most important thing first? Is
   the primary action findable in two seconds? Do size, weight and position
   agree about importance, or compete?
2. **Information architecture** — would a new user understand the organisation?
   Is related content grouped? Too many choices at once? (The settings dialog
   and the discovery pane are the two densest surfaces; judge them hardest.)
3. **Emotional resonance** — what does it evoke, and is that intentional? The
   target here is a **personal, local, single-user news tracker on localhost** —
   calm and bookish, not enterprise-dashboard, not consumer-social. "Would the
   user feel this is for me" is a real question; "does it match the brand" is
   not, since there is no brand beyond this.
4. **Discoverability & affordance** — are interactive things obviously
   interactive? Watch for **hover-revealed** controls specifically: per-topic
   actions appear on hover on desktop (FR-3.2), which is a discoverability risk
   the design already accepted once — re-examine it rather than assume it.
5. **Composition & balance** — is whitespace intentional or leftover? Is there
   rhythm? Does asymmetry read as designed? Check the one-column collapse.
6. **Typography** — does the hierarchy signal reading order? Is body text
   comfortable (line length, leading, size)? Enough contrast between heading
   levels? The serif/sans/mono split is load-bearing here: flag anywhere it is
   used inconsistently.
7. **Colour** — cohesive? Do accents draw the eye to the right things? Does
   meaning survive colourblindness (not just "contrast passes" — does the
   *marigold active state* still read as active)?
8. **States & edge cases** — empty states that guide rather than announce
   nothing; loading states; error copy that helps and does not blame; success
   that confirms and points onward. This app has real ones to judge: the
   invitational empty state, the "no stories yet" hint, the error and
   failed-check banners, the toast slot.
9. **Microcopy & voice** — clear, concise, human. Labels and buttons
   unambiguous. Error copy that lets the reader fix the problem. This project
   has form here: NEWS-40 and NEWS-260 were both cases where copy pointed at a
   place that could not help.

---

## 4. Constraints any proposed fix must respect

Propose fixes that can actually be built here. A critique that requires
forbidden structure is a critique the next agent has to relitigate.

- **kerf rules** (`docs/3-ui.md`, enforced by `eslint-plugin-kerfjs`): state in
  `defineStore`/signals; events via `delegate()` with `data-*` attributes —
  **never** `addEventListener` or inline handlers; `data-key` on list rows;
  `.map()` not `each()` for static structural arrays.
- **Structural containers stay** (NEWS-99). `#banners` and `#toast-slot` are
  ARIA live regions and **must exist before their content** or the
  announcement is lost; `#topics-panel` is an `aria-controls` target and
  removing it fails the axe suite. Do not propose "clean up the empty wrapper".
- **Both themes, or it is not done.** `tests/e2e/a11y.spec.ts` runs axe in light
  *and* dark and fails on serious/critical. Any colour proposal must state what
  it does in both.
- **Spacing changes are load-bearing.** NEWS-161's layout test exists because a
  shared selector once gave the export button a box's padding. Prefer a new
  block over adding a selector to an existing rule.
- **Motion respects `prefers-reduced-motion`** (FR-3.7).
- **New controls reuse the established classes** rather than inventing siblings.
  Concretely, from NEWS-133/134/135: close buttons are `btn icon`; **there is no
  global `input` rule**, so a new text field must `@extend %text-field` or it
  renders browser-default white and breaks in dark mode; icons come from
  `icons.tsx` (Lucide path data), never a glyph like `⌄`. `discover.spec.ts`
  guards the first two by comparing each control's computed background lightness
  against the panel's in emulated dark mode.

---

## 5. Output

Write the report in this shape. Be direct — vague feedback wastes the reader's
time. Name the element (`.topic-row`, `src/client/app.tsx:2194`), not "some
elements". Prioritise ruthlessly: if everything is important, nothing is.

### Anti-patterns verdict
Pass/fail on §2, with the specific tells found. Brutally honest.

### Overall impression
Gut reaction: what works, what does not, and the single biggest opportunity.

### What's working
Two or three things, with *why* they work. Not padding — knowing what to
preserve is half of what stops a redesign making things worse.

### Priority issues
The three to five most impactful problems, ordered. For each:

- **What** — the problem, named plainly.
- **Why it matters** — the cost to the person using it.
- **Where** — file and line, or the screen and element.
- **Fix** — concrete, and buildable under §4.
- **Ticket** — file it (below).

### Minor observations
Smaller things worth recording, one line each.

### Questions to consider
Provocative ones that might unlock a better answer — "what would a confident
version of this look like?", "does this need to be this complex?"

---

## 6. File the findings

This project is ticket-driven (`CLAUDE.md`): a finding that is not in a ticket
is forgotten. **Do not ask whether to file follow-ups — file them.**

- Use `hotsheet_create_ticket` (or the `/hs-bug`, `/hs-feature`, `/hs-task`
  skills). Category `bug` for something broken or misleading, `feature` for a
  design improvement, `task` for a cleanup.
- **One ticket per issue**, not one for the review. Each carries the What / Why
  / Where / Fix from above so it stands alone months later.
- Put the open design question *inside* the ticket rather than deferring on it.
- Leave `up_next` off unless the user says otherwise — a critique produces a
  backlog, and deciding what to do next is the user's call.
- Attach the relevant still (`hotsheet_add_attachment` with the
  `assets/stills/*.png` path) when the issue is visual. A screenshot argues
  better than a paragraph.
