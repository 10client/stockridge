// =====================================================================
// public/js/views/customers.js — the customer book, credit and collections
// =====================================================================
// The point of this screen is not a list of names. It is answering "who owes
// what, how late are they, and who do we call first?" — three questions a
// proprietor asks every week and which, without ageing, are unanswerable from a
// balance column.

'use strict';

import { endpoints as api } from '../api.js';
import { state, activeBusiness, activeBranch, atLeast, can } from '../state.js';
import { el, clear, icon, badge, toneForStatus, table, money, spinner, reportError, toast, modal, field, readForm, emptyState, statCard } from '../ui.js';
import { newIdempotencyKey } from '../offline.js';

export default async function customersView(ctx) {
  const host = ctx.host;
  if (ctx.query.id) { await renderStatement(host, ctx.query.id, ctx); return {}; }

  host.appendChild(el('header', { class: 'view-head' },
    el('div', {}, el('h1', { text: 'Customers & credit' }),
      el('p', { class: 'muted', text: 'Balances are derived from the ledger, never stored — so a balance always equals the sum of its evidence.' })),
    el('div', { class: 'view-actions' },
      el('button', { class: 'btn btn-primary', onclick: () => newCustomer(ctx) }, icon('plus'), ' New customer'))));

  const search = el('input', { type: 'search', placeholder: 'Search name, company or phone…', value: ctx.query.q || '' });
  const classSel = el('select', {},
    el('option', { value: '', text: 'All classes' }),
    ...['RETAIL', 'TRADE', 'WHOLESALE', 'DISTRIBUTOR', 'CORPORATE', 'STAFF'].map((c) => el('option', { value: c, text: c, selected: ctx.query.class === c })));
  const body = el('div', {}, spinner());
  host.appendChild(el('div', { class: 'filter-bar' }, search, classSel,
    el('button', { class: 'btn btn-primary', onclick: () => ctx.navigate(`/customers?q=${encodeURIComponent(search.value)}${classSel.value ? `&class=${classSel.value}` : ''}`) }, 'Filter')));
  host.appendChild(body);

  let t;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => ctx.navigate(`/customers?q=${encodeURIComponent(search.value)}${classSel.value ? `&class=${classSel.value}` : ''}`), 350); });
  classSel.addEventListener('change', () => ctx.navigate(`/customers?q=${encodeURIComponent(search.value)}${classSel.value ? `&class=${classSel.value}` : ''}`));

  try {
    const rows = await api.customers({ search: ctx.query.q, class: ctx.query.class, limit: 200 });
    clear(body);
    const debtors = rows.filter((r) => Number(r.balance) > 0);
    const totalOwed = debtors.reduce((a, r) => a + Number(r.balance), 0);
    body.appendChild(el('div', { class: 'stat-grid stat-grid-sm' },
      statCard({ label: 'Customers', value: String(rows.length), icon: 'users' }),
      statCard({ label: 'With a balance', value: String(debtors.length), tone: debtors.length ? 'warn' : null }),
      statCard({ label: 'Total receivable', value: money(totalOwed), tone: totalOwed > 0 ? 'warn' : null }),
      statCard({ label: 'Over their limit', value: String(rows.filter((r) => r.credit_limit != null && Number(r.balance) > Number(r.credit_limit)).length), tone: 'bad' }),
    ));
    body.appendChild(table([
      { key: 'name', label: 'Customer', render: (r) => el('div', {}, el('strong', { text: r.name }), el('div', { class: 'muted small', text: [r.company_name, r.phone].filter(Boolean).join(' · ') })) },
      { key: 'customer_class', label: 'Class', render: (r) => badge(String(r.customer_class).toLowerCase(), r.customer_class === 'RETAIL' ? 'neutral' : 'info') },
      { key: 'home_branch_name', label: 'Home branch' },
      { key: 'balance', label: 'Balance', align: 'right', render: (r) => Number(r.balance) > 0 ? el('strong', { class: 'text-warn', text: money(r.balance) }) : Number(r.balance) < 0 ? el('span', { class: 'text-good', title: 'A credit balance is money we hold that we owe back in goods or cash — a liability, not negative revenue', text: `${money(r.balance)} in credit` }) : '—' },
      { key: 'credit_limit', label: 'Limit', align: 'right', render: (r) => r.credit_limit != null ? money(r.credit_limit) : '—' },
      { key: 'terms_code', label: 'Terms', render: (r) => String(r.terms_code || 'CASH').replace(/_/g, ' ') },
      { key: 'account_status', label: 'Status', render: (r) => badge(String(r.account_status).replace(/_/g, ' ').toLowerCase(), toneForStatus(r.account_status)) },
    ], rows, { dense: true, rowKey: 'id', empty: 'No customers yet.', onRow: (r) => ctx.navigate(`/customers?id=${encodeURIComponent(r.id)}`) }));
  } catch (e) {
    clear(body);
    body.appendChild(emptyState('Customers could not be loaded', e.message || String(e), 'Try again', () => ctx.rerender()));
  }
  return {};
}

