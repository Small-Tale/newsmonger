#!/usr/bin/env bash
#
# Signed + notarized release build, locally (NEWS-198).
#
#   npm run tauri:build:local                  sign, notarize, verify
#   npm run tauri:build:local -- --no-notarize sign and verify only (fast)
#
# `npm run tauri:build` produces an **unsigned** bundle that opens on this Mac
# and nowhere else. This adds the credentials that make it distributable, without
# putting any of them on a command line.
#
# Modelled on ~/Documents/glassbox's `tauri:build:local`, which prompts for the
# passphrase to its updater signing key and exports TAURI_SIGNING_PRIVATE_KEY.
#
# That half is conditional here. `~/.tauri/newsmonger.key` exists, but the updater
# is **not configured yet** — `bundle.createUpdaterArtifacts` is absent from
# tauri.conf.json — so Tauri would ignore the key entirely. Prompting for a
# passphrase to sign artifacts nothing will produce is theatre, so the key is used
# only once the updater is switched on, and this flips over on its own when it is
# (see NEWS-199). Until then what makes a build production here is Apple's
# credentials, so those are what it supplies.
#
# What it keeps from glassbox unconditionally is the important bit: a hidden
# `read -rs` prompt, so no secret reaches argv, the shell history, or `ps`.
#
# This does NOT substitute for the release workflow. Here signing comes from the
# login keychain; in CI a `.p12` is imported into a throwaway keychain
# (APPLE_CERTIFICATE + APPLE_CERTIFICATE_PASSWORD + KEYCHAIN_PASSWORD). That path
# exists only there, so a green run of this proves nothing about it — and this
# repo has already had two "passes locally, fails on the runner" bugs (NEWS-191,
# NEWS-193). Nor does it replace opening a downloaded .dmg: a file this machine
# produced is never quarantined, which is the one thing no script can check.
#
set -euo pipefail
cd "$(dirname "$0")/.."

# The organization the bundle must be signed as. Not a preference — this machine
# carries a personal Developer ID too, and signing a Small Tale release with it
# would succeed locally and be wrong.
ORG="Small Tale"

NOTARIZE=true
CHECK_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --no-notarize) NOTARIZE=false ;;
    --check)       CHECK_ONLY=true; NOTARIZE=false ;;
    -h|--help)
      echo "Usage: npm run tauri:build:local [-- --no-notarize | --check]"
      echo
      echo "  (default)       sign + notarize + staple, then verify"
      echo "  --no-notarize   sign only, then verify. Much faster — notarization is"
      echo "                  the slow part (minutes to over an hour at Apple)."
      echo "  --check         resolve the signing identity and exit. Confirms the setup"
      echo "                  in a second instead of finding out 15 minutes in."
      echo
      echo "Reads APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID from the environment when"
      echo "set; prompts for whatever is missing. APPLE_PASSWORD is the app-specific"
      echo "password from appleid.apple.com, not your Apple ID password."
      exit 0 ;;
    *) echo "Unrecognized arg: $arg" >&2; exit 1 ;;
  esac
done

BOLD="\033[1m"; DIM="\033[2m"; GREEN="\033[32m"; YELLOW="\033[33m"
RED="\033[31m"; CYAN="\033[36m"; RESET="\033[0m"
info()    { echo -e "${CYAN}${BOLD}>>>${RESET} $1"; }
success() { echo -e "${GREEN}${BOLD}>>>${RESET} $1"; }
warn()    { echo -e "${YELLOW}${BOLD}>>>${RESET} $1"; }
error()   { echo -e "${RED}${BOLD}>>>${RESET} $1" >&2; }

[[ "$(uname -s)" == "Darwin" ]] || {
  error "macOS only — codesign, notarytool and stapler are Apple tools."
  exit 1
}

