/**
 * Turn a failed CLI's stderr into a sentence worth showing (NEWS-274).
 *
 * Both CLI providers used to do this:
 *
 * ```ts
 * stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300)
 * ```
 *
 * The last three lines of a **pretty-printed JSON error** are its closing
 * braces. So a 400 whose payload said
 *
 *   "message": "Invalid schema for response_format 'codex_output_schema': …
 *   'required' is required to be supplied and to be an array including every key
 *   in properties. Missing 'outlet'."
 *
 * reached the user as `Codex CLI exited with code 1: }, "status": 400 }` — the
 * one part of the response carrying no information, with the real message four
 * lines above the window. Diagnosing it meant re-running the CLI by hand and
 * reading the whole stream, which is not something a user can do.
 *
 * So the message is found by **what it is**, not by where it sits.
 */

/** Longer than the old 300: these messages name a JSON path and then explain it. */
const MAX_DETAIL = 600;

/**
 * A JSON string value for `message`, wherever it appears.
 *
 * A regex rather than brace-matching a candidate object: the payload is
 * pretty-printed across many lines, may be preceded by a `ERROR: ` prefix, and
 * can appear more than once (codex prints the error per attempt). Finding the
 * field directly avoids having to decide where the object starts and ends, which
 * is the part that would be fragile.
 */
const MESSAGE_RE = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const CODE_RE = /"code"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

/** Lines that carry no information on their own — punctuation of the format. */
function isStructural(line: string): boolean {
  return line.trim() === '' || /^[{}[\],\s]*$/.test(line.trim());
}

function lastMatch(re: RegExp, text: string): string | null {
  let found: string | null = null;
  for (const m of text.matchAll(re)) found = m[1];
  return found;
}

/** Undo JSON string escaping in a value pulled out by regex rather than parsed. */
function unescape(value: string): string {
  return value
    .replace(/\\n/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cliErrorDetail(stderr: string, limit: number = MAX_DETAIL): string {
  const text = stderr.trim();
  if (text === '') return '';

  // The error's own words, when it has any. `code` goes in front because it is
  // the searchable part — "invalid_json_schema" finds the answer, the prose
  // explains it.
  const message = lastMatch(MESSAGE_RE, text);
  if (message !== null && message !== '') {
    const code = lastMatch(CODE_RE, text);
    const prefix = code === null || code === '' ? '' : `${code}: `;
    return `${prefix}${unescape(message)}`.slice(0, limit);
  }

  // Otherwise the tail, minus the punctuation — so a plain-text failure (a usage
  // dump, a missing binary) still says something, and a JSON blob with no
  // `message` field does not degrade to braces again.
  const lines = text.split('\n').filter((l) => !isStructural(l));
  if (lines.length === 0) return text.slice(0, limit);
  return lines
    .slice(-3)
    .map((l) => l.trim())
    .join(' ')
    .slice(0, limit);
}
