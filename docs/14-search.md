# 14 — Feed Search

A live keyword filter over the stories already in the feed. See also [3 — UI](3-ui.md) and the sibling view filters Solo/Saved in [3 — UI](3-ui.md).

## Status: shipped

Scope for now is **filtering the collected feed** — not a live web search that fetches fresh results on demand. (That was considered and deferred; it's a bigger, quota-spending feature.)

- **FR-14.1** *(Shipped)* A search box in the header filters the feed **live as you type**. Matching is a case-insensitive substring against a story's **title, summary, or its topic's name** (`itemMatchesQuery` / `filterItemsByQuery` in `src/client/search.ts`). Source URLs are not matched.

- **FR-14.2** *(Shipped)* Search **composes** with the Solo and Saved filters — it narrows within whatever they're already showing (the pipeline is Solo → Saved → search). The query is **ephemeral** (in-memory `searchQuery`, cleared on reload), like Solo.

- **FR-14.3** *(Shipped)* The box is **compact by default and grows on focus or when it holds a query**, with an animated width transition. A clear (×) button appears while it has a query and empties it. The input is *uncontrolled* (no `value` binding) so re-rendering on each keystroke can't fight the cursor; the store drives only the filter and the expand/collapse class, and the clear button resets the DOM value directly.

- **FR-14.4** *(Shipped)* When a search matches nothing, the feed shows a "No stories match your search" empty state (it takes precedence over the Saved/"no stories yet" empty states).

## Testing

- **Unit** (`tests/unit/search.test.ts`): `itemMatchesQuery` (empty query matches all; title/summary/topic-name matches; non-match) and `filterItemsByQuery` (empty query passthrough, topic-name resolution, missing-topic-name fallback).
- **E2E** (`tests/e2e/app.spec.ts`): typing filters the feed to matching stories and widens the box; a no-match query shows the empty state; clearing restores the full feed and collapses the box.
