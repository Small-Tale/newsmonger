import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MIN_SCANNED_FILES,
  MUST_BE_SCANNED,
  repoRelative,
  repoRoot as root,
  sourceFiles,
} from '../helpers/source-tree.js';

/**
 * No source file may carry a character that misrepresents the text it is in
 * (NEWS-408, NEWS-413, NEWS-414).
 *
 * Most of them are invisible, which is where the filename comes from and still the
 * best one-line description. Two are not: U+00A0 looks exactly like the space it is
 * not, and U+FFFD is a visible marker that some other text used to be there. The
 * property they all share is the one worth gating — **what you read is not what is
 * on disk**.
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
 * - **Zero-width and bidi characters** — U+200B, U+200C, U+2060, and the Trojan
 *   Source set (CVE-2021-42574): U+061C, U+200E, U+200F, U+202A–U+202E,
 *   U+2066–U+2069. A bidi override makes source **display in one order and compile
 *   in another**: the reviewer reads a comment, the compiler reads a statement.
 *   That is a documented supply-chain attack, not a typo, and there is no benign
 *   use of one here. U+2060 WORD JOINER joined them in NEWS-413 — it is U+200B with
 *   different line-breaking behaviour, and leaving it out was an arbitrary hole in
 *   a rule that already rejects its two neighbours.
 * - **U+FFF9–U+FFFB, the interlinear annotation characters** (NEWS-413). Unicode
 *   states outright that these are not for interchanged plain text: they delimit an
 *   annotation whose base and body a renderer may show quite differently from the
 *   stored order. That is the Trojan Source theme with a different mechanism.
 * - **U+00A0 NO-BREAK SPACE and U+00AD SOFT HYPHEN** — the NEWS-413 judgement call;
 *   the reasoning is below, because "obviously yes" was not the answer and the next
 *   person deserves the argument rather than the verdict.
 * - **U+2000–U+200A, U+202F NARROW NO-BREAK SPACE and U+205F MEDIUM MATHEMATICAL
 *   SPACE** — the NEWS-418 judgement call, and a *split* one: U+3000 IDEOGRAPHIC
 *   SPACE was weighed with these twelve and is deliberately allowed. The reasoning
 *   for both halves is below.
 * - **U+FFFD REPLACEMENT CHARACTER** (NEWS-414), the gap between the two guards.
 *   `readFileSync(file, 'utf8')` does not throw on invalid UTF-8; it *substitutes*.
 *   So a genuinely corrupted text file decodes "successfully", holds no control
 *   byte for `control-bytes.test.ts` to find and no bidi character for this one,
 *   and sails through both while being mojibake. It belongs here rather than there
 *   because it is a property of *decoding*: the byte scan reads a `Buffer` and by
 *   construction can never see one. Nothing in the tree contains a U+FFFD today —
 *   checked, because a sanitisation fixture holding one deliberately would have
 *   been a legitimate exception, and there is none.
 *
 * ## Why U+00A0 and U+00AD are rejected outright (NEWS-413)
 *
 * The case against gating them is real and is the same one that shaped the ZWJ rule
 * below: NBSP is *correct typography* — in "10 MB", in "Figure 1" — and a guard
 * that fires on legitimate prose is a guard somebody switches off, taking the bidi
 * overrides with it. This repo is 39 files of prose under `docs/`, plus README and
 * CLAUDE.md. That is not a small surface to bet.
 *
 * It is still the right call, for four reasons:
 *
 * 1. **The scan found zero of either, in all ~346 files.** Every doc, every README,
 *    every requirements document has been written without one. Compare U+FE0F,
 *    which is *actually in* `docs/5-desktop-app.md` and is therefore left alone.
 *    The prose argument is real in general and hypothetical here.
 * 2. **There is a visible alternative, and that is the whole difference from ZWJ.**
 *    A woman-technologist emoji cannot be written without a joiner, so rejecting
 *    ZWJ outright would have forced people to choose between the guard and their
 *    content. NBSP has `&nbsp;`, soft hyphen has `&shy;`, and both render
 *    identically while staying greppable. A rule you can satisfy in five seconds
 *    with a *better* answer is a rule people follow. The failure message says so.
 * 3. **The obvious compromise — reject in code, allow in prose — exempts exactly
 *    the wrong files.** NBSP's canonical damage is to shell commands and YAML,
 *    where the error names neither the character nor the line; and the fenced
 *    command blocks people copy out of are in the Markdown. CLAUDE.md alone hands
 *    the reader `pueue add -p -l news-gate -- npm run test:all` to paste. An
 *    extension-based prose exemption would protect the files nobody pastes from.
 * 4. **Soft hyphen barely needs the argument.** It is invisible in plain text,
 *    breaks a grep for the word it sits inside exactly as U+200B does, travels
 *    silently through a copy-paste out of rendered output, and is not hand-authored
 *    in a repo like this one.
 *
 * If a doc ever does need a literal NBSP, the exemption gets written then, narrow,
 * with the actual case in hand — which is the order the ZWJ rule was arrived at,
 * and the right one. Widening an allow-list to make a scan pass is the wrong one.
 *
 * ## Why the rest of the space family splits 12–1 (NEWS-418)
 *
 * NEWS-413 left these for their own argument rather than taking them with the diff
 * that was open: U+2000–U+200A, U+202F, U+205F, U+3000. Its four grounds are the
 * frame, and applying them one at a time is what produces a split rather than a
 * verdict.
 *
 * **Ground 1 — zero occurrences — holds for all fourteen**, re-checked over the same
 * ~346 files. So none of this is retrofitting a rule onto content that exists.
 *
 * **Ground 3 — the refused prose exemption — holds unchanged.** Every one of these
 * is whitespace to a human and *not* whitespace to bash (IFS is space, tab and
 * newline), to YAML (space and tab) or to JSON (space, tab, CR, LF). A fenced block
 * in a Markdown file is still the thing people paste from.
 *
 * **Ground 4 — grep — holds too, and more sharply than for NBSP.** These characters
 * are not word-internal; they sit *between* words, which is where a search puts its
 * space. A grep for "topic categories" simply misses the line.
 *
 * **Ground 2 — a visible alternative exists — is the load-bearing one, and it is
 * where the family comes apart.** For twelve of them the alternative is real and
 * was checked against the HTML5 entity table rather than recalled: `&ensp;`,
 * `&emsp;`, `&emsp13;`, `&emsp14;`, `&numsp;`, `&puncsp;`, `&thinsp;`, `&hairsp;`,
 * `&MediumSpace;`. U+2000 and U+2001 are *canonically equivalent* to U+2002 and
 * U+2003, so `&ensp;` and `&emsp;` cover them exactly; U+2006 has no name and takes
 * `&#8198;`. U+202F has no named entity either, and needs none: nobody in this repo
 * has a reason to type one, and a plain space or `&nbsp;` says what was meant.
 *
 * **U+202F is the clearest of the fourteen.** It is NBSP with a narrower advance —
 * same paste origin (a browser, a word processor, macOS text substitution), same
 * non-breaking behaviour, same damage to a shell command, a YAML key or a JSON
 * document, and it is *harder* to spot than NBSP rather than easier, because it is
 * narrow rather than the width of the space it is impersonating. Rejecting NBSP and
 * allowing this would be an arbitrary hole in the rule, the same shape as the one
 * NEWS-413 closed by adding U+2060 next to U+200B and U+200C.
 *
 * ### The exception: U+3000 IDEOGRAPHIC SPACE is allowed
 *
 * Ground 2 fails for it, and a second, independent ground fails as well.
 *
 * **There is no comfortable substitute.** U+3000 is not a typographic flourish in
 * CJK text; it is *the* space, the full-width one that belongs between and around
 * CJK. It has no HTML named entity — checked, along with the others — so the
 * alternative on offer is `&#12288;`, which does not render CJK prose readable in
 * source, it renders it unreadable. That is the ZWJ situation exactly: a
 * woman-technologist emoji cannot be written without a joiner, and a Japanese
 * sentence cannot be spaced without this. A rule you can only satisfy by mangling
 * your content is a rule that gets the guard switched off, and the bidi overrides go
 * with it.
 *
 * **And this is not hypothetical here.** FR-35.2 ships a location field explicitly
 * designed to hold any script and refuses to normalise, case-fold or transliterate
 * what is typed — `docs/35-location.md` and `src/db/schemas.ts` argue the point in
 * prose, `src/client/onboarding-view.tsx` puts 東京 in the placeholder a user reads,
 * and `tests/unit/location-prompt.test.ts` pins コンサート and 北海道 precisely so a
 * stray slugify cannot turn them into nothing. CJK is already in nine files of this
 * tree. The next fixture or doc sentence that spaces it properly is not a
 * far-fetched scenario, it is the feature working.
 *
 * **It also fails this file's own criterion.** The property shared by everything
 * rejected above is stated at the top: *what you read is not what is on disk*.
 * U+3000 is double-width. In the monospace font every one of these files is read in
 * it is a conspicuous gap, not a space wearing a disguise — which is the one thing
 * that can be said for it and cannot be said for U+2009 or U+202F.
 *
 * So it goes on the same shelf as the variation selectors: not scanned, for a stated
 * reason, and the reason is written down so the next person does not have to
 * rediscover it. If a U+3000 ever *does* turn up somewhere it has no business being,
 * that is a narrow rule to write then — "outside a CJK context" — with the actual
 * case in hand.
 *
 * Deliberately **not** scanned, for a stated reason rather than because it would
 * have failed:
 *
 * - **U+FE0E / U+FE0F, the variation selectors.** They only choose the text or
 *   emoji presentation of the character *before* them; they cannot hide, reorder
 *   or terminate anything. `docs/5-desktop-app.md` uses U+FE0F twice, in its two
 *   warning callouts. Flagging those would be the first step towards a guard
 *   somebody switches off.
 * - **U+3000 IDEOGRAPHIC SPACE** (NEWS-418) — the one member of the space family
 *   that survived the argument above. Pinned by a test, so that a later widening to
 *   "anything with the White_Space property" fails there rather than in whichever
 *   file first writes a Japanese sentence properly.
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

/** Likewise for the three interlinear annotation characters (NEWS-413). */
const INTERLINEAR =
  'an interlinear annotation delimiter, which Unicode states is not for interchanged plain text: it lets a renderer show something other than the stored order';

