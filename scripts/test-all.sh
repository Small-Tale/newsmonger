#!/usr/bin/env bash
# Full gate: typecheck + lint + unit tests + E2E tests, with merged coverage.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== typecheck =="
npm run typecheck

echo "== lint =="
npm run lint

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

echo "== unit tests (vitest, coverage -> coverage/unit) =="
rm -rf coverage .coverage-tmp
npx vitest run --coverage

echo "== e2e tests (playwright, V8 coverage -> .coverage-tmp) =="
E2E_COVERAGE=1 npx playwright test

echo "== merge coverage =="
node scripts/merge-coverage.mjs
