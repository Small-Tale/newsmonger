#!/usr/bin/env bash
# Verify the sidecar build on real Linux, in Docker (NEWS-20).
#
#   bash scripts/verify-sidecar-linux.sh              # both Linux triples
#   bash scripts/verify-sidecar-linux.sh x86_64-unknown-linux-gnu
#
# `scripts/build-sidecar.sh` maps a target triple to a Node platform and
# downloads the matching binary. Until this existed, only `aarch64-apple-darwin`
# had ever been exercised — the Linux mappings were written and never run.
#
# **The reason to run this in a container rather than cross-compile from macOS**
# is the boot check at the end of `build-sidecar.sh`. That check runs the staged
# bundle from a directory outside the repo, which is the only way to catch a
# missing `"type": "module"` or an incomplete dependency closure — run in place,
# Node walks up to the project's own `package.json` and `node_modules` and a
# broken bundle looks fine. It **self-skips when cross-compiling**, because the
# downloaded binary can't run on the build host. Inside a Linux container the
# target *is* the host, so it runs for real.
#
# Not covered here, and not coverable here: building the Tauri bundle itself
# (`.deb`/`.AppImage`) and launching the packaged app. Those need the GTK/WebKit
# stack and a desktop session — a VM, not a container. See NEWS-20.
set -euo pipefail
cd "$(dirname "$0")/.."

TRIPLES=("${@:-}")
if [ -z "${1:-}" ]; then
  TRIPLES=(x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu)
fi

# The rust image is here for `rustc --print host-tuple`, which is how
# `build-sidecar.sh` decides whether it is cross-compiling. Without a real rustc
# it reports `unknown`, the triples don't match, and the boot check — the whole
# reason for running on Linux — silently skips.
IMAGE="rust:1-bookworm"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "the docker daemon is not reachable" >&2; exit 1; }

for TRIPLE in "${TRIPLES[@]}"; do
  case "$TRIPLE" in
    x86_64-unknown-linux-gnu)  PLATFORM="linux/amd64"; NARCH="x64" ;;
    aarch64-unknown-linux-gnu) PLATFORM="linux/arm64"; NARCH="arm64" ;;
    *) echo "not a Linux target triple: $TRIPLE" >&2; exit 1 ;;
  esac

  echo "==> $TRIPLE on $PLATFORM"
  # The repo is mounted read-only and copied inside, so a container build can
  # never write into the working tree — it would leave a Linux `node_modules`
  # and a Linux sidecar behind for the next macOS build to trip over.
  docker run --rm --platform "$PLATFORM" -v "$PWD":/src:ro "$IMAGE" bash -euo pipefail -c "
    export DEBIAN_FRONTEND=noninteractive
    curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-${NARCH}.tar.xz -o /tmp/node.tar.xz
    mkdir -p /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
    export PATH=/opt/node/bin:\$PATH
    cp -a /src /build
    rm -rf /build/node_modules /build/dist /build/src-tauri/binaries /build/src-tauri/server
    cd /build
    npm ci --no-audit --no-fund --silent
    bash scripts/build-sidecar.sh '$TRIPLE'
    file 'src-tauri/binaries/newsmonger-node-$TRIPLE'
  "
  echo "==> $TRIPLE ok"
done

echo
echo "✓ sidecar verified on Linux for: ${TRIPLES[*]}"