async function renderStatement(host, id, ctx) {
  host.appendChild(spinner('Loading the statement…'));
  let st;
  try { st = await api.customerStatement(id); } catch (e) {
    clear(host);
    host.appendChild(emptyState('That customer could not be loaded', e.message || String(e), 'Back', () => ctx.navigate('/customers')));
    return;
  }
  clear(host);
  const c = st.customer;

  host.appendChild(el('header', { class: 'view-head' },
    el('div', {},
      el('h1', {}, c.name, ' ', badge(String(c.account_status).replace(/_/g, ' ').toLowerCase(), toneForStatus(c.account_status))),
      el('p', { class: 'muted', text: [c.company_name, c.customer_class, c.phone, c.email].filter(Boolean).join(' · ') })),
    el('div', { class: 'view-actions' },
      el('button', { class: 'btn btn-ghost', onclick: () => ctx.navigate('/customers') }, '← Back'),
      el('button', { class: 'btn btn-primary', onclick: () => takePayment(c, ctx) }, 'Record a payment'))));

  const bal = st.balance || {};
  const ageing = st.ageing || {};
  host.appendChild(el('div', { class: 'stat-grid' },
    statCard({ label: 'Balance', value: money(bal.balance), sub: bal.isOverpaid ? 'in credit — this is a liability we owe back' : `${(ageing.lines || []).length} open item(s)`, tone: bal.balance > 0 ? 'warn' : bal.isOverpaid ? 'good' : null }),
    statCard({ label: 'Credit limit', value: c.credit_limit != null ? money(c.credit_limit) : 'none set', sub: c.credit_limit != null ? `${money(Math.max(0, Number(c.credit_limit) - Number(bal.balance)))} headroom` : '' }),
    statCard({ label: 'Most overdue', value: ageing.maxDaysOverdue ? `${ageing.maxDaysOverdue} days` : 'nothing overdue', tone: ageing.maxDaysOverdue > 30 ? 'bad' : ageing.maxDaysOverdue > 0 ? 'warn' : 'good' }),
    statCard({ label: 'Bad-debt provision', value: money(st.provision ? st.provision.totalProvision : 0), sub: 'expected loss at standard rates', tone: 'neutral' }),
  ));

  // Ageing buckets — the one table that decides who gets called.
  host.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: 'Ageing' }),
    el('p', { class: 'hint', text: 'Payments are applied oldest-first, which is both the commercially standard convention and the one most favourable to the customer. Applying them newest-first would let an old debt look current while the genuinely new one aged.' }),
    el('div', { class: 'ageing' }, (ageing.buckets || []).filter((b) => b.count > 0 || b.amount_kobo > 0).map((b) => el('div', { class: `ageing-cell ageing-${b.code}` },
      el('span', { class: 'ageing-label', text: b.label }),
      el('strong', { class: 'ageing-amount', text: money(b.amount) }),
      el('span', { class: 'ageing-count muted', text: `${b.count} item(s) · ${b.percent}%` }))))));

  if (st.chase_schedule) {
    host.appendChild(el('section', { class: 'card' },
      el('h2', { class: 'card-title', text: 'What to do next' }),
      el('p', { class: 'hint', text: 'A debt nobody calls about is a debt that is never paid. This is the standard escalation for an account this overdue, so the process is not improvised per manager.' }),
      el('ol', { class: 'chase-list' }, (st.chase_schedule.completed || []).map((s) => el('li', { class: 'chase-done' },
        el('strong', { text: `Day ${s.atDays}: ${s.channel.replace(/_/g, ' ')}` }), el('span', { text: ` — ${s.message}` })))),
      st.chase_schedule.nextAction
        ? el('p', { class: 'next-action' }, el('strong', { text: `Next (day ${st.chase_schedule.nextAction.atDays}, in ${st.chase_schedule.nextAction.inDays} day(s)): ` }),
          el('span', { text: `${st.chase_schedule.nextAction.channel.replace(/_/g, ' ')} — ${st.chase_schedule.nextAction.message}` }))
        : null,
      st.chase_schedule.escalated ? el('div', { class: 'warn-box' }, 'This account is past the escalation threshold. Further credit is blocked automatically until it is cleared or restructured.') : null));
  }

  host.appendChild(el('div', { class: 'two-col' },
    el('section', { class: 'card' },
      el('h2', { class: 'card-title', text: 'Ledger' }),
      table([
        { key: 'entry_date', label: 'Date' },
        { key: 'entry_type', label: 'Type', render: (r) => badge(String(r.entry_type).replace(/_/g, ' ').toLowerCase(), r.direction === 'DEBIT' ? 'bad' : 'good') },
        { key: 'reference', label: 'Reference' },
        { key: 'due_date', label: 'Due' },
        { key: 'amount', label: 'Amount', align: 'right', render: (r) => `${r.direction === 'DEBIT' ? '' : '−'}${money(r.amount)}` },
      ], st.entries || [], { dense: true, empty: 'No ledger entries.' })),
    el('section', { class: 'card' },
      el('h2', { class: 'card-title', text: 'Instalment plans' }),
      st.plans && st.plans.length
        ? table([
          { key: 'plan_number', label: 'Plan' },
          { key: 'model', label: 'Model', render: (r) => badge(String(r.model).replace(/_/g, ' ').toLowerCase(), 'neutral') },
          { key: 'outstanding', label: 'Outstanding', align: 'right', render: (r) => money(r.outstanding) },
          { key: 'next_due_date', label: 'Next due' },
          { key: 'days_overdue', label: 'Days late', align: 'right', render: (r) => Number(r.days_overdue) > 0 ? badge(`${r.days_overdue}d`, 'bad') : '—' },
          { key: 'status', label: 'Status', render: (r) => badge(String(r.status).toLowerCase(), toneForStatus(r.status)) },
        ], st.plans, { dense: true, rowKey: 'plan_id', onRow: (r) => ctx.navigate(`/operations?tab=plans&id=${encodeURIComponent(r.plan_id)}`) })
        : el('p', { class: 'muted', text: 'No instalment plans.' }),
      el('h2', { class: 'card-title', text: 'Chase history' }),
      st.chase_log && st.chase_log.length
        ? table([
          { key: 'created_at', label: 'When', render: (r) => String(r.created_at || '').slice(0, 16) },
          { key: 'channel', label: 'Channel', render: (r) => String(r.channel).replace(/_/g, ' ') },
          { key: 'outcome', label: 'Outcome', render: (r) => badge(String(r.outcome).replace(/_/g, ' ').toLowerCase(), r.outcome === 'PROMISE_TO_PAY' ? 'warn' : r.outcome === 'SETTLED' ? 'good' : 'neutral') },
          { key: 'promised_date', label: 'Promised' },
          { key: 'notes', label: 'Notes' },
        ], st.chase_log, { dense: true })
        : el('p', { class: 'muted', text: 'Nothing logged yet. Record every call — "we have been chasing them" is an assertion without evidence, and the same customer gets called three times in a day by three different branches.' }),
    )));
}

