/**
 * Extract structured kitchen-printer (KP) order data from parsed ESC/POS lines.
 *
 * EposNow KP receipts (typical layout — confirm against real capture):
 *   ┌────────────────────────────────┐
 *   │  ORDER #1234                   │ ← bold/large
 *   │  Table: 7   Server: John       │
 *   │  2026-04-27 12:30              │
 *   │  ─────────────────────────────  │
 *   │  2 x BURGER                    │
 *   │      no onions                 │ ← modifier
 *   │  1 x FRIES (large)             │
 *   │  1 x COKE                      │
 *   │  ─────────────────────────────  │
 *   │  PAID — Card                   │ ← optional tender hint
 *   └────────────────────────────────┘
 *
 * We extract a permissive shape; tighten once we see real samples.
 *
 * Output:
 *   {
 *     order:    '1234',
 *     table:    '7',
 *     server:   'John',
 *     time:     '2026-04-27 12:30',
 *     items:    [{ qty, name, modifiers: [...] }],
 *     tenderHint: 'Card',     // if KP echoes payment method
 *   }
 */
export function extractKp(parsed) {
  const lines = parsed.lines.map(l => l.text);
  const out = {
    order: null, table: null, server: null, time: null,
    items: [],
    tenderHint: null,
  };

  for (const text of lines) {
    const t = text.trim();
    let m;
    if (!out.order && (m = t.match(/^(?:ORDER|Order|#)\s*[#:]?\s*(\d+)/))) out.order = m[1];
    if (!out.table && (m = t.match(/Table[:\s]+(\S+)/i))) out.table = m[1];
    if (!out.server && (m = t.match(/Server[:\s]+(.+?)(?:\s{2}|$)/i))) out.server = m[1].trim();
    if (!out.time && (m = t.match(/^(\d{4}[\/-]\d{2}[\/-]\d{2}[\sT]\d{2}:\d{2}(?::\d{2})?)/))) out.time = m[1];

    // Item: "  2 x BURGER" or "2x BURGER" or "BURGER x 2"
    if ((m = t.match(/^(\d+)\s*[x×]\s+(.+)$/i))) {
      out.items.push({ qty: Number(m[1]), name: m[2].trim(), modifiers: [] });
      continue;
    }
    if ((m = t.match(/^(.+?)\s+[x×]\s*(\d+)$/i))) {
      out.items.push({ qty: Number(m[2]), name: m[1].trim(), modifiers: [] });
      continue;
    }

    // Modifier: indented line under last item
    if (out.items.length && /^\s{2,}\S/.test(text) && !/[x×]\s*\d/.test(t)) {
      out.items[out.items.length - 1].modifiers.push(t);
    }

    // Tender hint
    if ((m = t.match(/^(?:PAID|Paid)\s*[—-]?\s*(.+)$/))) {
      out.tenderHint = m[1].trim();
    }
  }

  return out;
}
