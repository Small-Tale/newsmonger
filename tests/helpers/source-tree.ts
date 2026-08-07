import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The set of files the text-hygiene guards scan (NEWS-403, NEWS-408, NEWS-409).
 *
 * Extracted here so `control-bytes.test.ts` (a byte-level scan) and
 * `invisible-characters.test.ts` (a decode-then-scan) walk **the same tree**. The
 * two tests deliberately guarantee different things and must not be merged, but a
 * file covered by one and not the other would be a hole nobody could see from
 * either file.
 *
 * The other members of this family — `sandboxable.test.ts` and
 * `windows-portability.test.ts` — keep their own walks on purpose: they are scoped
 * differently and filter to source extensions. Only these two want an identical set.
 */

const SELF = fileURLToPath(import.meta.url);

/** The repository root, two levels up from `tests/helpers/`. */
export const repoRoot = path.join(path.dirname(SELF), '../..');

/**
 * An absolute path as a repo-relative one with `/` separators, on every platform.
 *
 * `path.relative` returns the platform separator, so on Windows it hands back
 * `src\routes\api.ts` — and every repo-relative path *written down* in this repo
 * uses `/`: `MUST_BE_SCANNED`, `SKIPPED_PATHS`, the allow-lists in the sibling
 * guards. Comparing the two silently fails on Windows and only on Windows
 * (NEWS-419), which for these guards means the "is scanned" checks — the ones that
 * exist so a broken walk cannot pass silently — would themselves be the thing that
 * broke.
 *
 * It is a function rather than an idiom repeated at each call site because it *was*
 * an idiom repeated at each call site: two of the four places that needed it had it
 * and two did not, and nothing could tell them apart by reading.
 */
