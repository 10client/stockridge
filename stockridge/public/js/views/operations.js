// =====================================================================
// public/js/views/operations.js — tills, safe, change owed, holds,
// instalment plans, deliveries and warranty
// =====================================================================
// One screen for the day-to-day operations that are not selling and are not
// accounting. They are grouped because they share an audience: the person
// running the branch today.

'use strict';

import { endpoints as api } from '../api.js';
import { state, activeBusiness, activeBranch, branchesOfActiveBusiness, atLeast, can, todayWat } from '../state.js';
import { el, clear, badge, toneForStatus, table, money, spinner, reportError, toast, modal, field, readForm, emptyState, statCard, confirmDialog } from '../ui.js';
import { newIdempotencyKey } from '../offline.js';

const TABS = [
  ['till', 'Tills & safe'],
  ['change', 'Change owed'],
  ['holds', 'Holds (layaway)'],
  ['plans', 'Instalment plans'],
  ['delivery', 'Deliveries'],
  ['warranty', 'Warranty'],
  ['attendance', 'Attendance'],
];

export default async function operationsView(ctx) {
  const host = ctx.host;
  const tab = ctx.query.tab || 'till';

  host.appendChild(el('header', { class: 'view-head' },
    el('div', {}, el('h1', { text: 'Operations' }),
      el('p', { class: 'muted', text: `${activeBranch() ? activeBranch().name : ''} · ${todayWat()} WAT` }))));
  host.appendChild(el('nav', { class: 'tabs' }, TABS.map(([k, label]) => el('a', {
    href: `/operations?tab=${k}`, class: `tab${tab === k ? ' active' : ''}`,
    onclick: (ev) => { ev.preventDefault(); ctx.navigate(`/operations?tab=${k}`); },
  }, label))));

  const body = el('div', {}, spinner());
  host.appendChild(body);
  try {
    if (tab === 'till') await renderTill(body, ctx);
    else if (tab === 'change') await renderChange(body, ctx);
    else if (tab === 'holds') await renderHolds(body, ctx);
    else if (tab === 'plans') await renderPlans(body, ctx);
    else if (tab === 'delivery') await renderDelivery(body, ctx);
    else if (tab === 'warranty') await renderWarranty(body, ctx);
    else await renderAttendance(body, ctx);
  } catch (e) {
    clear(body);
    body.appendChild(emptyState('This screen could not be loaded', e.message || String(e), 'Try again', () => ctx.rerender()));
  }
  return {};
}

// ---------------------------------------------------------------------
// TILLS AND SAFE
// ---------------------------------------------------------------------
async function renderTill(body, ctx) {
  const [tills, safe] = await Promise.all([
    api.tills(),
    activeBranch() ? api.safe(activeBranch().id).catch(() => null) : null,
  ]);
  clear(body);
  const open = tills.filter((t) => t.status === 'OPEN');

  body.appendChild(el('div', { class: 'stat-grid stat-grid-sm' },
    statCard({ label: 'Open tills', value: String(open.length), tone: open.length ? 'good' : 'warn' }),
    statCard({ label: 'Safe balance', value: safe ? money(safe.balance.balance) : '—', sub: safe && safe.balance.negative ? 'NEGATIVE — a movement was recorded the wrong way round' : `${safe ? safe.movements.length : 0} movements` }),
    statCard({ label: 'Tills needing review', value: String(tills.filter((t) => Number(t.requires_review) === 1 && !t.reviewed_by).length), tone: 'warn' }),
  ));

  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title' }, 'Till sessions',
      el('button', { class: 'btn btn-sm btn-primary', onclick: () => openTillDialog(ctx) }, 'Open a till')),
    table([
      { key: 'branch_name', label: 'Branch' },
      { key: 'till_no', label: 'Till' },
      { key: 'opened_by_name', label: 'Opened by' },
      { key: 'opening_float', label: 'Float', align: 'right', render: (r) => money(r.opening_float) },
      { key: 'sales_count', label: 'Sales', align: 'right' },
      { key: 'void_count', label: 'Voids', align: 'right', render: (r) => Number(r.void_count) > 0 ? badge(r.void_count, 'warn') : '0' },
      { key: 'status', label: 'Status', render: (r) => badge(r.status.toLowerCase(), toneForStatus(r.status)) },
      { key: 'variance', label: 'Variance', align: 'right', render: (r) => r.variance != null ? el('strong', { class: Number(r.variance) === 0 ? 'text-good' : 'text-bad', text: money(r.variance) }) : '—' },
      { key: 'opened_at', label: 'Opened', render: (r) => String(r.opened_at || '').slice(0, 16) },
      { key: 'action', label: '', render: (r) => r.status === 'OPEN' ? el('button', { class: 'btn btn-sm btn-primary', onclick: (ev) => { ev.stopPropagation(); closeTillDialog(r, ctx); } }, 'Close & count') : (Number(r.requires_review) && !r.reviewed_by ? badge('needs review', 'warn') : '') },
    ], tills, { dense: true, empty: 'No till sessions yet. Open one before the first sale — a sale with no open till cannot be reconciled at close.' })));

  if (safe) {
    body.appendChild(el('section', { class: 'card' },
      el('h2', { class: 'card-title' }, `Safe — ${safe.branch.name}`,
        el('button', { class: 'btn btn-sm btn-ghost', onclick: () => safeMovementDialog(ctx) }, 'Record a movement')),
      el('p', { class: 'hint', text: 'The safe balance is DERIVED from these movements, never typed in. A balance somebody can edit is a balance nobody can prove.' }),
      safe.balance.negative ? el('div', { class: 'error-box' }, 'The safe is showing a negative balance. A movement was recorded in the wrong direction — find it below and correct it.') : null,
      table([
        { key: 'created_at', label: 'When', render: (r) => String(r.created_at || '').slice(0, 16) },
        { key: 'movement_type', label: 'Type', render: (r) => badge(String(r.movement_type).replace(/_/g, ' ').toLowerCase(), 'neutral') },
        { key: 'direction', label: 'In/Out', render: (r) => badge(r.direction, r.direction === 'IN' ? 'good' : 'warn') },
        { key: 'amount', label: 'Amount', align: 'right', render: (r) => money(r.amount) },
        { key: 'reference', label: 'Reference' },
        { key: 'notes', label: 'Notes' },
      ], safe.movements, { dense: true, empty: 'No movements.' })));
  }
}

