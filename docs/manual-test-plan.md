# Manual Test Plan

Features that can't be reliably automated (yet). Remove entries as automated coverage lands and note the move under "Automated Coverage Summary".

## Real Claude news checks (needs `ANTHROPIC_API_KEY`) — ✅ verified 2026-07-24

Verified against the live API (NEWS-3): real current stories with citations that resolve (HTTP 200), prompt-level dedup on re-check, an empty list for an obscure topic (no padding), and actionable missing-key errors. Perfect JSON compliance — `parseNewsResult` succeeded first try on every response. Note: a check takes ~4 min at default effort; see NEWS-19.

1. `npm run dev` with a valid key; add a topic with active news coverage (e.g. "artificial intelligence").
2. Click **Check** — within a couple of minutes, items should appear with plausible titles, 2–4 sentence summaries, and working links to real news articles.
3. Click **Check** again immediately — expect zero or few new items (dedup against the first batch; the model is told what was already reported).
4. Add a very obscure topic — expect a successful check with no items ("Nothing found yet" only if no other topic has items).
5. Unset the key and check — expect the run to fail and the warning banner to name the topic with an auth error.

## First-run onboarding on a genuinely fresh install — NEWS-78

The E2E suite shares one server whose state earlier specs build up, so it can never be in the no-topics/no-provider state that triggers the guide automatically. That path is manual.

1. `npm run dev --data-dir /tmp/newsmonger-fresh` with **no** `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` set and no Claude/Codex CLI signed in, in a browser profile that has never run Newsmonger (or clear `localStorage` for the origin).
2. The setup guide should open by itself, on the welcome step.
3. Step 2 should say a key is needed. With a signed-in `claude-cli` **or** `codex-cli`, it should instead list it under "Found a signed-in subscription" — verify both branches.
4. Pick two starter topics, choose an interval, click **Start watching**: both topics appear and both begin checking.
5. Reload — the guide must **not** reappear. Settings → "Show the setup guide again" must bring it back.

## Key verification (needs a real key) — NEWS-78

