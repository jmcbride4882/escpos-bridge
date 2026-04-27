# Hetzner side patch

This document shows the changes needed in `/opt/eposnow-webhooks/src/server.js`
to receive intercepts from the Pi and (optionally) archive raw bytes to S3.

## 1. Run the SQL migration

```bash
PGPASSWORD=lsltapps psql -h localhost -U lsltapps -d lsltapps -f /opt/lsltapps/escpos-bridge/sql/001-interceptor-events.sql
```

## 2. Set the shared secret + S3 archive config

Add to `/opt/eposnow-webhooks/.env`:

```
INTERCEPTOR_SECRET=<openssl rand -hex 32 — paste output here>
# S3 archive (optional but strongly recommended for AEAT compliance)
S3_RECEIPTS_BUCKET=lsltapps-receipts
S3_RECEIPTS_REGION=eu-west-1
# (S3_ACCESS_KEY_ID + S3_SECRET_ACCESS_KEY presumably already in your env)
```

Make sure the bucket exists and your IAM key has `s3:PutObject` on it.

## 3. Code to add to /opt/eposnow-webhooks/src/server.js

Place this block alongside other route handlers (before `app.listen`):

```js
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const INTERCEPTOR_SECRET = process.env.INTERCEPTOR_SECRET || '';
const S3_RECEIPTS_BUCKET = process.env.S3_RECEIPTS_BUCKET || '';
const s3Client = S3_RECEIPTS_BUCKET
  ? new S3Client({ region: process.env.S3_RECEIPTS_REGION || 'eu-west-1' })
  : null;

function authIntercept(req, res, next) {
  if (!INTERCEPTOR_SECRET) return res.status(503).json({ error: 'interceptor not configured' });
  if (req.headers['x-interceptor-secret'] !== INTERCEPTOR_SECRET) {
    return res.status(401).json({ error: 'bad secret' });
  }
  next();
}

// Async fire-and-forget S3 archival — never blocks the response.
// Storage scheme:
//   s3://lsltapps-receipts/{venue}/{YYYY}/{MM}/{DD}/{invoice or capturedAt}.bin   ← raw ESC/POS
//   s3://lsltapps-receipts/{venue}/{YYYY}/{MM}/{DD}/{invoice or capturedAt}.json  ← parsed payload
function archiveToS3(venue, kind, payload) {
  if (!s3Client || !S3_RECEIPTS_BUCKET) return;
  const at = new Date(payload.capturedAt || Date.now());
  const yyyy = at.getUTCFullYear();
  const mm = String(at.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(at.getUTCDate()).padStart(2, '0');
  const slug = (payload.invoice || at.toISOString().replace(/[:.]/g, '-'))
    .replace(/[^A-Za-z0-9._-]/g, '_');
  const baseKey = `${venue}/${yyyy}/${mm}/${dd}/${kind}-${slug}`;

  // 1) Raw bytes
  if (payload.raw_b64) {
    s3Client.send(new PutObjectCommand({
      Bucket: S3_RECEIPTS_BUCKET,
      Key: `${baseKey}.bin`,
      Body: Buffer.from(payload.raw_b64, 'base64'),
      ContentType: 'application/octet-stream',
      Metadata: {
        venue, kind,
        invoice: payload.invoice ?? '',
        device: payload.deviceId ?? '',
        capturedAt: payload.capturedAt ?? '',
      },
    })).catch(err => console.error('[s3] raw archive failed:', err.message));
  }
  // 2) Parsed JSON
  s3Client.send(new PutObjectCommand({
    Bucket: S3_RECEIPTS_BUCKET,
    Key: `${baseKey}.json`,
    Body: JSON.stringify(payload, null, 2),
    ContentType: 'application/json',
  })).catch(err => console.error('[s3] json archive failed:', err.message));
}

app.post('/intercept/receipt', express.json({ limit: '1mb' }), authIntercept, async (req, res) => {
  try {
    const p = req.body || {};
    const venue = req.headers['x-venue'] || p.venue || null;
    const deviceId = req.headers['x-device-id'] || p.deviceId || null;

    // Cross-reference: time-window match against webhook_events for the same customer.
    // Tighten later with a JSONPath query against TransactionDetails.
    let matchedTxId = null;
    if (p.invoice) {
      const m = await prisma.webhookEvent.findFirst({
        where: {
          createdAt: {
            gte: new Date(new Date(p.capturedAt).getTime() - 30000),
            lte: new Date(new Date(p.capturedAt).getTime() + 30000),
          },
        },
        orderBy: { createdAt: 'asc' },
      }).catch(() => null);
      if (m) matchedTxId = Number(m.payload?.TransactionID ?? m.payload?.transactionID ?? null);
    }

    await lsltQueryParams(`
      INSERT INTO interceptor_events
        (kind, venue, device_id, captured_at, invoice, ticket, staff, till_device,
         total, customer_barcode, raw_size, raw_b64, payload, matched_eposnow_tx_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    `, [
      p.kind || 'receipt', venue, deviceId, p.capturedAt,
      p.invoice ?? null, p.ticket ?? null, p.staff ?? null, p.device ?? null,
      p.total ?? null, p.customerBarcode ?? null,
      p.rawSize ?? null, p.raw_b64 ?? null,
      JSON.stringify(p), matchedTxId,
    ]);

    // Async S3 archive (fire-and-forget — DB row is the source of truth, S3 is backup)
    archiveToS3(venue, p.kind || 'receipt', p);

    res.json({ ok: true });
  } catch (err) {
    console.error('[intercept/receipt] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/intercept/kp', express.json({ limit: '1mb' }), authIntercept, async (req, res) => {
  // Same shape as receipt — kept separate so the URL classifies the source.
  // Currently no PAYG venue uses this, but ready for future kitchen/bar setups.
  try {
    const p = req.body || {};
    const venue = req.headers['x-venue'] || p.venue || null;
    const deviceId = req.headers['x-device-id'] || p.deviceId || null;
    await lsltQueryParams(`
      INSERT INTO interceptor_events
        (kind, venue, device_id, captured_at, ticket, staff, raw_size, raw_b64, payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [
      'kp', venue, deviceId, p.capturedAt,
      p.order ?? p.ticket ?? null, p.server ?? null,
      p.rawSize ?? null, p.raw_b64 ?? null, JSON.stringify(p),
    ]);
    archiveToS3(venue, 'kp', p);
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

## 5. Test

```bash
curl -X POST https://webhooks.lsltapps.com/intercept/receipt \
  -H 'Content-Type: application/json' \
  -H "X-Interceptor-Secret: <your-secret>" \
  -H 'X-Venue: 19th-hole' \
  -H 'X-Device-Id: test' \
  -d '{
    "capturedAt":"2026-04-27T10:00:00Z",
    "invoice":"T-9999-1 F2-00000001",
    "total":1.60,
    "tenders":[{"name":"Customer Credit","amount":0.38},{"name":"Customer Points","amount":1.22}],
    "raw_b64":"GxAbdBM..."
  }'
```

You should see:
- `{"ok":true}` HTTP response
- A row in `interceptor_events`
- Two objects in S3: `s3://lsltapps-receipts/19th-hole/2026/04/27/receipt-T-9999-1_F2-00000001.bin` + `.json`

## Verifying S3 archive

```bash
aws s3 ls s3://lsltapps-receipts/19th-hole/$(date -u +%Y/%m/%d)/ --recursive
```

Or via the AWS console.

## Re-parsing later

If we improve the parser/extractor, we can re-process every archived receipt:

```bash
# pseudocode
aws s3 cp s3://lsltapps-receipts/19th-hole/2026/ ./tmp --recursive --exclude '*.json'
for f in ./tmp/**/*.bin; do
  node -e "..."   # run improved parser, UPDATE interceptor_events SET payload=...
done
```

Useful for: when EposNow changes their receipt format, when we add support for new document types (EOD/floats/petty cash extractors), or when we want to run new analytics across historical data.