function openTillDialog(ctx) {
  const branch = activeBranch();
  const floatF = field({ label: 'Opening float (₦, counted)', name: 'opening_float', type: 'number', min: 0, step: '0.01', required: true, value: branch ? branch.default_till_float || 0 : 0, hint: 'Count the drawer. A float nobody counted at open cannot be reconciled at close, because the opening figure is a guess — and a guess is what a variance dispute turns on.' });
  const tillF = field({ label: 'Till number', name: 'till_no', value: '1' });
  const form = el('form', { onsubmit: async (ev) => {
    ev.preventDefault();
    const v = readForm(form);
    try {
      const res = await api.openTill({ branch_id: branch.id, till_no: v.till_no || '1', opening_float: Number(v.opening_float) || 0 });
      m.close(); toast(`Till ${res.till_no} opened at ${res.branch} with ${money(res.opening_float)}.`, { kind: 'good' }); ctx.rerender();
    } catch (e) { reportError(e, { context: 'The till could not be opened' }); }
  } }, tillF, floatF, el('div', { class: 'row-end' }, el('button', { type: 'submit', class: 'btn btn-primary' }, 'Open till')));
  const m = modal({ title: 'Open a till', size: 'sm', body: form });
}

function closeTillDialog(session, ctx) {
  const countedF = field({ label: 'Cash counted in the drawer (₦)', name: 'counted_cash', type: 'number', min: 0, step: '0.01', required: true });
  const tolF = field({ label: 'Tolerance (₦)', name: 'tolerance', type: 'number', min: 0, step: '0.01', value: 0, hint: 'Within this the till closes cleanly. Outside it, a manager must review — and the review is recorded.' });
  const notesF = field({ label: 'Notes', name: 'notes', type: 'textarea', rows: 2 });
  const result = el('div', {});
  const form = el('form', { onsubmit: async (ev) => {
    ev.preventDefault();
    const v = readForm(form);
    try {
      const res = await api.closeTill(session.id, v);
      m.close();
      modal({
        title: `Till ${session.till_no} closed — ${res.status === 'CLOSED' ? 'done' : res.status}`,
        body: el('div', {},
          el('dl', { class: 'money-rows' },
            el('div', {}, el('dt', { text: 'Expected in the drawer' }), el('dd', { text: money(res.expected_cash) })),
            el('div', {}, el('dt', { text: 'Counted' }), el('dd', { text: money(res.counted_cash) })),
            el('div', { class: 'money-total' }, el('dt', { text: 'Variance' }), el('dd', { class: res.variance === 0 ? 'text-good' : 'text-bad', text: money(res.variance) }))),
          el('p', { class: res.requires_review ? 'warn-box' : 'ok-box', text: res.review_note }),
          el('h3', { class: 'card-title', text: 'By method' }),
          table([
            { key: 'label', label: 'Method' },
            { key: 'expected', label: 'Expected', align: 'right', render: (r) => money(r.expected) },
            { key: 'counted', label: 'Counted', align: 'right', render: (r) => r.counted == null ? el('span', { class: 'muted', text: 'not in the drawer' }) : money(r.counted) },
            { key: 'variance', label: 'Variance', align: 'right', render: (r) => r.variance == null ? '—' : el('strong', { class: Number(r.variance) === 0 ? 'text-good' : 'text-bad', text: money(r.variance) }) },
            { key: 'verifiedAgainst', label: 'Verified against', render: (r) => el('span', { class: 'muted small', text: String(r.verifiedAgainst || '').replace(/_/g, ' ').toLowerCase() }) },
          ], res.reconciliation.rows, { dense: true }),
          Number(res.change_owed_outstanding) > 0 ? el('p', { class: 'hint', text: `${money(res.change_owed_outstanding)} is still owed to customers as change. It is a liability, and it is why the drawer can be short while the books are right.` }) : null),
        footer: el('div', { class: 'row-end' }, el('button', { class: 'btn btn-primary', onclick: (e2) => { e2.target.closest('.modal-host').hidden = true; ctx.rerender(); } }, 'Done')),
      });
    } catch (e) { reportError(e, { context: 'The till could not be closed' }); }
  } }, countedF, tolF, notesF, result, el('div', { class: 'row-end' }, el('button', { type: 'submit', class: 'btn btn-primary' }, 'Close the till')));
  const m = modal({ title: `Close till ${session.till_no} — ${session.branch_name}`, body: form });
}

