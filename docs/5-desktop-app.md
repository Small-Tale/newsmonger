# 5 — Desktop App (Tauri)

Hybrid model borrowed from glassbox: the Node server is the app in both modes; Tauri is a thin shell whose webview loads `http://127.0.0.1:<port>` served by the same server the browser uses. There is no Rust backend logic.

## Status: dev-mode verified, release bundling deferred

- **FR-5.1** *(Shipped, verified on macOS)* `npm run tauri:dev` compiles, spawns the server from source (`node --import tsx src/cli.ts --no-open`), watches stdout for the `running at <url>` readiness line, navigates the webview there (verified via server request log: `GET /` → assets → `/api/state`), and SIGTERMs the server on normal quit. Until ready, a bundled loading page shows a spinner (with an error message if the server exits first). Navigation attempts are logged to stderr as `[shell] navigated to <url>` / `[shell] navigate failed: <err>`.
- **FR-5.2** *(Shipped)* The frontend detects Tauri via `window.__TAURI__` (`src/client/tauri.ts`) and routes external links through the server (`/api/open-external`), since the webview has no tabs.
- **FR-5.3** *(Design only — follow-up ticket)* Release builds bundle the tsup server output plus a real Node binary as a Tauri sidecar (glassbox pattern: `externalBin` + `resources`) and platform bundling (`bundle.active` is `false` until then; release builds show a "not wired up yet" message). App icons already exist (`src-tauri/icons/`, generated set — required even for dev compilation).

### Orphan protection (FR-5.4)

- **FR-5.4** *(Shipped, verified)* The spawned server exits itself when its parent dies without cleanup: the shell sets `NEWS_WATCH_PARENT=1`, and the server polls `process.ppid` every 2 s, shutting down when re-parented to init. This covers hard kills (SIGTERM/SIGKILL of the shell, where `RunEvent::Exit` never fires) and `tauri dev` rebuild restarts — each of which would otherwise orphan a server and push later instances down the port-fallback chain. Dev mode deliberately omits `--strict-port` for the same reason (glassbox precedent).

### Debug aids

- `NEWS_LOG_REQUESTS=1` makes the server log every request (`[req] GET /api/state`) to stderr — the reliable way to confirm the webview is actually talking to the server (note: WKWebView throttles timers in occluded windows, so the 4 s poll may pause while the window is hidden).

See also: [4 — CLI, Server, and Storage](4-cli-server-storage.md), glassbox's `docs/tauri-architecture.md` for the reference pattern.
