#!/usr/bin/env bash
#
# Does the local change touch Rust? (NEWS-294)
#
# **Why this exists.** `scripts/gates-rust.sh` runs `cargo fmt`, clippy in *both*
# profiles and `cargo test`. The release profile is the expensive one and it earns
# its place — the updater commands are `#[cfg(not(debug_assertions))]`, so a
# debug-only clippy never compiles their bodies (NEWS-89). None of it can say
# anything about a TypeScript-only change, and that is the large majority of
# commits.
#
# **Why it errs toward running.** The scar this must not reopen: `test:all` once
# passed green with a `cargo fmt --check` violation in `src-tauri/src/lib.rs` and
# main was red for two commits, because nothing named the formatter. A needless
# Rust run costs about a minute. A needless *skip* costs a red main and the hour
# spent finding out why. So every uncertainty here resolves to "run them":
# no git, a failing `git status`, an unreadable diff — all exit 0.
#
# **What "the local change" means.** Uncommitted work *and* commits not yet on the
# upstream branch. The second half matters: those commits' own gate runs may
# themselves have skipped Rust, so they are part of the unverified change until
# they are published. With no upstream to compare against, only uncommitted work
# can be examined, and the script says so rather than implying more.
#
# Exit 0 -> Rust may be affected (or it cannot tell): run the gates.
# Exit 1 -> nothing Rust-adjacent differs: the caller may skip them.
#
# Usage: bash scripts/rust-changed.sh
#
# bash 3.2 must be enough (macOS default); gated by tests/unit/release-scripts.test.ts.
#
# Deliberately no `set -e`: this script's whole job is to inspect commands that
# are allowed to fail, and decide what their failure means.
set -uo pipefail
cd "$(dirname "$0")/.."

# Anything whose change could alter what fmt/clippy/test say. Generous on purpose
# — see "errs toward running" above. `src-tauri/binaries` and `src-tauri/server`
# are gitignored, so the broad `src-tauri/` prefix costs nothing.
RUST_PATHS='src-tauri/|scripts/gates-rust\.sh|scripts/rust-changed\.sh|scripts/ensure-sidecar-stub\.sh|scripts/build-sidecar\.sh|scripts/tauri-build-local\.sh'

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "   rust-changed: not a git checkout, so nothing can be compared — assuming Rust changed."
  exit 0
fi

if ! status=$(git status --porcelain 2>/dev/null); then
  echo "   rust-changed: 'git status' failed, so nothing can be compared — assuming Rust changed."
  exit 0
fi

# Piped from a variable rather than straight from git: under `pipefail` a `grep -q`
# that closes the pipe early can make the upstream command look like it failed.
if printf '%s\n' "$status" | grep -Eq "$RUST_PATHS"; then
  echo "   rust-changed: uncommitted work touches Rust —"
  printf '%s\n' "$status" | grep -E "$RUST_PATHS" | sed 's/^/     /'
  exit 0
fi

upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null)
if [ -n "$upstream" ]; then
  base=$(git merge-base HEAD "$upstream" 2>/dev/null)
  if [ -n "$base" ]; then
    committed=$(git diff --name-only "$base" HEAD 2>/dev/null)
    if printf '%s\n' "$committed" | grep -Eq "$RUST_PATHS"; then
      echo "   rust-changed: commits not yet on ${upstream} touch Rust —"
      printf '%s\n' "$committed" | grep -E "$RUST_PATHS" | sed 's/^/     /'
      exit 0
    fi
    echo "   rust-changed: nothing under src-tauri/ (nor a Rust-adjacent script) differs from ${upstream}."
    exit 1
  fi
fi

echo "   rust-changed: no upstream branch to compare against, so only uncommitted work was examined — and none of it is Rust."
echo "   rust-changed: that takes it on trust that the commits already made were gated. CI runs the Rust job regardless."
exit 1
