# 5 — Desktop App (Tauri)

Hybrid model borrowed from glassbox: the Node server is the app in both modes; Tauri is a thin shell whose webview loads `http://127.0.0.1:<port>` served by the same server the browser uses. There is no Rust backend logic.

## Status: dev and release both verified on macOS

- **FR-5.1** *(Shipped, verified on macOS)* `npm run tauri:dev` compiles, spawns the server from source (`node --import tsx src/cli.ts --no-open`), watches stdout for the `running at <url>` readiness line, navigates the webview there (verified via server request log: `GET /` → assets → `/api/state`), and SIGTERMs the server on normal quit. Until ready, a bundled loading page shows a spinner (with an error message if the server exits first). Navigation attempts are logged to stderr as `[shell] navigated to <url>` / `[shell] navigate failed: <err>`.
- **FR-5.2** *(Shipped)* The frontend detects Tauri via `window.__TAURI__` (`src/client/tauri.ts`) and routes external links through the server (`/api/open-external`), since the webview has no tabs.
- **FR-5.3** *(Shipped, verified on macOS)* `npm run tauri:build` produces a self-contained app: a real Node binary ships beside the app executable as an `externalBin` sidecar (`news-node`), and the tsup server bundle plus its client assets and full dependency tree are staged into `resources/server/`. The release shell resolves both and spawns the server exactly as dev mode does — same readiness-line watch, same navigation, same shutdown. `scripts/build-sidecar.sh` produces all of it and runs as `beforeBuildCommand`, so `tauri build` is self-contained. App icons live in `src-tauri/icons/` (generated set — required even for dev compilation).

  **Verified end to end:** the built `News.app` starts its sidecar, serves the real UI (request log shows `GET /` → assets → `/api/state` → `/api/providers`), and leaves no orphaned server on quit. Only macOS (`aarch64-apple-darwin`) has been built and run; the other target triples are wired but untested, as is the Windows `CREATE_NO_WINDOW` flag.

  **Why a real Node binary rather than a single-file executable:** the server resolves its client assets relative to `import.meta.url`, which single-binary compilers (`pkg`, `bun build --compile`) break.

  **Why `npm install` rather than copying `node_modules/<dep>`:** the runtime deps have transitive deps of their own (`@anthropic-ai/sdk` → `standardwebhooks`, `kerfjs` → `@preact/signals-core`), and a top-level copy silently omits them.

  The dependency split has one source of truth: tsup's default externalizes exactly the `dependencies` in `package.json` and bundles everything else, and the sidecar script installs those same `dependencies`. Neither side keeps a hand-maintained list.

### Gotcha: verify the staged bundle from outside the repo

`scripts/build-sidecar.sh` finishes by copying `src-tauri/server/` to a temp dir and booting it there, checking for the readiness line **and** fetching `/healthz` and both client assets. The copy is the whole point. Run the staged bundle in place and Node walks up to the project's own `package.json` and `node_modules`, so a bundle with an incomplete dependency closure resolves anyway and looks healthy — right up until it runs on a machine that has no repo around it. This bug was real, and it passed an in-place smoke test before the isolated one caught it.

The check is skipped when cross-compiling, since the downloaded Node binary won't run on the build host.

### Orphan protection (FR-5.4)

- **FR-5.4** *(Shipped, verified)* The spawned server exits itself when its parent dies without cleanup: the shell sets `NEWS_WATCH_PARENT=1`, and the server polls `process.ppid` every 2 s, shutting down when re-parented to init. This covers hard kills (SIGTERM/SIGKILL of the shell, where `RunEvent::Exit` never fires) and `tauri dev` rebuild restarts — each of which would otherwise orphan a server and push later instances down the port-fallback chain. Dev mode deliberately omits `--strict-port` for the same reason (glassbox precedent).

### Debug aids

- `NEWS_LOG_REQUESTS=1` makes the server log every request (`[req] GET /api/state`) to stderr — the reliable way to confirm the webview is actually talking to the server (note: WKWebView throttles timers in occluded windows, so the 4 s poll may pause while the window is hidden).

See also: [4 — CLI, Server, and Storage](4-cli-server-storage.md), glassbox's `docs/tauri-architecture.md` for the reference pattern.
