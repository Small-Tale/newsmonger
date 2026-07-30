#!/usr/bin/env bash
#
# Interactive release for Newsmonger (NEWS-194).
#
#   npm run release        stable: bump version files, changelog, commit, tag v{ver}
#   npm run release:beta   beta:   tag v{ver}-beta.N
#
# Resumable: progress is kept in .release-state.json, so an abort mid-flow picks
# up where it left off rather than re-asking everything.
#
# Modelled on ~/Documents/{hotsheet,glassbox}/scripts/release.sh, with four
# deliberate differences — each because this repo's release pipeline differs, not
# out of preference:
#
#  1. NO `npm whoami` PREFLIGHT. Those projects publish to npm; this one ships
#     only GitHub Releases with Tauri bundles (.github/workflows/release.yml).
#     Requiring an npm login would block a release on a credential it never uses.
#     If npm publishing is ever added, that check comes back — see NEWS-195.
#
#  2. STABLE PUSHES `v{ver}` DIRECTLY, NOT `v{ver}-rc.N`. Their CI publishes an
#     RC and then auto-promotes it. Ours has no promote step and treats *any*
#     hyphenated tag as a prerelease, so an `-rc.N` tag would publish as a
#     prerelease and sit there forever.
#
#  3. `git describe --match 'v*'`. This repo carries non-version tags
#     (`favicon-work`, `briefing-reel-abandoned`), and an unfiltered describe
#     would anchor the release-notes range at one of those.
#
#  4. BETA BUMPS THE VERSION FILES TOO. Their beta path deliberately leaves
#     package.json alone and lets CI bump ephemerally at publish time. Ours
#     cannot: the release workflow *guards* that the tag's base version matches
#     package.json and tauri.conf.json, and nothing bumps anything in CI — the
#     files are the source of the artifact version. A tag ahead of them is
#     rejected before the build.
#
set -euo pipefail
cd "$(dirname "$0")/.."

STATE_FILE=".release-state.json"

BOLD="\033[1m"; DIM="\033[2m"; GREEN="\033[32m"; YELLOW="\033[33m"
RED="\033[31m"; CYAN="\033[36m"; RESET="\033[0m"
info()    { echo -e "${CYAN}${BOLD}>>>${RESET} $1"; }
success() { echo -e "${GREEN}${BOLD}>>>${RESET} $1"; }
warn()    { echo -e "${YELLOW}${BOLD}>>>${RESET} $1"; }
error()   { echo -e "${RED}${BOLD}>>>${RESET} $1" >&2; }

confirm() {
  local response
  echo -en "${CYAN}${BOLD}>>>${RESET} $1 ${DIM}[y/N]${RESET} "
  read -r response
  [[ "$response" =~ ^[Yy]$ ]]
}

