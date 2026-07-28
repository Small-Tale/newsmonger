# Topic categories and the filter bar

Topics are classified into newspaper-style sections so the sidebar can label them and the feed can be filtered to one section at a time. Related: [topics and scheduling](./1-topics-and-scheduling.md), [UI](./3-ui.md), [topic guidance](./18-topic-guidance.md).

**Status: shipped** (FR-22.1–22.10). Topics classify themselves on their first check, the sidebar labels them, and the filter bar narrows the feed to a section.

## The taxonomy

Two levels. Eleven top-level categories, with subcategories only where they earn their place — Sports and Technology need them, Style doesn't.

| # | Category | `slug` | Subcategories |
|---|---|---|---|
| 1 | World | `world` | Africa · Americas · Asia-Pacific · Europe · Middle East |
| 2 | Politics | `politics` | Elections · Policy & Legislation · Government · Courts & Law · Defense |
| 3 | Business | `business` | Markets · Companies · Economy · Startups & VC · Real Estate · Jobs & Labor |
| 4 | Technology | `technology` | AI · Software & Internet · Chips & Hardware · Cybersecurity · Crypto · Consumer Tech |
| 5 | Science | `science` | Space · Climate & Environment · Energy · Biology & Medicine Research · Physics & Math |
| 6 | Health | `health` | Medicine · Public Health · Mental Health · Healthcare Industry · Fitness & Nutrition |
| 7 | Sports | `sports` | Soccer · Football · Basketball · Baseball · Hockey · Tennis · Golf · Motorsport · Combat Sports · Olympics · College |
| 8 | Entertainment | `entertainment` | Film · TV & Streaming · Music · Gaming · Celebrity |
| 9 | Culture | `culture` | Art & Design · Books · Food & Drink · Travel · History · Religion · Ideas |
| 10 | Style | `style` | Fashion · Beauty · Home & Garden |
| 11 | Society | `society` | Education · Crime & Justice · Immigration · Family · Social Issues |

Eleven is a deliberate ceiling: the filter bar has to stay scannable, and a category nobody's topics land in costs bar space permanently.

Three placements were reviewed specifically:

- **Climate & Environment sits under Science**, not at the top level. Much climate news is really politics or business, and promoting it later is a one-line data edit under the model below — whereas a twelfth pill is permanent.
- **Style is separate from Culture**, mirroring the newspaper section, so Fashion is findable on its own with Beauty and Home alongside it.
- **Crime & Justice sits under Society**, not Politics. The split against Politics ▸ Courts & Law is *incidents and policing* vs *rulings and the judiciary*.

## Requirements

- **FR-22.1** *(Shipped)* The taxonomy lives in one module, `BUILTIN_CATEGORIES` in `src/categories.ts`, and is **edited in code**. There is no settings UI and no stored copy — the owner's call: "no UI, this should be code side only, just that it's likely we'll find gaps in the future."

  Consequences worth knowing: the client imports the module directly rather than receiving it over `/api/state`, so the table cannot drift between server and client and the 4-second poll carries no static payload. And `retired` still earns its place even as a code-side flag — see FR-22.4.

- **FR-22.2** *(Shipped)* **Topics store a slug, never a label.** Renaming *Style* → *Fashion & Style* touches one table row and no topic.

- **FR-22.3** *(Shipped)* A stored slug is a **plain string, deliberately not a zod enum**. An enum would mean every taxonomy edit could invalidate stored rows, and hand-editing to a category the code doesn't know would fail the whole load. A slug that no longer resolves simply renders as *Uncategorized*.

- **FR-22.4** *(Shipped)* Categories are **retired, not deleted**. A retired entry disappears from the filter bar and from the classifier's options but still labels topics that hold it, so removal cannot orphan a topic. `activeCategories()` is what the bar and the classifier read; `categoryLabel()` resolves regardless.

- **FR-22.5** *(Shipped)* **Label resolution is most-specific-that-resolves.** `sports`+`soccer` → "Sports · Soccer"; `sports`+unknown → "Sports" (losing a subcategory must not demote a topic all the way); unknown category → "Uncategorized".

