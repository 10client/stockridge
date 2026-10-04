// =====================================================================
// public/js/views/stock.js — what is on the shelf, and what to do about it
// =====================================================================
// Two questions a stock screen has to answer, in this order:
//   1. what can I sell RIGHT NOW?  (sellable, not on-hand — a reserved unit is
//      on the shelf and already spoken for)
//   2. what do I need to buy?      (reorder advice from velocity, not just a
//      reorder level somebody set once and forgot)

'use strict';

import { endpoints as api } from '../api.js';
import { state, activeBusiness, activeBranch, branchesOfActiveBusiness, atLeast, can } from '../state.js';
import { el, clear, icon, badge, toneForStatus, table, money, spinner, reportError, toast, modal, field, readForm, emptyState } from '../ui.js';
import { cachedFetch, newIdempotencyKey } from '../offline.js';

export default async function stockView(ctx) {
  const host = ctx.host;
  const business = activeBusiness();
  const tab = ctx.query.tab || 'onhand';

  host.appendChild(el('header', { class: 'view-head' },
    el('div', {}, el('h1', { text: 'Stock' }),
      el('p', { class: 'muted', text: `${business ? business.name : ''} · figures are SELLABLE (on hand less reserved), which is what the till can actually sell` })),
    el('div', { class: 'view-actions' },
      el('a', { class: 'btn btn-primary', href: '#', onclick: (ev) => { ev.preventDefault(); receiveDialog(ctx); } }, icon('plus'), ' Receive stock'))));

  const tabs = el('nav', { class: 'tabs' },
    tabLink('onhand', 'On hand', tab),
    tabLink('alerts', 'Alerts', tab),
    tabLink('movements', 'Movements', tab),
    tabLink('batches', 'Batches & serials', tab));
  host.appendChild(tabs);

  const body = el('div', { id: 'stock-body' }, spinner('Loading stock…'));
  host.appendChild(body);

  function tabLink(key, label, current) {
    return el('a', {
      href: `/stock?tab=${key}`, class: `tab${current === key ? ' active' : ''}`,
      onclick: (ev) => { ev.preventDefault(); ctx.navigate(`/stock?tab=${key}`); },
    }, label);
  }

  try {
    if (tab === 'onhand') await renderOnHand(body, ctx);
    else if (tab === 'alerts') await renderAlerts(body, ctx);
    else if (tab === 'movements') await renderMovements(body, ctx);
    else await renderBatches(body, ctx);
  } catch (e) {
    clear(body);
    body.appendChild(emptyState('Could not load stock', e.message || String(e), 'Try again', () => ctx.rerender()));
  }
  return {};
}

async function renderOnHand(body, ctx) {
  const res = await cachedFetch(`stock:${state.activeBusinessId}:${state.activeBranchId}`,
    () => api.stock({ branch_id: state.scope.pinned ? undefined : ctx.query.branch_id }));
  const rows = res.data || [];
  clear(body);
  if (res.stale) body.appendChild(el('div', { class: 'stale-banner' }, icon('warn'), el('span', { text: `Offline — stock as at ${new Date(res.cached_at).toLocaleString('en-NG')}.` })));

  const filter = ctx.query.filter;
  let list = rows;
  if (filter === 'low') list = rows.filter((r) => ['OUT_OF_STOCK', 'CRITICAL', 'LOW'].includes(r.urgency));
  const totalCost = list.reduce((a, r) => a + Number(r.cost_value || 0), 0);
  const totalRetail = list.reduce((a, r) => a + Number(r.retail_value || 0), 0);

  body.appendChild(el('div', { class: 'stat-grid stat-grid-sm' },
    el('div', { class: 'stat' }, el('span', { class: 'stat-label', text: 'Lines' }), el('strong', { class: 'stat-value', text: String(list.length) })),
    el('div', { class: 'stat' }, el('span', { class: 'stat-label', text: 'Value at cost' }), el('strong', { class: 'stat-value', text: money(totalCost) })),
    el('div', { class: 'stat' }, el('span', { class: 'stat-label', text: 'Value at retail' }), el('strong', { class: 'stat-value', text: money(totalRetail) })),
    el('div', { class: 'stat' }, el('span', { class: 'stat-label', text: 'Potential margin' }), el('strong', { class: 'stat-value', text: money(totalRetail - totalCost) })),
  ));

  body.appendChild(table([
    { key: 'product_name', label: 'Product', render: (r) => el('div', {}, el('strong', { text: r.product_name }), el('div', { class: 'muted small', text: [r.sku, r.category_name].filter(Boolean).join(' · ') })) },
    { key: 'branch_name', label: 'Branch' },
    { key: 'quantity_on_hand', label: 'On hand', align: 'right' },
    { key: 'quantity_reserved', label: 'Reserved', align: 'right', render: (r) => Number(r.quantity_reserved) > 0 ? badge(r.quantity_reserved, 'warn') : '—' },
    { key: 'sellable', label: 'Sellable', align: 'right', render: (r) => el('strong', { class: Number(r.sellable) <= 0 ? 'text-bad' : '', text: String(r.sellable) }) },
    { key: 'reorder_level', label: 'Reorder at', align: 'right' },
    { key: 'cost_value', label: 'At cost', align: 'right', render: (r) => money(r.cost_value) },
    { key: 'urgency', label: 'Status', render: (r) => badge(r.urgency.replace(/_/g, ' ').toLowerCase(), toneForStatus(r.urgency)) },
  ], list, {
    dense: true, rowKey: 'product_id', empty: 'No stock recorded yet. Receive some, or run the opening-balances import.',
    onRow: (r) => ctx.navigate(`/stock?tab=batches&product=${r.product_id}`),
  }));
}

