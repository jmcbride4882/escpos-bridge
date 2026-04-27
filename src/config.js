/**
 * Config — env-driven so the same binary runs across venues / network moves.
 *
 * Supports N printer proxies via numbered slots:
 *
 *   PRINTER_1_NAME=receipt
 *   PRINTER_1_PORT=9100
 *   PRINTER_1_HOST=192.168.18.50      (real receipt printer IP)
 *   PRINTER_1_KIND=receipt             (or: kp | bar)
 *
 *   PRINTER_2_NAME=kp
 *   PRINTER_2_PORT=9101
 *   PRINTER_2_HOST=192.168.18.100     (kitchen printer)
 *   PRINTER_2_KIND=kp
 *
 *   PRINTER_3_NAME=bar
 *   PRINTER_3_PORT=9102
 *   PRINTER_3_HOST=192.168.18.101     (bar printer)
 *   PRINTER_3_KIND=bar
 *
 * Add up to 8 by setting PRINTER_4_*, etc. Empty slots are skipped.
 *
 * `KIND` controls which extractor runs:
 *   receipt → sales receipts (auto-detects EOD/float/petty cash too)
 *   kp      → kitchen order tickets
 *   bar     → bar order tickets (same parser as KP)
 */
const env = process.env;

function num(v, def) { const n = Number(v); return Number.isFinite(n) ? n : def; }

function loadPrinters() {
  const out = [];
  for (let i = 1; i <= 8; i++) {
    let host = (env[`PRINTER_${i}_HOST`] || '').trim();
    const port = env[`PRINTER_${i}_PORT`];
    const name = env[`PRINTER_${i}_NAME`];
    const kind = env[`PRINTER_${i}_KIND`];
    // Strip inline `# comment` (env files don't do that natively)
    if (host.includes('#')) host = host.split('#')[0].trim();
    // Skip if host is empty, looks like a placeholder, or doesn't look like an IP/hostname
    if (!host || !port) continue;
    if (!/^[a-zA-Z0-9.\-_]+$/.test(host)) continue;
    const k = kind || 'receipt';
    // Per-printer default mode:
    //   kp/bar    = transparent (kitchen + bar ops always need paper)
    //   receipt   = on-demand-2x (capture only on auto-print; print only on
    //               staff re-press — saves paper, customer-friendly)
    // Override per-printer with PRINTER_N_MODE, or globally with PRINT_MODE.
    const defaultModeForKind = (k === 'kp' || k === 'bar') ? 'transparent' : 'on-demand-2x';
    // Default copies: receipt prints 2 (customer + till copy), KP/bar prints 1.
    const defaultCopies = (k === 'receipt') ? 2 : 1;
    out.push({
      slot: i,
      name: name || `printer${i}`,
      kind: k,
      listenPort: num(port, 9100 + i - 1),
      upstreamHost: host,
      upstreamPort: num(env[`PRINTER_${i}_UPSTREAM_PORT`], 9100),
      enabled: env[`PRINTER_${i}_ENABLED`] !== 'false',
      printMode: env[`PRINTER_${i}_MODE`] || defaultModeForKind,
      copies: num(env[`PRINTER_${i}_COPIES`], defaultCopies),
      // Per-printer venue override — for one Pi covering multiple physical venues
      // (e.g. Lakeside + Snack Shack on the same LAN). Falls back to global VENUE_SLUG.
      venue: env[`PRINTER_${i}_VENUE`] || env.VENUE_SLUG || '19th-hole',
    });
  }
  return out;
}

export const config = {
  printers: loadPrinters(),

  // Where parsed events go
  hetzner: {
    baseUrl: (env.HETZNER_BASE_URL || 'https://webhooks.lsltapps.com/intercept').replace(/\/$/, ''),
    secret:  env.INTERCEPTOR_SECRET || '',
    timeoutMs: num(env.HETZNER_TIMEOUT_MS, 5000),
  },

  // Local resilience
  retry: {
    dbPath:        env.RETRY_DB_PATH       || '/var/lib/escpos-bridge/retry.db',
    sweepEveryMs:  num(env.RETRY_SWEEP_MS, 30 * 1000),
    maxAgeHours:   num(env.RETRY_MAX_AGE_HOURS, 72),
  },

  // Identity
  device: {
    venue:      env.VENUE_SLUG || '19th-hole',
    deviceId:   env.DEVICE_ID  || 'pi5-19th-1',
  },

  // Print mode — controls whether bytes physically print
  // 'transparent'      — always forward to printer (default; safe; no UX change)
  // 'on-demand-2x'     — only forward if same content arrives twice within 20s
  //                      (sales receipts only; floats/EODs/etc always forward)
  // 'digital-only'     — never forward to printer (capture only — DANGEROUS, AEAT issue)
  printMode: env.PRINT_MODE || 'transparent',
  duplicateWindowMs: num(env.DUPLICATE_WINDOW_MS, 20 * 1000),
  alwaysPrintAboveEur: num(env.ALWAYS_PRINT_ABOVE_EUR, 50),  // override for big tx in 2x mode

  logLevel: env.LOG_LEVEL || 'info',
};

export function validateConfig() {
  const errs = [];
  // Soft warnings — log but don't refuse to start, so the web GUI can boot
  // for first-run setup even when the secret + printers aren't configured yet.
  if (!config.hetzner.secret) {
    console.warn('[config] INTERCEPTOR_SECRET not set — Hetzner forwarding disabled until set');
  }
  if (config.printers.length === 0) {
    console.warn('[config] No printers configured — web GUI will start but no proxies will run');
  }
  for (const p of config.printers) {
    if (!['receipt', 'kp', 'bar'].includes(p.kind)) {
      errs.push(`PRINTER_${p.slot}_KIND='${p.kind}' invalid — must be receipt|kp|bar`);
    }
  }
  if (!['transparent', 'dedup', 'on-demand-2x', 'digital-only'].includes(config.printMode)) {
    errs.push(`PRINT_MODE='${config.printMode}' invalid — must be transparent|dedup|on-demand-2x|digital-only`);
  }
  return errs;
}
