import type { ThreadSummary } from '../api/schemas.js';
import { dayLabelFor } from './dates.js';

/**
 * The reading rules for the "story so far": how many rows the pane shows and how
 * they are dated (NEWS-282), and what the collapsed card's badge says (NEWS-283).
 *
 * Pure and separate from `app.tsx` so the arithmetic *and the wording* can be
 * asserted directly — the badge's sentence is the whole of its feature, and a
 * sentence tested through the DOM is a sentence nobody reviews. The JSX in
 * `itemJsx` is thin on purpose: everything with a rule behind it lives here.
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

/** "1st", "2nd", "3rd", "4th"… — including the 11th/12th/13th exceptions. */
function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/** The two halves of a thread badge: what this story is, and since when. */
export interface ThreadBadge {
  /** "4th update", or "3 follow-ups" for the story that started the thread. */
  count: string;
  /** The day the subject first appeared, or `''` when there is nothing to say. */
  since: string;
}

/**
 * The collapsed card's thread badge (NEWS-283), or null for a thread of one.
 *
 * Without this the timeline is invisible: nothing on a collapsed card says a
 * click reveals anything, so the feature would ship and nobody would find it.
 *
 * **Two phrasings, because there are two honest facts.** A story that *followed*
 * others is "the 4th update", and the useful second half is when the subject
 * started — "since Jun 12" — which is the one thing the card cannot already
 * show. The **first** story of a thread is not an update of anything, and its
 * own date is already in the header, so it says how many followed it instead:
 * "3 follow-ups". Squeezing both into one template would have meant calling the
 * opening story "1st update", which is wrong in the specific way a badge cannot
 * afford — it is the sentence that has to make someone click.
 *
 * Returned in halves because they are shown in different places: only `count`
 * fits on the card (a feed column is ~430px in the two-column layout, and the
 * date clause pushed the topic pill onto three lines — the NEWS-71 crowding,
 * measured rather than guessed), while `since` rides the button's tooltip and
 * accessible name and every row of the pane it opens. The date is `dayLabel`'s,
 * lowercased for mid-sentence use, so "since Jun 12" here and "Jun 12" as a feed
 * heading are the same day in the same words — there is no third date format.
 */
export function threadBadge(summary: ThreadSummary | undefined): ThreadBadge | null {
  if (summary === undefined || !threadFetchNeeded(summary)) return null;
  if (summary.position === 1) {
    const followers = summary.size - 1;
    // No date: a thread's first story *is* the start, and its own timestamp is
    // already in the header beside it.
    return { count: followers === 1 ? '1 follow-up' : `${followers} follow-ups`, since: '' };
  }
  // An unparseable start date drops the clause rather than printing "since ".
  return { count: `${ordinal(summary.position)} update`, since: dayLabelFor(summary.startedAt).toLowerCase() };
}

/** The badge as one line — what a screen reader and a tooltip get. */
export function threadBadgeLabel(summary: ThreadSummary | undefined): string {
  const badge = threadBadge(summary);
  if (badge === null) return '';
  return badge.since === '' ? badge.count : `${badge.count} · since ${badge.since}`;
}

/**
 * What the expander announces once it carries a badge (NEWS-283).
 *
 * The badge **is** the expander's label rather than a decoration beside it, so
 * the accessible name says what pressing it does *and* what it would reveal —
 * "Show the story so far — 4th update · since Jun 12" — instead of a bare count
 * that a screen reader would read as a riddle. It carries the date the card
 * itself has no room for. A card with no thread keeps the plain NEWS-281 wording.
 */
export function threadExpanderLabel(summary: ThreadSummary | undefined, expanded: boolean): string {
  const verb = expanded ? 'Hide' : 'Show';
  const badge = threadBadgeLabel(summary);
  if (badge === '') return expanded ? 'Hide story detail' : 'Show story detail';
  // The badge text is carried verbatim, not paraphrased: WCAG 2.5.3 asks that a
  // control's visible label be contained in its accessible name, so "someone who
  // says what they see" and "someone who hears the name" are naming one control.
  return `${verb} the story so far — ${badge}`;
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
