/**
 * Source attribution for a story (NEWS-82).
 *
 * Its own module rather than living in `app.tsx`: these are pure functions and
 * `app.tsx` touches `document` at import time, so putting them there would make
 * them untestable outside a browser — the same reason `search.ts`, `share.ts`
 * and `schedule.ts` are separate.
 */

/**
 * Who published it (NEWS-82).
 *
 * The model's own answer when it gave one, otherwise the URL's registrable
 * domain minus `www.` — usually close enough to be useful and never wrong in a
 * misleading way, which a guess would be.
 */
export function outletFor(source: { outlet: string | null; url: string }): string {
  if (source.outlet !== null && source.outlet.trim() !== '') return source.outlet;
  try {
    return new URL(source.url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * How to label a publication date (NEWS-82).
 *
 * Says nothing when the article was published the same day it was found — that
 * is the normal case and the feed's own day heading already says it. It speaks
 * up only when the two differ, which is exactly when the heading is misleading:
 * a catch-up check after a week's downtime files week-old articles under today.
 */
export function publishedLabel(publishedAt: string, foundAt: string): string {
  const found = foundAt.slice(0, 10);
  if (publishedAt >= found) return '';
  const days = Math.round((Date.parse(`${found}T00:00:00Z`) - Date.parse(`${publishedAt}T00:00:00Z`)) / 86_400_000);
  if (days <= 0) return '';
  if (days === 1) return 'published a day earlier';
  if (days < 7) return `published ${String(days)} days earlier`;
  return `published ${publishedAt}`;
}