1. In Settings, paste a deliberately corrupted key (change a few characters of a real one). Saving should fail immediately with "…rejected that key", and the key must **not** be stored.
2. Paste the correct key — it should save.
3. Disconnect the network and save a key. It should be **accepted** (the check can't run, so it must not claim the key is bad).

## Citation verification against real sites (needs `ANTHROPIC_API_KEY`) — NEWS-83

Unit tests inject the probe; the **live** `probeLink` — real HEAD/ranged-GET behaviour against real news sites — is manual, and it is the half that matters, because the whole design rests on how outlets actually answer HEAD.

1. `npm run dev` with a valid key; run a check on an active topic.
2. Every story that appears should have at least one working link. Click a few.
3. Watch stderr: a line like `dropped N story/stories and M source link(s) that did not resolve` is expected occasionally and fine. **A run that drops most stories is not** — it means real outlets are being judged dead. If that happens, check whether they are 403-ing the ranged GET too, and widen the fallback rather than accepting the loss.
4. Disconnect the network mid-check: the run should still succeed with stories stored **unverified** (the probe failing must not lose the news).

## Source favicons against real outlets (needs a real provider) — NEWS-169

Unit tests cover origin canonicalisation, `<link rel=icon>` extraction against the markup shapes real sites use, the mark-and-sweep, and the schema round trip. What they cannot cover is **how real outlets actually answer** — which is the half that decides whether the feed looks finished or patchy. Under `--ai-test` no favicons are fetched at all (the mock's URLs are fictional), so this path never runs in the automated suite.

1. `npm run dev` with a real provider; run a check on a topic that pulls from several outlets.
2. Most source links should show the outlet's icon rather than the arrow. **A run where almost everything falls back to the arrow is the failure to look for** — it means real outlets are not being resolved, and the fix is to widen the candidate list (an `/apple-touch-icon.png` guess, or reading the *article* page's `<link>` rather than only the homepage's), not to accept the loss.
3. Check a mixed feed for **alignment**: rows with an icon and rows with the arrow must start their link text at the same x. The two are sized to match deliberately.
4. Check **dark mode**. Many favicons are near-black monochrome marks made for light browser chrome; the faint `--pine-soft` plate behind them exists for exactly that case. Anything that disappears into the paper is worth reporting.
5. Confirm the browser still makes **zero third-party requests** (DevTools → Network, filter by domain). Icons must come from `127.0.0.1` like every other image (FR-8.4).
6. Restart the app and confirm the icons are **still there** — the startup prune runs on boot, and a favicon missing from the mark set would be deleted silently (FR-8.18).

## Live price updates — NEWS-93

Unit tests cover the file and manifest paths with a stub fetch; these are the end-to-end halves.

1. Run the app, open Settings → Spending, note the estimate.
2. Edit `~/.newsmonger/prices.json` — double the input rate for the model in use — and save. Reopen Settings: the estimate should roughly double **without restarting the app**.
3. Break the file (delete a closing brace). The estimate must be unchanged and stderr should say the file is invalid — not silently drop to "—".
4. Point **Price updates** at an https URL serving the same JSON shape and restart. stderr should log `model prices updated from …` and `prices.json` should match the manifest.
5. Point it at a URL that 404s and restart: no crash, no log of success, prices unchanged.

## Token usage capture (needs `ANTHROPIC_API_KEY`) — NEWS-79

Unit tests inject usage; the mapping from a *real* `message.usage` block is manual.

1. `npm run dev` with a valid key; run one check on an active topic.
2. Open Settings → **Spending**. The month's estimate should be a plausible few cents, and the note should say how many checks it is based on — not "—", and not a count of unpriced checks (the default model is priced).
3. Set a **Monthly budget** below the current estimate. Within a minute the over-budget banner should appear and scheduled checks should stop; **Check now** must still work.
4. Clear the budget field — the banner goes away and scheduled checks resume.

## Real OpenAI checks (needs `OPENAI_API_KEY`)

1. `npm run dev --provider openai` (or set provider to OpenAI in Settings) with a valid key; add a topic with active coverage.
2. Check — expect live items with real source links (the Responses API `web_search` tool). Confirm the default model (`gpt-5`) is available to the account, or set `--model`.
3. Point `OPENAI_BASE_URL` / `--endpoint` at an OpenAI-compatible gateway and confirm it still works.


## Real topic discovery (needs a real provider) — NEWS-116/124–128

The E2E suite drives discovery end to end, but only against the deterministic mock: it proves the plumbing, the exclusions, the cache, the tuner's state machine and the round bound. What it cannot judge is whether the model's *answers* are any good, and that is most of the feature's value. See [24 — Topic Discovery](24-topic-discovery.md).

1. `npm run dev` with a real provider configured. Open the compass button beside the add-topic field.
2. **The describe door** — type something real and mixed ("i cycle and work in biotech"). Expect suggestions that follow from *both* interests rather than blending them, grouped under sections that make sense.
3. **Surprise me** — submit an empty box. Expect a genuine spread across different areas of life, not several variations on one theme. This is the instruction most likely to be ignored by a model reaching for its defaults.
4. **The mix (FR-24.10)** — confirm both `Ongoing story` and `Evergreen` badges appear, and that they are *right*: an ongoing label on a standing subject like "Formula 1" is the failure worth catching, since it promises news that will keep coming and then goes quiet.
5. **The section door** — browse to a subcategory and confirm suggestions are actually of that section, and that "Anything in X" ranges across the whole of it.
6. **Classification (FR-24.13)** — add a suggestion and confirm the topic lands in the filter-bar section its card previewed, with no second classification call.
7. **Guidance (FR-24.12)** — open the added topic's guidance and confirm the steer reads like a usable instruction ("race results and team news, not driver gossip"), not a restatement of the name. Then confirm its **first check** is visibly narrowed by it.
8. **Exclusions (FR-24.11)** — reopen discovery and confirm nothing you already follow is offered. The mock plants a duplicate on purpose so the *filter* is tested automatically; what needs a human is whether the model also avoids **near**-duplicates ("F1" when you follow "Formula 1"), which the filter cannot catch.
9. **The tuner** — pick ⌄ narrower on a card and run a few rounds. Confirm candidates genuinely narrow rather than restating the anchor, that ≈ similar gives adjacent subjects rather than synonyms, and that skipping steers *away* from a direction across rounds — the property the whole keep/skip design rests on.
10. **Cost** — copy a diagnostics bundle afterwards and confirm the `## Topic discovery` section reports the calls you made, with cache hits marked free. It also names the model: confirm discovery ran on the fast one (`claude-haiku-4-5` / `gpt-5-mini`) and not the check model (NEWS-132).
11. **Speed and quality on the fast model** — the reason for the smaller model is latency, so time a discovery call against a check. Then judge whether Haiku's suggestions are actually good enough: this is the one trade-off no test can evaluate, and if the mix, the classifications, or the guidance steers get noticeably worse, the model choice is what to revisit first.


## Tauri desktop shell (needs Rust toolchain)

1. `npm run tauri:dev` — window shows the loading spinner, then the app once the server prints its readiness line.
2. Click a source link — it should open in the system browser, not inside the webview.
3. Quit the app — the spawned `node` server process must exit too (`pgrep -f cli.ts`).
4. **Export a file (NEWS-157)**: Settings → Data → click each export link. Each must save a file via the system browser (`<a download>` is a no-op in the WKWebView — this is why the click is routed through `/api/open-external`). Automated in a browser and with a simulated `window.__TAURI__`, but the real webview's download behaviour is what this confirms.
5. **Delete a topic (NEWS-39)**: select it and press Delete, or right-click → Delete. The **in-app** confirmation must appear (not a native OS dialog), and confirming must actually remove the topic. This is the case that failed with `window.confirm`, which no-ops in the WKWebView — and which no headless test can catch, since Playwright auto-accepts native dialogs. Also verify **Remove** on a stored API key confirms and removes.

## Tauri release bundle (needs Rust toolchain) — ✅ macOS verified 2026-07-24

`npm run tauri:build` then launch `src-tauri/target/release/bundle/macos/Newsmonger.app`. Verified on `aarch64-apple-darwin` (NEWS-2): the sidecar starts, the webview navigates, the real UI loads (`NEWSMONGER_LOG_REQUESTS=1` shows `GET /` → assets → `/api/state` → `/api/providers`), and quitting leaves no orphaned `newsmonger-node`.

Still manual, and **unverified on every other platform**:

1. Build on Windows and Linux — confirm the target-triple → Node-platform mapping in `scripts/build-sidecar.sh` is right and the app launches.
2. On Windows, confirm no console window flashes when the sidecar spawns (`CREATE_NO_WINDOW`, written but never run).
3. Install from the `.dmg` (not just the build tree) and launch — confirms resources resolve from a real install location.
4. On macOS, signing config is in place (NEWS-21) but no build has been signed yet — the bundle is still unsigned, so Gatekeeper will block it on another machine. After a signed build, `bash scripts/verify-signing.sh` checks it mechanically; the one thing it cannot check is the launch itself, so **open the .dmg on a Mac that has never seen the app** and confirm the window loads. That is the only test that exercises the sidecar's entitlements under a real quarantine.

## App name and icon in the built bundle — NEWS-182 / NEWS-184

These share a cause — a bundle-level property that no unit test can see — so check them together.

`tests/unit/tauri-icons.test.ts` asserts the *declaration* and that the files exist. It cannot assert what the bundler produced, which is where this bug actually lived.

1. `npm run tauri:build`, then inspect the bundle directly — this is faster and more certain than looking at pictures:
   - `/usr/libexec/PlistBuddy -c "Print :CFBundleIconFile" <App>.app/Contents/Info.plist` should print a name, not `Does Not Exist`.
   - `find <App>.app -name '*.icns'` should find one under `Contents/Resources`.
2. Launch it and check all three places macOS shows an icon, because they read different things and can disagree: the **Dock**, **Finder** (the bundle in `/Applications` or wherever it was copied), and **About Newsmonger** in the app menu.
3. If Finder still shows the old or generic icon after a correct build, that is the **icon cache**, not the bundle — `touch` the app or relaunch Finder before concluding anything.
4. In `tauri dev` the Dock icon comes from whatever `generate_context!` embedded at the last Rust build, so a stale dev icon is expected and is not this bug (see FR-5.3's gotcha).
5. **Window title (NEWS-185).** The titlebar should show **no text** — just the traffic lights. Then confirm the title is still *set*, which is the half that is easy to break silently: the **Window** menu should list "Newsmonger", and right-clicking the Dock icon should list the window by name. `osascript -e 'tell application "System Events" to get name of window 1 of process "Newsmonger"'` reports it without needing to read menus. An empty result there means `title` was lost, not merely hidden.
6. **Name (NEWS-184).** `CFBundleExecutable` should be `Newsmonger`, and the fastest check on a *running* app is `lsappinfo list | grep -i newsmonger` — it should report `Newsmonger`, with helpers as `Newsmonger Networking` / `Newsmonger Web Content`. Lowercase anywhere in that output means the `[[bin]]` rename did not take. Hovering the Dock icon and opening its context menu are the user-visible versions of the same check.

## System browser opening

1. `npm run dev` (without `--no-open`) — the default browser should open to the app.

## API key storage — ✅ all three platforms verified 2026-07-24

macOS (real Keychain), Linux (Docker, both with and without a Secret Service daemon) and Windows 11 (Parallels VM) all pass an identical round-trip harness: absent-reads-null, write/read, overwrite, a >128-character key, special characters including non-ASCII and emoji, delete, and idempotent delete. Three real Windows bugs were fixed in the process — see [7 — API Keys](7-api-keys.md).

> **When testing the keychain by hand, never use the production account names.** A harness that used `anthropic-api-key` deleted a real stored key on cleanup. Use a scratch account (`harness-scratch-do-not-use`) — the production accounts hold live credentials.

E2E still covers the UI against an in-memory store (`NEWSMONGER_FAKE_KEYCHAIN=1`), which by design exercises nothing below `src/keychain.ts`, so the OS layer stays manual.

Still worth doing by hand, since the harness exercises `src/keychain.ts` directly rather than the UI:

1. **Through the app on each platform**: save a key in Settings, restart, and confirm it is still found.
2. **Linux, headless**: with `secret-tool` installed but no daemon, confirm the dialog reports no keyring and disables the inputs. (The harness covers the probe; this covers the *rendering*, which is FR-7.11's untested half.)
3. **KWallet** rather than GNOME Keyring — only gnome-keyring has been exercised.

## Claude subscription provider (`claude-cli`, needs Claude Code signed in)

Unit tests inject a fake runner and never spawn the CLI, so the live path is manual.

1. With `claude` installed and logged in, and **no** `ANTHROPIC_API_KEY` set, open Settings and pick "Claude subscription (Claude Code)". The status line should read ready, and a note should explain that scheduled checks run only while Newsmonger is open.
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

## New-item notifications in Tauri (NEWS-38) — needs a desktop run

Browser-verified (toggle, permission, firing, throttle). The native desktop path is manual. As of NEWS-66 the shell routes through the **notification plugin** (`tauri-plugin-notification`) because the web Notification API's request was a silent "denied" with no OS prompt in the WKWebView. Rust compiles and both client paths are unit-tested; the runtime below is what needs a real machine.

1. `npm run tauri:dev`, open Settings, toggle notifications on. **Confirm the real OS permission dialog appears** (the NEWS-66 fix — previously it just said "blocked"). Grant it.
2. Add a topic with active coverage on an API-key provider, background the app, and let a scheduled check run — confirm an OS notification appears **and** the dock icon bounces (macOS) / taskbar flashes.
3. Clicking the OS notification: on the plugin path it may not focus the window (no JS click handler) — the dock bounce still draws the eye. Note the behaviour.
4. Confirm nothing fires while the app is focused, and no more than once per 5 minutes.
5. Quit and relaunch with the toggle still on — confirm notifications still fire (the startup permission re-sync), without re-toggling.
6. If the plugin's `requestPermission()` still doesn't prompt (e.g. macOS requires a signed/bundled app rather than `tauri dev`), test again with `npm run tauri:build` — real notifications on macOS generally need the bundled app. Record which build works. (Related: NEWS-40.)

## Share a story in Tauri (NEWS-43) — run on macOS, works (NEWS-45)

**Outcome:** the owner ran this on macOS and reported the share sheet "seems to work" — so `navigator.share` is *not* a WKWebView no-op the way `window.confirm` is (NEWS-39). The OS-sheet path is the one macOS takes; the clipboard fallback does not fire there.

Recorded as the owner's observation from a live run, not as an instrumented result: nobody asserted the sheet's contents field-by-field, so treat "the sheet carries title + summary + link" as expected rather than confirmed. Keep the steps below — the fallback path still needs checking on Windows and Linux, neither of which has ever been bundle-verified (FR-5.3, NEWS-20), and a WebKit or Tauri upgrade could regress this on macOS with nothing to catch it.

Browser-verified both paths (OS-sheet path via a stubbed `navigator.share`, and the clipboard fallback + toast). The **real** desktop share sheet is manual, because `navigator.share` may be absent or a no-op in the WKWebView (cf. the `window.confirm` no-op in NEWS-39). The clipboard fallback is the reliable path and is what a WKWebView will use if the sheet doesn't work.

1. `npm run tauri:dev`, add a topic, run a check so there are stories.
2. Click a story's **share** button. If the OS share sheet opens, it should carry the title + summary + source link; cancelling it should do nothing (no toast).
3. If no share sheet appears, the story text must land on the clipboard and a **"Copied to clipboard"** toast must show and then fade. Paste somewhere to confirm the block (title, blank line, summary, blank line, URL).
4. If `navigator.share` works in the WKWebView, the fallback path won't fire — note which path this platform took (NEWS-45 tracks confirming the sheet in a live shell).

## Auto-update in a real signed build (NEWS-89) — needs two releases

Everything above the Tauri bridge is automated: the banner, install, retry, dismiss and both Settings outcomes run in `tests/e2e/update.spec.ts` against a faked `window.__TAURI__`, and the store transitions in `tests/unit/update.test.ts`. What no test can reach is the part that *is* the feature — a signed manifest fetched over the network and a binary actually replaced on disk. That needs two real releases, because an update requires something to update *from*.

Note the commands are `#[cfg(not(debug_assertions))]`-guarded, so **`tauri dev` will always report no update** — that is correct behaviour, not a failure. This has to be tested against installed release builds.

1. Cut a release (`npm run release:beta:auto` or `npm run release`) and let `release-desktop.yml` finish. Confirm the published release carries **`latest.json`** alongside the bundles, and that its `signature` fields are non-empty.
2. Install that build from the `.dmg` — a real install, not a run from `target/`. Launch it and confirm no update banner (it is current).
3. Settings → App → **Check for updates** → confirm "Newsmonger is up to date."
4. Cut a *second*, higher-versioned release the same way.
5. Relaunch the installed older app. Within ~13 s (the poll delays) confirm the banner reads "Newsmonger &lt;version&gt; is available."
6. Press **Install**, wait for "…is installed — restart to start using it." Quit and relaunch; confirm the running app is the new version (About panel / `appVersion` in the diagnostics bundle).
7. Confirm the update was **signature-verified rather than merely downloaded**: temporarily point `plugins.updater.endpoints` at a manifest signed by a *different* key, rebuild, and confirm the check fails instead of installing. This is the one step that actually tests the security property; skipping it means the pubkey has never been proven load-bearing.
8. Offline behaviour: pull the network and relaunch — confirm no banner, no error dialog, and **no delay to the window appearing** (the check is spawned, not awaited).

## Signed build still launches after the entitlement change (NEWS-215) — REQUIRED before the next release

`src-tauri/entitlements.plist` dropped `com.apple.security.cs.disable-executable-page-protection` to match glassbox. **No automated check can cover this.** Signing, notarization and stapling all succeed regardless of whether the entitlements are right; a wrong set fails only when the packaged app is *launched*, and only on the hardened runtime — i.e. on a signed build, not `tauri dev`.

The symptom to watch for is the sidecar dying instantly: the window opens on the loading page and never navigates, with the server process exiting immediately. `[server]` lines in the log would show a crash or nothing at all.

1. `npm run tauri:build:local --sign` (an unsigned build does **not** exercise this — the hardened runtime is what enforces it).
2. Launch the built `Newsmonger.app` from `Finder`, not from a terminal.
3. Confirm the window navigates past the loading spinner to the real UI — that alone proves the Node sidecar started and served a page under the hardened runtime.
4. Add a topic and let a check run, so V8 has done real JIT work rather than just booting.
5. If it fails: put `cs.disable-executable-page-protection` back **and verify that was the cause**, because a missing `cs.allow-jit` produces an identical symptom.

Worth doing on both an Apple Silicon and an Intel Mac if both are available, since the JIT paths differ.

## Automated Coverage Summary

- Topics CRUD, scheduling logic, dedup, parsing, API validation, and full UI flows are covered by `npm test` + `npm run test:e2e` (mock AI service).
- API key precedence, the `/api/keys` routes, and the Settings dialog save/remove flows are covered by `tests/unit/api-keys*.test.ts` and `tests/e2e/keys.spec.ts`, against the in-memory keychain (`NEWSMONGER_FAKE_KEYCHAIN=1`). The OS keychain layer itself stays manual per platform, above.
