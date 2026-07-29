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

- **FR-25.6** *(Shipped)* Clearing removes that topic's stories **and resets `coveredThroughAt`**. Clearing the stories alone would leave the topic *looking* fresh while still behaving as though it had been covered up to now, so the next check would report nothing; resetting the window makes it behave like a first check and span a sensible period.

- **FR-25.7** *(Shipped)* The **run history is kept**. It records what the app did, not what the topic is about, and the diagnostics bundle would be poorer for losing it.

- **FR-25.8** *(Shipped)* Clearing touches **only the renamed topic**, and is refused without a rename to justify it (`clearItems` requires `name`, enforced in the request schema). There is already a delete for wiping a topic; `PATCH` must not quietly become a second one that happens to leave the topic behind.

- **FR-25.9** *(Shipped)* **The rename is applied before the clear.** A name collision rejects before anything is deleted — a 409 that had already discarded the stories would be the worst outcome this route could produce. Pinned by a test.

### What renaming deliberately does *not* do

- **The category is left alone.** A renamed topic keeps the section it was filed under, even though the classifier read the old name to choose it. Re-classifying automatically would silently move topics in the filter bar as a side effect of fixing a typo, and FR-22.7 already says a manual choice must survive. Reclassification is available on its own from the topic menu — see [22 — Topic Categories](22-topic-categories.md).
- **Guidance is left alone**, and is edited separately (FR-18).

## Testing

- **Unit** (`tests/unit/rename-topic.test.ts`, 11): rename via `createApp(...)` + `app.request(...)`; trimming; renaming to the same name; the 409 for a duplicate and for a blank name; 404 for a missing topic; clearing resetting `coveredThroughAt`; the run history surviving; other topics untouched; `clearItems` alone rejected; and clearing *not* happening when the rename is rejected.
- **E2E** (`tests/e2e/topics.spec.ts`, 3): rename keeping stories with the clear box present-but-unticked, rename-and-clear affecting only that topic's stories, and a duplicate name leaving the dialog open with the error visible.
