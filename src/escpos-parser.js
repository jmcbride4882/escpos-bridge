/**
 * ESC/POS parser — bytes → structured lines with formatting state.
 *
 * Decoded against EposNow's actual receipt format (verified 2026-04-26):
 * uses Codepage 13 (CP858), basic ALIGN/BOLD/SIZE, ESC@ INIT, GS V CUT,
 * GS k CODE128 barcodes. We track state and emit one logical "line" per
 * LF — caller layer (receipt-extract / kp-extract) interprets meaning.
 *
 * Output:
 *   {
 *     lines: [{ text, align, bold, size, codepage }],
 *     barcodes: [{ format, data }],
 *     cuts: number,
 *     raw_b64: string  // for debugging / Hetzner archive
 *   }
 */

// CP858 → Unicode (the bits we care about). EposNow uses 0xD5 for €.
// ESC t 0x13 = page 19 = CP858 (Multilingual Latin + Euro).
const CP858_OVERRIDES = {
  0xD5: '€',
  0xA5: 'Ñ',
  0xA4: 'ñ',
  0xA1: 'í',
  0xA0: 'á',
  0xA2: 'ó',
  0xA3: 'ú',
  0x82: 'é',
  0x83: 'â',
  0xC7: 'ã',
  0x8A: 'è',
};
const CP858_PAGE = 19;  // ESC t n — n=19 selects CP858

function decodeByte(b, codepage) {
  if (b < 0x80) return String.fromCharCode(b);
  if (codepage === CP858_PAGE && CP858_OVERRIDES[b] != null) return CP858_OVERRIDES[b];
  // Fallback — Latin-1
  return String.fromCharCode(b);
}

export function parse(buffer) {
  const lines = [];
  const barcodes = [];
  let cuts = 0;
  let i = 0;
  let currentText = '';
  let state = {
    align:   'left',     // 'left' | 'center' | 'right'
    bold:    false,
    size:    { w: 1, h: 1 },
    codepage: 0,
  };

  const flushLine = () => {
    if (currentText.length || lines.length === 0) {
      lines.push({
        text: currentText,
        align: state.align,
        bold:  state.bold,
        size:  { ...state.size },
        codepage: state.codepage,
      });
    }
    currentText = '';
  };

  while (i < buffer.length) {
    const b = buffer[i];

    // ESC sequences (0x1B)
    if (b === 0x1B) {
      const cmd = buffer[i + 1];
      if (cmd === 0x40) {            // ESC @ — INIT
        state = { align: 'left', bold: false, size: { w: 1, h: 1 }, codepage: 0 };
        i += 2;
        continue;
      }
      if (cmd === 0x74) {            // ESC t n — CODEPAGE
        state.codepage = buffer[i + 2];
        i += 3;
        continue;
      }
      if (cmd === 0x61) {            // ESC a n — ALIGN
        const n = buffer[i + 2];
        state.align = n === 1 ? 'center' : n === 2 ? 'right' : 'left';
        i += 3;
        continue;
      }
      if (cmd === 0x45) {            // ESC E n — BOLD
        state.bold = buffer[i + 2] !== 0;
        i += 3;
        continue;
      }
      if (cmd === 0x21) {            // ESC ! n — print mode (font + emphasis + size)
        i += 3;                      // we ignore for now
        continue;
      }
      if (cmd === 0x64) {            // ESC d n — feed n lines
        const n = buffer[i + 2];
        for (let k = 0; k < n; k++) flushLine();
        i += 3;
        continue;
      }
      if (cmd === 0x4A) {            // ESC J n — feed n dots
        i += 3;
        continue;
      }
      // Unknown ESC — skip 2 bytes
      i += 2;
      continue;
    }

    // GS sequences (0x1D)
    if (b === 0x1D) {
      const cmd = buffer[i + 1];
      if (cmd === 0x21) {            // GS ! n — SIZE
        const n = buffer[i + 2];
        state.size = { w: ((n >> 4) & 0x0F) + 1, h: (n & 0x0F) + 1 };
        i += 3;
        continue;
      }
      if (cmd === 0x56) {            // GS V n [m] — CUT
        cuts++;
        const n = buffer[i + 2];
        i += (n >= 0x41 && n <= 0x42) ? 4 : 3;
        continue;
      }
      if (cmd === 0x68) { i += 3; continue; }   // GS h n — barcode height
      if (cmd === 0x77) { i += 3; continue; }   // GS w n — barcode width
      if (cmd === 0x48) { i += 3; continue; }   // GS H n — HRI position
      if (cmd === 0x66) { i += 3; continue; }   // GS f n — HRI font
      if (cmd === 0x6B) {                       // GS k m d1...dk NUL  OR  GS k m n d1...dn
        const m = buffer[i + 2];
        if (m >= 65) {                          // function B: m, n, then n bytes
          const n = buffer[i + 3];
          const data = buffer.slice(i + 4, i + 4 + n);
          barcodes.push({ format: barcodeFormat(m), data: data.toString('utf8') });
          i += 4 + n;
        } else {                                // function A: m, then NUL-terminated
          let end = i + 3;
          while (end < buffer.length && buffer[end] !== 0x00) end++;
          const data = buffer.slice(i + 3, end);
          barcodes.push({ format: barcodeFormat(m), data: data.toString('utf8') });
          i = end + 1;
        }
        continue;
      }
      // Unknown GS — skip 2 bytes
      i += 2;
      continue;
    }

    // Regular bytes
    if (b === 0x0A) {                // LF
      flushLine();
      i++;
      continue;
    }
    if (b === 0x0D) {                // CR — ignore
      i++;
      continue;
    }
    if (b === 0x00) {                // NUL — ignore (spurious)
      i++;
      continue;
    }
    currentText += decodeByte(b, state.codepage);
    i++;
  }

  if (currentText.length) flushLine();

  return {
    lines,
    barcodes,
    cuts,
    raw_b64: buffer.toString('base64'),
  };
}

function barcodeFormat(m) {
  // Common ESC/POS barcode m values. Function A (0-6), Function B (65-79).
  switch (m) {
    case 0: case 65: return 'UPC-A';
    case 1: case 66: return 'UPC-E';
    case 2: case 67: return 'EAN13';
    case 3: case 68: return 'EAN8';
    case 4: case 69: return 'CODE39';
    case 5: case 70: return 'ITF';
    case 6: case 71: return 'CODABAR';
    case 72: return 'CODE93';
    case 73: return 'CODE128';
    default: return `unknown(${m})`;
  }
}