- **FR-22.6** *(Shipped)* **"No subcategory" is a rendered fallback, not a stored row.** A topic that is Sports but matches no listed sport stores `sports` / `null` and renders as *Other* in a drilled-down filter bar.

  Requested as "a General subcategory for all categories"; done this way because a stored row per category would have to be remembered for every category added later — reopening the same hole — and because adding *Skiing* next winter would then strand `sports/general` topics claiming to be classified. With `null` they are unclassified-at-sub-level, which is exactly what they are. It also gives the classifier an easier instruction: omit the field rather than choose a catch-all.

- **FR-22.7** *(Shipped)* Topics carry `category` / `subcategory` / `categorySource`, stored as three nullable columns on `topics` (schema v2; an existing v1 database is migrated by `ALTER TABLE`, additive and needing no backfill — an unclassified topic is exactly what `null` means).

  `categorySource: 'auto' | 'manual'` is a promise: automatic classification must not overwrite a choice a person made. `PATCH /api/topics/:id { category, subcategory? }` always writes `'manual'`, because that route only runs when someone chose. **Clearing** (`category: null`) resets the source to `'auto'` — otherwise a cleared topic would be permanently ineligible for classification, which is both invisible and unfixable from the UI. Changing the category drops the subcategory, since a sub from the previous parent resolves to nothing.

  The store **accepts slugs the taxonomy doesn't have**, and so does the route. The taxonomy is code-side and editable, so a slug that resolves today may not tomorrow; rejecting them would make storage the one place that can't survive an ordinary edit. A caller taking a slug from a *model* should still validate — that is FR-22.8's job.

- **FR-22.8** *(Shipped)* Topics are classified automatically, by extending the provider's JSON contract on the news check. No extra API call: a new topic is due immediately, so the label lands on the first check, about a minute after it's added.

  **Asked for only while the topic needs it** — `category === null && categorySource === 'auto'`. A labelled topic would otherwise spend tokens on a settled question every check and could answer differently each time. The label is a property of the topic, not of this week's stories.

  **The model's answer is untrusted.** Options come from `activeCategories()`, never a hard-coded list (FR-22.4), and what comes back is validated against the live taxonomy before it is stored:

  - An unknown **category** drops the whole classification, leaving the topic eligible for a better answer next check. This is the failure that matters: an unresolvable slug renders identically to never-classified (FR-22.5), so storing one would look untouched in the UI while the code considered it done — and it would never be asked again, because `category !== null`.
  - An unknown or **mismatched subcategory** is dropped on its own, keeping the category. Sports-with-no-subcategory is a valid answer (FR-22.6), not a reason to discard a good category.
  - A malformed classification never fails the parse. The stories are the expensive part of the response; a bad category degrades to "not classified" rather than losing the batch.

  The topic is **re-read after the check returns** rather than trusting the copy taken before it. A check takes minutes, and a user may categorise by hand in the meantime — `categorySource: 'manual'` has to win.

  `category`/`subcategory` are declared in `NEWS_JSON_SCHEMA` but not required: `additionalProperties: false` means a structured-output provider would otherwise *reject* a classification, while most checks don't ask for one.

- **FR-22.9** *(Shipped, revised NEWS-111)* The sidebar shows a section label per topic, on **its own line** beneath the topic name and status, carrying the **full path** ("Technology · Consumer Tech").

  It was beside the name at first, showing only the most specific segment because that was all that fit. Both were wrong for the same reason: the label and the name competed for the same ~320px and both truncated — "Consumer Tech" became "CONSUMER …" while a long topic name lost its tail. A full line fits the longest path the built-in taxonomy can produce ("Science · Biology & Medicine Research") and gives the name back the width the badge was taking.

  The label is still bounded, but by the row rather than by a character count, so nothing in the built-in table can trip it — the cap only exists for a hand-edited taxonomy with an unreasonably long label.

  An unclassified topic gets **no label at all** rather than an "Uncategorized" badge — a badge on every unclassified row is noise, and absence already reads as "not yet".

- **FR-22.10** *(Shipped)* A horizontally scrollable filter bar sits directly under the header, above the banners and the sidebar+feed area. **All** · the 11 sections · **Uncategorized** — 13 pills, which is why the taxonomy stops at 11.

  Selecting a section reveals a **second row of its subsections**, styled deliberately unlike the first: the top row is small-caps sans, the sub-row is italic serif separated by hairlines. A newspaper masthead and its subsections — which is what makes "which level am I on" legible without a label saying so. The sub-row is always in the DOM (empty when nothing is selected) rather than conditionally rendered, since it sits above the keyed topics list.

  Both rows scroll horizontally rather than wrapping: a wrapped bar changes height as you select, shifting the whole feed down.

