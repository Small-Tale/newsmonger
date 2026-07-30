#!/usr/bin/env bash
#
# Create the bundle paths `tauri-build` insists exist, for Rust-only jobs (NEWS-201).
#
# `tauri-build` validates `bundle.externalBin` and `bundle.resources` inside its
# build script, so a plain `cargo clippy` fails before compiling anything:
#
#   resource path `binaries/newsmonger-node-x86_64-unknown-linux-gnu` doesn't exist
#
# Both paths are gitignored and produced by `scripts/build-sidecar.sh`, which only
# runs as Tauri's `beforeBuildCommand` — never under cargo. That is exactly why the
# Rust CI job had never passed (NEWS-191).
#
# **Stubs rather than the real thing, deliberately.** A lint/test job compile-checks
# Rust and never produces a bundle, and `tauri-build` only checks that the paths
# *exist*. Building the real sidecar would mean setup-node, a Node download, an
# `npm ci`, a server bundle and a nested `npm install` — minutes of work to satisfy
# an existence check. The release workflows build them for real, which is where it
# matters.
#
# Extracted from an inline `ci.yml` step once a second workflow needed it
# (release-candidate.yml). One copy: two hand-maintained lists of build paths is
# how the wordmark shipped broken (see tests/unit/client-assets.test.ts).
#
# Usage: bash scripts/ensure-sidecar-stub.sh [target-triple]
#
# Defaults to the host triple, which is what a lint job wants. Pass a triple to
# stub for a cross-compilation target.
#
# Safe to run when the real artifacts are already present — it never overwrites.
#
# bash 3.2 must be enough (macOS default); gated by tests/unit/release-scripts.test.ts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TRIPLE="${1:-$(rustc --print host-tuple)}"

if [ -z "$TRIPLE" ]; then
  echo "error: could not determine the target triple (is rustc on PATH?)" >&2
  exit 1
fi

mkdir -p src-tauri/binaries src-tauri/server

SIDECAR="src-tauri/binaries/newsmonger-node-${TRIPLE}"
if [ -e "$SIDECAR" ]; then
  echo "  sidecar already present, left alone: $SIDECAR"
else
  : > "$SIDECAR"
  chmod +x "$SIDECAR"
  echo "  stubbed $SIDECAR"
fi

# The `resources` entry is a `server/**/*` glob, so it needs at least one file —
# an empty directory does not satisfy it.
if [ -n "$(ls -A src-tauri/server 2>/dev/null)" ]; then
  echo "  server resources already present, left alone"
else
  echo "stub for cargo checks — see scripts/ensure-sidecar-stub.sh" > src-tauri/server/README
  echo "  stubbed src-tauri/server/README"
fi
