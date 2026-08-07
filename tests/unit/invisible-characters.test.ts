import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { MIN_SCANNED_FILES, MUST_BE_SCANNED, repoRoot as root, sourceFiles } from '../helpers/source-tree.js';

/**
 * No source file may carry an invisible character (NEWS-408).
 *
 * The companion to `control-bytes.test.ts`, and the more dangerous half of the
 * problem. That test is byte-level and answers exactly one question: would grep
 * treat this file as binary and skip it? The characters here answer none of it —
 * **every one of them is multi-byte in UTF-8**, so the file stays valid text,
 * `file` reports text, grep reads it fine, and not one of the NUL's symptoms
 * appears. Only the confusion does.
 *
 * Which is why this is a separate file rather than a widening of that scan. The
 * two share the walk (`tests/helpers/source-tree.ts`) so neither can cover a file
 * the other misses, and stay apart so each keeps a guarantee statable in one
 * sentence. C0 and DEL are therefore *not* checked here; they are that test's job.
 *
 * What is rejected, and why each one is worth a gate:
 *
 * - **C1 controls (U+0080–U+009F).** The C0 range's forgotten twin. They arrive
 *   from a mis-decoded CP1252 round-trip — an em dash put through the wrong codec
 *   comes back as one of these — and terminals interpret several of them: U+009B
 *   is CSI, the escape-sequence introducer.
 * - **U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR.** These are *line
 *   terminators to a JavaScript parser*. A statement can end without appearing to,
 *   and every tool that counts lines by `\n` — this test's own line numbers
 *   included, deliberately — disagrees with the parser about where the file's
 *   lines are. That disagreement is the bug.
 * - **A mid-file BOM (U+FEFF).** At offset 0 it is a conventional, harmless
 *   encoding marker and is allowed. Anywhere else it is a zero-width no-break
 *   space sitting inside an identifier, a JSON key or a shell command, and the
 *   error it produces names neither the character nor the line.
 * - **Zero-width and bidi characters** — U+200B, U+200C, and the Trojan Source set
 *   (CVE-2021-42574): U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069. A bidi
 *   override makes source **display in one order and compile in another**: the
 *   reviewer reads a comment, the compiler reads a statement. That is a documented
 *   supply-chain attack, not a typo, and there is no benign use of one here.
 *
 * Deliberately **not** scanned, each for a stated reason rather than because it
 * would have failed:
 *
 * - **U+FE0E / U+FE0F, the variation selectors.** They only choose the text or
 *   emoji presentation of the character *before* them; they cannot hide, reorder
 *   or terminate anything. `docs/5-desktop-app.md` uses U+FE0F twice, in its two
 *   warning callouts. Flagging those would be the first step towards a guard
 *   somebody switches off.
 * - **U+00A0 no-break space and U+00AD soft hyphen.** Both are real typography and
 *   both need a judgement call this ticket did not make. Neither appears in the
 *   tree today.
 *
 * And one **narrow, conditional** allowance — see `PICTOGRAPHIC` below.
 */

/**
 * U+200D ZERO WIDTH JOINER is allowed **only between two pictographs**.
 *
 * ZWJ is not decoration: it is what makes a woman-technologist emoji one glyph
 * instead of two, and a guard that rejects it outright is a guard the first person
 * to paste an emoji disables — at which point the bidi overrides come back too. So
 * it is permitted where it is doing that job and rejected everywhere else. A ZWJ
 * between two ASCII letters is not joining an emoji; it is splitting an identifier
 * in the reader's eye while the parser sees one token, and that is the attack.
 *
 * The rule is narrow on purpose. It was *not* written as "allow ZWJ in `docs/`"
 * or "allow ZWJ inside string literals": the first exempts the file type this repo
 * greps hardest, and the second needs a parser to answer, which a text scan does
 * not have and should not pretend to.
 *
 * **Nothing in the tree relies on this today** — the scan below finds no ZWJ at
 * all, in any file. It exists so that the day someone adds an emoji sequence to
 * the UI copy or a demo fixture, the guard stays on instead of coming off.
 */
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