# --- State ------------------------------------------------------------------
init_state()  { [[ -f "$STATE_FILE" ]] || echo '{}' > "$STATE_FILE"; }
get_state()   { node -e "
  const s=JSON.parse(require('fs').readFileSync('$STATE_FILE','utf8'));
  process.stdout.write(s[process.argv[1]]||'');" "$1" 2>/dev/null || echo ""; }
set_state()   { node -e "
  const fs=require('fs');
  const s=JSON.parse(fs.readFileSync('$STATE_FILE','utf8'));
  s[process.argv[1]]=process.argv[2];
  fs.writeFileSync('$STATE_FILE', JSON.stringify(s,null,2));" "$1" "$2"; }
get_step()    { get_state "_step"; }
set_step()    { set_state "_step" "$1"; }
past_step()   { local c; c=$(get_step); [[ -n "$c" ]] && [[ "$c" -gt "$1" ]]; }
cleanup_state() { rm -f "$STATE_FILE"; }

resolve_editor() {
  [[ -n "${EDITOR:-}" ]] && { echo "$EDITOR"; return; }
  [[ -n "${VISUAL:-}" ]] && { echo "$VISUAL"; return; }
  for c in nano vim vi; do command -v "$c" &>/dev/null && { echo "$c"; return; }; done
  echo ""
}

resolve_gitgist() {
  if [[ -x "node_modules/.bin/gitgist" ]]; then echo "node_modules/.bin/gitgist"
  elif command -v gitgist &>/dev/null; then echo "gitgist"; fi
}

# Anchor for the release-notes range.
#
# Stable anchors at the last PRODUCTION tag so the notes cover everything since
# the previous stable, not just since the most recent beta. Beta anchors at
# whatever came last (beta or stable) — betas are incremental and shouldn't
# repeat bullets an earlier beta already carried.
#
# `--match 'v*'` matters here specifically: see note 3 in the header.
last_release_tag() {
  if [[ "$BETA_MODE" == "true" ]]; then
    git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || echo ""
  else
    git describe --tags --abbrev=0 --match 'v*' \
      --exclude='*-beta.*' --exclude='*-rc.*' 2>/dev/null || echo ""
  fi
}

# --- Preflight --------------------------------------------------------------
preflight() {
  info "Pre-flight..."
  [[ -f package.json ]] || { error "No package.json — run from the project root."; exit 1; }

  if [[ -n "$(git status --porcelain)" ]]; then
    warn "Working tree is not clean:"
    git status --short
    confirm "Continue anyway?" || exit 1
  fi

  local branch; branch=$(git branch --show-current)
  if [[ "$branch" != "main" && "$branch" != "master" ]]; then
    warn "On branch '${branch}', not main/master."
    confirm "Continue anyway?" || exit 1
  fi

  # Without this, the beta-number auto-increment and the notes anchor both work
  # off a stale local tag list — which reuses a tag the remote already has (push
  # rejected) or anchors the notes at an out-of-date base (notes repeat shipped
  # work).
  info "Fetching tags from origin..."
  git fetch --tags --prune origin 2>/dev/null || warn "git fetch failed — using the local tag list."

  success "Pre-flight OK (branch=${branch})"
}

# --- Release notes ----------------------------------------------------------
step_release_notes() {
  local prev; prev=$(get_state "release_notes")
  local initial=""

  if [[ -z "$prev" ]]; then
    local last_tag range
    last_tag=$(last_release_tag)
    range="${last_tag:+${last_tag}..HEAD}"

    local gitgist generated=""
    gitgist=$(resolve_gitgist)
    if [[ -n "$gitgist" ]]; then
      info "Drafting notes with gitgist (${range:-since last tag})..."
      generated=$("$gitgist" ${range:+"$range"} 2>/dev/null || true)
      # gitgist emits a `_No changes…_` placeholder rather than failing on an
      # empty range; that is not a draft, so don't seed it into the CHANGELOG.
      [[ "$generated" == _No\ * ]] && generated=""
      [[ -z "$generated" ]] && generated=$("$gitgist" ${range:+"$range"} --no-ai 2>/dev/null || true)
      [[ "$generated" == _No\ * ]] && generated=""
    else
      warn "gitgist not found (it is a devDependency — run 'npm install')."
    fi

    if [[ -n "$generated" ]]; then
      success "Draft ready — review and edit."
      initial="# gitgist draft below. Edit freely; '#' lines are stripped on save.

${generated}"
    else
      initial="# Release notes — SHORT and USER-FACING. Bullets only.
# Skip ticket ids, refactors, tests, docs, internals.
# Lines starting with '#' are stripped on save.

- "
    fi
  else
    initial="$prev"
  fi

  local editor; editor=$(resolve_editor)
  [[ -n "$editor" ]] || { error "No editor found. Set \$EDITOR."; exit 1; }

  local tmpfile; tmpfile=$(mktemp "${TMPDIR:-/tmp}/newsmonger-release-notes.XXXXXX")
  trap "rm -f '$tmpfile'" RETURN
  printf '%s\n' "$initial" > "$tmpfile"

  while true; do
    info "Release notes ${DIM}(opening ${editor##*/})${RESET}"
    $editor "$tmpfile"
    NOTES=$(grep -v '^#' "$tmpfile" | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}')
    if [[ -z "$NOTES" ]]; then
      warn "Release notes are empty."
      confirm "Open the editor again?" || { error "Aborted — notes are required."; exit 1; }
      continue
    fi
    echo ""; echo "$NOTES" | sed 's/^/    /'; echo ""
    confirm "Use this text?" && break
    printf '%s\n' "$NOTES" > "$tmpfile"
  done

  set_state "release_notes" "$NOTES"
}

# --- Version ----------------------------------------------------------------
step_version() {
  local current; current=$(node -p "require('./package.json').version")
  info "Current version: ${BOLD}${current}${RESET}"

  local major minor patch
  IFS='.' read -r major minor patch <<< "$current"
  local next_patch="${major}.${minor}.$((patch + 1))"
  local next_minor="${major}.$((minor + 1)).0"
  local next_major="$((major + 1)).0.0"

  # "Keep" is a real option and often the right one: package.json's version is
  # the *upcoming* release until a v{ver} tag exists for it.
  local keep_note="(no change)"
  git rev-parse "v${current}" >/dev/null 2>&1 && keep_note="${YELLOW}already tagged — pick a bump${RESET}"

  echo ""
  echo -e "    ${DIM}Enter)${RESET} keep   ${BOLD}${current}${RESET} ${DIM}${keep_note}${RESET}"
  echo -e "    ${DIM}1)${RESET}     patch  ${BOLD}${next_patch}${RESET}"
  echo -e "    ${DIM}2)${RESET}     minor  ${BOLD}${next_minor}${RESET}"
  echo -e "    ${DIM}3)${RESET}     major  ${BOLD}${next_major}${RESET}"
  echo -e "    ${DIM}4)${RESET}     custom"
  echo ""
  echo -en "${CYAN}${BOLD}>>>${RESET} Choose version ${DIM}[Enter/1/2/3/4]${RESET} "
  local choice; read -r choice
  case "$choice" in
    "") VERSION="$current" ;;
    1)  VERSION="$next_patch" ;;
    2)  VERSION="$next_minor" ;;
    3)  VERSION="$next_major" ;;
    4)  echo -en "${CYAN}${BOLD}>>>${RESET} Enter version: "; read -r VERSION ;;
    *)  error "Invalid choice"; exit 1 ;;
  esac

  [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    error "Version must be X.Y.Z (got '$VERSION'). Prerelease suffixes go on the tag."
    exit 1
  }
  if [[ "$BETA_MODE" != "true" ]] && git rev-parse "v${VERSION}" >/dev/null 2>&1; then
    error "v${VERSION} already exists. A stable version cannot be released twice."
    exit 1
  fi
  set_state "version" "$VERSION"
}

