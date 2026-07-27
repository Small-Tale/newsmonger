# 10 — New-Item Notifications

An opt-in OS notification (and dock bounce / taskbar flash) when new stories arrive while the app isn't in front of you.

See also: [3 — UI](3-ui.md), [6 — AI Providers](6-providers.md) (the attendance gate), [7 — API Keys](7-api-keys.md).

## Status: shipped; browser-verified, Tauri-native path is manual

## When it fires

- **FR-10.1** *(Shipped)* Off by default. A checkbox in the Settings dialog (`notifyOnNewItems`, persisted in the store's settings) enables it. Enabling requests notification permission on the spot — that request must ride the click, so it lives in the toggle's change handler. In the **Tauri desktop shell** the request goes through the notification plugin, whose `requestPermission()` raises the real OS dialog; in a browser it uses the web `Notification.requestPermission()` (NEWS-66).

- **FR-10.2** *(Shipped)* **Only when the app is not focused.** If the window is visible and focused when new stories land, the feed updating in front of you is enough — a notification would be noise. `focusProbe.isFocused()` (visible AND focused) gates it.

  This dovetails with the attendance gate ([6 — AI Providers](6-providers.md)): subscription providers only *check* while foregrounded, so they rarely trigger a notification — which is correct, you're already looking. The real value is for API-key providers doing background checks while you're in another app.

- **FR-10.3** *(Shipped)* **Throttled to once per five minutes.** New story ids are still recorded during the throttle, so a suppressed batch doesn't re-fire when the window reopens — only genuinely newer stories do.

- **FR-10.4** *(Shipped)* The stories already present when the app opens never notify: the seen-set is seeded silently on the first state load, and only ids appearing *after* that count as new.

## What it does

- **FR-10.5** *(Shipped)* A notification ("New story" / "N new stories"). In Tauri it's posted via the notification plugin's `sendNotification`; in a browser it's a web `Notification` whose click focuses the app window (NEWS-66). The permission-granted state for the Tauri path is cached (`tauriGranted`) — set on the toggle and re-synced on startup (`syncTauriNotificationPermission`) so a session that had notifications on keeps firing without re-toggling.
- **FR-10.6** *(Shipped)* A **dock bounce** (macOS) / **taskbar flash** (Windows/Linux) via the Tauri window's `requestUserAttention`, reached through the global Tauri API so the browser build pulls in no Tauri packages. This is separate from the notification on purpose: it still draws the eye when notifications are suppressed by Do Not Disturb, and it's the desktop-only half. A no-op in a browser.

## Structure

- Detection and firing live in `src/client/notifications.ts` (`noteState`, called from `refreshState` after every poll). `focusProbe` and `clock` are overridable so the focus and throttle branches are unit-testable without a DOM or wall-clock.
- The Tauri window helpers (`bounceDockIcon`, `focusAppWindow`) are in `src/client/tauri.ts` alongside the existing `openExternalUrl`.
- The permission-refused note lives in an always-present `#…` slot (KF-377); when the user enables the toggle but permission is refused, the box is explicitly unchecked (a false→false setting is no attribute change, so kerf's morph won't reset the live `checked` property on its own).

## Verified vs manual

- **Browser: verified.** Toggle persists across reload; permission grant/deny handled; a notification fires (captured via a stubbed `Notification`) when new items arrive while unfocused, and not while focused; throttle and first-load seeding are unit-tested (10 cases).
- **Tauri native: needs a device.** The desktop shell now routes permission + firing through the **notification plugin** (`tauri-plugin-notification`, registered in `src-tauri/src/lib.rs`, `notification:default` capability) precisely because the web Notification API's request was a silent "denied" in the WKWebView with no OS prompt (NEWS-66). The Rust side **compiles**, and both the Tauri and web client paths are **unit-tested** (13 cases, the Tauri path via a stubbed `window.__TAURI__.notification`). What can't be checked here is the actual runtime: whether `requestPermission()` raises the OS dialog and `sendNotification()` posts on a real machine — that's a manual desktop run (dovetails with NEWS-40). Dock bounce likewise needs a real desktop run. See the manual test plan.
