import type { StateResp } from '../api/schemas.js';
import { appStore } from './stores.js';
import { bounceDockIcon, focusAppWindow } from './tauri.js';

/**
 * OS notifications when new stories arrive while the app isn't in front of you.
 *
 * "Not in front of you" is the whole point (NEWS-38): if the window is focused,
 * the feed updating is enough and a notification would be noise. So this only
 * fires while the app is backgrounded or unfocused — which also means
 * subscription providers (checks gated to the foreground, see attendance.ts)
 * rarely trigger it, and API-key providers doing background checks get the real
 * value. Throttled to once per 5 minutes.
 */

const THROTTLE_MS = 5 * 60 * 1000;

/**
 * Item ids already seen. `null` until the first state load, so the stories
 * already present when the app opens don't all fire a notification.
 */
let seenIds: Set<string> | null = null;
let lastNotifiedAt = 0;

/** Overridable so tests can drive the focus branch deterministically. */
export const focusProbe = {
  isFocused(): boolean {
    return document.visibilityState === 'visible' && document.hasFocus();
  },
};

/** Now, overridable in tests (Date.now isn't otherwise injectable here). */
export const clock = { now: (): number => Date.now() };

/**
 * Ask for notification permission, returning whether it's granted.
 *
 * Must be called from a user gesture (the settings toggle) — browsers reject a
 * permission request that isn't. Already-granted or already-denied short-circuit
 * without a prompt.
 *
 * ### One path, and on desktop it is not the browser API (NEWS-260)
 *
 * `window.Notification` looks like a browser fallback here and is not: in the
 * desktop shell the plugin's `init-iife.js` **replaces `window.Notification`**
 * with a shim whose `requestPermission` invokes `plugin:notification|…` on the
 * Rust side, and whose constructor delivers through the OS. So this one call is
 * the browser API in a browser and the plugin on the desktop.
 *
 * There used to be a second branch that preferred `window.__TAURI__.notification`
 * and cached its answer. **That global does not exist in any build of this app**
 * — the crate injects `init-iife.js`, which only replaces `window.Notification`;
 * the `api-iife.js` that would define the global ships inside the crate but is
 * never injected, and the npm package is not a dependency. The branch never ran,
 * and because the sync arm check waited on its cached answer, desktop
 * notifications could never fire at all. The unit tests missed it by
 * manufacturing the global they were testing against.
 *
 * ### What this cannot do on macOS
 *
 * **It cannot produce an OS permission prompt.** The plugin's desktop
 * implementation hardcodes `Ok(PermissionState::Granted)` for both
 * `request_permission` and `permission_state`; macOS is never asked. Delivery
 * goes through the legacy `NSUserNotificationCenter`, which has no authorization
 * concept — unlike `UNUserNotificationCenter`, which is what apps that do prompt
 * use. A macOS app therefore appears in System Settings → Notifications only
 * once it has **successfully delivered** one, which is most of why
 * `sendTestNotification` below exists.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/**
 * Whether notifications can fire right now (enabled + permitted).
 *
 * One rule for both surfaces. It used to branch on `isTauri()` and require a
 * cached plugin answer that nothing ever set, which is how the desktop build
 * ended up unable to fire at all while the setting read "on" (NEWS-260).
 */
function notificationsArmed(): boolean {
  if (!appStore.state.value.settings.notifyOnNewItems) return false;
  return notificationsPermitted();
}

/** Whether the OS will accept one. On desktop the shim reports `granted`. */
function notificationsPermitted(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

/**
 * Hand one to the OS.
 *
 * `new Notification(...)` is the plugin on the desktop and the browser API in a
 * browser — see `ensureNotificationPermission`. **The click handler only works
 * in the browser**: the desktop shim's constructor delivers and returns a bare
 * object, so nothing reads `onclick` there. It is still set rather than branched
 * on, because it costs nothing and the alternative is two paths where one will
 * do. The dock bounce is what draws the eye on the desktop.
 */
function deliver(title: string, body: string): void {
  try {
    const n = new Notification(title, { body, tag: 'newsmonger-new-items' });
    n.onclick = (): void => {
      focusAppWindow();
      n.close();
    };
  } catch {
    /* construction can throw if permission was revoked mid-session */
  }
}

function fire(count: number): void {
  lastNotifiedAt = clock.now();
  const title = count === 1 ? 'New story' : `${String(count)} new stories`;
  deliver(title, 'Newsmonger found something new for you.');
  // The dock bounce is separate: it draws the eye even when notifications are
  // suppressed by Do Not Disturb, and is the desktop-only half of the feature.
  bounceDockIcon();
}


/**
 * Fold a fresh state snapshot into the notifier. Call after every state update.
 *
 * The first call seeds the seen-set silently. Later calls notify when new ids
 * appear, the app is unfocused, notifications are armed, and the throttle has
 * elapsed. New ids are always recorded, so a throttled notification doesn't
 * re-fire for the same stories once the window passes.
 */
export function noteState(state: StateResp): void {
  // The newest ids across all topics (NEWS-75), not the current feed page — so a
  // new story notifies even in a topic the feed isn't currently showing.
  const ids = state.latestItemIds;
  if (seenIds === null) {
    seenIds = new Set(ids);
    return;
  }
  const fresh = ids.filter((id) => !(seenIds as Set<string>).has(id));
  for (const id of fresh) seenIds.add(id);
  if (fresh.length === 0) return;
  if (focusProbe.isFocused()) return; // you're looking; the feed already updated
  if (!notificationsArmed()) return;
  if (clock.now() - lastNotifiedAt < THROTTLE_MS) return;
  fire(fresh.length);
}

/** Tests only: forget seen ids and throttle so each case starts clean. */
export function __resetNotificationsForTests(): void {
  seenIds = null;
  lastNotifiedAt = 0;
}