/**
 * Characters that sit *between* the parts of an emoji sequence without being
 * pictographs themselves, and so must be stepped over when looking backwards from
 * a ZWJ for the thing it joins.
 *
 * A heart-on-fire is U+2764 U+FE0F U+200D U+1F525 — the character immediately
 * before the ZWJ is a variation selector, not the heart. Skin-tone modifiers
 * (U+1F3FB–U+1F3FF) sit in the same position in the astronaut sequences.
 */
function isEmojiModifier(cp: number): boolean {
  return cp === 0xfe0e || cp === 0xfe0f || (cp >= 0x1f3fb && cp <= 0x1f3ff);
}

/** ISO/IEC 6429 names for U+0080–U+009F, so the message can say what was found. */
const C1_NAMES = [
  'PAD (padding character)',
  'HOP (high octet preset)',
  'BPH (break permitted here)',
  'NBH (no break here)',
  'IND (index)',
  'NEL (next line)',
  'SSA (start of selected area)',
  'ESA (end of selected area)',
  'HTS (horizontal tab set)',
  'HTJ (horizontal tab with justification)',
  'VTS (vertical tab set)',
  'PLD (partial line down)',
  'PLU (partial line up)',
  'RI (reverse index)',
  'SS2 (single shift two)',
  'SS3 (single shift three)',
  'DCS (device control string)',
  'PU1 (private use one)',
  'PU2 (private use two)',
  'STS (set transmit state)',
  'CCH (cancel character)',
  'MW (message waiting)',
  'SPA (start of protected area)',
  'EPA (end of protected area)',
  'SOS (start of string)',
  'SGC (single graphic character introducer)',
  'SCI (single character introducer)',
  'CSI (control sequence introducer)',
  'ST (string terminator)',
  'OSC (operating system command)',
  'PM (privacy message)',
  'APC (application program command)',
];

/** The shared tail of every bidi entry: one attack, told once. */
const TROJAN_SOURCE = 'Trojan Source, CVE-2021-42574: source can display in one order and compile in another';

/**
 * Every codepoint rejected unconditionally, with the name and the reason that go
 * into the failure message.
 *
 * A table rather than a chain of range checks, because the message has to name the
 * character. "Invisible character found" would send the next person hunting
 * through a file their editor renders as clean — the same trap
 * `control-bytes.test.ts` was careful to avoid.
 */
const REJECTED = new Map<number, { name: string; why: string }>([
  [0x2028, { name: 'LINE SEPARATOR', why: 'a line terminator to a JavaScript parser: it can end a statement without appearing to' }],
  [0x2029, { name: 'PARAGRAPH SEPARATOR', why: 'a line terminator to a JavaScript parser: it can end a statement without appearing to' }],
  [
    0xfeff,
    {
      name: 'ZERO WIDTH NO-BREAK SPACE',
      why: 'a byte-order mark somewhere other than offset 0, where it is simply an invisible character inside the text',
    },
  ],
  [0x200b, { name: 'ZERO WIDTH SPACE', why: 'invisible, and splits a token for the reader while the parser sees one' }],
  [0x200c, { name: 'ZERO WIDTH NON-JOINER', why: 'invisible, and splits a token for the reader while the parser sees one' }],
  [0x061c, { name: 'ARABIC LETTER MARK', why: `a bidi control (${TROJAN_SOURCE})` }],
  [0x200e, { name: 'LEFT-TO-RIGHT MARK', why: `a bidi control (${TROJAN_SOURCE})` }],
  [0x200f, { name: 'RIGHT-TO-LEFT MARK', why: `a bidi control (${TROJAN_SOURCE})` }],
  [0x202a, { name: 'LEFT-TO-RIGHT EMBEDDING', why: `a bidi override (${TROJAN_SOURCE})` }],
  [0x202b, { name: 'RIGHT-TO-LEFT EMBEDDING', why: `a bidi override (${TROJAN_SOURCE})` }],
  [0x202c, { name: 'POP DIRECTIONAL FORMATTING', why: `a bidi override (${TROJAN_SOURCE})` }],
  [0x202d, { name: 'LEFT-TO-RIGHT OVERRIDE', why: `a bidi override (${TROJAN_SOURCE})` }],
  [0x202e, { name: 'RIGHT-TO-LEFT OVERRIDE', why: `a bidi override (${TROJAN_SOURCE})` }],
  [0x2066, { name: 'LEFT-TO-RIGHT ISOLATE', why: `a bidi isolate (${TROJAN_SOURCE})` }],
  [0x2067, { name: 'RIGHT-TO-LEFT ISOLATE', why: `a bidi isolate (${TROJAN_SOURCE})` }],
  [0x2068, { name: 'FIRST STRONG ISOLATE', why: `a bidi isolate (${TROJAN_SOURCE})` }],
  [0x2069, { name: 'POP DIRECTIONAL ISOLATE', why: `a bidi isolate (${TROJAN_SOURCE})` }],
]);

