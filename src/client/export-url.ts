/**
 * Building the export URL (NEWS-158, NEWS-160).
 *
 * A pure function so the scope × format × topic table is testable without a
 * browser, in the style of `dial.ts` and `topic-sort.ts`. The dialog renders
 * whatever this returns straight into an `<a href>`, so this *is* the export.
 */

export interface ExportChoice {
  scope: 'all' | 'saved' | 'topic';
  /** The topic to export, when `scope` is `topic`. Null otherwise. */
  topicId: string | null;
  format: 'md' | 'json';
}

/**
 * The URL for a choice, or **null when the choice cannot be exported**.
 *
 * Null rather than a URL that would 404 or quietly fall back to everything:
 * "one topic" with no topic picked is not a request for all of them, and the
 * dialog disables its Export control on null rather than offering a link that
 * does the wrong thing.
 */
export function exportHref(choice: ExportChoice): string | null {
  const { scope, topicId, format } = choice;
  if (scope !== 'topic') return `/api/export.${format}?scope=${scope}`;
  if (topicId === null || topicId === '') return null;
  // Encoded because a topic id reaches the query string, and while ids are
  // generated here today, nothing in the type says they always will be.
  return `/api/export.${format}?scope=topic&topic=${encodeURIComponent(topicId)}`;
}
