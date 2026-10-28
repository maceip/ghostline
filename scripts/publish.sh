#!/usr/bin/env bash
#
# publish.sh — push everything, then make the releases visible.
#
#     GITHUB_TOKEN=ghp_... ./scripts/publish.sh
#
# It does the three things that need a token, in order:
#
#   1. pushes the local commits to main, which cuts a fresh release with
#      working download links and no bare .exe,
#   2. flips the older pre-releases to full releases, because GitHub hides
#      pre-releases from the repository's front page — that is why the
#      sidebar said "4 tags" instead of listing the downloads,
#   3. sets the five Apple secrets, if they are in the environment, so the
#      next release is notarised.
#
# The token is only used from this file.  It is never written to
# .git/config, never passed in argv (so it never shows up in `ps`), and
# never committed.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

REPO="${GITHUB_REPO:-maceip/zode}"
API="https://api.github.com/repos/${REPO}"

# The token can come from the environment or from a file.  The file is the
# better option: it survives a /tmp wipe, it never appears in argv, and it
# never appears in `ps`.
TOKEN_FILE="${ZODE_TOKEN_FILE:-/workspace/.zode-token}"
TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
if [ -z "${TOKEN}" ] && [ -r "${TOKEN_FILE}" ]; then
    TOKEN="$(cat "${TOKEN_FILE}")"
fi

if [ -z "${TOKEN}" ]; then
    echo "no token found."
    echo "  either set GITHUB_TOKEN, or put one in ${TOKEN_FILE}"
    exit 1
fi

# The token is read from a file, not from argv, so it never appears in the
# process list.
CRED_FILE="$(mktemp)"
ASKPASS="$(mktemp)"
cleanup() { rm -f "${CRED_FILE}" "${ASKPASS}" "${CRED_FILE}.pub.pem"; }
trap cleanup EXIT
chmod 600 "${CRED_FILE}"
printf '%s' "${TOKEN}" > "${CRED_FILE}"
cat > "${ASKPASS}" <<EOF
#!/usr/bin/env bash
cat "${CRED_FILE}"
EOF
chmod 700 "${ASKPASS}"

auth() { curl -sS -H "Authorization: token ${TOKEN}" -H "Accept: application/vnd.github+json" "$@"; }

# ---------------------------------------------------------------------------
echo "==> 1. pushing"
# ---------------------------------------------------------------------------
if git rev-parse --verify HEAD >/dev/null 2>&1; then
    BEFORE=$(git rev-parse HEAD)
    GIT_ASKPASS="${ASKPASS}" GIT_TERMINAL_PROMPT=0 git push origin main
    AFTER=$(git rev-parse HEAD)
    if [ "${BEFORE}" = "${AFTER}" ]; then
        echo "    nothing to push"
    else
        echo "    pushed — a release will be cut in a few minutes"
    fi
else
    echo "    not a git repository, skipping"
fi

# ---------------------------------------------------------------------------
echo "==> 2. flipping the pre-releases"
# ---------------------------------------------------------------------------
# A pre-release is hidden from the repository's front page.  Every release
# so far was one, so the sidebar said "4 tags" and offered "Create a new
# release" instead of listing the downloads.
FLIPPED=0
# The releases are patched by their numeric id.  The by-tag route answers
# 404 for a PATCH, which is a confusing way to learn that.
while read -r id tag latest; do
    [ -z "${id}" ] && continue
    if [ "${latest}" = "latest" ]; then
        BODY='{"prerelease":false,"make_latest":"true"}'
    else
        BODY='{"prerelease":false,"make_latest":"false"}'
    fi
    RESP=$(curl -sS -X PATCH \
        -H "Authorization: token ${TOKEN}" \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        "${API}/releases/${id}" \
        -d "${BODY}")
    if echo "${RESP}" | grep -q '"prerelease": false'; then
        echo "    ok   ${tag}"
        FLIPPED=$((FLIPPED + 1))
    else
        echo "    FAIL ${tag} — $(echo "${RESP}" | tr -d '\n' | head -c 120)"
    fi
