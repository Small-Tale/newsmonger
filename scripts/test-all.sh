#!/usr/bin/env bash
#
# Full gate: typecheck + lint + Rust + unit tests + E2E tests, with merged coverage.
#
# **Resumable, and loud about it** (NEWS-300). E2E is ~73% of a 3m34s run, so a
# failure in it used to mean fixing one line and re-paying typecheck, lint, both
# builds and the whole unit suite to get back to where you were. `--from=e2e`
# starts there instead.
#
#   npm run test:all                 # the commit gate
#   npm run test:all -- --from=e2e   # resume after an E2E-only failure
#   npm run test:all -- --list       # the phase ids, in order
#
# **A resumed run is not a gate**, and this script says so in as many words. That
# distinction is the whole safety property here: this project has already shipped
# a `test:all` that passed green while `cargo fmt --check` was violated, and main
# was red for two commits (NEWS-201 follow-on). So every run — resumed or not —
# ends with a summary naming each phase and whether it actually ran, and a
# partial run prints a banner refusing to be mistaken for a full one.
#
# Explicit `--from`, deliberately, rather than stamp files keyed on a hash of the
# inputs. A stamp is a *guess* that nothing relevant changed, and a wrong guess
# here produces a **green** run with a phase silently skipped — the one outcome
# this must never have. A flag is a stated intention, and the summary repeats it
# back.
#
# bash 3.2 must be enough (macOS default); gated by tests/unit/release-scripts.test.ts.
set -euo pipefail
cd "$(dirname "$0")/.."

PHASE_IDS="typecheck lint rust client server unit e2e coverage"

phase_label() {
  case "$1" in
    typecheck) echo "typecheck" ;;
    lint)      echo "lint" ;;
    rust)      echo "rust (fmt + clippy debug/release + test)" ;;
    client)    echo "client assets (unit tests fetch them through the real route)" ;;
    server)    echo "server bundle (unit tests spawn the packaged CLI)" ;;
    unit)      echo "unit tests (vitest, coverage -> coverage/unit)" ;;
    e2e)       echo "e2e tests (playwright, V8 coverage -> .coverage-tmp)" ;;
    coverage)  echo "merge coverage" ;;
    *)         echo "$1" ;;
  esac
}

phase_run() {
  case "$1" in
    typecheck) npm run typecheck ;;
    lint)      npm run lint ;;
    # The Rust gates belong in "everything" (NEWS-201 follow-on). They were
    # absent, so `test:all` passed green with a `cargo fmt --check` violation in
    # src-tauri/src/lib.rs and main went red for two commits. The script
    # path-gates itself (NEWS-294) and reports which way it went via
    # RUST_GATE_VERDICT_FILE, so the summary below cannot claim it ran when it
    # did not.
    rust)      RUST_GATE_VERDICT_FILE="$RUST_VERDICT" bash scripts/gates-rust.sh ;;
    # Client assets, before the unit tests rather than only before E2E
    # (NEWS-191). Two tests in tests/unit/api.test.ts fetch `/static/favicon.svg`
    # through the real route, deliberately: the `<link>` and the file come from
    # different places (the page template vs the client build), and the tests
    # assert they agree. `dist/` is gitignored, so on a clean checkout there is
    # nothing to serve and they 404 — which is why CI had never passed while this
    # always looked green locally.
    client)    npm run build:client ;;
    # The server bundle, for the same reason one step later (NEWS-295).
    # tests/unit/npm-package.test.ts spawns `node dist/cli.js` — the artifact its
    # assertions are actually about. It used to spawn `npx tsx src/cli.ts`, which
    # cost a cold transpile per spawn and cannot run in a command sandbox at all.
    # The E2E leg had the same trap until NEWS-299 and is now
    # `node --import tsx/esm` — the loader without the CLI's unix socket. The
    # whole run still needs a sandbox override on macOS, for a reason outside
    # this repo: Chromium cannot register a Mach port (NEWS-311).
    server)    npm run build ;;
    unit)      rm -rf coverage .coverage-tmp && npx vitest run --coverage ;;
    e2e)       E2E_COVERAGE=1 npx playwright test ;;
    coverage)  node scripts/merge-coverage.mjs ;;
    *)         echo "!! unknown phase: $1" >&2; return 1 ;;
  esac
}

