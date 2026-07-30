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
