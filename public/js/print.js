'use strict';
// =====================================================================
// public/js/print.js — RECEIPTS, SHELF LABELS AND TILL SHEETS
// =====================================================================
// Printing in a Nigerian shop means one of two things: a 58/80 mm thermal roll
// at the counter, or an A4 sheet in the back office. Both are served by the same
// approach — build the text, put it in a hidden `#print-area`, and let the
// browser's own print dialog handle the paper. No PDF library, no print server,
// and it works with the machine already plugged in.
//
// The document it produces is deliberately text-only, in a monospace face, at a
// size that survives a thermal head that has seen two years of harmattan dust.
// =====================================================================
(function (global) {
  const SR = global.SR = global.SR || {};
  const U = SR.util;

  const WIDTHS = { '58': 32, '80': 48, 'a4': 96 }; // characters per line

  let printerPrefs = { paper: '80', copies: 1, showLogo: true, showFooter: true };

  async function loadPrefs() {
    try {
      const stored = await SR.store.metaGet('printer', null);
      if (stored) printerPrefs = Object.assign(printerPrefs, stored);
    } catch (e) { /* defaults are fine */ }
    return printerPrefs;
  }
  async function savePrefs(patch) {
    printerPrefs = Object.assign(printerPrefs, patch);
    await SR.store.metaSet('printer', printerPrefs).catch(() => {});
    return printerPrefs;
  }
  function prefs() { return printerPrefs; }

  const centre = (text, width) => {
    const s = String(text || '');
    if (s.length >= width) return s.slice(0, width);
    const pad = Math.floor((width - s.length) / 2);
    return ' '.repeat(pad) + s;
  };
  const rule = (width, char = '-') => char.repeat(width);
  const cols = (left, right, width) => {
    const l = String(left || ''); const r = String(right || '');
    if (l.length + r.length + 1 > width) {
      // Long names wrap onto their own line rather than pushing the amount off
      // the roll — an amount that has been cut off is an amount in dispute.
      return `${l}\n${' '.repeat(Math.max(0, width - r.length))}${r}`;
    }
    return l + ' '.repeat(width - l.length - r.length) + r;
  };
  const money = (v) => U.money(v, { kobo: true }).replace('₦', 'N');

  // -------------------------------------------------------------------
  // SALE RECEIPT
  // -------------------------------------------------------------------
  function saleReceipt(sale, { brand = 'StockRidge', footer = null, paper = null } = {}) {
    const width = WIDTHS[paper || printerPrefs.paper] || 48;
    const L = [];
    L.push(centre(brand, width));
    if (sale.branch_name) L.push(centre(sale.branch_name, width));
    if (sale.branch_address) L.push(centre(sale.branch_address, width));
    if (sale.branch_phone) L.push(centre(sale.branch_phone, width));
    L.push(rule(width));
    L.push(cols(`Receipt ${sale.receipt_no || ''}`, U.soldAt(sale.sold_at).slice(0, 10), width));
    L.push(cols(U.soldAt(sale.sold_at).slice(11), String(sale.branch_code || ''), width));
    L.push(cols(`Cashier: ${sale.cashier_name || sale.sold_by_name || '—'}`, String(sale.sale_type || 'RETAIL'), width));
    if (sale.customer_name) L.push(`Customer: ${sale.customer_name}`);
    if (sale.customer_phone) L.push(`Phone   : ${sale.customer_phone}`);
    L.push(rule(width));

    for (const item of sale.items || []) {
      const name = item.product_name || item.name || 'Item';
      L.push(name.length > width ? `${name.slice(0, width - 1)}…` : name);
      if (item.serial_no) L.push(`  S/N ${item.serial_no}`);
      if (item.variant_name) L.push(`  ${item.variant_name}`);
      const qtyText = `${U.qty(item.quantity)} ${item.unit_code || item.base_unit_name || ''}`.trim();
      const unit = U.money(item.unit_price, { kobo: true }).replace('₦', '@');
      L.push(cols(`  ${qtyText} ${unit}`, money(item.line_total), width));
      if (Number(item.line_discount)) L.push(cols('  less discount', `-${money(item.line_discount)}`, width));
    }

    L.push(rule(width));
    L.push(cols('Subtotal', money(sale.subtotal), width));
    if (Number(sale.discount_amount) + Number(sale.order_discount_amount || 0)) {
      L.push(cols('Discount', `-${money(Number(sale.discount_amount) + Number(sale.order_discount_amount || 0))}`, width));
    }
    if (Number(sale.delivery_fee)) L.push(cols('Delivery', money(sale.delivery_fee), width));
    L.push(cols('TOTAL', money(sale.total), width));
    if (Number(sale.vat_amount)) {
      L.push(cols(`  incl. VAT (${U.qty(sale.vat_rate_percent || 7.5, 2)}%)`, money(sale.vat_amount), width));
    }
    L.push(rule(width));

    for (const p of sale.payments || []) {
      const label = U.humanise(p.method);
      const ref = p.reference ? ` (${String(p.reference).slice(0, 12)})` : '';
      L.push(cols(`${label}${ref}`, money(p.amount), width));
    }
    if (Number(sale.change_given)) L.push(cols('Change', money(sale.change_given), width));
    if (Number(sale.change_owed)) L.push(cols('Change owed', money(sale.change_owed), width));
    if (Number(sale.balance_due)) {
      L.push(rule(width));
      L.push(cols('BALANCE DUE', money(sale.balance_due), width));
    }
    L.push(rule(width));
    L.push(centre(U.amountInWords(sale.total), width));
    if ((sale.items || []).some((i) => Number(i.warranty_months))) {
      L.push(rule(width));
      L.push('WARRANTY');
      for (const item of sale.items) {
        if (!Number(item.warranty_months)) continue;
        const from = new Date(`${U.soldDate(sale.sold_at)}T00:00:00Z`);
        from.setUTCMonth(from.getUTCMonth() + Number(item.warranty_months));
        L.push(cols(` ${(item.product_name || '').slice(0, width - 14)}`, from.toISOString().slice(0, 10), width));
      }
      L.push(' Keep this receipt. A claim without it cannot be verified.');
    }
    L.push(rule(width));
    L.push(centre(footer || 'Thank you for your custom.', width));
    L.push(centre('Powered by StockRidge', width));
    L.push('');
    L.push('');
    return L.join('\n');
  }

  /** The receipt for a sale that is still queued on this device. */
  function pendingReceipt(record, { brand = 'StockRidge', paper = null } = {}) {
    const width = WIDTHS[paper || printerPrefs.paper] || 48;
    const cart = record.payload || {};
    const L = [];
    L.push(centre(brand, width));
    L.push(centre('*** OFFLINE SALE ***', width));
    L.push(rule(width));
    L.push(cols('Local ref', String(record.client_id).slice(-12), width));
    L.push(cols('Recorded', U.soldAt(record.occurred_at), width));
    L.push(cols('Device', record.device_id || '—', width));
    L.push(rule(width));
    for (const line of cart.lines || []) {
      const name = line.name || line.product_name || line.product_id || 'Item';
      L.push(name.length > width ? `${name.slice(0, width - 1)}…` : name);
      L.push(cols(`  ${U.qty(line.quantity)} ${line.unitCode || ''}`, money(line.expectedTotal != null ? line.expectedTotal : line.unitPrice * line.quantity), width));
    }
    L.push(rule(width));
    L.push(cols('TOTAL', money(cart.expectedTotal), width));
    for (const p of cart.payments || []) L.push(cols(`  ${U.humanise(p.method)}`, money(p.amount), width));
    L.push(rule(width));
    L.push(centre('Not yet sent to the office.', width));
    L.push(centre('It will sync automatically.', width));
    L.push(centre(`Quote ${String(record.client_id).slice(-8)} in any query.`, width));
    L.push('');
    return L.join('\n');
  }

  /** A till shift sheet: what the drawer should hold, and what to count. */
  function tillSheet(till, { brand = 'StockRidge', paper = null } = {}) {
    const width = WIDTHS[paper || printerPrefs.paper] || 48;
    const L = [];
    L.push(centre(brand, width));
    L.push(centre('TILL SHEET', width));
    L.push(rule(width));
    L.push(cols('Branch', till.branch_name || '—', width));
    L.push(cols('Cashier', till.cashier_name || till.opened_by_name || '—', width));
    L.push(cols('Opened', U.dateTime(till.opened_at), width));
    L.push(cols('Closed', till.closed_at ? U.dateTime(till.closed_at) : 'OPEN', width));
    L.push(rule(width));
    L.push(cols('Opening float', money(till.opening_cash), width));
    L.push(cols('Cash sales', money(till.cash_sales_total), width));
    L.push(cols('Safe in / (out)', money(till.safe_in_total - till.safe_out_total), width));
    L.push(rule(width));
    L.push(cols('EXPECTED CASH', money(till.expected_cash), width));
    L.push(cols('COUNTED', money(till.counted_cash), width));
    L.push(cols('VARIANCE', money(till.variance), width));
    L.push(rule(width));
    L.push(cols('Sales', String(till.sale_count), width));
    L.push(cols('Voids', String(till.void_count), width));
    L.push(cols('Grand total', money(till.grand_total), width));
    L.push(rule(width));
    L.push('Signature: ______________________');
    L.push('');
    L.push('');
    return L.join('\n');
  }

  /** A stocktake count sheet, grouped by category, with blank count columns. */
  function countSheet(lines, { title = 'STOCKTAKE', branch = '', paper = 'a4' } = {}) {
    const width = WIDTHS[paper] || 96;
    const L = [];
    L.push(centre(title, width));
    if (branch) L.push(centre(branch, width));
    L.push(centre(`Printed ${U.dateTime(U.nowIso())}`, width));
    L.push(rule(width, '='));
    L.push(cols('PRODUCT', 'SYSTEM /  COUNT /  VARIANCE', width));
    L.push(rule(width));
    let lastCategory = null;
    for (const line of lines) {
      if (line.category_name && line.category_name !== lastCategory) {
        lastCategory = line.category_name;
        L.push('');
        L.push(`[${lastCategory}]`);
      }
      L.push(String(line.product_name || '').slice(0, width));
      L.push(cols(`  ${line.sku || ''} ${line.unit_code || ''}`, `${U.qty(line.system_qty)}  ____  ______`, width));
    }
    L.push(rule(width, '='));
    L.push('');
    L.push('Counted by: ______________________   Checked by: ______________________');
    L.push('');
    return L.join('\n');
  }

  // -------------------------------------------------------------------
  // THE PRINT ITSELF
  // -------------------------------------------------------------------
  function printText(text, { title = 'StockRidge', copies = null } = {}) {
    let area = document.getElementById('print-area');
    if (!area) {
      area = document.createElement('div');
      area.id = 'print-area';
      document.body.appendChild(area);
    }
    const n = Math.max(1, Number(copies || printerPrefs.copies || 1));
    area.innerHTML = '';
    for (let i = 0; i < n; i += 1) {
      const pre = document.createElement('pre');
      pre.style.cssText = 'font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.35; margin: 0 0 18px; white-space: pre-wrap; word-break: break-word;';
      pre.textContent = text;
      area.appendChild(pre);
    }
    const prevTitle = document.title;
    document.title = title;
    // A short delay lets the layout settle; printing synchronously after a
    // replaceChildren can capture an empty page on slower machines.
    setTimeout(() => {
      global.print();
      document.title = prevTitle;
    }, 60);
  }

  /** Open a preview modal with a Print button — the path a cashier actually
   *  uses, because it lets them see the ₦ sign survived before it reaches paper. */
  function preview(text, { title = 'Receipt', filename = null, onPrint = null } = {}) {
    const body = SR.ui.h('div', {});
    body.appendChild(SR.ui.h('div', { class: 'receipt', id: 'receipt-preview' }, text));
    const actions = [
      SR.ui.h('button', { class: 'btn', onClick: () => SR.ui.copyToClipboard(text, 'Receipt text copied — paste it into WhatsApp.') }, 'Copy text'),
    ];
    if (filename) {
      actions.push(SR.ui.h('button', { class: 'btn', onClick: () => U.download(filename, text, 'text/plain;charset=utf-8') }, 'Save .txt'));
    }
    actions.push(SR.ui.h('button', { class: 'btn btn-primary', onClick: () => { if (onPrint) onPrint(); printText(text, { title }); } }, 'Print'));
    return SR.ui.openModal({ title, body, footer: actions, size: 'narrow' });
  }

  /** Print a full A4 report: a heading, a filter line and a table. */
  function printReport({ title, subtitle = null, columns, rows, foot = null, paper = 'a4', filename = null }) {
    const width = WIDTHS[paper] || 96;
    const L = [];
    L.push(centre(title, width));
    if (subtitle) L.push(centre(subtitle, width));
    L.push(centre(`Printed ${U.dateTime(U.nowIso())}`, width));
    L.push(rule(width, '='));
    // Column widths are proportional to the longest value in each column, with a
    // floor so a heading is never truncated to a single character.
    const cell = (r, c) => {
      const v = c.value ? c.value(r) : r[c.key];
      return v === null || v === undefined ? '' : String(v);
    };
    const widths = columns.map((c) => Math.max(
      String(c.label || '').length,
      Math.min(30, Math.max(...rows.map((r) => cell(r, c).length), 3)),
    ));
    const totalWidth = widths.reduce((a, b) => a + b + 2, 0);
    if (totalWidth > width) {
      const scale = (width - columns.length * 2) / widths.reduce((a, b) => a + b, 0);
      for (let i = 0; i < widths.length; i += 1) widths[i] = Math.max(4, Math.floor(widths[i] * scale));
    }
    const header = columns.map((c, i) => String(c.label || '').slice(0, widths[i]).padEnd(widths[i])).join('  ');
    L.push(header);
    L.push(rule(width));
    for (const r of rows) {
      L.push(columns.map((c, i) => cell(r, c).slice(0, widths[i]).padEnd(widths[i])).join('  '));
    }
    if (foot) {
      L.push(rule(width));
      L.push(columns.map((c, i) => String(foot[i] === undefined || foot[i] === null ? '' : foot[i]).slice(0, widths[i]).padEnd(widths[i])).join('  '));
    }
    L.push('');
    L.push(`${rows.length} row(s).`);
    const text = L.join('\n');
    if (filename) U.download(filename, text, 'text/plain;charset=utf-8');
    printText(text, { title });
    return text;
  }

  /** Something for a new install to prove the printer works. */
  function testPage({ brand = 'StockRidge' } = {}) {
    const width = WIDTHS[printerPrefs.paper] || 48;
    const L = [];
    L.push(centre(brand, width));
    L.push(centre('PRINTER TEST', width));
    L.push(rule(width));
    L.push(cols('Naira sign', U.money(45000)));
    L.push(cols('With kobo', U.money(12345.67, { kobo: true })));
    L.push(cols('Large figure', U.money(12500000)));
    L.push(rule(width));
    L.push('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    L.push('abcdefghijklmnopqrstuvwxyz');
    L.push('0123456789  , . - / # @ ( )');
    L.push(rule(width));
    L.push(centre('If every line above is', width));
    L.push(centre('readable, the printer is set.', width));
    L.push(centre(U.dateTime(U.nowIso()), width));
    L.push('');
    L.push('');
    return L.join('\n');
  }

  SR.print = {
    WIDTHS, loadPrefs, savePrefs, prefs,
    saleReceipt, pendingReceipt, tillSheet, countSheet,
    printText, preview, printReport, testPage,
    centre, cols, rule,
  };
}(window));
