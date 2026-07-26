# 17 — Server-Side Pagination (Design)

**Status: Design only — Deferred.** Client-side pagination (a 100-item render cap + "Show more", [16 — Feed Pagination](16-pagination.md)) bounds the DOM today. This doc designs the *server* side — trimming the `/api/state` payload — which isn't yet a live problem (pre-launch, no large datasets) but will matter at thousands of stories. See NEWS-73.

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
   - **2b** *(Deferred, NEWS-76)* — the atomic flip: slim `/api/state` (drop `items`, add `flaggedByTopic`), feed from `/api/items` per view, debounced search, the `recentlyFlagged` overlay, server-provided counts, and the filter/search/flag E2E rewrite.

The search-UX decision is settled: **server-side, debounced** (confirmed when phase 2 was scheduled).
