# 33 — Getting a Set-Aside Database Back

**Status: shipped.** Written for NEWS-342.

[FR-4.9](4-cli-server-storage.md) answers a database it cannot open by renaming it to `newsmonger.db.corrupt-<ts>` and starting fresh. [FR-4.17](4-cli-server-storage.md) tells the user that happened and where the file went. This document is the answer to the question that follows immediately after: **can I have it back?**

Until this shipped, the answer was "quit the app, find your data folder, rename a file, restart" — which is a real procedure a real person can follow, and also one nobody should have to work out while looking at an app that has just lost their topics.

## What it does

- **FR-33.1** *(Shipped, NEWS-342)* **`GET /api/recover/candidates` lists every set-aside database in the data directory, newest first, with what each one holds** — topic, story and run counts — or the reason it still cannot be read.

  Read from the **directory**, not from the FR-4.17 notice. That notice is dismissible, and a route back that a dismissal destroys is not a route back. Reading the directory also finds files left by builds that predate the notice entirely, which is most of the ones that exist.

  The name matched is `newsmonger.db.corrupt-<digits>` and nothing else. That is what the client hands back to recover, so keeping it a bare name is also what makes the path join safe — it can never contain a separator or a `..`.

- **FR-33.2** *(Shipped, NEWS-342)* **Settings → Data → Recovery** shows them, and is **absent entirely when there is nothing to recover** — which is the state of essentially every install. The eyebrow lives inside the conditional ([NEWS-307](3-ui.md)): a *Recovery* heading over nothing is a question with no answer.

  Its own group rather than part of Backup. A backup is a snapshot the user asked for; this is the database the app took away from them. Reading them as one thing would suggest the second is as routine as the first.

  The candidate list is fetched when the Data tab opens, **not on the 4-second poll**: inspecting a candidate means copying and opening a database, which is far too much to do every four seconds for a list that is almost always empty.

- **FR-33.3** *(Shipped, NEWS-342)* **A file that still cannot be read is listed anyway, with the reason where the button would be.** No disabled control — a dead end with no adjacent explanation is the [NEWS-309](3-ui.md) failure mode — and one unreadable file never hides the readable ones beside it.

  Worth listing rather than hiding, because "we still cannot read this" is itself something the user needs told: it is the difference between *there is nothing to be done* and *nobody has tried*.

- **FR-33.4** *(Shipped, NEWS-342)* **`POST /api/recover` replaces everything in the live database with the set-aside one**, behind a confirmation naming what replaces what, what survives, and that it cannot be undone — the [FR-31.3](31-bulk-delete.md) shape, for the same reason. Whoever is reading that dialog has already lost data once today.

  **The current contents are written to `pre-recover-<ts>.json` first.** Someone recovering may have added topics since; those are not silently the price of getting the old ones back. This must not be the second irreversible step in a story that started with one.

  **The set-aside file is left exactly where it is.** Recovering is a copy, not a move — if the result is not what they hoped, the original is still there to try again from, and it is still listed afterwards.

  The FR-4.17 notice is dismissed on success, since it has now been answered.

## How, and why it is not a file swap

- **FR-33.5** *(Shipped, NEWS-342)* **Nothing here swaps files.** The set-aside database is opened *separately*, read out, and written into the live database through `Store.replaceAll` — the same route [FR-27.10](27-data-location.md)'s restore takes.

  The live `Store` holds an open connection. Replacing the file underneath it would mean tearing down and rebuilding that connection mid-request, or requiring a restart, and would be a worse problem than the one being solved. Going through `replaceAll` means one transaction, no restart, and no new failure mode.

- **FR-33.6** *(Shipped, NEWS-342)* **Inspection always happens against a copy.** `openDb` migrates what it opens, and a set-aside file is the user's only copy of that data — reading it must never be the thing that changes it. Verified by a test that hashes the file before and after listing.

  The copy is also what makes an **old** quarantine recoverable. [NEWS-335](4-cli-server-storage.md) made migrations idempotent and [NEWS-336](4-cli-server-storage.md) narrowed what counts as unreadable, so a database set aside by an earlier build may well open cleanly today. That is the case this feature is most useful for, and the one that actually exists in the wild.

- **FR-33.7** *(Shipped, NEWS-342)* **The file is opened with `openDb` before `Store`.** `Store`'s constructor answers an unreadable file by quarantining it and starting fresh — which here would look like a database that simply had nothing in it, and would report a silent, empty "recovery" as a success. `openDb` throws instead, and the thrown reason is what FR-33.3 shows.

## Deliberately not here

- **No recovery from the banner itself.** The banner points at Settings rather than carrying the action. It is dismissible, and the durable route must not live on something designed to be got rid of.
- **No automatic recovery.** Replacing the whole database is not a thing to do on the user's behalf, however confident the counts look.
- **No deleting the set-aside file.** Not after a successful recovery, and not as a separate control. Disk is cheap and the file is the last copy of something that was already nearly lost; whoever wants it gone can delete it themselves.
- **No merge.** "Keep my new topics *and* the recovered ones" is a plausible ask and a different feature — it needs a dedupe rule, a conflict story, and a preview. Import ([FR-30.2](30-import.md)) is the additive tool, and the safety copy means nothing is lost to the replacement either way.

## Related

- [4 — CLI, Server, and Storage](4-cli-server-storage.md) — FR-4.9 sets the file aside, FR-4.17 says so, FR-4.18 explains why it starts fresh rather than stopping.
- [27 — Data Location](27-data-location.md) — FR-27.10's restore, whose `replaceAll` route this borrows.
- [8 — Article Images](8-article-images.md) — FR-8.19 is why a recovered story's pictures are usually still cached, and FR-8.20 refetches the ones that are not.
