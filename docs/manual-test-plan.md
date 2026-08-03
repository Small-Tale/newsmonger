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

## Global npm install — ✅ macOS verified 2026-07-31 (NEWS-216)

The published package is a separate artifact from the source tree, and the suite only inspects it statically (`tests/unit/npm-package.test.ts`): it can be broken while everything is green. The one thing that proves it is installing it.

```sh
mkdir -p /tmp/nm && npm pack --pack-destination /tmp/nm
npm install -g --prefix /tmp/nm-prefix /tmp/nm/newsmonger-<version>.tgz
PATH=/tmp/nm-prefix/bin:$PATH newsmonger --ai-test --no-open --port 4291 --data-dir /tmp/nm-data
```

Run it from a directory **outside the repo** — the point is that the server resolves its client assets relative to its own module rather than the cwd.

Verified 2026-07-31 on macOS at 0.2.0: the `bin` symlink is created, `newsmonger --help` / `--version` answer and exit 0, the server prints its readiness line, `/` and every `/static/*` asset serve (`app.js` 887 kB, `styles.css`, the SVGs), `/api/state` returns the real state with `appVersion`, and the page renders in Chromium with **no console errors**.

### Linux — ✅ verified 2026-07-31 (NEWS-217)

Docker, four passes, all green at 0.2.0:

| Pass | Image | Result |
|---|---|---|
| arm64 (native) | `node:22` (v22.23.2) | install, `--help`/`--version` exit 0, readiness line, `/` + all `/static/*` + `/api/state` + `/healthz`, `POST /api/topics` → 201 |
| amd64 (emulated) | `node:22` | identical |
| Browser | `mcr.microsoft.com/playwright:v1.61.1-noble` (Node 24.17) | first-run onboarding appears, skip, add a topic through the UI, it renders — **no console errors, no failed requests** |
| Non-root | `node:22`, `tester` user, `npm config set prefix ~/.npm-global` | bin on PATH, server serves, default data dir lands at `$HOME/.newsmonger` owned by the user |

The browser pass is the one worth keeping: it walks the real first-run path (fresh data dir → onboarding wizard → add a topic) rather than just asserting the HTML came back.

`npm install -g` as a non-root user needs a user-writable npm prefix, which is npm's ordinary configuration and not something this package can influence — but it is what a Linux user will actually do, so it is covered.

### Windows — ✅ verified 2026-07-31 (NEWS-218)

Parallels Windows 11 ARM64 (build 10.0.26200), Node 24.16.0 / npm 11.13.0, driven with `prlctl exec --current-user`, installing from a tarball copied onto the VM's own disk (not run over the `\\Mac` share, which would conflate SMB semantics with real portability bugs).

All green at 0.2.0: `npm install -g` writes **both** shims (`newsmonger` and `newsmonger.cmd`) into `%APPDATA%\npm`; `--help` exits 0 and `--version` prints `0.2.0`; a bad flag still exits 1; the server prints its readiness line; `/`, all five `/static/*` assets, `/manifest.webmanifest`, `/api/state`, `/api/providers`, `/healthz`, `/feed.xml` and `/api/export.md` all 200; `POST /api/topics` → 201 and the topic comes back in state. The default data directory lands at **`C:\Users\<user>\.newsmonger`** — the Windows home, not a POSIX path — holding `newsmonger.db` and its `-shm`/`-wal` siblings.

**The browser-open path works, and the way it looks when it fails is worth knowing.** `openInBrowser` runs `cmd /c start "" <url>`. On this VM no browser process ever appeared, and every OS-level idiom behaved identically — `start`, `explorer.exe <url>`, `Start-Process <url>`, `rundll32 url.dll,FileProtocolHandler` — while launching `msedge.exe` directly worked fine. A screenshot of the VM desktop settled it: Windows had raised **"Select an app to open this 'http' link"** and was waiting on a choice, because the VM has no settled default-browser association (Parallels adds the Mac browsers as candidates). The command reached the shell and the shell did its job.

So: **process-count checks cannot verify browser opening on Windows.** Capture the screen — `prlctl capture <vm> --file x.png` — and note that a blanked display captures as a ~20 kB black frame, so capture twice.

Two harness traps, recorded because both cost a round:

- PowerShell's `Invoke-WebRequest` hangs against the local server here; `curl.exe` is fine and is what the check script uses.
- A JSON body inlined on a `curl.exe` command line loses its quotes crossing the PowerShell/cmd boundary and comes back as a **400 from the app** — which reads exactly like a product bug. Write the body to a file and use `--data-binary "@file"`.

## Desktop bundle on Windows — ✅ verified 2026-08-01 (NEWS-20)

Installed from the **published** `Newsmonger_0.2.0-beta.7_x64-setup.exe`, not a build tree, so resource resolution ran from a real install location. Parallels Windows 11 (build 10.0.26200), driven with `prlctl exec --current-user`.