FROM=""
for arg in "$@"; do
  case "$arg" in
    --list) for id in $PHASE_IDS; do echo "$id"; done; exit 0 ;;
    --from=*) FROM="${arg#--from=}" ;;
    *) echo "!! unknown option: $arg" >&2
       echo "   usage: test-all.sh [--from=<phase>] [--list]" >&2
       exit 2 ;;
  esac
done

if [ -n "$FROM" ]; then
  known=""
  for id in $PHASE_IDS; do
    if [ "$id" = "$FROM" ]; then known="yes"; fi
  done
  if [ -z "$known" ]; then
    echo "!! --from=$FROM is not a phase. Known phases, in order:" >&2
    for id in $PHASE_IDS; do echo "     $id" >&2; done
    exit 2
  fi
fi

# Repo-relative, not `mktemp` (NEWS-300). The unit suite runs inside a command
# sandbox (NEWS-295), which denies writes to macOS's default TMPDIR — so
# `mktemp` fails there, and `tests/unit/test-all-phases.test.ts` drives this
# script. Under `node_modules/.cache` it is gitignored, writable, and outside
# everything the phases below delete.
RUST_VERDICT="node_modules/.cache/newsmonger-rust-verdict"
mkdir -p "$(dirname "$RUST_VERDICT")"
rm -f "$RUST_VERDICT"
# Newline-separated "id<TAB>outcome", built as we go so the summary is truthful
# even when a phase fails and the trap fires mid-run.
RESULTS=""
CURRENT=""
SKIPPED_ANY=""

record() { RESULTS="${RESULTS}$1	$2
"; }

summary() {
  code="$1"
  # A phase that failed, and everything after it, never ran. Say so rather than
  # leaving them absent — "not listed" reads as "fine".
  if [ -n "$CURRENT" ]; then
    record "$CURRENT" "FAILED"
    reached=""
    for id in $PHASE_IDS; do
      if [ "$id" = "$CURRENT" ]; then reached="yes"; continue; fi
      if [ -n "$reached" ]; then record "$id" "not reached"; fi
    done
  fi

  echo
  echo "== phase summary =="
  printf '%s' "$RESULTS" | while IFS='	' read -r id outcome; do
    [ -n "$id" ] || continue
    printf '   %-10s %s\n' "$id" "$outcome"
  done

  if [ -n "$SKIPPED_ANY" ]; then
    echo
    echo "!! PARTIAL RUN — phases were skipped by --from=$FROM."
    echo "!! This is NOT a commit gate. Run 'npm run test:all' with no flags before committing."
  fi

  if [ -n "$CURRENT" ]; then
    echo
    echo "!! $CURRENT failed. Once it is fixed, resume without re-paying the phases above:"
    echo "!!   npm run test:all -- --from=$CURRENT"
    echo "!! Then run the full gate before committing."
  fi

  rm -f "$RUST_VERDICT"
  return "$code"
}

on_exit() {
  code=$?
  summary "$code" || true
  exit "$code"
}
trap on_exit EXIT

reached_from=""
[ -n "$FROM" ] || reached_from="yes"

for id in $PHASE_IDS; do
  if [ -z "$reached_from" ]; then
    if [ "$id" = "$FROM" ]; then
      reached_from="yes"
    else
      SKIPPED_ANY="yes"
      record "$id" "skipped (--from=$FROM)"
      continue
    fi
  fi

  echo "== $(phase_label "$id") =="
  CURRENT="$id"
  phase_run "$id"
  CURRENT=""

  if [ "$id" = "rust" ] && [ -s "$RUST_VERDICT" ]; then
    record "$id" "$(cat "$RUST_VERDICT")"
  else
    record "$id" "ran"
  fi
done
