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

  function itemGroup(item) {
    if (item.selling_group && item.selling_group_label) {
      return { code: item.selling_group, label: item.selling_group_label };
    }
    return U.sellingGroup({
      code: item.category_code || item.categoryCode,
      name: item.category_name || item.categoryName,
    });
  }

  function groupItems(items) {
    const order = U.sellingGroups().map((g) => g.code);
    const buckets = new Map();
    for (const item of items || []) {
      const group = itemGroup(item);
      const prev = buckets.get(group.code) || { code: group.code, label: group.label, items: [], total: 0 };
      prev.items.push(item);
      prev.total = U.round2(prev.total + Number(item.line_total != null ? item.line_total : (Number(item.quantity) || 0) * (Number(item.unit_price) || 0)));
      buckets.set(group.code, prev);
    }
    return [...buckets.values()].sort((a, b) => {
      const ai = order.indexOf(a.code);
      const bi = order.indexOf(b.code);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.label.localeCompare(b.label);
    });
  }

  function itemTrace(item) {
    const bits = [];
    const cat = item.category_name || item.categoryName;
    if (cat) bits.push(cat);
    if (item.batch_no || item.batchNo) bits.push(`batch ${item.batch_no || item.batchNo}`);
    if (item.expiry_date || item.expiryDate) bits.push(`exp ${String(item.expiry_date || item.expiryDate).slice(0, 10)}`);
    if (item.registration_no || item.registrationNo) bits.push(`NAFDAC ${item.registration_no || item.registrationNo}`);
    return bits;
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
    if (sale.pcn_license_no) L.push(centre(`PCN ${sale.pcn_license_no}`, width));
    if (sale.nafdac_premises_no) L.push(centre(`NAFDAC premises ${sale.nafdac_premises_no}`, width));
    L.push(rule(width, '='));
    L.push(cols('Receipt', sale.receipt_no || '—', width));
    L.push(cols('Date', U.soldAt(sale.sold_at), width));
    if (sale.branch_code) L.push(cols('Branch', String(sale.branch_code), width));
    L.push(cols('Cashier', sale.cashier_name || sale.sold_by_name || '—', width));
    L.push(cols('Type', U.humanise(sale.sale_type || 'RETAIL'), width));
    L.push(cols('Customer', sale.customer_name || 'Walk-in', width));
    if (sale.customer_phone) L.push(cols('Phone', sale.customer_phone, width));
    L.push(rule(width));

    const groups = groupItems(sale.items || []);
    if (!groups.length) L.push(centre('No items', width));
    const split = groups.length > 1;
    for (const group of groups) {
      if (split) {
        L.push(centre(group.label.toUpperCase(), width));
      }
      for (const item of group.items) {
        const name = item.product_name || item.name || 'Item';
        L.push(name.length > width ? `${name.slice(0, width - 1)}…` : name);
        if (item.variant_name || item.variantName) L.push(`  ${item.variant_name || item.variantName}`);
        const qtyText = `${U.qty(item.quantity)} ${item.unit_code || item.unitCode || item.base_unit_name || ''}`.trim();
        const unit = U.money(item.unit_price != null ? item.unit_price : item.unitPrice, { kobo: true }).replace('₦', '@');
        const lineTotal = item.line_total != null ? item.line_total : (Number(item.quantity) || 0) * (Number(item.unit_price != null ? item.unit_price : item.unitPrice) || 0);
        L.push(cols(`  ${qtyText} x ${unit}`, money(lineTotal), width));
        const trace = itemTrace(item).join(' · ');
        if (trace) L.push(trace.length > width ? `  ${trace.slice(0, width - 3)}…` : `  ${trace}`);
        for (const sn of serialsForItem(item, sale)) {
          const line = `  S/N ${sn}`;
          L.push(line.length > width ? `${line.slice(0, width - 1)}…` : line);
        }
        if (Number(item.line_discount || item.lineDiscount)) L.push(cols('  less discount', `-${money(item.line_discount || item.lineDiscount)}`, width));
      }
      if (split) L.push(cols(`  ${group.label} total`, money(group.total), width));
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
    if (sale.claim_code) {
      L.push(centre('COLLECTION CODE', width));
      L.push(centre(String(sale.claim_code), width));
      L.push(centre('Quote this code to collect the change.', width));
      if (sale.claim_expires_at) L.push(centre(`Collect by ${sale.claim_expires_at}`, width));
    }
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
    const scripts = sale.prescriptions || [];
    if (scripts.length) {
      L.push(rule(width));
      L.push('PRESCRIPTION RECORD');
      for (const p of scripts) {
        L.push(` Rx ${p.prescriber_name || '—'}${p.patient_name ? ` · ${p.patient_name}` : ''}`);
      }
    }
    const controlled = sale.controlled_entries || sale.controlledRegister || [];
    if (controlled.length) {
      L.push(rule(width));
      L.push('CONTROLLED SUBSTANCE');
      for (const e of controlled) {
        L.push(` ${e.product_name || 'Medicine'} x${U.qty(e.quantity_dispensed || e.quantity || 1)} · ${e.buyer_name || ''}`);
      }
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
    if (Number(cart.change_owed_amount || cart.changeOwedAmount)) {
      L.push(cols('Change owed', money(cart.change_owed_amount || cart.changeOwedAmount), width));
    }
    if (cart.claim_code || cart.claimCode) {
      const code = cart.claim_code || cart.claimCode;
      L.push(centre('COLLECTION CODE', width));
      L.push(centre(String(code), width));
      L.push(centre('Quote this code to collect the change.', width));
    }
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
    L.push(cols('Opened', U.watClock(till.opened_at), width));
    L.push(cols('Closed', till.closed_at ? U.watClock(till.closed_at) : 'OPEN', width));
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
    L.push(centre(`Printed ${U.watClock(U.nowIso())}`, width));
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
  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  /**
   * Print only the slip, in its own document.
   *
   * Printing the till page left the receipt at the top-left of an A4 sheet and
   * a second page of leftover markup, because the receipt was absolutely
   * positioned over a document that was still as tall as the app. A short
   * receipt is one page, fitted to the paper, and nothing else is in the job.
   */
  function printText(text, { title = 'StockRidge', copies = null, paper = null } = {}) {
    const kind = String(paper || printerPrefs.paper || '80');
    const pageRule = kind === '58'
      ? 'size: 58mm auto; margin: 3mm;'
      : kind === 'a4'
        ? 'size: A4; margin: 12mm;'
        : 'margin: 10mm;';
    const n = Math.max(1, Number(copies || printerPrefs.copies || 1));
    const blocks = [];
    for (let i = 0; i < n; i += 1) {
      blocks.push(`<pre class="slip${i === n - 1 ? ' last' : ''}">${escapeHtml(text)}</pre>`);
    }
    let frame = document.getElementById('print-frame');
    if (!frame) {
      frame = document.createElement('iframe');
      frame.id = 'print-frame';
      frame.setAttribute('aria-hidden', 'true');
      frame.title = 'Receipt print';
      document.body.appendChild(frame);
    }
    const stray = document.getElementById('print-area');
    if (stray) stray.remove();
    const doc = frame.contentDocument || frame.contentWindow.document;
    doc.open();
    doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
      @page { ${pageRule} }
      html, body { margin: 0; padding: 0; background: #fff; color: #111; height: auto; width: 100%; }
      body { width: 100%; }
      pre.slip {
        box-sizing: border-box;
        display: block;
        width: 100%;
        max-width: 100%;
        margin: 0 auto;
        padding: 0;
        font-family: ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace;
        font-size: 16pt;
        line-height: 1.35;
        white-space: pre-wrap;
        word-break: break-word;
        page-break-after: always;
        page-break-inside: auto;
      }
      pre.slip.last { page-break-after: auto; }
    </style></head><body>${blocks.join('')}</body></html>`);
    doc.close();
    const win = frame.contentWindow;
    setTimeout(() => {
      try { win.focus(); win.print(); } catch (e) { /* the till stays usable if the dialog is blocked */ }
    }, 80);
  }

  /** Open a preview modal with a Print button — the path a cashier actually
   *  uses, because it lets them see the ₦ sign survived before it reaches paper. */
  function cancelBesidePrint(onCancel, onPrint) {
    return SR.ui.h('div', { class: 'receipt-pair' },
      SR.ui.h('button', { class: 'btn', onClick: onCancel }, 'Cancel'),
      SR.ui.h('button', { class: 'btn btn-primary', onClick: onPrint }, 'Print'));
  }

  function markReceipt(modal) {
    if (modal && modal.dialog) modal.dialog.classList.add('receipt-sheet');
    const root = document.getElementById('modal-root');
    if (root) root.classList.add('is-receipt');
  }

  function preview(text, { title = 'Receipt', filename = null, onPrint = null } = {}) {
    const body = SR.ui.h('div', {});
    body.appendChild(SR.ui.h('div', { class: 'receipt', id: 'receipt-preview' }, text));
    const actions = [
      SR.ui.h('button', { class: 'btn', onClick: () => SR.ui.copyToClipboard(text, 'Receipt text copied — paste it into WhatsApp.') }, 'Copy text'),
    ];
    if (filename) {
      actions.push(SR.ui.h('button', { class: 'btn', onClick: () => U.download(filename, text, 'text/plain;charset=utf-8') }, 'Save .txt'));
    }
    let opened;
    actions.push(cancelBesidePrint(
      () => { if (opened) opened.close(); },
      () => { if (onPrint) onPrint(); printText(text, { title }); },
    ));
    opened = SR.ui.openModal({
      title, body, footer: actions, size: 'narrow',
      onClose: () => {
        const root = document.getElementById('modal-root');
        if (root) root.classList.remove('is-receipt');
      },
    });
    markReceipt(opened);
    return opened;
  }

  /** Print a full A4 report: a heading, a filter line and a table. */
  function printReport({ title, subtitle = null, columns, rows, foot = null, paper = 'a4', filename = null }) {
    const width = WIDTHS[paper] || 96;
    const L = [];
    L.push(centre(title, width));
    if (subtitle) L.push(centre(subtitle, width));
    L.push(centre(`Printed ${U.watClock(U.nowIso())}`, width));
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
    L.push(centre(U.watClock(U.nowIso()), width));
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
      sale.branch_phone ? h('div', { class: 'slip-sub' }, sale.branch_phone) : null,
      sale.pcn_license_no ? h('div', { class: 'slip-sub' }, `PCN ${sale.pcn_license_no}`) : null,
      sale.nafdac_premises_no ? h('div', { class: 'slip-sub' }, `NAFDAC premises ${sale.nafdac_premises_no}`) : null);
    const meta = h('div', { class: 'slip-meta' },
      row('Receipt', sale.receipt_no || '—'),
      row('Date', U.soldAt(sale.sold_at)),
      row('Cashier', sale.cashier_name || sale.sold_by_name || '—'),
      row('Type', U.humanise(sale.sale_type || 'RETAIL')),
      row('Customer', sale.customer_name || 'Walk-in'),
      sale.customer_phone ? row('Phone', sale.customer_phone) : null);
    const items = h('div', { class: 'slip-items' });
    const groups = groupItems(sale.items || []);
    const split = groups.length > 1;
    for (const group of groups) {
      const section = h('div', { class: 'slip-group' });
      if (split) section.appendChild(h('div', { class: 'slip-group-name' }, group.label));
      for (const item of group.items) {
        const block = h('div', { class: 'slip-item' });
        block.appendChild(h('div', { class: 'slip-item-name' }, item.product_name || item.name || 'Item'));
        if (item.variant_name || item.variantName) block.appendChild(h('div', { class: 'slip-sub' }, item.variant_name || item.variantName));
        const qtyText = `${U.qty(item.quantity)} ${item.unit_code || item.unitCode || item.base_unit_name || ''}`.trim();
        const unitPrice = item.unit_price != null ? item.unit_price : item.unitPrice;
        const lineTotal = item.line_total != null ? item.line_total : (Number(item.quantity) || 0) * (Number(unitPrice) || 0);
        block.appendChild(row(`${qtyText} × ${U.money(unitPrice)}`, U.money(lineTotal)));
        const trace = itemTrace(item);
        if (trace.length) block.appendChild(h('div', { class: 'slip-sub' }, trace.join(' · ')));
        const serials = serialsForItem(item, sale);
        if (serials.length) block.appendChild(h('div', { class: 'slip-serial' }, serials.map((sn) => `S/N ${sn}`).join('  ·  ')));
        section.appendChild(block);
      }
      if (split) section.appendChild(row(`${group.label} total`, U.money(group.total), 'slip-group-total'));
      items.appendChild(section);
    }
    const scripts = sale.prescriptions || [];
    if (scripts.length) {
      items.appendChild(h('div', { class: 'slip-group' },
        h('div', { class: 'slip-group-name' }, 'Prescription record'),
        ...scripts.map((p) => h('div', { class: 'slip-sub' }, `Rx ${p.prescriber_name || '—'}${p.patient_name ? ` · ${p.patient_name}` : ''}`))));
    }
    const controlled = sale.controlled_entries || sale.controlledRegister || [];
    if (controlled.length) {
      items.appendChild(h('div', { class: 'slip-group' },
        h('div', { class: 'slip-group-name' }, 'Controlled substance'),
        ...controlled.map((e) => h('div', { class: 'slip-sub' }, `${e.product_name || 'Medicine'} × ${U.qty(e.quantity_dispensed || e.quantity || 1)} · ${e.buyer_name || ''}`))));
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
    if (sale.claim_code) {
      pay.appendChild(h('div', { class: 'slip-claim' },
        h('div', { class: 'slip-sub' }, 'Collection code'),
        h('div', { class: 'slip-claim-code' }, String(sale.claim_code)),
        h('div', { class: 'slip-sub' }, 'Quote this code to collect the change.'),
        sale.claim_expires_at ? h('div', { class: 'slip-sub' }, `Collect by ${sale.claim_expires_at}`) : null));
    }
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
  function previewSale(sale, { brand = 'StockRidge', footer = null, title = null, autoPrint = false, banner = null } = {}) {
    const text = saleReceipt(sale, { brand, footer });
    const heading = title || `Receipt ${sale.receipt_no || ''}`.trim();
    const body = SR.ui.h('div', { class: 'stack' });
    if (banner) body.appendChild(SR.ui.h('div', { class: 'alert alert-warn' }, banner));
    body.appendChild(slipNode(sale, { brand, footer }));
    const actions = [
      SR.ui.h('button', { class: 'btn', onClick: () => SR.ui.copyToClipboard(text, 'Receipt copied — paste it into WhatsApp.') }, 'Copy'),
      SR.ui.h('button', { class: 'btn', onClick: () => U.download(`${heading.replace(/\s+/g, '-').toLowerCase()}.txt`, text, 'text/plain;charset=utf-8') }, 'Save'),
      cancelBesidePrint(() => { if (modal) modal.close(); }, () => printSlip(sale, { brand, footer, title: heading })),
    ];
    let modal;
    modal = SR.ui.openModal({
      title: heading,
      body,
      footer: actions,
      size: 'narrow',
      onClose: () => {
        const root = document.getElementById('modal-root');
        if (root) root.classList.remove('is-receipt');
      },
    });
    if (modal && modal.dialog) modal.dialog.classList.add('receipt-sheet');
    const root = document.getElementById('modal-root');
    if (root) root.classList.add('is-receipt');
    if (autoPrint && prefs().autoPrint !== false) setTimeout(() => printSlip(sale, { brand, footer, title: heading }), 350);
    return { modal, text };
  }

  /** The slip, fitted to the paper, with none of the till around it. */
  function printSlip(sale, { brand = 'StockRidge', footer = null, title = 'Receipt' } = {}) {
    const node = slipNode(sale, { brand, footer });
    const holder = document.createElement('div');
    holder.appendChild(node);
    writeFrame(holder.innerHTML, title, SLIP_PRINT_CSS);
  }

  const SLIP_PRINT_CSS = `
    @page { margin: 10mm; }
    html, body { margin: 0; padding: 0; width: 100%; height: auto; background: #fff; color: #111; }
    .slip { width: 100%; max-width: none; margin: 0; background: #fff; color: #111; border: 0; border-radius: 0; box-shadow: none; padding: 0; }
    .slip-head, .slip-foot { text-align: center; }
    .slip-brand { font-weight: 750; font-size: 18pt; }
    .slip-sub { color: #444; font-size: 10pt; margin-top: 2px; }
    .slip-rule { border: 0; border-top: 1px dashed #999; margin: 8px 0; }
    .slip-row { display: flex; justify-content: space-between; gap: 12px; font-size: 12pt; padding: 2px 0; }
    .slip-row span:last-child { text-align: right; }
    .slip-item { padding: 6px 0; }
    .slip-item + .slip-item { border-top: 1px solid #eee; }
    .slip-item-name { font-weight: 700; font-size: 12pt; }
    .slip-serial { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 10pt; }
    .slip-total { font-size: 16pt; font-weight: 750; }
    .slip-group-name { font-size: 9pt; font-weight: 750; letter-spacing: 0.08em; text-transform: uppercase; margin-top: 8px; }
    .slip-claim { text-align: center; margin-top: 8px; padding: 8px 0; border-top: 1px dashed #999; }
    .slip-claim-code { font-size: 18pt; font-weight: 800; letter-spacing: 0.12em; }
    .slip-foot { font-size: 10pt; }
  `;

  function writeFrame(bodyHtml, title, css) {
    let frame = document.getElementById('print-frame');
    if (!frame) {
      frame = document.createElement('iframe');
      frame.id = 'print-frame';
      frame.setAttribute('aria-hidden', 'true');
      frame.title = 'Receipt print';
      document.body.appendChild(frame);
    }
    const stray = document.getElementById('print-area');
    if (stray) stray.remove();
    const doc = frame.contentDocument || frame.contentWindow.document;
    doc.open();
    doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${css}</style></head><body>${bodyHtml}</body></html>`);
    doc.close();
    const win = frame.contentWindow;
    setTimeout(() => {
      try { win.focus(); win.print(); } catch (e) { /* the till stays usable if the dialog is blocked */ }
    }, 80);
  }

  SR.print = {
    WIDTHS, loadPrefs, savePrefs, prefs,
    saleReceipt, pendingReceipt, tillSheet, countSheet,
    printText, preview, previewSale, slipNode, printReport, testPage,
    centre, cols, rule, serialsForItem,
  };
}(window));
