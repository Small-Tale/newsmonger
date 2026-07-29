# 5 — Desktop App (Tauri)

Hybrid model borrowed from glassbox: the Node server is the app in both modes; Tauri is a thin shell whose webview loads `http://127.0.0.1:<port>` served by the same server the browser uses. There is no Rust backend logic.

## Status: dev and release both verified on macOS

- **FR-5.1** *(Shipped, verified on macOS)* `npm run tauri:dev` compiles, spawns the server from source (`node --import tsx src/cli.ts --no-open`), watches stdout for the `running at <url>` readiness line, navigates the webview there (verified via server request log: `GET /` → assets → `/api/state`), and SIGTERMs the server on normal quit. Until ready, a bundled loading page shows a spinner (with an error message if the server exits first). Navigation attempts are logged to stderr as `[shell] navigated to <url>` / `[shell] navigate failed: <err>`.
- **FR-5.2** *(Shipped)* The frontend detects Tauri via `window.__TAURI__` (`src/client/tauri.ts`) and routes external links through the server (`/api/open-external`), since the webview has no tabs.
- **FR-5.3** *(Shipped, verified on macOS)* `npm run tauri:build` produces a self-contained app: a real Node binary ships beside the app executable as an `externalBin` sidecar (`newsmonger-node`), and the tsup server bundle plus its client assets and full dependency tree are staged into `resources/server/`. The release shell resolves both and spawns the server exactly as dev mode does — same readiness-line watch, same navigation, same shutdown. `scripts/build-sidecar.sh` produces all of it and runs as `beforeBuildCommand`, so `tauri build` is self-contained. App icons live in `src-tauri/icons/`, generated from `assets/logo-full-bleed.svg` with `npx tauri icon` (required even for dev compilation). Regenerate from that source rather than editing the PNGs (see `docs/3-ui.md` for why the *full-bleed* variant is the source, which is a deliberate choice against the macOS convention) — and delete the `android/` and `ios/` directories it also writes, since this is a desktop-only app and ~30 unused mobile icons is dead weight in the tree.

  **Verified end to end:** the built `Newsmonger.app` starts its sidecar, serves the real UI (request log shows `GET /` → assets → `/api/state` → `/api/providers`), and leaves no orphaned server on quit. Only macOS (`aarch64-apple-darwin`) has been built and run; the other target triples are wired but untested, as is the Windows `CREATE_NO_WINDOW` flag.

  The sidecar Node must be **22.5 or newer** — the server stores its data through the built-in `node:sqlite` (FR-4.8). `scripts/build-sidecar.sh` pins v22.14.0.

  **Why a real Node binary rather than a single-file executable:** the server resolves its client assets relative to `import.meta.url`, which single-binary compilers (`pkg`, `bun build --compile`) break.

  **Why `npm install` rather than copying `node_modules/<dep>`:** the runtime deps have transitive deps of their own (`@anthropic-ai/sdk` → `standardwebhooks`, `kerfjs` → `@preact/signals-core`), and a top-level copy silently omits them.

  The dependency split has one source of truth: tsup's default externalizes exactly the `dependencies` in `package.json` and bundles everything else, and the sidecar script installs those same `dependencies`. Neither side keeps a hand-maintained list.

### Gotcha: verify the staged bundle from outside the repo

`scripts/build-sidecar.sh` finishes by copying `src-tauri/server/` to a temp dir and booting it there, checking for the readiness line **and** fetching `/healthz` and both client assets. The copy is the whole point. Run the staged bundle in place and Node walks up to the project's own `package.json` and `node_modules`, so a bundle with an incomplete dependency closure resolves anyway and looks healthy — right up until it runs on a machine that has no repo around it. This bug was real, and it passed an in-place smoke test before the isolated one caught it.

The check is skipped when cross-compiling, since the downloaded Node binary won't run on the build host.

### Orphan protection (FR-5.4)

- **FR-5.4** *(Shipped, verified)* The spawned server exits itself when its parent dies without cleanup: the shell sets `NEWSMONGER_WATCH_PARENT=1`, and the server polls `process.ppid` every 2 s, shutting down when re-parented to init. This covers hard kills (SIGTERM/SIGKILL of the shell, where `RunEvent::Exit` never fires) and `tauri dev` rebuild restarts — each of which would otherwise orphan a server and push later instances down the port-fallback chain. Dev mode deliberately omits `--strict-port` for the same reason (glassbox precedent).

### Debug aids

- `NEWSMONGER_LOG_REQUESTS=1` makes the server log every request (`[req] GET /api/state`) to stderr — the reliable way to confirm the webview is actually talking to the server (note: WKWebView throttles timers in occluded windows, so the 4 s poll may pause while the window is hidden).

