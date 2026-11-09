#!/usr/bin/env bash
# deploy-secure-build.sh — Deploy Ghostline to ghostline.secure.build on secure.build (vectorheart)
#
# Usage:
#   bash scripts/deploy-secure-build.sh [deploy]
#   bash scripts/deploy-secure-build.sh verify
#   bash scripts/deploy-secure-build.sh status
#   bash scripts/deploy-secure-build.sh rollback
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_HOST="${GHOSTLINE_REMOTE_HOST:-devuser@secure.build}"
REMOTE_BASE="/opt/ghostline"
PUBLIC_ORIGIN="https://ghostline.secure.build"
PUBLIC_IP="142.248.222.1"

cmd="${1:-deploy}"
REVISION="$(git -C "$REPO_ROOT" rev-parse HEAD)"

deploy_release() {
  echo "==> [1/4] Streaming Ghostline release ${REVISION} to ${REMOTE_HOST}:${REMOTE_BASE}/releases/${REVISION}..."
  COPYFILE_DISABLE=1 tar -C "$REPO_ROOT" \
    --exclude='.git' \
    --exclude='.DS_Store' \
    --exclude='*.bak*' \
    -cf - \
    clef-site deploy | \
  ssh -o BatchMode=yes -o ConnectTimeout=15 "$REMOTE_HOST" "
    set -euo pipefail
    sudo install -d -o devuser -g devuser -m 0755 '$REMOTE_BASE' '$REMOTE_BASE/releases'
    rel_dir='$REMOTE_BASE/releases/$REVISION'
    rm -rf -- \"\$rel_dir.staging\"
    mkdir -p \"\$rel_dir.staging\"
    tar --warning=no-unknown-keyword -C \"\$rel_dir.staging\" -xf -
    cat > \"\$rel_dir.staging/version.json\" <<EOF
{
  \"service\": \"ghostline\",
  \"revision\": \"$REVISION\",
  \"origin\": \"$PUBLIC_ORIGIN\",
  \"guard_upstream\": \"http://100.80.211.36:8443\"
}
EOF
    rm -rf -- \"\$rel_dir\"
    mv \"\$rel_dir.staging\" \"\$rel_dir\"

    # Retain previous symlink for instant rollback
    if [ -L '$REMOTE_BASE/current' ]; then
      prev_target=\"\$(readlink -f '$REMOTE_BASE/current' || true)\"
      if [ -n \"\$prev_target\" ] && [ \"\$prev_target\" != \"\$rel_dir\" ]; then
        ln -sfn \"\$prev_target\" '$REMOTE_BASE/previous'
      fi
    fi
    ln -sfn \"\$rel_dir\" '$REMOTE_BASE/current.next'
    mv -Tf '$REMOTE_BASE/current.next' '$REMOTE_BASE/current'
  "

  echo "==> [2/4] Ensuring Knot DNS record for ghostline.secure.build -> ${PUBLIC_IP}..."
  ssh -o BatchMode=yes -o ConnectTimeout=15 "$REMOTE_HOST" "
    set -euo pipefail
    if ! sudo knotc zone-read secure.build. ghostline A 2>/dev/null | grep -q '$PUBLIC_IP'; then
      echo '    Adding ghostline.secure.build A $PUBLIC_IP to Knot zone secure.build....'
      sudo knotc zone-begin secure.build.
      sudo knotc zone-set secure.build. ghostline 3600 A '$PUBLIC_IP'
      sudo knotc zone-set secure.build. www.ghostline 3600 A '$PUBLIC_IP'
      sudo knotc zone-commit secure.build.
    else
      echo '    Knot DNS record ghostline.secure.build A $PUBLIC_IP already present.'
    fi
  "

  echo "==> [3/4] Reconciling ghostline.service (127.0.0.1:5197) and /etc/caddy/Caddyfile..."
  ssh -o BatchMode=yes -o ConnectTimeout=15 "$REMOTE_HOST" "
    set -euo pipefail
    sudo install -m 0644 '$REMOTE_BASE/current/deploy/ghostline.service' /etc/systemd/system/ghostline.service
    sudo systemctl daemon-reload
    sudo systemctl enable ghostline.service >/dev/null 2>&1 || true
    sudo systemctl restart ghostline.service

    if ! grep -q 'ghostline\.secure\.build' /etc/caddy/Caddyfile; then
      echo '    Appending ghostline.secure.build site block to /etc/caddy/Caddyfile...'
      sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-ghostline
      printf '\n' | sudo tee -a /etc/caddy/Caddyfile >/dev/null
      sudo tee -a /etc/caddy/Caddyfile < '$REMOTE_BASE/current/deploy/ghostline.Caddyfile' >/dev/null
      if ! sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
        echo '    Caddy validation failed! Restoring /etc/caddy/Caddyfile backup...' >&2
        sudo mv /etc/caddy/Caddyfile.bak-ghostline /etc/caddy/Caddyfile
        exit 1
      fi
      sudo rm -f /etc/caddy/Caddyfile.bak-ghostline
      sudo systemctl reload caddy
    else
      sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
      sudo systemctl reload caddy
    fi
  "

  echo "==> [4/4] Verifying ghostline.secure.build..."
  verify_remote "$REVISION"
}

verify_remote() {
  local expected_sha="${1:-}"
  ssh -o BatchMode=yes -o ConnectTimeout=15 "$REMOTE_HOST" "
    set -euo pipefail
    systemctl is-active --quiet ghostline.service
    for attempt in 1 2 3 4 5 6 7 8 9 10; do
      if curl -fsS http://127.0.0.1:5197/version.json >/tmp/ghostline-version.json 2>/dev/null; then
        break
      fi
      sleep 0.5
    done
    cat /tmp/ghostline-version.json
    echo ''
    if [ -n '$expected_sha' ]; then
      grep -q '$expected_sha' /tmp/ghostline-version.json || {
        echo 'Deployed revision mismatch in /version.json' >&2
        exit 1
      }
    fi
    curl -fsS -o /dev/null http://127.0.0.1:5197/index.html
    curl -fsS -o /dev/null http://127.0.0.1:5197/arena
    curl -fsS -o /dev/null http://127.0.0.1:5197/console
    curl -fsS --retry 8 --retry-delay 2 --retry-all-errors --resolve ghostline.secure.build:443:${PUBLIC_IP} '${PUBLIC_ORIGIN}/version.json' >/dev/null
    curl -fsS --retry 8 --retry-delay 2 --retry-all-errors --resolve ghostline.secure.build:443:${PUBLIC_IP} -o /dev/null '${PUBLIC_ORIGIN}/'
    curl -fsS --retry 8 --retry-delay 2 --retry-all-errors --resolve ghostline.secure.build:443:${PUBLIC_IP} -o /dev/null '${PUBLIC_ORIGIN}/arena'
    curl -fsS --retry 8 --retry-delay 2 --retry-all-errors --resolve ghostline.secure.build:443:${PUBLIC_IP} -o /dev/null '${PUBLIC_ORIGIN}/console'
    echo 'Verified: https://ghostline.secure.build (/, /arena, /console, /version.json) HTTP 200 OK'
  "
}

status_remote() {
  ssh -o BatchMode=yes -o ConnectTimeout=15 "$REMOTE_HOST" "
    set -euo pipefail
    echo 'current:' \"\$(readlink -f '$REMOTE_BASE/current' 2>/dev/null || echo 'none')\"
    echo 'previous:' \"\$(readlink -f '$REMOTE_BASE/previous' 2>/dev/null || echo 'none')\"
    systemctl status ghostline.service --no-pager -n 10 || true
  "
}

rollback_remote() {
  ssh -o BatchMode=yes -o ConnectTimeout=15 "$REMOTE_HOST" "
    set -euo pipefail
    test -L '$REMOTE_BASE/previous'
    prev_target=\"\$(readlink -f '$REMOTE_BASE/previous')\"
    cur_target=\"\$(readlink -f '$REMOTE_BASE/current' || true)\"
    ln -sfn \"\$prev_target\" '$REMOTE_BASE/current.rollback'
    mv -Tf '$REMOTE_BASE/current.rollback' '$REMOTE_BASE/current'
    if [ -n \"\$cur_target\" ]; then
      ln -sfn \"\$cur_target\" '$REMOTE_BASE/previous'
    fi
    sudo systemctl restart ghostline.service
  "
  verify_remote ""
}

case "$cmd" in
  deploy)
    deploy_release
    ;;
  verify)
    verify_remote ""
    ;;
  status)
    status_remote
    ;;
  rollback)
    rollback_remote
    ;;
  *)
    echo "Unknown command: $cmd (expected deploy|verify|status|rollback)" >&2
    exit 2
    ;;
esac
