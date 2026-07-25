# 16 — Feed Pagination

The feed renders a bounded number of stories with a "Show more" button, rather than every story at once. See also [3 — UI](3-ui.md) (feed, filters, grid).

## Status: client-side shipped; server-side deferred (NEWS-73)

### Client-side pagination (shipped)

- **FR-16.1** *(Shipped)* The feed renders at most `feedLimit` stories (a page = **100**), applied to the **final filtered + sorted list** — so it's correct for every view (Solo, Saved, Search, Review, or the default). `filteredItems.slice(0, feedLimit)` in `app.tsx`; `FEED_PAGE` / `feedLimit` in `stores.ts`.

- **FR-16.2** *(Shipped)* A **"Show N more"** button below the feed reveals the next page (`showMoreFeed` grows `feedLimit` by a page). The label shows the next page size, and the remaining total when it's more than a page ("Show 100 more (240 left)"). It lives in an always-present slot (KF-377).

- **FR-16.3** *(Shipped)* The page **resets to 100 whenever the view changes** — toggling Solo/Saved/Search/Review is a different list, shown from the top. The reset is folded into those four view-changing store actions.

- **FR-16.4** *(Evaluated, rejected)* **Virtualized scrolling** was considered and rejected: capping the render at 100 already keeps the DOM small (that's the point of the cap), and virtual lists handle our variable-height, grid-laid-out, day-grouped cards worst while fighting kerf's keyed `each()` + morph. A cap + "Show more" is simpler and sufficient.

### Server-side pagination (deferred — NEWS-73)

`/api/state` still returns *every* item on the 4 s poll; the client cap bounds the DOM but not the payload. Paginating the payload is deferred because it forces the filters server-side to stay correct, and moving **Search** server-side would regress the instant per-keystroke filter (NEWS-60) into a debounced round-trip. That's an architecture + UX decision, tracked in **NEWS-73** with the full design (endpoint shape, the recentlyFlagged overlay, per-view totals). It isn't yet a live problem: pre-launch, there are no large datasets.

## Testing

- **Unit** (`feed-pagination.test.ts`): `showMoreFeed` grows the limit a page at a time; every view-changing action resets it to one page.
- **Manual/visual**: seeding 110 items renders exactly 100 with a "Show 10 more" button (the 100+ threshold is impractical to seed in the E2E harness; the store logic and slice are unit-covered).
