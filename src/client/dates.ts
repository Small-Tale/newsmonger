/**
 * Calendar-day labelling, shared by everything in the app that dates a story.
 *
 * Lifted out of `app.tsx` when the thread timeline needed the same labels
 * (NEWS-282). The rule this file exists to enforce is that there is exactly
 * **one** absolute date format in the UI: a story dated "Jun 12" in a thread row
 * has to read the same as the feed heading it sits under, and a second
 * implementation is how those two drift apart.
 */

/** A date's local calendar day as `YYYY-MM-DD` — the key the feed groups on. */
export function dayKeyOf(date: Date): string {
  return date.toLocaleDateString('en-CA');
}

/** Label for a calendar day: Today, Yesterday, or "Jul 20". */
export function dayLabel(dateKey: string): string {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  if (dateKey === dayKeyOf(today)) return 'Today';
  if (dateKey === dayKeyOf(yesterday)) return 'Yesterday';
  // Noon, not midnight: parsing `YYYY-MM-DD` alone is UTC, which lands on the
  // previous day for anyone west of Greenwich.
  const d = new Date(`${dateKey}T12:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The day label for an instant, as the feed would head the group it falls in. */
export function dayLabelFor(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : dayLabel(dayKeyOf(at));
}
