# Topic categories and the filter bar

Topics are classified into newspaper-style sections so the sidebar can label them and the feed can be filtered to one section at a time. Related: [topics and scheduling](./1-topics-and-scheduling.md), [UI](./3-ui.md), [topic guidance](./18-topic-guidance.md).

**Status: shipped** (FR-22.1–22.10). Topics classify themselves on their first check, the sidebar labels them, and the filter bar narrows the feed to a section.

## The taxonomy

Two levels. **Twenty top-level sections** since NEWS-388, each with subcategories.

| # | Category | `slug` | Subcategories |
|---|---|---|---|
| 1 | World | `world` | Africa · Americas · Asia-Pacific · Europe · Middle East · Conflict & Security · Global Development |
| 2 | Politics | `politics` | Elections · Policy & Legislation · Government · Defense · Parties & Campaigns · Polling & Public Opinion |
| 3 | Business | `business` | Markets · Companies · Economy · Startups & VC · Jobs & Labor · Small Business · Trade & Supply Chains |
| 4 | Money | `money` | Personal Finance · Housing & Property · Retirement & Pensions · Tax · Consumer Rights & Prices · Insurance |
| 5 | Technology | `technology` | AI · Software & Internet · Chips & Hardware · Cybersecurity · Crypto · Consumer Tech · Developer Tools · Data & Privacy |
| 6 | Science | `science` | Space & Astronomy · Biology & Medicine Research · Physics & Math · Earth Sciences · Archaeology & Anthropology · Research & Academia |
| 7 | Environment | `environment` | Climate · Energy · Conservation & Wildlife · Pollution & Waste · Weather & Natural Disasters · Water & Oceans |
| 8 | Health | `health` | Medicine · Public Health · Mental Health · Healthcare Industry · Fitness & Nutrition · Pharma & Drug Development · Aging & Longevity |
| 9 | Sports | `sports` | Soccer · Football · Basketball · Baseball · Hockey · Cricket · Tennis · Golf · Motorsport · Combat Sports · Running & Endurance · Cycling · Winter Sports · Water Sports · Olympics · College |
| 10 | Entertainment | `entertainment` | Film · TV & Streaming · Music · Gaming · Anime & Comics · Comedy & Theater · Celebrity |
| 11 | Media | `media` | Journalism & Press · Publishing · Social Platforms · Advertising & Marketing · Podcasts & Audio |
| 12 | Culture | `culture` | Art & Design · Books & Literature · History · Religion & Belief · Ideas & Philosophy · Language · Museums & Heritage |
| 13 | Food & Drink | `food-drink` | Restaurants · Cooking · Ingredients & Produce · Beer, Wine & Spirits · Coffee & Tea · Food Industry & Safety |
| 14 | Travel | `travel` | Air Travel · Destinations · Hotels & Lodging · Rail & Road · Visas & Border Rules · Travel Industry |
| 15 | Style | `style` | Fashion · Beauty & Skincare · Watches & Jewelry · Streetwear & Sneakers |
| 16 | Living | `living` | Home & Garden · Pets & Animals · Outdoors & Recreation · Hobbies & Making · Motoring · Photography |
| 17 | Education | `education` | Schools · Higher Education · Teaching & Curriculum · Student Life · Education Technology · Skills & Training |
| 18 | Law & Justice | `law-justice` | Courts & Rulings · Crime & Policing · Regulation & Compliance · Legal Profession · Civil Rights & Liberties |
| 19 | Society | `society` | Social Issues · Immigration · Family & Relationships · Work & Careers · Community & Nonprofits · Demographics & Population |
| 20 | Transport | `transport` | Aviation · Rail · Shipping & Logistics · Public Transit · Roads & Infrastructure |

### What limits the size of this table

It began at eleven, and the reason given at the time was that "a category nobody's topics land in costs bar space permanently". **That stopped being true three tickets later** and nobody updated the comment: since NEWS-114 the bar renders only the sections topics are actually filed under (FR-22.13), so an unused section costs nothing at all. NEWS-392 found the stale claim; NEWS-388 spent the room it was hiding.

The real budget is the **classifier's option list**. Every section and every subcategory is written into the check prompt as a choice (`categoryOptions` → `buildUserPrompt`), so the table is re-read, in tokens, on every check that still needs a classification — and a longer menu is a harder choice for a model to make well. That, not the width of the bar, is what to weigh before widening it again.

