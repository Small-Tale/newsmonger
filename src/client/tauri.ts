import { openExternal } from './api.js';

interface TauriGlobal {
  core?: { invoke?: (cmd: string) => Promise<unknown> };
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
