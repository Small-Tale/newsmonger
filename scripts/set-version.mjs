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

/**
 * A prerelease suffix is **accepted** (NEWS-207), and the reason is measured.
 *
 * NEWS-196 recorded that "macOS bundle version fields reject them" and wrote the
 * *base* version into the Tauri/Cargo files for betas. That inherited claim is
 * wrong. Built locally with `0.2.0-beta.1`: `cargo` compiles it, the bundler
 * produces `Newsmonger.app` and `Newsmonger_0.2.0-beta.1_aarch64.dmg`, both
 * `CFBundleShortVersionString` and `CFBundleVersion` read `0.2.0-beta.1`, and the
 * app launches with Launch Services reporting `Version="0.2.0-beta.1"`.
 *
 * It mattered because the Tauri updater compares versions: with the base version
 * in the bundle, `v0.2.0-beta.1` and `v0.2.0-beta.2` both reported `0.2.0`, so an
 * installed beta could never see the next one — most of the point of a beta.
 *
 * The one real constraint is elsewhere and already handled: the **Windows MSI**
 * bundler requires a numeric-only pre-release identifier, so betas build the NSIS
 * `.exe` only (`--bundles nsis` in `release-candidate.yml`). That is a bundler
 * flag, not a reason to lie about the version in the file.
 */
const version = process.argv[2];
if (version === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(version)) {
  console.error(`Usage: node scripts/set-version.mjs X.Y.Z[-prerelease]  (got: ${version ?? '<nothing>'})`);
  console.error('A prerelease suffix is allowed (0.2.0-beta.1); build metadata (+build) is not.');
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
    //
    // `\r?$` rather than `$`: see the Cargo.lock note below.
    const out = src.replace(/^version = "[^"]*"(\r?)$/m, `version = "${version}"$1`);
    return out === src && !src.includes(`version = "${version}"`) ? null : out;
  }),
);

results.push(
  edit('src-tauri/Cargo.lock', (src) => {
    // Only the `newsmonger` package's own block. Matching on the name first is
    // what keeps this from touching the ~400 other `[[package]]` entries, any
    // one of which having version "0.1.0" would otherwise be a candidate.
    //
    // **`\r?\n`, not `\n`** (NEWS-213). Git for Windows checks out with CRLF by
    // default, so on a Windows runner this file arrives with `\r\n` line endings
    // and an `\n`-only pattern silently fails to match. The failure mode is
    // nasty: `edit()` reports "NO MATCH" and the script exits 1, which killed the
    // signed Windows release build *after* the tag was already public. macOS and
    // Linux never see it, so nothing local reproduces it.
    const re = /(\[\[package\]\]\r?\nname = "newsmonger"\r?\nversion = ")[^"]*(")/;
    if (!re.test(src)) return null;
    return src.replace(re, `$1${version}$2`);
  }),
);

for (const line of results) console.log(`    ${line}`);
if (results.some((r) => r.includes('NO MATCH'))) process.exit(1);
