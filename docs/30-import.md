# 30 — Import (and topic export)

**Status: partial.** Topic export (FR-30.2–30.4, NEWS-317) and topic import (FR-30.5–30.9, NEWS-318) are shipped; **story import is still design** (FR-30.10–30.14). Written for NEWS-290 (export/import topic lists) and NEWS-289 (import exported stories), which share enough machinery that answering them separately would have produced two incompatible formats.

The owner was asked four questions on NEWS-290 and three on NEWS-289 and had not answered when this was written, so **every decision below is taken under a stated assumption**, flagged as such. A doc is the right artifact for that: the assumptions are legible and correctable in one place, which they would not be spread through an implementation.

## Why this is a fourth thing

Data already moves out of the app three ways, and none of them is import:

| | What | Shape | Comes back how |
|---|---|---|---|
| [FR-21.4](21-export-and-feed.md) | `GET /api/export.json` — stories | `{exportedAt, title, stories[]}` | **nothing reads it** |
| [FR-27.7](27-data-location.md) | `newsmonger-backup.json` — whole install | `DataFileSchema` | `POST /api/backup/restore`, which **replaces everything** |
| [FR-4.8a](4-cli-server-storage.md) | legacy `data.json` | `DataFileSchema` | imported once, **only into an empty database** |

So the gap is real and specific: **there is no additive way in.** Restore replaces; the legacy importer refuses a database that has been used (NEWS-309 verified that it silently imports nothing). Import is the missing verb.

## The fork this hangs on

- **FR-30.1** *(Design only)* **These are shareable lists, not personal transfers.** A topic export is a small, human-readable, hand-editable file naming topics, their guidance and their classification — something to post in a gist or send to a friend. It carries no ids, no timestamps and no check state, because those describe *this* install and mean nothing on another.

  **Assumed, not confirmed.** The alternative — round-tripping your own topics between your own machines with everything intact — is already served by backup and restore (FR-27.10), so building it again here would be a second, worse copy of a shipped feature. What a *topic* export offers that a backup does not is that a human can read it.

  If the owner wants personal transfer instead, the changes are: keep `createdAt`/`lastCheckedAt`/`coveredThroughAt`, keep `paused` and `highPriority`, and let an import overwrite rather than skip. Every other requirement below survives.

## Topic export

- **FR-30.2** *(Shipped, NEWS-317)* `GET /api/export-topics.json` returns `{exportedAt, topics: [{name, guidance, category, subcategory}]}`. Names are trimmed as stored; `guidance` is included because it is the difference between "Formula 1" and a topic that already knows what you meant by it ([FR-24.12](24-topic-discovery.md)), and it is the single thing that makes a shared list worth more than a list of words.

- **FR-30.3** *(Shipped, NEWS-317)* **`paused` and `highPriority` are not exported.** Both are statements about how *you* are running a topic today, not about the topic. A shared list that silently arrives paused would look broken.

- **FR-30.4** *(Shipped, NEWS-317)* **No API keys, no settings, no stories.** Stated because the file looks like a config file and someone will assume otherwise. `newsmonger-backup.json` has the same property for the same reason (FR-27.7).

## Importing topics

- **FR-30.5** *(Shipped, NEWS-318)* Import is **additive and idempotent**: importing the same file twice leaves the same topics as importing it once.

- **FR-30.6** *(Shipped, NEWS-318)* **A topic already present is skipped, never merged.** Match on the rule the add-topic form already uses — `name = ? COLLATE NOCASE` against the trimmed name — so import and typing agree on what a duplicate is. Reusing that query rather than restating it is the point; two definitions of "same topic" would drift.

  Implemented as `Store.topicExists`, called by **both** `addTopic` and `importTopics`, so there is one query rather than two that started identical. The drift this prevents would show up as an import creating a second "Fusion Energy" beside the "fusion energy" you already follow — a bug nobody would think to look for in a SQL string, which is why the test asserts it through both doors rather than restating the rule.

  **Skipped rather than merged**, and this is the one place the design refuses a plausible alternative outright: adopting an incoming `guidance` for a topic you already have would silently overwrite something you wrote, in a bulk action, with no diff. An import that can destroy work is not an import.

- **FR-30.7** *(Shipped, NEWS-318)* The result is **reported, not silent**: *"Added 7 topics · skipped 3 you already follow."* A bulk action whose outcome you cannot see invites running it twice.

- **FR-30.8** *(Shipped, NEWS-318)* **An imported topic is due, not checked immediately.** Adding a topic by hand fires a check at once ([FR-1.12](1-topics-and-scheduling.md)), which is right for one topic and wrong for twenty: it would spend an hour of provider quota in a burst nobody asked for. Imported topics get `clearedAt`-style baseline treatment — the scheduler picks them up on its own cadence, and "Check all now" is there for anyone impatient.

  **Assumed.** The alternative — ask at import time — adds a decision to a flow whose whole point is bulk.

