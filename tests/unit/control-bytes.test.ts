import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * No source file may carry a raw control byte (NEWS-403).
 *
 * `src/routes/api.ts` — ~920 lines, every API route the app serves — contained a
 * literal `0x00` inside the template literal building a cache key. One byte, and
 * the whole file went dark:
 *
 * - `grep`/`ripgrep` classify a file with a NUL as binary and **skip it silently**
 *   unless forced with `-a`/`--text`. `grep -c hono src/routes/api.ts` found
 *   nothing; `grep -ac` found it. A search that returns no hits reads as "this
 *   does not exist here", so NEWS-397 concluded there was no manual
 *   classification path in the app. There is, and it is in that file.
 * - `file` reported it as `data` rather than as source.
 * - Every grep-based rule guard in this repo — the family this test belongs to,
 *   `sandboxable.test.ts` and `windows-portability.test.ts` — reads files it
 *   walks with `fs.readFileSync`, so those two were unaffected. But anything
 *   shelling out to grep, and every tool downstream that does, was exempting the
 *   file without saying so.
 * - It broke UTF-8 boundaries outside the repo: filing the ticket for this failed
 *   because the Hot Sheet API rejected the byte in the request body.
 *
 * The fix was `\0`, the two-character escape, whose runtime value is identical —
 * so nothing about the program changed and nothing about the program could have
 * caught it. That is the whole reason for a scan: **the failure is invisible on
 * the machine that introduces it**, exactly as with the tsx CLI and the Windows
 * spawns. An editor renders a NUL as nothing at all, tests stay green, and the
 * cost lands weeks later on whoever greps.
 *
 * Scope is the C0 range plus DEL — the bytes that make a file "binary" to the
 * tools above. Tab, newline and carriage return are the three that legitimately
 * appear in text. C1 (U+0080–U+009F) and the Unicode line separators are not
 * checked: they are multi-byte in UTF-8, do not trip the binary heuristics, and
 * would need a different (decode-then-scan) test to find.
 */

const SELF = fileURLToPath(import.meta.url);
const root = path.join(path.dirname(SELF), '../..');

/**
 * Extensions whose files are *supposed* to contain control bytes.
 *
 * Excluded **by extension, deliberately**, rather than by "skip whatever fails to
 * decode" — a decode-failure skip would exempt the next mangled source file for
 * the same reason it exempts a PNG, which is the bug this test exists to catch.
 *
 * Nothing git-tracked under `src/`, `tests/` or `scripts/` matches any of these
 * today; the only binaries on disk are captured stills and a demo SQLite file
 * under the gitignored `scripts/demo/.debug/` and `.review/`, already skipped
 * with the other dot-directories. The list is here so that a legitimate binary
 * fixture arriving later is excluded on purpose, in one named place, instead of
 * by a mechanism that would also excuse a broken `.ts`.
 */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.icns',
  '.db',
  '.sqlite',
  '.zip',
  '.gz',
  '.tgz',
  '.tar',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.pdf',
  '.mp3',
  '.mp4',
  '.mov',
  '.webm',
  // Design sources under `docs/graphics/` (NEWS-409). Both are binary container
  // formats — a Rhino model and a Sketch document — and both tripped the scan the
  // moment `docs/` was added. Listed explicitly rather than skipping whatever
  // fails to decode, for the reason the whole list exists: a decode-failure skip
  // would exempt the next mangled `.md` too.
  '.3dm',
  '.sketch',
]);

/**
 * Every file under the source roots, found by walking rather than by list.
 *
 * A hand-kept list is how `real-providers.spec.ts` kept its `npx tsx` through
 * NEWS-356: the rule was right, the file was simply not enumerated. A walk cannot
 * go stale — a new file is covered the moment it exists, and opting out takes a
 * deliberate edit here.
 *
 * Unlike its two siblings this walk is **not** filtered to source extensions. A
 * control byte is a defect in a `.json` fixture, a `.sh` gate script or a `.scss`
 * stylesheet just as much as in a `.ts`, and the point is to catch the file
 * nobody thought to include.
 *
 * Dot-directories are skipped along with the build outputs: under these roots
 * they are gitignored local artifacts — captured demo stills, a scratch SQLite
 * db, agent working dirs — and nothing tracked lives in one.
 */