function safeMovementDialog(ctx) {
  const typeF = field({ label: 'Movement', name: 'movement_type', type: 'select', choices: ['BANK_DEPOSIT', 'PURCHASE', 'CHANGE_GIVEN', 'REFUND', 'TRANSFER_IN', 'TRANSFER_OUT', 'COUNT_CORRECTION', 'PETTY_CASH'] });
  const dirF = field({ label: 'Direction', name: 'direction', type: 'select', choices: [{ value: 'OUT', label: 'OUT — cash leaves the safe' }, { value: 'IN', label: 'IN — cash enters the safe' }] });
  const amtF = field({ label: 'Amount (₦)', name: 'amount', type: 'number', min: '0.01', step: '0.01', required: true });
  const refF = field({ label: 'Reference', name: 'reference', hint: 'A bank deposit slip number, an invoice, or a claim code.' });
  const notesF = field({ label: 'What is it for?', name: 'notes', type: 'textarea', rows: 2, required: true });
  const form = el('form', { onsubmit: async (ev) => {
    ev.preventDefault();
    const v = readForm(form);
    try {
      const res = await api.safeMovement({ ...v, branch_id: activeBranch().id });
      m.close(); toast(`Recorded. The safe now holds ${money(res.balance)}.`, { kind: 'good' }); ctx.rerender();
    } catch (e) { reportError(e, { context: 'The movement could not be recorded' }); }
  } }, typeF, dirF, amtF, refF, notesF, el('div', { class: 'row-end' }, el('button', { type: 'submit', class: 'btn btn-primary' }, 'Record movement')));
  const m = modal({ title: 'Safe movement', size: 'sm', body: form });
}

// ---------------------------------------------------------------------
// CHANGE OWED
// ---------------------------------------------------------------------
async function renderChange(body, ctx) {
  const res = await api.changeOwed();
  clear(body);
  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: 'Outstanding change' }),
    el('p', { class: 'hint', text: 'The drawer had no small notes, so the shop owes the customer. Each has a claim code quotable at ANY branch. It is a liability until collected — and it is why a drawer can be short while the books are right.' }),
    el('div', { class: 'stat-grid stat-grid-sm' },
      statCard({ label: 'Owed', value: money(res.total), sub: `${res.count} record(s)`, tone: res.total > 0 ? 'warn' : null }),
      statCard({ label: 'Due for review', value: String((res.rows || []).filter((r) => Number(r.due_for_review) === 1).length), sub: 'unclaimed past the review period', tone: 'warn' })),
    el('div', { class: 'filter-bar' },
      el('input', { type: 'text', id: 'claim-code', placeholder: 'Claim code from a customer…' }),
      el('button', { class: 'btn btn-ghost', onclick: () => lookupClaim(ctx) }, 'Look up a code')),
    table([
      { key: 'claim_code', label: 'Code', render: (r) => el('code', { text: r.claim_code }) },
      { key: 'customer_name', label: 'Customer' },
      { key: 'customer_phone', label: 'Phone' },
      { key: 'amount', label: 'Amount', align: 'right', render: (r) => el('strong', { text: money(r.amount) }) },
      { key: 'branch_name', label: 'Owed at' },
      { key: 'owed_since', label: 'Since' },
      { key: 'days_outstanding', label: 'Days', align: 'right', render: (r) => Number(r.due_for_review) ? badge(`${r.days_outstanding}d — review`, 'warn') : `${r.days_outstanding}d` },
      { key: 'action', label: '', render: (r) => el('button', { class: 'btn btn-sm btn-primary', onclick: async (ev) => {
        ev.stopPropagation();
        const okGo = await confirmDialog({ title: 'Pay out this change', message: `Pay ${money(r.amount)} to ${r.customer_name || 'the customer'} from the drawer at ${activeBranch() ? activeBranch().name : 'this branch'}?`, confirmLabel: 'Pay it out' });
        if (!okGo) return;
        try { await api.changeOwedCollect(r.id); toast('Paid out and recorded against the safe.', { kind: 'good' }); ctx.rerender(); }
        catch (e) { reportError(e, { context: 'The payout could not be recorded' }); }
      } }, 'Pay out') },
    ], res.rows || [], { dense: true, empty: 'Nobody is owed change right now.' })));
}