async function renderAlerts(body, ctx) {
  const res = await api.stockAlerts({ branch_id: state.scope.pinned ? undefined : ctx.query.branch_id });
  clear(body);

  const section = (title, rows, columns, note) => el('section', { class: 'card' },
    el('h2', { class: 'card-title' }, title, el('span', { class: 'badge badge-neutral', text: String(rows.length) })),
    note ? el('p', { class: 'hint', text: note }) : null,
    rows.length ? table(columns, rows, { dense: true }) : el('p', { class: 'muted', text: 'None right now.' }));

  body.appendChild(section('Low or out of stock', res.low_stock, [
    { key: 'product_name', label: 'Product' },
    { key: 'branch_name', label: 'Branch' },
    { key: 'sellable', label: 'Sellable', align: 'right' },
    { key: 'reorder_level', label: 'Reorder at', align: 'right' },
    { key: 'reorder_quantity', label: 'Suggested order', align: 'right' },
    { key: 'urgency', label: 'Urgency', render: (r) => badge(r.urgency.replace(/_/g, ' '), toneForStatus(r.urgency)) },
  ], 'A reorder level alone cannot be right for two branches that sell at different speeds. The suggested quantity here is the client\'s own reorder level; the reorder advice endpoint also weighs observed velocity against supplier lead time.'));

  body.appendChild(section('Shelf life / best before', res.shelf_life, [
    { key: 'product_name', label: 'Product' },
    { key: 'branch_name', label: 'Branch' },
    { key: 'batch_no', label: 'Batch' },
    { key: 'best_before_date', label: 'Best before' },
    { key: 'days_remaining', label: 'Days left', align: 'right', render: (r) => el('strong', { class: r.days_remaining < 0 ? 'text-bad' : r.days_remaining <= 7 ? 'text-warn' : '', text: String(r.days_remaining) }) },
    { key: 'quantity_on_hand', label: 'Units', align: 'right' },
    { key: 'retail_value', label: 'At risk', align: 'right', render: (r) => money(r.retail_value) },
    { key: 'recommended_action', label: 'Suggested', render: (r) => badge(String(r.recommended_action).replace(/_/g, ' ').toLowerCase(), toneForStatus(r.band)) },
  ], 'Expired stock is a write-off decision, not a silent one: writing it off records the loss in the shrinkage account where an owner can see it.'));

  body.appendChild(section('Compliance certificates', res.compliance, [
    { key: 'certificate_type', label: 'Certificate' },
    { key: 'certificate_number', label: 'Number' },
    { key: 'business_name', label: 'Business' },
    { key: 'branch_name', label: 'Branch', render: (r) => r.branch_name || 'all' },
    { key: 'expiry_date', label: 'Expires' },
    { key: 'days_until_expiry', label: 'Days', align: 'right', render: (r) => el('strong', { class: r.days_until_expiry < 0 ? 'text-bad' : 'text-warn', text: String(r.days_until_expiry) }) },
    { key: 'alert_level', label: 'Status', render: (r) => badge(String(r.alert_level).replace(/_/g, ' '), toneForStatus(r.alert_level)) },
    { key: 'renewal_agent', label: 'Renewal' },
  ], 'One table for every dated obligation, so adding a new kind of permit is a row rather than a schema change. A lapsed SONCAP certificate stops goods clearing at the port — which is discovered at the port, not in the app, unless it is surfaced here.'));

  body.appendChild(section('Warranty expiring (60 days)', res.warranty_expiring, [
    { key: 'product_name', label: 'Product' },
    { key: 'serial_number', label: 'Serial' },
    { key: 'customer_name', label: 'Customer' },
    { key: 'customer_phone', label: 'Phone' },
    { key: 'sold_at', label: 'Sold' },
    { key: 'warranty_expires_on', label: 'Cover ends' },
    { key: 'days_remaining', label: 'Days left', align: 'right' },
  ], 'Contacting a customer before cover lapses is a genuine service — and for a shop that sells extended cover, it is a sale.'));
}

