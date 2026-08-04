#!/usr/bin/env bash
# Full gate: typecheck + lint + Rust + unit tests + E2E tests, with merged coverage.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== typecheck =="
npm run typecheck

echo "== lint =="
npm run lint

# The Rust gates belong in "everything" (NEWS-201 follow-on). They were absent,
# so `test:all` passed green with a `cargo fmt --check` violation in
# src-tauri/src/lib.rs and main went red for two commits. Skips itself with a
# notice when there's no cargo; see scripts/gates-rust.sh.
echo "== rust (fmt + clippy debug/release + test) =="
bash scripts/gates-rust.sh

# Client assets, before the unit tests rather than only before E2E (NEWS-191).
#
# Two unit tests in tests/unit/api.test.ts fetch `/static/favicon.svg` through
# the real route, deliberately: the `<link>` and the file come from different
# places (the page template vs the client build), and the tests assert they
# agree. But `dist/` is gitignored, so on a clean checkout there is nothing to
# serve and they 404.
#
# That is why CI had never passed while this always looked green locally — a dev
# machine has `dist/client/` lying around from an earlier build. Playwright's
# webServer builds for E2E; nothing built for the unit run.
echo "== client assets (unit tests fetch them through the real route) =="
npm run build:client

# The server bundle, for the same reason one step later (NEWS-295).
#
# tests/unit/npm-package.test.ts spawns the CLI to assert what an installed user
# meets — the usage line, the exit codes, `--help` on stdout. It used to do that
# as `npx tsx src/cli.ts`, which cost a cold resolve-and-transpile per spawn and
# **cannot run inside a command sandbox at all**: tsx opens an IPC socket and gets
# `listen EPERM`. It now runs `node dist/cli.js`, which is also the artifact those
# assertions are actually about.
#
# The test rebuilds on demand when the bundle is missing or stale, so `npm test`
# alone still works. This line is here to make the dependency explicit rather
# than a side effect discovered by whoever next reads a confusing failure.
echo "== server bundle (unit tests spawn the packaged CLI) =="
npm run build

echo "== unit tests (vitest, coverage -> coverage/unit) =="
rm -rf coverage .coverage-tmp
npx vitest run --coverage

echo "== e2e tests (playwright, V8 coverage -> .coverage-tmp) =="
E2E_COVERAGE=1 npx playwright test

echo "== merge coverage =="
node scripts/merge-coverage.mjs