async function lookupClaim(ctx) {
  const input = document.getElementById('claim-code');
  const code = String(input.value || '').trim();
  if (!code) { toast('Enter the claim code.', { kind: 'warn' }); return; }
  try {
    const r = await api.changeOwedLookup(code);
    if (!r.found) { toast(`No record for ${code}. Check the code — it is on the receipt.`, { kind: 'warn', duration: 6000 }); return; }
    modal({
      title: `Claim ${r.claim_code}`, size: 'sm',
      body: el('div', {},
        el('p', { class: 'modal-message' }, r.collectable
          ? `This claim is valid for ${money(r.amount)} and can be paid out at any branch.`
          : `This claim has already been ${String(r.status).toLowerCase()}.`),
        el('p', { class: 'hint', text: 'The customer\'s name and phone are deliberately not shown here. This lookup is open to anyone with a code, and a code is short enough that it should not unlock personal details.' })),
      footer: el('div', { class: 'row-end' }, el('button', { class: 'btn btn-primary', onclick: (ev) => { ev.target.closest('.modal-host').hidden = true; } }, 'Close')),
    });
  } catch (e) { reportError(e, { context: 'The lookup failed' }); }
}

// ---------------------------------------------------------------------
// HOLDS
// ---------------------------------------------------------------------
async function renderHolds(body, ctx) {
  const rows = await api.holds({ status: 'ACTIVE' });
  clear(body);
  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: 'Active holds' }),
    el('p', { class: 'hint', text: 'A held item is still ON HAND but NOT SELLABLE. It reserves real stock, so no other till can sell it — and it expires, because an unbounded hold means the stock report quietly lies about what is available.' }),
    table([
      { key: 'hold_number', label: 'Hold' },
      { key: 'customer_name', label: 'Customer' },
      { key: 'branch_name', label: 'Branch' },
      { key: 'units_held', label: 'Units', align: 'right' },
      { key: 'total_value', label: 'Value', align: 'right', render: (r) => money(r.total_value) },
      { key: 'deposit', label: 'Deposit', align: 'right', render: (r) => `${money(r.deposit)} (${r.deposit_percent}%)` },
      { key: 'balance', label: 'Balance', align: 'right', render: (r) => el('strong', { text: money(r.balance) }) },
      { key: 'expires_on', label: 'Expires', render: (r) => el('span', { class: Number(r.days_until_expiry) < 0 ? 'text-bad' : Number(r.days_until_expiry) <= 2 ? 'text-warn' : '', text: `${r.expires_on} (${r.days_until_expiry}d)` }) },
      { key: 'reason', label: 'Reason', render: (r) => badge(String(r.reason).replace(/_/g, ' ').toLowerCase(), 'neutral') },
      { key: 'action', label: '', render: (r) => el('button', { class: 'btn btn-sm btn-ghost', onclick: (ev) => { ev.stopPropagation(); releaseHold(r, ctx); } }, 'Release') },
    ], rows, { dense: true, empty: 'No active holds.' })));
}

function releaseHold(hold, ctx) {
  const reasonF = field({ label: 'Why is this hold being released?', name: 'reason', type: 'select', choices: ['MANUAL', 'EXPIRED', 'CUSTOMER_CANCELLED', 'CONVERTED_ELSEWHERE'] });
  const refundF = field({ label: 'Refund the deposit?', name: 'refund_deposit', type: 'checkbox', value: true });
  const forfeitF = field({ label: 'Forfeit % of the deposit', name: 'forfeit_percent', type: 'number', min: 0, max: 100, value: 0, hint: 'A forfeited deposit is OTHER INCOME, not sales revenue: no goods left the shop, so booking it as revenue would overstate turnover and understate margin.' });
  const form = el('form', { onsubmit: async (ev) => {
    ev.preventDefault();
    const v = readForm(form);
    try {
      const res = await api.releaseHold(hold.hold_id, { reason: v.reason, refund_deposit: !!v.refund_deposit, forfeit_percent: Number(v.forfeit_percent) || 0 });
      m.close();
      toast(`Hold released. ${res.quantity_to_release} unit(s) are sellable again.${Number(res.deposit_refundable) > 0 ? ` Refund ${money(res.deposit_refundable)} from the drawer.` : ''}${Number(res.deposit_forfeited) > 0 ? ` ${money(res.deposit_forfeited)} forfeited to other income.` : ''}`, { kind: 'warn', duration: 9000 });
      ctx.rerender();
    } catch (e) { reportError(e, { context: 'The hold could not be released' }); }
  } }, reasonF, refundF, forfeitF, el('div', { class: 'row-end' }, el('button', { type: 'submit', class: 'btn btn-primary' }, 'Release the hold')));
  const m = modal({ title: `Release ${hold.hold_number}`, size: 'sm', body: form });
}