async function renderMovements(body, ctx) {
  const rows = await api.stockMovements({ limit: 200, product_id: ctx.query.product });
  clear(body);
  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: 'Stock movements' }),
    el('p', { class: 'hint', text: 'Balances are a cache; this table is the evidence. Every unit that arrived, left, or changed reservation has a row, so a batch can be replayed and reconciled against its balance.' }),
    table([
      { key: 'moved_at', label: 'When', render: (r) => String(r.moved_at || '').slice(0, 16) },
      { key: 'branch_name', label: 'Branch' },
      { key: 'product_name', label: 'Product' },
      { key: 'movement_type', label: 'Type', render: (r) => badge(String(r.movement_type).replace(/_/g, ' ').toLowerCase(), r.direction === -1 ? 'bad' : r.direction === 1 ? 'good' : 'neutral') },
      { key: 'quantity', label: 'Units', align: 'right', render: (r) => `${r.direction === -1 ? '−' : r.direction === 1 ? '+' : ''}${r.quantity}` },
      { key: 'reservation_delta', label: 'Reserved', align: 'right', render: (r) => Number(r.reservation_delta) ? `${Number(r.reservation_delta) > 0 ? '+' : ''}${r.reservation_delta}` : '—' },
      { key: 'moved_by_name', label: 'By' },
      { key: 'reference', label: 'Reference' },
      { key: 'notes', label: 'Notes' },
    ], rows, { dense: true, empty: 'No movements recorded yet.' })));
}

async function renderBatches(body, ctx) {
  const products = await api.products({ business_id: state.activeBusinessId, limit: 500 });
  clear(body);
  const sel = el('select', { onchange: (ev) => load(ev.target.value) },
    el('option', { value: '', text: '— choose a product —' }),
    products.map((p) => el('option', { value: p.id, text: p.name, selected: p.id === ctx.query.product })));
  const detail = el('div', { id: 'batch-detail' });
  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: 'Batches and serial numbers' }),
    el('p', { class: 'hint', text: 'Each batch carries its own cost and its own selling price, because two deliveries of the same fridge bought three months apart genuinely price differently. Forcing them onto one shelf price is how a retailer discovers in December that they sold the cheap stock at the expensive stock\'s margin.' }),
    sel, detail));
  if (ctx.query.product) load(ctx.query.product);

  async function load(productId) {
    if (!productId) return;
    clear(detail);
    detail.appendChild(spinner());
    const [batches, product] = await Promise.all([api.stockBatches(productId), api.product(productId)]);
    clear(detail);
    detail.appendChild(table([
      { key: 'branch_code', label: 'Branch' },
      { key: 'batch_no', label: 'Batch' },
      { key: 'quantity_on_hand', label: 'On hand', align: 'right' },
      { key: 'quantity_reserved', label: 'Reserved', align: 'right' },
      { key: 'sellable', label: 'Sellable', align: 'right', render: (r) => el('strong', { text: String(r.sellable) }) },
      { key: 'cost_per_unit', label: 'Cost', align: 'right', render: (r) => money(r.cost_per_unit) },
      { key: 'selling_price_per_unit', label: 'Sells at', align: 'right', render: (r) => money(r.selling_price_per_unit) },
      { key: 'value_at_cost', label: 'Value', align: 'right', render: (r) => money(r.value_at_cost) },
      { key: 'best_before_date', label: 'Best before', render: (r) => r.best_before_date || '—' },
      { key: 'received_at', label: 'Received', render: (r) => String(r.received_at || '').slice(0, 10) },
    ], batches, { dense: true, empty: 'No batches at branches you can see.' }));

    if (product.serials && product.serials.length) {
      detail.appendChild(el('h3', { class: 'card-title', text: `Serial numbers (${product.serials.length})` }));
      detail.appendChild(table([
        { key: 'serial_number', label: 'Serial' },
        { key: 'branch_name', label: 'Branch' },
        { key: 'status', label: 'Status', render: (r) => badge(String(r.status).replace(/_/g, ' ').toLowerCase(), toneForStatus(r.status)) },
        { key: 'customer_name', label: 'Owner' },
        { key: 'sold_at', label: 'Sold', render: (r) => r.sold_at ? String(r.sold_at).slice(0, 10) : '—' },
        { key: 'warranty_expires_on', label: 'Cover to', render: (r) => r.warranty_expires_on || '—' },
        { key: 'warranty_status', label: 'Warranty', render: (r) => badge(String(r.warranty_status || '').replace(/_/g, ' ').toLowerCase(), toneForStatus(r.warranty_status)) },
      ], product.serials, { dense: true }));
    }
    if (product.ladder_validation && !product.ladder_validation.ok) {
      detail.appendChild(el('div', { class: 'warn-box' },
        el('strong', { text: 'This product\'s unit ladder is inconsistent: ' }),
        el('ul', {}, product.ladder_validation.errors.map((e) => el('li', { text: e })))));
    }
  }
}

