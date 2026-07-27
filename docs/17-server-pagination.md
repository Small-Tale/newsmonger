# 17 — Server-Side Pagination

**Status: Shipped.** The feed is filtered, sorted, and paginated server-side; `/api/state` no longer carries the item list. Built in three parts: phase 1 the endpoint (NEWS-74), phase 2a the notification decoupling (NEWS-75), phase 2b the client flip (NEWS-76).

## The core tension

`/api/state` returns **every** item on the 4-second poll. The obvious fix — return a page — breaks the client, because **every feed filter runs client-side today** (Solo, Saved, Search, off-topic hide, Review — see `app.tsx`). A client that only holds one page can only filter that page, so it misses matches deeper in history.

So server pagination **forces the filters server-side too**. And that collides with **instant search** (NEWS-60): moving Search to the server turns a per-keystroke client filter into a debounced network round-trip.

You cannot have all three of: bounded payload, complete filtering over full history, and instant client-side search. Pick the two that matter at scale.

## Recommendation: full server-side filtering, debounced search

At real scale, **completeness beats instant-feel**: a search that silently misses old stories is a worse bug than a search that lags ~250 ms. So when this is built, move **all** filters server-side and accept a **debounced** search. (The alternative — a "hybrid" that keeps search client-side over only the loaded window — is *simpler* but ships a subtly-broken search, which is the wrong trade at the scale that motivates this work.)

Until the dataset is actually large, do nothing more: the client cap already keeps the UI fast.

## Proposed shape

- **Slim `/api/state`** to the small, always-full parts: `topics`, `settings`, `runs`, `checking`. Drop `items` (or keep only a count).
- **New `GET /api/items`** returns a filtered, sorted (newest-first), paginated page:
  `?limit=100&before=<cursor>&topics=a,b&saved=1&q=foo&mode=normal|review` → `{ items, nextCursor, total }`.
  Filtering + sort + slice live in the `Store` (the predicates already exist client-side — port them). `total` drives the per-view "Show more" count.
- **Cursor**, not offset: the feed is newest-first by `foundAt`; the cursor is the last shown item's `(foundAt, id)`, and the page is items *before* it. Offsets drift as new items arrive.
- **Client rewire**: the feed derives from fetched pages, not `s.items`. View state → query params; a view change refetches page 1; "Show more" fetches the next page; the 4 s poll refetches page 1 of the current view and reconciles (new items prepend). Search input is debounced.

## Sharp edges to handle

- **The `recentlyFlagged` overlay (NEWS-61).** A story flagged *this session* stays visible-but-collapsed until reload, but the server's normal view excludes off-topic items. The client must hold the flagged items it already has and **merge** them (collapsed) into the server's page. On reload they're gone (server excludes; session set empty) — which is the existing behaviour.
- **Live updates while paginated.** New stories arriving during a poll must prepend to page 1 without disturbing already-loaded lower pages or the scroll position.
- **Empty-state and "Show more" counts** become server-provided (`total`) per filtered view.

## Phased implementation (status)

1. **Server item query + `/api/items`** — *(Shipped, NEWS-74)* `Store.queryItems` (filter/sort/cursor-paginate + total) + the endpoint. Additive; `/api/state` untouched.
2. **Client rewire** — split for safety:
   - **2a** *(Shipped, NEWS-75)* — `latestItemIds` on `/api/state` and notifications moved onto it (`noteState` no longer reads the full item list), so a later feed-slim can't break notifications. Non-breaking.
   - **2b** *(Shipped, NEWS-76)* — the atomic flip: `/api/state` slimmed (dropped `items`, added `flaggedByTopic`); the feed fetches `/api/items` per view (`refreshFeed`); **search is debounced** (~250 ms, `SEARCH_DEBOUNCE_MS`); the `recentlyFlagged` overlay holds just-flagged items client-side and merges them collapsed into the normal page; counts come from the server's per-view `total` and `flaggedByTopic`.

The search-UX decision is settled: **server-side, debounced** — the instant per-keystroke filter (NEWS-60) is now a debounced refetch, the accepted regression.

## What each part touches (as built)

- `Store.queryItems` / `latestItemIds` / `flaggedCountsByTopic` (`src/db/store.ts`); `GET /api/items` + slimmed `/api/state` (`src/routes/api.ts`); `ItemsResp` + slimmed `StateResp` (`src/api/schemas.ts`).
- Client: `refreshFeed` (`src/client/api.ts`); `feedItems`/`feedTotal`/`flaggedByTopic`/`recentlyFlaggedItems` state + `setFeed`/`addRecentlyFlagged`/`removeRecentlyFlagged` (`src/client/stores.ts`); the feed pipeline, overlay merge, and view-change refetch wiring (`src/client/app.tsx`). `itemMatchesQuery` stays for the client-side overlay match.

## Out-of-order refresh responses (NEWS-104)

Refreshes run concurrently by design: the 4-second poll, plus one after every mutation (`withRefresh` PATCHes, then refreshes). The store applied whichever response **resolved** last, which is not the one **issued** last.

- **FR-17.9** *(Shipped, NEWS-104)* `refreshState` and `refreshFeed` each carry a monotonic sequence number and **drop a response older than the newest already applied** — success and failure alike, so a stale error can't raise a banner over state a newer response already wrote.

  The visible symptom was a setting appearing to revert: change an interval while a poll is already in flight, and the poll answers with the pre-PATCH value and rewrites the `<select>` until the next tick, up to 4 seconds later. It surfaced first as an E2E flake in the NEWS-56 clamp test, which is a symptom of the client bug rather than a test artifact — worth stating, because "fix the test" was the obvious and wrong response.

  It matters more for the feed than for settings: `refreshFeed`'s query is built from the *live* view, so a response for the previous search term or Solo set landing late would repopulate rows the current filters exclude.

  A sequence number rather than an `AbortController`: the older request's *answer* is what's unwanted, not the request itself, and aborting a poll that a mutation happened to overlap would throw away a legitimate refresh. `refreshFeed` keeps its own counter — the endpoints are independent, and a shared one would let a feed response suppress a state one.

  **Pinned at the unit level, deliberately.** E2E can't schedule the interleaving — 288 `--repeat-each` executions of the spec that flaked never reproduced it. `tests/unit/refresh-ordering.test.ts` chooses the arrival order, so it fails deterministically without the guard; verified by removing the guard and watching 4 of its 5 tests fail. The fifth asserts in-order responses still apply, which is the failure mode of an over-eager guard.
