import { openExternal } from './api.js';

interface TauriWindow {
  requestUserAttention?: (type: number | null) => Promise<unknown>;
  setFocus?: () => Promise<unknown>;
}

/** The notification plugin's guest API, exposed on the global by `withGlobalTauri`. */
interface TauriNotification {
  isPermissionGranted?: () => Promise<boolean>;
  requestPermission?: () => Promise<string>;
  sendNotification?: (options: { title: string; body?: string }) => void;
}

interface TauriGlobal {
  core?: { invoke?: (cmd: string) => Promise<unknown> };
  window?: { getCurrentWindow?: () => TauriWindow };
  notification?: TauriNotification;
}

/** The Tauri notification plugin API, or undefined outside the desktop shell. */
export function tauriNotification(): TauriNotification | undefined {
  return getTauriGlobal()?.notification;
}

/** The Tauri global injected into the webview when running as a desktop app. */
export function getTauriGlobal(): TauriGlobal | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as Record<string, unknown>)['__TAURI__'] as TauriGlobal | undefined;
}

export function isTauri(): boolean {
  return getTauriGlobal() !== undefined;
}

/**
 * Inside the Tauri webview, `target="_blank"` links have no tab to open into —
 * route them through the server, which opens the system browser. In a normal
 * browser this returns false and the default link behavior applies.
 */
export function openExternalUrl(url: string): boolean {
  if (!isTauri()) return false;
  void openExternal(url).catch(() => {
    /* nothing sensible to do in the webview */
  });
  return true;
}

/** UserAttentionType.Critical — the continuous dock bounce / taskbar flash. */
const ATTENTION_CRITICAL = 1;

/**
 * Bounce the dock icon (macOS) or flash the taskbar (Windows/Linux).
 *
 * Best-effort and desktop-only: in a browser there is no icon to bounce, so
 * this is a no-op. Reached through the global Tauri API (`withGlobalTauri` in
 * tauri.conf.json) rather than an import, so the browser build pulls in no
 * Tauri packages. **Unverified in a live Tauri window in this environment** —
 * see docs/10-notifications.md.
 */
export function bounceDockIcon(): void {
  const win = getTauriGlobal()?.window?.getCurrentWindow?.();
  if (win?.requestUserAttention === undefined) return;
  // Promise.resolve guards against a non-promise runtime return; attention is a
  // nicety, so a rejection is swallowed.
  void Promise.resolve(win.requestUserAttention(ATTENTION_CRITICAL)).catch(() => {
    /* never surface a failure */
  });
}

/** Bring the desktop window to the front (best-effort, desktop-only). */
export function focusAppWindow(): void {
  const win = getTauriGlobal()?.window?.getCurrentWindow?.();
  if (win?.setFocus !== undefined) {
    void Promise.resolve(win.setFocus()).catch(() => {});
    return;
  }
  if (typeof window !== 'undefined') window.focus();
}