// ---------------------------------------------------------------------
// receiving
// ---------------------------------------------------------------------
function receiveDialog(ctx) {
  const business = activeBusiness();
  const branches = branchesOfActiveBusiness();
  const productSel = el('select', { name: 'product_id', required: true, onchange: (ev) => onProduct(ev.target.value) }, el('option', { value: '', text: 'Loading products…' }));
  const branchSel = el('select', { name: 'branch_id', required: true },
    (branches.length ? branches : [activeBranch()]).filter(Boolean).map((b) => el('option', { value: b.id, text: b.name, selected: b.id === state.activeBranchId })));
  const unitSel = el('select', { name: 'unit_type' }, el('option', { value: 'BASE_UNIT', text: 'base unit' }));
  const qtyF = field({ label: 'How many did you receive?', name: 'quantity', type: 'number', min: 1, step: 1, required: true, value: 1 });
  const costF = field({ label: 'Total cost on the supplier invoice (₦)', name: 'total_cost', type: 'number', min: 0, step: '0.01', required: true, hint: 'Enter the invoice total, not a per-unit guess. It is split to a per-unit cost at full precision, because rounding ₦480,000 over 7,000 bags to ₦68.57 loses ₦10 on every delivery — permanently, and invisibly.' });
  const priceF = field({ label: 'Selling price per base unit (₦)', name: 'selling_price_per_unit', type: 'number', min: 0, step: '0.01' });
  const batchF = field({ label: 'Batch / invoice number', name: 'batch_no' });
  const bbF = field({ label: 'Best-before date', name: 'best_before_date', type: 'date' });
  const supplierF = field({ label: 'Supplier', name: 'supplier_id', type: 'select', choices: [] });
  const serialsF = el('div', { id: 'serials-field', hidden: true },
    field({ label: 'Serial numbers (one per line, or comma-separated)', name: 'serial_numbers', type: 'textarea', rows: 4, hint: 'Captured at receipt so the serial exists BEFORE the unit can be sold. Asking a cashier for a serial that was never registered means they will invent one.' }));
  const preview = el('div', { class: 'receive-preview muted' });

  let chosen = null;
  function onProduct(id) {
    chosen = (window.__srProducts || []).find((p) => p.id === id) || null;
    clear(unitSel);
    const ladder = chosen ? (chosen.ladder || []) : [];
    for (const rung of ladder) {
      unitSel.appendChild(el('option', {
        value: rung.unit,
        text: rung.configured
          ? (rung.unit === 'BASE_UNIT' ? `${chosen.base_unit.toLowerCase()} (1)` : `${rung.unit.toLowerCase()} (${rung.pieces.toLocaleString('en-NG')} ${chosen.base_unit.toLowerCase()}s)`)
          : `${rung.unit.toLowerCase()} (not configured)`,
        disabled: !rung.configured,
      }));
    }
    if (priceF.querySelector('input')) priceF.querySelector('input').value = chosen ? (chosen.default_selling_price || '') : '';
    const bb = bbF.querySelector('input');
    if (bb) { bb.hidden = !(chosen && Number(chosen.track_best_before) === 1); bb.required = !!(chosen && Number(chained(chosen) === 1)); }
    serialsF.hidden = !(chosen && Number(chosen.serial_tracking) === 1);
    updatePreview();
  }
  function chained(p) { return p.track_best_before; }

  function updatePreview() {
    if (!chosen) { preview.textContent = ''; return; }
    const unit = unitSel.value;
    const count = Number(qtyF.querySelector('input').value) || 0;
    const total = Number(costF.querySelector('input').value) || 0;
    const rung = (chosen.ladder || []).find((r) => r.unit === unit);
    if (!rung || !rung.configured || !count) { preview.textContent = ''; return; }
    const pieces = count * rung.pieces;
    const perPiece = pieces > 0 ? total / pieces : 0;
    preview.textContent = `${count} ${unit === 'BASE_UNIT' ? chosen.base_unit.toLowerCase() : unit.toLowerCase()} = ${pieces.toLocaleString('en-NG')} ${chosen.base_unit.toLowerCase()}s. `
      + `Cost per ${chosen.base_unit.toLowerCase()}: ₦${perPiece.toFixed(4)} (stored at full precision, shown rounded).`;
  }
  [qtyF, costF].forEach((f) => f.querySelector('input').addEventListener('input', updatePreview));
  unitSel.addEventListener('change', updatePreview);

  const form = el('form', { onsubmit: async (ev) => {
    ev.preventDefault();
    const v = readForm(form);
    if (!v.product_id) { toast('Choose a product.', { kind: 'warn' }); return; }
    const serials = serialsF.hidden ? [] : String(v.serial_numbers || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    if (!serialsF.hidden) {
      const rung = (chosen.ladder || []).find((r) => r.unit === v.unit_type);
      const need = Math.round(Number(v.quantity) * (rung ? rung.pieces : 1));
      if (serials.length !== need) {
        toast(`This product is serial-tracked: ${need} serial number(s) are required, ${serials.length} given. Receiving without them means the till will refuse to sell the unit later.`, { kind: 'error', duration: 9000 });
        return;
      }
    }
    try {
      const res = await api.receiveStock({
        branch_id: v.branch_id, product_id: v.product_id, unit_type: v.unit_type,
        quantity: Number(v.quantity), total_cost: Number(v.total_cost),
        selling_price_per_unit: v.selling_price_per_unit ? Number(v.selling_price_per_unit) : undefined,
        batch_no: v.batch_no, best_before_date: v.best_before_date, supplier_id: v.supplier_id,
        serial_numbers: serials,
      }, newIdempotencyKey('receipt'));
      m.close();
      toast(`Received ${res.description}. Cost per ${chosen.base_unit.toLowerCase()}: ${money(res.cost_per_unit)}.`, { kind: 'good', duration: 7000 });
      ctx.rerender();
    } catch (e) { reportError(e, { context: 'The receipt could not be saved' }); }
  } },
  el('div', { class: 'field' }, el('label', { for: 'product_id', text: 'Product' }), productSel),
  el('div', { class: 'field' }, el('label', { for: 'branch_id', text: 'Receiving branch' }), branchSel),
  el('div', { class: 'field-row' },
    el('div', { class: 'field' }, el('label', { text: 'Received in' }), unitSel),
    qtyF),
  costF, priceF, serialsF, batchF, bbF, supplierF,
  preview,
  el('div', { class: 'row-end' },
    el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => m.close() }, 'Cancel'),
    el('button', { type: 'submit', class: 'btn btn-primary' }, 'Receive into stock')));

  const m = modal({ title: 'Receive stock', size: 'md', body: form });

  (async () => {
    try {
      const [products, suppliers] = await Promise.all([
        api.products({ business_id: business.id, limit: 1000 }),
        (async () => { try { return await api.suppliers ? api.suppliers() : []; } catch (e) { return []; } })(),
      ]);
      window.__srProducts = products;
      clear(productSel);
      productSel.appendChild(el('option', { value: '', text: '— choose a product —' }));
      for (const p of products) productSel.appendChild(el('option', { value: p.id, text: `${p.name}${p.sku ? ` (${p.sku})` : ''}` }));
      productSel.addEventListener('change', (ev) => onProduct(ev.target.value));
      if (Array.isArray(suppliers) && suppliers.length) {
        const s = supplierF.querySelector('select');
        for (const sup of suppliers) s.appendChild(el('option', { value: sup.id, text: sup.name }));
      } else {
        supplierF.hidden = true;
      }
    } catch (e) { reportError(e, { context: 'Could not load the product list' }); }
  })();
}