All four of the ticket's steps pass: the NSIS installer exits 0 into `%LOCALAPPDATA%\Newsmonger` (a **per-user** install, no elevation), the app launches with the window titled *Newsmonger*, the sidecar `newsmonger-node.exe` (79.5 MB, `v22.14.0`) spawns, `/healthz`, `/api/state` and `/` all answer on 4187, the webview renders the real UI, and `CloseMainWindow()` — a graceful quit, not a kill — leaves **no orphaned `newsmonger-node.exe`**. The installer is `NotSigned`, as decided in NEWS-236.

**`CREATE_NO_WINDOW` works, and the obvious way to check it is wrong.** The flag suppresses the console *window*; it does **not** prevent a console being allocated, so a `conhost.exe` still appears as a child of the sidecar. Its presence proves nothing. What proves it is that both the sidecar's `MainWindowHandle` and its conhost's are `0` — nothing is ever displayed. Counting conhost processes is worse than useless here, because every `prlctl exec` shell spawns one of its own.

Two things about driving this from macOS that cost time and are worth not rediscovering:

- **`prlctl exec` blocks until the process it started exits.** `Start-Process` on a GUI app therefore hangs the session forever. Launch detached with `Invoke-CimMethod Win32_Process Create` and poll from separate `exec` calls.
- **Quote everything through `-EncodedCommand`** (UTF-16LE base64). Plain `-Command` strings lose their quoting somewhere between bash and prlctl, and `-File` over `\\Mac\Home` did not resolve. PowerShell's progress stream also needs `$ProgressPreference = "SilentlyContinue"`, or a 25 MB download serialises a megabyte of CLIXML into the output.

## E2E suite on Windows — ✅ verified 2026-07-31 (NEWS-209), re-run clean 2026-08-01 (NEWS-235)

**Three consecutive clean runs on 2026-08-01** at `5980f46`: **181/181, zero flaky**, 4.7–5.7 minutes each. The previously-flaky `topics.spec.ts:367` (fixed in `291401a`) did not recur, and neither did the `a11y.spec.ts` sweep that flaked in the original run.

One caveat that matters for promoting the CI job to blocking (NEWS-235): these are **VM** runs. The flake being guarded against happened on a *loaded* GitHub `windows-latest` runner, and a quiet VM is the easier environment. The CI job has had **no** run since the fix.

The harness needed **no porting**. That was measured, not assumed, and it contradicts what NEWS-209 expected: glassbox's Windows port had to fix an `npx.cmd` spawn, add Node `mkdir`s in the config and `build:client`, return a favicon 204 and patch the keychain. None of it applied here — newsmonger already resolves paths through Node APIs and creates its directories with `fs.mkdirSync`, so the suite ran as-is.

Procedure (Parallels Windows 11, build 10.0.26200, Node 24.16.0, driven with `prlctl exec`):

```powershell
git config --global --add safe.directory '*'   # the Mac share is another owner
git clone Z:\Documents\news C:\nm-e2e        # clone onto C:, not run over SMB
cd C:\nm-e2e; npm ci; npx playwright install chromium
$env:CI = 'true'; npm run test:e2e
```

Clone onto the VM's own disk rather than running out of `\\Mac\Home`: `node_modules` and Playwright over SMB conflate share latency and filesystem semantics with the real portability bugs you are looking for.

**Result at `ef10d5b`: 173 passed, 1 flaky, ~5 minutes.** The flake was `a11y.spec.ts` — the settings-dialog sweep, which walks every tab in both themes and runs axe — timing out at the 30 s default under full-suite load. It passes **3/3 in isolation**, so it is VM slowness rather than a Windows bug. Worth watching on the CI runner: if it recurs there, the fix is a longer timeout on that one test, not a harness change.

Now covered by the **blocking** `test-e2e-windows` job in `release-candidate.yml` (advisory until NEWS-235), so this stays a spot-check rather than a routine step. It gates the web app in a Windows browser only — no Windows *bundle* has ever been built or launched (NEWS-20), which is still manual.

## Tauri release bundle (needs Rust toolchain) — ✅ macOS verified 2026-07-24

`npm run tauri:build` then launch `src-tauri/target/release/bundle/macos/Newsmonger.app`. Verified on `aarch64-apple-darwin` (NEWS-2): the sidecar starts, the webview navigates, the real UI loads (`NEWSMONGER_LOG_REQUESTS=1` shows `GET /` → assets → `/api/state` → `/api/providers`), and quitting leaves no orphaned `newsmonger-node`.

Still manual, and **unverified on every other platform**:

1. Build on Windows and Linux — confirm the target-triple → Node-platform mapping in `scripts/build-sidecar.sh` is right and the app launches.
2. On Windows, confirm no console window flashes when the sidecar spawns (`CREATE_NO_WINDOW`, written but never run).
3. Install from the `.dmg` (not just the build tree) and launch — confirms resources resolve from a real install location.
4. On macOS this is now **automated** — `bash scripts/verify-released-dmg.sh <tag> [aarch64|x64]` (NEWS-21). It downloads the published dmg, sets `com.apple.quarantine` exactly as a browser does, and checks the path a user actually takes: the app inside is stapled, Gatekeeper reports `source=Notarized Developer ID`, the copy dragged out of the volume **keeps its quarantine** and is still accepted, and — the part nothing else can check — the Node sidecar **starts and JITs** while quarantined under the hardened runtime. Entitlements can be read statically; only running the thing proves the hardened runtime lets V8 map and write executable memory, which is the failure that stays invisible until it happens on a stranger's Mac.

   `verify-signing.sh` still runs in CI and checks a different thing: the bundle on the machine that built it. That machine holds the signing key, never quarantines its own output, and is checking something that has not been through GitHub.

   **What remains manual:** launching the GUI and confirming the window loads and the feed appears. The script proves the sidecar can run; it does not click anything. Also, running the **x64** dmg on an Apple Silicon Mac exercises it through Rosetta — good evidence, not identical to a native Intel machine.

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

