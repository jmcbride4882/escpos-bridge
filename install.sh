#!/usr/bin/env bash
# escpos-bridge installer for Raspberry Pi OS Lite (Debian bookworm, 64-bit).
# One-shot — clones repo, installs Node 20, builds, sets up systemd, starts.
#
# Usage on a fresh Pi 5:
#   curl -fsSL https://raw.githubusercontent.com/jmcbride4882/escpos-bridge/main/install.sh | sudo bash
#   # OR (if cloning manually first):
#   git clone https://github.com/jmcbride4882/escpos-bridge.git /opt/escpos-bridge
#   cd /opt/escpos-bridge && sudo bash install.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/jmcbride4882/escpos-bridge.git}"
INSTALL_DIR="/opt/escpos-bridge"
CONFIG_DIR="/etc/escpos-bridge"
SERVICE_NAME="escpos-bridge"

echo "==> escpos-bridge installer"
echo "    target: $INSTALL_DIR"
echo "    config: $CONFIG_DIR"
echo

# Must be root for systemd + /opt/* + /etc/*
if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo." >&2
  exit 1
fi

# Step 1 — system update + curl/git
echo "==> apt update + base packages"
apt-get update -qq
apt-get install -y -qq curl git build-essential

# Step 2 — Node.js 20 via NodeSource (installs latest 20.x)
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  echo "==> installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
echo "    node: $(node -v), npm: $(npm -v)"

# Step 3 — clone or update repo
if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "==> updating existing $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
elif [[ -d "$INSTALL_DIR" && ! -d "$INSTALL_DIR/.git" ]]; then
  echo "==> using existing $INSTALL_DIR (not a git repo — skipping clone)"
else
  echo "==> cloning $REPO_URL → $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

# Step 4 — npm install
echo "==> npm install"
cd "$INSTALL_DIR"
npm install --production

# Step 5 — config dir + sample env
mkdir -p "$CONFIG_DIR"
mkdir -p /var/lib/escpos-bridge
chown nobody:nogroup /var/lib/escpos-bridge

if [[ ! -f "$CONFIG_DIR/config.env" ]]; then
  echo "==> writing $CONFIG_DIR/config.env (EDIT BEFORE STARTING)"
  cat > "$CONFIG_DIR/config.env" <<'EOF'
# escpos-bridge config — edit then `systemctl restart escpos-bridge`

# Required: shared secret for Hetzner auth (must match webhook server's INTERCEPTOR_SECRET)
INTERCEPTOR_SECRET=changeme

# Identity (shows up in Hetzner DB)
VENUE_SLUG=19th-hole
DEVICE_ID=pi5-19th-1

# Receipt printer proxy
RECEIPT_ENABLED=true
RECEIPT_LISTEN_PORT=9100
RECEIPT_UPSTREAM_HOST=        # ← FILL IN with the real receipt printer IP
RECEIPT_UPSTREAM_PORT=9100

# Kitchen printer proxy
KP_ENABLED=true
KP_LISTEN_PORT=9101
KP_UPSTREAM_HOST=192.168.18.100   # confirmed for 19th Hole
KP_UPSTREAM_PORT=9100

# Hetzner endpoints (override only if you change webhook server URL)
# HETZNER_RECEIPT_URL=https://webhooks.lsltapps.com/intercept/receipt
# HETZNER_KP_URL=https://webhooks.lsltapps.com/intercept/kp

# Verbosity: debug | info | warn | error
LOG_LEVEL=info
EOF
  chmod 600 "$CONFIG_DIR/config.env"
  echo
  echo "    ⚠ Edit $CONFIG_DIR/config.env BEFORE starting:"
  echo "      - Set INTERCEPTOR_SECRET (must match webhook server)"
  echo "      - Set RECEIPT_UPSTREAM_HOST (real receipt printer IP)"
  echo "      - Confirm KP_UPSTREAM_HOST (currently 192.168.18.100)"
  echo
fi

# Step 6 — systemd
echo "==> installing systemd unit"
cp "$INSTALL_DIR/systemd/escpos-bridge.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"

echo
echo "==> install complete."
echo
echo "Next:"
echo "    1. Edit $CONFIG_DIR/config.env"
echo "    2. Reconfigure your till to print to this Pi's IP:"
echo "       - Receipt printer setting → $(hostname -I | awk '{print $1}'):9100"
echo "       - Kitchen printer setting → $(hostname -I | awk '{print $1}'):9101"
echo "    3. systemctl start $SERVICE_NAME"
echo "    4. journalctl -fu $SERVICE_NAME    # follow logs"
echo
