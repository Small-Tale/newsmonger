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
