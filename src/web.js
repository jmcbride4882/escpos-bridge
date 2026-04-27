/**
 * Local web GUI for configuration + monitoring.
 * Runs on http://<pi-ip>:WEB_PORT (default 8080) on the Pi's LAN.
 *
 * Auth: HTTP Basic — username 'admin', password from WEB_PASSWORD env var.
 *       Default 'changeme' → first-run wizard forces a change.
 *
 * Endpoints:
 *   GET  /                 → single-page UI (web/index.html)
 *   GET  /api/status       → { printers, queue, uptime, recentIntercepts }
 *   GET  /api/config       → current config (sanitized)
 *   POST /api/config       → save /etc/escpos-bridge/config.env
 *   POST /api/restart      → systemctl restart escpos-bridge
 *   GET  /api/logs?n=200   → last N journalctl lines for the service
 *   GET  /api/scan         → LAN scan for hosts with port 9100 open
 *   POST /api/test-print   → { host, port } send small test receipt
 */
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import { config } from './config.js';
import { getQueueDepth } from './forwarder.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dirname, '..', 'web', 'index.html');
const CONFIG_PATH = '/etc/escpos-bridge/config.env';

// In-memory ring of recent intercepts (last 20)
export const recentIntercepts = [];
const MAX_RECENT = 20;
export function recordIntercept(printerName, kind, summary) {
  recentIntercepts.unshift({
    at: new Date().toISOString(),
    printer: printerName, kind, summary,
  });
  if (recentIntercepts.length > MAX_RECENT) recentIntercepts.length = MAX_RECENT;
}

// Per-printer last-byte stats
export const printerStats = new Map();   // name → { lastByteAt, totalBytes, totalConnections }
export function bumpPrinterStats(name, bytes) {
  const s = printerStats.get(name) || { lastByteAt: null, totalBytes: 0, totalConnections: 0 };
  s.lastByteAt = new Date().toISOString();
  s.totalBytes += bytes;
  s.totalConnections += 1;
  printerStats.set(name, s);
}

// Auth
function checkAuth(req) {
  const password = process.env.WEB_PASSWORD || 'changeme';
  const hdr = req.headers.authorization || '';
  if (!hdr.startsWith('Basic ')) return false;
  const decoded = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
  const [user, pass] = decoded.split(':');
  return user === 'admin' && pass === password;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { resolve({}); }
    });
  });
}

// Sanitize config for client (hide secrets)
function sanitizedConfig() {
  return {
    venue: config.device.venue,
    deviceId: config.device.deviceId,
    printers: config.printers,
    printMode: config.printMode,
    duplicateWindowMs: config.duplicateWindowMs,
    alwaysPrintAboveEur: config.alwaysPrintAboveEur,
    hetznerBaseUrl: config.hetzner.baseUrl,
    hetznerSecretSet: !!config.hetzner.secret,
    webPasswordIsDefault: (process.env.WEB_PASSWORD || 'changeme') === 'changeme',
    interceptorSecretIsDefault: (config.hetzner.secret || '') === 'changeme' || !config.hetzner.secret,
  };
}

// Write config.env from a partial JSON update (preserves keys we don't touch)
function saveConfig(updates) {
  let current = {};
  if (existsSync(CONFIG_PATH)) {
    const text = readFileSync(CONFIG_PATH, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (m) current[m[1]] = m[2];
    }
  }
  const merged = { ...current, ...updates };
  // Preserve a sensible order: identity, secret, printers, mode, advanced
  const ordered = [
    'INTERCEPTOR_SECRET', 'WEB_PASSWORD',
    'VENUE_SLUG', 'DEVICE_ID',
    ...Array.from({ length: 8 }, (_, i) => i + 1).flatMap((i) => [
      `PRINTER_${i}_NAME`, `PRINTER_${i}_KIND`,
      `PRINTER_${i}_PORT`, `PRINTER_${i}_HOST`, `PRINTER_${i}_UPSTREAM_PORT`, `PRINTER_${i}_ENABLED`,
    ]),
    'PRINT_MODE', 'DUPLICATE_WINDOW_MS', 'ALWAYS_PRINT_ABOVE_EUR',
    'HETZNER_BASE_URL', 'LOG_LEVEL', 'WEB_PORT',
  ];
  const lines = [];
  const seen = new Set();
  for (const key of ordered) {
    if (key in merged) {
      lines.push(`${key}=${merged[key]}`);
      seen.add(key);
    }
  }
  // Catch any keys we didn't anticipate
  for (const [k, v] of Object.entries(merged)) {
    if (!seen.has(k)) lines.push(`${k}=${v}`);
  }
  writeFileSync(CONFIG_PATH, lines.join('\n') + '\n', { mode: 0o600 });
}

// LAN scan — try TCP connect to port 9100 on every host in the Pi's primary subnet.
async function scanLan() {
  const ifaces = os.networkInterfaces();
  let myIp = null, prefix = null;
  for (const list of Object.values(ifaces)) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        myIp = iface.address;
        prefix = iface.address.split('.').slice(0, 3).join('.');
        break;
      }
    }
    if (myIp) break;
  }
  if (!prefix) return { error: 'No IPv4 interface found' };

  const probes = [];
  for (let i = 1; i < 255; i++) {
    if (i === Number(myIp.split('.')[3])) continue;       // skip self
    const host = `${prefix}.${i}`;
    probes.push(new Promise((resolve) => {
      const sock = net.createConnection({ host, port: 9100 });
      let done = false;
      const timer = setTimeout(() => {
        if (!done) { done = true; sock.destroy(); resolve(null); }
      }, 800);
      sock.on('connect', () => {
        if (!done) { done = true; clearTimeout(timer); sock.destroy(); resolve(host); }
      });
      sock.on('error', () => {
        if (!done) { done = true; clearTimeout(timer); resolve(null); }
      });
    }));
  }
  const results = (await Promise.all(probes)).filter(Boolean);
  return { myIp, subnet: prefix + '.0/24', open9100: results };
}

