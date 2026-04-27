/**
 * Classify a parsed receipt by its first lines, so the receipt port can
 * handle multiple document types from the same physical printer:
 *
 *   sales       → "Simplified Invoice:" header
 *   eod         → "End of Day Report" / "Z-Report" / "X-Report"
 *   float       → "Float Adjustment" / "Float Up" / "Float Down"
 *   petty_cash  → "Petty Cash"
 *   nosale      → "NO SALE" / "DRAWER OPEN"
 *   refund      → "Refund" header (or negative total)
 *   void        → "VOID" header
 *   balance     → "Customer Balance" / "Account Statement"
 *   other       → anything we don't yet recognize (raw_b64 still archived)
 *
 * Returns 'sales' as default for sales-receipt-shaped documents (so existing
 * receipt extractor still runs); other types just route the raw to Hetzner
 * for now, with extractors to be added once we see real samples.
 */
export function classify(parsed) {
  const lines = parsed.lines.map(l => l.text.trim()).filter(Boolean).slice(0, 12);
  const text = lines.join(' | ').toUpperCase();

  if (text.includes('SIMPLIFIED INVOICE'))                 return 'sales';
  if (text.includes('END OF DAY') || /\bZ-?REPORT\b/.test(text)) return 'eod';
  if (/\bX-?REPORT\b/.test(text))                          return 'x_report';
  if (text.includes('FLOAT ADJUSTMENT') || text.includes('FLOAT UP') || text.includes('FLOAT DOWN')) return 'float';
  if (text.includes('PETTY CASH'))                         return 'petty_cash';
  if (text.includes('NO SALE') || text.includes('DRAWER OPEN')) return 'nosale';
  if (text.includes('REFUND'))                             return 'refund';
  if (text.includes('VOID') && !text.includes('AVOID'))    return 'void';
  if (text.includes('CUSTOMER BALANCE') || text.includes('ACCOUNT STATEMENT')) return 'balance';

  // Heuristic: looks like a sales receipt if it has both "PRODUCT" header and a "Total" line
  const hasProductHdr = lines.some(l => /^PRODUCT\s+/.test(l));
  const hasTotal = lines.some(l => /^Total\b/.test(l));
  if (hasProductHdr && hasTotal) return 'sales';

  return 'other';
}
