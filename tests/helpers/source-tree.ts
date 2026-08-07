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
 * differently (`src-tauri/src` matters to one, `docs/` to neither) and filter to
 * source extensions. Only these two want an identical set.
 */

const SELF = fileURLToPath(import.meta.url);

/** The repository root, two levels up from `tests/helpers/`. */
export const repoRoot = path.join(path.dirname(SELF), '../..');

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
]);

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
 */
export function sourceFiles(): string[] {
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
  for (const sub of ['src', 'tests', 'scripts', 'docs']) walk(path.join(repoRoot, sub));
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
 */
export const MUST_BE_SCANNED = [
  'src/routes/api.ts',
  'tests/e2e/server.ts',
  'scripts/e2e-scramble.mjs',
  'src/client/styles.scss',
  'docs/22-topic-categories.md',
  'CLAUDE.md',
  'package.json',
];

/** A floor well under the ~330 files the walk finds today, but far above zero. */
export const MIN_SCANNED_FILES = 100;