// ---------------------------------------------------------------------
// INSTALMENT PLANS
// ---------------------------------------------------------------------
async function renderPlans(body, ctx) {
  const rows = await api.instalments();
  clear(body);
  const overdue = rows.filter((r) => Number(r.days_overdue) > 0 || Number(r.overdue_count) > 0);
  const defaulted = rows.filter((r) => r.status === 'DEFAULTED');
  const outstanding = rows.reduce((a, r) => a + Number(r.outstanding || 0), 0);
  body.appendChild(el('div', { class: 'stat-grid stat-grid-sm' },
    statCard({ label: 'Active plans', value: String(rows.filter((r) => r.status === 'ACTIVE').length) }),
    statCard({ label: 'Outstanding', value: money(outstanding), tone: outstanding > 0 ? 'warn' : null }),
    statCard({ label: 'Overdue', value: String(overdue.length), tone: overdue.length ? 'bad' : 'good' }),
    statCard({ label: 'Defaulted', value: String(defaulted.length), tone: defaulted.length ? 'bad' : null }),
  ));
  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: 'Plans' }),
    el('p', { class: 'hint', text: 'A LAYAWAY_BACKED plan keeps the goods in the shop with stock reserved, so it can be repossessed. A DELIVERED_ON_DEPOSIT plan lets the goods go after the deposit, so the balance is an unsecured receivable and repossession is not an option — the choices offered on a defaulted plan differ accordingly.' }),
    table([
      { key: 'plan_number', label: 'Plan' },
      { key: 'customer_name', label: 'Customer', render: (r) => el('div', {}, el('strong', { text: r.customer_name }), el('div', { class: 'muted small', text: r.customer_phone || '' })) },
      { key: 'branch_name', label: 'Branch' },
      { key: 'model', label: 'Model', render: (r) => badge(String(r.model).replace(/_/g, ' ').toLowerCase(), r.model === 'DELIVERED_ON_DEPOSIT' ? 'warn' : 'neutral') },
      { key: 'total', label: 'Total', align: 'right', render: (r) => money(r.total) },
      { key: 'paid', label: 'Paid', align: 'right', render: (r) => money(r.paid) },
      { key: 'outstanding', label: 'Outstanding', align: 'right', render: (r) => el('strong', { text: money(r.outstanding) }) },
      { key: 'next_due_date', label: 'Next due', render: (r) => r.next_due_date ? el('span', { class: Number(r.days_overdue) > 0 ? 'text-bad' : '', text: `${r.next_due_date}${Number(r.days_overdue) > 0 ? ` (${r.days_overdue}d late)` : ''}` }) : '—' },
      { key: 'next_amount', label: 'Amount', align: 'right', render: (r) => r.next_amount != null ? money(r.next_amount) : '—' },
      { key: 'missed_count', label: 'Missed', align: 'right', render: (r) => Number(r.missed_count) > 0 ? badge(r.missed_count, 'bad') : '0' },
      { key: 'status', label: 'Status', render: (r) => badge(String(r.status).toLowerCase(), toneForStatus(r.status)) },
      { key: 'action', label: '', render: (r) => el('button', { class: 'btn btn-sm btn-primary', onclick: (ev) => { ev.stopPropagation(); planPayment(r, ctx); } }, 'Take payment') },
    ], rows, { dense: true, empty: 'No instalment plans.' })));
}

function planPayment(plan, ctx) {
  const amtF = field({ label: 'Amount received (₦)', name: 'amount', type: 'number', min: '0.01', step: '0.01', required: true, value: plan.next_amount || '' });
  const methodF = field({ label: 'Method', name: 'method', type: 'select', choices: ['CASH', 'POS_TERMINAL', 'BANK_TRANSFER', 'MOBILE_MONEY'] });
  const notesF = field({ label: 'Notes', name: 'notes', type: 'textarea', rows: 2 });
  const form = el('form', { onsubmit: async (ev) => {
    ev.preventDefault();
    const v = readForm(form);
    try {
      const res = await api.planPayment(plan.plan_id, v, newIdempotencyKey('plan'));
      m.close();
      let msg = `Recorded ${money(v.amount)} on ${plan.plan_number}. Outstanding ${money(res.outstanding)} · status ${res.status}.`;
      if (Number(res.late_fees) > 0) msg += ` A late fee of ${money(res.late_fees)} was applied.`;
      if (res.status === 'COMPLETED') msg += ' The plan is now paid off — reserved stock has been released and the goods belong to the customer.';
      if (res.status === 'DEFAULTED') msg += ' The plan has DEFAULTED. Open it to see the options, which depend on whether the goods are still in the shop.';
      toast(msg, { kind: res.status === 'DEFAULTED' ? 'error' : 'good', duration: 10000 });
      ctx.rerender();
    } catch (e) { reportError(e, { context: 'The payment could not be recorded' }); }
  } }, amtF, methodF, notesF, el('div', { class: 'row-end' }, el('button', { type: 'submit', class: 'btn btn-primary' }, 'Record payment')));
  const m = modal({ title: `Payment on ${plan.plan_number} — ${plan.customer_name}`, size: 'sm', body: form });
}

