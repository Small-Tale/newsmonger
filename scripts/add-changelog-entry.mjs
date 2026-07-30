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

const version = process.argv[2];
if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Usage: node scripts/add-changelog-entry.mjs X.Y.Z < notes.md  (got: ${version ?? '<nothing>'})`);
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
} else {
  const current = fs.readFileSync(file, 'utf8');
  const firstEntry = current.indexOf('\n## [');
  // Insert above the newest existing entry so the file stays newest-first.
  // Appending would silently invert the order, which nobody notices until the
  // changelog is read from the top and describes the oldest release.
  const next =
    firstEntry === -1
      ? `${current.replace(/\n+$/, '')}\n\n${entry}`
      : `${current.slice(0, firstEntry)}\n${entry}${current.slice(firstEntry)}`;
  fs.writeFileSync(file, next);
  console.log(`    CHANGELOG.md updated with ${version}`);
}
