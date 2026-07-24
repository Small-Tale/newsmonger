/**
 * Strip markup out of model-authored prose.
 *
 * Web-searching models wrap cited sentences in their own citation markup —
 * Claude's `web_search` tool emits `<cite index="11-2,11-3">…</cite>` — and
 * that markup lands inside the JSON string fields we asked for. The UI escapes
 * everything it renders (as it should), so the tags surface as literal text in
 * the middle of a summary.
 *
 * Asking the model not to do it isn't sufficient: this is emitted by the tool
 * layer, and prompt instructions don't reliably suppress it. So it's cleaned at
 * the boundary instead, where it can't depend on the model cooperating.
 *
 * Tags are removed but their contents kept — the text inside a `<cite>` is the
 * actual sentence, not decoration.
 */

/** Matches an HTML-ish tag: `<`/`</` followed by a letter, through the next `>`. */
const TAG = /<\/?[a-zA-Z][^>]*>/g;

/** The entities a model is realistically going to emit in prose. */
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/**
 * Remove markup and decode entities from a model-authored string.
 *
 * Deliberately conservative about what counts as a tag: the pattern requires a
 * letter straight after `<`, so an ordinary prose comparison such as
 * `a < b > c` survives untouched. Idempotent, so it's safe to apply on both write and read.
 */
export function stripMarkup(text: string): string {
  const withoutTags = text.replace(TAG, '');
  const decoded = withoutTags.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m);
  // Removing a tag can leave a doubled space or a space before punctuation.
  return decoded.replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
}
