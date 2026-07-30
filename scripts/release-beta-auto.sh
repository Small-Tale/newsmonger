#!/usr/bin/env bash
#
# Non-interactive beta release (NEWS-194).
#
# Same outcome as `npm run release:beta` (`scripts/release.sh --beta`) but
# answers every prompt itself, so it can run from automation, a cron, or Claude
# when the user says "cut a beta".
#
# Why a separate script rather than piping answers into release.sh: that one is a
# resumable state machine with several `read`-driven branches — the version menu,
# the editor loop and its "use this text?" confirm, the proceed confirm, and the
# resume prompt. What the right answers *are* depends on the saved
# `.release-state.json`, so echo-piping them is brittle. Re-implementing the beta
# path is cleaner than bending the interactive script into something it isn't.
#
# What it does:
#   1. Preflight: tree clean (hard fail, unlike the interactive version, which
#      asks), on main/master, node present, fetch tags.
#   2. Pick the target version: `--version X.Y.Z` or a bare positional wins.
#      Otherwise package.json's version if it hasn't shipped as a stable tag —
#      it IS the upcoming release — else the next minor.
#   3. Draft notes with gitgist over <lastVersionTag>..HEAD: AI draft, then
#      `--no-ai` deterministic grouping, then a git-log pointer. Override with
#      `--notes <file>` / `--notes-stdin`.
#   4. Gates: npm run test:all (typecheck + lint + unit + E2E).
#   5. Write the version into every file, update CHANGELOG.md, commit.
#   6. Auto-increment the beta number, annotated tag, push commit + tag.
#
# Unlike glassbox/hotsheet this DOES bump version files and commit — see note 4
# in scripts/release.sh. The release workflow guards that the tag's base version
# matches package.json/tauri.conf.json, and nothing bumps in CI.
#
# Exit codes:
#   0 — pushed (or --dry-run completed); CI is running.
#   1 — preflight / argument failure.
#   2 — gates failed.
#   3 — git commit, tag or push failed.
#
set -euo pipefail
cd "$(dirname "$0")/.."

# Colours off on a non-tty so captured logs stay readable.
if [[ -t 1 ]]; then
  BOLD="\033[1m"; DIM="\033[2m"; GREEN="\033[32m"; YELLOW="\033[33m"
  RED="\033[31m"; CYAN="\033[36m"; RESET="\033[0m"
else
  BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; CYAN=""; RESET=""
fi
info()    { echo -e "${CYAN}${BOLD}>>>${RESET} $1"; }
success() { echo -e "${GREEN}${BOLD}>>>${RESET} $1"; }
warn()    { echo -e "${YELLOW}${BOLD}>>>${RESET} $1"; }
error()   { echo -e "${RED}${BOLD}>>>${RESET} $1" >&2; }

OVERRIDE_VERSION=""
SKIP_TESTS="false"
DRY_RUN="false"
NOTES_OVERRIDE=""
NOTES_LABEL=""

set_version_arg() {
  [[ -n "$OVERRIDE_VERSION" ]] && { error "Version given twice ('$OVERRIDE_VERSION' and '$1')."; exit 1; }
  OVERRIDE_VERSION="$1"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)     [[ -z "${2:-}" ]] && { error "--version needs a value (e.g. --version 0.2.0)"; exit 1; }
                   set_version_arg "$2"; shift 2 ;;
    --version=*)   set_version_arg "${1#--version=}"; shift ;;
    --skip-tests)  SKIP_TESTS="true"; shift ;;
    --dry-run)     DRY_RUN="true"; shift ;;
    --notes)       [[ -f "${2:-}" ]] || { error "--notes needs a readable file (or use --notes-stdin)"; exit 1; }
                   NOTES_OVERRIDE=$(cat "$2"); NOTES_LABEL="--notes $2"; shift 2 ;;
    --notes=*)     p="${1#--notes=}"; [[ -f "$p" ]] || { error "--notes file not found: $p"; exit 1; }
                   NOTES_OVERRIDE=$(cat "$p"); NOTES_LABEL="--notes=$p"; shift ;;
    --notes-stdin) NOTES_OVERRIDE=$(cat); NOTES_LABEL="--notes-stdin"; shift ;;
    -h|--help)
      cat <<EOF