### The NEWS-97 placements, and what NEWS-388 did to them

- **Climate & Environment under Science** — *superseded*. The case for burying it was that promoting it later would be a one-line data edit; that is exactly what happened. **Environment** is a top-level section now, with Climate and Energy under it, and the Science rows are retired rather than deleted.
- **Style separate from Culture** — *still true*, mirroring the newspaper section, so Fashion is findable on its own. Home & Garden went to Living.
- **Crime & Justice under Society, not Politics** — *superseded*. The distinction it drew survives, but inside one section: **Law & Justice ▸ Crime & Policing** (incidents and policing) against **Courts & Rulings** (rulings and the judiciary). Splitting one subject across two top-level sections was the part that never quite worked.

### What NEWS-388 moved, and what that cost

Nothing was deleted (FR-22.4). Rows that changed section are retired in place, so a topic classified under the old shape still renders its old label and nothing new can land there:

| Was | Now | Retired row |
|---|---|---|
| Politics ▸ Courts & Law | Law & Justice ▸ Courts & Rulings | `politics`/`courts-law` |
| Business ▸ Real Estate | Money ▸ Housing & Property | `business`/`real-estate` |
| Science ▸ Climate & Environment | Environment ▸ Climate | `science`/`climate-environment` |
| Science ▸ Energy | Environment ▸ Energy | `science`/`energy` |
| Culture ▸ Food & Drink | the Food & Drink section | `culture`/`food-drink` |
| Culture ▸ Travel | the Travel section | `culture`/`travel` |
| Style ▸ Home & Garden | Living ▸ Home & Garden | `style`/`home-garden` |
| Society ▸ Education | the Education section | `society`/`education` |
| Society ▸ Crime & Justice | Law & Justice ▸ Crime & Policing | `society`/`crime-justice` |

Six rows were **widened in place** rather than moved — Space → Space & Astronomy, Books → Books & Literature, Religion → Religion & Belief, Ideas → Ideas & Philosophy, Beauty → Beauty & Skincare, Family → Family & Relationships. Slugs are generated from labels, so each of those would have quietly moved its slug and orphaned every topic holding the old one. They are declared with `renamed(label, slug)`, which pins the slug — which is what makes FR-22.2's promise ("renaming touches one table row and no topic") actually hold.

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

  `category`/`subcategory` are declared in `NEWS_JSON_SCHEMA` **and required** (*corrected in NEWS-272*): `additionalProperties: false` means a structured-output provider would otherwise *reject* a classification, and strict mode additionally rejects a declared property missing from `required`. Both are nullable, so a check that doesn't ask for a classification gets them back as `null` rather than absent — the prompt asks for exactly that, and the zod parse has always treated absent and null identically.

- **FR-22.9** *(Shipped, revised NEWS-111)* The sidebar shows a section label per topic, on **its own line** beneath the topic name and status, carrying the **full path** ("Technology · Consumer Tech").

  It was beside the name at first, showing only the most specific segment because that was all that fit. Both were wrong for the same reason: the label and the name competed for the same ~320px and both truncated — "Consumer Tech" became "CONSUMER …" while a long topic name lost its tail. A full line fits the longest path the built-in taxonomy can produce ("Science · Biology & Medicine Research") and gives the name back the width the badge was taking.

  The label is still bounded, but by the row rather than by a character count, so nothing in the built-in table can trip it — the cap only exists for a hand-edited taxonomy with an unreasonably long label.

  An unclassified topic gets **no label at all** rather than an "Uncategorized" badge — a badge on every unclassified row is noise, and absence already reads as "not yet".

- **FR-22.10** *(Shipped)* A horizontally scrollable filter bar sits directly under the header, above the banners and the sidebar+feed area. **All** · the sections in use · **Uncategorized**. It was originally "All · the 11 sections · Uncategorized — 13 pills, which is why the taxonomy stops at 11"; FR-22.13 replaced the fixed row with one that renders only what topics are filed under, so the bar's length now follows the user's topics rather than the taxonomy's size (NEWS-392).

  Selecting a section reveals a **second row of its subsections**, styled deliberately unlike the first: the top row is small-caps sans, the sub-row is italic serif separated by hairlines. A newspaper masthead and its subsections — which is what makes "which level am I on" legible without a label saying so. The sub-row is always in the DOM (empty when nothing is selected) rather than conditionally rendered, since it sits above the keyed topics list.

  Both rows scroll horizontally rather than wrapping: a wrapped bar changes height as you select, shifting the whole feed down.