See also: [4 — CLI, Server, and Storage](4-cli-server-storage.md), glassbox's `docs/tauri-architecture.md` for the reference pattern.

## Code signing and notarization (NEWS-21)

An unsigned bundle opens on the machine that built it and nowhere else. Gatekeeper blocks it everywhere a stranger might run it, which is the only place it matters — and the build machine cannot reproduce that, because it trusts its own certificate and never quarantines a file it made itself.

- **FR-5.5** *(Partial — config shipped, credentials outstanding)* Release bundles are signed with a **Developer ID Application** certificate and notarized. Nothing identity-specific is committed: Tauri reads `APPLE_SIGNING_IDENTITY` (or `APPLE_CERTIFICATE` + `APPLE_CERTIFICATE_PASSWORD` in CI) and, for notarization, either `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID` or the App Store Connect key trio `APPLE_API_ISSUER` + `APPLE_API_KEY` + `APPLE_API_KEY_PATH`.

- **FR-5.6** *(Shipped)* `src-tauri/entitlements.plist` grants the hardened runtime exceptions **the Node sidecar cannot run without**, and no others.

  This is the trap in signing a Tauri app whose sidecar is a JavaScript runtime. Notarization requires the hardened runtime (Tauri enables it by default), and the hardened runtime blocks exactly what V8 does — writing and executing code at runtime. Get this wrong and the app signs, notarizes and staples cleanly, then dies at launch on someone else's Mac. Every check up to that point is green.

  The set is Node's own, minus three:

  | Entitlement | Why |
  |---|---|
  | `cs.allow-jit` | V8 compiles JavaScript at runtime |
  | `cs.allow-unsigned-executable-memory` | V8 maps executable pages it did not sign |
  | `cs.disable-executable-page-protection` | V8 writes and executes the same pages |
  | ~~`get-task-allow`~~ | **The notary service rejects it.** Node ships it because Node's binaries are signed but not notarized; ours are both |
  | ~~`cs.allow-dyld-environment-variables`~~ | Nothing sets `DYLD_*` for the sidecar, and it is an injection surface |
  | ~~`cs.disable-library-validation`~~ | The staged tree has no native addons. **This is the one to add if a native dependency ever appears** — the failure will look like an unexplained `dlopen` error |

- **FR-5.7** *(Shipped)* `bash scripts/verify-signing.sh` asserts, on the build machine, the properties Gatekeeper will check on someone else's: a Developer ID authority, the hardened runtime flag, the sidecar's JIT entitlements, the *absence* of `get-task-allow`, a deep strict `codesign --verify`, `spctl` reporting `source=Notarized Developer ID`, and a stapled ticket on **both** the app and the `.dmg` — notarizing the app does not notarize the disk image it ships in.

  Run against the current unsigned build it reports exactly what is missing, including that the sidecar inherits `get-task-allow` from Node's own signature. That was found by running it, not by reasoning about it.

### What still needs a human

Everything below requires the Apple Developer account and must not be committed:

1. **Create a Developer ID Application certificate** (Apple Developer → Certificates) and install it in the login keychain. `security find-identity -v -p codesigning` should then list it.
2. **Get the Team ID** from the membership page.
3. **Create an app-specific password** at appleid.apple.com (Sign-In and Security → App-Specific Passwords) for notarization — *not* the Apple ID password. The App Store Connect API key is the better option for CI, since it isn't tied to one person's account.
4. **Export the certificate as `.p12`** only when CI needs it (NEWS-6); a local build uses the keychain directly and needs no export.

Then a signed local build is `APPLE_SIGNING_IDENTITY="Developer ID Application: … (TEAMID)" APPLE_ID=… APPLE_PASSWORD=… APPLE_TEAM_ID=… npm run tauri:build`, followed by `bash scripts/verify-signing.sh`.

**Windows Authenticode** is untouched — no Windows bundle has been verified at all yet (NEWS-20), so signing one would be signing something unproven.

### If the app icon looks stale in dev

`tauri dev` runs the bare executable, not a bundle, and `generate_context!` compiles the icon **into the binary** — so the Dock icon in dev comes from whatever was embedded the last time the Rust crate was built, not from `src-tauri/icons/` on disk. Regenerating the icons changes nothing until something rebuilds.

The crate does recompile on every `cargo build` here, so the next `tauri dev` picks it up; a binary showing old artwork simply predates the icon change. To confirm rather than guess, search the binary for the icon's bytes:

```sh
python3 -c "
new = open('src-tauri/icons/icon.png','rb').read()
blob = open('src-tauri/target/debug/news','rb').read()
c = new[len(new)//2:len(new)//2+256]
print('embedded:', c in blob)"
```

If that says `True` and the Dock still disagrees, it is macOS's icon cache rather than the build.