// ---------------------------------------------------------------------
// DELIVERIES
// ---------------------------------------------------------------------
async function renderDelivery(body, ctx) {
  const [jobs, zones] = await Promise.all([api.deliveryJobs({}), api.deliveryZones().catch(() => [])]);
  clear(body);
  const due = jobs.filter((j) => Number(j.is_overdue) === 1);
  body.appendChild(el('div', { class: 'stat-grid stat-grid-sm' },
    statCard({ label: 'Open jobs', value: String(jobs.length) }),
    statCard({ label: 'Overdue', value: String(due.length), tone: due.length ? 'bad' : 'good' }),
    statCard({ label: 'Dispatched', value: String(jobs.filter((j) => ['DISPATCHED', 'IN_TRANSIT'].includes(j.status)).length), tone: 'warn' }),
    statCard({ label: 'Zones configured', value: String(zones.length) }),
  ));
  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: 'Delivery jobs' }),
    el('p', { class: 'hint', text: 'Stock leaves on DISPATCH, not on delivery: the moment an item is loaded it is no longer sellable from the branch. A failed attempt returns the goods to sellable stock and, if the failure was the customer\'s fault, may carry a re-delivery fee — that determination is made in code rather than left to whoever is on shift.' }),
    table([
      { key: 'job_number', label: 'Job' },
      { key: 'scheduled_date', label: 'Date', render: (r) => el('span', { class: Number(r.is_overdue) ? 'text-bad' : '', text: `${r.scheduled_date}${r.window_start ? ` ${r.window_start}–${r.window_end || ''}` : ''}` }) },
      { key: 'customer_name', label: 'Customer', render: (r) => el('div', {}, el('strong', { text: r.customer_name }), el('div', { class: 'muted small', text: r.contact_phone || r.customer_phone || '' })) },
      { key: 'address', label: 'Address', render: (r) => el('span', { class: 'small', text: [r.address, r.area].filter(Boolean).join(', ') }) },
      { key: 'job_type', label: 'Type', render: (r) => badge(String(r.job_type).replace(/_/g, ' ').toLowerCase(), 'neutral') },
      { key: 'driver_name', label: 'Driver' },
      { key: 'fee', label: 'Fee', align: 'right', render: (r) => money(r.fee) },
      { key: 'fee_collected', label: 'Fee paid', render: (r) => Number(r.fee_collected) ? badge('paid', 'good') : badge('due', 'warn') },
      { key: 'status', label: 'Status', render: (r) => badge(String(r.status).replace(/_/g, ' ').toLowerCase(), toneForStatus(r.status)) },
      { key: 'action', label: '', render: (r) => ['SCHEDULED', 'CONFIRMED'].includes(r.status)
        ? el('button', { class: 'btn btn-sm btn-primary', onclick: (ev) => { ev.stopPropagation(); dispatchJob(r, ctx); } }, 'Dispatch')
        : ['DISPATCHED', 'IN_TRANSIT'].includes(r.status)
          ? el('button', { class: 'btn btn-sm btn-primary', onclick: (ev) => { ev.stopPropagation(); completeJob(r, ctx); } }, 'Record outcome')
          : '' },
    ], jobs, { dense: true, empty: 'No open delivery jobs.' })));
}

function dispatchJob(job, ctx) {
  const driverF = field({ label: 'Driver', name: 'driver_id', type: 'select', choices: [], placeholder: '— assign a driver —' });
  const vehF = field({ label: 'Vehicle registration', name: 'vehicle_registration', value: job.vehicle_registration || '' });
  const form = el('form', { onsubmit: async (ev) => {
    ev.preventDefault();
    const v = readForm(form);
    if (!v.driver_id) { toast('Assign a driver. An unassigned trip cannot be tracked, and "which truck had it?" is the first question when an item does not arrive.', { kind: 'warn', duration: 8000 }); return; }
    try {
      await api.dispatchJob(job.job_id, v);
      m.close(); toast(`${job.job_number} dispatched. Stock has left the branch.`, { kind: 'good' }); ctx.rerender();
    } catch (e) { reportError(e, { context: 'The job could not be dispatched' }); }
  } }, driverF, vehF,
  el('p', { class: 'hint', text: 'Dispatch is the moment stock physically leaves. If the sale is not paid in full, dispatch is refused unless the owner has enabled managers_can_dispatch_unpaid — goods leaving against an unpaid invoice is how a delivery becomes a gift.' }),
  el('div', { class: 'row-end' }, el('button', { type: 'submit', class: 'btn btn-primary' }, 'Dispatch')));
  const m = modal({ title: `Dispatch ${job.job_number}`, size: 'sm', body: form });
  (async () => {
    // Drivers are users flagged is_driver, so a storekeeper who also drives does
    // not have to choose between two true facts.
    try {
      const branches = await api.branches();
      const sel = driverF.querySelector('select');
      sel.appendChild(el('option', { value: job.driver_id || '', text: job.driver_name || '— assign a driver —' }));
    } catch (e) { /* the caller can still type a driver in */ }
  })();
}

