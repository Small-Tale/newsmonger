# 31 — Deleting in Bulk

**Status: shipped.** Written for NEWS-328, which asked for a *Delete all topics* button beside the existing story clear, with a confirmation, and suggested renaming both.

The Reset group is the one place in the app that throws work away on purpose. It held one control; it now holds two, and the second is strictly more destructive than the first — which is most of what this document is about.

## The pair

- **FR-31.1** *(Shipped, NEWS-328)* **`Delete all topics`** removes every topic, and with it every story and every run filed under one. `POST /api/topics/clear` → `Store.deleteAllTopics`, in one transaction.

  A topic *owns* its stories and its run history — they are about that topic, not about the app — so leaving either behind would be rows nothing can reach. `pruneOrphans` ([FR-4.8c](4-cli-server-storage.md)) would delete the orphaned stories on the next start anyway, which is a slower route to the same place and a confusing one in between.

  **Settings and API keys are untouched**, and both the button's note and the confirm dialog say so. "Delete all topics" is exactly the phrase that raises the fear it means the whole app.

- **FR-31.2** *(Shipped, NEWS-328)* **Both controls say "Delete", not "Clear".** *Clear all stories* read as tidying — emptying a view — and it removes rows from the database.

  They also had to agree with each other. One called *Clear* beside one called *Delete* implies a difference in severity that does not exist: both are permanent, and neither has an undo. (The per-topic clear does have one — [FR-26.1](26-undo.md) — which is a different control with a different promise.)

  The toast follows the button: "Deleted 14 stories", not "Cleared".

- **FR-31.3** *(Shipped, NEWS-328)* **Each is confirmed, and each confirm names what survives.** A count, then what goes, then what stays, then that it cannot be undone — the shape [FR-27.10](27-data-location.md)'s restore dialog uses, for the same reason: the decision is only makeable if you can see what it replaces.

  The topic dialog additionally names the stories going with them, because that is the part someone might not have thought through. A reader who has just decided the stories are worth keeping should not lose them to the button next door without being told.

- **FR-31.4** *(Shipped, NEWS-328)* **Checks are cancelled first.** A check in flight is about to write stories for a topic that is being deleted; `cancelAllChecks` aborts synchronously and the delete runs before the event loop can hand control back to a check's continuation, which then finds its signal aborted and throws its results away.

  This is [FR-27.11](27-data-location.md)'s rule for the story clear (NEWS-271), applied to the same hazard. **Cancel rather than refuse**: answering "a check is running, try later" asks someone to wait minutes for work whose output they have just decided to delete.

  Both dialogs say a running check will be stopped, and only when one is — a consequence belongs before the decision, not in a toast afterwards.

- **FR-31.5** *(Shipped, NEWS-328)* **Each is disabled when it would do nothing**, with the reason in the note beside it (the NEWS-309 rule: a dead end with no adjacent explanation is the NEWS-40 failure mode). No topics disables the topic delete; no stories disables the story delete.

## Where they live

- **FR-31.6** *(Shipped, NEWS-328)* Side by side in the **Reset** group, as equal halves of one row — the same two-up as the import/export pairs ([FR-3.72](3-ui.md)). They are the two things you can throw away, and someone deciding between them wants to see both at once.

  Still `Reset` rather than "Danger zone". The eyebrow names what the group is *for*; the `danger` variant on the buttons carries the warning, which is where it belongs now that both of them wear it.

## Deliberately not here

- **No "delete everything" button.** Restore-from-backup already replaces the whole install ([FR-27.10](27-data-location.md)), and a single control that took topics, stories, settings *and* keys would be a factory reset — a different feature, with a different confirmation, and one nobody has asked for.
- **No undo.** The per-topic clear has one ([FR-26.1](26-undo.md)) because it is a small, easily-misclicked action on one row. These two are deliberate, confirmed, and named; an undo buffer holding every topic and story in the install would be a copy of the database in memory to guard against a decision the user just typed through a dialog to make.
- **No selective bulk delete** ("delete the paused ones", "delete everything older than…"). Both are plausible and neither was asked for; the per-topic delete already covers the shape of "some of them".
