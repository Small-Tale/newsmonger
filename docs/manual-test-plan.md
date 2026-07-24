# Manual Test Plan

Features that can't be reliably automated (yet). Remove entries as automated coverage lands and note the move under "Automated Coverage Summary".

## Real Claude news checks (needs `ANTHROPIC_API_KEY`) — ✅ verified 2026-07-24

Verified against the live API (NEWS-3): real current stories with citations that resolve (HTTP 200), prompt-level dedup on re-check, an empty list for an obscure topic (no padding), and actionable missing-key errors. Perfect JSON compliance — `parseNewsResult` succeeded first try on every response. Note: a check takes ~4 min at default effort; see NEWS-19.

1. `npm run dev` with a valid key; add a topic with active news coverage (e.g. "artificial intelligence").
2. Click **Check** — within a couple of minutes, items should appear with plausible titles, 2–4 sentence summaries, and working links to real news articles.
3. Click **Check** again immediately — expect zero or few new items (dedup against the first batch; the model is told what was already reported).
4. Add a very obscure topic — expect a successful check with no items ("Nothing found yet" only if no other topic has items).
5. Unset the key and check — expect the run to fail and the warning banner to name the topic with an auth error.

## Real OpenAI checks (needs `OPENAI_API_KEY`)

1. `npm run dev --provider openai` (or set provider to OpenAI in Settings) with a valid key; add a topic with active coverage.
2. Check — expect live items with real source links (the Responses API `web_search` tool). Confirm the default model (`gpt-5`) is available to the account, or set `--model`.
3. Point `OPENAI_BASE_URL` / `--endpoint` at an OpenAI-compatible gateway and confirm it still works.


## Tauri desktop shell (needs Rust toolchain)

1. `npm run tauri:dev` — window shows the loading spinner, then the app once the server prints its readiness line.
2. Click a source link — it should open in the system browser, not inside the webview.
3. Quit the app — the spawned `node` server process must exit too (`pgrep -f cli.ts`).
4. **Delete a topic (NEWS-39)**: select it and press Delete, or right-click → Delete. The **in-app** confirmation must appear (not a native OS dialog), and confirming must actually remove the topic. This is the case that failed with `window.confirm`, which no-ops in the WKWebView — and which no headless test can catch, since Playwright auto-accepts native dialogs. Also verify **Remove** on a stored API key confirms and removes.

## Tauri release bundle (needs Rust toolchain) — ✅ macOS verified 2026-07-24

`npm run tauri:build` then launch `src-tauri/target/release/bundle/macos/News.app`. Verified on `aarch64-apple-darwin` (NEWS-2): the sidecar starts, the webview navigates, the real UI loads (`NEWS_LOG_REQUESTS=1` shows `GET /` → assets → `/api/state` → `/api/providers`), and quitting leaves no orphaned `news-node`.

Still manual, and **unverified on every other platform**:

1. Build on Windows and Linux — confirm the target-triple → Node-platform mapping in `scripts/build-sidecar.sh` is right and the app launches.
2. On Windows, confirm no console window flashes when the sidecar spawns (`CREATE_NO_WINDOW`, written but never run).
3. Install from the `.dmg` (not just the build tree) and launch — confirms resources resolve from a real install location.
4. On macOS, the bundle is unsigned/unnotarized, so Gatekeeper will block it on another machine; signing is not set up.

## System browser opening

1. `npm run dev` (without `--no-open`) — the default browser should open to the app.

## API key storage — ✅ all three platforms verified 2026-07-24

macOS (real Keychain), Linux (Docker, both with and without a Secret Service daemon) and Windows 11 (Parallels VM) all pass an identical round-trip harness: absent-reads-null, write/read, overwrite, a >128-character key, special characters including non-ASCII and emoji, delete, and idempotent delete. Three real Windows bugs were fixed in the process — see [7 — API Keys](7-api-keys.md).

> **When testing the keychain by hand, never use the production account names.** A harness that used `anthropic-api-key` deleted a real stored key on cleanup. Use a scratch account (`harness-scratch-do-not-use`) — the production accounts hold live credentials.

E2E still covers the UI against an in-memory store (`NEWS_FAKE_KEYCHAIN=1`), which by design exercises nothing below `src/keychain.ts`, so the OS layer stays manual.

Still worth doing by hand, since the harness exercises `src/keychain.ts` directly rather than the UI:

1. **Through the app on each platform**: save a key in Settings, restart, and confirm it is still found.
2. **Linux, headless**: with `secret-tool` installed but no daemon, confirm the dialog reports no keyring and disables the inputs. (The harness covers the probe; this covers the *rendering*, which is FR-7.11's untested half.)
3. **KWallet** rather than GNOME Keyring — only gnome-keyring has been exercised.

## Claude subscription provider (`claude-cli`, needs Claude Code signed in)

Unit tests inject a fake runner and never spawn the CLI, so the live path is manual.

1. With `claude` installed and logged in, and **no** `ANTHROPIC_API_KEY` set, open Settings and pick "Claude subscription (Claude Code)". The status line should read ready, and a note should explain that scheduled checks run only while News is open.
2. Check a topic with active coverage — expect real current stories with working links. Takes minutes, not seconds (a measured run was 161 s / 21 turns).
3. Run `claude logout`, then check again — expect an actionable "Claude Code is not signed in" error rather than a hang.
4. With `auto` selected and both a subscription and an API key available, confirm the run uses the subscription (the feed's "last check via" says `claude-cli`).
5. Background the app and confirm scheduled checks don't fire; return to it and confirm the due check runs.

## ChatGPT subscription provider (`codex-cli`, needs Codex signed in)

Same shape as the Claude one — unit tests inject a fake runner, so the live path is manual.

1. With `codex` installed and `~/.codex/auth.json` reporting `auth_mode: chatgpt`, pick "ChatGPT subscription (Codex)" in Settings and confirm the status reads ready.
2. Check a topic with active coverage — expect real current stories with working links.
3. Confirm Codex writes nothing: it runs `-s read-only`, so a check must not create or modify files in the working directory.
4. Sign out of Codex and check again — expect an actionable "Codex is not signed in" error.

## Automated Coverage Summary

- Topics CRUD, scheduling logic, dedup, parsing, API validation, and full UI flows are covered by `npm test` + `npm run test:e2e` (mock AI service).
- API key precedence, the `/api/keys` routes, and the Settings dialog save/remove flows are covered by `tests/unit/api-keys*.test.ts` and `tests/e2e/keys.spec.ts`, against the in-memory keychain (`NEWS_FAKE_KEYCHAIN=1`). The OS keychain layer itself stays manual per platform, above.
