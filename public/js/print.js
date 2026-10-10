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

  // Every serial that belongs on one line of a receipt, from whichever shape
  // handed it over: the cart (`serialNumbers`), the sale item (`serial_no`),
  // or the register rows attached to the sale (`sale.serials`).
  function serialsForItem(item, sale) {
    const found = [];
    const push = (value) => {
      String(value || '').split(/,\s*/).forEach((part) => {
        const sn = part.trim();
        if (sn && !found.includes(sn)) found.push(sn);
      });
    };
    if (Array.isArray(item.serial_numbers)) item.serial_numbers.forEach(push);
    if (Array.isArray(item.serialNumbers)) item.serialNumbers.forEach(push);
    push(item.serial_no);
    for (const row of (sale && sale.serials) || []) {
      const sameItem = item.id && row.sale_item_id && String(row.sale_item_id) === String(item.id);
      const sameName = !item.id && row.product_name && (item.product_name || item.name) && row.product_name === (item.product_name || item.name);
      if (sameItem || sameName) push(row.serial_no);
    }
    return found;
  }

  function wrapCentre(text, width) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const w of words) {
      if (!cur) cur = w;
      else if ((cur.length + 1 + w.length) <= width) cur += ` ${w}`;
      else { lines.push(centre(cur, width)); cur = w; }
    }
    if (cur) lines.push(centre(cur, width));
    return lines.length ? lines : [centre('', width)];
  }

  // -------------------------------------------------------------------
  // SALE RECEIPT
  // -------------------------------------------------------------------
  // One shape, used by the thermal roll and by the on-screen slip: who sold
  // it, what left the shop, what was paid, and — only when a number was
  // actually captured — which unit it was. An empty serial line is not printed.
  function saleReceipt(sale, { brand = 'StockRidge', footer = null, paper = null } = {}) {
    const width = WIDTHS[paper || printerPrefs.paper] || 48;
    const L = [];
    L.push(centre(brand, width));
    if (sale.branch_name) L.push(centre(sale.branch_name, width));
    if (sale.branch_address) L.push(centre(sale.branch_address, width));
    if (sale.branch_phone) L.push(centre(sale.branch_phone, width));
    L.push(rule(width, '='));
    L.push(cols('Receipt', sale.receipt_no || '—', width));
    L.push(cols('Date', U.soldAt(sale.sold_at), width));
    if (sale.branch_code) L.push(cols('Branch', String(sale.branch_code), width));
    L.push(cols('Cashier', sale.cashier_name || sale.sold_by_name || '—', width));
    L.push(cols('Type', U.humanise(sale.sale_type || 'RETAIL'), width));
    L.push(cols('Customer', sale.customer_name || 'Walk-in', width));
    if (sale.customer_phone) L.push(cols('Phone', sale.customer_phone, width));
    L.push(rule(width));

    const items = sale.items || [];
    if (!items.length) L.push(centre('No items', width));
    for (const item of items) {
      const name = item.product_name || item.name || 'Item';
      L.push(name.length > width ? `${name.slice(0, width - 1)}…` : name);
      if (item.variant_name) L.push(`  ${item.variant_name}`);
      const qtyText = `${U.qty(item.quantity)} ${item.unit_code || item.base_unit_name || ''}`.trim();
      const unit = U.money(item.unit_price, { kobo: true }).replace('₦', '@');
      L.push(cols(`  ${qtyText} x ${unit}`, money(item.line_total), width));
      for (const sn of serialsForItem(item, sale)) {
        const line = `  S/N ${sn}`;
        L.push(line.length > width ? `${line.slice(0, width - 1)}…` : line);
      }
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
    L.push(...wrapCentre(U.amountInWords(sale.total), width));
    if ((sale.items || []).some((i) => Number(i.warranty_months))) {
      L.push(rule(width));
      L.push('WARRANTY');
      for (const item of sale.items) {
        const months = Number(item.warranty_months);
        if (!months) continue;
        // `U.isoDate`, never `U.soldDate`: the latter is a display string
        // ("05 Oct 2026"), and `new Date("05 Oct 2026T00:00:00Z")` is Invalid, whose
        // toISOString() throws — taking the whole receipt with it. A receipt for a
        // warrantied appliance therefore never printed at all.
        const soldIso = U.isoDate(sale.sold_at);
        let to = null;
        if (soldIso) {
          const from = new Date(`${soldIso}T00:00:00Z`);
          from.setUTCMonth(from.getUTCMonth() + months);
          if (Number.isFinite(from.getTime())) to = from.toISOString().slice(0, 10);
        }
        // An unreadable sale date prints the period rather than nothing: the
        // warranty still means something without a date beside it.
        L.push(cols(` ${(item.product_name || '').slice(0, width - 14)}`,
          to || `${months} month${months === 1 ? '' : 's'}`, width));
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
      const qtyText = `${U.qty(line.quantity)} ${line.unitCode || ''}`.trim();
      const lineTotal = line.expectedTotal != null ? line.expectedTotal : Number(line.unitPrice || 0) * Number(line.quantity || 0);
      L.push(cols(`  ${qtyText}`, money(lineTotal), width));
      for (const sn of serialsForItem(line, { serials: cart.serials })) {
        const row = `  S/N ${sn}`;
        L.push(row.length > width ? `${row.slice(0, width - 1)}…` : row);
      }
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

  function row(label, value, cls) {
    return SR.ui.h('div', { class: `slip-row${cls ? ' ' + cls : ''}` },
      SR.ui.h('span', {}, label),
      SR.ui.h('span', {}, value));
  }

  /** The receipt as a slip, not a wall of monospace. Print still uses the text. */
  function slipNode(sale, { brand = 'StockRidge', footer = null } = {}) {
    const h = SR.ui.h;
    const head = h('div', { class: 'slip-head' },
      h('div', { class: 'slip-brand' }, brand || 'StockRidge'),
      sale.branch_name ? h('div', { class: 'slip-sub' }, sale.branch_name) : null,
      sale.branch_address ? h('div', { class: 'slip-sub' }, sale.branch_address) : null,
      sale.branch_phone ? h('div', { class: 'slip-sub' }, sale.branch_phone) : null);
    const meta = h('div', { class: 'slip-meta' },
      row('Receipt', sale.receipt_no || '—'),
      row('Date', U.soldAt(sale.sold_at)),
      row('Cashier', sale.cashier_name || sale.sold_by_name || '—'),
      row('Customer', sale.customer_name || 'Walk-in'),
      sale.customer_phone ? row('Phone', sale.customer_phone) : null);
    const items = h('div', { class: 'slip-items' });
    for (const item of sale.items || []) {
      const block = h('div', { class: 'slip-item' });
      block.appendChild(h('div', { class: 'slip-item-name' }, item.product_name || item.name || 'Item'));
      if (item.variant_name) block.appendChild(h('div', { class: 'slip-sub' }, item.variant_name));
      const qtyText = `${U.qty(item.quantity)} ${item.unit_code || item.base_unit_name || ''}`.trim();
      block.appendChild(row(`${qtyText} × ${U.money(item.unit_price)}`, U.money(item.line_total)));
      const serials = serialsForItem(item, sale);
      if (serials.length) {
        block.appendChild(h('div', { class: 'slip-serial' }, serials.map((sn) => `S/N ${sn}`).join('  ·  ')));
      }
      items.appendChild(block);
    }
    const totals = h('div', { class: 'slip-totals' },
      row('Subtotal', U.money(sale.subtotal)));
    const discount = Number(sale.discount_amount) + Number(sale.order_discount_amount || 0);
    if (discount) totals.appendChild(row('Discount', `−${U.money(discount)}`));
    if (Number(sale.delivery_fee)) totals.appendChild(row('Delivery', U.money(sale.delivery_fee)));
    totals.appendChild(row('Total', U.money(sale.total), 'slip-total'));
    if (Number(sale.vat_amount)) totals.appendChild(row(`VAT included (${U.qty(sale.vat_rate_percent || 7.5, 2)}%)`, U.money(sale.vat_amount)));
    const pay = h('div', { class: 'slip-pay' });
    for (const pmt of sale.payments || []) {
      const ref = pmt.reference ? ` · ${pmt.reference}` : '';
      pay.appendChild(row(`${U.humanise(pmt.method)}${ref}`, U.money(pmt.amount)));
    }
    if (Number(sale.change_given)) pay.appendChild(row('Change', U.money(sale.change_given)));
    if (Number(sale.change_owed)) pay.appendChild(row('Change owed', U.money(sale.change_owed)));
    if (Number(sale.balance_due)) pay.appendChild(row('Balance due', U.money(sale.balance_due), 'slip-due'));
    const foot = h('div', { class: 'slip-foot' },
      h('div', { class: 'slip-words' }, U.amountInWords(sale.total)),
      h('div', {}, footer || 'Thank you for your custom.'));
    return h('div', { class: 'slip' }, head, h('hr', { class: 'slip-rule' }), meta, h('hr', { class: 'slip-rule' }), items, h('hr', { class: 'slip-rule' }), totals, h('hr', { class: 'slip-rule' }), pay, h('hr', { class: 'slip-rule' }), foot);
  }

  /**
   * The receipt the cashier shows the customer, and the text the printer gets.
   * One function so the counter and the sales screen cannot drift apart.
   */
  function previewSale(sale, { brand = 'StockRidge', footer = null, title = null, autoPrint = false } = {}) {
    const text = saleReceipt(sale, { brand, footer });
    const heading = title || `Receipt ${sale.receipt_no || ''}`.trim();
    const body = SR.ui.h('div', { class: 'stack' }, slipNode(sale, { brand, footer }));
    const actions = [
      SR.ui.h('button', { class: 'btn', onClick: () => SR.ui.copyToClipboard(text, 'Receipt copied — paste it into WhatsApp.') }, 'Copy'),
      SR.ui.h('button', { class: 'btn', onClick: () => U.download(`${heading.replace(/\s+/g, '-').toLowerCase()}.txt`, text, 'text/plain;charset=utf-8') }, 'Save'),
      SR.ui.h('button', { class: 'btn btn-primary', onClick: () => printText(text, { title: heading }) }, 'Print'),
    ];
    const modal = SR.ui.openModal({ title: heading, body, footer: actions, size: 'narrow' });
    if (autoPrint && prefs().autoPrint !== false) setTimeout(() => printText(text, { title: heading }), 350);
    return { modal, text };
  }

  SR.print = {
    WIDTHS, loadPrefs, savePrefs, prefs,
    saleReceipt, pendingReceipt, tillSheet, countSheet,
    printText, preview, previewSale, slipNode, printReport, testPage,
    centre, cols, rule, serialsForItem,
  };
}(window));
