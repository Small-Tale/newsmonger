#!/usr/bin/env bash
# Build the Tauri sidecar: a real Node.js binary + the server bundle.
#
# The app is a Node server in both modes (see docs/5-desktop-app.md), so the
# release bundle ships an actual `node` binary as a Tauri sidecar plus the tsup
# server bundle and its external runtime deps as resources. We don't use a
# single-binary compiler (pkg / bun compile) — the server resolves client assets
# relative to import.meta.url, which those tools break.
#
# Usage:
#   bash scripts/build-sidecar.sh                       # host target
#   bash scripts/build-sidecar.sh aarch64-apple-darwin  # explicit target
set -euo pipefail
cd "$(dirname "$0")/.."

# 22.5 is the floor: the server uses the built-in `node:sqlite` (NEWS-94).
NODE_VERSION="v22.14.0"
# Target triple, in precedence order: explicit argument, then Tauri's own env var,
# then the host.
#
# **Reading the env var here rather than interpolating it in `beforeBuildCommand` is
# the whole point** (NEWS-211). That config used to say:
#
#   bash scripts/build-sidecar.sh "$TAURI_ENV_TARGET_TRIPLE"
#
# which works on macOS and Linux and cannot work on Windows: Tauri runs
# `beforeBuildCommand` through **cmd.exe**, which does not expand `$VAR`. bash then
# received the literal text and died with `Unsupported target:
# \$TAURI_ENV_TARGET_TRIPLE"`. An environment variable reaches the child process
# whatever shell launched it, so letting the script read it is portable where
# interpolating it is not.
TARGET="${1:-}"

# Defend against that shape coming back. Without this the symptom is a baffling
# "Unsupported target" naming a variable, on Windows only.
case "$TARGET" in
  *'$'*|*'%'*)
    echo "warning: ignoring an unexpanded variable reference as the target: $TARGET" >&2
    echo "         Pass a real triple, or let \$TAURI_ENV_TARGET_TRIPLE through." >&2
    TARGET=""
    ;;
esac

[ -n "$TARGET" ] || TARGET="${TAURI_ENV_TARGET_TRIPLE:-}"
[ -n "$TARGET" ] || TARGET="$(rustc --print host-tuple 2>/dev/null || echo unknown)"

case "$TARGET" in
  aarch64-apple-darwin)      NODE_PLATFORM="darwin-arm64" ;;
  x86_64-apple-darwin)       NODE_PLATFORM="darwin-x64" ;;
  x86_64-pc-windows-msvc)    NODE_PLATFORM="win-x64" ;;
  x86_64-unknown-linux-gnu)  NODE_PLATFORM="linux-x64" ;;
  aarch64-unknown-linux-gnu) NODE_PLATFORM="linux-arm64" ;;
  *) echo "Unsupported target: $TARGET" >&2; exit 1 ;;
esac

EXT=""
[[ "$TARGET" == *windows* ]] && EXT=".exe"
SIDECAR="src-tauri/binaries/newsmonger-node-${TARGET}${EXT}"
SERVER_DIR="src-tauri/server"

echo "==> Building sidecar for $TARGET"

# --- 1. Server + client bundles ---
npm run build
npm run build:client

# --- 2. Node binary for the target platform ---
mkdir -p src-tauri/binaries
if [ -f "$SIDECAR" ] && [ "$(wc -c < "$SIDECAR" | tr -d ' ')" -gt 1000000 ]; then
  echo "==> Node binary already present: $SIDECAR"
else
  rm -f "$SIDECAR"
  echo "==> Downloading Node $NODE_VERSION for $NODE_PLATFORM"
  if [[ "$TARGET" == *windows* ]]; then
    ARCHIVE="node-${NODE_VERSION}-${NODE_PLATFORM}.zip"
    curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${ARCHIVE}" -o "/tmp/${ARCHIVE}"
    unzip -jo "/tmp/${ARCHIVE}" "node-${NODE_VERSION}-${NODE_PLATFORM}/node.exe" -d src-tauri/binaries/
    mv src-tauri/binaries/node.exe "$SIDECAR"
    rm -f "/tmp/${ARCHIVE}"
  else
    ARCHIVE="node-${NODE_VERSION}-${NODE_PLATFORM}.tar.gz"
    curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${ARCHIVE}" -o "/tmp/${ARCHIVE}"
    tar -xzf "/tmp/${ARCHIVE}" -C /tmp "node-${NODE_VERSION}-${NODE_PLATFORM}/bin/node"
    mv "/tmp/node-${NODE_VERSION}-${NODE_PLATFORM}/bin/node" "$SIDECAR"
    rm -rf "/tmp/${ARCHIVE}" "/tmp/node-${NODE_VERSION}-${NODE_PLATFORM}"
  fi
  chmod +x "$SIDECAR"
fi
echo "    $SIDECAR ($(du -h "$SIDECAR" | cut -f1))"

