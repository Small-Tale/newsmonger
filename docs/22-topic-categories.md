# Topic categories and the filter bar

Topics are classified into newspaper-style sections so the sidebar can label them and the feed can be filtered to one section at a time. Related: [topics and scheduling](./1-topics-and-scheduling.md), [UI](./3-ui.md), [topic guidance](./18-topic-guidance.md).

**Status: partly built.** The taxonomy and its resolution logic are shipped (FR-22.1–22.6). Nothing yet writes a category onto a topic, and there is no filter bar — those depend on decisions still open with the owner (see [Open questions](#open-questions)). Tracked by NEWS-97 and its follow-ups.

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

- **FR-22.1** *(Shipped)* The taxonomy is **data seeded from built-ins** (`BUILTIN_CATEGORIES` in `src/categories.ts`), not a hard-coded list. Adding, renaming or retiring a category is a data write, not a release.

- **FR-22.2** *(Shipped)* **Topics store a slug, never a label.** Renaming *Style* → *Fashion & Style* touches one table row and no topic.

- **FR-22.3** *(Shipped)* A stored slug is a **plain string, deliberately not a zod enum**. An enum would mean every taxonomy edit could invalidate stored rows, and hand-editing to a category the code doesn't know would fail the whole load. A slug that no longer resolves simply renders as *Uncategorized*.

- **FR-22.4** *(Shipped)* Categories are **retired, not deleted**. A retired entry disappears from the filter bar and from the classifier's options but still labels topics that hold it, so removal cannot orphan a topic. `activeCategories()` is what the bar and the classifier read; `categoryLabel()` resolves regardless.

- **FR-22.5** *(Shipped)* **Label resolution is most-specific-that-resolves.** `sports`+`soccer` → "Sports · Soccer"; `sports`+unknown → "Sports" (losing a subcategory must not demote a topic all the way); unknown category → "Uncategorized".

- **FR-22.6** *(Shipped)* **"No subcategory" is a rendered fallback, not a stored row.** A topic that is Sports but matches no listed sport stores `sports` / `null` and renders as *Other* in a drilled-down filter bar.

  Requested as "a General subcategory for all categories"; done this way because a stored row per category would have to be remembered for every category added later — reopening the same hole — and because adding *Skiing* next winter would then strand `sports/general` topics claiming to be classified. With `null` they are unclassified-at-sub-level, which is exactly what they are. It also gives the classifier an easier instruction: omit the field rather than choose a catch-all.

- **FR-22.7** *(Not built)* Topics carry `category` / `subcategory` / `categorySource`. `categorySource: 'auto' | 'manual'` exists so a user's own choice is never overwritten by a later automatic classification.

- **FR-22.8** *(Not built)* Topics are classified automatically. See [Open questions](#open-questions) — the mechanism is undecided.

- **FR-22.9** *(Not built)* The sidebar shows a pill per topic with the most specific label.

- **FR-22.10** *(Not built)* A horizontally scrollable filter bar sits between the page header and the sidebar+content area, filtering the feed to a category.

## Open questions

Blocking the unbuilt requirements above. Recorded here so the design isn't re-derived later.

1. **Classification mechanism.** Piggyback on the first news check (free — a new topic is due immediately, so the pill appears within a minute — but a topic whose checks keep failing stays uncategorized), or a dedicated classification call at creation (instant and failure-independent, but a new method on all five providers plus a per-topic cost)?

   A local keyword table was considered and rejected: it would match "Premier League" and miss "Tesla", "Zelensky", "Ozempic", and proper nouns are most of what people track.

2. **Editing the taxonomy.** A settings UI for add/rename/retire, or is hand-editing the stored table enough for now? The data model supports both; only the UI is extra work.

3. **Second-level filtering.** Top-level pills only at first, with sub-pills as a second row once a category is selected — or both rows from the outset?

## Testing

`tests/unit/categories.test.ts` covers the seed table's shape (slug uniqueness at both levels, punctuation-safe slugs, the three reviewed placements, nothing shipped retired) and label resolution (each fallback, retired-but-still-labelled, a subcategory belonging to a different category).

Two tests exist specifically to defend decisions rather than behaviour: that no `general`/`other` row is stored, and that the *Other* label is a constant rather than a table entry. Both would pass silently if someone later "fixed" FR-22.6 by adding the rows.
