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

## Testing

- **Unit**: `Store.setItemSaved` and `PATCH /api/items/:id` (`tests/unit/saved-items.test.ts`); `shareText` formatting incl. the no-source case (`tests/unit/share.test.ts`).
- **E2E** (`tests/e2e/app.spec.ts`): bookmark a story → filter to saved → unbookmark while filtered → reload clears the filter but not the flags (NEWS-42); share via a stubbed OS sheet (no toast) then via the clipboard fallback (toast + clipboard content), and the toast self-clears (NEWS-43).
