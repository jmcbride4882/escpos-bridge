#!/usr/bin/env bash
# escpos-bridge installer for Raspberry Pi OS Lite (Debian bookworm, 64-bit).
# One-shot — clones repo, installs Node 20, builds, sets up systemd, starts.
#
# Usage on a fresh Pi 4 (8GB) or Pi 5:
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

# Step 5 — dedicated user (web GUI needs to edit config + restart service)
if ! id escpos &>/dev/null; then
  echo "==> creating 'escpos' user"
  useradd --system --no-create-home --shell /usr/sbin/nologin escpos
fi

# Step 5b — config dir + sample env (owned by escpos user so web GUI can write)
mkdir -p "$CONFIG_DIR"
mkdir -p /var/lib/escpos-bridge
chown -R escpos:escpos "$CONFIG_DIR" /var/lib/escpos-bridge

# Step 5c — sudoers entry: web GUI can restart its own service without password
cat > /etc/sudoers.d/escpos-bridge <<'SUDOERS'
escpos ALL=(root) NOPASSWD: /bin/systemctl restart escpos-bridge
escpos ALL=(root) NOPASSWD: /bin/systemctl status escpos-bridge
SUDOERS
chmod 440 /etc/sudoers.d/escpos-bridge

if [[ ! -f "$CONFIG_DIR/config.env" ]]; then
  echo "==> writing $CONFIG_DIR/config.env (EDIT BEFORE STARTING)"
  cat > "$CONFIG_DIR/config.env" <<'EOF'
# escpos-bridge config — most users edit this via the web GUI at http://<pi>:8080
# Manual edit: `sudo nano /etc/escpos-bridge/config.env` then `systemctl restart escpos-bridge`

# ───── Web GUI ─────
WEB_PORT=8080
WEB_PASSWORD=changeme

# ───── Required ─────
# Shared secret for Hetzner auth (must match webhook server's INTERCEPTOR_SECRET)
INTERCEPTOR_SECRET=changeme

# Identity — VENUE_SLUG is the DEFAULT venue for this Pi.
# A Pi can serve multiple venues (e.g. Lakeside + Snack Shack on one shared LAN).
# In that case, set VENUE_SLUG to the primary venue and override per-printer
# with PRINTER_N_VENUE for printers that belong to a different physical venue.
VENUE_SLUG=lakeside
DEVICE_ID=pi4-lakeside-1

# ───── Printers (one per till output stream — add as many as you have) ─────
# Each printer slot needs HOST + PORT + NAME + KIND (receipt | kp | bar)
# Empty slots are skipped. Up to 8 printers.

# Sample layout for ONE Pi covering Lakeside + Snack Shack (shared LAN).
# Adjust per venue. Add PRINTER_N_VENUE to override the global VENUE_SLUG
# when a printer belongs to a different physical venue than the Pi's default.

# Slots are auto-skipped if HOST is empty — this is the safe initial state.
# Use the web GUI's LAN scan + Config tab to fill in HOSTs, or edit here.
#
# Slot 1 — Lakeside customer receipts (LAN printer at the bar)
PRINTER_1_NAME=lakeside-receipt
PRINTER_1_KIND=receipt
PRINTER_1_PORT=9100
PRINTER_1_HOST=
PRINTER_1_VENUE=lakeside
#
# Slot 2 — Lakeside kitchen
PRINTER_2_NAME=lakeside-kitchen
PRINTER_2_KIND=kp
PRINTER_2_PORT=9101
PRINTER_2_HOST=
PRINTER_2_VENUE=lakeside
#
# Slot 3 — Snack Shack customer receipts
PRINTER_3_NAME=snack-receipt
PRINTER_3_KIND=receipt
PRINTER_3_PORT=9102
PRINTER_3_HOST=
PRINTER_3_VENUE=snack-shack
#
# Slot 4 — Snack Shack kitchen
PRINTER_4_NAME=snack-kitchen
PRINTER_4_KIND=kp
PRINTER_4_PORT=9103
PRINTER_4_HOST=
PRINTER_4_VENUE=snack-shack
#
# Slots 5-8 available for more printers (bar/order-A/order-B/front/back/etc).

# ───── Print mode ─────
# transparent     — always forward to printer (DEFAULT, safe, no UX change)
# on-demand-2x    — sales receipts only print if same content sent twice within 20s
#                   (saves paper; non-sales docs always print; >€50 always prints)
# digital-only    — never forward to printer (DANGEROUS — AEAT compliance issue)
PRINT_MODE=transparent
DUPLICATE_WINDOW_MS=20000
ALWAYS_PRINT_ABOVE_EUR=50

# ───── Hetzner (override only if URL changes) ─────
# HETZNER_BASE_URL=https://webhooks.lsltapps.com/intercept

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

# Step 5d — Raspberry Pi Connect (free remote shell + screen share via
# https://connect.raspberrypi.com). Lets us SSH into every venue's Pi
# from anywhere without VPN or port forwarding. Skipped on non-Pi hosts.
if grep -q 'Raspberry Pi' /proc/cpuinfo 2>/dev/null; then
  if ! command -v rpi-connect >/dev/null 2>&1; then
    echo "==> installing rpi-connect-lite (headless: shell access only)"
    apt-get install -y -qq rpi-connect-lite || echo "  ⚠ rpi-connect-lite not available — skipping"
  fi
  echo "    Pi Connect requires a one-time signin under the 'pi' user (NOT root):"
  echo "      sudo loginctl enable-linger pi"
  echo "      sudo -u pi rpi-connect signin   # opens a code at https://connect.raspberrypi.com/sign-in"
  echo "      sudo -u pi rpi-connect on       # enable shell sharing"
  echo "    Then the Pi appears at https://connect.raspberrypi.com — SSH from any browser."
fi

# Step 6 — systemd
echo "==> installing systemd unit"
cp "$INSTALL_DIR/systemd/escpos-bridge.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"

echo
echo "==> install complete."
echo
PI_IP="$(hostname -I | awk '{print $1}')"
echo "Next:"
echo "    1. systemctl start $SERVICE_NAME"
echo "    2. Open http://${PI_IP}:8080 in your browser"
echo "       (login: admin / password: changeme — change it on first visit)"
echo "    3. Run the LAN scan to find your printer IPs"
echo "    4. Set the interceptor secret (must match Hetzner)"
echo "    5. Save config + restart"
echo "    6. Reconfigure your tills to print to ${PI_IP}:9100 (receipt) / :9101 (KP) / :9102 (bar)"
echo
echo "Alternatively, edit $CONFIG_DIR/config.env directly + systemctl restart $SERVICE_NAME"
echo
