/**
 * Replays the actual ESC/POS dump captured from EposNow on 2026-04-26
 * (TX 56226931 — AGUA 50CL paid €1.22 points + €0.38 wallet credit).
 * Verifies the parser + receipt extractor produce the expected fields.
 *
 *   node test/parse-sample.js
 */
import { parse } from '../src/escpos-parser.js';
import { extractReceipt } from '../src/receipt-extract.js';

// Reconstructed from the printer dump in the conversation. Real bytes.
const sample = Buffer.from([
  0x1B, 0x40,                                                     // INIT
  0x1B, 0x74, 0x13,                                                // CODEPAGE_CP858
  0x1B, 0x61, 0x01,                                                // ALIGN_CENTER
  0x1B, 0x45, 0x01,                                                // BOLD_ON
  0x1D, 0x21, 0x11,                                                // SIZE_2x2
  0x53, 0x6E, 0x61, 0x63, 0x6B, 0x20, 0x53, 0x68, 0x61, 0x63, 0x6B, 0x0A,  // "Snack Shack\n"
  0x1D, 0x21, 0x00, 0x1B, 0x45, 0x00,                              // SIZE_NORMAL, BOLD_OFF
  0x0A,
  ...Buffer.from('LAKESIDE LA TORRE (MURCIA) GROUP SL\n(ESB70822366)\nVAT Number: B70822366\nLa Torre Golf Resort, Torre-Pacheco, Spain\nTorre-Pacheco\nMurcia\n30709\nlsltgroup.es | gm@lsltgroup.es\n', 'ascii'),
  0x1B, 0x61, 0x00,                                                // ALIGN_LEFT
  ...Buffer.from('-'.repeat(48) + '\n', 'ascii'),
  0x1B, 0x61, 0x01, 0x1B, 0x45, 0x01,
  ...Buffer.from('Simplified Invoice:\n', 'ascii'),
  0x1B, 0x45, 0x00, 0x1B, 0x61, 0x00,
  ...Buffer.from('-'.repeat(48) + '\n', 'ascii'),
  ...Buffer.from('Invoice No.                 T-8712-1 F2-00000002\n', 'ascii'),
  ...Buffer.from('Date                     2026/04/26 14:10:37.170\n', 'ascii'),
  ...Buffer.from('Staff                                       John\n', 'ascii'),
  ...Buffer.from('Device                                     Till7\n', 'ascii'),
  ...Buffer.from('\nTICKET NUMBER\n', 'ascii'),
  0x1B, 0x45, 0x01, 0x1D, 0x21, 0x11,
  ...Buffer.from('A - 3\n', 'ascii'),
  0x1D, 0x21, 0x00, 0x1B, 0x45, 0x00,
  ...Buffer.from('-'.repeat(48) + '\n', 'ascii'),
  0x1B, 0x45, 0x01,
  ...Buffer.from('PRODUCT                    PRICE   QTY     TOTAL\n', 'ascii'),
  0x1B, 0x45, 0x00,
  // Item line — using D5 for €
  ...Buffer.from('AGUA 50CL BOTTLE           ', 'ascii'), 0xD5, ...Buffer.from('1.60     1     ', 'ascii'), 0xD5, ...Buffer.from('1.60\n', 'ascii'),
  ...Buffer.from('Total Qty                                      1\n', 'ascii'),
  ...Buffer.from('-'.repeat(48) + '\n', 'ascii'),
  ...Buffer.from('Sub Total                                  ', 'ascii'), 0xD5, ...Buffer.from('1.60\n', 'ascii'),
  ...Buffer.from('Customer Points                           -', 'ascii'), 0xD5, ...Buffer.from('1.22\n', 'ascii'),
  0x1B, 0x45, 0x01, 0x1D, 0x21, 0x01,
  ...Buffer.from('Total              ', 'ascii'), 0xD5, ...Buffer.from('1.60\n', 'ascii'),
  0x1D, 0x21, 0x00, 0x1B, 0x45, 0x00,
  ...Buffer.from('-'.repeat(48) + '\n', 'ascii'),
  0x1B, 0x45, 0x01,
  ...Buffer.from('PAYMENT BY TENDER                         AMOUNT\n', 'ascii'),
  0x1B, 0x45, 0x00,
  ...Buffer.from('Customer Credit                            ', 'ascii'), 0xD5, ...Buffer.from('0.38\n', 'ascii'),
  ...Buffer.from('Customer Points                            ', 'ascii'), 0xD5, ...Buffer.from('1.22\n', 'ascii'),
  ...Buffer.from('-'.repeat(48) + '\n', 'ascii'),
  0x1B, 0x45, 0x01,
  ...Buffer.from('TAX RATE              PERCENTAGE  BASE       TAX\n', 'ascii'),
  0x1B, 0x45, 0x00,
  ...Buffer.from('IVA 10%                   10.00% ', 'ascii'), 0xD5, ...Buffer.from('1.45     ', 'ascii'), 0xD5, ...Buffer.from('0.04\n', 'ascii'),
  ...Buffer.from('-'.repeat(49) + '\n', 'ascii'),
  // CODE128 barcode
  0x1D, 0x68, 0x50, 0x1D, 0x77, 0x02, 0x1D, 0x48, 0x02, 0x1D, 0x66, 0x00,
  0x1D, 0x6B, 0x49, 22, // function B, CODE128, length 22
  ...Buffer.from('{BRECB000022IW07UWZ6K8W', 'ascii').slice(0, 22),
  0x0A, 0x0A, 0x0A, 0x0A,
  0x1D, 0x56, 0x00,                                                // CUT
]);

console.log(`Sample size: ${sample.length} bytes\n`);

const parsed = parse(sample);
console.log('=== Parsed lines ===');
parsed.lines.slice(0, 30).forEach((l, i) => console.log(`  ${i.toString().padStart(2)} [${l.align[0]}${l.bold?'B':' '}${l.size.w}x${l.size.h}] "${l.text}"`));
console.log(`... ${parsed.lines.length} lines total`);
console.log(`\nBarcodes: ${JSON.stringify(parsed.barcodes)}`);
console.log(`Cuts: ${parsed.cuts}`);

console.log('\n=== Extracted receipt ===');
const r = extractReceipt(parsed);
console.log(JSON.stringify(r, null, 2));

// Sanity assertions
const checks = [
  ['venue',        r.venue === 'Snack Shack'],
  ['invoice',      r.invoice === 'T-8712-1 F2-00000002'],
  ['staff',        r.staff === 'John'],
  ['device',       r.device === 'Till7'],
  ['ticket',       r.ticket === 'A - 3'],
  ['items',        r.items.length === 1 && r.items[0].name.includes('AGUA')],
  ['subtotal',     r.subtotal === 1.6],
  ['total',        r.total === 1.6],
  ['discount pts', r.discounts.some(d => d.name === 'Customer Points' && d.amount === -1.22)],
  ['tender credit', r.tenders.some(t => t.name === 'Customer Credit' && t.amount === 0.38)],
  ['tender pts',   r.tenders.some(t => t.name === 'Customer Points' && t.amount === 1.22)],
  ['tax IVA',      r.taxes.some(t => t.name === 'IVA 10%' && t.percent === 10)],
];

console.log('\n=== Assertions ===');
let pass = 0, fail = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  ok ? pass++ : fail++;
}
console.log(`\n${pass}/${checks.length} passed`);
process.exit(fail === 0 ? 0 : 1);