Same shape as the Claude one — unit tests inject a fake runner, so the live path is manual. **`codexExecArgs` is now unit-tested (NEWS-272), which covers the flag list but not whether the installed CLI still accepts it.** That gap is what shipped a dead `--search` flag, so step 2 matters more than it looks.

1. With `codex` installed and `~/.codex/auth.json` reporting `auth_mode: chatgpt`, pick "ChatGPT subscription (Codex)" in Settings and confirm the status reads ready.
2. Check a topic with active coverage — expect real current stories with working links. **An exit code 2 with codex's usage text means it rejected our argv**, which is what a removed or renamed flag looks like; compare `codexExecArgs` against `codex exec --help`.
3. Confirm the stories are actually *current*. Web search rides `-c tools.web_search=true`, and if that key ever stops taking effect Codex will answer from training data — plausible-looking output with stale or invented links, which is a quieter failure than a crash and the one worth looking for.
4. Confirm Codex writes nothing: it runs `-s read-only`, so a check must not create or modify files in the working directory.
5. Sign out of Codex and check again — expect an actionable "Codex is not signed in" error.

To re-verify a config key after a CLI upgrade, use the technique from NEWS-244/272 rather than trusting `--help`: `codex exec --strict-config -c <key>=<value> "hi"` rejects an unrecognized field by name. Note that a *recognized but inert* key passes that check, so anything load-bearing also needs one real query watched end to end.

## New-item notifications in Tauri (NEWS-38) — needs a desktop run

Browser-verified (toggle, permission, firing, throttle, and since NEWS-260 the test button). The native delivery is manual.

**Read this before running it, because the previous version of these steps asked for something that cannot happen.** NEWS-260 established, from the plugin's own source and the macOS notification database:

- **There is no OS permission dialog on desktop.** `tauri-plugin-notification`'s desktop implementation hardcodes `Ok(PermissionState::Granted)` for `request_permission` and `permission_state`; macOS is never asked. Delivery uses the legacy `NSUserNotificationCenter`, which has no authorization concept. Step 1 used to say "confirm the real OS permission dialog appears" — it never will, and waiting for it reads as a bug.
- **The app is listed in System Settings → Notifications only after it has successfully delivered one.** So its absence there before the first notification is expected, not a permissions fault.
- **`tauri:dev` cannot register this app.** In dev the plugin sets the application to `com.apple.Terminal` (`tauri::is_dev()`), so a dev notification registers *Terminal*. Anything about System Settings must be checked on a **built** app.

1. `npm run tauri:build` (or install a released bundle), open Settings → App, and press **Send a test notification**. Confirm a notification appears and the result line says it was sent.
2. Confirm the app now appears in **System Settings → Notifications** as Newsmonger. This is the check that was impossible before NEWS-260 — nothing else in the app delivers on demand.
3. Toggle notifications on. Confirm no permission dialog appears and the toggle simply sticks (see above — there is nothing to grant).
4. Add a topic with active coverage on an API-key provider, background the app, and let a scheduled check run — confirm an OS notification appears **and** the dock icon bounces (macOS) / taskbar flashes.
5. **Click the OS notification: the window should come forward.** *Answered on v0.2.0-beta.14 — it does.* Our JS `onclick` cannot run on the desktop (the shim never reads it); macOS activates the app that *posted* the notification, and the posting bundle id is faked to ours, so this works without any code of ours. **Re-check it after a Tauri or macOS upgrade** — the behaviour belongs to the OS, so nothing in the test suite can notice it stopping. Windows and Linux remain unverified.
6. Confirm nothing fires while the app is focused, and no more than once per 5 minutes. A test notification in between must not suppress a genuine one.
7. Quit and relaunch with the toggle still on — confirm notifications still fire without re-toggling. (There is no startup permission re-sync any more; it existed only to feed the cache NEWS-260 deleted.)

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
- **Gatekeeper on a published macOS release** moved here from manual (NEWS-21): `bash scripts/verify-released-dmg.sh <tag>` downloads the real artifact, quarantines it, and verifies stapling, `spctl` assessment, quarantine inheritance through drag-out, and that the sidecar starts and JITs under the hardened runtime. First run on `v0.2.0-beta.7` — both `aarch64` and `x64` pass. Only the GUI launch itself is still manual.
- **The Linux sidecar build** is covered by `bash scripts/verify-sidecar-linux.sh` (NEWS-20), which runs `build-sidecar.sh` in a container for both Linux triples so the isolated boot check actually executes instead of self-skipping as it does when cross-compiling.
