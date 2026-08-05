# 25 — Topic Editing

A topic's name is not a label — it is the question the app asks. It goes into the prompt verbatim, it is what the classifier reads to file the topic into a section, and it is what dedup compares against. So until now a topic was effectively immutable: a typo, a name that turned out to be ambiguous, or a subject that narrowed over time meant deleting and starting again, losing every story found so far.

See also [1 — Topics and Scheduling](1-topics-and-scheduling.md), [18 — Topic Guidance](18-topic-guidance.md), [22 — Topic Categories](22-topic-categories.md), [26 — Undo](26-undo.md).

## Status: shipped (NEWS-139)

Guidance (FR-18) has been editable since it shipped; this doc covers the **name**, which is the part with consequences.

### Renaming

- **FR-25.1** *(Shipped)* A topic is renamed from its context menu — the same single-target rule as guidance, since there is one name. `PATCH /api/topics/:id { name }`.

- **FR-25.1a** *(Shipped, NEWS-162)* The menu item reads **"Edit topic…"**, not "Rename", and the dialog is headed *Edit "…"* with a **Save** button. A rename reads as relabelling something, and this is the one field in the app where that is exactly wrong: the name is the question put to the model, so changing it changes what gets found. The dialog's hint has said so since NEWS-139 — the menu item was the thing contradicting it, promising a cosmetic edit before the consequence was visible. "Edit topic" also pairs with "Edit guidance" beside it, which is the other half of steering a topic.

  The **operation keeps its name** in the API, the route, the handlers and the tests (`rename`, `data-save-rename`, `renameTopic`): `PATCH { name }` is precisely a rename, and the doc-level framing has been "topic editing" all along. What was wrong was the promise made to the user, not the description of the mechanism. The completion toasts still read "Renamed to …" for the same reason — as a past-tense report of what happened they are accurate, and each already names the consequence ("applies from the next check").

- **FR-25.2** *(Shipped)* The name is trimmed and must be unique **case-insensitively**, the same rule creation applies, because they are the same field. Renaming a topic to the name it already has is a **no-op, not a collision with itself**.

- **FR-25.3** *(Shipped)* A duplicate name is a **409, not a 404**. The distinction matters at the UI: 404 sends someone looking for a missing topic, while 409 is a name they can change. The dialog stays open on failure so the correction happens in the field already in front of them.

- **FR-25.4** *(Shipped)* Renaming takes effect **from the next check**. Nothing retroactively re-runs, and the existing stories keep whatever they were found under.

### Clearing previous results

- **FR-25.5a** *(Shipped)* The story count that decides whether clearing is offered is fetched **when the dialog opens**, from the feed endpoint's `total` (`GET /api/items?topics=<id>&limit=1`). It was briefly carried on `/api/state` instead, which is polled every four seconds by every client — a `GROUP BY` over every story on that path measurably slowed the settings round trip under the full test suite. NEWS-75/76 slimmed that payload deliberately; one dialog needing one number is not a reason to grow it again.

- **FR-25.5b** *(Shipped, NEWS-145)* Clearing is **undoable** for a short window, from the toast that reports it — see [26 — Undo](26-undo.md). That is what makes the asymmetry noted below defensible rather than an accident: deleting a topic confirms first, while clearing its stories is a checkbox, and the stories are the part that cannot be recreated.

- **FR-25.5** *(Shipped)* When a renamed topic already has stories, the dialog offers to clear them — **only when there are stories to clear**, and **unticked by default**. Renaming is usually a correction, and discarding a topic's history should never happen because a box was already checked.

- **FR-25.6** *(Shipped; widened in NEWS-291)* Clearing removes that topic's stories **and resets its check state** — `coveredThroughAt`, `lastCheckedAt`, the failure streak and its cooldown — while recording `clearedAt`. Clearing the stories alone would leave the topic *looking* fresh while still behaving as though it had been covered up to now, so the next check would report nothing; resetting makes it behave like a first check and span a sensible period. The full field-by-field audit is [FR-2.13](2-news-checks-and-dedup.md#what-a-clear-resets), and why a reset topic still is not immediately due is [FR-1.15](1-topics-and-scheduling.md).