# --- Signing identity, resolved rather than typed -----------------------------
#
# `security find-identity` prints lines like:
#   2) ABC123… "Developer ID Application: Small Tale, Inc. (5S45RN2WP9)"
# Match on the org so the personal cert can't be picked by accident, and take the
# Team ID from the identity's own parenthesised suffix so the two cannot disagree.
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  # Read into an array with a while-read loop, NOT `mapfile`. macOS ships bash
  # **3.2** and `/usr/bin/env bash` resolves to it, where `mapfile` does not
  # exist — the first version of this died on `mapfile: command not found`.
  # `bash -n` does not catch that, because it is a missing builtin rather than a
  # syntax error.
  found=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && found+=("$line")
  done < <(
    security find-identity -v -p codesigning 2>/dev/null \
      | grep -F 'Developer ID Application' \
      | grep -F "$ORG" \
      | sed -E 's/.*"(.*)".*/\1/'
  )
  case "${#found[@]}" in
    0)
      error "No \"Developer ID Application: $ORG …\" identity in the login keychain."
      echo  "  Installed identities:" >&2
      security find-identity -v -p codesigning 2>/dev/null | sed 's/^/  /' >&2
      echo  "  See docs/5-desktop-app.md for how to create and install one." >&2
      exit 1 ;;
    1) APPLE_SIGNING_IDENTITY="${found[0]}" ;;
    *)
      error "More than one \"$ORG\" Developer ID identity — refusing to guess:"
      printf '  %s\n' "${found[@]}" >&2
      echo  "  Set APPLE_SIGNING_IDENTITY explicitly and re-run." >&2
      exit 1 ;;
  esac
fi
export APPLE_SIGNING_IDENTITY
info "Signing identity: ${BOLD}${APPLE_SIGNING_IDENTITY}${RESET}"

