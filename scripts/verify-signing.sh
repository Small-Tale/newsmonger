#!/usr/bin/env bash
# Check that a built macOS bundle is actually distributable (NEWS-21).
#
# Signing has an unusually bad failure mode: everything succeeds on the machine
# that built it, and Gatekeeper blocks it everywhere else. The build machine is
# the one place you cannot test the thing you care about — it trusts its own
# certificate, and quarantine is never applied to a locally-produced file. So
# this asserts the properties Gatekeeper will check *there*, here.
#
# Usage:
#   bash scripts/verify-signing.sh                       # default release paths
#   bash scripts/verify-signing.sh path/to/Newsmonger.app      # explicit bundle
#
# Exits non-zero if the bundle would be rejected. Safe to run on an unsigned
# build — it says which step failed rather than pretending.
set -uo pipefail
cd "$(dirname "$0")/.."

APP="${1:-src-tauri/target/release/bundle/macos/Newsmonger.app}"
DMG_DIR="src-tauri/target/release/bundle/dmg"

fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=1; }
note() { printf '  \033[33m•\033[0m %s\n' "$1"; }

if [ ! -d "$APP" ]; then
  echo "No bundle at $APP — run 'npm run tauri:build' first." >&2
  exit 2
fi

echo "==> Bundle: $APP"

# --- 1. Is it signed at all, and by whom? ---------------------------------
sig="$(codesign -dvvv "$APP" 2>&1 || true)"
authority="$(printf '%s' "$sig" | awk -F'Authority=' '/Authority=/{print $2; exit}')"
if printf '%s' "$sig" | grep -q 'code object is not signed'; then
  bad "not signed at all"
elif printf '%s' "$authority" | grep -q '^Developer ID Application'; then
  ok "signed by: $authority"
else
  # An ad-hoc or self-signed identity works locally and nowhere else, which is
  # precisely the confusion this script exists to prevent.
  bad "signed, but not with a Developer ID Application certificate (got: ${authority:-none})"
fi

# --- 2. Hardened runtime ---------------------------------------------------
# Notarization requires it. Tauri sets it by default; this catches the case
# where someone turns it off to make a signing error go away.
if printf '%s' "$sig" | grep -q 'flags=.*runtime'; then
  ok "hardened runtime enabled"
else
  bad "hardened runtime NOT enabled — notarization will refuse this"
fi

# --- 3. The sidecar ---------------------------------------------------------
# The part most likely to be wrong, and the part that fails *after* a successful
# notarization: a Node binary re-signed under the hardened runtime cannot run
# JavaScript without JIT entitlements.
sidecar="$(find "$APP/Contents" -type f -name 'newsmonger-node*' -perm -u+x 2>/dev/null | head -1)"
if [ -z "$sidecar" ]; then
  bad "no newsmonger-node sidecar found inside the bundle"
else
  ok "sidecar: ${sidecar#"$APP"/}"
  ents="$(codesign -d --entitlements - "$sidecar" 2>/dev/null || true)"
  for needed in allow-jit allow-unsigned-executable-memory; do
    if printf '%s' "$ents" | grep -q "$needed"; then
      ok "sidecar has com.apple.security.cs.$needed"
    else
      bad "sidecar is MISSING com.apple.security.cs.$needed — it will sign, notarize, and then fail to run JavaScript"
    fi
  done
  # The notary service rejects this outright. Node's own binaries carry it, so
  # it arrives by accident rather than by choice.
  if printf '%s' "$ents" | grep -q 'get-task-allow'; then
    bad "sidecar carries com.apple.security.get-task-allow — the notary service will reject the submission"
  else
    ok "sidecar has no get-task-allow"
  fi
fi

# --- 4. Signature integrity, including everything nested -------------------
if codesign --verify --deep --strict --verbose=2 "$APP" >/dev/null 2>&1; then
  ok "signature verifies (deep, strict)"
else
  bad "codesign --verify --deep --strict failed"
fi

# --- 5. What Gatekeeper will actually decide -------------------------------
# The one check that speaks for the machines you don't own. "source=Notarized
# Developer ID" is the only answer that means "this will open for a stranger".
assess="$(spctl --assess --type exec --verbose=4 "$APP" 2>&1 || true)"
if printf '%s' "$assess" | grep -q 'source=Notarized Developer ID'; then
  ok "Gatekeeper: accepted, notarized"
elif printf '%s' "$assess" | grep -q 'accepted'; then
  bad "Gatekeeper accepts it locally but it is not notarized ($(printf '%s' "$assess" | tr '\n' ' '))"
else
  bad "Gatekeeper would reject: $(printf '%s' "$assess" | tr '\n' ' ')"
fi

# --- 6. Stapled ticket ------------------------------------------------------
# Without stapling the app still opens, but only for someone online — the first
# launch has to reach Apple. Stapling is what makes it work offline.
if xcrun stapler validate "$APP" >/dev/null 2>&1; then
  ok "notarization ticket is stapled"
else
  bad "no stapled ticket — first launch will need network access, and will fail without it"
fi

# --- 7. The DMG, which is what people actually download --------------------
dmg="$(find "$DMG_DIR" -name '*.dmg' 2>/dev/null | head -1)"
if [ -z "$dmg" ]; then
  note "no .dmg built — skipping (the app bundle alone is not what users download)"
else
  echo "==> Disk image: $dmg"
  if xcrun stapler validate "$dmg" >/dev/null 2>&1; then
    ok "dmg has a stapled ticket"
  else
    bad "dmg is not stapled — notarizing the app does not notarize the disk image it ships in"
  fi
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "PASS — this bundle should open on a machine that has never seen it."
else
  echo "FAIL — see docs/5-desktop-app.md for what each check means." >&2
fi
exit "$fail"