/**
 * One entry in the fixed-width space family (NEWS-418), with the alternative that
 * keeps the guard switched on.
 *
 * The message has to name a *better* answer, not just a prohibition — that is
 * NEWS-413's second ground and the reason the NBSP rule survives contact with a
 * repo that is 39 files of prose. Every entity below was verified against the HTML5
 * table rather than recalled, because a message that names an entity which does not
 * exist is worse than one that names none.
 */
function spaceEntry(name: string, alternative: string): { name: string; why: string } {
  return {
    name,
    why:
      `a Unicode space that no parser treats as one: bash splits words on space, tab and newline, YAML on space and tab, JSON on space, tab, CR and LF, and this is none of them — so it survives a paste as whitespace that is not whitespace. It also sits between words, which is where a search puts its space, so a grep for the phrase around it finds nothing. Write a plain space, or ${alternative} where the width genuinely matters`,
  };
}

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
  [0x2060, { name: 'WORD JOINER', why: 'invisible, and splits a token for the reader while the parser sees one' }],
  [
    0x00a0,
    {
      name: 'NO-BREAK SPACE',
      why: 'indistinguishable from a space it is not: it arrives silently from a web paste and breaks shell commands and YAML with an error naming neither the character nor the line. Write a plain space, or `&nbsp;` where the typography matters',
    },
  ],
  [
    0x00ad,
    {
      name: 'SOFT HYPHEN',
      why: 'invisible until a renderer breaks the line, and until then it splits the word for grep exactly as a zero-width space would. Write `&shy;` if a break hint is really wanted',
    },
  ],
  // The fixed-width space family (NEWS-418). U+2000 and U+2001 are canonically
  // equivalent to U+2002 and U+2003, so they take the same entity; U+2006 has no
  // named entity and takes the numeric reference.
  [0x2000, spaceEntry('EN QUAD', '`&ensp;`')],
  [0x2001, spaceEntry('EM QUAD', '`&emsp;`')],
  [0x2002, spaceEntry('EN SPACE', '`&ensp;`')],
  [0x2003, spaceEntry('EM SPACE', '`&emsp;`')],
  [0x2004, spaceEntry('THREE-PER-EM SPACE', '`&emsp13;`')],
  [0x2005, spaceEntry('FOUR-PER-EM SPACE', '`&emsp14;`')],
  [0x2006, spaceEntry('SIX-PER-EM SPACE', '`&#8198;`')],
  [0x2007, spaceEntry('FIGURE SPACE', '`&numsp;`')],
  [0x2008, spaceEntry('PUNCTUATION SPACE', '`&puncsp;`')],
  [0x2009, spaceEntry('THIN SPACE', '`&thinsp;`')],
  [0x200a, spaceEntry('HAIR SPACE', '`&hairsp;`')],
  [0x205f, spaceEntry('MEDIUM MATHEMATICAL SPACE', '`&MediumSpace;`')],
  [
    // NBSP's twin, and the strongest candidate of the fourteen NEWS-418 weighed:
    // same paste origin, same non-breaking behaviour, same damage — and narrower
    // than the space it impersonates, so harder to spot rather than easier.
    0x202f,
    {
      name: 'NARROW NO-BREAK SPACE',
      why: 'U+00A0 with a narrower advance, and every word of that entry applies: it arrives silently from a web paste, breaks shell commands and YAML with an error naming neither the character nor the line, and is harder to see than a no-break space rather than easier. Write a plain space, or `&nbsp;` where the line must not break',
    },
  ],
  [
    0xfffd,
    {
      name: 'REPLACEMENT CHARACTER',
      why: 'mojibake: either invalid UTF-8 that `readFileSync(…, "utf8")` silently substituted for, or already-broken text committed as-is. Either way the file is no longer the text it appears to be, and the original bytes are gone',
    },
  ],
  [0xfff9, { name: 'INTERLINEAR ANNOTATION ANCHOR', why: INTERLINEAR }],
  [0xfffa, { name: 'INTERLINEAR ANNOTATION SEPARATOR', why: INTERLINEAR }],
  [0xfffb, { name: 'INTERLINEAR ANNOTATION TERMINATOR', why: INTERLINEAR }],
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
const NBSP = '\u{a0}';
const SHY = '\u{ad}';
const WJ = '\u{2060}';
const FFFD = '\u{fffd}';
const NNBSP = '\u{202f}';
const THINSP = '\u{2009}';
const IDEOSP = '\u{3000}';

