# escpos-bridge

Transparent TCP proxy that intercepts EposNow ESC/POS print streams (receipt + kitchen) on a Raspberry Pi, parses them, and forwards structured data to Hetzner. Receipts are still printed normally — the Pi sits inline.

## Why

EposNow's webhook payload omits `Customer Credit` and `Customer Points` from the `Tenders` array (only `Cash` and `Card` are exposed at the device-token scope). The receipt printer always shows the real tenders. Capturing them gives us:

- **Definitive ground truth** on wallet vs points payments (closes the verification loop our `eposnow_pending_verifications` system started)
- **Real KP feed** for KDS / kitchen analytics
- **Discovery of new till devices** as they appear (Till7 = device 8712 just showed up)
- **Cross-check of staff names + invoice numbers** for AEAT compliance

## Architecture

```
┌─────────┐ ESC/POS ┌─────────────┐ ESC/POS ┌──────────────┐
│  Till   │────────▶│   Pi (this) │────────▶│ Real printer │
└─────────┘  9100   │  proxy      │  9100   └──────────────┘
                    │             │
                    │  parse +    │ HTTPS
                    │  extract    │────────▶  webhooks.lsltapps.com/intercept/*
                    │             │           (with X-Interceptor-Secret header)
                    │  SQLite     │
                    │  retry      │
                    └─────────────┘
```

If the Pi crashes, systemd restarts it within 5s. If Hetzner is unreachable, intercepts queue locally (SQLite) and replay every 30s. Bytes always forward to the printer in real time — no UX impact.

## Hardware

- Raspberry Pi 5, 8GB
- Active cooler (Pi 5 throttles without one)
- 27W USB-C PSU (Pi 5 official)
- Wired ethernet (do NOT use WiFi — too brittle for printer-path)
- microSD ≥ 16GB (or NVMe via the Pi 5 hat)

## First-time setup (~30 minutes)

### 1. Flash Raspberry Pi OS Lite (64-bit) to SD

Use Raspberry Pi Imager. Set:
- Hostname: `pi-19th-1` (or whatever venue/device)
- Username/password: your standard
- Enable SSH
- Set static IP **on your router's DHCP reservations** so the till always finds it

### 2. Boot the Pi, SSH in

```bash
ssh pi@pi-19th-1.local
```

### 3. Install

```bash
# If repo is public on GitHub:
curl -fsSL https://raw.githubusercontent.com/jmcbride4882/escpos-bridge/main/install.sh | sudo bash

# OR clone manually:
sudo git clone https://github.com/jmcbride4882/escpos-bridge.git /opt/escpos-bridge
sudo bash /opt/escpos-bridge/install.sh
```

### 4. Edit config

```bash
sudo nano /etc/escpos-bridge/config.env
```

Set (REQUIRED before starting):
- `INTERCEPTOR_SECRET=` (must match the value on the Hetzner side)
- `RECEIPT_UPSTREAM_HOST=` (the actual receipt printer IP — find via `nmap -p 9100 192.168.18.0/24` or check the till's printer settings)
- Confirm `KP_UPSTREAM_HOST=192.168.18.100` (19th Hole kitchen — should already be right)

### 5. Reconfigure the till

In EposNow Back Office → Devices → your Till7:
- Receipt printer IP → change from real printer IP to the Pi's IP, port 9100
- Kitchen printer IP → change from real printer IP to the Pi's IP, port 9101

(The till keeps printing as normal because the Pi forwards every byte upstream.)

### 6. Start

```bash
sudo systemctl start escpos-bridge
sudo journalctl -fu escpos-bridge        # watch live
```

You should see lines like:
```
[receipt] listening on :9100 → forwarding to 192.168.18.x:9100
[kp]      listening on :9101 → forwarding to 192.168.18.100:9100
```

### 7. Test

Make any transaction at the till. Within ~2 seconds:
- The receipt prints (proving the proxy is transparent)
- `journalctl` shows `[receipt] sent OK`
- Hetzner DB: `SELECT * FROM interceptor_events ORDER BY id DESC LIMIT 1;` shows the row

## Hetzner side

See [docs/HETZNER-PATCH.md](docs/HETZNER-PATCH.md) for the webhook server changes needed BEFORE the Pi will have anywhere to send to.

## Failure modes

| What fails | What happens |
|---|---|
| Pi process crashes | systemd restarts within 5s |
| Pi powers off | Till's print fails → operator sees error → reconfigure till to direct printer IP (~2 min recovery) |
| Hetzner unreachable | Intercepts queue locally, replay automatically when reachable |
| Hetzner unreachable >72h | Old queue entries dropped (logged loudly) |
| Receipt printer powered off | Pi proxy connection fails → till's print fails → till operator notices |
| Kitchen printer powered off | Same — till print fails for kitchen orders |
| Network partition (Pi can talk to till but not printer) | Till print fails — clear signal to operator |

**Single point of failure note:** If the Pi dies and you don't have time to reconfigure, you can SSH into the till's BackOffice and revert to the real printer IPs. Keep those handy.

## Testing

```bash
# Replays the actual EposNow receipt sample we captured 2026-04-26
node test/parse-sample.js
```

## Development locally (no Pi)

```bash
npm install
INTERCEPTOR_SECRET=test \
RECEIPT_UPSTREAM_HOST=127.0.0.1 RECEIPT_UPSTREAM_PORT=9999 \
KP_UPSTREAM_HOST=127.0.0.1 KP_UPSTREAM_PORT=9998 \
HETZNER_RECEIPT_URL=http://localhost:8080/intercept/receipt \
HETZNER_KP_URL=http://localhost:8080/intercept/kp \
npm start

# In another terminal, simulate the till sending bytes:
node -e "
const net = require('net');
const fs = require('fs');
const sample = fs.readFileSync('test/sample.bin'); // capture real one with tcpdump
net.createConnection(9100, () => {}).end(sample);
"
```

## Roadmap

- v1 (now): 19th Hole only, receipt + KP, basic ground-truth capture
- v2: Lakeside + Snack Shack
- v3: cross-reference webhook tenders, alert on Customer Credit drift in real time
- v4: feed the live KDS dashboard with KP intercepts (replace the existing webhook-only KDS)
