#!/usr/bin/env bash
#
# The fast inner loop: typecheck + lint + unit tests (NEWS-294).
#
# **This is not `test:all`, and it is not allowed to feel like it.** The full gate
# is still required before every commit and the never-commit-red rule is unchanged
# — a command that makes it *easier* to commit red would be a net loss, so this
# one ends by saying what it did not run.
#
# What it leaves out, and why that is safe for iteration but not for a commit:
#
#   * **E2E** — 2.3 minutes and the largest single cost, but also the only thing
#     that exercises the real UI against a real server.
#   * **The Rust gates** — irrelevant to a TypeScript change (and `test:all` now
#     skips them for one anyway; see scripts/rust-changed.sh).
#   * **Coverage** — v8 instrumentation is a real share of the unit leg's wall
#     time and is only needed for the merged report.
#
# What it keeps: typecheck and lint, because "fix lint and type errors as you go"
# is the house rule and both are seconds; and the client build, because two
# api.test.ts tests fetch `/static/…` through the real route and 404 without it
# (NEWS-191) — a failure that has nothing to do with the change being iterated on.
#
# bash 3.2 must be enough (macOS default); gated by tests/unit/release-scripts.test.ts.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== typecheck =="
npm run typecheck

echo "== lint =="
npm run lint

echo "== client assets (unit tests fetch them through the real route) =="
npm run build:client

# No `--coverage`: see above. The server bundle the packaged-CLI tests spawn is
# rebuilt on demand by the test itself when it is stale (NEWS-295).
echo "== unit tests (vitest, no coverage) =="
npx vitest run

echo
echo "!! gate:quick ran typecheck + lint + unit tests ONLY."
echo "!! No E2E, no Rust gates, no coverage. This is the iteration loop, not the gate."
echo "!! Run 'npm run test:all' before committing — never commit red."