/** `U+202E`, the form every Unicode reference and every bug report uses. */
function asCodepoint(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Why the character at index `i` of `chars` is not allowed, or `null` if it is.
 *
 * Position matters for exactly two of them — a BOM is allowed at offset 0 and
 * nowhere else, and a ZWJ is allowed between pictographs and nowhere else — which
 * is why this takes the whole sequence rather than a lone codepoint.
 */
function rejectionFor(chars: string[], i: number): { name: string; why: string } | null {
  const cp = chars[i].codePointAt(0) ?? 0;

  // A BOM at the very start of a file is conventional and harmless. Node does not
  // strip it from a `utf8` read, so it arrives here as index 0 and is waved
  // through; anywhere else it falls to the table above.
  if (cp === 0xfeff && i === 0) return null;

  if (cp >= 0x80 && cp <= 0x9f) {
    return {
      name: `C1 CONTROL ${C1_NAMES[cp - 0x80]}`,
      why: 'a C1 control, usually the wreckage of a CP1252 round-trip, and interpreted by some terminals',
    };
  }

  if (cp === 0x200d) {
    let back = i - 1;
    while (back >= 0 && isEmojiModifier(chars[back].codePointAt(0) ?? 0)) back--;
    const joinsEmoji =
      back >= 0 && PICTOGRAPHIC.test(chars[back]) && i + 1 < chars.length && PICTOGRAPHIC.test(chars[i + 1]);
    return joinsEmoji
      ? null
      : {
          name: 'ZERO WIDTH JOINER',
          why: 'allowed only between two pictographs, where it builds a single emoji glyph; here it joins ordinary text, hiding a token boundary from the reader',
        };
  }

  return REJECTED.get(cp) ?? null;
}

/**
 * A window of `chars` around index `i`, with the invisible characters spelled out.
 *
 * Printing the raw line would print the culprit invisibly a second time — into a
 * terminal, and into a CI log — which is not much of a report. Only the characters
 * this test knows about are escaped: an em dash or an emoji in the surrounding
 * prose stays itself, so the window still reads like the line it came from.
 */
function contextWindow(chars: string[], i: number): string {
  const from = Math.max(0, i - 30);
  const to = Math.min(chars.length, i + 31);
  const body = chars
    .slice(from, to)
    .map((ch, offset) => {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp < 0x20 || cp === 0x7f) return `<${asCodepoint(cp)}>`;
      // `from + offset` is the real index, which `rejectionFor` needs for the
      // BOM-at-offset-0 and ZWJ-between-pictographs rules.
      return rejectionFor(chars, from + offset) === null ? ch : `<${asCodepoint(cp)}>`;
    })
    .join('')
    .replace(/<U\+000A>/g, '\\n');
  return `${from > 0 ? '...' : ''}${body}${to < chars.length ? '...' : ''}`;
}

/**
 * The first invisible character in `text`, described well enough to go and fix it.
 *
 * Reports the codepoint in `U+XXXX` form, its Unicode name, what it does, and the
 * 1-based line and column — **counting lines by `\n` only**. That is what the
 * editor, the stack trace and `grep -n` all count by, so it is the number that
 * takes you to the character. For U+2028/U+2029 it is also, pointedly, not what
 * the JavaScript parser counts by; that mismatch is the reason they are rejected.
 *
 * Columns are counted in codepoints, so an emoji earlier on the line advances the
 * column by one rather than by two.
 */
