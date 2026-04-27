/**
 * Config — env-driven so the same binary runs across venues / network moves
 * (19th Hole LAN today, POS network later).
 *
 * Override via /etc/escpos-bridge/config.env (loaded by systemd as EnvironmentFile)
 * or inline: KP_UPSTREAM_HOST=192.168.18.100 node src/server.js
 */
const env = process.env;

function num(v, def) { const n = Number(v); return Number.isFinite(n) ? n : def; }

export const config = {
  // Where the till tells the printer to connect
  receipt: {
    listenPort:    num(env.RECEIPT_LISTEN_PORT, 9100),
    upstreamHost:  env.RECEIPT_UPSTREAM_HOST || '',          // e.g. '192.168.18.x'
    upstreamPort:  num(env.RECEIPT_UPSTREAM_PORT, 9100),
    enabled:       env.RECEIPT_ENABLED !== 'false',
  },
  kp: {
    listenPort:    num(env.KP_LISTEN_PORT, 9101),
    upstreamHost:  env.KP_UPSTREAM_HOST || '192.168.18.100', // confirmed: 19th Hole kitchen
    upstreamPort:  num(env.KP_UPSTREAM_PORT, 9100),
    enabled:       env.KP_ENABLED !== 'false',
  },

  // Where parsed events go
  hetzner: {
    receiptUrl: env.HETZNER_RECEIPT_URL || 'https://webhooks.lsltapps.com/intercept/receipt',
    kpUrl:      env.HETZNER_KP_URL      || 'https://webhooks.lsltapps.com/intercept/kp',
    secret:     env.INTERCEPTOR_SECRET  || '',                // SET IN config.env — required
    timeoutMs:  num(env.HETZNER_TIMEOUT_MS, 5000),
  },

  // Local resilience
  retry: {
    dbPath:        env.RETRY_DB_PATH       || '/var/lib/escpos-bridge/retry.db',
    sweepEveryMs:  num(env.RETRY_SWEEP_MS, 30 * 1000),
    maxAgeHours:   num(env.RETRY_MAX_AGE_HOURS, 72),          // discard older than 3 days
  },

  // Identity (shows up in Hetzner DB so we know which Pi sent the event)
  device: {
    venue:      env.VENUE_SLUG || '19th-hole',
    deviceId:   env.DEVICE_ID  || 'pi5-19th-1',
  },

  // Verbosity
  logLevel: env.LOG_LEVEL || 'info',  // 'debug' | 'info' | 'warn' | 'error'
};

export function validateConfig() {
  const errs = [];
  if (!config.hetzner.secret) errs.push('INTERCEPTOR_SECRET not set — required for auth');
  if (config.receipt.enabled && !config.receipt.upstreamHost) {
    errs.push('RECEIPT_UPSTREAM_HOST not set (set RECEIPT_ENABLED=false to skip receipt proxy)');
  }
  if (config.kp.enabled && !config.kp.upstreamHost) {
    errs.push('KP_UPSTREAM_HOST not set (set KP_ENABLED=false to skip KP proxy)');
  }
  return errs;
}
