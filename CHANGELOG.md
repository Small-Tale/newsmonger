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