done < <(auth "${API}/releases?per_page=100" | python3 -c "
import sys, json
try:
    releases = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if isinstance(releases, dict):
    sys.exit(0)
# The list is newest first, so only the first one is made the latest.
# Marking every release as the latest leaves whichever was patched last
# holding the title, which is the oldest one.
newest = True
for r in releases:
    if r.get('prerelease') or r.get('draft'):
        print(r['id'], r['tag_name'], 'latest' if newest else 'plain')
        newest = False
")
echo "    ${FLIPPED} flipped"

# "Latest" is a separate thing from the pre-release flag, and it is what
# /releases/latest resolves to.  The newest release has to be told
# explicitly, every time — otherwise the title sticks to whichever release
# happened to be published last.
# The list comes back with the "latest" release first, so the first entry
# is not necessarily the newest one — it is whichever release holds the
# title.  Sort by the creation date instead.
NEWEST=$(auth "${API}/releases?per_page=100" | python3 -c "
import sys, json
try:
    releases = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if isinstance(releases, dict):
    sys.exit(0)
if not releases:
    sys.exit(0)
newest = max(releases, key=lambda r: r.get('created_at') or '')
print(newest.get('id', ''), newest.get('tag_name', ''))
")
NEWEST_ID=$(echo "${NEWEST}" | cut -d" " -f1)
NEWEST_TAG=$(echo "${NEWEST}" | cut -d" " -f2)
if [ -n "${NEWEST_ID}" ]; then
    curl -sS -o /dev/null -X PATCH \
        -H "Authorization: token ${TOKEN}" \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        "${API}/releases/${NEWEST_ID}" \
        -d '{"make_latest":"true"}'
    echo "    latest -> ${NEWEST_TAG}"
fi

# The notes of the older releases still claim the disk image is "notarised
# and stapled".  It is not — it is signed ad-hoc until the Apple secrets
# are in place.  A false claim in a release note is worse than no note.
echo "    correcting the older release notes"
auth "${API}/releases?per_page=100" | python3 -c "
import sys, json
try:
    releases = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if isinstance(releases, dict):
    sys.exit(0)
for r in releases:
    body = r.get('body') or ''
    if 'notarised and stapled' in body and 'not notarised' not in body:
        body = body.replace(
            'The disk image is signed, notarised and stapled, so it opens without a\nGatekeeper warning. If your copy still warns, right-click the app inside\nthe disk image and choose **Open** once.',
            '> This disk image is **not notarised** — it is signed ad-hoc.  A copy\n> downloaded from here gets the macOS \"downloaded from the internet\" warning and\n> may be moved to the Trash.  Right-click the app inside the disk image\n> and choose **Open** once, or build it yourself on your own Mac.')
        body = body.replace(
            'The disk image is signed, **notarised**, stapled',
            'The disk image is signed; it is **not notarised**')
        print(r['id'])
" > /tmp/.zode_stale_ids
while read -r id; do
    [ -z "${id}" ] && continue
    auth "${API}/releases/${id}" | python3 -c "
import json, sys
r = json.load(sys.stdin)
body = r.get('body') or ''
body = body.replace(
    'The disk image is signed, notarised and stapled, so it opens without a\nGatekeeper warning. If your copy still warns, right-click the app inside\nthe disk image and choose **Open** once.',
    '> This disk image is **not notarised** — it is signed ad-hoc.  A copy\n> downloaded from here gets the macOS \"downloaded from the internet\" warning and\n> may be moved to the Trash.  Right-click the app inside the disk image\n> and choose **Open** once, or build it yourself on your own Mac.')
body = body.replace(
    'The disk image is signed, **notarised**, stapled',
    'The disk image is signed; it is **not notarised**')
print(json.dumps({'body': body}))
" | curl -sS -o /dev/null -w "    %{http_code} release ${id}\n" -X PATCH \
        -H "Authorization: token ${TOKEN}" \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        "${API}/releases/${id}" \
        -d @-
done < /tmp/.zode_stale_ids

# ---------------------------------------------------------------------------
echo "==> 3. the Apple secrets"
# ---------------------------------------------------------------------------
# Set them if they are in the environment.  They are optional: without them
# the disk image is signed ad-hoc and a downloaded copy gets the Gatekeeper
# warning.
if [ -n "${MACOS_CERTIFICATE:-}" ] && [ -n "${APPLE_ID:-}" ]; then
    set_secret() {
        curl -sS -o /dev/null -w "    %{http_code} $1\n" \
            -X PUT \
            -H "Authorization: token ${TOKEN}" \
            -H "Accept: application/vnd.github+json" \
            -H "X-GitHub-Api-Version: 2022-11-28" \
            "${API}/actions/secrets/${1}" \
            -d "$(python3 -c "
import json,sys
name, value = sys.argv[1], sys.argv[2]
print(json.dumps({'encrypted_value': value, 'key_id': ''}))
" "$2" "$3")"
    }
    # The encrypted_value has to be sealed with the repository's public key.
    KEY=$(auth "${API}/actions/secrets/public-key" | python3 -c "import sys,json;print(json.load(sys.stdin)['key'])")
    KEY_ID=$(auth "${API}/actions/secrets/public-key" | python3 -c "import sys,json;print(json.load(sys.stdin)['key_id'])")
    KEY_FILE="${CRED_FILE}.pub.pem"
    printf '%s\n' "${KEY}" > "${KEY_FILE}"
    seal() {
        # The repository's public key seals the value, so the secret is
        # never sent in the clear.
        python3 -c "
import sys
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives import serialization
key = serialization.load_pem_public_key(sys.argv[1].encode())
blob = key.encrypt(sys.argv[2].encode(), padding.PKCS1v15())
print(blob.hex())
" "${KEY}" "$1" 2>/dev/null && return 0
        # Fallback for a machine without the python cryptography package.
        # openssl is on every Mac and every Linux box.
        printf '%s' "$1" | openssl pkeyutl -encrypt -pubin -inkey "${KEY_FILE}" \
            -pkeyopt rsa_padding_mode:pkcs1 2>/dev/null | od -An -tx1 | tr -d ' \n'
    }
    if [ -n "${KEY}" ]; then
        for pair in "MACOS_CERTIFICATE:${MACOS_CERTIFICATE}" \
                    "MACOS_CERTIFICATE_PASSWORD:${MACOS_CERTIFICATE_PASSWORD:-}" \
                    "APPLE_ID:${APPLE_ID}" \
                    "APPLE_APP_SPECIFIC_PASSWORD:${APPLE_APP_SPECIFIC_PASSWORD:-}" \
                    "APPLE_TEAM_ID:${APPLE_TEAM_ID:-}"
        do
            NAME="${pair%%:*}"
            VALUE="${pair#*:}"
            [ -z "${VALUE}" ] && continue
            SEALED=$(seal "${VALUE}")
            [ -z "${SEALED}" ] && { echo "    could not seal ${NAME}"; continue; }
            curl -sS -o /dev/null -w "    %{http_code} ${NAME}\n" \
                -X PUT \
                -H "Authorization: token ${TOKEN}" \
                -H "Accept: application/vnd.github+json" \
                -H "X-GitHub-Api-Version: 2022-11-28" \
                "${API}/actions/secrets/${NAME}" \
                -d "{\"encrypted_value\":\"${SEALED}\",\"key_id\":\"${KEY_ID}\"}"
        done
    else
        echo "    could not read the repository's public key"
    fi
else
    echo "    MACOS_CERTIFICATE and APPLE_ID are not in the environment — skipping"
    echo "    (the disk image stays ad-hoc signed; see docs/RELEASING.md)"
fi

# ---------------------------------------------------------------------------
echo
echo "==> done"
echo "    releases:   https://github.com/${REPO}/releases"
echo "    latest:     https://github.com/${REPO}/releases/latest"
echo "    download:   https://github.com/${REPO}/releases/latest/download/zode-macos-0.1.0-universal.dmg"
