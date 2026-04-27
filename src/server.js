/**
 * escpos-bridge entry point.
 *
 * Two TCP listeners (receipt + KP). For each accepted connection:
 *   1. Open upstream socket to the real printer
 *   2. Pipe bytes both ways (transparent — printer keeps printing as normal)
 *   3. Buffer all client→printer bytes
 *   4. On client close, parse buffer, extract structured fields, forward to Hetzner
 *
 * Failure mode: if the upstream printer is unreachable, we tear the client
 * connection down so the till knows the print failed (operator will reprint).
 * We DO NOT silently absorb prints — that would hide real failures.
 */
import net from 'node:net';
import { config, validateConfig } from './config.js';
import { parse } from './escpos-parser.js';
import { extractReceipt } from './receipt-extract.js';
import { extractKp } from './kp-extract.js';
import { send, startSweepTimer, getQueueDepth } from './forwarder.js';

function startProxy(name, listenPort, upstreamHost, upstreamPort, parserAndExtract) {
  const server = net.createServer((client) => {
    const clientAddr = `${client.remoteAddress}:${client.remotePort}`;
    if (config.logLevel === 'debug') console.log(`[${name}] connect from ${clientAddr}`);

    const chunks = [];
    let upstream;
    try {
      upstream = net.createConnection({ host: upstreamHost, port: upstreamPort }, () => {
        if (config.logLevel === 'debug') console.log(`[${name}] upstream connected`);
      });
    } catch (err) {
      console.error(`[${name}] cannot reach printer ${upstreamHost}:${upstreamPort}: ${err.message}`);
      client.destroy();
      return;
    }

    upstream.on('error', (err) => {
      console.error(`[${name}] upstream error (${upstreamHost}:${upstreamPort}): ${err.message}`);
      client.destroy();
    });

    client.on('data', (buf) => {
      chunks.push(buf);
      upstream.write(buf);
    });

    client.on('end', () => upstream.end());
    client.on('error', (err) => {
      console.error(`[${name}] client error: ${err.message}`);
      upstream.destroy();
    });
    upstream.on('end', () => client.end());

    // When client disconnects, parse + forward (don't block printer)
    client.on('close', async () => {
      const total = Buffer.concat(chunks);
      if (total.length === 0) return;
      try {
        const parsed = parse(total);
        const extracted = parserAndExtract(parsed);
        const payload = {
          ...extracted,
          venue: config.device.venue,
          deviceId: config.device.deviceId,
          capturedAt: new Date().toISOString(),
          rawSize: total.length,
          raw_b64: parsed.raw_b64,
        };
        if (config.logLevel === 'debug') console.log(`[${name}] parsed:`, JSON.stringify(extracted, null, 2).slice(0, 800));
        await send(name, payload);
      } catch (err) {
        console.error(`[${name}] parse/forward failed: ${err.message}`);
      }
    });
  });

  server.on('error', (err) => {
    console.error(`[${name}] listen error on :${listenPort}: ${err.message}`);
    process.exit(1);
  });

  server.listen(listenPort, '0.0.0.0', () => {
    console.log(`[${name}] listening on :${listenPort} → forwarding to ${upstreamHost}:${upstreamPort}`);
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
console.log(`Hetzner: receipt → ${config.hetzner.receiptUrl}`);
console.log(`Hetzner: kp      → ${config.hetzner.kpUrl}`);
console.log(`Retry queue depth on boot: ${getQueueDepth()}`);

if (config.receipt.enabled) {
  startProxy('receipt', config.receipt.listenPort, config.receipt.upstreamHost, config.receipt.upstreamPort,
             (parsed) => ({ kind: 'receipt', ...extractReceipt(parsed) }));
}
if (config.kp.enabled) {
  startProxy('kp', config.kp.listenPort, config.kp.upstreamHost, config.kp.upstreamPort,
             (parsed) => ({ kind: 'kp', ...extractKp(parsed) }));
}

startSweepTimer();

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`Got ${sig}, exiting`);
    process.exit(0);
  });
}
