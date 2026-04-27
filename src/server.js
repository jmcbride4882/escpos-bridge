/**
 * escpos-bridge entry point.
 *
 * One TCP proxy per configured printer. For each accepted connection:
 *   1. Open upstream socket to the real printer
 *   2. Pipe bytes both ways (transparent — printer keeps printing as normal)
 *   3. Buffer all client→printer bytes
 *   4. On client close: parse buffer, classify, extract, forward to Hetzner
 *   5. PRINT_MODE controls whether bytes physically reach the printer
 *
 * Failure mode: if the upstream printer is unreachable, the till's print
 * fails (clear signal to operator). We do NOT silently absorb prints.
 */
import net from 'node:net';
import { config, validateConfig } from './config.js';
import { parse } from './escpos-parser.js';
import { classify } from './classify.js';
import { extractReceipt } from './receipt-extract.js';
import { extractKp } from './kp-extract.js';
import { send, startSweepTimer, getQueueDepth } from './forwarder.js';
import { startWebGui, recordIntercept, bumpPrinterStats } from './web.js';

// Recent-prints cache for on-demand-2x mode (sales receipts only)
const recentPrints = new Map();   // key = content-hash, value = { firstSeenAt, bytes, printer }
const RECENT_TTL_MS = 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - RECENT_TTL_MS;
  for (const [k, v] of recentPrints) if (v.firstSeenAt < cutoff) recentPrints.delete(k);
}, 30 * 1000).unref();

function contentHash(buf) {
  // Simple fast hash — good enough for dedup detection within 60s window
  let h = 0;
  for (let i = 0; i < buf.length; i++) h = ((h << 5) - h + buf[i]) | 0;
  return h.toString(36);
}

/**
 * Decide whether to physically forward bytes to the printer.
 * Returns true to print, false to silently capture only.
 */
function shouldPrint(printer, parsed, kind, totalEur, buf) {
  if (config.printMode === 'transparent') return true;
  if (config.printMode === 'digital-only') return false;

  // 'on-demand-2x' mode
  // Always print non-sales documents (floats/EODs/refunds/etc — usually staff need paper)
  if (kind !== 'sales') return true;
  // Always print large transactions
  if (totalEur != null && totalEur >= config.alwaysPrintAboveEur) return true;

  // Check if we've seen this content recently (within window)
  const hash = contentHash(buf);
  const prior = recentPrints.get(hash);
  const now = Date.now();
  if (prior && (now - prior.firstSeenAt) < config.duplicateWindowMs) {
    // Second press — print AND clear so the next first-press starts fresh
    recentPrints.delete(hash);
    return true;
  }
  // First press — capture only, remember so the next one within window prints
  recentPrints.set(hash, { firstSeenAt: now, printer: printer.name });
  return false;
}

