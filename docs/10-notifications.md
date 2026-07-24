# 10 — New-Item Notifications

An opt-in OS notification (and dock bounce / taskbar flash) when new stories arrive while the app isn't in front of you.

See also: [3 — UI](3-ui.md), [6 — AI Providers](6-providers.md) (the attendance gate), [7 — API Keys](7-api-keys.md).

## Status: shipped; browser-verified, Tauri-native path is manual

## When it fires

- **FR-10.1** *(Shipped)* Off by default. A checkbox in the Settings dialog (`notifyOnNewItems`, persisted in `data.json`) enables it. Enabling requests browser notification permission on the spot — that request must ride the click, so it lives in the toggle's change handler.

- **FR-10.2** *(Shipped)* **Only when the app is not focused.** If the window is visible and focused when new stories land, the feed updating in front of you is enough — a notification would be noise. `focusProbe.isFocused()` (visible AND focused) gates it.

  This dovetails with the attendance gate ([6 — AI Providers](6-providers.md)): subscription providers only *check* while foregrounded, so they rarely trigger a notification — which is correct, you're already looking. The real value is for API-key providers doing background checks while you're in another app.

- **FR-10.3** *(Shipped)* **Throttled to once per five minutes.** New story ids are still recorded during the throttle, so a suppressed batch doesn't re-fire when the window reopens — only genuinely newer stories do.

- **FR-10.4** *(Shipped)* The stories already present when the app opens never notify: the seen-set is seeded silently on the first state load, and only ids appearing *after* that count as new.

## What it does

- **FR-10.5** *(Shipped)* A web `Notification` ("New story" / "N new stories"), whose click focuses the app window.
- **FR-10.6** *(Shipped)* A **dock bounce** (macOS) / **taskbar flash** (Windows/Linux) via the Tauri window's `requestUserAttention`, reached through the global Tauri API so the browser build pulls in no Tauri packages. This is separate from the notification on purpose: it still draws the eye when notifications are suppressed by Do Not Disturb, and it's the desktop-only half. A no-op in a browser.

## Structure

- Detection and firing live in `src/client/notifications.ts` (`noteState`, called from `refreshState` after every poll). `focusProbe` and `clock` are overridable so the focus and throttle branches are unit-testable without a DOM or wall-clock.
- The Tauri window helpers (`bounceDockIcon`, `focusAppWindow`) are in `src/client/tauri.ts` alongside the existing `openExternalUrl`.
- The permission-refused note lives in an always-present `#…` slot (KF-377); when the user enables the toggle but permission is refused, the box is explicitly unchecked (a false→false setting is no attribute change, so kerf's morph won't reset the live `checked` property on its own).

## Verified vs manual

- **Browser: verified.** Toggle persists across reload; permission grant/deny handled; a notification fires (captured via a stubbed `Notification`) when new items arrive while unfocused, and not while focused; throttle and first-load seeding are unit-tested (10 cases).
- **Tauri native: manual.** The web `Notification` API and `requestUserAttention` could not be exercised in a live WKWebView in this environment (the window can't be scripted here). The `window.confirm` bug in NEWS-39 is a reminder that a web API can behave differently in the WKWebView, so **whether the web Notification API works there is unconfirmed** — if it doesn't, the fallback is the Tauri notification plugin (a native path, filed as a follow-up). Dock bounce likewise needs a real desktop run. See the manual test plan.
