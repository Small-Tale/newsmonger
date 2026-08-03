# 14 — Feed Search

A live keyword filter over the stories already in the feed. See also [3 — UI](3-ui.md) and the sibling view filters Solo/Saved in [3 — UI](3-ui.md).

## Status: shipped

Scope for now is **filtering the collected feed** — not a live web search that fetches fresh results on demand. (That was considered and deferred; it's a bigger, quota-spending feature.)

- **FR-14.1** *(Shipped)* A search box in the header filters the feed **live as you type**. Matching is a case-insensitive substring against a story's **title, summary, or its topic's name** (`itemMatchesQuery` / `filterItemsByQuery` in `src/client/search.ts`). Source URLs are not matched.

- **FR-14.2** *(Shipped)* Search **composes** with the Solo and Saved filters — it narrows within whatever they're already showing (the pipeline is Solo → Saved → search). The query is **ephemeral** (in-memory `searchQuery`, cleared on reload), like Solo.

- **FR-14.3** *(Shipped)* The box is **compact by default and grows on focus or when it holds a query**, with an animated width transition. It's a fully-rounded pill (NEWS-69). A clear (×) button appears while it has a query and empties it. The input is *uncontrolled* (no `value` binding) so re-rendering on each keystroke can't fight the cursor; the store drives only the filter and the expand/collapse class, and the clear button resets the DOM value directly.

- **FR-14.3a** *(Shipped, NEWS-267)* **Below the 860px one-column collapse the box is icon-only**, the same 34px circle as the bookmark and settings buttons beside it, expanding on focus or a query to `min(320px, 100vw - 320px)`.

  It used to stay a fixed 110px pill under 720px, on the reasoning that search should not crowd out the action buttons. That protected the buttons and broke the field: 110px minus padding, icon and gap leaves the input **62px** — about four characters — so the placeholder rendered as "Search st" and you could not read your own query. Focused it reached 180px, which is not much better.

  Nothing caught it for the same reason nothing usually does: the field was present, focusable, correctly named and contrast-correct, so axe and every functional test passed while the control was unusable. **Size was the bug**, so `tests/e2e/layout.spec.ts` measures it — at rest, expanded, and for horizontal overflow with the field open.

  The search icon is a `<label for>`, which is what makes the collapsed circle focus the input on click: no delegate, no handler, and nothing for the kerf event rules to get wrong. The input keeps its width at `0` rather than `display: none` so Tab still reaches it, which means the keyboard opens it too.

  The threshold moved from 720px to **860px** to match the layout's own collapse (FR-3.3); the old rule left a 140px band where the sidebar had already stacked but the search was still full width.

- **FR-14.4** *(Shipped)* When a search matches nothing, the feed shows a "No stories match your search" empty state (it takes precedence over the Saved/"no stories yet" empty states).

## Testing

- **Unit** (`tests/unit/search.test.ts`): `itemMatchesQuery` (empty query matches all; title/summary/topic-name matches; non-match) and `filterItemsByQuery` (empty query passthrough, topic-name resolution, missing-topic-name fallback).
- **E2E** (`tests/e2e/app.spec.ts`): typing filters the feed to matching stories and widens the box; a no-match query shows the empty state; clearing restores the full feed and collapses the box.
