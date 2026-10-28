#!/usr/bin/env bash
#
# flip-releases.sh — make the existing pre-releases show up as real releases.
#
# Every release so far was created with `--prerelease`, and GitHub hides
# pre-releases from the repository's front page: the sidebar says "4 tags"
# and "Create a new release" instead of listing the downloads.  The assets
# were there the whole time — they were just not linked from anywhere
# anybody would look.
#
#     ./scripts/flip-releases.sh
#
# It flips every pre-release in the repository to a full release, so the
# front page shows the newest one and `/releases/latest/download/<file>`
# works.  Needs a token with write access to the repository:
#
#     GITHUB_TOKEN=... ./scripts/flip-releases.sh
#
# Nothing is deleted.  Only the pre-release flag changes.

set -uo pipefail

REPO="${GITHUB_REPO:-maceip/zode}"
API="https://api.github.com/repos/${REPO}"
TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"

if [ -z "${TOKEN}" ]; then
    echo "set GITHUB_TOKEN to a token with write access to ${REPO}"
    exit 1
fi

echo "flipping the pre-releases in ${REPO}"
echo

FLIPPED=0
KEPT=0

while read -r tag; do
    [ -z "${tag}" ] && continue
    # PATCH the release: prerelease -> false
    RESP=$(curl -sS -X PATCH \
        -H "Authorization: token ${TOKEN}" \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        "${API}/releases/tags/${tag}" \
        -d '{"prerelease":false,"make_latest":"true"}')

    if echo "${RESP}" | grep -q '"prerelease":false'; then
        echo "  ✔ ${tag} is now a full release"
        FLIPPED=$((FLIPPED + 1))
    else
        echo "  ✘ ${tag} could not be flipped:"
        echo "${RESP}" | head -3 | sed 's/^/      /'
        KEPT=$((KEPT + 1))
    fi
done < <(curl -sS -H "Authorization: token ${TOKEN}" -H "Accept: application/vnd.github+json" \
            "${API}/releases?per_page=100" \
          | python3 -c "
import sys, json
try:
    releases = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if isinstance(releases, dict):
    sys.exit(0)
for r in releases:
    if r.get('prerelease') or r.get('draft'):
        print(r['tag_name'])
")

echo
echo "${FLIPPED} flipped, ${KEPT} not."
echo
echo "The front page now shows the newest release, and this works:"
echo "  https://github.com/${REPO}/releases/latest/download/zode-macos-0.1.0-universal.dmg"
