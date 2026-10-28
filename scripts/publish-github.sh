#!/usr/bin/env bash
#
# Publish the Zode repository to GitHub as a PUBLIC repo named `zode`.
#
# Requires a GitHub token with the `repo` scope. Provide it in ONE of these ways:
#
#   1. Environment variable (recommended):
#        export GH_TOKEN=ghp_xxxxxxxxxxxxxxxx
#        ./scripts/publish-github.sh
#
#   2. An existing `gh` CLI session:
#        gh auth login
#        ./scripts/publish-github.sh
#
#   3. Interactive prompt (if neither is set).
#
# The script is idempotent: if the repository already exists it pushes to it
# instead of failing.
#
set -euo pipefail

REPO_NAME="${ZODE_REPO_NAME:-zode}"
REPO_OWNER="${ZODE_REPO_OWNER:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT"

command -v gh >/dev/null 2>&1 || {
  echo "error: the GitHub CLI ('gh') is required." >&2
  echo "  macOS:   brew install gh" >&2
  echo "  Windows: winget install GitHub.cli" >&2
  exit 1
}

# ---- resolve auth ---------------------------------------------------------
if [[ -z "${GH_TOKEN:-}" && -z "${GITHUB_TOKEN:-}" ]]; then
  if gh auth status >/dev/null 2>&1; then
    echo "==> using the existing gh authentication"
  else
    echo "No GitHub credentials found."
    echo "Create a token at https://github.com/settings/tokens/new with the 'repo' scope."
    printf "Paste token (input hidden): "
    read -rs GH_TOKEN
    echo
    export GH_TOKEN
  fi
fi

# ---- sanity checks --------------------------------------------------------
if [[ ! -d .git ]]; then
  echo "==> initialising the git repository"
  git init -q -b main
  git config user.name  "${ZODE_GIT_NAME:-zode}"
  git config user.email "${ZODE_GIT_EMAIL:-zode@users.noreply.github.com}"
fi

if [[ -z "$(git status --porcelain)" ]]; then
  echo "==> nothing to commit; the working tree is clean"
else
  echo "==> staging and committing"
  git add -A
  git commit -q -m "Zode: native shells, Metro web app, and mobile clients"
fi

# ---- the target repository ------------------------------------------------
target="$REPO_NAME"
if [[ -n "$REPO_OWNER" ]]; then
  target="$REPO_OWNER/$REPO_NAME"
fi

if gh repo view "$target" >/dev/null 2>&1; then
  echo "==> https://github.com/$target already exists; pushing to it"
  git remote remove origin >/dev/null 2>&1 || true
  git remote add origin "https://github.com/$target.git"
  git push -u origin main
else
  echo "==> creating the PUBLIC repository '$target'"
  gh repo create "$target" \
    --public \
    --source=. \
    --remote=origin \
    --push \
    --description "Code content before chrome — native macOS/Windows shells, a Metro web app, and iOS + Android clients"
fi

echo
echo "Done.  https://github.com/$target"
echo
echo "Optional follow-ups:"
echo "  gh repo edit '$target' --homepage 'https://github.com/$target'"
echo "  # upload the 1280x640 social preview (icons/social-preview.png) under"
echo "  # Settings -> General -> Social preview"