describe('no source file carries an invisible or deceptive character (NEWS-408, NEWS-413, NEWS-414)', () => {
  it('scans a plausible number of files, so a broken walk cannot pass silently', () => {
    // The failure mode of a scan-based test: match nothing, assert nothing, stay
    // green forever. The list and the floor are shared with
    // `control-bytes.test.ts` so the two guards cannot drift into disagreeing
    // about what the tree is.
    // `repoRelative`, not `path.relative`: `MUST_BE_SCANNED` is written with `/`
    // and Windows would hand back `\`, so every assertion below would fail there
    // and nowhere else (NEWS-419).
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(MIN_SCANNED_FILES);
    for (const required of MUST_BE_SCANNED) {
      expect(files.map(repoRelative), `${required} is scanned`).toContain(required);
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

  it('rejects the zero-width space, non-joiner and word joiner', () => {
    expect(findInvisible(`adm${ZWSP}in`)).toContain('U+200B ZERO WIDTH SPACE at line 1, column 4');
    expect(findInvisible(`adm${ZWNJ}in`)).toContain('U+200C ZERO WIDTH NON-JOINER at line 1, column 4');
    // U+2060 is U+200B with different line-breaking behaviour and identical
    // deniability; NEWS-413 closed the hole rather than leaving one of the three.
    expect(findInvisible(`adm${WJ}in`)).toContain('U+2060 WORD JOINER at line 1, column 4');
  });

  it('rejects a no-break space, and offers the alternative in the message (NEWS-413)', () => {
    // The whole message, because for this one the *message* is what keeps the guard
    // switched on: it has to name a fix that is quicker than an exemption. The
    // context window is the other half — an NBSP printed raw would print as a space
    // and the report would look like it was complaining about nothing.
    expect(findInvisible(`See docs/2-checks.md${NBSP}for the interval.\n`)).toBe(
      'U+00A0 NO-BREAK SPACE at line 1, column 21 — indistinguishable from a space it is not: it arrives silently from a web paste and breaks shell commands and YAML with an error naming neither the character nor the line. Write a plain space, or `&nbsp;` where the typography matters. Context: See docs/2-checks.md<U+00A0>for the interval.\\n',
    );
  });

  it('rejects a soft hyphen (NEWS-413)', () => {
    // Invisible here, and the reason it is not merely cosmetic: a grep for
    // "deduplicates" misses this line, exactly as it would past a U+200B.
    expect(findInvisible(`dedu${SHY}plicates against previous stories\n`)).toContain(
      'U+00AD SOFT HYPHEN at line 1, column 5 — invisible until a renderer breaks the line',
    );
  });

  it('rejects the interlinear annotation characters (NEWS-413)', () => {
    for (const [cp, expected] of [
      [0xfff9, 'INTERLINEAR ANNOTATION ANCHOR'],
      [0xfffa, 'INTERLINEAR ANNOTATION SEPARATOR'],
      [0xfffb, 'INTERLINEAR ANNOTATION TERMINATOR'],
    ] as const) {
      expect(findInvisible(`a${String.fromCodePoint(cp)}b`), `${asCodepoint(cp)} is rejected`).toContain(
        `${asCodepoint(cp)} ${expected} at line 1, column 2`,
      );
    }
  });

  it('rejects the narrow no-break space, in full (NEWS-418)', () => {
    // The whole message for the strongest of the fourteen, for the reason NBSP gets
    // one: this is where the guard either hands over a quicker fix than an
    // exemption, or does not. The context window matters doubly here — printed raw,
    // a U+202F would print as a slightly narrow space and the report would look like
    // it was complaining about nothing at all.
    expect(findInvisible(`run npm${NNBSP}test before committing.\n`)).toBe(
      'U+202F NARROW NO-BREAK SPACE at line 1, column 8 — U+00A0 with a narrower advance, and every word of that entry applies: it arrives silently from a web paste, breaks shell commands and YAML with an error naming neither the character nor the line, and is harder to see than a no-break space rather than easier. Write a plain space, or `&nbsp;` where the line must not break. Context: run npm<U+202F>test before committing.\\n',
    );
  });

  it('names each fixed-width space and the entity that replaces it (NEWS-418)', () => {
    // Every entity here was checked against the HTML5 table. Asserting them keeps a
    // remembered-but-wrong name — `&nnbsp;`, `&ideosp;`, neither of which exists —
    // from reaching a failure message, where it would send someone to write markup
    // that renders as literal text.
    for (const [cp, name, alternative] of [
      // `&ensp;` and `&emsp;` are the right answer for the quads because U+2000 and
      // U+2001 *are* U+2002 and U+2003 under canonical equivalence. The message says
      // only the fix; the equivalence is the table comment's job, not the reader's
      // problem at the moment they are staring at a failure.
      [0x2000, 'EN QUAD', '`&ensp;`'],
      [0x2001, 'EM QUAD', '`&emsp;`'],
      [0x2002, 'EN SPACE', '`&ensp;`'],
      [0x2003, 'EM SPACE', '`&emsp;`'],
      [0x2004, 'THREE-PER-EM SPACE', '`&emsp13;`'],
      [0x2005, 'FOUR-PER-EM SPACE', '`&emsp14;`'],
      [0x2006, 'SIX-PER-EM SPACE', '`&#8198;`'],
      [0x2007, 'FIGURE SPACE', '`&numsp;`'],
      [0x2008, 'PUNCTUATION SPACE', '`&puncsp;`'],
      [0x2009, 'THIN SPACE', '`&thinsp;`'],
      [0x200a, 'HAIR SPACE', '`&hairsp;`'],
      [0x205f, 'MEDIUM MATHEMATICAL SPACE', '`&MediumSpace;`'],
    ] as const) {
      const found = findInvisible(`two${String.fromCodePoint(cp)}words`);
      expect(found, `${asCodepoint(cp)} is rejected`).toContain(`${asCodepoint(cp)} ${name} at line 1, column 4`);
      expect(found, `${asCodepoint(cp)} names its alternative`).toContain(alternative);
    }
  });

  it('allows U+3000 IDEOGRAPHIC SPACE, which is the point of the split (NEWS-418)', () => {
    // The one member of the family that is *not* rejected, pinned so a later
    // widening to "anything with the White_Space property" fails here rather than in
    // whichever file first writes a Japanese sentence properly. FR-35.2 ships a
    // location field designed to hold any script and refuses to normalise it, so CJK
    // is a feature of this app rather than a hypothetical: `東京` is already the
    // placeholder a user reads in `src/client/onboarding-view.tsx`.
    expect(findInvisible(`\u{6771}\u{4eac}${IDEOSP}\u{306e}\u{30cb}\u{30e5}\u{30fc}\u{30b9}\n`)).toBeNull();
    // And it is rejected nowhere else either — no accidental coverage via a range.
    expect(findInvisible(`a${IDEOSP}b`)).toBeNull();
    // Its narrow-space neighbours are still caught in the same sentence, so the
    // allowance is for this codepoint and not for "spaces near CJK".
    expect(findInvisible(`\u{6771}\u{4eac}${THINSP}\u{306e}\n`)).toContain('U+2009 THIN SPACE');
  });

  it('leaves an ordinary space and hyphen alone', () => {
    // The pair the two rules above are distinguished from, asserted so that a
    // careless widening — matching on "space-like" or "hyphen-like" — fails here
    // rather than in every file in the tree.
    expect(findInvisible('a plain space and a real-hyphen\n')).toBeNull();
  });

  it('catches mojibake that both guards would otherwise pass (NEWS-414)', () => {
    // The actual gap. 0xff is not a legal UTF-8 byte anywhere; `readFileSync` does
    // not throw on it, it *substitutes*. So the file decodes, holds no control byte
    // for `control-bytes.test.ts` and no bidi character for this scan, and used to
    // pass both while being corrupt. Built through a real Buffer decode rather than
    // by writing U+FFFD directly, because the substitution is the thing under test.
    const decoded = Buffer.from([0x63, 0x6f, 0x6e, 0x73, 0x74, 0x20, 0x78, 0x20, 0x3d, 0x20, 0xff, 0x3b, 0x0a]).toString(
      'utf8',
    );
    expect(decoded).toContain(FFFD);
    expect(findInvisible(decoded)).toBe(
      'U+FFFD REPLACEMENT CHARACTER at line 1, column 11 — mojibake: either invalid UTF-8 that `readFileSync(…, "utf8")` silently substituted for, or already-broken text committed as-is. Either way the file is no longer the text it appears to be, and the original bytes are gone. Context: const x = <U+FFFD>;\\n',
    );
  });

  it('catches a U+FFFD that was committed already encoded (NEWS-414)', () => {
    // The other way it arrives: someone pastes text that was mangled upstream, so
    // the bytes on disk are a valid EF BF BD and nothing is invalid about the file
    // at all. Same defect, same rule — the guard does not try to tell them apart,
    // because the answer in both cases is "recover the original text".
    expect(Buffer.from(FFFD, 'utf8')).toEqual(Buffer.from([0xef, 0xbf, 0xbd]));
    expect(findInvisible(`title: "Caf${FFFD} closes"\n`)).toContain('U+FFFD REPLACEMENT CHARACTER at line 1, column 12');
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
