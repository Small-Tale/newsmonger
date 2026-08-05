# 11 — Story Actions (Save & Share)

Per-story actions that live in each feed card's header: a **bookmark** to save a story and a **share** to send it elsewhere. Both are small buttons next to the timestamp; neither affects what the checker finds — they act on stories already in the feed. See [3 — UI](3-ui.md) for how the feed and its filters are built.

## Status: both shipped

### Save / bookmark (NEWS-42)

- **FR-11.1** *(Shipped)* Every story card has a bookmark button. Clicking it toggles `item.saved`, persisted in the store via `PATCH /api/items/:id { saved }` (`setItemSaved` in the store). Saved is a **property of the story**, so a bookmark survives a restart — but it goes with the story if the topic is deleted (the flag lives on the item, not on a separate list). The button fills solid green when saved.

- **FR-11.2** *(Shipped)* A **Saved filter** — a bookmark toggle in the header, beside the settings gear — narrows the feed to saved stories only, with a "Showing N saved" banner and a Show-all button, mirroring the existing Solo filter. The two **compose**: Saved filters within the current Solo set. The filter is a **view state and ephemeral** — a reload clears the filter but not the saved flags — for the same reason Solo is ephemeral (a stale hide-everything filter surviving a restart is a worse failure than re-applying one). Empty state when nothing is saved: a prompt to use the bookmark button.

### Share (NEWS-43)

- **FR-11.3** *(Shipped)* Every story card has a share button. It shares a formatted block — **title, summary, and the first source link** (`shareText` in `src/client/share.ts`). It tries the OS share sheet first (`navigator.share`); where that is absent — most desktop browsers — it falls back to copying the block to the clipboard and shows a transient toast to confirm. A share sheet the user *cancels* (AbortError) does nothing and shows no toast; the OS sheet is its own feedback, so the toast is reserved for the clipboard fallback and outright failures.

  **The Tauri WKWebView does support `navigator.share`** (NEWS-45): the owner ran `tauri:dev` on macOS and the real OS share sheet opened, so the sheet path — not the clipboard fallback — is what the desktop app takes. This was an open question worth answering rather than assuming, because the WKWebView *does* silently no-op `window.confirm` and `window.alert` (see [3 — UI](3-ui.md)), and the reasonable prior was that `navigator.share` behaved the same way. It does not. The fallback stays: it is what every desktop browser uses, and Windows and Linux are unverified (FR-5.3, NEWS-20).

  The **toast** (`#toast-slot`, `.toast`) is an in-app bottom-of-screen notice with a self-clearing timer (`showToast` in `app.tsx`), used because `window.alert` is a WKWebView no-op. It lives in an always-present slot (kerf KF-377, see [3 — UI](3-ui.md)).

### The card's own click is now claimed (NEWS-281)

Bookmark, share and flag are the actions *on* a story. As of NEWS-281 the card **body** has an action too: a left-click anywhere that isn't one of those controls or a source link **expands the card into a detail pane**. It is documented with the rest of the feed's interaction rules in [3 — UI](3-ui.md) (FR-3.63–3.66), not here, because what the pane holds is a feed concern rather than a per-story action — but it matters to this document for one reason: **every control on this page shares its click with that handler.**

`delegate()` matches by walking up from the event target, so a press on the bookmark button also matches the card. The expand handler bails inside `.item-actions`, `ul.sources` and `.item-pane`; a new per-story control added outside those three wrappers will toggle the card as well as doing its own job. Put it in `.item-actions`.

**The cluster is also out of room** (NEWS-283). The thread badge — "4th update", the only thing on a collapsed card that advertises the story-so-far pane — was added *inside the expander button as its label* rather than as a fourth control beside bookmark and share, because the header's fifth element reflowed the topic pill onto three lines. See [3 — UI](3-ui.md) FR-3.67. Anything else that wants a place here should expect to justify it the same way.

Right-click is unchanged: the story context menu (bookmark / share / flag) still opens exactly as before, since a right-click produces no `click` event.

## Testing

- **Unit**: `Store.setItemSaved` and `PATCH /api/items/:id` (`tests/unit/saved-items.test.ts`); `shareText` formatting incl. the no-source case (`tests/unit/share.test.ts`).
- **E2E** (`tests/e2e/stories.spec.ts`): bookmark a story → filter to saved → unbookmark while filtered → reload clears the filter but not the flags (NEWS-42); share via a stubbed OS sheet (no toast) then via the clipboard fallback (toast + clipboard content), and the toast self-clears (NEWS-43). Both actions are also asserted **not** to expand the card (NEWS-281) — that they still fire is only half the property.
