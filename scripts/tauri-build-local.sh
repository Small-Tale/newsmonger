#!/usr/bin/env bash
#
# Local production build (NEWS-198), shaped like ~/Documents/glassbox's
# `tauri:build:local`.
#
#   npm run tauri:build:local                       glassbox behaviour: updater
#                                                   passphrase, build, done
#   npm run tauri:build:local -- --sign             ...and sign, then verify
#   npm run tauri:build:local -- --release          ...and notarize + staple both
#                                                   the .app and the .dmg
#   npm run tauri:build:local -- --check            resolve the identity and exit
#   npm run tauri:build:local -- --save-credentials remember notarization creds
#
# The default deliberately matches glassbox: prompt for the updater signing key's
# passphrase, export it, run `tauri build`. That produces update-signed artifacts
# and an **unsigned** app bundle — fast, and fine for testing, because it is CI
# that signs what ships. Note what that means: a default-built .app opens on this
# Mac and nowhere else. Use `--release` for something distributable.
#
# The updater passphrase is the only credential this needs by default, and that is
# not a style choice — Tauri *requires* it once `bundle.createUpdaterArtifacts` is
# on, whereas Apple signing and notarization are skipped silently when their
# variables are absent. That asymmetry is the whole reason glassbox's script asks
# for exactly one thing.
#
# Neither this nor glassbox's substitutes for the release workflow: here signing
# comes from the login keychain, while CI imports a `.p12` into a throwaway one.
# A locally produced file is also never quarantined, so it cannot tell you what
# Gatekeeper will decide about a download.
#
set -euo pipefail
cd "$(dirname "$0")/.."

ORG="Small Tale"                          # never the personal Developer ID
UPDATER_KEY="${HOME}/.tauri/newsmonger.key"
KEYCHAIN_SERVICE="newsmonger-notarization"

SIGN=false
NOTARIZE=false
CHECK_ONLY=false
SAVE_CREDENTIALS=false
for arg in "$@"; do
  case "$arg" in
    --sign)             SIGN=true ;;
    --release)          SIGN=true; NOTARIZE=true ;;
    --check)            CHECK_ONLY=true; SIGN=true ;;
    --save-credentials) SAVE_CREDENTIALS=true ;;
    -h|--help)
      cat <<'EOF'
Usage: npm run tauri:build:local [-- --sign | --release | --check | --save-credentials]

  (default)            updater passphrase + build. UNSIGNED — opens on this Mac
                       only. Matches glassbox's tauri:build:local.
  --sign               also sign with the Developer ID, then verify.
  --release            also notarize + staple the .app AND the .dmg, then verify.
                       Distributable. Slow: notarization is minutes to over an
                       hour at Apple.
  --check              resolve the signing identity and exit, without building.
  --save-credentials   store the Apple ID + app-specific password in the login
                       keychain, then exit. Later --release runs prompt for nothing.

Notarization credentials resolve: environment -> login keychain -> prompt.
APPLE_PASSWORD is the app-specific password from appleid.apple.com, NOT your
Apple ID password. Paste it with its hyphens.
EOF
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

[[ "$(uname -s)" == "Darwin" ]] || { error "macOS only — codesign/notarytool/stapler are Apple tools."; exit 1; }

# --- Save credentials and exit ------------------------------------------------
#
# The login keychain rather than a dotfile: Tauri accepts *only* env vars for
# notarization (no `--keychain-profile` equivalent), so `notarytool
# store-credentials` would cover our own dmg submission and not Tauri's of the
# app. Holding the secret in the keychain and exporting it into just this process
# gets a dotfile's convenience without leaving a password in plaintext.
if [[ "$SAVE_CREDENTIALS" == "true" ]]; then
  read -rp "$(echo -e "${CYAN}${BOLD}>>>${RESET} Apple ID (email): ")" save_id
  read -rsp "$(echo -e "${CYAN}${BOLD}>>>${RESET} App-specific password ${DIM}(xxxx-xxxx-xxxx-xxxx)${RESET}: ")" save_pw
  echo
  [[ -n "$save_id" && -n "$save_pw" ]] || { error "Both values are required."; exit 1; }
  security add-generic-password -U -a "$save_id" -s "$KEYCHAIN_SERVICE" -w "$save_pw" \
    && success "Saved to the login keychain as service '${KEYCHAIN_SERVICE}'."
  echo -e "  ${DIM}Remove with: security delete-generic-password -s ${KEYCHAIN_SERVICE}${RESET}"
  exit 0
