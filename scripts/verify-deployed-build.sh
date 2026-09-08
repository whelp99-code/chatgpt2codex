#!/usr/bin/env bash
# Verify that an installed macOS app's dist/ was actually produced by `npm run
# build` from a commit in this repository, rather than by a .pkg installer (or
# anything else) that touched production outside git.
#
# A .pkg built by scripts/build-macos-app.sh installs straight from a local
# working tree — nothing forces that tree to be a clean checkout of a pushed
# commit. This script closes that gap after the fact: it hashes the installed
# dist/, rebuilds dist/ from a real git commit in an isolated worktree, and
# reports whether they match.
set -Eeuo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="${APP_NAME:-ChatGPT To Codex}"
APP_PATH="${DEPLOYED_APP_PATH:-/Applications/${APP_NAME}.app}"
REF="HEAD"
SEARCH=0
SEARCH_DEPTH=30

usage() {
  cat <<'EOF'
Usage: verify-deployed-build.sh [options]

  --app PATH        Installed .app bundle to check (default: /Applications/ChatGPT To Codex.app)
  --ref REF         Git commit/branch to build and compare against (default: HEAD)
  --search [N]      Instead of only checking --ref, walk back up to N recent
                     commits (default 30) on the current branch looking for
                     one whose build matches the installed dist/ exactly
  -h, --help        Show this help

Exit code 0 means the installed dist/ was reproduced byte-for-byte from a real
commit's build output. Any other outcome (mismatch, no dist/ found, app not
found) exits non-zero and explains why.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --app) APP_PATH="${2:?--app requires a path}"; shift 2 ;;
    --ref) REF="${2:?--ref requires a commit-ish}"; shift 2 ;;
    --search)
      SEARCH=1
      if [ "${2:-}" ] && [[ "$2" =~ ^[0-9]+$ ]]; then SEARCH_DEPTH="$2"; shift 2; else shift; fi
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

say() { printf '[verify-deployed-build] %s\n' "$*"; }

INSTALLED_DIST="$APP_PATH/Contents/Resources/chatgpt2codex/dist"
if [ ! -d "$INSTALLED_DIST" ]; then
  echo "no dist/ found under: $INSTALLED_DIST" >&2
  echo "(pass --app to point at the actual installed bundle)" >&2
  exit 1
fi

# Order-independent, content-and-path hash of a dist/ tree: every regular
# file's relative path and sha256 digest, sorted, hashed together. Using
# `find -print0` keeps filenames with spaces/newlines safe.
hash_tree() {
  local dir="$1"
  (
    cd "$dir"
    find . -type f -print0 | sort -z | xargs -0 shasum -a 256 | sort -k2
  ) | shasum -a 256 | awk '{print $1}'
}

installed_hash="$(hash_tree "$INSTALLED_DIST")"
say "installed dist/ ($INSTALLED_DIST): $installed_hash"

build_ref_hash() {
  local ref="$1" worktree
  worktree="$(mktemp -d "${TMPDIR:-$HOME/.cache}/c2c-verify.XXXXXX")"
  trap 'rm -rf "$worktree"' RETURN
  git -C "$ROOT" worktree add --detach --force "$worktree" "$ref" >/dev/null 2>&1 \
    || { echo "unknown ref: $ref" >&2; return 2; }
  (
    cd "$worktree"
    npm ci --no-audit --no-fund --silent >/dev/null 2>&1 || npm install --no-audit --no-fund --silent >/dev/null 2>&1
    npm run build --silent >/dev/null 2>&1
  )
  local h
  h="$(hash_tree "$worktree/dist")"
  git -C "$ROOT" worktree remove --force "$worktree" >/dev/null 2>&1 || true
  echo "$h"
}

if [ "$SEARCH" -eq 1 ]; then
  say "searching the last $SEARCH_DEPTH commits on the current branch for a match..."
  found=""
  while IFS=' ' read -r sha subject; do
    [ -z "$sha" ] && continue
    say "  trying $sha ($subject)..."
    h="$(build_ref_hash "$sha" || true)"
    if [ -n "$h" ] && [ "$h" = "$installed_hash" ]; then
      found="$sha"
      break
    fi
  done < <(git -C "$ROOT" log -n "$SEARCH_DEPTH" --format='%h %s')
  if [ -n "$found" ]; then
    echo "MATCH: installed dist/ was built from commit $found" \
      "($(git -C "$ROOT" show -s --format='%s' "$found"))"
    exit 0
  else
    echo "NO MATCH: installed dist/ does not correspond to any of the last $SEARCH_DEPTH commits." >&2
    echo "It may have been produced by an uncommitted change or a .pkg built outside this checkout." >&2
    exit 1
  fi
fi

ref_hash="$(build_ref_hash "$REF")"
ref_sha="$(git -C "$ROOT" rev-parse --short "$REF")"
say "build of $REF ($ref_sha): $ref_hash"

if [ "$installed_hash" = "$ref_hash" ]; then
  echo "MATCH: installed dist/ was built from $REF ($ref_sha)."
  exit 0
else
  echo "MISMATCH: installed dist/ does NOT match a build of $REF ($ref_sha)." >&2
  echo "Re-run with --search to look for the commit it actually matches," >&2
  echo "or treat this install as unverified (possibly a .pkg-only change that bypassed git)." >&2
  exit 1
fi
