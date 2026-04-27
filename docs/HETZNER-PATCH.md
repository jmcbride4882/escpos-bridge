# Hetzner side patch

This document shows the changes needed in `/opt/eposnow-webhooks/src/server.js`
to receive intercepts from the Pi.

## 1. Run the SQL migration

```bash
psql -U lsltapps -d lsltapps -f /opt/lsltapps/escpos-bridge/sql/001-interceptor-events.sql
```

## 2. Set the shared secret

Add to `/opt/eposnow-webhooks/.env`:

```
INTERCEPTOR_SECRET=<some long random string — also set in Pi's /etc/escpos-bridge/config.env>
```

Generate one with: `openssl rand -hex 32`

## 3. Add to /opt/eposnow-webhooks/src/server.js

Place this block alongside the other route handlers (before `app.listen`):

```js
const INTERCEPTOR_SECRET = process.env.INTERCEPTOR_SECRET || '';

function authIntercept(req, res, next) {
  if (!INTERCEPTOR_SECRET) return res.status(503).json({ error: 'interceptor not configured' });
  const got = req.headers['x-interceptor-secret'];
  if (got !== INTERCEPTOR_SECRET) return res.status(401).json({ error: 'bad secret' });
  next();
}

app.post('/intercept/receipt', express.json({ limit: '1mb' }), authIntercept, async (req, res) => {
  try {
    const p = req.body || {};
    const venue = req.headers['x-venue'] || p.venue || null;
    const deviceId = req.headers['x-device-id'] || p.deviceId || null;

    // Cross-reference: find the matching webhook_events transaction by invoice number
    // (we don't have it explicitly there, but capturedAt is within ~3s of webhook arrival)
    let matchedTxId = null;
    let driftNotes = null;
    if (p.invoice) {
      const m = await prisma.webhookEvent.findFirst({
        where: {
          createdAt: {
            gte: new Date(new Date(p.capturedAt).getTime() - 30000),
            lte: new Date(new Date(p.capturedAt).getTime() + 30000),
          },
          // payload->'TransactionDetails' has UserPresentableInvoiceNumber matching p.invoice
        },
        orderBy: { createdAt: 'asc' },
      }).catch(() => null);
      // For now, time-based match. Tighten with a JSONPath query against TransactionDetails.
      if (m) matchedTxId = Number(m.payload?.TransactionID ?? m.payload?.transactionID ?? null);
    }

    // Drift detection: webhook had Tenders=null but receipt shows wallet/points tenders
    // (or vice versa: webhook reports Cash/Card but receipt shows none)
    const receiptTenders = (p.tenders || []).map(t => t.name);
    if (receiptTenders.some(n => /Customer Credit|Customer Points/i.test(n))) {
      // TODO: pull the matching webhook payload Tenders array and confirm absence — flag drift
    }

    await lsltQueryParams(`
      INSERT INTO interceptor_events
        (kind, venue, device_id, captured_at, invoice, ticket, staff, till_device,
         total, customer_barcode, raw_size, raw_b64, payload,
         matched_eposnow_tx_id, drift_detected, drift_notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    `, [
      'receipt', venue, deviceId, p.capturedAt,
      p.invoice ?? null, p.ticket ?? null, p.staff ?? null, p.device ?? null,
      p.total ?? null, p.customerBarcode ?? null,
      p.rawSize ?? null, p.raw_b64 ?? null,
      JSON.stringify(p),
      matchedTxId, driftNotes != null, driftNotes,
    ]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[intercept/receipt] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/intercept/kp', express.json({ limit: '1mb' }), authIntercept, async (req, res) => {
  try {
    const p = req.body || {};
    const venue = req.headers['x-venue'] || p.venue || null;
    const deviceId = req.headers['x-device-id'] || p.deviceId || null;
    await lsltQueryParams(`
      INSERT INTO interceptor_events
        (kind, venue, device_id, captured_at, ticket, staff,
         raw_size, raw_b64, payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [
      'kp', venue, deviceId, p.capturedAt,
      p.order ?? p.ticket ?? null, p.server ?? null,
      p.rawSize ?? null, p.raw_b64 ?? null,
      JSON.stringify(p),
    ]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[intercept/kp] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});
```

## 4. Reload

```bash
pm2 reload eposnow-webhooks
```

## 5. Test from your laptop

```bash
curl -X POST https://webhooks.lsltapps.com/intercept/receipt \
  -H 'Content-Type: application/json' \
  -H "X-Interceptor-Secret: $INTERCEPTOR_SECRET" \
  -H 'X-Venue: 19th-hole' \
  -H 'X-Device-Id: test' \
  -d '{"capturedAt":"2026-04-27T10:00:00Z","invoice":"T-9999-1 F2-00000001","total":1.60,"tenders":[{"name":"Customer Credit","amount":0.38}]}'
```

Should return `{"ok":true}` and you'll see the row in `interceptor_events`.
