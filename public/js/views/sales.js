// =====================================================================
// public/js/views/sales.js — sales history, one sale, and voiding
// =====================================================================
'use strict';

import { endpoints as api } from '../api.js';
import { state, activeBusiness, atLeast, can } from '../state.js';
import { el, clear, icon, badge, toneForStatus, table, money, spinner, reportError, toast, modal, promptReason, confirmDialog, emptyState } from '../ui.js';
import { openPrintWindow } from './pos.js';

export default async function salesView(ctx) {
  const host = ctx.host;
  const today = new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 10);
  const from = ctx.query.from || new Date(Date.parse(`${today}T00:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10);
  const to = ctx.query.to || today;

  if (ctx.query.id) { renderOne(host, ctx.query.id, ctx); return {}; }

  host.appendChild(el('header', { class: 'view-head' },
    el('div', {}, el('h1', { text: 'Sales' }),
      el('p', { class: 'muted', text: 'Dates are West Africa Time. A sale at 00:30 in Lagos counts on the Lagos day it was made.' })),
    el('div', { class: 'view-actions' }, el('a', { class: 'btn btn-primary', href: '/pos', text: 'New sale' }))));

  const filter = el('form', { class: 'filter-bar', onsubmit: (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target).entries());
    ctx.navigate(`/sales?from=${encodeURIComponent(f.from)}&to=${encodeURIComponent(f.to)}${f.status ? `&status=${encodeURIComponent(f.status)}` : ''}${f.q ? `&q=${encodeURIComponent(f.q)}` : ''}`);
  } },
  el('label', {}, 'From', el('input', { type: 'date', name: 'from', value: from, max: '366' })),
  el('label', {}, 'To', el('input', { type: 'date', name: 'to', value: to })),
  el('label', {}, 'Status', el('select', { name: 'status' },
    el('option', { value: '', text: 'Any' }),
    ...['COMPLETED', 'PART_PAID', 'VOIDED', 'REFUNDED', 'QUOTE'].map((s) => el('option', { value: s, text: s.replace(/_/g, ' '), selected: ctx.query.status === s })))),
  el('button', { class: 'btn btn-primary', type: 'submit' }, 'Apply'));
  host.appendChild(filter);

  const body = el('div', {}, spinner('Loading sales…'));
  host.appendChild(body);

  try {
    const res = await api.sales({ from, to: undefined, start_date: from, end_date: to, status: ctx.query.status, limit: 100 });
    clear(body);
    const t = res.totals || {};
    body.appendChild(el('div', { class: 'stat-grid stat-grid-sm' },
      el('div', { class: 'stat' }, el('span', { class: 'stat-label', text: 'Sales' }), el('strong', { class: 'stat-value', text: String(t.count || 0) })),
      el('div', { class: 'stat' }, el('span', { class: 'stat-label', text: 'Revenue' }), el('strong', { class: 'stat-value', text: money(t.total) })),
      el('div', { class: 'stat' }, el('span', { class: 'stat-label', text: 'VAT collected' }), el('strong', { class: 'stat-value', text: money(t.vat) })),
      el('div', { class: 'stat' }, el('span', { class: 'stat-label', text: 'Margin' }), el('strong', { class: 'stat-value', text: money(t.margin) })),
      el('div', { class: 'stat' }, el('span', { class: 'stat-label', text: 'Still owed' }), el('strong', { class: 'stat-value text-warn', text: money(t.balance_due) })),
    ));
    body.appendChild(table([
      { key: 'sale_number', label: 'Invoice' },
      { key: 'sale_date', label: 'Date', render: (r) => `${r.sale_date} ${String(r.sale_time || '').slice(0, 5)}` },
      { key: 'branch_name', label: 'Branch' },
      { key: 'customer_name', label: 'Customer', render: (r) => r.customer_name || el('span', { class: 'muted', text: 'walk-in' }) },
      { key: 'sale_type', label: 'Type', render: (r) => badge(r.sale_type.toLowerCase(), 'neutral') },
      { key: 'total', label: 'Total', align: 'right', render: (r) => money(r.total) },
      { key: 'balance_kobo', label: 'Owed', align: 'right', render: (r) => Number(r.balance_kobo) > 0 ? el('strong', { class: 'text-warn', text: money(r.balance_kobo / 100) }) : '—' },
      { key: 'sold_by_name', label: 'Sold by' },
      { key: 'status', label: 'Status', render: (r) => badge(String(r.status).toLowerCase(), toneForStatus(r.status)) },
    ], res.rows || [], {
      dense: true, rowKey: 'id',
      empty: `No sales between ${from} and ${to}.`,
      onRow: (r) => ctx.navigate(`/sales?id=${encodeURIComponent(r.id)}`),
    }));
  } catch (e) {
    clear(body);
    body.appendChild(emptyState('Sales could not be loaded', e.message || String(e), 'Try again', () => ctx.rerender()));
  }
  return {};
}

async function renderOne(host, id, ctx) {
  host.appendChild(spinner('Loading the sale…'));
  let sale;
  try { sale = await api.sale(id); } catch (e) {
    clear(host);
    host.appendChild(emptyState('That sale could not be found', e.message || String(e), 'Back to sales', () => ctx.navigate('/sales')));
    return;
  }
  clear(host);

  host.appendChild(el('header', { class: 'view-head' },
    el('div', {},
      el('h1', {}, sale.sale_number, ' ', badge(String(sale.status).toLowerCase(), toneForStatus(sale.status))),
      el('p', { class: 'muted', text: `${sale.branch ? sale.branch.name : ''} · ${sale.sale_date} ${String(sale.sale_time || '').slice(0, 5)} WAT · ${sale.sale_type}` })),
    el('div', { class: 'view-actions' },
      el('button', { class: 'btn btn-ghost', onclick: () => ctx.navigate('/sales') }, '← Back'),
      el('button', { class: 'btn btn-ghost', onclick: async () => { try { openPrintWindow(await api.receipt(id)); } catch (e2) { reportError(e2); } } }, 'Print receipt'),
      !sale.voided_at && Number(sale.balance_kobo) === 0 && can.voidSale()
        ? el('button', { class: 'btn btn-danger', onclick: () => voidIt(sale, ctx) }, 'Void sale')
        : null)));

  if (sale.voided_at) {
    host.appendChild(el('div', { class: 'warn-box' },
      el('strong', { text: 'This sale was voided. ' }),
      `${String(sale.voided_at).slice(0, 16)} · reason: ${sale.void_reason || 'not given'}. Stock was returned to the shelf and the ledger entry was reversed — not deleted, so the history stays complete.`));
  }

  host.appendChild(el('div', { class: 'two-col' },
    el('section', { class: 'card' },
      el('h2', { class: 'card-title', text: 'Lines' }),
      table([
        { key: 'product_name', label: 'Product', render: (r) => el('div', {}, el('strong', { text: r.product_name }), r.serial_numbers ? el('div', { class: 'muted small', text: `SN: ${r.serial_numbers}` }) : null) },
        { key: 'quantity', label: 'Qty', align: 'right', render: (r) => `${r.quantity}${r.unit_type !== 'BASE_UNIT' ? ` ${r.unit_type.toLowerCase()}` : ''}` },
        { key: 'base_quantity', label: 'Base units', align: 'right' },
        { key: 'line_gross', label: 'Gross', align: 'right', render: (r) => money(r.line_gross) },
        { key: 'discount_total', label: 'Discount', align: 'right', render: (r) => Number(r.discount_total) > 0 ? `−${money(r.discount_total)}` : '—' },
        { key: 'line_vat', label: 'VAT', align: 'right', render: (r) => Number(r.line_vat) > 0 ? money(r.line_vat) : el('span', { class: 'muted', text: 'exempt' }) },
        { key: 'line_total', label: 'Net', align: 'right', render: (r) => el('strong', { text: money(r.line_total) }) },
        { key: 'line_margin', label: 'Margin', align: 'right', render: (r) => atLeast('MANAGER') ? money(r.line_margin) : '—' },
        { key: 'pricing_trail', label: 'Why this price', render: (r) => el('button', { class: 'btn btn-sm btn-ghost', onclick: () => showTrail(r) }, r.pricing_trail && r.pricing_trail.length ? `${r.pricing_trail.length} rule(s)` : '—') },
      ], sale.items || [], { dense: true })),

    el('section', { class: 'card' },
      el('h2', { class: 'card-title', text: 'Money' }),
      moneyRows(sale),
      el('h2', { class: 'card-title', text: 'Payments' }),
      sale.payments && sale.payments.length
        ? table([
          { key: 'method', label: 'Method', render: (r) => badge(String(r.method).replace(/_/g, ' ').toLowerCase(), 'neutral') },
          { key: 'amount', label: 'Amount', align: 'right', render: (r) => money(r.amount) },
          { key: 'reference', label: 'Reference' },
          { key: 'fee', label: 'Fee', align: 'right', render: (r) => Number(r.fee) > 0 ? money(r.fee) : '—' },
          { key: 'expected_settlement_date', label: 'Settles', render: (r) => r.expected_settlement_date || '—' },
        ], sale.payments, { dense: true })
        : el('p', { class: 'muted', text: 'No payments recorded.' }),
      Number(sale.balance_kobo) > 0
        ? el('div', { class: 'warn-box' }, el('strong', { text: `${money(sale.balance_kobo / 100)} still outstanding.` }),
          ` Terms ${sale.credit_terms_code || '—'}${sale.due_date ? `, due ${sale.due_date}` : ''}. It is on the customer's statement and ages with it.`)
        : null,
      sale.register_entries && sale.register_entries.length
        ? el('div', {},
          el('h2', { class: 'card-title', text: 'Register entries' }),
          el('p', { class: 'hint', text: 'Hash-chained and append-only. These rows cannot be edited or deleted; altering one breaks every link after it, which the verify action detects.' }),
          table([
            { key: 'product_name', label: 'Item' },
            { key: 'buyer_name', label: 'Buyer' },
            { key: 'buyer_phone', label: 'Phone' },
            { key: 'id_type', label: 'ID', render: (r) => r.id_type ? `${r.id_type} ${r.id_number || ''}` : '—' },
            { key: 'serial_numbers', label: 'Serials' },
            { key: 'seq', label: 'Chain #', align: 'right' },
          ], sale.register_entries, { dense: true }))
        : null,
    )));
}

