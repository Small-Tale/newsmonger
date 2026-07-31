#!/usr/bin/env bash
#
# Make Apple's notarization queue visible while CI waits on it (NEWS-197).
#
# Tauri drives `notarytool` internally and prints one "Notarizing …" line, then
# nothing until it finishes. On this project's first submissions that silence ran
# **1h38m**, and six of seven submissions sat `In Progress` for hours — one of them
# 10.8. While it is happening there is no way to tell a slow queue from a hung one,
# and the job's only visible outcome is an opaque `-1009` or a timeout.
#
# This polls Apple directly, from beside the build rather than inside it, so the
# log carries a timestamped record of what the notary service was actually doing.
#
#   start   background a poller writing to the log (returns immediately)
#   report  stop the poller and print what it recorded
#   history recent submissions, and Apple's own log for the newest one
#
# `report` and `history` are diagnostics and must never be the thing that fails a
# release — call them with `continue-on-error: true`. A diagnostic that can fail
# the job obscures the failure it exists to explain (NEWS-194).
#
# Requires APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID, and macOS for `xcrun`.

set -uo pipefail

STATE_DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
LOG="$STATE_DIR/notary-watch.log"
PID_FILE="$STATE_DIR/notary-watch.pid"
# Two minutes: often enough to see a state change promptly, rare enough that a
# two-hour wait is ~60 lines rather than a wall of them.
INTERVAL="${NOTARY_WATCH_INTERVAL:-120}"

# Every credential is required, so a missing one is a silent no-op rather than a
# failed release. An unsigned build (no APPLE_* secrets) is a legitimate caller.
have_credentials() {
  [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]
}

# `--password` is passed on the command line because `notarytool` offers no stdin
# form. It is an app-specific password, and the process list on a throwaway runner
# is not a meaningful exposure — but never echo the command itself.
notary() {
  xcrun notarytool "$@" \
    --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_PASSWORD"
}

# One line per submission: status first, since that is the word being looked for.
summarize() {
  if command -v jq >/dev/null 2>&1; then
    jq -r '.history // [] | .[:5][] | "  \(.status // "?")\t\(.id // "?")\t\(.createdDate // "?")"' 2>/dev/null
  else
    # jq is preinstalled on GitHub's macOS runners; this keeps the script honest
    # anywhere else rather than emitting nothing.
    cat
  fi
}

cmd_start() {
  if ! have_credentials; then
    echo "notary-watch: no Apple credentials in the environment — not watching"
    return 0
  fi
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "notary-watch: already running (pid $(cat "$PID_FILE"))"
    return 0
  fi

  : > "$LOG"
  {
    echo "notary-watch: polling every ${INTERVAL}s from $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    while true; do
      sleep "$INTERVAL"
      ts="$(date -u '+%H:%M:%S')"
      out="$(notary history --output-format json 2>&1)"
      if [[ -z "$out" ]]; then
        echo "[$ts] notarytool returned nothing"
      else
        echo "[$ts] recent submissions:"
        printf '%s\n' "$out" | summarize
      fi
    done
  } >> "$LOG" 2>&1 &

  echo $! > "$PID_FILE"
  echo "notary-watch: started (pid $(cat "$PID_FILE")), logging to $LOG"
}

cmd_report() {
  if [[ -f "$PID_FILE" ]]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
  if [[ -s "$LOG" ]]; then
    echo "── What Apple's notary queue was doing during this build ──"
    cat "$LOG"
  else
    echo "notary-watch: nothing recorded (build finished inside one poll interval, or no credentials)"
  fi
}

cmd_history() {
  have_credentials || { echo "notary-watch: no Apple credentials — cannot query history"; return 0; }

  echo "── Recent notarization submissions ──"
  # `In Progress` means Apple is still thinking; `Invalid` means it refused the
  # bundle. That one word is the whole diagnosis, and the fixes share nothing:
  # a missing entitlement, an unsigned nested binary and a present `get-task-allow`
  # are three different bugs (NEWS-194).
  notary history 2>&1 | head -40

  local id
  id="$(notary history --output-format json 2>/dev/null | (command -v jq >/dev/null 2>&1 && jq -r '.history[0].id // empty' || true))"
  if [[ -n "$id" ]]; then
    # The submission id is what every past diagnosis depended on, and it was only
    # recoverable by grepping an error string out of the raw log.
    echo ""
    echo "── Apple's log for the newest submission ($id) ──"
    notary log "$id" 2>&1 | head -60
  else
    echo ""
    echo "notary-watch: could not determine a submission id to fetch a log for"
  fi
}

case "${1:-}" in
  start) cmd_start ;;
  report) cmd_report ;;
  history) cmd_history ;;
  *)
    echo "Usage: bash scripts/notary-watch.sh start|report|history" >&2
    exit 2
    ;;
esac
