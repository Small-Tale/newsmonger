# 10 — New-Item Notifications

An opt-in OS notification (and dock bounce / taskbar flash) when new stories arrive while the app isn't in front of you.

See also: [3 — UI](3-ui.md), [6 — AI Providers](6-providers.md) (the attendance gate), [7 — API Keys](7-api-keys.md).

## Status: shipped; browser-verified, Tauri-native path is manual

## When it fires

- **FR-10.1** *(Shipped; corrected in NEWS-260)* Off by default. A checkbox in the Settings dialog (`notifyOnNewItems`, persisted in the store's settings) enables it. Enabling requests notification permission on the spot — that request must ride the click, so it lives in the toggle's change handler.

  **One call for both surfaces**: `Notification.requestPermission()`. That looks like the browser API and on the desktop it is not — the plugin's `init-iife.js` *replaces* `window.Notification` in the webview with a shim that invokes the Rust side. There is no separate desktop branch, and the one that used to be here was worse than redundant: see FR-10.5.

  **It cannot raise an OS dialog on macOS**, which this doc previously claimed it did. The plugin's desktop implementation hardcodes `Ok(PermissionState::Granted)` for both `request_permission` and `permission_state` — macOS is never asked. Delivery uses the legacy `NSUserNotificationCenter`, which has no authorization concept, unlike the `UNUserNotificationCenter` that apps which do prompt use. A consequence worth knowing because it looks exactly like a fault: **a macOS app appears in System Settings → Notifications only once it has successfully delivered a notification**, so there is nothing to allow there until then (hence FR-10.7).

- **FR-10.2** *(Shipped)* **Only when the app is not focused.** If the window is visible and focused when new stories land, the feed updating in front of you is enough — a notification would be noise. `focusProbe.isFocused()` (visible AND focused) gates it.

  This dovetails with the attendance gate ([6 — AI Providers](6-providers.md)): subscription providers only *check* while foregrounded, so they rarely trigger a notification — which is correct, you're already looking. The real value is for API-key providers doing background checks while you're in another app.

- **FR-10.3** *(Shipped)* **Throttled to once per five minutes.** New story ids are still recorded during the throttle, so a suppressed batch doesn't re-fire when the window reopens — only genuinely newer stories do.

- **FR-10.4** *(Shipped)* The stories already present when the app opens never notify: the seen-set is seeded silently on the first state load, and only ids appearing *after* that count as new.

## What it does

- **FR-10.5** *(Shipped; the desktop half was broken until NEWS-260)* A notification ("New story" / "N new stories"), delivered by constructing a `Notification` — the plugin on the desktop, the browser API in a browser (FR-10.1). Its click focuses the app window **in a browser**. On the desktop the handler cannot run at all: the shim's constructor delivers and returns a bare object, so nothing ever reads `onclick`, and the dock bounce (FR-10.6) is the attention-getter.

  Clicking it **does** bring the window forward on macOS, and **not because of anything we do** (*confirmed on v0.2.0-beta.14, NEWS-261*). `NSUserNotificationCenter` activates the application that posted a notification when its contents are clicked, and mac-notification-sys fakes the posting bundle id to ours, so the OS does for free what our handler cannot. Nothing in our stack participates: the delegate in `mac-notification-sys` only reports the activation type back to Rust, and `tauri-plugin-notification` discards it.

  Worth keeping the distinction, because it decides what a future change may safely break: **the behaviour is the OS's, not ours.** If a later Tauri or macOS release stops activating the posting app, no test here will notice — there is nothing of ours to test. Windows and Linux are unverified, and their notification stacks make their own choice.

  **What was wrong.** There were two branches, and the desktop one preferred `window.__TAURI__.notification`, caching its answer in `tauriGranted` because the arm check is synchronous. **That global does not exist in any build of this app** — the crate injects `init-iife.js`, which replaces `window.Notification` and defines no global; the `api-iife.js` that would define one ships inside the crate but is never injected, and the npm package is not a dependency. So `tauriGranted` stayed `null`, the arm check returned false forever, and **the packaged desktop app never delivered a single notification**, while the setting read "on" — the precise failure the toggle's own comment says it exists to prevent. It also explains the macOS symptom completely: with nothing ever delivered, macOS had no reason to list the app.

  Two things kept it hidden, both worth naming. A hand-written interface for a global nobody defines type-checks perfectly and is `undefined` only at runtime; and the unit tests **manufactured that global** and asserted against it, so they passed in a world we do not ship.
- **FR-10.7** *(Removed, NEWS-329)* There was a **Send a test notification** button in Settings → App (NEWS-260), delivering one immediately past the focus gate and the throttle, without consuming the throttle window.

  Removed on request. **It had a real second job, and losing it is a genuine cost worth recording**: on macOS an app appears in *System Settings → Notifications* only once it has delivered one, so the button was the only way to make Newsmonger's entry exist without waiting for a check to find a story while the window was in the background. The permission-blocked note used to send people to it; it now says the entry should appear after the first real notification instead, which is true but slower.

  The feature is otherwise unobservable on demand, so nothing replaced it.

  It exists because the feature is otherwise **unobservable**: a real notification requires a check to find new stories while the window is unfocused, which a user cannot arrange on purpose. On macOS it does double duty as the only way to get the app listed in System Settings → Notifications (FR-10.1). The result line claims only that one was *handed over* — the OS may still suppress it for Do Not Disturb or a per-app setting, and saying "sent" about something invisible would be the same class of lie this ticket fixed.

- **FR-10.6** *(Shipped)* A **dock bounce** (macOS) / **taskbar flash** (Windows/Linux) via the Tauri window's `requestUserAttention`, reached through the global Tauri API so the browser build pulls in no Tauri packages. This is separate from the notification on purpose: it still draws the eye when notifications are suppressed by Do Not Disturb, and it's the desktop-only half. A no-op in a browser.

## Structure

- Detection and firing live in `src/client/notifications.ts` (`noteState`, called from `refreshState` after every poll). `focusProbe` and `clock` are overridable so the focus and throttle branches are unit-testable without a DOM or wall-clock.
- The Tauri window helpers (`bounceDockIcon`, `focusAppWindow`) are in `src/client/tauri.ts` alongside the existing `openExternalUrl`.
- The permission-refused note lives in an always-present `#…` slot (KF-377); when the user enables the toggle but permission is refused, the box is explicitly unchecked (a false→false setting is no attribute change, so kerf's morph won't reset the live `checked` property on its own).

## Verified vs manual

- **Browser: verified.** Toggle persists across reload; permission grant/deny handled; a notification fires (captured via a stubbed `Notification`) when new items arrive while unfocused, and not while focused; throttle and first-load seeding are unit-tested (10 cases).
- **Tauri native: needs a device.** The desktop shell now routes permission + firing through the **notification plugin** (`tauri-plugin-notification`, registered in `src-tauri/src/lib.rs`, `notification:default` capability) precisely because the web Notification API's request was a silent "denied" in the WKWebView with no OS prompt (NEWS-66). The Rust side **compiles**, and both the Tauri and web client paths are **unit-tested** (13 cases, the Tauri path via a stubbed `window.__TAURI__.notification`). What can't be checked here is the actual runtime: whether `requestPermission()` raises the OS dialog and `sendNotification()` posts on a real machine — that's a manual desktop run (dovetails with NEWS-40). Dock bounce likewise needs a real desktop run. See the manual test plan.