function moneyRows(sale) {
  const rows = [
    ['Subtotal', sale.subtotal],
    ['Discount', -Number(sale.discount_total)],
    ['Taxable', sale.taxable_kobo != null ? sale.taxable_kobo / 100 : null],
    ['VAT-exempt', sale.exempt_kobo != null ? sale.exempt_kobo / 100 : null],
    [`VAT @ ${sale.vat_rate_percent}% (included)`, sale.vat_amount],
    ['TOTAL', sale.total],
    ['Paid', sale.paid],
    ['Change given', sale.change_given],
  ];
  if (atLeast('MANAGER')) {
    rows.push(['Cost of goods', sale.cost_total], ['Margin', sale.margin_total],
      ['Margin %', sale.total > 0 ? `${((sale.margin_total / (sale.total - sale.vat_amount)) * 100).toFixed(2)}%` : '—']);
  }
  return el('dl', { class: 'money-rows' }, rows.filter((r) => r[1] != null).map((r) => el('div', { class: r[0] === 'TOTAL' ? 'money-total' : '' },
    el('dt', { text: r[0] }),
    el('dd', { text: typeof r[1] === 'string' ? r[1] : money(r[1]) }))));
}

function showTrail(item) {
  const trail = item.pricing_trail || [];
  modal({
    title: `Why this price — ${item.product_name}`,
    size: 'sm',
    body: trail.length
      ? el('div', {},
        el('p', { class: 'modal-message', text: 'Each layer that applied, in the fixed order the system resolves them.' }),
        el('ol', { class: 'trail' }, trail.map((t) => el('li', {},
          el('strong', { text: t.label || t.layer }),
          t.amount != null ? el('span', { class: 'trail-amount', text: money(t.amount) }) : null,
          t.note ? el('span', { class: 'muted trail-note', text: ` — ${t.note}` }) : null))),
        item.discount_reason ? el('p', { class: 'hint', text: `Discount reason: ${item.discount_reason}${item.discount_approved_by ? ' (manager-approved)' : ''}` }) : null)
      : el('p', { class: 'muted', text: 'No pricing trail was recorded on this line.' }),
    footer: el('div', { class: 'row-end' }, el('button', { class: 'btn btn-primary', onclick: (ev) => { ev.target.closest('.modal-host').hidden = true; } }, 'Close')),
  });
}

async function voidIt(sale, ctx) {
  // A void is the single most abusable action a cashier has: sell for cash, void
  // the sale, keep the note. The books then show no sale and the stock is already
  // gone. So the reason is mandatory, the window is enforced server-side, and the
  // action is written to the audit log with WARNING severity regardless of who
  // did it.
  const reason = await promptReason({
    title: `Void ${sale.sale_number}`,
    message: `This reverses ${money(sale.total)}, returns the stock to the shelf, and reverses the ledger entry. The reason is recorded against your login and appears in the void report.`,
    label: 'Why is this sale being voided?',
    confirmLabel: 'Void the sale',
    danger: true,
  });
  if (!reason) return;
  try {
    const res = await api.voidSale(sale.id, reason);
    toast(`${sale.sale_number} voided. Stock returned to the shelf and the ledger entry reversed.`, { kind: 'warn', duration: 7000 });
    ctx.rerender();
  } catch (e) {
    // The refusal message is the server's and it says what to do: wait for a
    // manager, or use a return instead.
    reportError(e, { context: 'The sale could not be voided' });
  }
}
