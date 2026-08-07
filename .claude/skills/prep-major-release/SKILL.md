---
name: prep-major-release
description: Prepare the repo for a major release — review/update README.md so it stays compelling, and review the demo scenarios + screenshot scenes, proposing and applying any new/different/fewer screenshots (the maintainer captures them after).
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, Agent
---

Prepare Newsmonger for a major release. A lot has usually changed since the last
release, so the public-facing story drifts: the **README** stops advertising the
best features, and the **demo screenshots** stop matching the UI. This skill
brings both back in line.

Two deliverables, in order:

1. **README.md** — reviewed and updated so it stays compelling and advertises the
   most important and interesting features.
2. **Demo scenarios + screenshot scenes** — reviewed, with any *new / different /
   fewer* screenshots proposed and the **code changes applied**, then handed off
   to the maintainer to capture. **Do not capture screenshots yourself** —
   capturing needs Chromium outside the command sandbox and the maintainer does
   it (they said so). Your job is to get the scenes *ready to capture* and tell
   them exactly what to run.

## Step 0 — Orient (what's new since last time)

Before touching the README, build an accurate picture of the current feature set
so you advertise what actually ships today, not what shipped a year ago:

- Read `docs/ai/requirements-summary.md` and `docs/ai/code-summary.md` — the
  fastest synthesis of every feature and its status (Shipped / Partial / …).
- Skim the requirements index in `CLAUDE.md` and any newer numbered docs in
  `docs/` that the README predates.
- `git log --oneline -40` (or since the last release tag: `git log --oneline
  $(git describe --tags --abbrev=0 2>/dev/null)..HEAD`) to see what landed.
- Note features that are **shipped but absent or undersold** in the README, and
  README claims that are **stale** (removed/renamed/changed). Consider spawning an
  `Agent` (Explore) to diff "features in the docs/code" against "features in the
  README" if the gap is large.

## Step 1 — Review & update README.md

`README.md` is the front door (also rendered on npm and GitHub). Read it in full,
then revise for:

- **Compelling top-of-funnel.** The hero tagline + first two paragraphs must make
  the value obvious in seconds: you name the subjects you care about, and on a schedule
  the app asks an AI with web search what is *actually new* about each one, then
  hands you a short briefing with links. Keep the "the overnight briefing" energy
  — punchy, not corporate.
- **Advertise the most important & interesting features**, with the strongest
  ones highest. As of this writing the standouts worth leading with or featuring:
  topic tracking where the model does its own web search and reports only what is
  **genuinely new** (dedup against everything already reported, doc 2); story
  threading — "the story so far" across a running subject (doc 29); topic
  discovery and the tuner (doc 24); **subscription providers** — Claude or Codex
  CLI, so no API key and no per-token cost (doc 9); per-topic guidance and
  off-topic flagging that feeds the next prompt (docs 18, 15); categories,
  scheduling by interval or daily times, retries and cooldowns; Atom/JSON/Markdown
  export and a subscribable feed (doc 21); import, backup/restore and recovery
  (docs 30, 27, 33); light/dark themes; the desktop app. Privacy is a *selling
  point* here, not a footnote — localhost-only, keys in the OS keychain, and the
  only outbound traffic is the check itself. Re-check this list against Step 0 —
  features get added; promote new ones, demote anything retired.
- **Accuracy.** Every CLI flag, install step, provider, and capability claim must
  match reality (`src/cli.ts` for flags/usage, the requirements docs for
  behavior). Fix anything stale. Don't invent features.
