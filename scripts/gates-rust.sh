#!/usr/bin/env bash
#
# The Rust gates, exactly as CI runs them.
#
# **Why this exists.** `npm run test:all` was typecheck + lint + unit + E2E and
# contained no Rust at all, while `ci.yml` has a whole Tauri job. So running "all
# the gates" locally passed with a `cargo fmt --check` violation sitting in
# `src-tauri/src/lib.rs`, and main went red for two commits before anyone looked
# at Actions. Clippy had been run by hand; the formatter had not, because nothing
# named it.
#
# Kept as one script called from `test-all.sh` rather than four lines inside it,
# so the local gate and the CI job can be asserted identical
# (tests/unit/release-scripts.test.ts) instead of drifting.
#
# Both clippy profiles run, and that is not redundant: the updater commands are
# `#[cfg(not(debug_assertions))]` (NEWS-89), so a debug-only clippy never compiles
# their bodies. That distinction cost a release run to learn.
#
# Skipped with a loud notice when there is no cargo — the JS gates should still be
# runnable on a machine without a Rust toolchain. Also skipped, just as loudly,
# when nothing Rust-adjacent has changed (NEWS-294; see scripts/rust-changed.sh).
#
# `RUST_GATES=required` overrides both: a missing toolchain becomes a failure, and
# the diff-based skip is disabled. `RUST_GATES=skip` still suppresses everything.
#
# bash 3.2 must be enough (macOS default); gated by tests/unit/release-scripts.test.ts.
set -euo pipefail
cd "$(dirname "$0")/.."

# Tell the caller what we decided, if it asked (NEWS-300).
#
# `test-all.sh` prints a per-phase summary, and a summary that says "rust: ran"
# when this script self-skipped would be the exact lie the summary exists to
# prevent. One word to a file the caller names — no coupling on our stdout, and
# nothing happens when the variable is unset.
rust_verdict() {
  if [ -n "${RUST_GATE_VERDICT_FILE:-}" ]; then
    printf '%s' "$1" > "$RUST_GATE_VERDICT_FILE"
  fi
}

# Explicit opt-out, for a CI job that has a *sibling* job doing this properly.
#
# `ci.yml` runs the Rust gates in a dedicated job that installs the webkit/glib
# dev headers the Tauri crate links against. The gate job (typecheck/lint/unit/
# E2E) has none of them, so compiling there fails with "The system library
# `glib-2.0` ... was not found" — which is exactly what happened when the Rust
# gates were first folded into `test:all` (NEWS-213 follow-on). Installing the
# headers twice to run the same checks twice is the wrong fix.
if [ "${RUST_GATES:-}" = "skip" ]; then
  echo "== rust gates SKIPPED (RUST_GATES=skip) =="
  echo "   Set by a caller that runs them elsewhere — ci.yml's dedicated rust job."
  rust_verdict "skipped (RUST_GATES=skip)"
  exit 0
fi

# Automatic skip when the change cannot affect Rust (NEWS-294).
#
# Both clippy profiles compiling the Tauri crate is minutes that a TypeScript-only
# change — most commits — buys nothing with. `scripts/rust-changed.sh` makes the
# call from the diff, and errs toward running: any uncertainty there exits 0.
#
# Three things stop this becoming the silent-skip failure mode that left main red
# for two commits:
#
#   * the notice below is loud, names what was compared, and says how to override;
#   * `RUST_GATES=required` runs them regardless of the diff;
#   * `CI` disables the skip outright. `ci.yml`'s rust job invokes cargo directly
#     rather than through this script, so CI's coverage never depended on this —
#     but a future CI job that *does* call it must not silently inherit a
#     local-iteration optimisation.
if [ "${RUST_GATES:-}" != "required" ] && [ -z "${CI:-}" ]; then
  if ! bash scripts/rust-changed.sh; then
    echo "== rust gates SKIPPED — this change cannot affect them =="
    echo "!! cargo fmt, clippy (debug), clippy (release) and cargo test did NOT run."
    echo "!! Force them with:  RUST_GATES=required npm run gates:rust"
    echo "!! CI runs them unconditionally in its dedicated rust job, so a violation still surfaces there."
    rust_verdict "skipped (nothing Rust-adjacent changed)"
    exit 0
  fi
fi

if ! command -v cargo >/dev/null 2>&1; then
  if [ "${RUST_GATES:-}" = "required" ]; then
    echo "!! cargo not found and RUST_GATES=required — failing." >&2
    exit 1
  fi
  echo "!! cargo not found — SKIPPING the Rust gates."
  echo "!! CI still runs them, so a formatting or clippy error will surface there."
  rust_verdict "skipped (no cargo on this machine)"
  exit 0
fi

# tauri-build validates the bundle paths inside its build script, so every cargo
# command below fails before compiling without these.
bash scripts/ensure-sidecar-stub.sh

echo "== cargo fmt --check =="
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check

echo "== cargo clippy (debug) =="
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings

echo "== cargo clippy (release — compiles the cfg(not(debug_assertions)) bodies) =="
cargo clippy --manifest-path src-tauri/Cargo.toml --release --all-targets -- -D warnings

echo "== cargo test =="
cargo test --manifest-path src-tauri/Cargo.toml

rust_verdict "ran"
