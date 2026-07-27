# 20 — First-Run Onboarding

Before this, a new user opened News to an empty sidebar and a one-line empty state. Nothing told them the app could do *nothing at all* until an AI provider was configured — and the way to configure one was behind a gear icon, in a dialog whose first three fields are about something else. For anyone other than the author, that was the point where the app was abandoned.

See also [6 — AI Providers](6-providers.md), [7 — API Keys and Settings Dialog](7-api-keys.md), and [19 — Cost Visibility](19-cost-visibility.md).

## Status: shipped

### When it appears

- **FR-20.1** *(Shipped)* The guide opens by itself only when the app is genuinely unusable: **no topics and no available provider**. Someone who already has either is never interrupted.

- **FR-20.2** *(Shipped)* The decision waits for **both** `/api/state` and `/api/providers` to answer. The provider list starts empty, so acting before the probe returns would flash the wizard at every existing user on every reload — the client holds an explicit `'auto'` (undecided) state rather than treating "not yet loaded" as "nothing available".

- **FR-20.3** *(Shipped)* Dismissal is remembered per device (`localStorage`, alongside the other view preferences — it records what *this* browser has shown, not anything about the data). After that only **Settings → "Show the setup guide again"** reopens it.

### The four steps

- **FR-20.4** *(Shipped)* **Welcome** — what the app actually does: you name topics, it asks an AI with live web search whether anything is genuinely new, and repeats nothing you've already been shown.

- **FR-20.5** *(Shipped)* **Source** — how it authenticates. **A signed-in `claude-cli` / `codex-cli` subscription is presented first when one is detected**: someone already paying for Claude or ChatGPT needs no key at all, and burying that behind two key fields hides the easy answer behind the hard one. With no subscription, the same key rows as Settings, and a note that keys live in the OS keychain.

- **FR-20.6** *(Shipped)* **Topics** — six broad starter topics as toggle chips, chosen so any of them returns something on the first check rather than leaving the new user staring at an empty feed. Picking none is fine and says so. The running count notes that each topic is checked on its own, so more topics means more checks — the cost consequence stated where the choice is made.

- **FR-20.7** *(Shipped)* **Schedule** — the interval, framed by what it costs rather than as a bare dropdown, and pointing at the spending cap in Settings.

- **FR-20.8** *(Shipped)* Every step is skippable, and the backdrop deliberately does **not** dismiss on click — this is the one dialog whose whole job is to be read, and a stray click behind it shouldn't silently end setup. Finishing creates the chosen topics one at a time (each `POST /api/topics` fires its own first check — FR-1.12).

### Key verification

- **FR-20.9** *(Shipped)* `PUT /api/keys/:provider` **checks the key with the vendor before storing it**, so a typo surfaces immediately instead of as a failed check hours later. The probe lists models — the cheapest authenticated call each vendor offers. Deliberately not a completion: spending tokens (or plan quota) to answer "is this typed correctly?" is a bad trade, and it is the same reasoning as [9 — Subscription Providers](9-subscription-providers.md) FR-9.6.

- **FR-20.10** *(Shipped)* **Only an authentication failure (401/403) blocks the save.** Anything else — offline, proxied, a vendor outage — is `unknown`, and the key is stored anyway. Telling users their key is wrong because *we* couldn't reach the vendor is the worse failure: it sends them off to regenerate a key that was fine.

- **FR-20.11** *(Shipped)* The verifier is injected (`createApp({ verifyKey })`). `--ai-test` passes null, so the E2E suite can save deliberately-fake keys, and unit tests never touch the network.

## Testing

- **Unit** (`tests/unit/key-verify.test.ts`, 7 tests): a valid key saves and the vendor is asked exactly once with the **trimmed** value; an invalid key is rejected with the vendor's reason **and is not stored**; an `unknown` verdict saves anyway; a null verifier skips the check; an empty key never reaches the vendor.
- **E2E** (`tests/e2e/app.spec.ts`): the guide **does not** auto-open once topics and a provider exist (the regression that would annoy every existing user), reopens from Settings, walks welcome → source → topics → schedule, toggles a starter chip with the count following, and closes on skip without creating anything.
- The auto-open path on a genuinely fresh install is **manual** — the E2E suite shares one server whose state is built up by earlier specs, so it can never be in the no-topics/no-provider state. See `manual-test-plan.md`.
