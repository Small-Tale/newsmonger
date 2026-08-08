# Changelog

All notable changes to Newsmonger, newest first.

Entries are added by `npm run release` / `npm run release:beta`, which draft them
with [gitgist](https://www.npmjs.com/package/gitgist) over the commits since the
last version tag and open them in `$EDITOR` for editing. Written for people who
use the app, so ticket ids, refactors, test changes and internals stay out — the
git history already has those.

Versions follow [semver](https://semver.org). A `-beta.N` suffix lives on the git
tag only, never in `package.json` or `tauri.conf.json`: macOS bundle version
fields reject semver prerelease suffixes.

<!-- Nothing released yet. The first `npm run release` inserts its entry below. -->

## [0.2.0-beta.21] - 2026-08-08

## Other Changes

- Let temp-dir cleanup survive a database Windows will not unlink (NEWS-429) (`361ba58`)

## [0.2.0-beta.20] - 2026-08-08

## Features

- Onboarding now asks who you are and where you are: a reader-profile picker (48 profiles across three skippable pages) and a location field, both between the Source and Topics steps.
- Ticking profiles seeds your feed — the picker maps to a curated table of 240 standing topics (five per profile), with the per-profile depth shrinking as you tick more so ten profiles don't create fifty topics.
- Location is a global free-text setting (Settings ▸ App ▸ Location) sent with every check; the model applies it only where a topic is inherently about somewhere, so "Local schools" gets local news and "Space exploration" stays global.
- Topic discovery gained a suggested-topics strip between the free-text box and the section grid, so "what should I watch?" is answered without typing or drilling.
- An unscoped "surprise me" discovery request is now biased by your ticked profiles, while an explicitly scoped request is left exactly as asked.
- You can now set a topic's section and subject by hand from the rename dialog — the manual-choice behaviour the app already respected finally has a control.
- Selected default topics ship with search guidance so ambiguous names ("Marathons", "Mercury") search for the right thing.

## Changes

- The topic taxonomy grew from 11 sections to 20, all with subcategories — Money, Environment, Media, Food & Drink, Travel, Living, Education, Law & Justice, Transport and a catch-all *Other* section for topics the classifier can't place.
- "Climate science" is no longer offered twice under two names, which previously created two separate topics for one subject.
- A topic whose stored section no longer exists in the taxonomy is now re-classified instead of being treated as permanently classified while displaying as *Uncategorized*.
- When you correct a classified topic by hand, the app records what the classifier had said, so misfiling can be measured.

## Bug Fixes

- The setup guide now reappears after you delete `~/.newsmonger` — the dismissal flag is scoped to the install it was dismissed for — and it no longer stays hidden just because a provider CLI happens to be signed in on the machine.
- "Export topics…" in the desktop app now works instead of failing silently; it was passing a relative URL to the external-link handler, which rejected it with no error shown.

## Documentation and Demo Assets

- The demo and README screenshots are recorded from real news coverage, with real article images and favicons, replacing invented stories that linked to `example.org` and rendered picture-less.
- Every shipped SVG embeds its images rather than linking a long-dead localhost port, so the animation and stills render correctly in Preview, QuickLook and Finder thumbnails.
- The hero animation now scrolls the page inside its frame between the feed and sources beats, instead of dissolving or sliding whole frames past each other, and the end card is signed with the real serif wordmark.
- Screenshots were recaptured on the corrected taxonomy, so section and subject labels no longer disagree with each other or omit the subject.
- New requirements docs cover Location (35) and profile-derived default topics (36).

## [0.2.0-beta.19] - 2026-08-07

## Features

- Newly added topics now wait a minute before their first scheduled check, so guidance written right after creating a topic is used by that first check instead of being missed.
- A topic with its edit or guidance dialog open is skipped by the scheduler until the dialog closes, so a check never runs against guidance you're still typing.
- README now documents the RSS feed at `/feed.xml` (with `?scope=saved` for bookmarks), Markdown/JSON export and import, search and bookmarks, per-topic scheduling and priority, automatic sections and subjects, theme selection, and backup/restore.

## Bug Fixes

- The masthead wordmark now follows the theme you pinned in Settings rather than the OS preference — pinning light on a dark system no longer made the word "News" vanish.
- An expanded story card's detail pane now fills the full height of its grid row, instead of stopping mid-card with rounded corners floating in empty space.
- Fixed five CSS rules pointing at undeclared color tokens: the high-priority star, settings field-label star and review flag now use a themed, contrast-checked color; the restore-row border, muted text and — most importantly — the file-button focus ring all render again.
- The Codex model cache is now validated rather than trusted, so an unexpected shape from the vendor degrades to "no models" instead of crashing with `.map is not a function` or sorting arbitrarily.

## UX

- The topic discovery button beside the add-topic field is now a grid icon rather than a compass, matching the section grid it opens.
- Demo screenshots and the animated hero were recaptured against the current UI.

## [0.2.0-beta.18] - 2026-08-06

## Reliability

- Fixed the end-to-end test harness on Windows: the client build step now spawns npm the way current Node requires (`npm.cmd` through a shell), replacing a spawn that failed before any test could run.
- Fixed test servers failing to launch on Windows with a misleading `node.exe ENOENT` — working directories are now resolved from `file:` URLs correctly instead of via a raw URL pathname.
- The real-provider E2E suite now launches its server with `node --import tsx/esm` from an explicit repo root, so it runs under a command sandbox and on Windows.

## CI

- Added a Windows end-to-end CI job that runs on pushes touching the test harness, config, scripts, or the CLI entry point, so Windows-only breakage surfaces immediately instead of at the next release.

## Documentation

- macOS code signing and notarization (FR-5.5) is now documented as shipped and verified rather than partially complete, with the evidence from recent signed releases.

## [0.2.0-beta.17] - 2026-08-06

## Other Changes

- Spawn npm by a name Windows can resolve (NEWS-348) (`6f1bc37`)

## [0.2.0-beta.16] - 2026-08-06

## Features

- Story threads: stories in the same topic covering one developing subject are now grouped, so a card can say it's the "4th update" instead of arriving as if nothing came before.
- Clicking a story card expands it in place to a detail pane showing the "story so far" — every earlier instalment on the subject, dated and attributed. An open pane now follows its thread as new instalments arrive.
- Appearance setting in Settings → App: Light, Dark, or Match system. The chosen theme is applied server-side, so there's no flash of the wrong palette on load.
- Export and import topic lists as a shareable, hand-editable JSON file, and import stories back from an existing `export.json`. Topic import is additive and skips duplicates case-insensitively; story import dedups on the same key a check uses.
- Settings → Data → Recovery lists any database the app set aside as unreadable, shows what each one holds, and can restore it — the section is absent when there is nothing to recover.
- "Delete all topics" joins "Delete all stories" in the Reset group, both behind a confirmation.

## Bug Fixes

- Fixed a stale schema version being mistaken for a corrupt database, which could quarantine a perfectly good database and start the app empty.
- Cached story images are now kept for as long as the stories that use them; an empty story list no longer causes the image prune to delete the whole cache. A story whose cached image has gone missing is refetched, and a failed refetch is retried rather than abandoned for the rest of the run.
- The Atom feed at `/feed.xml` now carries the `atom:author` element RFC 4287 requires, so strict feed readers accept it.
- The topics rail no longer collapses when the page is scrolled — its height now tracks its real position in the viewport instead of a sticky-shifted one.
- Clearing one topic's stories no longer leaves flagged-story overlays rendering over rows that no longer exist.
- A failed first backup after choosing a folder now reports an error instead of being silently dropped.
- Switching providers across vendors (e.g. ChatGPT → Claude) no longer leaves the other vendor's model selected, which would have failed every subsequent check.

## UX

- The app now says so when a database was set aside as unreadable, instead of silently opening onto an empty topic list.
- When the server can't start, the desktop shell shows what went wrong — including the reason and the reassurance that your data is untouched — instead of spinning indefinitely.
- Clearing a topic's stories resets it to its initial state: it reads as never checked on every surface, and its failure streak and cooldown are cleared.
- Warning amber was darkened to meet WCAG AA contrast on every background it's used on.
- Settings polish: every group on every tab is now named; each Data control has a single-line hint instead of a paragraph; the backup folder path stacks above its field so it's fully visible; import/export pairs are equal halves of a row; "Back up now" and "Restore" fill their lines; the scrolling panel spans the dialog so its scrollbar and focus rings are no longer clipped.
- "Delete all stories" moved out of the Backup group into Reset and now uses a destructive style; quiet buttons gained a resting edge so they no longer read as captions.
- The Source tab's status line now always says something rather than rendering an empty row.
- Story source attribution is aligned with its headline inside the same link.
- The restore instructions in Settings → Data now describe a path that actually works.

## Removed

- The Diagnostics section and its effort comparison have been removed.
- The "Send a test notification" button has been removed.

## [0.2.0-beta.15] - 2026-08-04

## Bug Fixes

- Fixed Codex CLI checks failing outright: the shared JSON schemas now list every declared property in `required`, as OpenAI's strict structured outputs demand, and topic discovery is fixed the same way.
- CLI failures now show the actual error message and code (e.g. `invalid_json_schema: …`) instead of the closing braces of a JSON payload, with the detail cap raised from 300 to 600 characters.
- A topic that has been checked but holds no stories now reads `checked 1d ago · no stories` instead of implying stories are still there.

## Features

- New effort comparison in Settings → App → Diagnostics: median duration and median tokens per effort level, fastest first. Only successful runs count, runs from before effort tracking are excluded, and tokens read "not reported" rather than 0 when a provider reports none. It stays silent below two levels and explains what to change instead.

## Behavior Changes

- Checks no longer ask the model to omit `category`/`subcategory`; they are always returned, as `null` when no classification was requested.

## Documentation

- Confirmed and documented that clicking a desktop notification on macOS brings the window forward — courtesy of the OS activating the posting app, not app code. Windows and Linux remain unverified.

## [0.2.0-beta.14] - 2026-08-03

## Bug Fixes

- Clearing all stories no longer refuses while a check is running — it stops the running checks (and any queued topics or pending re-check) and clears immediately. The confirmation says how many checks will stop, and the toast reports how many did.
- Results from a check that was already in flight can no longer refill the feed right after a clear.
- Fixed every check failing on a ChatGPT (Codex) subscription with an exit-code-2 usage error; web search is now enabled through a config override after the CLI removed the `--search` flag.

## [0.2.0-beta.13] - 2026-08-03

## Features

- Settings → Data now offers **Clear all stories**, deleting every story while keeping topics, settings and API keys; the confirmation names what survives, and each topic's coverage window resets so the next check starts fresh.
- Changing provider, model or effort **cancels any check already in flight** — a real abort that reaches both SDKs and kills CLI agent child processes — and reissues the manual ones under the new selections. Interval and retention edits leave running checks alone.
- The model setting is now a dropdown that only offers models the current provider actually has, filling in a small default when nothing is chosen and replacing a model left over from a provider you switched away from.
- The Effort control lists only the levels the chosen model accepts, and switches off entirely for models that accept none (such as `claude-haiku-4-5`). A saved level the new model refuses is moved to the nearest supported one instead of silently failing the next check.
- A **Send a test notification** action in Settings lets you confirm notifications actually reach the OS, reporting the result inline.

## Bug Fixes

- Desktop notifications now work in the packaged app at all. The client was gated on a `window.__TAURI__.notification` global no build defines, so the desktop never delivered one; both surfaces now go through the single `Notification` API the shell shims.
- Topic suggestions are no longer served from another provider's answers: the discovery cache is keyed on provider, model and effort, and suggestions on screen are dropped when a provider change invalidates them.
- Article-image URL safety now rejects a host if **any** resolved address falls in a blocked range, not just the first, and treats an empty DNS answer as a rejection.
- The discovery results heading no longer contradicts the group label beneath it — a qualifier explains where a suggestion will actually file itself — and a card no longer describes itself as "narrower than" its own name.

## UX

- Below the one-column collapse, search is an icon-only circle that expands on focus instead of a 62px stub that showed about four characters of your query.
- The two discovery depth controls are now tellable apart: the whole-result-set pair reads **narrow these** / **more like these**, distinct from a card's **narrower** / **similar**.
- Ways out of a mode (review, saved filter, and friends) render with a visible edge so the only exit no longer reads as plain text.
- Settings → Source aligns its labels, controls, API-key fields and status line on one column; the status line, which had never been indented at all, now sits under the control it describes.

## Accessibility

- API key rows use a real `<label for>`, so the Anthropic and OpenAI fields announce as "Anthropic API key" and "OpenAI API key" instead of both reading as "Paste API key", and clicking a provider name focuses its field.

## Documentation

- The README hero animation gains a dark-mode beat revealed by a wipe, and the feature stills were recaptured.

## [0.2.0-beta.12] - 2026-08-02

## Features

- **Restore from a backup, in the app.** Settings → Data now shows what your configured backup folder holds — *"Backup found — 12 topics and 340 stories, saved 3 hours ago"* — with a **Restore from backup** button beside it. No more renaming files by hand into a data directory you've never seen.
- Restoring replaces everything in one transaction rather than merging, and any error rolls back, so a failed restore leaves your data exactly as it was.
- Your current data is saved to a `pre-restore-<timestamp>.json` file in the data folder before anything is replaced.
- The confirmation names the snapshot's date and contents before you commit to overwriting, and the button is styled as destructive.
- The restore panel refreshes when you open the Data tab, after "Back up now", and after changing the backup folder — so it reflects the folder's real contents without reopening Settings.

## Behavior

- Your machine's backup folder setting is kept after a restore instead of adopting the path from the snapshot, which would usually point at a folder that doesn't exist and silently stop backups.
- Restore is refused while a check is running, so a check finishing mid-restore can't mix old stories into the new data.
- A folder with no backup shows no restore control at all; a file this version can't read is reported as unreadable rather than as "no backup".
- API keys are still never included in a backup — the panel says so, so a restored app asking for your key reads as expected rather than as a failed restore.

## [0.2.0-beta.11] - 2026-08-02

## Bug Fixes

- The "falling behind schedule" banner no longer fires for time the app was never permitted to check — backgrounding the app with a subscription provider, or a rate-limit pause, no longer counts against a topic's cadence.
- A `<select>` you've touched now keeps following the server: settings dropdowns (e.g. the high-priority interval after it's clamped) no longer keep showing a stale value the app has already changed.
- Sidebar topic rows now render their own state — two topics in the same category with the same flags could previously be served each other's cached row, showing the wrong name, badge or controls.
- The app now refreshes as soon as it becomes visible again, instead of showing whatever was true when you left it until the next 4-second poll.

## Features

- Model suggestions now come from the provider instead of a hardcoded list: OpenAI and Anthropic catalogues are fetched over the API (newest first, non-text families filtered out) and Codex reads the model list its own CLI keeps on disk, including Codex-only models like `gpt-5.3-codex-spark`.
- Reasoning effort now works on every real provider. Codex (via `model_reasoning_effort`) and the OpenAI API provider join Anthropic and the Claude CLI; the effort control is now disabled only for the test-only `mock` provider.
- The effort menu offers what the chosen **model** actually accepts, not one global list — asking for an unsupported level previously failed the check outright. A saved level the model doesn't take stays visible rather than silently disappearing from the control.
- The OpenAI provider retries without `reasoning.effort` when the API rejects the parameter, so a non-reasoning model still works instead of failing the check.

## Performance

- The server now holds idle connections for 30 seconds instead of Node's 5, so a page polling every 4 seconds reuses one socket instead of churning a new one each poll (measured: 457 sockets in `TIME_WAIT` at peak, down to 46).

## Reliability

- Windows E2E tests are now a blocking release gate rather than advisory, after 10 consecutive clean first-attempt runs.
- `NEWSMONGER_SCHEDULER_TICK_MS` sets the scheduler's sweep interval; a bad value falls back to the 60-second default rather than leaving the app running without ever checking.

## [0.2.0-beta.10] - 2026-08-01

## Features

- New **Newest stories** sidebar sort orders topics by their most recent story, with topics that have never produced one sinking to the bottom in A→Z order.
- Each topic row now shows a badge counting the stories found today, in the left gutter beside the priority star; topics with nothing today show no badge at all.
- The **Effort** setting now applies to the Claude subscription provider as well as the Anthropic API — the Claude CLI accepts the same effort levels, and checks now pass the chosen level through.

## Bug Fixes

- Desktop app: notifications, automatic updates and app relaunch now work. The window's capabilities didn't cover the localhost origin it navigates to, so every one of those requests was silently refused — macOS was never even asked for notification permission.

## UX

- Disabled form controls in Settings now look disabled — dimmed, with a "not-allowed" cursor — instead of rendering identically to live fields.
- The Effort note now names both providers the setting applies to, and no longer claims the Claude subscription takes no effort setting.
- Claude subscription model suggestions are now aliases (`opus`, `sonnet`, `haiku`, `fable`) that track the latest model, replacing a pinned name that had already been superseded. The field remains free text if you want to pin a specific model.

## [0.2.0-beta.9] - 2026-08-01

## Bug Fixes

- The Claude and Codex CLI providers now find their binaries when the app is launched from Finder, instead of failing with "not installed" — the packaged app doesn't inherit your shell's `PATH`, so the app searches the usual install locations (`~/.local/bin`, Homebrew, npm's global dir on Windows) as a fallback. Subscription-based checks were unable to run at all in the beta release.
- Settings → Source no longer reports "no API key" for subscription providers that don't use one; it now says "CLI not found", which is the actual problem.

## UX

- The notifications-blocked message now names where to fix it: in a browser it points at that page's site settings and shows the origin, and explicitly says macOS System Settings won't help; in the desktop app it points at System Settings → Notifications → Newsmonger.
- The Effort setting now explains on the page why it's disabled for non-Anthropic providers, rather than hiding the reason in a tooltip on a disabled control.

## [0.2.0-beta.8] - 2026-08-01

## Bug Fixes

- Backup folder paths typed into Settings are now resolved before being saved: a leading `~` is expanded, blank input turns backups off, and relative paths are rejected with an explanation. Previously a path like `~/Documents/Backups` created a literal directory named `~` next to wherever the app was started, and the backup reported success into it.
- Another user's home directory (`~otheruser/...`) is refused rather than guessed at, and a rejected backup path no longer allows the rest of a settings update to apply.
- Saved paths are trimmed and normalized, so two spellings of the same folder don't read as two different settings.

## Documentation

- The Windows desktop bundle is now documented as verified end to end from the published installer: it installs per-user to `%LOCALAPPDATA%\Newsmonger`, launches, spawns the sidecar, serves the UI, shows no console window, and leaves no orphaned process on quit. Linux install-and-launch remains unverified.
- The Windows installer is unsigned by decision, and the docs now spell out the consequence: SmartScreen will warn on download, with "run anyway" behind a "More info" link.
- Release pipeline docs record that all four platform bundles now build in CI, with the macOS pair notarized and stapled.

## Tooling

- New `scripts/verify-released-dmg.sh <tag> [aarch64|x64]` downloads a published macOS release, quarantines it as a browser would, and checks stapling, Gatekeeper's notarization verdict, quarantine inheritance after drag-out, and that the Node sidecar starts and JITs under the hardened runtime.
- The screenshot capture script supports a per-scene "soak", letting the topics sidebar still show a next-check dial partway through its countdown instead of always full; the README screenshot and its alt text were updated to match.

## [0.2.0-beta.7] - 2026-08-01

## CI

- The pre-upgrade smoke test against the published stable release is now advisory — it emits a warning instead of failing the run, since an already-published build can't satisfy smoke assertions added after it shipped. The post-upgrade smoke test against the beta remains strict.
- Beta install now retries up to 10 times with escalating backoff (~9 minutes total) to wait out npm registry propagation, and reports a clear error if the version never becomes installable.

## [0.2.0-beta.6] - 2026-07-31

## Features

- **Backup to a synced folder.** Point Newsmonger at a folder in iCloud Drive, Google Drive, OneDrive or Dropbox and it writes a full snapshot — topics, stories, settings and run history — after a successful check, at most once an hour. The live database stays local, so a sync daemon never touches an open SQLite file. API keys are never included; they stay in the OS keychain. There's also a "Back up now" button in Settings → Data.
- **The app offers to set backups up.** After your third topic, a dialog appears listing the sync folders that actually exist on your machine, one click each. "Not now" holds it off for a day; "Don't ask again" is permanent and survives a reinstall.
- **AI effort is now a setting.** A dropdown in Settings → Source picks how hard the model works on each check — low, medium, high, extra high or max, or the provider's own default (unchanged behaviour until you choose). Seedable with `--effort` / `NEWSMONGER_EFFORT`. It applies to Anthropic checks only; the control is disabled for other providers, and topic discovery always runs at the model's default.
- **Runs record the effort they used.** The diagnostics bundle shows the level each check actually ran at, so a change to the setting can be compared against what it bought. Runs from before this shipped read as unknown rather than being backfilled as "default".
- **`newsmonger --help` and `--version`.** Both print to stdout and exit 0, and are answered before anything else on the command line is parsed — so `--help` works even alongside a flag that wouldn't.

## Bug Fixes

- **The app no longer asks for access to your Documents folder.** The Claude and Codex CLI providers were spawned with whatever working directory the app inherited; macOS attributes a child process's file reads to the app that started it, so an agent reading its own working directory triggered Documents/Downloads/Media prompts in Newsmonger's name. Spawned agents now start in a dedicated temp directory, and the desktop shell anchors the server to a directory the app owns.
- **Beta builds carry their real version.** Prerelease bundles reported the base version (`0.2.0` for `v0.2.0-beta.1` and `-beta.2` alike), so the Tauri updater could never see one beta as newer than another. The full `-beta.N` version is now written into the bundle.

## Documentation

- The README now shows what the app looks like: seven inline screenshots — the feed, topics sidebar, discovery, the keep/skip tuner, review mode, Settings → Source, and export — all captured from the running app rather than mocked up.
- Development setup, commands and the from-source workflow moved into a new `CONTRIBUTING.md`, leaving the README for people using the app. The documented install path is now `npm install -g newsmonger`.

## Release & Packaging

- Releases are gated again: typecheck, lint and tests run before any build, the git tag must match the version in `package.json` and `tauri.conf.json`, and a prerelease suffix is refused on the stable release path (a mistyped `v0.3.0-rc1` would otherwise have flipped `releases/latest` and pushed itself to everyone).
- Code signing is verified before publishing, and the check now finds the bundle wherever the build put it. An unstapled `.dmg` is no longer treated as a failure.
- Manual `workflow_dispatch` runs get a `dry_run` option that builds, signs, notarizes and verifies without publishing, and a release build now checks out the tag being released rather than whatever `main` points at.
- Release runs no longer cancel each other, bundles are kept as artifacts even when a job fails, and Apple's notarization queue is polled and logged so a slow submission is distinguishable from a hung one.
- The npm smoke install can now actually fail — an exhausted retry loop used to exit green — and it waits out the registry CDN before giving up.

## [0.2.0-beta.5] - 2026-07-31

## Documentation

- Documented that all builds — beta and stable — use a single updater endpoint (`releases/latest/download/latest.json`), which means beta installs automatically rejoin the stable channel on the next stable release.
- Expanded the macOS signing docs with the rationale for the entitlement set and a required manual pre-release check that a signed build's Node sidecar still launches.

## Developer Experience

- Added an animated SVG hero to the README, captured from the live app.
- New `npm run demo:capture` script regenerates the README hero by booting a real server in demo mode and driving the UI with Playwright.
- The Rust gate script now honors `RUST_GATES=skip`, so callers that run those checks elsewhere can opt out instead of failing on missing system headers.

## Internal

- macOS hardened-runtime entitlements now grant `cs.disable-library-validation` in place of `cs.disable-executable-page-protection`, matching the reference Node-sidecar configuration.

## [0.2.0-beta.4] - 2026-07-31

## Features

- Added `--demo` mode, which serves curated fixture stories so screenshots and docs can be captured from the real running app; it implies `--ai-test` and makes no network calls. A second check on the same topic returns a different set of stories, so deduplication is visible in a capture.

## Bug Fixes

- Fixed the version-bump script failing on Windows checkouts with CRLF line endings, which aborted the signed Windows release build with a spurious `NO MATCH` on `src-tauri/Cargo.lock`. Files with CRLF now keep their line endings after a bump.
- Normalized shell, Node, TOML, lockfile, JSON, and YAML files to LF on checkout so Windows runners stop hitting line-ending failures.

## Documentation

- The README quick start no longer tells you to export an API key: signing in to Claude Code or the Codex CLI is now the documented default path, with `--ai-test` and API keys as alternatives.
- The provider table now lists `claude-cli` and `codex-cli`, explains that subscriptions are tried before API keys, and notes that subscription-backed scheduled checks only run while the app is open.

## [0.2.0-beta.3] - 2026-07-30

## Bug Fixes

- Fixed the Windows desktop bundle build failing immediately with `Unsupported target: $TAURI_ENV_TARGET_TRIPLE` — the sidecar build script now reads the target triple from the environment instead of relying on shell variable expansion, and ignores an unexpanded `$VAR`/`%VAR%` argument with a clear warning rather than treating it as a real target.

## [0.2.0-beta.2] - 2026-07-30

## Developer Experience

- `npm run test:all` now runs the Rust gates (`cargo fmt --check`, clippy in both debug and release profiles, and `cargo test`) alongside the existing typecheck, lint, unit, and E2E steps.
- New `npm run gates:rust` runs just the Rust gates on their own.
- The Rust gates skip with a visible notice when no `cargo` toolchain is present, so the JavaScript gates stay runnable without Rust; set `RUST_GATES=required` to make a missing toolchain a failure instead.
- CI now runs `cargo test` in the Tauri job.

## [0.2.0-beta.1] - 2026-07-30

## Features

- Desktop builds can now update themselves: a banner announces a newer version, an Install button applies it in place, and Settings → App gains a "Check for updates" button with up-to-date / error feedback. Dismissing a banner sticks for that version but a newer one re-announces.
- Newsmonger is now publishable to npm — `npm install -g newsmonger` ships working code, with a build step enforced before publish and sourcemaps excluded at every depth.

## UX

- The topic dial tooltip now counts down in real time — "Next check in 42m" instead of "3% of the interval left before the next check". Durations round down to match the adjacent "checked 23h ago" label, and under a minute reads "in under a minute". Paused and never-checked topics keep their own wording.

## Bug Fixes

- The masthead wordmark no longer renders as a broken image in packaged desktop builds — the app bundle now ships every built client asset instead of a hardcoded list of four, and its startup check verifies each one is actually served.
- The CLI usage line names the right binary (`newsmonger`, not `news`) and lists the real providers — it previously advertised `ollama`, which doesn't exist, and omitted `claude-cli` and `codex-cli`.
- Cutting a second beta of the same version no longer collides with the first in the changelog: entries are headed `0.1.0-beta.2` and re-running a release refuses to duplicate an existing entry unless `--replace` is passed.

## Release Process

- Releases now run through a two-track pipeline: `-rc.N` / `-beta.N` tags publish to npm under `@beta`, smoke-test the *published* package (fresh install and upgrade from `@latest`), and only then promote to `@latest` and trigger the signed desktop build. `npm run release` tags an rc; CI produces the stable tag.
- GitHub Releases are held as drafts until every platform bundle is uploaded, so the `latest` pointer — which the updater reads — never serves a half-published version.
- Release notes now carry a "## Download" section whose links are generated from the same module that renames the shipped `.dmg` files, so a link can't point at a filename that was never published.
- New `npm run tauri:build:local` produces a local production build, with optional `--sign` and `--release` (notarize + staple) modes; notarization credentials are cached in the login keychain rather than a dotfile.

## [0.1.0] - 2026-07-30

First beta of Newsmonger — a topic-based news tracker. You list the topics you care about, and on a schedule you choose the app asks an AI with live web search whether anything is genuinely new on each one, then summarizes what it found with links to the sources.

## What it does

- **Follow topics, not feeds.** Add a topic, pick an interval (hourly through daily), and checks run on their own. Stories already reported on an earlier check are deduplicated away, so the feed is only what's new.
- **Steer a topic in your own words.** Guidance like "regulatory news only, not stock moves" is followed. Marking a story off-topic teaches the app which sense of an ambiguous name you meant.
- **Bring your own AI.** Anthropic or OpenAI with an API key, or your existing Claude or Codex CLI subscription — no key needed for those. Switch providers any time.
- **Suggested topics.** Discovery proposes topics from what you already follow, with a one-line reason for each.
- **A readable feed.** Article images, source favicons, publication dates and outlet names. Save stories, share them, or export the feed.
- **Sections.** Topics are filed into categories automatically, and the sidebar can group by them.
- **Notifications** when a check finds something new.
- **Desktop app for macOS**, signed and notarized, with the web UI available at `localhost:4187`.

## Privacy

API keys live in your OS keychain and are never written to the database. Nothing leaves your machine except the topic text sent to the AI provider you picked. Article images are fetched server-side and cached locally, so the browser makes no third-party requests. Data is a SQLite file at `~/.newsmonger`.

## Known limitations in this beta

- **macOS Apple Silicon only.** No Intel, Windows or Linux bundles yet.
- **No auto-update.** New versions mean downloading the next release by hand.
- Subscription-backed providers (Claude CLI, Codex CLI) only run scheduled checks while the app is open; API-key providers run unattended.
- Storage location isn't configurable yet, so pointing it at iCloud or Drive for backup isn't possible.
- Topic section overrides are API-only — there's no UI for changing a topic's section.

## Getting it running

Download the `.dmg`, or `npm install && npm run dev` from source. On first launch the app walks you through picking a provider and adding your first topics.
