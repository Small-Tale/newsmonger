#!/usr/bin/env bash
#
# Smoke test for a *published* newsmonger install (NEWS-201).
#
# Adapted from ~/Documents/glassbox/tests/smoke/smoke-test.sh. Run by CI after
# `npm install -g newsmonger@<version>` — fresh and upgrade — to verify the
# thing on the registry actually works. That is a different question from the one
# the unit and E2E suites answer: those run against the working tree, so they
# cannot see a packaging fault. Newsmonger has shipped exactly that bug twice —
# a `files` allowlist that omitted the code, and a client asset copied by three
# separate hardcoded lists, one of which missed the wordmark — so the checks here
# lean on *what the running server serves*, not on a list written down here.
#
# Usage:
#   bash tests/smoke/smoke-test.sh [newsmonger-command]
#
# The optional argument is the command to run; defaults to `newsmonger` on PATH.
# It may be multi-word (e.g. "node dist/cli.js").
#
# Exit codes:
#   0 — all checks passed
#   1 — a check failed
#
# **bash 3.2 must be enough** — that is what macOS ships, and `mapfile`,
# `readarray`, `declare -A` and `wait -n` do not exist there. `bash -n` will not
# catch a missing builtin, so this is gated by tests/unit/release-scripts.test.ts.
set -euo pipefail

NEWSMONGER="${1:-newsmonger}"
PORT=4199
BASE="http://localhost:$PORT"
PASSED=0
FAILED=0
SERVER_PID=""
DATA_DIR=""

BOLD="\033[1m"
GREEN="\033[32m"
RED="\033[31m"
DIM="\033[2m"
RESET="\033[0m"

pass() { echo -e "  ${GREEN}✓${RESET} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "  ${RED}✗${RESET} $1"; FAILED=$((FAILED + 1)); }

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  # The data dir is a mktemp path, never ~/.newsmonger — see below.
  if [[ -n "$DATA_DIR" && -d "$DATA_DIR" ]]; then
    rm -rf "$DATA_DIR"
  fi
}
trap cleanup EXIT

summary() {
  echo ""
  local total=$((PASSED + FAILED))
  if [[ "$FAILED" -eq 0 ]]; then
    echo -e "${GREEN}${BOLD}PASSED${RESET} — all $total checks passed"
    exit 0
  fi
  echo -e "${RED}${BOLD}FAILED${RESET} — $PASSED passed, $FAILED failed"
  exit 1
}

echo -e "${BOLD}Smoke Test: ${NEWSMONGER}${RESET}"
echo ""

# --- The binary runs at all ---

# One invocation, captured — deliberately not `$NEWSMONGER --help | grep`.
#
# Two traps here, both of which cost a debugging round. `newsmonger --help`
# **exits 1**: the flag is not recognised, so it falls through to the
# unknown-argument path, which prints the usage line and exits non-zero. (Glassbox's
# `--help` exits 0, which is why this section diverges from it.) And under
# `set -o pipefail` a pipeline inherits that 1 even when `grep` matches, so
# `! cmd | grep -q .` reports "not runnable" for a command that ran perfectly.
HELP_OUTPUT=$($NEWSMONGER --help 2>&1 || true)

if [[ -z "$HELP_OUTPUT" ]]; then
  # No output at all is the shape a broken `bin` entry or a missing dist takes.
  fail "Command not runnable: $NEWSMONGER"
  summary
fi
pass "Command runnable"

if echo "$HELP_OUTPUT" | grep -q "usage: newsmonger"; then
  pass "--help prints usage"
else
  fail "--help did not print usage (got: $(echo "$HELP_OUTPUT" | head -1))"
fi

# --- Start the server ---
#
# `--data-dir` into a temp directory is mandatory, not tidiness: the default is
# ~/.newsmonger, and a smoke test that writes there would scribble on the real
# install of whoever ran it. Same rule the unit and E2E suites follow.
#
# `--ai-test` uses the deterministic mock provider, so a check needs no API key
# and returns the same two stories every time — which is what makes the
# end-to-end assertion below possible on a runner with no credentials.
DATA_DIR=$(mktemp -d "${TMPDIR:-/tmp}/newsmonger-smoke.XXXXXX")

echo ""
echo -e "${DIM}Starting newsmonger (data dir: $DATA_DIR)...${RESET}"
$NEWSMONGER --no-open --strict-port --port "$PORT" --data-dir "$DATA_DIR" --ai-test &
SERVER_PID=$!

READY=false
for _ in $(seq 1 60); do
  if curl -sf "$BASE/healthz" > /dev/null 2>&1; then
    READY=true
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    fail "Server process exited unexpectedly"
    break
  fi
  sleep 0.5
done

if [[ "$READY" == "true" ]]; then
  pass "Server started on port $PORT"
else
  fail "Server did not become ready within 30 seconds"
  summary
fi

# --- The page loads ---

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/")
if [[ "$HTTP_STATUS" == "200" ]]; then
  pass "GET / returns 200"
else
  fail "GET / returned $HTTP_STATUS (expected 200)"
fi

PAGE_HTML=$(curl -s "$BASE/")
if echo "$PAGE_HTML" | grep -q 'id="app"'; then
  pass "Page contains the app mount point"
else
  fail "Page missing the #app mount point"
fi