function sourceFiles(): string[] {
  const skip = new Set(['node_modules', 'dist', 'target', 'coverage', 'test-results', 'playwright-report']);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(full);
    }
  };
  for (const sub of ['src', 'tests', 'scripts', 'docs']) walk(path.join(root, sub));
  // Root-level prose and config too (NEWS-409). `docs/` earns its place for a
  // sharper reason than the code roots: this project *greps its own docs* as a
  // workflow step — CLAUDE.md says to "grep for what is taken rather than
  // reading the last bullet" when allocating an FR id, and
  // `build-requirements-summary.mjs` parses every one. A requirements doc that
  // silently vanished from search would break id allocation while looking fine,
  // and NEWS-302 already records what a collision costs: six ids naming two
  // requirements each.
  for (const file of fs.readdirSync(root, { withFileTypes: true })) {
    if (!file.isFile() || file.name.startsWith('.')) continue;
    if (['.md', '.json', '.yml', '.yaml'].includes(path.extname(file.name).toLowerCase())) {
      out.push(path.join(root, file.name));
    }
  }
  return out.sort();
}

/** A C0 control byte other than tab (0x09), newline (0x0a) or CR (0x0d), or DEL (0x7f). */
function isForbidden(byte: number): boolean {
  return (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f;
}

/**
 * The first forbidden byte in `buf`, described well enough to go and fix it.
 *
 * "control byte found" would send the next person hunting through a file their
 * editor renders as clean, so this reports the byte value, its absolute offset,
 * and the 1-based line and column — the offset because that is what a hex editor
 * and a `dd`/`node` one-liner take, the line because that is what everything else
 * takes.
 */
function findControlByte(buf: Buffer): string | null {
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    if (!isForbidden(byte)) continue;
    // `split` always yields at least one element, so the last one is the
    // partial line the byte sits on.
    const before = buf.subarray(0, i).toString('utf8').split('\n');
    const line = before.length;
    const column = before[line - 1].length + 1;
    const hex = `0x${byte.toString(16).padStart(2, '0')}`;
    return `byte ${hex} at offset ${i} (line ${line}, column ${column})`;
  }
  return null;
}

describe('no source file carries a raw control byte (NEWS-403)', () => {
  it('scans a plausible number of files, so a broken walk cannot pass silently', () => {
    // The failure mode of a scan-based test: match nothing, assert nothing, stay
    // green forever.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(100);
    for (const required of [
      'src/routes/api.ts',
      'tests/e2e/server.ts',
      'scripts/e2e-scramble.mjs',
      'src/client/styles.scss',
      'docs/22-topic-categories.md',
      'CLAUDE.md',
      'package.json',
    ]) {
      expect(files.map((f) => path.relative(root, f)), `${required} is scanned`).toContain(required);
    }
  });

  it('finds none under src/, tests/, scripts/ or docs/', () => {
    const offenders = sourceFiles().flatMap((file) => {
      const found = findControlByte(fs.readFileSync(file));
      return found === null ? [] : [`${path.relative(root, file)}: ${found} — use the escape sequence instead`];
    });
    expect(offenders).toEqual([]);
  });

  it('catches the exact byte NEWS-403 fixed', () => {
    // Pins the detector against the real defect. Built from a char code rather
    // than written literally, because a fixture holding a raw NUL would make this
    // file fail its own scan — and "delete the fixture" is the wrong fix.
    const wasBroken = Buffer.from(`  const attemptKey = \`\${dataDir}${String.fromCharCode(0)}\${hash}\`;\n`, 'utf8');
    expect(findControlByte(wasBroken)).toBe('byte 0x00 at offset 32 (line 1, column 33)');
  });

  it('accepts tab, newline, CR and multi-byte UTF-8', () => {
    // The em dash and the arrow are all over this repo's prose; a scan that read
    // bytes without thinking would be tempted to flag their continuation bytes,
    // which are all ≥ 0x80 and correctly out of range.
    expect(findControlByte(Buffer.from('a\tb\r\nc — d → e\n', 'utf8'))).toBeNull();
  });

  it('excludes binaries by extension, not by whether they decode', () => {
    // A PNG is skipped because it is a PNG. Nothing is skipped for being
    // unreadable, which is how a mangled source file would have slipped through.
    const files = sourceFiles().map((f) => path.extname(f).toLowerCase());
    expect(files.filter((ext) => BINARY_EXTENSIONS.has(ext))).toEqual([]);
    expect(files).toContain('.ts');
    expect(files).toContain('.json');
    expect(files).toContain('.sh');
  });
});