- **Screenshots resolve and still represent the feature.** Each `<img
  src="assets/…">` must point at a file that exists and shows what the
  surrounding prose claims. Build the authoritative list of referenced images:
  `grep -oE 'assets/[A-Za-z0-9_.-]+\.(png|svg)' README.md | sort -u`. Cross-check
  against `assets/` and against the scene list in Step 2. Note (don't fix yet)
  any screenshot that should be re-shot because the UI moved — that feeds Step 2.
- **Structure & links.** Headings scan well, the feature table/bullets are
  current, internal links (`docs/…`, anchors) and the releases/npm links work.

Apply the edits directly to `README.md`. Keep British-English spelling — this repo's house style, unlike glassbox's (NEWS-364) — and the
project's no-emoji rule (see `CLAUDE.md`) — applies to README prose too.

## Step 2 — Review the demo scenarios & screenshot scenes

The README's stills are generated from real app states. The pipeline:

- **Demo data** — `src/demo.ts` (`DEMO_TOPICS` and their curated fixture stories).
  A single `--demo` flag, not a numbered list, and it implies `--ai-test`.
  `docs/28-demo-capture.md` is the spec.
- **Still capture** — `scripts/demo/capture-stills.ts` defines a `SCENES` array;
  each entry has a `name`, an `alt` string (the README's alt text lives here, not
  in the README) and a `setup(page)` that drives the demo server into the state
  being shown, then writes `assets/stills/<name>.png`. Run with
  `npm run demo:stills`. These are the README stills — currently feed, topics,
  discover, tuner, thread, review, export, settings-source.
- **Animated hero** — `assets/demo.svg` (+ `.svgz`) is produced separately by
  `scripts/demo/capture-demo.ts` (`npm run demo:capture`).

  **Check it against the same UI changes as the stills, not just against the
  `domotion-svg` version** (NEWS-376). A domotion bump forces a re-capture, but
  it is not the only thing that does — the hero renders the real app, including
  the sidebar and its add-topic row, so any chrome change that moved a still
  moved the hero too. It was nearly missed once precisely because the version
  check came back clean and read as an all-clear.

  Cheap way to be sure: `git log -1 --date=short --format='%h %ad' -- assets/demo.svg`
  and compare against the commits for the UI changes you found in Step 0. Or grep
  the SVG for a path only the *new* icon has — the frames are inline SVG, so
  `grep -c 'M3 12h18' assets/demo.svg` answers "does the hero have the grid icon"
  directly.

Review the set and decide what should change. Build the three-way map —
**README `<img src="assets/stills/…">` ↔ the scene's `name` in `capture-stills.ts`** — and
look for:

- **Missing coverage (new screenshot).** A marquee feature added since the last
  release with no still (e.g. a new comparison mode, a new AI surface). If it
  deserves a screenshot, add a `SCENARIOS` entry (and, if it needs a UI state the
  demo data doesn't yet produce, extend `DEMO_TOPICS` / its fixture stories in `src/demo.ts` +
  `src/demo.ts` so a real `--demo` run reaches that state). Then reference
  the new `assets/demo-<slug>.png` from the README.
- **Stale screenshot (different).** A scene whose UI moved enough that the still
  misrepresents it. Fix the scene's `setup()` so it captures the current,
  best-looking state. Keep captures deterministic and machine-independent
  (the script already isolates the data dir and uses `--demo`, which implies `--ai-test`
  — preserve that).
- **Redundant screenshot (fewer).** Two stills showing nearly the same thing, or
  a feature no longer worth a dedicated image. Drop the weaker one from the README
  and remove its `SCENARIOS` entry so the set stays tight.

Apply the **code** changes (`README.md`, `scripts/demo/capture-stills.ts`,
`src/demo.ts`) and keep docs in sync — if you add/retire a scene or demo topic,
update `docs/28-demo-capture.md` and the AI summaries
(`docs/ai/*`) per `CLAUDE.md`. **Do not run the capture** — the maintainer does
that.

## Step 2b — Upgrade `domotion-svg` if out of date (before any capture)

The demos — both the README stills and the animated hero — are generated by
[`domotion-svg`](https://www.npmjs.com/package/domotion-svg), declared in `devDependencies` as **`^0.21.1` — caret-ranged, like 27 of this repo's 28 dependencies, and deliberately so** (NEWS-365). Glassbox pins it exactly; do not carry that over.

**The caret does not mean a bump can arrive by surprise.** `package-lock.json` is committed and pins the exact version, CI runs `npm ci`, and `npm install` against a satisfied lock does not move it. Only a deliberate `npm update` / `npm i domotion-svg@latest` changes what is installed — which is what step 2 below *is*. Pinning exactly would buy nothing the lockfile does not already give, at the cost of being the odd one out in the manifest. Always confirm the installed version from `node_modules`, not from the range. A domotion release can fix rendering,
frame-synchronization, or browser-compat bugs, so a major release should ship its
demos built on the **latest** domotion. Do this *before* the capture handoff so
the re-capture in Step 3 runs on the new version.

1. **Check for a newer version.** Compare the latest published version against the
   pin:
   `npm view domotion-svg version` (latest) vs the `domotion-svg` entry in
   `package.json` → `devDependencies` (may need to run outside the command sandbox
   if the registry isn't reachable). If they match, skip this step.
2. **Bump the range + install.** Edit `package.json` to `^<new-version>` — **keep
   the caret**, matching the rest of the manifest — then `npm install` to refresh
   `package-lock.json`, and commit the lockfile: that is what actually fixes the
   version everyone builds on. Confirm with `grep '"version"' node_modules/domotion-svg/package.json`.
3. **Update every place that names the pinned version.** Find them all with
   `grep -rn '<old-version>' scripts/demo docs` — currently that's the header
   comment in `scripts/demo/capture-demo.ts`, the requirements note in
   and the pin note in `docs/ai/code-summary.md`.
4. **Verify the API the scripts use didn't shift.** A minor bump can change the
   generation path. Run `npm run typecheck` (the capture scripts live in the same
   project and must still compile); a clean capture in Step 3 is the final proof.
   If it fails, adapt the capture scripts to the new API before handing off.
5. **A domotion bump forces a full re-capture.** Because every demo frame is
   re-rendered by domotion, both the stills **and** the animated hero must be
   re-captured on the new version even if no UI changed — call this out explicitly
   in the Step 3 handoff (`npm run demo:stills` *and* `npm run demo:capture`).

Apply the `package.json` / doc changes here (they're code, not a capture); the
maintainer still runs the actual re-capture in Step 3.

## Step 3 — Hand off the capture checklist

Because the maintainer captures the screenshots, end with a clear, runnable
handoff:

- **What changed and why** — the README revisions, any `domotion-svg` upgrade
  (old → new version, from Step 2b), and per scene: added / re-shoot / removed,
  with the one-line reason.
- **Exact commands to capture** — e.g.
  `npm run demo:stills` for a refresh; note it MUST run outside the command
  sandbox (Chromium needs Mach ports — NEWS-311). If the animated hero needs a
  redo, mention `npm run demo:capture` separately. **If Step 2b bumped
  `domotion-svg`, a full re-capture of both is required** — hand off
  `npm run demo:stills` *and* `npm run demo:capture` regardless of which
  scenes changed.
- **What to verify after capture** — the new `assets/demo-*.png` render correctly
  and the README references them.

If a decision is genuinely the maintainer's (e.g. "should we drop the narrative
screenshot or keep both?") and you can't resolve it from the code/docs, ask via
the Hot Sheet `FEEDBACK NEEDED:` mechanism rather than guessing — see the
worklist. Otherwise pick the obvious option, state it, and proceed.

## Guardrails

- **Don't capture screenshots or run the demo servers** — the maintainer does.
  Your output is committed code + a capture checklist.
- **Don't `git push`** (and don't `git commit` unless asked) — follow the
  project's git conventions in `CLAUDE.md`.
- **Keep docs in sync** in the same pass — README claims, `docs/28-demo-capture.md`,
  and the AI summaries must all match what you changed.
- **British-English spelling** (house style here, not glassbox's American — NEWS-364), **no emoji / decorative glyphs** in any prose or UI
  string you touch.
- **Typecheck if you touched TS** (`npm run typecheck`; `npm run lint`) so the
  capture script + demo changes still build before handoff.

## Output

A short report: the README changes made; any `domotion-svg` upgrade (old → new
version, or "already current"); the screenshot-scene decisions (added / re-shot /
removed, each with a reason); the exact capture command(s) for the maintainer to
run; and anything left for them to decide.