# --- 3. Stage the server bundle + its runtime deps as resources ---
echo "==> Staging $SERVER_DIR"
rm -rf "$SERVER_DIR"
mkdir -p "$SERVER_DIR/client"
cp dist/cli.js "$SERVER_DIR/"
# The server resolves client assets as ./client relative to cli.js (see
# clientDir() in src/server.ts), so these must sit next to it.
#
# Copy *everything* `build:client` produced rather than naming files (NEWS-203).
# This line used to hardcode four filenames, which made it a **third** asset list
# — after `build:client` and `build:client:dev` — and an invisible one: CLAUDE.md
# tells you to update "both copy lists". So when the masthead wordmarks were added
# to those two, this one was missed, and `/static/wordmark-*.svg` 404'd in every
# packaged build while working perfectly in dev and in every test.
#
# Sourcemaps are the one deliberate exclusion: they are large, only useful next to
# a dev build, and would ship the client source inside the app bundle.
find dist/client -maxdepth 1 -type f ! -name '*.map' -exec cp {} "$SERVER_DIR/client/" \;
echo "    client assets: $(find "$SERVER_DIR/client" -maxdepth 1 -type f | wc -l | tr -d ' ') files"

# A package.json beside cli.js does two things: it pins the dependency set that
# `npm install` below resolves, and its `"type": "module"` declares the bundle as
# ESM. Node 22 would infer that anyway by sniffing the syntax, but only after
# failing to parse it as CommonJS and reparsing (MODULE_TYPELESS_PACKAGE_JSON) —
# declaring it skips the guesswork.
node -e '
  const root = require("./package.json");
  require("fs").writeFileSync("src-tauri/server/package.json", JSON.stringify({
    name: "newsmonger-server", version: root.version, private: true, type: "module",
    dependencies: root.dependencies,
  }, null, 2) + "\n");
'
# `npm install` rather than copying node_modules/<dep>: the deps have their own
# transitive deps (e.g. @anthropic-ai/sdk -> standardwebhooks, kerfjs ->
# @preact/signals-core) that a top-level copy silently omits.
(cd "$SERVER_DIR" && npm install --omit=dev --no-audit --no-fund --silent)

echo "==> Staged ($(du -sh "$SERVER_DIR" | cut -f1) of resources)"

# --- 4. Verify the staged bundle actually boots ---
# This MUST run from a copy outside the repo. Run in place and Node walks up to
# the project's own package.json and node_modules, so a missing "type": "module"
# or an incomplete dependency closure resolves anyway and the broken bundle
# looks fine — right up until it's installed on a real machine.
HOST_TRIPLE="$(rustc --print host-tuple 2>/dev/null || echo unknown)"
if [ "$TARGET" != "$HOST_TRIPLE" ]; then
  echo "==> Skipping boot check (cross-compiling $TARGET on $HOST_TRIPLE)"
else
  echo "==> Verifying the staged bundle boots in isolation"
  VERIFY_DIR="$(mktemp -d)"
  trap 'rm -rf "$VERIFY_DIR"' EXIT
  cp -R "$SERVER_DIR" "$VERIFY_DIR/server"

  VERIFY_PORT=4291
  "./$SIDECAR" "$VERIFY_DIR/server/cli.js" --no-open --strict-port --ai-test \
    --port "$VERIFY_PORT" --data-dir "$VERIFY_DIR/data" > "$VERIFY_DIR/out.log" 2>&1 &
  VERIFY_PID=$!

  ok=""
  for _ in $(seq 1 30); do
    if grep -q "running at " "$VERIFY_DIR/out.log" 2>/dev/null; then ok=1; break; fi
    kill -0 "$VERIFY_PID" 2>/dev/null || break
    sleep 0.5
  done

  # The readiness line only proves it started. Fetch every staged client asset
  # too, since those are staged separately and resolved relative to cli.js.
  #
  # Derived from what is on disk, NOT a list (NEWS-203). This check exists to
  # catch staging mistakes, and it previously fetched `/static/app.js` and
  # `/static/styles.css` — a hardcoded pair that happened to name two assets that
  # *were* staged. When the wordmarks went missing from the bundle it sailed
  # straight past them, and a broken masthead shipped. A check with its own
  # hardcoded list cannot catch a hardcoded list being wrong.
  #
  # `app.global.js` is served at `/static/app.js`, so the URL is not always the
  # filename — that mapping is the one thing still stated explicitly.
  if [ -n "$ok" ]; then
    paths="/healthz"
    for f in "$VERIFY_DIR"/server/client/*; do
      [ -f "$f" ] || continue
      name="$(basename "$f")"
      case "$name" in
        app.global.js) paths="$paths /static/app.js" ;;
        *)             paths="$paths /static/$name" ;;
      esac
    done
    for path in $paths; do
      code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${VERIFY_PORT}${path}")"
      if [ "$code" = "200" ]; then
        echo "    200 $path"
      else
        echo "    $path returned $code" >&2
        ok=""
      fi
    done
  fi

  kill "$VERIFY_PID" 2>/dev/null || true
  wait "$VERIFY_PID" 2>/dev/null || true

  if [ -z "$ok" ]; then
    echo "!! Staged bundle failed to boot:" >&2
    cat "$VERIFY_DIR/out.log" >&2
    exit 1
  fi
  echo "    server booted and served client assets"
fi

echo "==> Sidecar ready"
