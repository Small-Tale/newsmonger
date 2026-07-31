#!/usr/bin/env bash
# Verify a *published* macOS release the way a user meets it (NEWS-21).
#
#   bash scripts/verify-released-dmg.sh v0.2.0-beta.7
#   bash scripts/verify-released-dmg.sh v0.2.0-beta.7 x64     # the Intel dmg
#
# `scripts/verify-signing.sh` checks a bundle on the machine that built it.
# That machine holds the signing key, has never quarantined the file, and is
# checking something that has not been through GitHub. This checks the artifact a
# user actually downloads, under the attribute that actually gates it.
#
# **The quarantine flag is the whole point.** Gatekeeper's assessment is only
# performed on files carrying `com.apple.quarantine`, which a browser sets and a
# build never does. Without it, `spctl` will happily accept things it would
# reject in a user's Downloads folder, and every check here would be theatre.
#
# What the checks establish, in the order a user hits them:
#
#   1. The `.app` inside the dmg is **stapled** — so first launch works with no
#      network. A notarized-but-unstapled app needs to phone Apple, and fails
#      shut on a plane or behind a firewall.
#   2. `spctl` assesses it as **`source=Notarized Developer ID`**, the string
#      that means Gatekeeper will open it rather than offering the Trash.
#   3. Dragged out of the dmg it **keeps its quarantine** and is *still*
#      accepted — that is the real install path, not the mounted volume.
#   4. The Node sidecar **starts and JITs** while quarantined. This is the one
#      that cannot be checked any other way: get the hardened-runtime
#      entitlements wrong and the app signs, notarizes and staples perfectly,
#      then dies at launch on someone else's Mac with every prior check green.
#
# Note on the dmg's own staple: it does **not** have one, and that is deliberate
# (NEWS-200/221). This script proves why that is safe rather than asserting it —
# step 3 exercises mount-drag-out-run and shows the app is accepted regardless.
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="${1:-}"
ARCH="${2:-aarch64}"
if [ -z "$TAG" ]; then
  echo "usage: bash scripts/verify-released-dmg.sh <tag> [aarch64|x64]" >&2
  exit 2
fi

command -v gh >/dev/null || { echo "gh is required to download the release" >&2; exit 2; }
[ "$(uname -s)" = "Darwin" ] || { echo "macOS only — spctl and stapler are Apple tools" >&2; exit 2; }

if [ -t 1 ]; then
  GREEN="\033[32m"; RED="\033[31m"; YELLOW="\033[33m"; BOLD="\033[1m"; RESET="\033[0m"
else
  GREEN=""; RED=""; YELLOW=""; BOLD=""; RESET=""
fi
fail=0
ok()   { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
bad()  { printf "  ${RED}✗${RESET} %s\n" "$1"; fail=1; }
note() { printf "  ${YELLOW}•${RESET} %s\n" "$1"; }

WORK="$(mktemp -d)"
MOUNT=""
cleanup() {
  [ -n "$MOUNT" ] && hdiutil detach "$MOUNT" -quiet 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> Downloading $TAG ($ARCH)"
gh release download "$TAG" --pattern "*${ARCH}.dmg" --dir "$WORK" --clobber
DMG="$(find "$WORK" -name '*.dmg' | head -1)"
[ -n "$DMG" ] || { echo "no .dmg matching *${ARCH}.dmg in $TAG" >&2; exit 1; }
echo "    $(basename "$DMG") ($(du -h "$DMG" | cut -f1))"

# Exactly what Safari writes. Without this every assessment below is meaningless,
# so it is applied before anything is inspected.
echo "==> Quarantining it, as a browser would"
xattr -w com.apple.quarantine "0081;$(printf %x "$(date +%s)");Safari;$(uuidgen)" "$DMG"
ok "com.apple.quarantine set"

echo "==> Mounting"
MOUNT="$(hdiutil attach -nobrowse -readonly "$DMG" | sed -n 's|.*\(/Volumes/.*\)|\1|p' | tail -1)"
APP="$(find "$MOUNT" -maxdepth 1 -name '*.app' | head -1)"
[ -n "$APP" ] || { echo "no .app inside the dmg" >&2; exit 1; }

echo "==> The app inside the disk image"
xcrun stapler validate "$APP" >/dev/null 2>&1 \
  && ok "stapled — first launch needs no network" \
  || bad "no stapled ticket: first launch will need Apple reachable, and fails without it"

assess="$(spctl -a -vvv -t exec "$APP" 2>&1 || true)"
case "$assess" in
  *"source=Notarized Developer ID"*) ok "Gatekeeper: accepted, Notarized Developer ID" ;;
  *) bad "Gatekeeper did not accept it: $(printf '%s' "$assess" | tr '\n' ' ')" ;;
esac

# The real install path. A user does not run the app from the mounted volume;
# they drag it out, and the copy inherits the quarantine flag.
echo "==> Dragged out of the volume, as a user installs it"
cp -R "$APP" "$WORK/"
DRAGGED="$WORK/$(basename "$APP")"
if xattr -p com.apple.quarantine "$DRAGGED" >/dev/null 2>&1; then
  ok "the copy inherited quarantine (so this is a real test, not a free pass)"
else
  # Not fatal, but it means the rest of this section proves less than it looks.
  note "the copy carries no quarantine — the checks below are weaker than intended"
fi
assess="$(spctl -a -vvv -t exec "$DRAGGED" 2>&1 || true)"
case "$assess" in
  *"source=Notarized Developer ID"*) ok "still accepted once installed" ;;
  *) bad "rejected after being copied out: $(printf '%s' "$assess" | tr '\n' ' ')" ;;
esac

# The check nothing else can make. Entitlements can be read statically, but only
# running the thing proves the hardened runtime lets V8 map and write executable
# memory — the failure that is invisible until it happens on a stranger's Mac.
echo "==> The Node sidecar, quarantined, under the hardened runtime"
SIDECAR="$(find "$DRAGGED/Contents/MacOS" -name '*-node' -o -name '*-node.exe' | head -1)"
if [ -z "$SIDECAR" ]; then
  bad "no sidecar found in Contents/MacOS — the app cannot serve anything"
else
  if ver="$("$SIDECAR" --version 2>&1)"; then
    ok "starts: $ver"
  else
    bad "the sidecar will not start: $ver"
  fi
  # A loop long enough to reach V8's optimizing compiler, so `allow-jit` and
  # `allow-unsigned-executable-memory` are exercised rather than merely declared.
  if out="$("$SIDECAR" -e 'let s=0;for(let i=0;i<3e7;i++)s+=i;console.log("jit-ok",s)' 2>&1)"; then
    case "$out" in
      *jit-ok*) ok "JIT works under the hardened runtime" ;;
      *) bad "unexpected output from the JIT check: $out" ;;
    esac
  else
    bad "JIT is blocked — check the entitlements: $out"
  fi
fi

echo
if [ "$fail" -eq 0 ]; then
  printf "${GREEN}${BOLD}PASS${RESET} — %s is what a user can download, install and run.\n" "$TAG"
else
  printf "${RED}${BOLD}FAIL${RESET} — %s would not work for a user. See above.\n" "$TAG"
fi
exit "$fail"
