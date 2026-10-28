#!/usr/bin/env bash
#
# prepare-apple-secrets.sh — turn your Apple account into the five secrets
# the release workflow needs.
#
# Run this on the Mac that holds your Developer ID certificate:
#
#     ./scripts/prepare-apple-secrets.sh
#
# It finds your "Developer ID Application" certificate, exports the private
# key as a base64 .p12, works out your team id, and prints the five secret
# values — either to paste into GitHub by hand, or it sets them for you if
# you have the GitHub CLI and a token.
#
# Nothing is sent anywhere by this script unless you ask it to. It only
# reads your keychain and writes a .p12 into a temporary directory that it
# removes again.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; DIM=$'\033[2m'; OFF=$'\033[0m'
if [ ! -t 1 ]; then RED=""; GREEN=""; YELLOW=""; BOLD=""; DIM=""; OFF=""; fi

say()  { printf '%s\n' "$*"; }
ok()   { printf '  %s✔%s %s\n' "$GREEN" "$OFF" "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$OFF" "$*"; }
bad()  { printf '  %s✘%s %s\n' "$RED" "$OFF" "$*"; }
step() { printf '\n%s%s%s\n' "$BOLD" "$*" "$OFF"; }

WORKDIR="$(mktemp -d)"
cleanup() { rm -rf "${WORKDIR}"; }
trap cleanup EXIT

if [ "$(uname -s)" != "Darwin" ]; then
    bad "this script has to run on a Mac (it reads your keychain)."
    exit 1
fi

# ---------------------------------------------------------------------------
step "1. Your Developer ID Application identities"
# ---------------------------------------------------------------------------
IDENTITIES=$(security find-identity -v -p codesigning 2>/dev/null | grep "Developer ID Application" || true)

if [ -z "${IDENTITIES}" ]; then
    bad "no 'Developer ID Application' identity in your keychain."
    say ""
    say "  These are the certificates that can sign a build for other people."
    say "  An 'Apple Development' certificate cannot — it only works on your"
    say "  own Mac, and Apple will not notarise a build signed with one."
    say ""
    say "  To make one:"
    say "    1. open Xcode ▸ Settings ▸ Accounts, sign in, click 'Manage Certificates'"
    say "    2. tick 'Developer ID Application' and click the '+' button"
    say "       (it is created for you automatically)"
    say "    3. or create one at"
    say "       https://developer.apple.com/account/resources/certificates/list"
    say ""
    say "  If you made one there, it has to be in your keychain as well:"
    say "    security import \"Developer ID Application.p12\" -k ~/Library/Keychains/login.keychain-db"
    say ""
    say "  Then run this script again."
    exit 1
fi

say "${IDENTITIES}" | sed 's/^/  /'
say ""

# Pick the first identity, but let the user choose if there is more than one.
COUNT=$(printf '%s\n' "${IDENTITIES}" | grep -c .)
if [ "${COUNT}" -gt 1 ]; then
    say "  There is more than one. Pick the number to use:"
    i=1
    while IFS= read -r line; do
        say "    ${i}) ${line}"
        i=$((i + 1))
    done <<< "${IDENTITIES}"
    printf '\n  Which one? [1] '
    read -r PICK
    PICK="${PICK:-1}"
else
    PICK=1
fi

LINE=$(printf '%s\n' "${IDENTITIES}" | sed -n "${PICK}p")
HASH=$(printf '%s' "${LINE}" | sed 's/^[[:space:]]*\([0-9A-F]*\).*/\1/')
IDENTITY=$(printf '%s' "${LINE}" | sed 's/.*"\(.*\)".*/\1/')
# "Developer ID Application: Name (ABCDE12345)" — the tail is the team id.
TEAM_ID=$(printf '%s' "${IDENTITY}" | sed 's/.*(\([A-Z0-9]*\))$/\1/')

ok "identity: ${IDENTITY}"
if [ -n "${TEAM_ID}" ] && [ "${TEAM_ID}" != "${IDENTITY}" ]; then
    ok "team id:  ${TEAM_ID}"
else
    warn "could not read the team id out of the identity name"
    TEAM_ID=""
fi

# ---------------------------------------------------------------------------
step "2. Exporting the private key"
# ---------------------------------------------------------------------------
# A .p12 that holds both the certificate and the private key.  The key has
# to be in the keychain in a form security can export.
KEY_NAME=$(security find-identity -v -p codesigning 2>/dev/null | grep "Developer ID Application" | sed -n "${PICK}p" | sed 's/.*"\(.*\)".*/\1/')

say "  The export needs a password. It protects the .p12, and it is the"
say "  value of the MACOS_CERTIFICATE_PASSWORD secret."
say ""
printf '  Password for the .p12 (leave empty to generate one): '
read -r P12_PASSWORD
if [ -z "${P12_PASSWORD}" ]; then
    P12_PASSWORD=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)
    say "  generated: ${P12_PASSWORD}"