export function repoRelative(file: string): string {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

/**
 * Extensions whose files are *supposed* to contain bytes that are not text.
 *
 * Excluded **by extension, deliberately**, rather than by "skip whatever fails to
 * decode" — a decode-failure skip would exempt the next mangled source file for
 * the same reason it exempts a PNG, which is the bug these tests exist to catch.
 *
 * Nothing git-tracked under `src/`, `tests/` or `scripts/` matches any of these
 * today; the only binaries on disk are captured stills and a demo SQLite file
 * under the gitignored `scripts/demo/.debug/` and `.review/`, already skipped with
 * the other dot-directories. The list is here so that a legitimate binary fixture
 * arriving later is excluded on purpose, in one named place, instead of by a
 * mechanism that would also excuse a broken `.ts`.
 *
 * `src-tauri/` (NEWS-412) contributes the app icons, and every extension they use —
 * `.png`, `.ico`, `.icns` — was already on the list. The native-code extensions
 * below are not in the tree at all; they are listed for the same reason as `.zip`
 * and `.mp4`, so that the day one appears the exclusion is a decision somebody made
 * rather than a decode failure nobody noticed.
 */
export const BINARY_EXTENSIONS = new Set([
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
  // Native code (NEWS-412). A Rust/Tauri tree can grow these outside `target/` —
  // a bundled `.dylib`, a prebuilt `.node` addon, the Windows pair.
  '.dylib',
  '.so',
  '.dll',
  '.exe',
  '.node',
  '.rlib',
]);

/**
 * Build outputs that an extension cannot describe, skipped by repo-relative path.
 *
 * Both are gitignored `src-tauri/` artifacts (NEWS-412). `server/` is the bundled
 * Node sidecar — `cli.js`, the client bundle and a whole `node_modules` — and
 * `binaries/` holds the sidecar executables themselves, which are **Mach-O and ELF
 * files with no extension at all**. That is the case `BINARY_EXTENSIONS` cannot
 * express, and it is not an argument for a decode-failure skip: these are excluded
 * because of *where* they are, not because of what happens when you read them, so
 * a mangled `.rs` two directories away is still caught.
 *
 * Matched by path rather than by directory name on purpose. The names are generic —
 * a future `src/server/` is entirely plausible — and a bare `server` in the skip
 * set would silently take it too, which is exactly the kind of quiet hole these
 * guards exist to close.
 */
export const SKIPPED_PATHS = new Set(['src-tauri/binaries', 'src-tauri/server']);

/**
 * Every file under the source roots, found by walking rather than by list.
 *
 * A hand-kept list is how `real-providers.spec.ts` kept its `npx tsx` through
 * NEWS-356: the rule was right, the file was simply not enumerated. A walk cannot
 * go stale — a new file is covered the moment it exists, and opting out takes a
 * deliberate edit here.
 *
 * Unlike the two sibling guards this walk is **not** filtered to source
 * extensions. A stray control byte or bidi override is a defect in a `.json`
 * fixture, a `.sh` gate script or a `.scss` stylesheet just as much as in a `.ts`,
 * and the point is to catch the file nobody thought to include.
 *
 * Dot-directories are skipped along with the build outputs: under these roots they
 * are gitignored local artifacts — captured demo stills, a scratch SQLite db,
 * agent working dirs — and nothing tracked lives in one.
 *
 * Root-level prose and config are included too (NEWS-409). `docs/` earns its place
 * for a sharper reason than the code roots: this project *greps its own docs* as a
 * workflow step — CLAUDE.md says to "grep for what is taken rather than reading
 * the last bullet" when allocating an FR id, and `build-requirements-summary.mjs`
 * parses every one. A requirements doc that silently vanished from search would
 * break id allocation while looking fine, and NEWS-302 already records what a
 * collision costs: six ids naming two requirements each.
 *
 * `src-tauri/` was added by NEWS-412, and it is the root that needed a guard most
 * rather than least. A `.rs` file hides a NUL exactly as well as a `.ts` file does,
 * and the Rust gates **path-gate themselves** (NEWS-294): `scripts/rust-changed.sh`
 * skips fmt, both clippy profiles and `cargo test` when nothing under `src-tauri/`
 * differs, so those files get *less* routine scrutiny than everything else here,
 * not more. `sandboxable.test.ts` already walked `src-tauri/src`, so the precedent
 * for reaching into it was set; this walk goes wider, taking `Cargo.toml`,
 * `tauri.conf.json`, the generated ACL schemas and `loading/index.html` with it.
 */
export function sourceFiles(): string[] {
  const skip = new Set(['node_modules', 'dist', 'target', 'coverage', 'test-results', 'playwright-report']);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (SKIPPED_PATHS.has(repoRelative(full))) continue;
      if (entry.isDirectory()) walk(full);
      else if (!BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(full);
    }
  };
  // `src-tauri/target` is caught by the `target` name above, with the other build
  // outputs; its two gitignored siblings need `SKIPPED_PATHS`.
  for (const sub of ['src', 'tests', 'scripts', 'docs', 'src-tauri']) walk(path.join(repoRoot, sub));
  for (const file of fs.readdirSync(repoRoot, { withFileTypes: true })) {
    if (!file.isFile() || file.name.startsWith('.')) continue;
    if (['.md', '.json', '.yml', '.yaml'].includes(path.extname(file.name).toLowerCase())) {
      out.push(path.join(repoRoot, file.name));
    }
  }
  return out.sort();
}

/**
 * The files every scan of this tree must be seen to reach, plus the floor the
 * count must clear.
 *
 * The failure mode of a scan-based test is to match nothing, assert nothing and
 * stay green forever, so both guards check the walk before trusting its result.
 * Shared so the two cannot drift into checking different things.
 *
 * Written with `/` separators, so a walk's output must go through `repoRelative`
 * before it is compared against these — see that function for what it cost not to.
 */
export const MUST_BE_SCANNED = [
  'src/routes/api.ts',
  'tests/e2e/server.ts',
  'scripts/e2e-scramble.mjs',
  'src/client/styles.scss',
  'docs/22-topic-categories.md',
  // One entry per walked root, because the count below cannot police the small
  // ones: `src-tauri` contributes 13 files of ~346, so losing it whole would not
  // move the floor at all (NEWS-412). A named file is the only thing that notices.
  'src-tauri/src/lib.rs',
  'CLAUDE.md',
  'package.json',
];

/**
 * A floor under the ~346 files the walk finds today, set high enough to notice a
 * root going missing.
 *
 * It was 100 against ~330, which is a tripwire for a walk that broke *entirely* and
 * nothing else. At 250, losing `src/` (95 files) or `tests/` (162) trips it. The
 * smaller roots are `MUST_BE_SCANNED`'s job — the two checks are deliberately
 * different instruments, and neither covers the other.
 */
export const MIN_SCANNED_FILES = 250;
