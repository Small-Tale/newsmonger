#!/usr/bin/env bash
# Full gate: typecheck + lint + unit tests + E2E tests, with merged coverage.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== typecheck =="
npm run typecheck

echo "== lint =="
npm run lint

echo "== unit tests (vitest, coverage -> coverage/unit) =="
rm -rf coverage .coverage-tmp
npx vitest run --coverage

echo "== e2e tests (playwright, V8 coverage -> .coverage-tmp) =="
E2E_COVERAGE=1 npx playwright test

echo "== merge coverage =="
node scripts/merge-coverage.mjs
