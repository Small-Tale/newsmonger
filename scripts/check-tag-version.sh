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
# `--stable-only` additionally refuses any tag carrying a prerelease suffix
# (NEWS-222). `release-desktop.yml` publishes with `prerelease: false` and
# `make_latest: true`, and its tag filter is `v[0-9]*` minus `!v*-rc.*` and
# `!v*-beta.*` — so a suffix that is neither, like `v0.3.0-alpha.1` or a mistyped
# `v0.3.0-rc1`, falls through to the **stable** path and flips `releases/latest`.
# The updater reads `releases/latest`, so that ships an untested build to every
# installed user. The old `release.yml` derived the prerelease flag from the tag
# (`case "$tag" in *-*)`), which was robust to exactly this typo; the glob split
# lost that.
#
# Refusing loudly rather than tightening the trigger to `!v*-*`: an excluded tag
# would trigger *nothing at all*, and a push that silently does nothing is the
# same class of problem this exists to remove.
#
# Usage:
#   bash scripts/check-tag-version.sh                          # reads $GITHUB_REF
#   bash scripts/check-tag-version.sh v0.2.0-beta.1
#   bash scripts/check-tag-version.sh --stable-only v0.2.0
set -uo pipefail
cd "$(dirname "$0")/.."

stable_only=false
raw=""
for arg in "$@"; do
  case "$arg" in
    --stable-only) stable_only=true ;;
    *) [ -z "$raw" ] && raw="$arg" ;;
  esac
done
raw="${raw:-${GITHUB_REF:-}}"
# Accept a bare tag or a full ref, so it works from a workflow and by hand.
tag="${raw#refs/tags/}"
tag="${tag#v}"

if [ -z "$tag" ]; then
  echo "check-tag-version: no tag given and GITHUB_REF is unset — nothing to check" >&2
  exit 2
fi

base="${tag%%-*}"

if [ "$stable_only" = true ] && [ "$base" != "$tag" ]; then
  echo "::error::'v$tag' carries a prerelease suffix, but this workflow publishes stable releases (prerelease: false, make_latest: true)."
  echo "" >&2
  echo "Prerelease tags belong to release-candidate.yml, which claims 'v*-rc.*' and" >&2
  echo "'v*-beta.*' exactly. A suffix matching neither — '-alpha.1', or '-rc1' with the" >&2
  echo "dot missing — reaches this workflow instead and would be published as stable," >&2
  echo "flipping releases/latest. The desktop updater reads releases/latest, so that" >&2
  echo "ships this build to everyone who has the app installed." >&2
  echo "" >&2
  echo "Cut prereleases with 'npm run release:beta' so the shape is never in doubt." >&2
  exit 1
fi

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