- **FR-25.7** *(Shipped)* The **run history is kept**. It records what the app did, not what the topic is about, and the diagnostics bundle would be poorer for losing it.

- **FR-25.8** *(Shipped)* Clearing touches **only the renamed topic**, and is refused without a rename to justify it (`clearItems` requires `name`, enforced in the request schema). There is already a delete for wiping a topic; `PATCH` must not quietly become a second one that happens to leave the topic behind.

- **FR-25.9** *(Shipped)* **The rename is applied before the clear.** A name collision rejects before anything is deleted — a 409 that had already discarded the stories would be the worst outcome this route could produce. Pinned by a test.

- **FR-25.10** *(Shipped, NEWS-303)* **The clear drops that topic's client-only story state, and only that topic's.**

  `recentlyFlaggedItems` holds full copies of stories flagged this session, merged into the feed so a misclick stays reversible ([FR-15.3](15-off-topic-flagging.md), NEWS-61). The *client* owns it, so `refreshState` cannot empty it — flag a story, clear that topic, and the flagged row went on rendering over a feed whose database rows were gone. NEWS-273 fixed this for the app-wide clear (FR-27.11) and left this one; same bug, one topic's worth.

  `clearStoryOverlaysForTopic(topicId)` in `src/client/stores.ts`, called **before** the request — `renameTopic` refreshes state and feed itself, so clearing afterwards leaves a frame in which the emptied feed renders with the stale overlay still merged in.

  **Not the app-wide action under another name.** A per-topic clear deletes exactly one topic's stories, so wiping every topic's overlay would throw away state the action did not invalidate: another topic's just-flagged story, a review of a topic that still holds flagged stories, an expanded card belonging elsewhere. Wiping state an action did not invalidate is the same class of untruth as leaving state it did. Membership comes from `feedItems` and the overlay, which both carry `topicId` — the question is only which of the stories the client is *currently describing* belonged to that topic, so no new server data is needed. `feedLimit` is deliberately not reset: "show more" spans every topic.

  **An undo does not bring a still-flagged story back into view, and that is the decision, not an oversight.** The three options were: accept it, have the undo re-seed the overlay, or filter the overlay to items that still exist. The third is the nicest rule and needs the ids the slimmed `/api/state` does not carry (`latestItemIds` caps at 50) — scoping by topic gets its substance without them.

  The second was rejected on two counts. It restores the wrong thing: an undo reverses the *clear*, not the *flag*, and a story that is still flagged belongs where flagged stories live — review mode shows it and the sidebar badge counts it, so nothing is lost, only filed. And it is not free: `POST /api/topics/:id/restore-cleared` answers with a count, so the route would have to start returning the items — a server-shape change to re-show rows the user has since acted on twice. What the overlay promises is that the row you *just* flagged stays put; it has never promised to survive arbitrary later actions on the topic.

### What renaming deliberately does *not* do

- **The category is left alone.** A renamed topic keeps the section it was filed under, even though the classifier read the old name to choose it. Re-classifying automatically would silently move topics in the filter bar as a side effect of fixing a typo, and FR-22.7 already says a manual choice must survive. Reclassification is available on its own from the topic menu — see [22 — Topic Categories](22-topic-categories.md).
- **Guidance is left alone**, and is edited separately (FR-18).

## Testing

- **Unit** (`tests/unit/rename-topic.test.ts`, 11): rename via `createApp(...)` + `app.request(...)`; trimming; renaming to the same name; the 409 for a duplicate and for a blank name; 404 for a missing topic; clearing resetting `coveredThroughAt`; the run history surviving; other topics untouched; `clearItems` alone rejected; and clearing *not* happening when the rename is rejected.
- **E2E** (`tests/e2e/topics.spec.ts`, 3): rename keeping stories with the clear box present-but-unticked, rename-and-clear affecting only that topic's stories, and a duplicate name leaving the dialog open with the error visible.
