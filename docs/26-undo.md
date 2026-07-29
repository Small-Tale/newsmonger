# 26 — Undo

Almost nothing in News is destructive. Stories accumulate, topics can be paused, a rename applies from the next check and leaves history alone. There are exactly two exceptions, and until NEWS-145 they were guarded very differently: **deleting a topic** asks for confirmation, while **clearing a topic's stories** was a checkbox on the rename dialog.

That asymmetry may look defensible — the topic survives a clear — but the stories do not, and they are the part that cannot be recreated. A check re-fills a cleared topic, but not with the *same* stories, and not for the window that was reset with them. This document covers the undo that makes the checkbox defensible rather than an accident of implementation.

See also [25 — Topic Editing](25-topic-editing.md), where clearing is specified (FR-25.5–25.9), and [3 — UI](3-ui.md) for the toast.

## Status: shipped (NEWS-145)

### What is undoable

- **FR-26.1** *(Shipped)* Clearing a topic's stories is undoable for a short window. Nothing else is: deleting a topic already confirms first, and everything else in the app is reversible by doing it again.

- **FR-26.2** *(Shipped)* The undo restores **both halves of what the clear removed** — the stories *and* `coveredThroughAt`. Clearing nulls the window so the next check spans a sensible period (FR-25.6); an undo that put the stories back and left the window null would re-report every restored story as new on the next check, which is a worse outcome than the clear.

- **FR-26.3** *(Shipped)* Stories return **under their original ids**, with `saved` and `offTopic` intact. A story's id is what a bookmark, an off-topic flag and an open share dialog all refer to, so re-adding it under a fresh id would restore the text while quietly breaking every reference to it. An undo that silently un-bookmarked a story is worse than the clear it was undoing.

### The window

- **FR-26.4** *(Shipped)* The snapshot is held **in memory in the server process**, in `ClearUndoBuffer` (`src/undo.ts`), keyed by topic id with a 60-second TTL and a small entry cap.

  The alternative considered was a **soft-delete column** swept later, which survives a restart. It was rejected as a poor trade: it costs a schema change and a filter on every read path that touches items — real surface area for a real bug — to catch a case (clear, restart the server, then change your mind) that is not the one the undo exists for. The case it exists for is ticking the box without meaning to, and noticing at once.

  The consequence is stated rather than hidden: **a reload during the window forfeits the undo**, because the buffer lives in the server process and not in the page.

- **FR-26.5** *(Shipped)* Keyed **per topic**, so clearing a second topic does not displace the first's undo, and re-clearing the *same* topic replaces its snapshot — the newer one is the one that matches what is on screen. Re-remembering also refreshes a topic against eviction, or the cap would drop the freshest snapshot for the most recently cleared topic.

- **FR-26.6** *(Shipped)* The toast that offers the undo stays up **9 seconds**, against 2.6 for a plain one, and comfortably inside the server's TTL so the button is never on screen after the snapshot behind it has gone. The two toasts ask different things of the reader: a plain one only has to be *noticed*, while this one has to be read, understood as reversible, and acted on with the mouse. A window that expires mid-reach is worse than no undo, because it teaches that the affordance is unreliable.

### The surface

- **FR-26.7** *(Shipped)* The offer is an **Undo button in the toast** that reports the clear, and the toast names the count — "cleared 34 stories", from the number the rename dialog already fetched when it opened (FR-25.5a) — rather than saying "some stories".

- **FR-26.8** *(Shipped)* A plain toast keeps `pointer-events: none`, so a transient notice can never swallow a click meant for the page; only the actionable one opts back in, via an `actionable` class.

- **FR-26.9** *(Shipped)* An expired window is **not an error**. The user pressed a button the app was still showing them, so it replaces the toast with a plain notice rather than raising the red banner reserved for real failures — which would read as "something broke" instead of "you were too slow".

### API

- **FR-26.10** *(Shipped)* `POST /api/topics/:id/restore-cleared`. A separate route rather than a `PATCH` flag: this is not an edit to the topic but the reversal of one, and it must not be reachable by accident from a request that meant to rename something.

- **FR-26.11** *(Shipped)* An expired or already-used window answers **410, not 404**. The topic is right there; what is gone is the offer, and a 404 would say the wrong thing expired.

- **FR-26.12** *(Shipped)* A topic deleted while its undo was on offer answers **404, and inserts nothing**. `items` has no foreign key on `topic_id`, so restoring here would silently create rows belonging to nothing — invisible in the feed, and counted by every aggregate. The check runs **before** the snapshot is consumed, so a failed restore does not also destroy the undo.

- **FR-26.13** *(Shipped)* A clear that removed **nothing** offers no undo. Remembering an empty snapshot would put a live "Undo" on a clear that did nothing.

- **FR-26.14** *(Shipped)* A **rejected** rename clears nothing and stashes nothing. FR-25.9 already orders the rename before the clear so a 409 cannot discard stories; the undo buffer sits inside that same branch and inherits the ordering.

## Testing

- **Unit** (`tests/unit/undo-clear.test.ts`, 14): the buffer on its own — take-once, per-topic isolation, replacement, expiry on an injected clock, eviction, and re-remembering refreshing against eviction — then the route through `createApp(...)`: stories and window restored together, original ids and flags preserved, the second undo a 410 rather than a double restore, 410 with no snapshot, 404 plus zero inserts for a deleted topic, no undo for an empty clear, and none for a rename without a clear or a rename that was rejected.
- **E2E** (`tests/e2e/topics.spec.ts`, 2): clear a topic with a bookmarked story, undo from the toast, and assert the stories *and* the bookmark are back; and a plain toast has no Undo and does not take pointer events.