Usage: bash scripts/release-beta-auto.sh [X.Y.Z | --version X.Y.Z] [--skip-tests] [--dry-run]
                                         [--notes <file> | --notes-stdin]

Non-interactive beta release — same result as \`npm run release:beta\` without prompts.

Version:  pass X.Y.Z (bare or via --version) to target it explicitly. Otherwise
          package.json's version is used when it hasn't shipped as a stable tag
          yet, else the next minor.
Notes:    drafted by gitgist over <lastVersionTag>..HEAD (AI, then --no-ai, then a
          git-log pointer). Override with --notes / --notes-stdin.
--skip-tests  skip the local gates. CI re-runs them, but the tag is already public
              by then, so prefer not to.
--dry-run     do everything EXCEPT commit, tag and push.

Examples:
  npm run release:beta:auto
  npm run release:beta:auto -- --version 0.2.0
  npm run release:beta:auto -- 0.2.0 --dry-run
  echo "- fixed X" | npm run release:beta:auto -- --notes-stdin
EOF
      exit 0 ;;
    -*) error "Unrecognized arg: $1"; exit 1 ;;
    *)  set_version_arg "$1"; shift ;;
  esac
done

if [[ -n "$OVERRIDE_VERSION" && ! "$OVERRIDE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  error "Version must be X.Y.Z (got '$OVERRIDE_VERSION'). Prerelease suffixes go on the tag."
  exit 1
fi

# --- Preflight --------------------------------------------------------------
preflight() {
  info "Preflight..."
  [[ -f package.json ]] || { error "No package.json — run from the project root."; exit 1; }
  command -v node >/dev/null || { error "node not found on PATH."; exit 1; }

  # Hard fail rather than the interactive script's prompt: unattended, a dirty
  # tree means the tag would capture work nobody reviewed.
  if [[ -n "$(git status --porcelain)" ]]; then
    error "Working tree is dirty. Commit or stash first."
    git status --short >&2
    exit 1
  fi

  local branch; branch=$(git branch --show-current)
  if [[ "$branch" != "main" && "$branch" != "master" ]]; then
    error "On branch '${branch}', not main/master. Refusing to cut a beta from a side branch."
    exit 1
  fi

  info "Fetching tags from origin..."
  git fetch --tags --prune origin 2>/dev/null || warn "git fetch failed (offline?) — using the local tag list."
  success "Preflight clean (branch=${branch})"
}

# --- Target version ---------------------------------------------------------
read_version() {
  if [[ -n "$OVERRIDE_VERSION" ]]; then
    VERSION="$OVERRIDE_VERSION"
    info "Target version (explicit): ${BOLD}${VERSION}${RESET}"
    return
  fi
  local current; current=$(node -p "require('./package.json').version")
  if git rev-parse "v${current}" >/dev/null 2>&1; then
    local major minor patch
    IFS='.' read -r major minor patch <<< "$current"
    VERSION="${major}.$((minor + 1)).0"
    info "package.json (${current}) already shipped as a stable tag — targeting next minor: ${BOLD}${VERSION}${RESET}"
  else
    VERSION="$current"
    info "package.json (${VERSION}) has not shipped stable — targeting it directly"
  fi
}

# --- Notes ------------------------------------------------------------------
draft_notes() {
  if [[ -n "$NOTES_OVERRIDE" ]]; then
    NOTES="$NOTES_OVERRIDE"
    info "Notes from ${BOLD}${NOTES_LABEL}${RESET}:"
    printf '%s\n' "$NOTES" | sed 's/^/    /'
    return
  fi

  # `--match 'v*'` because this repo carries non-version tags (favicon-work,
  # briefing-reel-abandoned) that would otherwise anchor the range.
  local last_tag range pointer
  last_tag=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || echo "")
  range="${last_tag:+${last_tag}..HEAD}"
  pointer="- See \`git log ${range:-HEAD}\` for details."

  local gitgist=""
  if [[ -x "node_modules/.bin/gitgist" ]]; then gitgist="node_modules/.bin/gitgist"
  elif command -v gitgist >/dev/null; then gitgist="gitgist"; fi

  if [[ -z "$gitgist" ]]; then
    warn "gitgist not found (it is a devDependency — run 'npm install'). Using a git-log pointer."
    NOTES="$pointer"; return
  fi

  info "Drafting notes with gitgist (${range:-since last tag})..."
  local generated
  generated=$("$gitgist" ${range:+"$range"} 2>/dev/null || true)
  [[ "$generated" == _No\ * ]] && generated=""
  if [[ -z "$generated" ]]; then
    warn "gitgist AI draft empty/failed — falling back to deterministic (--no-ai) grouping."
    generated=$("$gitgist" ${range:+"$range"} --no-ai 2>/dev/null || true)
    [[ "$generated" == _No\ * ]] && generated=""
  fi
  NOTES="${generated:-$pointer}"

  echo ""; printf '%s\n' "$NOTES" | sed 's/^/    /'; echo ""
}

# --- Gates ------------------------------------------------------------------
run_gates() {
  if [[ "$SKIP_TESTS" == "true" ]]; then
    warn "Skipping gates (--skip-tests). CI re-runs them, but the tag is public by then."
    return
  fi
  info "Gates (typecheck, lint, unit, E2E)..."
  npm run test:all || { error "Gates failed — nothing committed or tagged."; exit 2; }
  success "Gates passed"
}

# --- Version files + changelog + commit + tag -------------------------------
apply_version() {
  info "Writing v${BOLD}${VERSION}${RESET} into every file that states it..."
  npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null
  node scripts/set-version.mjs "$VERSION"

  info "Updating CHANGELOG.md..."
  node -e "
    const fs = require('fs');
    const f = 'CHANGELOG.md';
    const entry = process.argv[1];
    if (!fs.existsSync(f)) { fs.writeFileSync(f, '# Changelog\n\n' + entry + '\n'); return; }
    const cur = fs.readFileSync(f, 'utf8');
    const at = cur.indexOf('\n## [');
    fs.writeFileSync(f, at === -1
      ? cur.replace(/\n+$/, '') + '\n\n' + entry + '\n'
      : cur.slice(0, at) + '\n' + entry + '\n' + cur.slice(at));
  " "## [${VERSION}] - $(date +%Y-%m-%d)

${NOTES}"
}

commit_tag_push() {
  local n=1
  while git rev-parse "v${VERSION}-beta.${n}" >/dev/null 2>&1; do n=$((n + 1)); done
  local tag="v${VERSION}-beta.${n}"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo ""
    success "Dry run complete — would commit the bump and push ${BOLD}${tag}${RESET} at $(git rev-parse --short HEAD)."
    info "Version files and CHANGELOG.md were modified locally; 'git checkout -- .' to discard."
    return
  fi

  git add package.json package-lock.json CHANGELOG.md \
          src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock 2>/dev/null || true
  if git diff --cached --quiet; then
    warn "Nothing to commit — version files were already at ${VERSION}."
  else
    git commit -m "release: v${VERSION}" || { error "git commit failed."; exit 3; }
  fi

  info "Creating annotated tag ${BOLD}${tag}${RESET}..."
  printf '%s\n' "$NOTES" | git tag -a "$tag" -F - || { error "git tag failed."; exit 3; }

  info "Pushing commit and tag..."
  git push || { error "git push failed. Tag exists locally: git tag -d ${tag}"; exit 3; }
  git push origin "$tag" || {
    error "Tag push failed. Retry: git push origin ${tag}"
    error "Unwind:              git tag -d ${tag}"
    exit 3
  }

  echo ""
  success "Beta tag ${BOLD}${tag}${RESET} pushed."
  echo ""
  echo -e "  ${DIM}CI will build, sign, notarize, verify, then publish a${RESET} ${BOLD}prerelease${RESET}."
  echo -e "  ${DIM}It stays opt-in — GitHub's releases/latest skips prereleases.${RESET}"
  echo ""
  echo -e "  ${DIM}Monitor:${RESET} https://github.com/Small-Tale/newsmonger/actions"
  echo -e "  ${DIM}Unwind before CI finishes:${RESET}"
  echo -e "    git push origin :refs/tags/${tag} && git tag -d ${tag}"
}

echo ""
echo -e "${BOLD}  Newsmonger Beta — non-interactive${RESET}"
[[ "$DRY_RUN" == "true" ]] && echo -e "  ${DIM}--dry-run: nothing will be committed, tagged or pushed.${RESET}"
echo ""

preflight
read_version
draft_notes
run_gates
apply_version
commit_tag_push