function takePayment(customer, ctx) {
  const amountF = field({ label: 'Amount received (₦)', name: 'amount', type: 'number', min: '0.01', step: '0.01', required: true });
  const methodF = field({ label: 'Method', name: 'method', type: 'select', choices: ['CASH', 'POS_TERMINAL', 'BANK_TRANSFER', 'MOBILE_MONEY', 'USSD'] });
  const refF = field({ label: 'Reference', name: 'reference', hint: 'Required for a transfer, POS or wallet payment. Without it the receipt cannot be matched to the bank, which is how a shop "loses" money it actually received.' });
  const notesF = field({ label: 'Notes', name: 'notes', type: 'textarea', rows: 2 });
  const info = el('p', { class: 'hint' });
  const form = el('form', { onsubmit: async (ev) => {
    ev.preventDefault();
    const v = readForm(form);
    const needsRef = ['POS_TERMINAL', 'BANK_TRANSFER', 'MOBILE_MONEY', 'USSD'].includes(v.method);
    if (needsRef && !v.reference) { toast('Enter the reference from the transfer alert or POS receipt.', { kind: 'warn', duration: 7000 }); refF.querySelector('input').focus(); return; }
    try {
      const res = await api.customerPayment(customer.id, v, newIdempotencyKey('pay'));
      m.close();
      let msg = `Recorded ${money(v.amount)} against ${customer.name}.`;
      if (res.allocation && res.allocation.length) {
        msg += ` Settled ${res.allocation.filter((a) => a.settled_in_full).length} item(s) in full.`;
      }
      if (res.unapplied > 0) {
        // Not a dropped amount and not extra revenue: it is money we hold that we
        // owe back in goods or cash.
        msg += ` ${money(res.unapplied)} did not match any open debt and is held as a customer advance.`;
      }
      toast(msg, { kind: 'good', duration: 8000 });
      ctx.rerender();
    } catch (e) { reportError(e, { context: 'The payment could not be recorded' }); }
  } }, amountF, methodF, refF, notesF, info,
  el('div', { class: 'row-end' },
    el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => m.close() }, 'Cancel'),
    el('button', { type: 'submit', class: 'btn btn-primary' }, 'Record payment')));
  const m = modal({ title: `Payment from ${customer.name}`, size: 'sm', body: form });
  methodF.querySelector('select').addEventListener('change', (ev) => {
    const needsRef = ['POS_TERMINAL', 'BANK_TRANSFER', 'MOBILE_MONEY', 'USSD'].includes(ev.target.value);
    refF.querySelector('input').required = needsRef;
    info.textContent = needsRef ? 'A reference is required so this can be reconciled against the settlement report.' : '';
  });
}

