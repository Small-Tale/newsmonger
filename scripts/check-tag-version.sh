#!/usr/bin/env bash
#
# The tag and the version files must agree (NEWS-208).
#
# Nothing else links them. The tag is the only statement of the release version;
# the bundle takes its version from `tauri.conf.json` and the npm package from
# `package.json`. Tag `v0.2.0` against a `0.1.0` config and the build succeeds,
# the release page looks right, and every asset is named `0.1.0` — with the
# generated download links pointing at filenames that do not exist.
#
# The old `release.yml` guarded this. NEWS-201 replaced that file and the port
# dropped the guard; this restores it as a script so both workflows share one
# implementation rather than two drifting copies.
#
# Only the **base** version is compared. The `-rc.N` / `-beta.N` suffix lives on
# the tag and never in the files: `release.sh` writes the clean `X.Y.Z` in the
# tree for *both* channels (see note 4 in its header), and CI writes the full
# suffixed version at build time (NEWS-207).
#
# Usage:
#   bash scripts/check-tag-version.sh              # reads $GITHUB_REF
#   bash scripts/check-tag-version.sh v0.2.0-beta.1
set -uo pipefail
cd "$(dirname "$0")/.."

raw="${1:-${GITHUB_REF:-}}"
# Accept a bare tag or a full ref, so it works from a workflow and by hand.
tag="${raw#refs/tags/}"
tag="${tag#v}"

if [ -z "$tag" ]; then
  echo "check-tag-version: no tag given and GITHUB_REF is unset — nothing to check" >&2
  exit 2
fi

base="${tag%%-*}"
conf="$(node -p "require('./src-tauri/tauri.conf.json').version")"
pkg="$(node -p "require('./package.json').version")"

echo "tag=$tag base=$base tauri.conf.json=$conf package.json=$pkg"

fail=0
if [ "$base" != "$conf" ]; then
  echo "::error::Tag base version '$base' does not match tauri.conf.json ($conf)."
  fail=1
fi
if [ "$base" != "$pkg" ]; then
  echo "::error::Tag base version '$base' does not match package.json ($pkg)."
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "The tag is the only statement of the release version, and the bundles take" >&2
  echo "theirs from these files. Publishing them mismatched ships assets named after" >&2
  echo "the wrong version, with download links pointing at filenames that do not exist." >&2
  echo "" >&2
  echo "Cut releases with 'npm run release' — it writes both files and tags the same" >&2
  echo "commit, so they cannot disagree. A hand-cut tag is the case this catches." >&2
  exit 1
fi

echo "Tag and version files agree on $base."