function completeJob(job, ctx) {
  const successF = field({ label: 'Outcome', name: 'success', type: 'select', choices: [{ value: 'true', label: 'Delivered' }, { value: 'false', label: 'Failed attempt' }] });
  const receiverF = field({ label: 'Received by (name)', name: 'receiver_name' });
  const receiverPhoneF = field({ label: 'Receiver phone', name: 'receiver_phone', type: 'tel' });
  const reasonF = field({ label: 'Failure reason', name: 'failure_reason', type: 'select', choices: ['CUSTOMER_NOT_AVAILABLE', 'WRONG_ADDRESS', 'ACCESS_DIFFICULT', 'PAYMENT_NOT_CLEARED', 'VEHICLE_BREAKDOWN', 'ITEM_DAMAGED_IN_TRANSIT', 'CUSTOMER_REFUSED', 'SECURITY_CHECKPOINT', 'WEATHER', 'OTHER'] });
  const chargeF = field({ label: 'Charge a re-delivery fee', name: 'charge_redelivery', type: 'checkbox' });
  const feeF = field({ label: 'Re-delivery fee (₦)', name: 'redelivery_fee', type: 'number', min: 0, step: '0.01', value: 0 });
  const onTimeF = field({ label: 'Arrived within the promised window', name: 'on_time', type: 'checkbox', value: true });
  const note = el('p', { class: 'hint' });
  const form = el('form', { onsubmit: async (ev) => {
    ev.preventDefault();
    const v = readForm(form);
    const success = v.success === 'true';
    if (success && !v.receiver_name) {
      toast('Record who received it. Without a name, a signature or a photo the delivery cannot be evidenced if it is ever disputed — and "the customer says it never arrived" becomes unanswerable.', { kind: 'warn', duration: 10000 });
      return;
    }
    try {
      const res = await api.completeJob(job.job_id, {
        success, receiver_name: v.receiver_name, receiver_phone: v.receiver_phone,
        failure_reason: success ? undefined : v.failure_reason,
        charge_redelivery: !!v.charge_redelivery,
        redelivery_fee: Number(v.redelivery_fee) || 0,
        on_time: !!v.on_time,
      });
      m.close();
      if (success) toast(`${job.job_number} delivered and evidenced.`, { kind: 'good' });
      else toast(`Attempt recorded as failed (${res.failure_reason}). The goods are back in sellable stock.${res.chargeable ? ` A re-delivery fee of ${money(res.redelivery_fee)} is chargeable — the failure was the customer's.` : ` No re-delivery fee: ${res.note}`}`, { kind: 'warn', duration: 11000 });
      ctx.rerender();
    } catch (e) { reportError(e, { context: 'The outcome could not be recorded' }); }
  } }, successF, receiverF, receiverPhoneF, onTimeF, reasonF, chargeF, feeF, note,
  el('div', { class: 'row-end' }, el('button', { type: 'submit', class: 'btn btn-primary' }, 'Record outcome')));
  successF.querySelector('select').addEventListener('change', (ev) => {
    const failed = ev.target.value === 'false';
    [receiverF, receiverPhoneF, onTimeF].forEach((f) => { f.hidden = failed; });
    [reasonF, chargeF, feeF].forEach((f) => { f.hidden = !failed; });
    note.textContent = failed
      ? 'A failed attempt returns the goods to sellable stock. Whether the customer can be charged for a re-delivery depends on whose fault it was — that decision is made by the system from the reason, not left to whoever is on shift.'
      : '';
  });
  const m = modal({ title: `Outcome for ${job.job_number}`, body: form });
}

// ---------------------------------------------------------------------
// WARRANTY
// ---------------------------------------------------------------------
async function renderWarranty(body, ctx) {
  clear(body);
  const serialInput = el('input', { type: 'text', placeholder: 'Scan or type a serial number / IMEI…', autocapitalize: 'characters' });
  const result = el('div', {});
  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: 'Warranty check' }),
    el('p', { class: 'hint', text: 'A customer returns a fridge eleven months on claiming cover. Without a serial linked to a sale the shop either believes anyone who walks in — and eats the cost of a unit bought elsewhere — or refuses everyone and loses the customer. With it, the answer is a lookup.' }),
    el('div', { class: 'filter-bar' }, serialInput,
      el('button', { class: 'btn btn-primary', onclick: () => lookup(serialInput.value, result, ctx) }, 'Check cover'))));
  body.appendChild(result);
  serialInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); lookup(serialInput.value, result, ctx); } });
}

