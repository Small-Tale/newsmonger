import type { ThreadSummary } from '../api/schemas.js';
import { dayLabelFor } from './dates.js';

/**
 * The reading rules for the "story so far" pane (NEWS-282) — how many rows to
 * show and how to date them.
 *
 * Pure and separate from `app.tsx` so the arithmetic and the wording can be
 * asserted directly. The pane's JSX is thin on purpose: everything with a rule
 * behind it lives here.
 */

/**
 * How many timeline rows an expanded card shows before "show all".
 *
 * The pane sits inside a card in a grid whose rows stretch to the tallest card
 * on the line (FR-3.37), so an uncapped timeline on a long-running subject grows
 * the whole row and pushes the rest of the feed off screen — which is the
 * opposite of what expanding one story should do to the others.
 *
 * Four is the number of rows that still reads as a list rather than as an
 * article, and it happens to cover the great majority of threads outright: a
 * subject with more than four instalments is a genuinely long-running one, and
 * that is exactly when the reader wants a deliberate "show all" rather than a
 * wall of history.
 */
export const THREAD_ROW_CAP = 4;

/**
 * The rows to draw, and how many are being held back.
 *
 * The **most recent** rows survive the cap. The pane is read beside the story
 * you clicked, so the instalments nearest it are the ones that explain it; the
 * distant origin is what "show all" is for. (Order is unchanged either way —
 * oldest first, because the point of a thread is *how we got here*.)
 */
export function visibleThreadRows<T>(rows: readonly T[], showAll: boolean): { rows: T[]; hidden: number } {
  if (showAll || rows.length <= THREAD_ROW_CAP) return { rows: [...rows], hidden: 0 };
  return { rows: rows.slice(rows.length - THREAD_ROW_CAP), hidden: rows.length - THREAD_ROW_CAP };
}

/**
 * The date on a timeline row: the same label the feed heads that day's group
 * with, so "Jun 12" in a thread and "Jun 12" in the feed mean the same day.
 */
export function threadRowDate(iso: string): string {
  return dayLabelFor(iso);
}

/** "Show all 7 stories" — the affordance's own label, so its count can be tested. */
export function showAllLabel(size: number): string {
  return `Show all ${size} stories`;
}

/**
 * Whether expanding this story should fetch a timeline at all.
 *
 * No summary on the feed page means the story's thread holds only itself, which
 * is the ordinary case (FR-29.6) — so the common expansion costs no request, and
 * the pane says so in one line instead of putting an empty heading on screen.
 * The size is re-checked rather than assumed: the server only ever sends
 * summaries for threads of two or more, and this is the one place that promise
 * is load-bearing.
 */
export function threadFetchNeeded(summary: ThreadSummary | undefined): boolean {
  return summary !== undefined && summary.size > 1;
}