- **FR-22.11** *(Shipped)* The filter is **resolved server-side** as `category`/`subcategory` params on `/api/items`, not client-side over the fetched page. The client holds one page, so filtering there would silently miss matches deeper in history — the bug NEWS-74 existed to fix. It composes with Solo, Saved and Search rather than replacing them.

  Two sentinel slugs carry the selections a table row cannot express: `uncategorized` (topic has no category) and `other` (topic has a category but no subcategory). They live in `src/categories.ts` beside the taxonomy so the client and `Store.queryItems` cannot disagree about their spelling — the client must not import from `db/`, which pulls in `node:sqlite`.

  A story whose topic was deleted mid-check has no topic and therefore no category, so it appears under *Uncategorized*. That falls out of the LEFT JOIN rather than being written anywhere, so it is pinned by a test.

- **FR-22.12** *(Shipped)* The filter is **ephemeral** — cleared on reload, like Solo and for the same reason (`docs/3-ui.md`): a filter that quietly survived a restart would hide news days later, and "the app stopped finding anything" is a far worse failure than re-applying a filter. The sidebar collapse and topic sort *are* persisted, because they change how the app looks rather than what it is willing to show.

## Decisions made

Recorded so they aren't re-litigated. All three were the owner's calls on 2026-07-27.

1. **Classification piggybacks on the first news check** rather than making a dedicated call at topic creation. Free: a new topic is due immediately (`lastCheckedAt === null` ⇒ due, and the scheduler ticks every minute), so the label appears within about a minute. The accepted trade-off is that a topic whose checks keep failing stays uncategorized — a topic that has never fetched news has larger problems than a missing pill.

   A local keyword table was considered and rejected: it would match "Premier League" and miss "Tesla", "Zelensky", "Ozempic", and proper nouns are most of what people actually track.

2. **The taxonomy is edited in code, with no settings UI** (FR-22.1). Gaps are expected and are filled by editing `BUILTIN_CATEGORIES`.

3. **Sub-pills ship as a second row** below the top-level row, styled differently — the newspaper masthead-and-subsection look — rather than being deferred.

## Testing

`tests/e2e/categories.spec.ts` asserts the label is not clipped by **measuring** it — `scrollWidth` against `clientWidth` for the longest path the taxonomy can produce — and that it sits below the name rather than beside it. The measurement carries a guard against its own vacuous pass: a row re-rendered by the 4 s poll can report `scrollWidth === clientWidth === 0` for an instant, and `0 <= 0 + 1` would "prove" the label fits. It did exactly that at first, passing against a deliberately re-broken layout until the non-zero-width check was added.

`tests/e2e/categories.spec.ts` also drives the real bar: pills appearing after classification, narrowing to a section, the sub-row appearing and resetting when the section changes, the Uncategorized pill, composing with search, and the filter not surviving a reload. `tests/unit/items-query.test.ts` covers the server-side filter — both sentinels, composition with saved/search, and pagination *within* a filter.

`tests/unit/classify.test.ts` covers the classification path — when the request is made and withheld, and every way a model answer is rejected. Verified non-vacuous: removing the taxonomy validation fails exactly the four tests that assert rejection.

The mock provider classifies deterministically from the topic name: a name containing a category or subcategory **label** yields that section (so a fixture called "Soccer transfers" is Sports · Soccer and reads as its own documentation), a name containing "uncategorized" declines, and one containing "bogus" returns a slug the taxonomy doesn't have.

`tests/unit/categories.test.ts` covers the seed table's shape (slug uniqueness at both levels, punctuation-safe slugs, the three reviewed placements, nothing shipped retired) and label resolution (each fallback, retired-but-still-labelled, a subcategory belonging to a different category).

Two tests exist specifically to defend decisions rather than behaviour: that no `general`/`other` row is stored, and that the *Other* label is a constant rather than a table entry. Both would pass silently if someone later "fixed" FR-22.6 by adding the rows.
