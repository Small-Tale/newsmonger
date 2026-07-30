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