# --- Version files + changelog ---------------------------------------------
step_update_version() {
  local version; version=$(get_state "version")
  info "Writing v${BOLD}${version}${RESET} into every file that states it..."
  npm version "$version" --no-git-tag-version --allow-same-version >/dev/null
  node scripts/set-version.mjs "$version"
  success "Version files updated"
}

# The tag this run will create, resolved before anything is written (NEWS-196).
#
# The beta number has to be known before the changelog entry, so its heading can
# read `0.1.0-beta.2` rather than `0.1.0`. Otherwise every beta after the first
# collides with the first one's heading — not only a re-run, but the ordinary
# second beta of a version.
#
# Echoes `<tag>\t<changelog-label>`. They differ for a beta: the label carries the
# prerelease suffix, the version *files* never do (macOS bundle version fields
# reject it). One resolver so the heading and the tag can never disagree.
resolve_tag() {
  local version; version=$(get_state "version")
  if [[ "$BETA_MODE" == "true" ]]; then
    local n=1
    while git rev-parse "v${version}-beta.${n}" >/dev/null 2>&1; do n=$((n + 1)); done
    printf '%s\t%s' "v${version}-beta.${n}" "${version}-beta.${n}"
  else
    printf '%s\t%s' "v${version}" "$version"
  fi
}

step_update_changelog() {
  local notes label
  notes=$(get_state "release_notes")
  label=$(resolve_tag | cut -f2)
  info "Updating CHANGELOG.md (${label})..."
  # Notes go via stdin — they are multi-line markdown with quotes and backticks,
  # and passing that as a shell argument is how a changelog gets mangled.
  # `--replace` because this flow is resumable: an abort after this step and a
  # re-run would otherwise prepend a second heading for the same version.
  printf '%s\n' "$notes" | node scripts/add-changelog-entry.mjs "$label" --replace
  success "CHANGELOG.md updated"
}

# --- Gates ------------------------------------------------------------------
# `test:all` is typecheck + lint + unit + E2E. The E2E pass costs ~2 minutes and
# is worth it here: this is the last gate before a tag that publishes a signed
# artifact to strangers. CI re-runs it, but finding a failure now beats finding
# it after the tag is public.
step_checks() {
  info "Running gates (typecheck, lint, unit, E2E)..."
  npm run test:all || { error "Gates failed — nothing tagged."; exit 2; }
  success "Gates passed"
}

