import type { NewsItem } from '../db/schemas.js';

/**
 * Sharing a story (NEWS-43). Produces a readable block — headline, summary,
 * source link — via the OS share sheet where available, falling back to the
 * clipboard. The fallback is what makes it reliable: `navigator.share` may be
 * absent (most desktop browsers) or not work in the Tauri WKWebView, the same
 * way `window.confirm` doesn't (NEWS-39).
 */

export type ShareResult = 'shared' | 'copied' | 'dismissed' | 'failed';

/** The text a share copies: title, summary, and the first source URL. */
export function shareText(item: NewsItem): string {
  const parts = [item.title, '', item.summary];
  const url = firstSourceUrl(item);
  if (url !== undefined) parts.push('', url);
  return parts.join('\n');
}

/** The first source URL, or undefined when a story has none. */
function firstSourceUrl(item: NewsItem): string | undefined {
  const url = item.sources.length > 0 ? item.sources[0].url : '';
  return url === '' ? undefined : url;
}

interface ShareCapableNavigator {
  share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>;
  clipboard?: { writeText: (text: string) => Promise<void> };
}

/**
 * Share a story. Returns which path succeeded:
 *  - `shared`    — went through the OS share sheet
 *  - `copied`    — fell back to the clipboard
 *  - `dismissed` — the user cancelled the share sheet (do nothing)
 *  - `failed`    — no share sheet and the clipboard write failed
 */
export async function shareItem(item: NewsItem): Promise<ShareResult> {
  const nav = navigator as ShareCapableNavigator;
  const url = firstSourceUrl(item);

  if (typeof nav.share === 'function') {
    try {
      await nav.share({ title: item.title, text: item.summary, ...(url !== undefined ? { url } : {}) });
      return 'shared';
    } catch (err) {
      // A cancelled share sheet throws AbortError — respect it, don't then
      // silently copy something the user chose not to send.
      if (err instanceof Error && err.name === 'AbortError') return 'dismissed';
      // Any other failure falls through to the clipboard.
    }
  }

  if (nav.clipboard !== undefined) {
    try {
      await nav.clipboard.writeText(shareText(item));
      return 'copied';
    } catch {
      return 'failed';
    }
  }
  return 'failed';
}
