import { describe, expect, it } from 'vitest';

import { cliErrorDetail } from '../../src/ai/providers/cli-error.js';

/**
 * Surfacing a CLI failure in words (NEWS-274).
 *
 * The fixtures below are **real stderr**, captured from the two Codex failures in
 * NEWS-272 rather than invented — which matters, because the bug was entirely
 * about the *shape* of real output. Both providers used to take
 * `split('\n').slice(-3)`, and the last three lines of a pretty-printed JSON
 * error are its closing braces.
 */

/** The 400 that broke every Codex check. Trimmed in the middle, shape preserved. */
const JSON_ERROR = `
[2026-08-03T09:22:03] OpenAI Codex v0.145.0
--------
workdir: /Users/x/news
model: gpt-5.6-sol
--------
ERROR: {
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "code": "invalid_json_schema",
    "message": "Invalid schema for response_format 'codex_output_schema': In context=('properties', 'items', 'items', 'properties', 'sources', 'items'), 'required' is required to be supplied and to be an array including every key in properties. Missing 'outlet'.",
    "param": "text.format.schema"
  },
  "status": 400
}
`;

/** The exit-2 usage dump from the removed `--search` flag. */
const USAGE_ERROR = `
error: unexpected argument '--search' found

Usage: codex exec [OPTIONS] [PROMPT]
       codex exec [OPTIONS] <COMMAND> [ARGS]

For more information, try '--help'.
`;

describe('cliErrorDetail', () => {
  it('surfaces the message from a JSON error, not its closing braces', () => {
    const detail = cliErrorDetail(JSON_ERROR);
    // What the user used to get: `}, "status": 400 }`.
    expect(detail).toContain("Missing 'outlet'");
    expect(detail).toContain('required');
    expect(detail).not.toMatch(/^\s*[}\],]/);
  });

  it('leads with the error code, which is the searchable part', () => {
    expect(cliErrorDetail(JSON_ERROR)).toMatch(/^invalid_json_schema: /);
  });

  it('keeps enough of the message to be actionable', () => {
    // The old 300-character cap truncated exactly the sentences worth reading:
    // this one names a JSON path *before* it says what is wrong with it.
    const detail = cliErrorDetail(JSON_ERROR);
    expect(detail.length).toBeGreaterThan(200);
    expect(detail).toContain('every key in properties');
  });

  it('still says something useful for a plain-text failure', () => {
    const detail = cliErrorDetail(USAGE_ERROR);
    expect(detail).toContain("try '--help'");
  });

  it('skips structural lines rather than counting them as content', () => {
    // A JSON blob with no `message` field must not degrade back to braces.
    const detail = cliErrorDetail('{\n  "oops": true,\n  "status": 500\n}\n');
    expect(detail).toContain('status');
    expect(detail).not.toBe('}, "status": 500 }');
  });

  it('collapses escapes and newlines so the sentence reads as one line', () => {
    const detail = cliErrorDetail('{"message": "line one\\nline two \\"quoted\\""}');
    expect(detail).toBe('line one line two "quoted"');
  });

  it('takes the last error when a CLI retries and prints several', () => {
    // Codex prints its error once per attempt; the final one is the outcome.
    const detail = cliErrorDetail('ERROR: {"code":"first","message":"the first"}\nERROR: {"code":"second","message":"the last"}');
    expect(detail).toBe('second: the last');
  });

  it('is empty for empty stderr, so the caller can omit the suffix', () => {
    expect(cliErrorDetail('')).toBe('');
    expect(cliErrorDetail('   \n  \n')).toBe('');
  });

  it('beats what the old positional slice produced, for the same input', () => {
    // Kept as a comparison rather than prose: this is the exact expression both
    // providers used, and running it on the real payload is the clearest possible
    // statement of why it had to change.
    const old = JSON_ERROR.trim().split('\n').slice(-3).join(' ').slice(0, 300);
    // Indentation and all — it rendered in the bug report as `}, "status": 400 }`
    // only because Markdown collapsed the whitespace.
    expect(old).toBe('  },   "status": 400 }');
    expect(old).not.toContain('outlet');
    expect(cliErrorDetail(JSON_ERROR)).toContain('outlet');
  });

  it('honours the length cap', () => {
    expect(cliErrorDetail(`{"message": "${'x'.repeat(2000)}"}`, 50)).toHaveLength(50);
  });
});