- **FR-22.13** *(Shipped, NEWS-114)* The bar shows **only options something is filed under**. A pill for a section nobody watches is a button that can only ever produce an empty feed, and twenty of them crowd out the two or three that mean something. *Uncategorized* appears only when a topic actually lacks a section.

  This is what lets the taxonomy be broad (NEWS-388) — an unused section is never rendered, so it costs the bar nothing. Pinned by a unit test asserting the omission against the *whole* table rather than a hand-picked pair, so growing the taxonomy can never quietly grow the bar (NEWS-392).

- **FR-22.14** *(Shipped, NEWS-114)* A section offers **no subsection row at all** when fewer than two subsections are in use. A lone option is not a choice: with every Sports topic under Soccer, "All Sports" and "Soccer" select exactly the same stories.

  Read literally the request was "don't show options other than All", which would leave a single always-active "All Sports" button — a control that does nothing, which is the clutter the ticket is about. Hiding the row is the reading taken; the top row already shows which section is active. Easy to change back if the literal reading was meant.

- **FR-22.15** *(Shipped, NEWS-114)* The **currently selected** section and subsection stay visible even once nothing uses them. Deleting the last Sports topic while filtered to Sports would otherwise remove the only control showing that a filter is on — an empty feed with no visible cause and no way back to All. Once deselected, it disappears normally.

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

4. **The taxonomy goes broad** (NEWS-388, 2026-08-07). Asked for as "enough that virtually any topic one could pick would fit reasonably well", and approved as such. Eleven sections left obvious topics with nowhere sensible to sit — personal finance, a court ruling, a restaurant opening, a rail strike — and the ceiling that kept them out had already been dissolved by NEWS-114 without anyone noticing (see *What limits the size of this table*). Twenty sections, nine of them new or promoted, and nothing deleted.

## Testing

`tests/e2e/categories.spec.ts` asserts the label is not clipped by **measuring** it — `scrollWidth` against `clientWidth` for the longest path the taxonomy can produce — and that it sits below the name rather than beside it. The measurement carries a guard against its own vacuous pass: a row re-rendered by the 4 s poll can report `scrollWidth === clientWidth === 0` for an instant, and `0 <= 0 + 1` would "prove" the label fits. It did exactly that at first, passing against a deliberately re-broken layout until the non-zero-width check was added.

Visibility (FR-22.13–22.15) is decided by `visibleCategories` / `visibleSubcategories` / `hasUncategorized` in `src/categories.ts` — pure functions over the topic list, so the rules are unit-tested rather than only observed through the DOM.

`tests/e2e/categories.spec.ts` also drives the real bar: pills appearing after classification, narrowing to a section, the sub-row appearing and resetting when the section changes, the Uncategorized pill, composing with search, and the filter not surviving a reload. `tests/unit/items-query.test.ts` covers the server-side filter — both sentinels, composition with saved/search, and pagination *within* a filter.

`tests/unit/classify.test.ts` covers the classification path — when the request is made and withheld, and every way a model answer is rejected. Verified non-vacuous: removing the taxonomy validation fails exactly the four tests that assert rejection.

The mock provider classifies deterministically from the topic name: a name containing a category or subcategory **label** yields that section (so a fixture called "Soccer transfers" is Sports · Soccer and reads as its own documentation), a name containing "uncategorized" declines, and one containing "bogus" returns a slug the taxonomy doesn't have.

`tests/unit/categories.test.ts` covers the seed table's shape (the twenty sections in order, slug uniqueness at both levels, punctuation-safe slugs, at least two live subcategories per section, no section shipped retired) and label resolution (each fallback, retired-but-still-labelled, a subcategory belonging to a different category).

Three of its cases exist because of NEWS-388 specifically: every row it moved still resolves to its old label *and* is gone from `activeCategories()`; every row it widened in place still sits on its original slug (FR-22.2); and `visibleCategories` omits every unpopulated section — asserted across the whole table, because that invariant is now the only thing keeping the bar short (NEWS-392).

Two tests exist specifically to defend decisions rather than behaviour: that no `general`/`other` row is stored, and that the *Other* label is a constant rather than a table entry. Both would pass silently if someone later "fixed" FR-22.6 by adding the rows.