if [[ -z "${APPLE_TEAM_ID:-}" ]]; then
  APPLE_TEAM_ID="$(sed -E 's/.*\(([A-Z0-9]{10})\)$/\1/' <<< "$APPLE_SIGNING_IDENTITY")"
  [[ "$APPLE_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || {
    error "Could not read a Team ID from the identity. Set APPLE_TEAM_ID and re-run."
    exit 1
  }
fi
export APPLE_TEAM_ID
info "Team ID: ${BOLD}${APPLE_TEAM_ID}${RESET} ${DIM}(from the identity)${RESET}"

if [[ "$CHECK_ONLY" == "true" ]]; then
  echo
  success "Signing identity resolves. Nothing was built."
  echo -e "  ${DIM}Confirm these match the repo secrets — a Team ID mismatch between the${RESET}"
  echo -e "  ${DIM}certificate and APPLE_TEAM_ID fails notarization, not signing, so it${RESET}"
  echo -e "  ${DIM}surfaces an hour into a release rather than at the start.${RESET}"
  exit 0
fi

# --- Notarization credentials -------------------------------------------------
if [[ "$NOTARIZE" == "true" ]]; then
  if [[ -z "${APPLE_ID:-}" ]]; then
    read -rp "$(echo -e "${CYAN}${BOLD}>>>${RESET} Apple ID (email): ")" APPLE_ID
  fi
  [[ -n "$APPLE_ID" ]] || { error "An Apple ID is required to notarize (or pass --no-notarize)."; exit 1; }
  export APPLE_ID

  if [[ -z "${APPLE_PASSWORD:-}" ]]; then
    # -s so it is never echoed. Together with never passing it as an argument,
    # that keeps it out of the terminal, the shell history, and `ps` output.
    read -rsp "$(echo -e "${CYAN}${BOLD}>>>${RESET} App-specific password ${DIM}(appleid.apple.com, xxxx-xxxx-xxxx-xxxx)${RESET}: ")" APPLE_PASSWORD
    echo
  fi
  [[ -n "$APPLE_PASSWORD" ]] || { error "The app-specific password is required (or pass --no-notarize)."; exit 1; }
  export APPLE_PASSWORD

  # Two ways to get this wrong, and neither error says which: using the Apple ID
  # account password, or stripping the hyphens. Catch the shape at least.
  [[ "$APPLE_PASSWORD" =~ ^[a-z]{4}(-[a-z]{4}){3}$ ]] || warn \
    "That doesn't look like an app-specific password (expected xxxx-xxxx-xxxx-xxxx). Continuing anyway."

  info "Notarizing as ${BOLD}${APPLE_ID}${RESET} — Apple's queue can take anywhere from minutes to over an hour."
else
  warn "Skipping notarization (--no-notarize). The bundle will be SIGNED but NOT distributable:"
  warn "  Gatekeeper blocks an un-notarized app on any Mac but this one."
fi

# --- Updater signing key, only if the updater is actually on -------------------
#
# The key exists at ~/.tauri/newsmonger.key, but Tauri only signs update
# artifacts when `bundle.createUpdaterArtifacts` is set — so asking for its
# passphrase before then buys nothing. The check is on the config, not on the
# key's presence, which is what makes this correct both now and later.
UPDATER_KEY="${HOME}/.tauri/newsmonger.key"
UPDATER_ON="$(node -p "require('./src-tauri/tauri.conf.json').bundle.createUpdaterArtifacts ? 'yes' : 'no'" 2>/dev/null || echo no)"

if [[ "$UPDATER_ON" == "yes" ]]; then
  [[ -f "$UPDATER_KEY" ]] || {
    error "The updater is enabled but $UPDATER_KEY is missing."
    error "  Generate one with: npm run tauri signer generate -- -w $UPDATER_KEY"
    error "  Losing this key is unrecoverable — the public key is compiled into every"
    error "  shipped binary, so a new keypair cannot update apps already installed."
    exit 1
  }
  TAURI_SIGNING_PRIVATE_KEY="$(cat "$UPDATER_KEY")"
  export TAURI_SIGNING_PRIVATE_KEY
  if [[ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]]; then
    read -rsp "$(echo -e "${CYAN}${BOLD}>>>${RESET} Updater key passphrase ${DIM}(${UPDATER_KEY})${RESET}: ")" TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    echo
  fi
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  info "Updater artifacts will be signed with ${BOLD}${UPDATER_KEY}${RESET}"
elif [[ -f "$UPDATER_KEY" ]]; then
  info "Updater key present but unused — createUpdaterArtifacts is off ${DIM}(NEWS-199)${RESET}"
fi

# --- Build --------------------------------------------------------------------
# No --target: scripts/verify-signing.sh reads src-tauri/target/release/bundle/…,
# and an explicit target moves everything under target/<triple>/ where it would
# find nothing and pass vacuously.
info "Building (this also runs scripts/build-sidecar.sh via beforeBuildCommand)..."
npm run tauri:build

# --- Verify -------------------------------------------------------------------
# Automatic, because a production build nobody verified is exactly what FR-5.7
# exists to prevent — the build machine trusts its own certificate and never
# quarantines its own output, so "it opened for me" means nothing.
echo
info "Verifying the bundle is distributable..."
if bash scripts/verify-signing.sh; then
  echo
  success "Bundle verified."
else
  echo
  if [[ "$NOTARIZE" == "true" ]]; then
    error "Verification failed. docs/5-desktop-app.md FR-5.7 explains each check."
    error "If notarization was refused, ask Apple why:"
    error "  xcrun notarytool history --apple-id \"\$APPLE_ID\" --team-id \"\$APPLE_TEAM_ID\" --password \"\$APPLE_PASSWORD\""
    error "  xcrun notarytool log <submission-id> --apple-id … --team-id … --password …"
  else
    warn "Expected with --no-notarize: the Gatekeeper and stapling checks cannot pass"
    warn "without notarization. Re-run without --no-notarize for a real verdict."
  fi
  exit 1
fi

echo
echo -e "  ${DIM}App:${RESET} src-tauri/target/release/bundle/macos/Newsmonger.app"
echo -e "  ${DIM}DMG:${RESET} $(find src-tauri/target/release/bundle/dmg -name '*.dmg' 2>/dev/null | head -1)"
echo
echo -e "  ${DIM}The one check no script can do: copy the .dmg to a Mac that has never seen${RESET}"
echo -e "  ${DIM}this app and open it there. Only a real download carries quarantine.${RESET}"