function newCustomer(ctx) {
  const nameF = field({ label: 'Name', name: 'name', required: true });
  const companyF = field({ label: 'Company', name: 'company_name' });
  const phoneF = field({ label: 'Phone', name: 'phone', type: 'tel', placeholder: '0803…', hint: 'Normalised to 0XXXXXXXXXX. A delivery, a receipt and a chase all need it.' });
  const classF = field({ label: 'Customer class', name: 'customer_class', type: 'select', choices: ['RETAIL', 'TRADE', 'WHOLESALE', 'DISTRIBUTOR', 'CORPORATE', 'STAFF'], hint: 'The class sets the default discount tier and whether the customer may buy on account at all.' });
  const typeF = field({ label: 'Type', name: 'customer_type', type: 'select', choices: ['INDIVIDUAL', 'COMPANY', 'GOVERNMENT', 'NGO'] });
  const limitF = field({ label: 'Credit limit (₦)', name: 'credit_limit', type: 'number', min: 0, step: '0.01', hint: 'Leave blank for no limit. A limit is only meaningful with terms — set both.' });
  const termsF = field({ label: 'Terms', name: 'terms_code', type: 'select', choices: ['CASH', 'NET_7', 'NET_14', 'NET_30', 'NET_60', 'NET_90', 'ON_DELIVERY', 'MILESTONE'] });
  const tinF = field({ label: 'TIN', name: 'tin', hint: 'Needed before a withholding-tax exemption can be argued, and for a corporate invoice.' });
  const form = el('form', { onsubmit: async (ev) => {
    ev.preventDefault();
    const v = readForm(form);
    try {
      const created = await api.createCustomer({ ...v, business_id: state.activeBusinessId, home_branch_id: state.activeBranchId });
      m.close();
      toast(`${created.name} added.`, { kind: 'good', duration: 3000 });
      ctx.navigate(`/customers?id=${encodeURIComponent(created.id)}`);
    } catch (e) { reportError(e, { context: 'The customer could not be saved' }); }
  } }, nameF, companyF, phoneF, classF, typeF, limitF, termsF, tinF,
  el('div', { class: 'row-end' }, el('button', { type: 'submit', class: 'btn btn-primary' }, 'Save customer')));
  const m = modal({ title: 'New customer', body: form });
}
