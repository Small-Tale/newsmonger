import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BINARY_EXTENSIONS,
  MIN_SCANNED_FILES,
  MUST_BE_SCANNED,
  repoRoot as root,
  sourceFiles,
} from '../helpers/source-tree.js';

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
 * appear in text. This scan stays **byte-level on purpose**: it is the one that
 * answers "would grep skip this file?", and a decoded scan cannot answer that.
 *
 * The rest of the invisible-character family — C1 (U+0080–U+009F), the Unicode
 * line separators, a mid-file BOM, and the zero-width and bidi-override
 * characters of Trojan Source — is multi-byte in UTF-8, so none of it trips a
 * binary heuristic and none of it belongs here. It is caught by
 * `invisible-characters.test.ts` (NEWS-408), which decodes first and then scans.
 * The two share `tests/helpers/source-tree.ts` so they cover the same files, and
 * stay separate so each keeps a guarantee you can state in one sentence.
 *
 * The walk reaches `src-tauri/` as of NEWS-412. A `.rs` file can hide a NUL as
 * easily as a `.ts` one, and the Rust gates path-gate themselves (NEWS-294), so
 * those files see *less* routine tooling than the rest of the tree.
 */

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
    expect(files.length).toBeGreaterThan(MIN_SCANNED_FILES);
    for (const required of MUST_BE_SCANNED) {
      expect(files.map((f) => path.relative(root, f)), `${required} is scanned`).toContain(required);
    }
  });

  it('finds none under src/, tests/, scripts/, docs/ or src-tauri/', () => {
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
    // Rust arrives with `src-tauri/` (NEWS-412), alongside `.toml` and `.plist`.
    expect(files).toContain('.rs');
  });

  it('excludes the two src-tauri build outputs by path (NEWS-412)', () => {
    // `src-tauri/server/` is a bundled Node sidecar with its own `node_modules`;
    // `src-tauri/binaries/` holds Mach-O and ELF executables with *no extension*,
    // which is the case `BINARY_EXTENSIONS` cannot express. Both are gitignored, so
    // this assertion is vacuous in a fresh clone and load-bearing in any checkout
    // that has run `npm run tauri:dev` — which is the checkout it needs to hold in.
    const scanned = sourceFiles().map((f) => path.relative(root, f).split(path.sep).join('/'));
    expect(scanned.filter((f) => f.startsWith('src-tauri/server/') || f.startsWith('src-tauri/binaries/'))).toEqual([]);
    expect(scanned).toContain('src-tauri/tauri.conf.json');
  });
});
