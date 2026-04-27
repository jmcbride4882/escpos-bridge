#!/usr/bin/env bash
# Auto-update escpos-bridge from GitHub.
#
# Polls origin/master every time it's invoked. If HEAD has moved, fast-forwards,
# reinstalls deps if package.json changed, then restarts the service.
# Designed to run as a systemd timer (escpos-bridge-update.timer) every 5 min.
#
# Logs go to journal — view with:
#   sudo journalctl -u escpos-bridge-update.service -n 50

set -euo pipefail

REPO_DIR=${REPO_DIR:-/opt/escpos-bridge}
BRANCH=${BRANCH:-master}
SERVICE=${SERVICE:-escpos-bridge.service}

cd "$REPO_DIR"

# Defuse "dubious ownership" — repo is owned by escpos user, this script
# typically runs as root via systemd.
git config --global --add safe.directory "$REPO_DIR" >/dev/null 2>&1 || true

OLD_HEAD=$(git rev-parse HEAD)
git fetch --quiet origin "$BRANCH"
NEW_HEAD=$(git rev-parse "origin/$BRANCH")

if [ "$OLD_HEAD" = "$NEW_HEAD" ]; then
  echo "[auto-update] $(date -Iseconds) up-to-date at $OLD_HEAD"
  exit 0
fi

echo "[auto-update] $(date -Iseconds) update available: $OLD_HEAD -> $NEW_HEAD"

# Stash any unexpected local changes so reset is safe (we don't expect any
# but Pi consoles sometimes leave artefacts behind)
git stash --include-untracked --quiet || true

git reset --hard "origin/$BRANCH"
echo "[auto-update] reset to origin/$BRANCH"

# Reinstall deps if anything in package* changed
if git diff --name-only "$OLD_HEAD" "$NEW_HEAD" | grep -qE '^package(-lock)?\.json$'; then
  echo "[auto-update] dependencies changed — running npm install"
  npm install --omit=dev --no-audit --no-fund 2>&1 | tail -5
fi

systemctl restart "$SERVICE"
echo "[auto-update] restarted $SERVICE"
