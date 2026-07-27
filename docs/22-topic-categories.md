# Topic categories and the filter bar

Topics are classified into newspaper-style sections so the sidebar can label them and the feed can be filtered to one section at a time. Related: [topics and scheduling](./1-topics-and-scheduling.md), [UI](./3-ui.md), [topic guidance](./18-topic-guidance.md).

**Status: partly built.** The taxonomy, its resolution logic and topic storage are shipped (FR-22.1–22.7). Automatic classification and the UI are not yet (FR-22.8–22.10) — NEWS-107 and NEWS-108.

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

- **FR-22.8** *(Not built — NEWS-107)* Topics are classified automatically, by extending the provider's JSON contract on the first news check. Options come from `activeCategories()`, never a hard-coded list. A slug the model returns that isn't in the taxonomy is **dropped rather than stored**: unresolvable renders identically to never-classified, so a bad write would be invisible. Only writes when the topic is unset or `categorySource === 'auto'`.

- **FR-22.9** *(Not built — NEWS-108)* The sidebar shows a pill per topic with the most specific label, coloured by top-level category.

- **FR-22.10** *(Not built — NEWS-108)* A horizontally scrollable filter bar sits between the page header and the sidebar+content area, filtering the feed to a category. Selecting a category reveals a **second row of its subcategories**, styled differently from the first — a newspaper masthead and its subsections.

## Decisions made

Recorded so they aren't re-litigated. All three were the owner's calls on 2026-07-27.

1. **Classification piggybacks on the first news check** rather than making a dedicated call at topic creation. Free: a new topic is due immediately (`lastCheckedAt === null` ⇒ due, and the scheduler ticks every minute), so the label appears within about a minute. The accepted trade-off is that a topic whose checks keep failing stays uncategorized — a topic that has never fetched news has larger problems than a missing pill.

   A local keyword table was considered and rejected: it would match "Premier League" and miss "Tesla", "Zelensky", "Ozempic", and proper nouns are most of what people actually track.

2. **The taxonomy is edited in code, with no settings UI** (FR-22.1). Gaps are expected and are filled by editing `BUILTIN_CATEGORIES`.

3. **Sub-pills ship as a second row** below the top-level row, styled differently — the newspaper masthead-and-subsection look — rather than being deferred.

## Testing

`tests/unit/categories.test.ts` covers the seed table's shape (slug uniqueness at both levels, punctuation-safe slugs, the three reviewed placements, nothing shipped retired) and label resolution (each fallback, retired-but-still-labelled, a subcategory belonging to a different category).

Two tests exist specifically to defend decisions rather than behaviour: that no `general`/`other` row is stored, and that the *Other* label is a constant rather than a table entry. Both would pass silently if someone later "fixed" FR-22.6 by adding the rows.
