'use strict';
// =====================================================================
// public/js/barcode-label.js — BARCODES AND SHELF LABELS, DRAWN LOCALLY
// =====================================================================
// Two symbologies, because between them they cover everything a Nigerian
// appliance, furniture or building-materials shop actually needs:
//
//   EAN-13   — for anything that will be scanned at a POS in another shop. The
//              check digit is computed from the first twelve digits, so a
//              mistyped product code cannot print a barcode that scans as a
//              DIFFERENT product.
//   CODE 128 — for internal shelf and bin labels, and for stocktake tags. Any
//              ASCII string, compact, and every mid-range thermal printer and
//              phone camera handles it.
//
// Both are emitted as SVG. Not canvas: an SVG label stays crisp at any DPI, prints
// correctly on a 203 dpi thermal head AND a 1200 dpi laser, and can be dropped
// straight into a print sheet without a rasterisation step.
// =====================================================================
(function (global) {
  const SR = global.SR = global.SR || {};

  // -------------------------------------------------------------------
  // EAN-13
  // -------------------------------------------------------------------
  // The standard L/G/R code sets. An EAN-13 digit is seven modules wide and the
  // pattern depends on which set it is drawn from; the FIRST digit is not drawn
  // at all — it is encoded by the CHOICE of L or G for positions 2–7, which is
  // why a 13-digit number fits in 95 modules.
  const L_CODES = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  const G_CODES = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
  const R_CODES = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
  const PARITY = [
    'LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG',
    'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL',
  ];

  function eanCheckDigit(twelve) {
    const digits = String(twelve).replace(/\D/g, '');
    if (digits.length !== 12) return null;
    let sum = 0;
    for (let i = 0; i < 12; i += 1) {
      sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 3);
    }
    return (10 - (sum % 10)) % 10;
  }

  function eanComplete(twelve) {
    const d = eanCheckDigit(twelve);
    return d === null ? null : `${twelve}${d}`;
  }

  /** Does this look like a valid 13-digit barcode? Advisory — nothing blocks on it. */
  function eanValid(code) {
    const s = String(code || '').replace(/\D/g, '');
    if (s.length !== 13) return false;
    return Number(s[12]) === eanCheckDigit(s.slice(0, 12));
  }

  function eanModules(code) {
    const s = String(code || '').replace(/\D/g, '');
    if (s.length !== 13) return null;
    const parity = PARITY[Number(s[0])];
    let bits = '101'; // start guard
    for (let i = 0; i < 6; i += 1) {
      const digit = Number(s[i + 1]);
      bits += parity[i] === 'L' ? L_CODES[digit] : G_CODES[digit];
    }
    bits += '01010'; // centre guard
    for (let i = 0; i < 6; i += 1) bits += R_CODES[Number(s[i + 7])];
    bits += '101'; // end guard
    return bits;
  }

  // -------------------------------------------------------------------
  // CODE 128 (subset B, with subset C for long digit runs)
  // -------------------------------------------------------------------
  const C128 = [
    '11011001100', '11001101100', '11001100110', '10010011000', '10010001100', '10001001100', '10011001000', '10011000100', '10001100100', '11001001000',
    '11001000100', '11000100100', '10110011100', '10011011100', '10011001110', '10111001100', '10011101100', '10011100110', '11001110010', '11001011100',
    '11001001110', '11011100100', '11001110100', '11101101110', '11101001100', '11100101100', '11100100110', '11101100100', '11100110100', '11100110010',
    '11011011000', '11011000110', '11000110110', '10100011000', '10001011000', '10001000110', '10110001000', '10001101000', '10001100010', '11010001000',
    '11000101000', '11000100010', '10110111000', '10110001110', '10001101110', '10111011000', '10111000110', '10001110110', '11101110110', '11010001110',
    '11000101110', '11011101000', '11011100010', '11011101110', '11101011000', '11101000110', '11100010110', '11101101000', '11101100010', '11100011010',
    '11101111010', '11001000010', '11110001010', '10100110000', '10100001100', '10010110000', '10010000110', '10000101100', '10000100110', '10110010000',
    '10110000100', '10011010000', '10011000010', '10000110100', '10000110010', '11000010010', '11001010000', '11110111010', '11000010100', '10001111010',
    '10100111100', '10010111100', '10010011110', '10111100100', '10011110100', '10011110010', '11110100100', '11110010100', '11110010010', '11011011110',
    '11011110110', '11110110110', '10101111000', '10100011110', '10001011110', '10111101000', '10111100010', '11110101000', '11110100010', '10111011110',
    '10111101110', '11101011110', '11110101110', '11010000100', '11010010000', '11010011100', '11000111010',
  ];
  const C128_START_B = 104;
  const C128_START_C = 105;
  const C128_CODE_B = 100;
  const C128_STOP = 106;

  /** Code 128-B for arbitrary text; switches to subset C for runs of 4+ digits so
   *  a long barcode number does not become absurdly wide. */
  function code128(text) {
    const s = String(text == null ? '' : text);
    if (!s) return null;
    const codes = [];
    let i = 0;
    // Decide the opening subset.
    const leadingDigits = (/^\d+/.exec(s) || [''])[0].length;
    let mode = leadingDigits >= 4 && leadingDigits % 2 === 0 ? 'C' : 'B';
    codes.push(mode === 'C' ? C128_START_C : C128_START_B);

    while (i < s.length) {
      const run = (/^\d+/.exec(s.slice(i)) || [''])[0].length;
      if (mode === 'B' && run >= 4) {
        // A leading odd digit is carried through B, then the rest goes to C.
        let start = i;
        if (run % 2 === 1) {
          codes.push(s.charCodeAt(start) - 32);
          start += 1;
        }
        mode = 'C';
        codes.push(C128_CODE_B);
        i = start;
        continue;
      }
      if (mode === 'C') {
        if (run >= 2) {
          codes.push(Number(s.slice(i, i + 2)));
          i += 2;
          continue;
        }
        mode = 'B';
        codes.push(C128_CODE_B + 1 - 1 + 0); // Code B switch is value 100 placed below
        codes[codes.length - 1] = C128_CODE_B;
        continue;
      }
      // Subset B: printable ASCII 32..126 maps to value charCode - 32.
      const ch = s.charCodeAt(i);
      if (ch < 32 || ch > 126) {
        // Refuse rather than print a label that scans as something else.
        return null;
      }
      codes.push(ch - 32);
      i += 1;
    }

    // Modulo-103 checksum, weighted by position from the start code.
    let sum = codes[0];
    for (let k = 1; k < codes.length; k += 1) sum += codes[k] * k;
    codes.push(sum % 103);
    codes.push(C128_STOP);

    return codes.map((c) => C128[c]).join('');
  }

  // -------------------------------------------------------------------
  // SVG
  // -------------------------------------------------------------------
  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function bitsToSvg(bits, { height = 60, moduleWidth = 2, quiet = 12, showText = null, barHeight = null } = {}) {
    const w = bits.length * moduleWidth + quiet * 2;
    const textHeight = showText ? 18 : 0;
    const h = height + textHeight + 6;
    const bh = barHeight || height;
    // Runs of 1s become rectangles, so a 95-module EAN is ~30 rects rather than
    // 95 — it prints faster and the SVG file stays small enough to inline.
    const rects = [];
    let i = 0;
    while (i < bits.length) {
      if (bits[i] !== '1') { i += 1; continue; }
      let j = i;
      while (j < bits.length && bits[j] === '1') j += 1;
      rects.push(`<rect x="${quiet + i * moduleWidth}" y="0" width="${(j - i) * moduleWidth}" height="${bh}"/>`);
      i = j;
    }
    const text = showText
      ? `<text x="${w / 2}" y="${bh + 15}" text-anchor="middle" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="13" letter-spacing="1.5" fill="#111">${esc(showText)}</text>`
      : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Barcode ${esc(showText || '')}"><rect width="${w}" height="${h}" fill="#fff"/><g fill="#111">${rects.join('')}</g>${text}</svg>`;
  }

  /** EAN-13 as SVG. Returns null when the code is not a valid 13-digit EAN. */
  function ean13Svg(code, opts = {}) {
    const modules = eanModules(code);
    if (!modules) return null;
    return bitsToSvg(modules, Object.assign({ moduleWidth: 2, height: 62, quiet: 12 }, opts, { showText: opts.showText === undefined ? String(code) : opts.showText }));
  }

  /** Code 128 as SVG. Returns null for text the symbology cannot carry. */
  function code128Svg(text, opts = {}) {
    const bits = code128(text);
    if (!bits) return null;
    return bitsToSvg(bits, Object.assign({ moduleWidth: 1.6, height: 56, quiet: 10 }, opts, { showText: opts.showText === undefined ? String(text) : opts.showText }));
  }

  /** The right symbology for the string, or null if neither can carry it. */
  function autoSvg(text, opts = {}) {
    const s = String(text == null ? '' : text);
    if (/^\d{13}$/.test(s) && eanValid(s)) return ean13Svg(s, opts);
    return code128Svg(s, opts);
  }

  // -------------------------------------------------------------------
  // LABELS
  // -------------------------------------------------------------------
  /**
   * Click-and-print shelf labels.
   *
   * A furniture shop needs these more than it needs barcodes: the label is a
   * PRICE TAG first and a barcode second, because the customer reads it across
   * the showroom floor and the cashier scans it at the till. So the name and
   * price are set large, and the barcode sits underneath.
   */
  function labelHtml(item, { width = '58mm', height = '40mm', currency = true } = {}) {
    const U = SR.util;
    const code = item.barcode || item.barcode_number || item.sku || item.serial_no || null;
    const svg = code ? autoSvg(code, { height: 42, moduleWidth: 1.5 }) : null;
    const price = currency ? U.money(item.price) : U.amount(item.price);
    return `<div class="shelf-label" style="width:${width};min-height:${height}">
  <div class="sl-name">${esc(String(item.name || '').slice(0, 58))}</div>
  ${item.spec ? `<div class="sl-spec">${esc(String(item.spec).slice(0, 46))}</div>` : ''}
  <div class="sl-price">${esc(price)}</div>
  ${item.unit ? `<div class="sl-unit">per ${esc(item.unit)}</div>` : ''}
  ${svg ? `<div class="sl-code">${svg}</div>` : ''}
  ${item.sku ? `<div class="sl-sku">${esc(item.sku)}</div>` : ''}
</div>`;
  }

  /**
   * A sheet of labels for printing on A4 sticker paper. 24 per page (3 x 8),
   * which is the standard sheet sold in Computer Village and Balogun market.
   */
  function labelSheet(items, { title = 'StockRidge labels', perRow = 3, width = '58mm', height = '37mm' } = {}) {
    const rows = [];
    for (let i = 0; i < items.length; i += perRow) rows.push(items.slice(i, i + perRow));
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: A4; margin: 8mm; }
  body { font-family: -apple-system, "Segoe UI", Arial, sans-serif; margin: 0; }
  .sheet { display: flex; flex-wrap: wrap; gap: 2mm; }
  .shelf-label { border: 1px dashed #bbb; padding: 2mm; box-sizing: border-box; display: flex; flex-direction: column; justify-content: space-between; overflow: hidden; page-break-inside: avoid; }
  .sl-name { font-size: 9pt; font-weight: 700; line-height: 1.15; }
  .sl-spec { font-size: 7pt; color: #444; }
  .sl-price { font-size: 15pt; font-weight: 800; letter-spacing: -.02em; margin-top: 1mm; }
  .sl-unit { font-size: 7pt; color: #555; margin-bottom: 1mm; }
  .sl-code svg { width: 100%; height: auto; }
  .sl-sku { font-family: ui-monospace, monospace; font-size: 6.5pt; color: #666; }
  @media print { .shelf-label { border-color: #eee; } }
</style></head><body><div class="sheet">
${items.map((i) => labelHtml(i, { width, height })).join('\n')}
</div></body></html>`;
  }

  /** Open the label sheet in a new window ready to print. */
  function printLabels(items, opts = {}) {
    const markup = labelSheet(items, opts);
    const win = global.open('', '_blank');
    if (!win) {
      SR.ui.warn('The browser blocked the print window. Allow pop-ups for StockRidge and try again.');
      return null;
    }
    win.document.write(markup);
    win.document.close();
    win.focus();
    setTimeout(() => { try { win.print(); } catch (e) { /* the user can print from the window */ } }, 400);
    return win;
  }

  /** A modal preview of one label, so a counter assistant can check the price
   *  before printing forty of them. */
  function previewLabel(item) {
    const body = SR.ui.h('div', {});
    body.appendChild(SR.ui.h('div', {
      html: `<style>
        .shelf-label { border: 1px solid var(--line-strong); border-radius: 8px; padding: 12px; background: #fff; color: #111; max-width: 260px; }
        .shelf-label .sl-name { font-weight: 700; font-size: .95rem; }
        .shelf-label .sl-spec { font-size: .74rem; color: #555; }
        .shelf-label .sl-price { font-size: 1.6rem; font-weight: 800; margin-top: 6px; }
        .shelf-label .sl-unit { font-size: .72rem; color: #666; }
        .shelf-label .sl-sku { font-family: var(--mono); font-size: .68rem; color: #777; }
        .shelf-label .sl-code svg { width: 100%; height: auto; }
      </style>${labelHtml(item)}`,
    }));
    return SR.ui.openModal({
      title: 'Shelf label',
      body,
      size: 'narrow',
      footer: [
        SR.ui.h('button', { class: 'btn', onClick: () => SR.ui.copyToClipboard(String(item.barcode || item.sku || ''), 'Code copied.') }, 'Copy code'),
        SR.ui.h('button', { class: 'btn btn-primary', onClick: () => printLabels([item]) }, 'Print this label'),
      ],
    });
  }

  SR.barcode = {
    eanCheckDigit, eanComplete, eanValid, eanModules, ean13Svg,
    code128, code128Svg, autoSvg,
    labelHtml, labelSheet, printLabels, previewLabel,
  };
}(window));
