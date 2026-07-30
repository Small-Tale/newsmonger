#!/usr/bin/env node
/**
 * Prepend a release entry to CHANGELOG.md (NEWS-194).
 *
 * Usage: node scripts/add-changelog-entry.mjs <version> <<'NOTES'
 *        - a bullet
 *        NOTES
 *
 * Notes come in on **stdin**, not argv: they are multi-line markdown that may
 * contain quotes, backticks and `$`, and threading that through a shell argument
 * is how you get a mangled changelog.
 *
 * A file rather than an inline `node -e` in the two release scripts, which is
 * where this started. That duplication is precisely how it shipped broken: both
 * copies used a bare `return` to early-exit, which is a SyntaxError at the top
 * level of `node -e` ("Illegal return statement"), and the dry run failed *after*
 * writing the version files. One tested file instead of two untested copies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'CHANGELOG.md');

const args = process.argv.slice(2);
const replace = args.includes('--replace');
const version = args.find((a) => !a.startsWith('--'));

// Prerelease suffixes are ACCEPTED here, unlike `set-version.mjs` which rejects
// them (NEWS-196). The two have different jobs: the version *files* cannot carry a
// `-beta.N` suffix because macOS bundle version fields reject it, but the changelog
// is history, and every beta is its own release with its own notes. Giving
// `0.1.0-beta.2` its own heading is both truer and the thing that stops the second
// beta of any version colliding with the first.
if (version === undefined || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(
    `Usage: node scripts/add-changelog-entry.mjs X.Y.Z[-beta.N] [--replace] < notes.md  (got: ${version ?? '<nothing>'})`,
  );
  process.exit(1);
}

const notes = fs.readFileSync(0, 'utf8').replace(/\s+$/, '');
if (notes === '') {
  console.error('Refusing to write an empty changelog entry — pass the notes on stdin.');
  process.exit(1);
}

// Date in the caller's local timezone, matching what a human would call "today".
const stamp = new Date().toLocaleDateString('en-CA'); // en-CA renders as YYYY-MM-DD
const entry = `## [${version}] - ${stamp}\n\n${notes}\n`;

if (!fs.existsSync(file)) {
  fs.writeFileSync(file, `# Changelog\n\n${entry}`);
  console.log(`    CHANGELOG.md created with ${version}`);
  process.exit(0);
}

const current = fs.readFileSync(file, 'utf8');

// An existing heading for this exact version (NEWS-196).
//
// The release run that hit this failed in CI *after* the local script had already
// committed the bump and the entry, so the natural recovery — re-run — would have
// prepended a second `## [0.1.0]`. Erroring by default rather than replacing
// silently: rewriting the notes of a version that has already shipped is worse
// than a duplicate, and the caller knows which situation it is in.
const heading = new RegExp(`^## \\[${version.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}] - `, 'm');
const existing = heading.exec(current);

if (existing !== null && !replace) {
  console.error(`CHANGELOG.md already has an entry for ${version}.`);
  console.error('  Re-running a release for the same version? Pass --replace to overwrite it.');
  console.error('  Cutting a new release? Bump the version instead.');
  process.exit(1);
}

let next;
if (existing !== null) {
  // Replace just this section: from its heading up to the next `## [` or EOF. An
  // off-by-one here would silently delete the release below it.
  const start = existing.index;
  const bodyStart = start + existing[0].length;
  const nextHeading = current.slice(bodyStart).search(/\n## \[/);
  const end = nextHeading === -1 ? current.length : bodyStart + nextHeading + 1;
  next = current.slice(0, start) + entry + current.slice(end);
  console.log(`    CHANGELOG.md entry for ${version} replaced`);
} else {
  // Insert above the newest existing entry so the file stays newest-first.
  // Appending would silently invert the order, which nobody notices until the
  // changelog is read from the top and describes the oldest release.
  const firstEntry = current.indexOf('\n## [');
  next =
    firstEntry === -1
      ? `${current.replace(/\n+$/, '')}\n\n${entry}`
      : `${current.slice(0, firstEntry)}\n${entry}${current.slice(firstEntry)}`;
  console.log(`    CHANGELOG.md updated with ${version}`);
}
fs.writeFileSync(file, next);