# --- Tag + push -------------------------------------------------------------
step_commit() {
  local version; version=$(get_state "version")
  info "Committing the version bump..."
  git add package.json package-lock.json CHANGELOG.md \
          src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock 2>/dev/null || true
  git diff --cached --quiet && { warn "Nothing to commit (version files already current)."; return; }
  git commit -m "release: v${version}"
  success "Committed"
}

step_tag_and_push() {
  local notes tag
  notes=$(get_state "release_notes")
  # The same resolver the changelog step used, so the heading and the tag agree.
  tag=$(resolve_tag | cut -f1)

  info "Creating annotated tag ${BOLD}${tag}${RESET}..."
  printf '%s\n' "$notes" | git tag -a "$tag" -F -

  info "Pushing commit and tag to origin..."
  git push || { error "git push failed. Tag exists locally: git tag -d ${tag}"; exit 3; }
  git push origin "$tag" || {
    error "Tag push failed. Retry: git push origin ${tag}"
    error "Unwind:              git tag -d ${tag}"
    exit 3
  }

  echo ""
  success "${tag} pushed."
  echo ""
  if [[ "$BETA_MODE" == "true" ]]; then
    echo -e "  ${DIM}CI will build, sign, notarize, verify, and publish a${RESET} ${BOLD}prerelease${RESET}."
    echo -e "  ${DIM}It stays opt-in: GitHub's releases/latest skips prereleases.${RESET}"
  else
    echo -e "  ${DIM}CI will build, sign, notarize, verify, and publish the release.${RESET}"
  fi
  echo ""
  echo -e "  ${DIM}Monitor:${RESET} https://github.com/Small-Tale/newsmonger/actions"
  echo -e "  ${DIM}Unwind before CI finishes:${RESET}"
  echo -e "    git push origin :refs/tags/${tag} && git tag -d ${tag}"
}

# --- Main -------------------------------------------------------------------
BETA_MODE=false
for arg in "$@"; do
  case "$arg" in
    --beta) BETA_MODE=true ;;
    -h|--help)
      echo "Usage: bash scripts/release.sh [--beta]"
      echo "  (no flag)  stable release: bump version files, changelog, commit, tag v{ver}"
      echo "  --beta     beta release:   same bump, tag v{ver}-beta.N"
      exit 0 ;;
    *) error "Unrecognized arg: $arg"; exit 1 ;;
  esac
done

echo ""
if [[ "$BETA_MODE" == "true" ]]; then
  echo -e "${BOLD}  Newsmonger Beta Release${RESET}"
  echo -e "  ${DIM}Publishes a GitHub prerelease. No auto-promote.${RESET}"
else
  echo -e "${BOLD}  Newsmonger Release${RESET}"
fi
echo ""

init_state
resume=$(get_step)
if [[ -n "$resume" && "$resume" -gt 0 ]]; then
  warn "Found saved progress (step ${resume}/6)."
  if confirm "Resume?"; then echo ""
  elif confirm "Start over?"; then cleanup_state; init_state
  else exit 0; fi
fi

past_step 1 || { preflight;            set_step 1; }
past_step 2 || { step_release_notes;   set_step 2; }
past_step 3 || { echo ""; step_version; set_step 3; }

if ! past_step 4; then
  version=$(get_state "version"); notes=$(get_state "release_notes")
  echo ""
  echo -e "${BOLD}━━━ Release Summary ━━━${RESET}"
  echo ""
  echo -e "  ${DIM}Channel:${RESET} $([[ "$BETA_MODE" == "true" ]] && echo "beta (prerelease)" || echo "stable")"
  echo -e "  ${DIM}Version:${RESET} ${BOLD}${version}${RESET}"
  echo -e "  ${DIM}Notes:${RESET}"
  printf '%s\n' "$notes" | sed 's/^/    /'
  echo ""
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo ""
  confirm "Proceed?" || { warn "Aborted. State saved — run again to resume."; exit 0; }
  set_step 4
fi

# Both channels bump the version files and commit — see note 4 in the header.
past_step 5 || {
  echo ""
  step_update_version
  step_update_changelog
  step_checks
  set_step 5
}
past_step 6 || { step_commit; step_tag_and_push; set_step 6; }

echo ""
success "Done."
cleanup_state
