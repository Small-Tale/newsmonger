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

/** Whether notifications can fire right now (enabled + permitted). */
function notificationsArmed(): boolean {
  return (
    appStore.state.value.settings.notifyOnNewItems &&
    typeof Notification !== 'undefined' &&
    Notification.permission === 'granted'
  );
}

function fire(count: number): void {
  lastNotifiedAt = clock.now();
  const title = count === 1 ? 'New story' : `${String(count)} new stories`;
  try {
    const n = new Notification(title, { body: 'News found something new for you.', tag: 'news-new-items' });
    n.onclick = (): void => {
      focusAppWindow();
      n.close();
    };
  } catch {
    /* construction can throw if permission was revoked mid-session */
  }
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
  const ids = state.items.map((i) => i.id);
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