function startProxy(printer) {
  const server = net.createServer((client) => {
    const clientAddr = `${client.remoteAddress}:${client.remotePort}`;
    if (config.logLevel === 'debug') console.log(`[${printer.name}] connect from ${clientAddr}`);

    const chunks = [];
    let upstream = null;
    let upstreamReady = false;
    const pendingToUpstream = [];   // bytes received before upstream opens

    function openUpstream() {
      try {
        upstream = net.createConnection({ host: printer.upstreamHost, port: printer.upstreamPort }, () => {
          upstreamReady = true;
          for (const b of pendingToUpstream) upstream.write(b);
          pendingToUpstream.length = 0;
        });
        upstream.on('error', (err) => {
          console.error(`[${printer.name}] upstream error (${printer.upstreamHost}:${printer.upstreamPort}): ${err.message}`);
          client.destroy();
        });
        upstream.on('end', () => client.end());
      } catch (err) {
        console.error(`[${printer.name}] cannot reach printer ${printer.upstreamHost}:${printer.upstreamPort}: ${err.message}`);
        client.destroy();
      }
    }

    client.on('data', (buf) => {
      chunks.push(buf);
      // Decision to forward happens at end-of-stream so we know full content.
      // Buffer to upstream until then.
      if (upstreamReady) upstream.write(buf);
      else pendingToUpstream.push(buf);
    });

    client.on('end',   () => upstream?.end());
    client.on('error', (err) => {
      console.error(`[${printer.name}] client error: ${err.message}`);
      upstream?.destroy();
    });

    // We'll open upstream lazily on `close` once we've decided to forward.
    // For 'transparent' mode (the default), open it immediately so latency is zero.
    if (config.printMode === 'transparent') openUpstream();

    client.on('close', async () => {
      const total = Buffer.concat(chunks);
      if (total.length === 0) return;

      let parsed, kind = 'other', extracted = {}, totalEur = null;
      try {
        parsed = parse(total);
        if (printer.kind === 'receipt') {
          kind = classify(parsed);
          if (kind === 'sales') {
            extracted = extractReceipt(parsed);
            totalEur = extracted.total;
          } else {
            // Non-sales: capture lines + raw, no specific extractor yet
            extracted = { kind, lines: parsed.lines.map(l => l.text), barcodes: parsed.barcodes };
          }
        } else if (printer.kind === 'kp' || printer.kind === 'bar') {
          kind = printer.kind;
          extracted = extractKp(parsed);
        }
      } catch (err) {
        console.error(`[${printer.name}] parse failed: ${err.message}`);
      }

      // Forwarding decision
      const willPrint = shouldPrint(printer, parsed, kind, totalEur, total);
      if (willPrint && !upstreamReady && config.printMode !== 'transparent') {
        // Open and write the buffered bytes now
        openUpstream();
        // Wait briefly for upstream to be ready
        await new Promise(r => setTimeout(r, 50));
        if (upstreamReady) {
          for (const b of chunks) upstream.write(b);
          upstream.end();
        }
      } else if (!willPrint && upstreamReady) {
        // shouldn't happen in non-transparent mode (we don't open upstream until decision)
        // but if it did, we already forwarded — no rollback possible
      }

      const payload = {
        ...extracted,
        kind,
        printerName: printer.name,
        printerKind: printer.kind,
        venue: config.device.venue,
        deviceId: config.device.deviceId,
        capturedAt: new Date().toISOString(),
        rawSize: total.length,
        raw_b64: parsed?.raw_b64 ?? total.toString('base64'),
        physicallyPrinted: willPrint,
      };

      if (config.logLevel === 'debug') {
        console.log(`[${printer.name}] kind=${kind} willPrint=${willPrint} extracted=${JSON.stringify(extracted).slice(0, 300)}`);
      } else {
        console.log(`[${printer.name}] ${kind} captured (${total.length}B) printed=${willPrint}`);
      }

      const httpKind = (printer.kind === 'receipt') ? 'receipt' : 'kp';
      try { await send(httpKind, payload); }
      catch (err) { console.error(`[${printer.name}] forward failed: ${err.message}`); }

      // Update web UI stats
      bumpPrinterStats(printer.name, total.length);
      const summary = kind === 'sales' && extracted.invoice
        ? `${extracted.invoice} · €${extracted.total}`
        : kind === 'kp' || kind === 'bar'
          ? `order ${extracted.order ?? '?'} · ${extracted.items?.length ?? 0} items`
          : `${total.length}B`;
      recordIntercept(printer.name, kind, summary);
    });
  });

  server.on('error', (err) => {
    console.error(`[${printer.name}] listen error on :${printer.listenPort}: ${err.message}`);
    process.exit(1);
  });

  server.listen(printer.listenPort, '0.0.0.0', () => {
    console.log(`[${printer.name}] listening on :${printer.listenPort} → ${printer.upstreamHost}:${printer.upstreamPort} (kind=${printer.kind})`);
  });

  return server;
}

// ── Boot ───────────────────────────────────────────────────────────────────

const errs = validateConfig();
if (errs.length) {
  console.error('Configuration errors:');
  for (const e of errs) console.error('  -', e);
  process.exit(1);
}

console.log(`escpos-bridge starting (venue=${config.device.venue}, device=${config.device.deviceId})`);
console.log(`Print mode: ${config.printMode}${config.printMode === 'on-demand-2x' ? ` (window=${config.duplicateWindowMs}ms, always-print >=€${config.alwaysPrintAboveEur})` : ''}`);
console.log(`Hetzner: ${config.hetzner.baseUrl}/{receipt,kp}`);
console.log(`Retry queue depth on boot: ${getQueueDepth()}`);
console.log(`Printers configured: ${config.printers.length}`);

for (const p of config.printers) {
  if (p.enabled) startProxy(p);
  else console.log(`[${p.name}] disabled`);
}

startSweepTimer();
startWebGui();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log(`Got ${sig}, exiting`); process.exit(0); });
}
