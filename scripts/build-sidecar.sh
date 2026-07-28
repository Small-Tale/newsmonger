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
# Tauri passes $TAURI_ENV_TARGET_TRIPLE to beforeBuildCommand, but it expands to
# an empty string outside a Tauri build — fall back to the host triple.
TARGET="${1:-}"
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
SIDECAR="src-tauri/binaries/news-node-${TARGET}${EXT}"
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
cp dist/client/app.global.js dist/client/styles.css dist/client/favicon.svg dist/client/logo-full-bleed.svg "$SERVER_DIR/client/"

# A package.json beside cli.js does two things: it pins the dependency set that
# `npm install` below resolves, and its `"type": "module"` declares the bundle as
# ESM. Node 22 would infer that anyway by sniffing the syntax, but only after
# failing to parse it as CommonJS and reparsing (MODULE_TYPELESS_PACKAGE_JSON) —
# declaring it skips the guesswork.
node -e '
  const root = require("./package.json");
  require("fs").writeFileSync("src-tauri/server/package.json", JSON.stringify({
    name: "news-server", version: root.version, private: true, type: "module",
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

  # The readiness line only proves it started; fetch a client asset too, since
  # those are staged separately and resolved relative to cli.js.
  if [ -n "$ok" ]; then
    for path in /healthz /static/app.js /static/styles.css; do
      code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${VERIFY_PORT}${path}")"
      [ "$code" = "200" ] || { echo "    $path returned $code" >&2; ok=""; }
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
