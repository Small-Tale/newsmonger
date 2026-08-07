# 20 — First-Run Onboarding

Before this, a new user opened Newsmonger to an empty sidebar and a one-line empty state. Nothing told them the app could do *nothing at all* until an AI provider was configured — and the way to configure one was behind a gear icon, in a dialog whose first three fields are about something else. For anyone other than the author, that was the point where the app was abandoned.

See also [6 — AI Providers](6-providers.md), [7 — API Keys and Settings Dialog](7-api-keys.md).

## Status: shipped

### When it appears

- **FR-20.1** *(Shipped)* The guide opens by itself only when the app is genuinely unusable: **no topics and no available provider**. Someone who already has either is never interrupted.

- **FR-20.2** *(Shipped)* The decision waits for **both** `/api/state` and `/api/providers` to answer. The provider list starts empty, so acting before the probe returns would flash the wizard at every existing user on every reload — the client holds an explicit `'auto'` (undecided) state rather than treating "not yet loaded" as "nothing available".

- **FR-20.3** *(Shipped)* Dismissal is remembered per device (`localStorage`, alongside the other view preferences — it records what *this* browser has shown, not anything about the data). After that only **Settings → "Show the setup guide again"** reopens it.

### The six steps

**Order: welcome → source → profiles → location → topics → schedule.** Profiles and Location sit *after* Source because a provider may be needed to act on them, and *before* Topics because that step creates topics and each fires its first check immediately (FR-1.12) — anything asked afterwards lands too late to steer the very check it exists to steer.

- **FR-20.4** *(Shipped)* **Welcome** — what the app actually does: you name topics, it asks an AI with live web search whether anything is genuinely new, and repeats nothing you've already been shown.

- **FR-20.5** *(Shipped)* **Source** — how it authenticates. **A signed-in `claude-cli` / `codex-cli` subscription is presented first when one is detected**: someone already paying for Claude or ChatGPT needs no key at all, and burying that behind two key fields hides the easy answer behind the hard one. With no subscription, the same key rows as Settings, and a note that keys live in the OS keychain.

- **FR-20.6** *(Shipped)* **Topics** — six broad starter topics as toggle chips, chosen so any of them returns something on the first check rather than leaving the new user staring at an empty feed. Picking none is fine and says so. The running count notes that each topic is checked on its own, so more topics means more checks — the cost consequence stated where the choice is made.

  **Since NEWS-146 the step opens the real discovery dialog** (see [24 — Topic Discovery](24-topic-discovery.md) FR-24.18). NEWS-128 first gave this step a describe-what-you're-into box of its own, which was a *second, smaller discovery*: it answered the same question as the real dialog with a fraction of the answer — no section grid for someone who cannot yet name what they want, no reason or ongoing/evergreen label on a suggestion, no narrower/similar, no second batch. Two implementations of one idea, and the reduced one was the copy a new user met first. The step now carries a **Discover topics** button wired to the *same* `data-action=open-discover` the sidebar's compass uses, so there is still exactly one delegate for "open discovery".

- **FR-20.6a** *(Shipped, NEWS-146)* **Two ways to leave the Topics step with topics, and the step says which is which.** A ticked starter chip is a reservation Finish turns into a topic; anything added inside discovery **already exists and is already checking**, because Add creates immediately (FR-24.26) and that is what makes its first check fire straight away. One combined number would misreport the half that can no longer be unticked, so the running count names them separately — "3 chosen, created when you finish · 2 added already and checking".

  The added count is a **difference against the topic count when the step opened**, not a raw total: onboarding is normally a first run, but Settings reopens it for someone who already has topics, and those are not something they just added. Deleting a topic mid-flow drives the difference below zero, which reads as none rather than as "-1 added".

  Wording lives in `src/client/onboarding.ts` (`onboardingCountText`) rather than inline in the dialog, so its branches are unit-testable without a browser — the same reason `dial.ts` and `topic-sort.ts` are separate modules.

- **FR-20.6b** *(Shipped, NEWS-146)* Discovery opens **over** the wizard, and **Escape closes discovery alone**. The Escape ladder had no rung for discovery before this — harmless while it could only open over the page, but with a wizard underneath it closed the wizard and left discovery floating on top of nothing. Tab-trapping needed no change: it reads the last `.dialog-backdrop .dialog` in the DOM, and `#discover-slot` follows `#onboarding-slot`.

  The starters are **not** dead code: onboarding runs before a provider is necessarily configured (Source comes first but is skippable), so when no provider would resolve, the step falls back to them and says why. That check mirrors `resolveProvider` rather than asking "is anything available" — an explicitly-chosen provider must itself be usable, or someone who picked OpenAI without a key would be offered a button that cannot work because an unrelated signed-in CLI happens to be present.