fi

# --- Signing identity, resolved rather than typed -----------------------------
if [[ "$SIGN" == "true" ]]; then
  if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
    # A while-read loop, NOT `mapfile`: macOS ships bash 3.2, where that builtin
    # does not exist. `bash -n` does not catch it, because a missing builtin is a
    # runtime failure.
    found=()
    while IFS= read -r line; do
      [[ -n "$line" ]] && found+=("$line")
    done < <(
      security find-identity -v -p codesigning 2>/dev/null \
        | grep -F 'Developer ID Application' | grep -F "$ORG" \
        | sed -E 's/.*"(.*)".*/\1/'
    )
    case "${#found[@]}" in
      0) error "No \"Developer ID Application: $ORG …\" identity in the login keychain."
         security find-identity -v -p codesigning 2>/dev/null | sed 's/^/  /' >&2
         exit 1 ;;
      1) APPLE_SIGNING_IDENTITY="${found[0]}" ;;
      *) error "More than one \"$ORG\" identity — refusing to guess:"
         printf '  %s\n' "${found[@]}" >&2
         error "Set APPLE_SIGNING_IDENTITY explicitly."
         exit 1 ;;
    esac
  fi
  export APPLE_SIGNING_IDENTITY
  info "Signing identity: ${BOLD}${APPLE_SIGNING_IDENTITY}${RESET}"

  # From the identity's own parenthesised suffix, so the two cannot disagree.
  if [[ -z "${APPLE_TEAM_ID:-}" ]]; then
    APPLE_TEAM_ID="$(sed -E 's/.*\(([A-Z0-9]{10})\)$/\1/' <<< "$APPLE_SIGNING_IDENTITY")"
    [[ "$APPLE_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || { error "Could not read a Team ID; set APPLE_TEAM_ID."; exit 1; }
  fi
  export APPLE_TEAM_ID
  info "Team ID: ${BOLD}${APPLE_TEAM_ID}${RESET} ${DIM}(from the identity)${RESET}"

  if [[ "$CHECK_ONLY" == "true" ]]; then
    echo; success "Signing identity resolves. Nothing was built."
    exit 0
  fi
fi

# --- Notarization credentials -------------------------------------------------
if [[ "$NOTARIZE" == "true" ]]; then
  if [[ -z "${APPLE_ID:-}" ]]; then
    APPLE_ID="$(security find-generic-password -s "$KEYCHAIN_SERVICE" 2>/dev/null \
      | sed -n 's/^ *"acct"<blob>="\(.*\)"$/\1/p')" || true
  fi
  if [[ -z "${APPLE_PASSWORD:-}" && -n "$APPLE_ID" ]]; then
    APPLE_PASSWORD="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)" || true
    [[ -n "$APPLE_PASSWORD" ]] && info "Notarization credentials: ${DIM}login keychain${RESET}"
  fi
  [[ -n "$APPLE_ID" ]] || read -rp "$(echo -e "${CYAN}${BOLD}>>>${RESET} Apple ID (email): ")" APPLE_ID
  [[ -n "$APPLE_ID" ]] || { error "An Apple ID is required to notarize."; exit 1; }
  export APPLE_ID
  if [[ -z "${APPLE_PASSWORD:-}" ]]; then
    read -rsp "$(echo -e "${CYAN}${BOLD}>>>${RESET} App-specific password: ")" APPLE_PASSWORD
    echo
    echo -e "  ${DIM}Tip: --save-credentials stores these so later runs prompt for nothing.${RESET}"
  fi
  [[ -n "$APPLE_PASSWORD" ]] || { error "The app-specific password is required."; exit 1; }
  export APPLE_PASSWORD
  # Two ways to get this wrong, neither of which says which: the account password
  # instead of an app-specific one, or stripping the hyphens.
  [[ "$APPLE_PASSWORD" =~ ^[a-z]{4}(-[a-z]{4}){3}$ ]] || warn \
    "That doesn't look like an app-specific password (xxxx-xxxx-xxxx-xxxx). Continuing."
  info "Notarizing as ${BOLD}${APPLE_ID}${RESET} — Apple's queue can take minutes to over an hour."
fi

# --- Updater signing key ------------------------------------------------------
#
# Required, not optional: with `createUpdaterArtifacts` on, the bundler signs the
# update artifacts and fails without this. Exactly what glassbox's script exists
# to supply.
UPDATER_ON="$(node -p "require('./src-tauri/tauri.conf.json').bundle.createUpdaterArtifacts ? 'yes' : 'no'" 2>/dev/null || echo no)"
if [[ "$UPDATER_ON" == "yes" ]]; then
  [[ -f "$UPDATER_KEY" ]] || {
    error "Updater artifacts are enabled but $UPDATER_KEY is missing."
    error "  Generate: npm run tauri signer generate -- -w $UPDATER_KEY"
    error "  Losing this key is unrecoverable — the public key is compiled into every"
    error "  shipped binary, so a replacement cannot update installs already out there."
    exit 1
  }
  TAURI_SIGNING_PRIVATE_KEY="$(cat "$UPDATER_KEY")"
  export TAURI_SIGNING_PRIVATE_KEY
  if [[ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]]; then
    read -rsp "$(echo -e "${CYAN}${BOLD}>>>${RESET} Updater key passphrase: ")" TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    echo
  fi
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
fi

if [[ "$SIGN" != "true" ]]; then
  warn "Unsigned build (glassbox default). It will open on this Mac and nowhere else."
  warn "  Use --release for something you can hand to someone."
fi

# --- Build --------------------------------------------------------------------
# No --target: verify-signing.sh reads src-tauri/target/release/bundle/…, and an
# explicit target moves everything under target/<triple>/ where it finds nothing
# and passes vacuously.
info "Building (beforeBuildCommand runs scripts/build-sidecar.sh)..."
npm run tauri:build

# --- Notarize the .dmg, which Tauri does not (NEWS-200) -----------------------
# Tauri notarizes and staples the .app, then builds the .dmg from it and only
# *signs* the dmg. The dmg is what people download, and a downloaded dmg is
# quarantined — Gatekeeper assesses the disk image itself and refuses a signed but
# un-notarized one. The notarized app inside does not help; nobody can reach it.
if [[ "$NOTARIZE" == "true" ]]; then
  dmg="$(find src-tauri/target/release/bundle/dmg -name '*.dmg' 2>/dev/null | head -1)"
  if [[ -z "$dmg" ]]; then
    warn "No .dmg produced — skipping its notarization."
  else
    echo; info "Notarizing the disk image separately: ${BOLD}$(basename "$dmg")${RESET}"
    xcrun notarytool submit "$dmg" \
      --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_PASSWORD" --wait
    xcrun stapler staple "$dmg"
    success "Disk image notarized and stapled"
  fi
fi

# --- Verify -------------------------------------------------------------------
# Only when signing was asked for. On an unsigned build every check would fail by
# design, and a wall of red on the expected outcome trains people to ignore it.
if [[ "$SIGN" == "true" ]]; then
  echo; info "Verifying the bundle is distributable..."
  if bash scripts/verify-signing.sh; then
    echo; success "Bundle verified."
  else
    echo
    if [[ "$NOTARIZE" == "true" ]]; then
      error "Verification failed — docs/5-desktop-app.md FR-5.7 explains each check."
      error "If Apple refused it, ask why:"
      error "  xcrun notarytool history --apple-id \"\$APPLE_ID\" --team-id \"\$APPLE_TEAM_ID\" --password \"\$APPLE_PASSWORD\""
    else
      warn "Expected with --sign: the Gatekeeper and stapling checks cannot pass"
      warn "without notarization. Use --release for a real verdict."
    fi
    exit 1
  fi
fi

echo
echo -e "  ${DIM}App:${RESET} src-tauri/target/release/bundle/macos/Newsmonger.app"
dmg_out="$(find src-tauri/target/release/bundle/dmg -name '*.dmg' 2>/dev/null | head -1)"
[[ -n "$dmg_out" ]] && echo -e "  ${DIM}DMG:${RESET} $dmg_out"
if [[ "$NOTARIZE" == "true" ]]; then
  echo
  echo -e "  ${DIM}The one check no script can do: copy the .dmg to a Mac that has never seen${RESET}"
  echo -e "  ${DIM}this app and open it there. Only a real download carries quarantine.${RESET}"
fi
