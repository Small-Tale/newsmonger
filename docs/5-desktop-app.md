# 5 — Desktop App (Tauri)

Hybrid model borrowed from glassbox: the Node server is the app in both modes; Tauri is a thin shell whose webview loads `http://127.0.0.1:<port>` served by the same server the browser uses. There is no Rust backend logic.

## Status: dev-mode wired, release bundling deferred

- **FR-5.1** *(Shipped, unverified — needs a Rust toolchain run)* `npm run tauri:dev` spawns the server from source (`node --import tsx src/cli.ts --no-open`), watches stdout for the `running at <url>` readiness line, navigates the webview there, and SIGTERMs the server on exit. Until ready, a bundled loading page shows a spinner (with an error message if the server exits first).
- **FR-5.2** *(Shipped)* The frontend detects Tauri via `window.__TAURI__` (`src/client/tauri.ts`) and routes external links through the server (`/api/open-external`), since the webview has no tabs.
- **FR-5.3** *(Design only — follow-up ticket)* Release builds bundle the tsup server output plus a real Node binary as a Tauri sidecar (glassbox pattern: `externalBin` + `resources`), including app icons and platform bundling. `bundle.active` is `false` until then, and release builds show a "not wired up yet" message.

See also: [4 — CLI, Server, and Storage](4-cli-server-storage.md), glassbox's `docs/tauri-architecture.md` for the reference pattern.