fi

echo "  exporting…"
if ! security export -k "${KEY_NAME}" -t identities -f pkcs12 -P "${P12_PASSWORD}" -o "${WORKDIR}/cert.p12" 2>/dev/null; then
    bad "the export failed."
    say ""
    say "  This normally means the private key is not marked as exportable."
    say "  Open Keychain Access, find the certificate, and enable"
    say "  'Allow all applications to access this item' (the little arrow"
    say "  next to the certificate), then run this again."
    say ""
    say "  Or export it from Keychain Access by hand:"
    say "    Keychain Access ▸ My Certificates ▸ 'Developer ID Application: …'"
    say "    ▸ right-click the certificate ▸ Export ▸ Personal Information Exchange"
    say "    ▸ set the same password, then come back to this script."
    exit 1
fi

if [ ! -s "${WORKDIR}/cert.p12" ]; then
    bad "the export produced an empty file."
    exit 1
fi

# The .p12 goes into the secret base64 encoded, on one line.
CERT_B64=$(base64 < "${WORKDIR}/cert.p12" | tr -d '\n')
ok "exported and base64 encoded ($(printf '%s' "${CERT_B64}" | wc -c | tr -d ' ') characters)"

# ---------------------------------------------------------------------------
step "3. The Apple id and its app-specific password"
# ---------------------------------------------------------------------------
say "  Notarisation needs an Apple id and an app-specific password for it."
say ""
say "  Create the password here:"
say "    https://appleid.apple.com/account/manage  →  Security  →  Generate an app-specific password"
say ""
say "  (A normal Apple id password will not work. Apple id itself is fine.)"
say ""
printf '  Apple id (the email you sign in with): '
read -r APPLE_ID
printf '  App-specific password: '
read -r APPLE_PASSWORD

if [ -z "${APPLE_ID}" ] || [ -z "${APPLE_PASSWORD}" ]; then
    warn "the Apple id and the app-specific password are needed as well."
    say "  Run this script again with them filled in."
    exit 1
fi

# ---------------------------------------------------------------------------
step "4. The five secrets"
# ---------------------------------------------------------------------------
say "  These are the values. ${DIM}(they are secret — do not paste them in a chat)${OFF}"
say ""
say "  ${BOLD}MACOS_CERTIFICATE${OFF}           <- the long base64 blob below"
say "  ${BOLD}MACOS_CERTIFICATE_PASSWORD${OFF}  <- ${P12_PASSWORD}"
say "  ${BOLD}APPLE_ID${OFF}                   <- ${APPLE_ID}"
say "  ${BOLD}APPLE_APP_SPECIFIC_PASSWORD${OFF} <- ${APPLE_PASSWORD}"
say "  ${BOLD}APPLE_TEAM_ID${OFF}              <- ${TEAM_ID}"
say ""
say "  --- MACOS_CERTIFICATE (one line) ---"
printf '%s\n' "${CERT_B64}"
say "  --- end ---"
say ""

# ---------------------------------------------------------------------------
step "5. Setting them"
# ---------------------------------------------------------------------------
say "  Repository ▸ Settings ▸ Secrets and variables ▸ Actions ▸ New repository secret"
say "  Add the five of them. Then push to main and the next release is"
say "  notarised."
say ""

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    say "  You have the GitHub CLI and it is signed in, so this can be done"
    say "  for you right now:"
    say ""
    say "    gh secret set MACOS_CERTIFICATE           --repo ${GITHUB_REPO:-maceip/zode} <<< \$CERT_B64"
    say "    gh secret set MACOS_CERTIFICATE_PASSWORD  --repo ${GITHUB_REPO:-maceip/zode} <<< \$P12_PASSWORD"
    say "    gh secret set APPLE_ID                   --repo ${GITHUB_REPO:-maceip/zode} <<< \$APPLE_ID"
    say "    gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo ${GITHUB_REPO:-maceip/zode} <<< \$APPLE_PASSWORD"
    say "    gh secret set APPLE_TEAM_ID              --repo ${GITHUB_REPO:-maceip/zode} <<< \$TEAM_ID"
    say ""
    say "  Or say the word and I will do it for you — paste the five values"
    say "  into the chat and I will set them with the API."
else
    say "  (The GitHub CLI is not signed in here, so paste them into the"
    say "  repository settings by hand — or paste them to me and I will set"
    say "  them with the API.)"
fi
say ""

# ---------------------------------------------------------------------------
step "6. Checking it worked"
# ---------------------------------------------------------------------------
say "  After the next release, this tells you whether the image really is"
say "  notarised:"
say ""
say "    ./scripts/check-notarization.sh"
say ""