- **FR-30.9** *(Shipped, NEWS-318)* A file the schema cannot read is **refused whole**, with the reason. Half an import is worse than none, and the transaction discipline is the same as `Store.replaceAll`'s (FR-27.10).

  The 400 carries **zod's own message**, not a generic "invalid request": `topics.0.name: expected string, received number` is the difference between fixing the file and guessing at it. Everywhere else in the API a bad body is a programming error; here it is a file a person chose, quite possibly hand-edited, so it is an ordinary thing to get wrong.

  The schema is correspondingly **lenient about what it ignores and strict about what it accepts**. An `exportedAt` it does not need, or a field from a future version, must not make a usable list unreadable — but a name that is not a string is a file this cannot honestly import. `guidance`, `category` and `subcategory` are optional, so the smallest file a person could type is valid: `{"topics":[{"name":"Fusion energy"}]}`. Bounds match `CreateTopicReqSchema`, since these are the same fields arriving by a different door and a list that could carry a 10,000-character name past the form's limit would be a way around it.

  Duplicates **within one file** collapse by the same rule, because each insert happens before the next entry is examined — a hand-editable file is one someone will paste into twice.

## Importing stories

- **FR-30.10** *(Design only)* Import accepts the file `GET /api/export.json` already produces (FR-21.4). Not a new format: an export nothing can read is the actual complaint behind NEWS-289, and inventing a second shape would leave the first still unreadable.

- **FR-30.11** *(Design only)* **Dedup is on the dedupe key, and there is no other option.** The export carries no ids and no keys, so `dedupeKeyFor` has to recompute one per story — normalized URL, falling back to normalized title ([FR-2.7](2-news-checks-and-dedup.md)). Reuse `filterNewItems` so import and checking agree on what "the same story" means.

  Worth knowing, because it is a real consequence rather than a detail: **an import writes into the same ledger a check reads.** `items` *is* the dedup ledger ([FR-2.13](2-news-checks-and-dedup.md)), so a future check will not re-report an imported story. That is correct — it is the same story — but it means importing quietly narrows what checks will surface.

- **FR-30.12** *(Design only)* **A story whose topic does not exist here creates it.** The export carries the topic *name* precisely so it means something elsewhere. The alternative is dropping those stories, and a story filed under nothing is invisible everywhere in this app — `pruneOrphans` would delete it ([FR-4.8c](4-cli-server-storage.md)).

  So story import is also a topic-creating action. Said plainly here because it is the kind of thing that should not be a surprise, and the report (FR-30.7) names it.

- **FR-30.13** *(Design only)* **Bookmarks come across; off-topic flags cannot.** `saved` is in the export and carries a judgement worth keeping. `offTopic` is not in the export *at all* — [FR-21.2](21-export-and-feed.md) excludes flagged stories from every selection — so the question of whether to import someone else's flags does not arise. That is the right outcome for an independent reason: flagged titles feed the prompt's negative examples ([15 — Off-Topic Flagging](15-off-topic-flagging.md)), so importing them would teach your topics what *someone else* meant.

- **FR-30.14** *(Design only)* `foundAt` is preserved from the file. An imported story is not new; dating it "now" would put a year-old article at the top of today's feed.

## Where it lives

- **FR-30.15** *(Partial, NEWS-317/318)* Settings → Data has a **Topics** group holding *Export topics…* and *Import topics…* side by side. Story import joins the existing `Export` group beside the button whose output it reads.

  **Assumed.** Folding topics into the export dialog was the alternative; that dialog asks two questions (scope × format) and a topic list answers neither. The tab's groups are already named and ordered ([FR-3.68](3-ui.md)), so a new pair of controls belongs in a group of its own rather than wedged into one whose heading would stop being true.

  Placed **after** `Export` rather than before it, which is where this doc first put it: "Export stories…" and "Export topics…" are the same verb on two different nouns, and a reader looking for one will look at the other. `Stories` (retention) is a different question and does not want to sit between them.

  A plain `<a download>`, not a button — the route is a `GET` returning a file, so the browser's own download is the whole mechanism and an anchor gets right-click → Save As for free. `data-external="1"` so the desktop shell hands it to the system browser like every other outbound link (FR-3.8). Its own `.topics-row` class rather than a second `.export-row`: reusing that one made every `.export-row` locator in the E2E suite ambiguous, so "add a button" broke an assertion about a different feature.

- **FR-30.16** *(Shipped, NEWS-318)* Import is **not** in the danger zone and takes no confirm dialog. It cannot destroy anything: it adds, skips and reports. The `Reset` group ([FR-27.11](27-data-location.md)) is for actions with no way back, and putting a safe action there would dilute it.

## Deliberately not in scope

- **Merging guidance**, per FR-30.6.
- **Importing settings or API keys.** Restore already does the former; the latter are never written to the data file at all ([FR-7.2](7-api-keys.md)), and an import format that could carry one would undo that.
- **A URL-based "subscribe to someone's topic list"**, which is a sync feature wearing an import's clothes and would need a fetch path, a refresh policy and a trust story.

## Tests this will need

Written now because they are the parts most likely to be skipped later.

- **Idempotence** — import the same file twice, assert the second changes nothing. FR-30.5 is the requirement most easily broken by a later change and the cheapest to pin.
- **The dedup rule is the *same* rule** — a topic that the add-topic form would reject as a duplicate must be skipped by import, asserted through both paths rather than by restating the query in a test.
- **A malformed file changes nothing** (FR-30.9), asserted on the store afterwards rather than on the error message.
- **Story import does not re-report on the next check** (FR-30.11) — a sequence test, not an operation test: import, then run a check that would have found the same story.
- **`offTopic` really is absent from the export** — pinning FR-30.13's premise, so a future change to FR-21.2 cannot silently start importing other people's flags.