- **FR-20.12** *(Shipped, NEWS-383)* **Profiles** — "what are you into?", 48 reader profiles as toggle chips across **three pages of sixteen**, shown one page at a time. Zero or more per page.

  **Each page independently spans all twelve interest facets**, and that is the property the paging depends on rather than a nicety. The obvious build is page 1 = professions, page 2 = hobbies, page 3 = culture; that is wrong here *because pages are individually skippable*, so anyone who stopped after page 1 would have been offered only professions. `profiles.test.ts` asserts the spread, because "the pages are diverse" is exactly the claim that quietly stops being true after two edits.

  The chips name **a kind of person, not a subject** — "Foodie", not "Food". A label that is already a topic gives a topic generator nothing to add.

  **Continue pages through the three, then advances the step**, so the wizard keeps one primary button and its dots keep counting steps. A separate **Skip these** leaves the remaining pages without leaving setup — and saves what is already ticked on the way out, because someone who picked six things on page one and then skipped meant to keep the six.

- **FR-20.13** *(Shipped, NEWS-383)* Selections are stored as **ids, never labels** (`settings.profiles`), so rewording a chip cannot orphan everyone who ticked it. Reopening the guide from Settings **pre-ticks what is already saved** — a returning user shown a blank grid would reasonably conclude their choices were lost.

  Unknown ids are kept in storage and dropped on read (`resolveProfiles`), the same call `categories.ts` makes for an unresolvable slug: an export written by a build with one extra profile must still import, and losing one chip beats losing the import.

  **They are deliberately absent from the JSON topic export** (FR-30.4 excludes settings). That export is a topic list for sharing, and a shared list should not carry "I am a Retiree interested in mental health". The SQLite backup covers them, being a copy of everything.

- **FR-20.14** *(Shipped, NEWS-394)* **Location** — where the user is, as free text in any script, with six continent buttons that fill the same field. See [35 — Location](35-location.md) for why there is no place list and no validation. Skippable; empty keeps every topic global.

- **FR-20.7** *(Shipped)* **Schedule** — the interval, framed by what it costs rather than as a bare dropdown, and pointing at the spending cap in Settings.

- **FR-20.8** *(Shipped)* Every step is skippable, and the backdrop deliberately does **not** dismiss on click — this is the one dialog whose whole job is to be read, and a stray click behind it shouldn't silently end setup. Finishing creates the chosen topics one at a time (each `POST /api/topics` fires its own first check — FR-1.12).

### Key verification

- **FR-20.9** *(Shipped)* `PUT /api/keys/:provider` **checks the key with the vendor before storing it**, so a typo surfaces immediately instead of as a failed check hours later. The probe lists models — the cheapest authenticated call each vendor offers. Deliberately not a completion: spending tokens (or plan quota) to answer "is this typed correctly?" is a bad trade, and it is the same reasoning as [9 — Subscription Providers](9-subscription-providers.md) FR-9.6.

- **FR-20.10** *(Shipped)* **Only an authentication failure (401/403) blocks the save.** Anything else — offline, proxied, a vendor outage — is `unknown`, and the key is stored anyway. Telling users their key is wrong because *we* couldn't reach the vendor is the worse failure: it sends them off to regenerate a key that was fine.

- **FR-20.11** *(Shipped)* The verifier is injected (`createApp({ verifyKey })`). `--ai-test` passes null, so the E2E suite can save deliberately-fake keys, and unit tests never touch the network.

## Testing

- **Unit** (`tests/unit/key-verify.test.ts`, 7 tests): a valid key saves and the vendor is asked exactly once with the **trimmed** value; an invalid key is rejected with the vendor's reason **and is not stored**; an `unknown` verdict saves anyway; a null verifier skips the check; an empty key never reaches the vendor.
- **E2E** (`tests/e2e/settings-layout.spec.ts`): the guide **does not** auto-open once topics and a provider exist (the regression that would annoy every existing user), reopens from Settings, walks welcome → source → topics → schedule, toggles a starter chip with the count following, and closes on skip without creating anything.
- The auto-open path on a genuinely fresh install is **manual** — the E2E suite shares one server whose state is built up by earlier specs, so it can never be in the no-topics/no-provider state. See `manual-test-plan.md`.
