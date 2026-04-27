/**
 * Extract structured receipt data from parsed ESC/POS lines.
 * Format reverse-engineered from EposNow Spanish "Simplified Invoice" receipts.
 *
 * Output:
 *   {
 *     invoice:   'T-8712-1 F2-00000002',
 *     date:      '2026/04/26 14:10:37.170',
 *     staff:     'John',
 *     device:    'Till7',
 *     ticket:    'A - 3',
 *     items:     [{ name, unit, qty, total }],
 *     subtotal:  1.60,
 *     discounts: [{ name: 'Customer Points', amount: -1.22 }],
 *     total:     1.60,
 *     tenders:   [{ name: 'Customer Credit', amount: 0.38 },
 *                 { name: 'Customer Points', amount: 1.22 }],
 *     taxes:     [{ name: 'IVA 10%', percent: 10, base: 1.45, tax: 0.04 }],
 *     customerBarcode: 'RECB000022IW07UWZ6K8W',
 *     venue:     'Snack Shack',
 *   }
 *
 * Section markers we walk between:
 *   "Simplified Invoice:"     start
 *   "PRODUCT ... PRICE QTY TOTAL"   items begin
 *   "Sub Total"                items end
 *   "PAYMENT BY TENDER"         tenders begin
 *   "TAX RATE"                  taxes begin
 */

function parseEur(s) {
  // EposNow: "€1.60" or "-€1.22" — sometimes with leading spaces
  const m = String(s).match(/-?€\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return s.includes('-') ? -n : n;
}

export function extractReceipt(parsed) {
  const lines = parsed.lines.map(l => l.text);
  const out = {
    invoice: null, date: null, staff: null, device: null, ticket: null,
    venue: null,
    items: [], discounts: [], tenders: [], taxes: [],
    subtotal: null, total: null,
    customerBarcode: null,
  };

  // First non-empty line is venue (we saw "Snack Shack" in the test)
  out.venue = lines.find(l => l.trim().length > 0)?.trim() ?? null;

  // Header field lookups (label is left-aligned, value is right-aligned, space-padded between)
  for (const text of lines) {
    const trimmed = text.trim();
    if (trimmed.startsWith('Invoice No.')) out.invoice = trimmed.replace(/^Invoice No\.\s*/, '').trim();
    else if (trimmed.startsWith('Date')) out.date = trimmed.replace(/^Date\s*/, '').trim();
    else if (trimmed.startsWith('Staff')) out.staff = trimmed.replace(/^Staff\s*/, '').trim();
    else if (trimmed.startsWith('Device')) out.device = trimmed.replace(/^Device\s*/, '').trim();
  }

  // Ticket number: line after "TICKET NUMBER" header that's bold + sized
  const ticketIdx = lines.findIndex(l => l.trim() === 'TICKET NUMBER');
  if (ticketIdx >= 0 && ticketIdx + 1 < lines.length) out.ticket = lines[ticketIdx + 1].trim();

  // Items: between "PRODUCT ... PRICE QTY TOTAL" and "Sub Total"
  const itemsStart = lines.findIndex(l => /^PRODUCT\s+/.test(l.trim()));
  const itemsEnd   = lines.findIndex((l, i) => i > itemsStart && /^Sub Total\b/.test(l.trim()));
  if (itemsStart >= 0 && itemsEnd > itemsStart) {
    for (let i = itemsStart + 1; i < itemsEnd; i++) {
      const line = lines[i];
      if (!line.trim() || /^Total Qty\b/.test(line.trim()) || /^-+$/.test(line.trim())) continue;
      // Format: "AGUA 50CL BOTTLE           €1.60     1     €1.60"
      // Right side is fixed columns. We split from the right.
      const parts = line.trim().split(/\s{2,}/);
      if (parts.length >= 2) {
        const total = parseEur(parts[parts.length - 1]);
        // Try to extract qty and unit: pattern "name PRICE QTY TOTAL"
        const m = line.match(/^(.+?)\s+€?([0-9.]+)\s+(-?[0-9]+)\s+-?€([0-9.]+)\s*$/);
        if (m) {
          out.items.push({
            name: m[1].trim(),
            unit: Number(m[2]),
            qty:  Number(m[3]),
            total: Number(m[4]),
          });
        } else {
          out.items.push({ name: parts[0], total });
        }
      }
    }
  }

  // Sub Total / discounts / Total
  for (const text of lines) {
    const t = text.trim();
    const m = t.match(/^Sub Total\s+(-?€[0-9.]+)$/);
    if (m) { out.subtotal = parseEur(m[1]); continue; }
    const tm = t.match(/^Total\s+(-?€[0-9.]+)$/);
    if (tm) { out.total = parseEur(tm[1]); continue; }
  }

  // Discounts: lines between "Sub Total" and "Total" that have a euro value
  const subIdx = lines.findIndex(l => /^Sub Total\b/.test(l.trim()));
  const totalIdx = lines.findIndex((l, i) => i > subIdx && /^Total\s+-?€/.test(l.trim()));
  if (subIdx >= 0 && totalIdx > subIdx) {
    for (let i = subIdx + 1; i < totalIdx; i++) {
      const t = lines[i].trim();
      const m = t.match(/^(.+?)\s+(-€[0-9.]+)$/);
      if (m) out.discounts.push({ name: m[1].trim(), amount: parseEur(m[2]) });
    }
  }

  // Tenders: between "PAYMENT BY TENDER" and the next "---" or "TAX RATE"
  const tStart = lines.findIndex(l => /^PAYMENT BY TENDER\b/.test(l.trim()));
  const tEnd   = lines.findIndex((l, i) => i > tStart && (/^TAX RATE\b/.test(l.trim()) || /^-+$/.test(l.trim())));
  if (tStart >= 0) {
    for (let i = tStart + 1; i < (tEnd > 0 ? tEnd : lines.length); i++) {
      const t = lines[i].trim();
      const m = t.match(/^(.+?)\s+(-?€[0-9.]+)$/);
      if (m) out.tenders.push({ name: m[1].trim(), amount: parseEur(m[2]) });
    }
  }

  // Taxes: between "TAX RATE" and the next "---"
  const taxStart = lines.findIndex(l => /^TAX RATE\b/.test(l.trim()));
  const taxEnd   = lines.findIndex((l, i) => i > taxStart && /^-+$/.test(l.trim()));
  if (taxStart >= 0) {
    for (let i = taxStart + 1; i < (taxEnd > 0 ? taxEnd : lines.length); i++) {
      const t = lines[i].trim();
      // "IVA 10%                   10.00% €1.45     €0.04"
      const m = t.match(/^(.+?)\s+([0-9.]+)%\s+€([0-9.]+)\s+€([0-9.]+)$/);
      if (m) out.taxes.push({
        name: m[1].trim(),
        percent: Number(m[2]),
        base: Number(m[3]),
        tax: Number(m[4]),
      });
    }
  }

  // Customer barcode: first CODE128 barcode in the parsed barcodes
  const code128 = parsed.barcodes.find(b => b.format === 'CODE128');
  if (code128) out.customerBarcode = code128.data;

  return out;
}
