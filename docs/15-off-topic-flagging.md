# 15 — Off-Topic Flagging

Let the user mark specific stories as off-topic so the model can infer what a short topic label actually means. A topic like "Apple" can mean the company or the fruit; flagging a few fruit stories teaches the next check which one the user meant. See also [11 — Story Actions](11-story-actions.md) (bookmark/share) and [3 — UI](3-ui.md).

## Status: shipped

### Flagging

- **FR-15.1** *(Shipped)* Each story has an `offTopic` flag (persisted, default false), toggled via `PATCH /api/items/:id { offTopic }` (`setItemOffTopic`). Flagging/unflagging is reversible.

- **FR-15.2** *(Shipped)* Every story card has a **right-click context menu** (`itemMenuJsx`): **Bookmark** (toggles), **Share**, and **Flag: Off topic** / **Unflag off topic**. The inline bookmark + share buttons stay in the card header for discoverability; flagging lives only in the menu, since it's rarer.

### Feed behaviour

- **FR-15.3** *(Shipped)* A story flagged **this session** collapses to a **dimmed one-liner** — topic chip, title, and an "off topic" pill — so a misclick is visible and undoable. The pill is a button: hovering reveals an × and reddens it, and clicking it prompts (in-app confirm) to unflag. Right-clicking the row still opens the item menu.

- **FR-15.4** *(Shipped)* On **reload**, flagged stories are **hidden from the feed** entirely (the "show collapsed" state is tracked in the ephemeral `recentlyFlagged` set, empty after a reload). They remain in storage.

- **FR-15.5** *(Shipped)* The topic right-click menu has a **"Review Flagged News Items"** entry with a **count badge**, enabled only when the targeted topic(s) have ≥1 flagged story. It switches the feed into a **review mode** showing ONLY those topics' flagged stories, rendered as normal cards with the off-topic pill where the bookmark/share buttons usually sit. An amber banner exits review mode. Review mode is ephemeral and overrides the Solo/Saved/Search filters while active.

  > kerf note: the collapsed row and the full card use **different `data-key`s** (`flag-<id>` vs `<id>`) so morph *swaps* the two rather than reshaping one into the other in place — which it botches. A test enters review without a reload to pin this.

### Prompt integration

- **FR-15.6** *(Shipped)* On each check, a topic's flagged story **titles** (most recent, capped at 10 — `offTopicTitlesForTopic`) are passed through `NewsProvider.checkTopic` into `buildUserPrompt` as a negative-example section: "The user marked these past stories as OFF-TOPIC … prefer stories unlike these." It's framed as intent inference, not a hard blacklist. Every provider forwards the titles; the mock records them for tests.

## Testing

- **Unit**: `Store.setItemOffTopic` + `offTopicTitlesForTopic` (order, cap, topic-scope, reload); `buildUserPrompt` includes/omits the section; `CheckRunner` forwards the titles to the provider; `PATCH /api/items/:id { offTopic }` route.
- **E2E** (`tests/e2e/app.spec.ts`): flag via the item menu → collapse → pill-click confirm (cancel) → **review without reload** → reload hides it → review via the badge → unflag → exit → both stories back.