function findInvisible(text: string): string | null {
  const chars = Array.from(text);
  let line = 1;
  let column = 1;
  for (let i = 0; i < chars.length; i++) {
    const rejection = rejectionFor(chars, i);
    if (rejection !== null) {
      const cp = asCodepoint(chars[i].codePointAt(0) ?? 0);
      return `${cp} ${rejection.name} at line ${line}, column ${column} — ${rejection.why}. Context: ${contextWindow(chars, i)}`;
    }
    if (chars[i] === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return null;
}

// Every fixture below builds its character from a `\u` escape rather than writing
// it literally, for the reason `control-bytes.test.ts` builds its NUL from
// `String.fromCharCode`: a literal would make this file fail its own scan, and
// "exempt the test file" is the wrong fix.
const BOM = '\u{feff}';
const CSI = '\u{9b}';
const LS = '\u{2028}';
const PS = '\u{2029}';
const RLO = '\u{202e}';
const ZWJ = '\u{200d}';
const ZWNJ = '\u{200c}';
const ZWSP = '\u{200b}';
const VS16 = '\u{fe0f}';

describe('no source file carries an invisible character (NEWS-408)', () => {
  it('scans a plausible number of files, so a broken walk cannot pass silently', () => {
    // The failure mode of a scan-based test: match nothing, assert nothing, stay
    // green forever. The list and the floor are shared with
    // `control-bytes.test.ts` so the two guards cannot drift into disagreeing
    // about what the tree is.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(MIN_SCANNED_FILES);
    for (const required of MUST_BE_SCANNED) {
      expect(files.map((f) => path.relative(root, f)), `${required} is scanned`).toContain(required);
    }
  });

  it('finds none under src/, tests/, scripts/, docs/ or src-tauri/', () => {
    const offenders = sourceFiles().flatMap((file) => {
      const found = findInvisible(fs.readFileSync(file, 'utf8'));
      return found === null ? [] : [`${path.relative(root, file)}: ${found}`];
    });
    expect(offenders).toEqual([]);
  });

  it('names the bidi override of Trojan Source, in full', () => {
    // The whole message, asserted verbatim once, because the requirement is the
    // message: file, codepoint, name, line, column. The other cases check the
    // parts they are about.
    expect(findInvisible(`const valid = user.isAdmin; // ${RLO}gnitset rof\n`)).toBe(
      'U+202E RIGHT-TO-LEFT OVERRIDE at line 1, column 32 — a bidi override (Trojan Source, CVE-2021-42574: source can display in one order and compile in another). Context: ...onst valid = user.isAdmin; // <U+202E>gnitset rof\\n',
    );
  });

  it('names each of the other bidi controls', () => {
    for (const [cp, expected] of [
      [0x061c, 'ARABIC LETTER MARK'],
      [0x200e, 'LEFT-TO-RIGHT MARK'],
      [0x200f, 'RIGHT-TO-LEFT MARK'],
      [0x202a, 'LEFT-TO-RIGHT EMBEDDING'],
      [0x202b, 'RIGHT-TO-LEFT EMBEDDING'],
      [0x202c, 'POP DIRECTIONAL FORMATTING'],
      [0x202d, 'LEFT-TO-RIGHT OVERRIDE'],
      [0x2066, 'LEFT-TO-RIGHT ISOLATE'],
      [0x2067, 'RIGHT-TO-LEFT ISOLATE'],
      [0x2068, 'FIRST STRONG ISOLATE'],
      [0x2069, 'POP DIRECTIONAL ISOLATE'],
    ] as const) {
      expect(findInvisible(`a${String.fromCodePoint(cp)}b`), `${asCodepoint(cp)} is rejected`).toContain(
        `${asCodepoint(cp)} ${expected} at line 1, column 2`,
      );
    }
  });

  it('names a C1 control, on the line it is actually on', () => {
    // U+009B is CSI, the escape-sequence introducer — the C1 most likely to do
    // something to a terminal that cats the file.
    expect(findInvisible(`ok\nok\nx = ${CSI};\n`)).toBe(
      'U+009B C1 CONTROL CSI (control sequence introducer) at line 3, column 5 — a C1 control, usually the wreckage of a CP1252 round-trip, and interpreted by some terminals. Context: ok\\nok\\nx = <U+009B>;\\n',
    );
  });

  it('names the Unicode line separators', () => {
    expect(findInvisible(`const a = 1${LS} const b = 2\n`)).toContain(
      'U+2028 LINE SEPARATOR at line 1, column 12 — a line terminator to a JavaScript parser',
    );
    expect(findInvisible(`para one${PS} para two\n`)).toContain('U+2029 PARAGRAPH SEPARATOR at line 1, column 9');
  });

  it('allows a BOM at offset 0 and rejects one anywhere else', () => {
    expect(findInvisible(`${BOM}{\n  "name": "newsmonger"\n}\n`)).toBeNull();
    expect(findInvisible(`{\n  "${BOM}name": "newsmonger"\n}\n`)).toContain(
      'U+FEFF ZERO WIDTH NO-BREAK SPACE at line 2, column 4 — a byte-order mark somewhere other than offset 0',
    );
  });

  it('rejects the zero-width space and non-joiner', () => {
    expect(findInvisible(`adm${ZWSP}in`)).toContain('U+200B ZERO WIDTH SPACE at line 1, column 4');
    expect(findInvisible(`adm${ZWNJ}in`)).toContain('U+200C ZERO WIDTH NON-JOINER at line 1, column 4');
  });

  it('allows a zero-width joiner between pictographs, including across a modifier', () => {
    // The three shapes a real emoji ZWJ sequence takes: plain, through a variation
    // selector, and through a skin-tone modifier.
    expect(findInvisible(`shipped \u{1f469}${ZWJ}\u{1f4bb} today\n`)).toBeNull();
    expect(findInvisible(`\u{2764}${VS16}${ZWJ}\u{1f525}\n`)).toBeNull();
    expect(findInvisible(`\u{1f9d1}\u{1f3fd}${ZWJ}\u{1f680}\n`)).toBeNull();
  });

  it('rejects a zero-width joiner that is not joining an emoji', () => {
    // The point of the conditional rule: the same codepoint, used to hide a token
    // boundary in ordinary text.
    expect(findInvisible(`const is${ZWJ}Admin = false;\n`)).toContain(
      'U+200D ZERO WIDTH JOINER at line 1, column 9 — allowed only between two pictographs',
    );
    // Trailing, with nothing to join.
    expect(findInvisible(`\u{1f469}${ZWJ}`)).toContain('U+200D ZERO WIDTH JOINER at line 1, column 2');
    // Leading, likewise.
    expect(findInvisible(`${ZWJ}\u{1f469}`)).toContain('U+200D ZERO WIDTH JOINER at line 1, column 1');
  });

  it('leaves ordinary prose, emoji and variation selectors alone', () => {
    // All of this is in the tree today: em dashes and arrows throughout the docs,
    // and a warning sign — U+26A0 U+FE0F — in the two release-key callouts of
    // `docs/5-desktop-app.md`. A guard that flagged them is a guard someone turns
    // off, so the variation selectors are out of scope on purpose.
    expect(findInvisible(`a\tb\r\nc \u{2014} d \u{2192} e \u{26a0}${VS16} f \u{1f389}\n`)).toBeNull();
  });

  it('leaves C0 and DEL to the byte-level scan', () => {
    // Not an oversight: a NUL is `control-bytes.test.ts`'s to report, and two
    // guards reporting the same defect with different wording is how one of them
    // ends up maintained and the other stale.
    expect(findInvisible(`a${String.fromCharCode(0)}b`)).toBeNull();
    expect(findInvisible(`a${String.fromCharCode(0x7f)}b`)).toBeNull();
  });
});
