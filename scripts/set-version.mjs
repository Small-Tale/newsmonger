#!/usr/bin/env node
/**
 * Write one version into every file that states it (NEWS-194).
 *
 * Usage: node scripts/set-version.mjs 0.2.0
 *
 * `npm version --no-git-tag-version` covers package.json and package-lock.json.
 * This covers the three it doesn't, and exists as a script rather than inline
 * `sed` in the release flows because **both** `release.sh` and
 * `release-beta-auto.sh` need it, and a version written to two of three files is
 * a worse outcome than not writing it at all: the release workflow's guard only
 * compares the tag against package.json and tauri.conf.json, so a stale
 * Cargo.toml would sail past it and ship a bundle whose Rust crate disagrees
 * with its own bundle version.
 *
 * Cargo.lock is included deliberately. It records the workspace package's own
 * version, so bumping only Cargo.toml leaves the lockfile stale — `cargo build`
 * silently rewrites it, which turns every release into a commit with an
 * unexplained lockfile change, and would hard-fail any future `--locked` build.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const version = process.argv[2];
if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Usage: node scripts/set-version.mjs X.Y.Z  (got: ${version ?? '<nothing>'})`);
  console.error('Prerelease suffixes belong on the git tag, not in these files — macOS bundle');
  console.error('version fields reject them.');
  process.exit(1);
}

/** Read, transform, write — reporting whether anything actually changed. */
function edit(rel, transform) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return `${rel}: absent, skipped`;
  const before = fs.readFileSync(full, 'utf8');
  const after = transform(before);
  if (after === null) return `${rel}: NO MATCH — check this file by hand`;
  if (after === before) return `${rel}: already ${version}`;
  fs.writeFileSync(full, after);
  return `${rel}: -> ${version}`;
}

const results = [];

results.push(
  edit('src-tauri/tauri.conf.json', (src) => {
    const conf = JSON.parse(src);
    conf.version = version;
    return `${JSON.stringify(conf, null, 2)}\n`;
  }),
);

results.push(
  edit('src-tauri/Cargo.toml', (src) => {
    // Anchored to the first `version =` in the file, which is `[package]`'s.
    // A bare global replace would also rewrite every dependency's version
    // pin — `tauri = { version = "2" }` and friends.
    const out = src.replace(/^version = "[^"]*"$/m, `version = "${version}"`);
    return out === src && !src.includes(`version = "${version}"`) ? null : out;
  }),
);

results.push(
  edit('src-tauri/Cargo.lock', (src) => {
    // Only the `newsmonger` package's own block. Matching on the name first is
    // what keeps this from touching the ~400 other `[[package]]` entries, any
    // one of which having version "0.1.0" would otherwise be a candidate.
    const re = /(\[\[package\]\]\nname = "newsmonger"\nversion = ")[^"]*(")/;
    if (!re.test(src)) return null;
    return src.replace(re, `$1${version}$2`);
  }),
);

for (const line of results) console.log(`    ${line}`);
if (results.some((r) => r.includes('NO MATCH'))) process.exit(1);