// Send a tiny test receipt
async function testPrint(host, port = 9100) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    const t = setTimeout(() => { sock.destroy(); resolve({ ok: false, error: 'timeout' }); }, 3000);
    sock.on('connect', () => {
      const now = new Date().toLocaleString('en-GB', { timeZone: 'Europe/Madrid' });
      const bytes = Buffer.concat([
        Buffer.from([0x1B, 0x40]),                                    // INIT
        Buffer.from([0x1B, 0x61, 0x01]),                              // ALIGN_CENTER
        Buffer.from([0x1B, 0x45, 0x01, 0x1D, 0x21, 0x11]),            // BOLD + 2x size
        Buffer.from('escpos-bridge\n', 'ascii'),
        Buffer.from([0x1D, 0x21, 0x00, 0x1B, 0x45, 0x00]),            // normal
        Buffer.from('Test print from Pi\n', 'ascii'),
        Buffer.from(now + '\n', 'ascii'),
        Buffer.from('\n\n\n', 'ascii'),
        Buffer.from([0x1D, 0x56, 0x00]),                              // CUT
      ]);
      sock.end(bytes, () => { clearTimeout(t); resolve({ ok: true }); });
    });
    sock.on('error', (err) => { clearTimeout(t); resolve({ ok: false, error: err.message }); });
  });
}

const startedAt = Date.now();

export function startWebGui() {
  const PORT = Number(process.env.WEB_PORT || 8080);
  const html = existsSync(HTML_PATH) ? readFileSync(HTML_PATH, 'utf8') : '<h1>web/index.html missing</h1>';

  const server = http.createServer(async (req, res) => {
    // Allow no-auth on / so the browser shows a login prompt nicely
    if (req.url === '/' || req.url === '/index.html') {
      if (!checkAuth(req)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="escpos-bridge"' });
        res.end('Auth required');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // All API requires auth
    if (!checkAuth(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="escpos-bridge"', 'Content-Type': 'application/json' });
      res.end('{"error":"unauthorized"}');
      return;
    }

    try {
      if (req.url === '/api/status' && req.method === 'GET') {
        const printers = config.printers.map(p => ({
          ...p,
          stats: printerStats.get(p.name) || { lastByteAt: null, totalBytes: 0, totalConnections: 0 },
        }));
        return send(res, 200, {
          uptime: Math.floor((Date.now() - startedAt) / 1000),
          printers,
          queue: getQueueDepth(),
          recentIntercepts,
          printMode: config.printMode,
        });
      }
      if (req.url === '/api/config' && req.method === 'GET') {
        return send(res, 200, sanitizedConfig());
      }
      if (req.url === '/api/config' && req.method === 'POST') {
        const updates = await readBody(req);
        // Whitelist allowed keys
        const allowed = new Set([
          'INTERCEPTOR_SECRET', 'WEB_PASSWORD', 'VENUE_SLUG', 'DEVICE_ID',
          'PRINT_MODE', 'DUPLICATE_WINDOW_MS', 'ALWAYS_PRINT_ABOVE_EUR',
          'HETZNER_BASE_URL', 'LOG_LEVEL', 'WEB_PORT',
        ]);
        for (let i = 1; i <= 8; i++) {
          for (const suf of ['NAME', 'KIND', 'PORT', 'HOST', 'UPSTREAM_PORT', 'ENABLED', 'VENUE']) {
            allowed.add(`PRINTER_${i}_${suf}`);
          }
        }
        const filtered = {};
        for (const [k, v] of Object.entries(updates || {})) {
          if (allowed.has(k) && v != null) filtered[k] = String(v);
        }
        saveConfig(filtered);
        return send(res, 200, { ok: true, restartNeeded: true });
      }
      if (req.url === '/api/restart' && req.method === 'POST') {
        // Use sudoers entry: nobody/escpos can run this without password
        const r = spawnSync('sudo', ['-n', '/bin/systemctl', 'restart', 'escpos-bridge']);
        return send(res, r.status === 0 ? 200 : 500, { ok: r.status === 0, stderr: r.stderr.toString() });
      }
      if (req.url?.startsWith('/api/logs') && req.method === 'GET') {
        const url = new URL(req.url, 'http://x');
        const n = Math.min(2000, Number(url.searchParams.get('n') || 200));
        try {
          const out = execSync(`journalctl -u escpos-bridge -n ${n} --no-pager -o cat`, { timeout: 5000 });
          return send(res, 200, { lines: out.toString('utf8').split('\n') });
        } catch (err) {
          return send(res, 500, { error: err.message });
        }
      }
      if (req.url === '/api/scan' && req.method === 'GET') {
        return send(res, 200, await scanLan());
      }
      if (req.url === '/api/test-print' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.host) return send(res, 400, { error: 'host required' });
        const r = await testPrint(body.host, body.port || 9100);
        return send(res, r.ok ? 200 : 500, r);
      }
      send(res, 404, { error: 'not found' });
    } catch (err) {
      console.error('[web] handler error:', err);
      send(res, 500, { error: err.message });
    }
  });

  server.listen(PORT, '0.0.0.0', () => {
    const ips = Object.values(os.networkInterfaces()).flat().filter(i => i?.family === 'IPv4' && !i.internal);
    console.log(`[web] GUI listening on :${PORT} → http://${ips[0]?.address || 'pi-ip'}:${PORT} (admin / WEB_PASSWORD)`);
  });
  return server;
}