async function lookup(serial, result, ctx) {
  const s = String(serial || '').trim();
  if (!s) { toast('Enter a serial number.', { kind: 'warn' }); return; }
  clear(result);
  result.appendChild(spinner('Looking up…'));
  try {
    const r = await api.warrantyLookup(s);
    clear(result);
    if (!r.found) {
      result.appendChild(el('div', { class: 'warn-box' }, r.message || 'That serial is not in this system.'));
      return;
    }
    const cover = r.cover || {};
    result.appendChild(el('section', { class: 'card' },
      el('h2', { class: 'card-title' }, r.serial.product_name, ' ', badge(String(cover.status || '').replace(/_/g, ' ').toLowerCase(), cover.inCover ? 'good' : 'bad')),
      el('dl', { class: 'money-rows' },
        el('div', {}, el('dt', { text: 'Serial' }), el('dd', {}, el('code', { text: r.serial.serial_number }))),
        el('div', {}, el('dt', { text: 'Sold to' }), el('dd', { text: r.serial.customer_name || 'not linked to a customer' })),
        el('div', {}, el('dt', { text: 'Sold on' }), el('dd', { text: r.serial.sold_at ? String(r.serial.sold_at).slice(0, 10) : '—' })),
        el('div', {}, el('dt', { text: 'Cover' }), el('dd', { text: cover.expiresOn ? `${cover.warrantyMonths} month(s) to ${cover.expiresOn}${cover.extendedMonths ? ` (includes ${cover.extendedMonths} extended)` : ''}` : 'none recorded' })),
        el('div', { class: 'money-total' }, el('dt', { text: cover.inCover ? 'Days remaining' : 'Expired' }), el('dd', { class: cover.inCover ? 'text-good' : 'text-bad', text: cover.inCover ? `${cover.daysRemaining} day(s)` : `${Math.abs(cover.daysRemaining || 0)} day(s) ago` }))),
      (cover.reasons || []).length ? el('ul', { class: 'reason-list' }, cover.reasons.map((x) => el('li', { text: x.message }))) : null,
      r.claims && r.claims.length
        ? el('div', {}, el('h3', { class: 'card-title', text: 'Claim history' }), table([
          { key: 'claim_number', label: 'Claim' },
          { key: 'opened_on', label: 'Opened' },
          { key: 'claim_type', label: 'Type' },
          { key: 'responsibility', label: 'Liable', render: (x) => badge(String(x.responsibility).toLowerCase(), x.chargeable ? 'warn' : 'neutral') },
          { key: 'status', label: 'Status', render: (x) => badge(String(x.status).toLowerCase(), toneForStatus(x.status)) },
        ], r.claims, { dense: true }))
        : null,
      el('div', { class: 'row-end' }, el('button', { class: 'btn btn-primary', onclick: () => openClaim(r, ctx) }, 'Open a claim'))));
  } catch (e) { clear(result); result.appendChild(el('div', { class: 'error-box', text: e.message || String(e) })); }
}

function openClaim(found, ctx) {
  const typeF = field({ label: 'What is the customer asking for?', name: 'claim_type', type: 'select', choices: ['REPAIR', 'REPLACE', 'REFUND', 'PARTS_ONLY', 'REJECT_AS_OUT_OF_COVER'] });
  const descF = field({ label: 'Describe the fault', name: 'description', type: 'textarea', rows: 3, required: true, hint: 'At least a sentence. The manufacturer will ask for it, and "does not work" gets the claim rejected.' });
  const respF = field({ label: 'Who is liable?', name: 'responsibility', type: 'select', choices: ['MANUFACTURER', 'SHOP', 'CUSTOMER', 'CARRIER', 'INSTALLER'], hint: 'An in-cover claim is the manufacturer\'s. An out-of-cover or customer-fault claim is CHARGEABLE — booking it as a warranty expense is how the warranty provision quietly doubles.' });
  const rmaF = field({ label: 'Manufacturer RMA number', name: 'rma_number', hint: 'Without it a unit sent away is untraceable, which is how a ₦400,000 compressor disappears.' });
  const form = el('form', { onsubmit: async (ev) => {
    ev.preventDefault();
    const v = readForm(form);
    try {
      const res = await api.warrantyClaim({ ...v, serial_number: found.serial.serial_number, branch_id: state.activeBranchId });
      m.close();
      toast(`Claim ${res.claim_number} opened. ${res.chargeable ? 'This one is CHARGEABLE — quote the customer before any work.' : res.note || ''}`, { kind: res.chargeable ? 'warn' : 'good', duration: 10000 });
      ctx.rerender();
    } catch (e) { reportError(e, { context: 'The claim could not be opened' }); }
  } }, typeF, descF, respF, rmaF, el('div', { class: 'row-end' }, el('button', { type: 'submit', class: 'btn btn-primary' }, 'Open the claim')));
  const m = modal({ title: `Claim — ${found.serial.product_name}`, body: form });
}

// ---------------------------------------------------------------------
// ATTENDANCE
// ---------------------------------------------------------------------
async function renderAttendance(body, ctx) {
  clear(body);
  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: 'Attendance' }),
    el('p', { class: 'hint', text: 'Clock-in classification is a SIGNAL FOR MANAGER REVIEW, never a hard gate. GPS accuracy indoors is poor and permissions vary by device; a system that locks a cashier out of the till at 8am on a Saturday over a satellite is a system that gets switched off. Flagged clock-ins are recorded and surfaced here, so the conversation happens with the facts rather than not at all.' }),
    el('p', { class: 'muted', text: 'The clock-in itself is on the mobile/till screen; this tab is the review queue.' })));
  try {
    const res = await api.dashboard({});
    const flagged = res.alerts && res.alerts.attendance_flagged ? res.alerts.attendance_flagged : 0;
    body.appendChild(el('div', { class: flagged ? 'warn-box' : 'ok-box' },
      flagged ? `${flagged} clock-in(s) are flagged and awaiting review.` : 'Nothing is awaiting review.'));
  } catch (e) { /* non-fatal */ }
}
