#!/usr/bin/env bash
# Check, commit, and push — the routine that keeps this repository from
# losing work to a crash, a power cut, or a wiped /tmp.
#
#   scripts/repe_checkpoint.sh              # check, commit if clean-able, push
#   scripts/repe_checkpoint.sh --no-push    # local only
#   scripts/repe_checkpoint.sh --verify     # run the full verification first
#
# What it does, in order:
#   1. Verifies the generator is in sync with the module workspace.
#   2. Optionally runs the full end-to-end verification suite.
#   3. Stages the guard's source, the module workspace, the calibrated
#      vectors, and the evaluation scripts.
#   4. Commits with a message that says what changed.
#   5. Pushes to origin, and tells you plainly if it could not.
#
# It NEVER force-pushes and NEVER rewrites history.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

DO_PUSH=1
DO_VERIFY=0
MESSAGE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --no-push) DO_PUSH=0; shift ;;
    --verify)  DO_VERIFY=1; shift ;;
    -m|--message) MESSAGE="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say "1. generator sync"
if ! python3 repe-compose.py --check; then
  echo "The generator is out of sync with repe-mods/." >&2
  echo "Run:  python3 repe-compose.py && bash upgrade_generic_viz.sh" >&2
  echo "Then stage the regenerated generator and try again." >&2
  exit 1
fi
echo "generator is in sync with repe-mods/"

if [ "$DO_VERIFY" -eq 1 ]; then
  say "2. full verification"
  if bash evals/verify_all.sh; then
    echo "verification passed"
  else
    echo "VERIFICATION FAILED — not committing." >&2
    exit 1
  fi
fi

say "3. stage"
git add -A \
  repe-mods/ \
  repe-compose.py \
  upgrade_generic_viz.sh \
  evals/ \
  .githooks/ \
  scripts/ \
  extract_repe_vectors.py \
  qwen-clef-repe-guard/artifacts/ \
  .gitignore 2>/dev/null || true
# The generated project tree is committed too, so a fresh clone has both the
# canonical modules and a ready-to-build project. The pre-commit hook is what
# guarantees the two cannot drift apart.

STAGED="$(git diff --cached --name-only | wc -l | tr -d ' ')"
echo "$STAGED file(s) staged"

if [ "$STAGED" -eq 0 ]; then
  say "nothing to commit"
else
  say "4. commit"
  if [ -z "$MESSAGE" ]; then
    MESSAGE="chore(repe-guard): checkpoint $(date '+%Y-%m-%d %H:%M')"
  fi
  git commit -m "$MESSAGE" || exit 1
fi

if [ "$DO_PUSH" -eq 1 ]; then
  say "5. push"
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  if git push origin "$BRANCH"; then
    echo "pushed to origin/$BRANCH"
    git status -sb | head -1
  else
    echo "PUSH FAILED — the commit is local only. Retry with:" >&2
    echo "  git push origin $BRANCH" >&2
    exit 1
  fi
fi

say "done"
git log --oneline -1
git status -sb | head -1