# --- Every static asset the client can ask for is actually served ---
#
# The list is *derived from what the server serves* — the HTML plus the client
# bundle — rather than written here. That is the point: the wordmark shipped
# broken in a packaged build precisely because a hardcoded list went stale, and a
# hardcoded list in this file would be a fourth copy with the same failure mode.
APP_JS=$(curl -s "$BASE/static/app.js")
ASSETS=$(printf '%s\n%s\n' "$PAGE_HTML" "$APP_JS" \
  | grep -o '/static/[A-Za-z0-9._-]*' \
  | sort -u)

if [[ -z "$ASSETS" ]]; then
  fail "No /static/ references found in the page or bundle (bundle empty?)"
else
  ASSET_COUNT=0
  MISSING=""
  # A `while read` loop rather than `mapfile` — bash 3.2 has no `mapfile`.
  # Piping into `while` would subshell the counters, so feed it via a heredoc.
  while IFS= read -r asset; do
    [[ -z "$asset" ]] && continue
    ASSET_COUNT=$((ASSET_COUNT + 1))
    status=$(curl -s -o /dev/null -w "%{http_code}" "$BASE$asset")
    if [[ "$status" != "200" ]]; then
      MISSING="$MISSING $asset($status)"
    fi
  done <<< "$ASSETS"

  if [[ -z "$MISSING" ]]; then
    pass "All $ASSET_COUNT referenced static assets served"
  else
    fail "Static assets missing:$MISSING"
  fi
fi

# --- The API answers ---

API_STATE=$(curl -s "$BASE/api/state")
if echo "$API_STATE" | grep -q '"settings"' && echo "$API_STATE" | grep -q '"topics"'; then
  pass "GET /api/state returns state"
else
  fail "GET /api/state did not return expected shape"
fi

PROVIDERS=$(curl -s "$BASE/api/providers")
if echo "$PROVIDERS" | grep -q '"providers"'; then
  pass "GET /api/providers returns the provider list"
else
  fail "GET /api/providers did not return expected shape"
fi

# --- A topic can be created, checked, and produces stories ---
#
# The part worth having. Everything above proves the package unpacked; this
# proves the pipeline runs — request validation, the provider call, dedup, and
# the SQLite write — inside an installed build rather than the working tree.
CREATE=$(curl -s -X POST "$BASE/api/topics" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Smoke test topic"}')
TOPIC_ID=$(printf '%s' "$CREATE" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')

if [[ -n "$TOPIC_ID" ]]; then
  pass "POST /api/topics created a topic"
else
  fail "POST /api/topics did not return an id (got: $CREATE)"
fi

if [[ -n "$TOPIC_ID" ]]; then
  CHECK=$(curl -s -X POST "$BASE/api/check" \
    -H 'Content-Type: application/json' \
    -d "{\"topicId\":\"$TOPIC_ID\"}")
  if echo "$CHECK" | grep -q '"started"'; then
    pass "POST /api/check started a check"
  else
    fail "POST /api/check did not start (got: $CHECK)"
  fi

  # Fire-and-forget on the server, so poll rather than assume it finished.
  STORIES=0
  for _ in $(seq 1 40); do
    ITEMS=$(curl -s "$BASE/api/items")
    STORIES=$(printf '%s' "$ITEMS" | grep -o '"total":[0-9]*' | head -1 | cut -d: -f2)
    [[ -z "$STORIES" ]] && STORIES=0
    if [[ "$STORIES" -gt 0 ]]; then break; fi
    sleep 0.5
  done

  if [[ "$STORIES" -gt 0 ]]; then
    pass "Check produced $STORIES stories (mock provider)"
  else
    fail "Check produced no stories within 20 seconds"
  fi
fi

# --- The feed and export surfaces respond ---

FEED_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/feed.xml")
if [[ "$FEED_STATUS" == "200" ]]; then
  pass "GET /feed.xml returns 200"
else
  fail "GET /feed.xml returned $FEED_STATUS"
fi

EXPORT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/export.md")
if [[ "$EXPORT_STATUS" == "200" ]]; then
  pass "GET /api/export.md returns 200"
else
  fail "GET /api/export.md returned $EXPORT_STATUS"
fi

# --- The database was actually written ---

if [[ -f "$DATA_DIR/newsmonger.db" ]]; then
  pass "SQLite database created in the data dir"
else
  fail "No newsmonger.db in $DATA_DIR (built-in node:sqlite unavailable?)"
fi

# --- Graceful shutdown ---

echo ""
echo -e "${DIM}Testing graceful shutdown...${RESET}"
kill "$SERVER_PID" 2>/dev/null || true
WAIT_EXIT=0
wait "$SERVER_PID" 2>/dev/null || WAIT_EXIT=$?
SERVER_PID=""

# 0 or 143 (128 + SIGTERM) both count as a clean exit.
if [[ "$WAIT_EXIT" -eq 0 || "$WAIT_EXIT" -eq 143 ]]; then
  pass "Server shut down cleanly (exit $WAIT_EXIT)"
else
  fail "Server exited with code $WAIT_EXIT"
fi

sleep 1
if curl -sf "$BASE/healthz" > /dev/null 2>&1; then
  fail "Port $PORT still serving after shutdown"
else
  pass "Port $PORT freed after shutdown"
fi

summary
