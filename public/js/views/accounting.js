// =====================================================================
// public/js/views/accounting.js — the books: P&L, balance sheet, trial
// balance, VAT return and withholding tax
// =====================================================================
// The value of a ledger is that a mistake is VISIBLE. A report derived from
// operational tables can be wrong in a way nobody can check; a trial balance
// that does not balance is wrong in a way anyone can see in one query. So this
// screen always shows whether the books balance, and says so in words rather
// than leaving it to be inferred from two columns.

'use strict';

import { endpoints as api } from '../api.js';
import { state, activeBusiness, canSeeMultipleBusinesses, atLeast, todayWat } from '../state.js';
import { el, clear, badge, toneForStatus, table, money, spinner, reportError, toast, modal, field, readForm, emptyState, statCard } from '../ui.js';

export default async function accountingView(ctx) {
  const host = ctx.host;
  const tab = ctx.query.tab || 'pl';
  const business = activeBusiness();

  host.appendChild(el('header', { class: 'view-head' },
    el('div', {}, el('h1', { text: 'Accounting & tax' }),
      el('p', { class: 'muted', text: canSeeMultipleBusinesses() && !ctx.query.business_id
        ? 'Consolidated across every business you can see. Pick one for a VAT return — it is filed per registered business.'
        : `${business ? business.name : ''}` })),
    el('div', { class: 'view-actions' },
      el('button', { class: 'btn btn-ghost', onclick: () => checkIntegrity(ctx) }, 'Check ledger integrity'))));

  host.appendChild(el('nav', { class: 'tabs' },
    ['pl', 'balance', 'trial', 'vat', 'wht'].map((k) => el('a', {
      href: `/accounting?tab=${k}`, class: `tab${tab === k ? ' active' : ''}`,
      onclick: (ev) => { ev.preventDefault(); ctx.navigate(`/accounting?tab=${k}${ctx.query.business_id ? `&business_id=${ctx.query.business_id}` : ''}`); },
    }, { pl: 'Profit & loss', balance: 'Balance sheet', trial: 'Trial balance', vat: 'VAT return', wht: 'Withholding tax' }[k]))));

  const body = el('div', {}, spinner());
  host.appendChild(body);

  try {
    if (tab === 'pl') await renderPL(body, ctx);
    else if (tab === 'balance') await renderBalance(body, ctx);
    else if (tab === 'trial') await renderTrial(body, ctx);
    else if (tab === 'vat') await renderVat(body, ctx);
    else await renderWht(body, ctx);
  } catch (e) {
    clear(body);
    // A 400/403 with BUSINESS_SELECTION_REQUIRED or BUSINESS_REQUIRED is not an error, it is a question.
    if (e.code === 'BUSINESS_SELECTION_REQUIRED' || e.code === 'BUSINESS_REQUIRED') {
      body.appendChild(chooseBusiness(ctx, e.message));
    } else {
      body.appendChild(emptyState('This report could not be produced', e.message || String(e), 'Try again', () => ctx.rerender()));
    }
  }
  return {};
}

function chooseBusiness(ctx, message) {
  if (!state.businesses || !state.businesses.length) {
    return el('section', { class: 'card' },
      el('h2', { class: 'card-title', text: 'No business found' }),
      el('p', { class: 'modal-message', text: 'Create a business profile first under Administration → Businesses to view accounting reports.' }),
      el('div', { class: 'button-list', style: { marginTop: '1rem' } },
        el('button', { class: 'btn btn-primary', onclick: () => ctx.navigate('/admin?tab=businesses') }, 'Add a business')));
  }
  return el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: 'Which business?' }),
    el('p', { class: 'modal-message', text: message }),
    el('div', { class: 'button-list', style: { marginTop: '1rem' } }, state.businesses.map((b) => el('button', {
      class: 'btn btn-primary',
      onclick: () => ctx.navigate(`/accounting?tab=${ctx.query.tab || 'pl'}&business_id=${encodeURIComponent(b.id)}`),
    }, b.trading_name || b.name))));
}

async function renderPL(body, ctx) {
  const period = ctx.query.period || todayWat().slice(0, 7);
  const pl = await api.profitAndLoss({ period, business_id: ctx.query.business_id });
  clear(body);
  body.appendChild(periodPicker(period, ctx, 'pl'));

  if (!pl.balanced) {
    body.appendChild(el('div', { class: 'error-box' },
      el('strong', { text: 'THE LEDGER DOES NOT BALANCE. ' }),
      'Do not rely on this report until it is fixed. Run the integrity check from the header — it names the entries whose debits and credits disagree.'));
  }

  body.appendChild(el('div', { class: 'stat-grid' },
    statCard({ label: 'Net revenue', value: money(pl.net_revenue), sub: `gross ${money(pl.revenue)} less returns and discounts`, icon: 'chart' }),
    statCard({ label: 'Gross profit', value: money(pl.gross_profit), sub: `${pl.gross_margin_percent}% margin`, tone: pl.gross_margin_percent > 0 ? 'good' : 'bad' }),
    statCard({ label: 'Operating profit', value: money(pl.operating_profit), sub: `after ${money(pl.opex)} of expenses` }),
    statCard({ label: 'Net profit', value: money(pl.net_profit), sub: `${pl.net_margin_percent}% of revenue`, tone: pl.net_profit >= 0 ? 'good' : 'bad' }),
  ));

  const lineTable = (title, rows, showPct) => el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: title }),
    rows.length ? table([
      { key: 'code', label: 'Account' , render: (r) => `${r.code} · ${r.name}` },
      { key: 'balance', label: 'Amount', align: 'right', render: (r) => money(r.balance) },
      showPct && Number(pl.net_revenue) > 0
        ? { key: 'pct', label: '% of revenue', align: 'right', render: (r) => `${((Math.abs(r.balance_kobo / 100) / pl.net_revenue) * 100).toFixed(1)}%` }
        : null,
    ].filter(Boolean), rows, { dense: true }) : el('p', { class: 'muted', text: 'Nothing posted in this period.' }));

  body.appendChild(lineTable('Revenue', [...(pl.lines.revenue || []), ...(pl.lines.returns || []), ...(pl.lines.discounts || []), ...(pl.lines.other_income || [])], true));
  body.appendChild(lineTable('Cost of sales', pl.lines.cogs || [], true));
  body.appendChild(lineTable('Operating expenses', pl.lines.opex || [], true));
  if ((pl.lines.other || []).length) body.appendChild(lineTable('Other', pl.lines.other, false));

  body.appendChild(el('p', { class: 'hint', text: 'Revenue is net of VAT: the VAT is collected for FIRS and is a liability from the moment of sale. Booking the gross would overstate turnover by 7.5% and then make it impossible to produce a VAT return from the ledger. Shrinkage and damage sit in cost of sales on their own accounts rather than buried in COGS, because that is the number an owner most needs to see separately.' }));
  if (pl.consolidated) {
    body.appendChild(el('section', { class: 'card' },
      el('h2', { class: 'card-title', text: 'By business' }),
      table([
        { key: 'business_name', label: 'Business' },
        { key: 'net_revenue', label: 'Net revenue', align: 'right', render: (r) => money(r.net_revenue) },
        { key: 'net_profit', label: 'Net profit', align: 'right', render: (r) => el('strong', { class: r.net_profit >= 0 ? 'text-good' : 'text-bad', text: money(r.net_profit) }) },
      ], pl.businesses || [], { dense: true }),
      el('p', { class: 'hint', text: 'Margin percentages are recomputed from the summed figures rather than averaged: averaging two percentages weights a small branch the same as a large one, which is not what the number means.' })));
  }
}

function periodPicker(period, ctx, tab) {
  const input = el('input', { type: 'month', value: period });
  return el('div', { class: 'filter-bar' },
    el('label', {}, 'Period', input),
    el('button', { class: 'btn btn-primary', onclick: () => ctx.navigate(`/accounting?tab=${tab}&period=${input.value}${ctx.query.business_id ? `&business_id=${ctx.query.business_id}` : ''}`) }, 'Show'),
    el('span', { class: 'muted', text: 'Periods are West Africa Time months.' }));
}

async function renderBalance(body, ctx) {
  const asOf = ctx.query.as_of || todayWat();
  const bs = await api.balanceSheet({ as_of: asOf, business_id: ctx.query.business_id });
  clear(body);
  const dateInput = el('input', { type: 'date', value: asOf });
  body.appendChild(el('div', { class: 'filter-bar' }, el('label', {}, 'As at', dateInput),
    el('button', { class: 'btn btn-primary', onclick: () => ctx.navigate(`/accounting?tab=balance&as_of=${dateInput.value}${ctx.query.business_id ? `&business_id=${ctx.query.business_id}` : ''}`) }, 'Show')));

  if (!bs.balances) {
    body.appendChild(el('div', { class: 'error-box' },
      el('strong', { text: `THE BALANCE SHEET IS OUT BY ${money(bs.out_by)}. ` }),
      'Assets do not equal liabilities plus equity plus the cumulative result. Something has been posted to the wrong side. Run the integrity check.'));
  } else {
    body.appendChild(el('div', { class: 'ok-box' }, 'The balance sheet balances: assets equal liabilities plus equity plus the cumulative trading result.'));
  }

  const side = (title, rows) => el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: title }),
    rows.length ? table([
      { key: 'code', label: 'Account', render: (r) => `${r.code} · ${r.name}` },
      { key: 'balance', label: 'Balance', align: 'right', render: (r) => money(r.balance) },
    ], rows, { dense: true }) : el('p', { class: 'muted', text: 'Nothing posted.' }));

  body.appendChild(el('div', { class: 'two-col' },
    side('Assets', bs.lines.assets || []),
    el('div', {},
      side('Liabilities', bs.lines.liabilities || []),
      side('Equity', bs.lines.equity || []),
      el('section', { class: 'card' },
        el('h2', { class: 'card-title', text: 'Cumulative result' }),
        el('dl', { class: 'money-rows' },
          el('div', {}, el('dt', { text: 'Retained earnings to date' }), el('dd', { text: money(bs.current_period_earnings) })),
          el('div', { class: 'money-total' }, el('dt', { text: 'Total equity & liabilities' }), el('dd', { text: money(bs.total_equity_and_liabilities) })),
          el('div', { class: 'money-total' }, el('dt', { text: 'Total assets' }), el('dd', { text: money(bs.assets) }))),
        el('p', { class: 'hint', text: 'Earnings are cumulative since inception, not for one period. Filtering them to a single month would make the sheet balance only in the first month the business traded.' })))));
}

async function renderTrial(body, ctx) {
  const tb = await api.trialBalance({ business_id: ctx.query.business_id, as_of: ctx.query.as_of });
  clear(body);
  body.appendChild(tb.balanced
    ? el('div', { class: 'ok-box' }, `In balance: total debits ${money(tb.total_debit)} equal total credits ${money(tb.total_credit)} across ${(tb.accounts || []).length} accounts.`)
    : el('div', { class: 'error-box' }, el('strong', { text: `OUT OF BALANCE BY ${money(tb.difference)}. ` }), 'Debits are ', money(tb.total_debit), ' and credits are ', money(tb.total_credit), '. Do not rely on any report derived from this until it is found and fixed.'));
  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: 'Trial balance' }),
    table([
      { key: 'code', label: 'Account', render: (r) => `${r.code} · ${r.name}` },
      { key: 'account_type', label: 'Type', render: (r) => badge(r.account_type.toLowerCase(), 'neutral') },
      { key: 'debit', label: 'Debit', align: 'right', render: (r) => Number(r.debit) ? money(r.debit) : '—' },
      { key: 'credit', label: 'Credit', align: 'right', render: (r) => Number(r.credit) ? money(r.credit) : '—' },
      { key: 'balance', label: 'Balance', align: 'right', render: (r) => el('strong', { text: money(r.balance) }) },
    ], tb.accounts || [], { dense: true, empty: 'Nothing posted yet.' })));
}

async function renderVat(body, ctx) {
  const period = ctx.query.period || todayWat().slice(0, 7);
  const v = await api.vatReturn({ period, business_id: ctx.query.business_id });
  clear(body);
  body.appendChild(periodPicker(period, ctx, 'vat'));
  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: `VAT return — ${period}` }),
    el('p', { class: 'hint', text: 'Derived from the ledger alone, so it can be reconciled against the trial balance rather than re-computed from sales and purchases by a different route.' }),
    el('dl', { class: 'money-rows' },
      el('div', {}, el('dt', { text: 'Chargeable (taxable) sales' }), el('dd', { text: money(v.chargeable_sales) })),
      el('div', {}, el('dt', { text: 'VAT-exempt sales' }), el('dd', { text: money(v.exempt_sales) })),
      el('div', {}, el('dt', { text: `Output VAT @ ${v.ratePercent || 7.5}%` }), el('dd', { text: money(v.outputVat) })),
      el('div', {}, el('dt', { text: 'Input VAT on purchases and expenses' }), el('dd', { text: money(v.inputVat) })),
      el('div', { class: 'money-total' }, el('dt', { text: v.position === 'REFUNDABLE' ? 'Refundable from FIRS' : v.position === 'NIL' ? 'Nil return' : 'Payable to FIRS' }), el('dd', { text: money(v.netPayable) }))),
    el('div', { class: v.position === 'PAYABLE' ? 'warn-box' : 'ok-box' },
      v.position === 'PAYABLE'
        ? `File and pay on or before the 21st of the following month. ${v.note || ''}`
        : v.position === 'REFUNDABLE'
          ? 'Input VAT exceeds output VAT this period — a refund position. Carry it forward or claim it.'
          : 'A nil return this period.'),
    v.business && v.business.vat_registration_no
      ? el('p', { class: 'muted', text: `Registered as ${v.business.name}, VAT Reg. No. ${v.business.vat_registration_no}, TIN ${v.business.tin || '—'}.` })
      : el('div', { class: 'warn-box' }, 'This business has no VAT registration number recorded. If it is registered, add the number under Administration → Business profile — receipts must show it and a customer cannot claim input VAT without it.')));
  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: 'How this is computed' }),
    el('p', { class: 'hint', text: 'VAT is EXTRACTED from shelf prices, never added on top: a Nigerian retail price already includes it, so registering for VAT must not raise what a customer pays. Exempt categories — basic food provisions, baby products, agricultural inputs, stationery — are excluded from the taxable base, and the sale-level VAT is allocated across lines by largest remainder so the sum of the lines always equals the total on the sale.' })));
}

async function renderWht(body, ctx) {
  const [rates, entries] = await Promise.all([api.whtRates(), api.whtEntries()]);
  clear(body);
  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: 'Rate schedule' }),
    el('p', { class: 'hint', text: `${rates.statutory_reference}. Our company size is ${String(rates.our_company_size).toLowerCase()}, so the highlighted column is the one that applies to us. Rates are data in the database — a change to the Regulations is an update, not a deployment.` }),
    table([
      { key: 'code', label: 'Type' },
      { key: 'description', label: 'Description' },
      { key: 'rate_percent_small', label: 'Small', align: 'right', render: (r) => pct(r.rate_percent_small, rates.our_company_size === 'SMALL') },
      { key: 'rate_percent_medium', label: 'Medium', align: 'right', render: (r) => pct(r.rate_percent_medium, rates.our_company_size === 'MEDIUM') },
      { key: 'rate_percent_large', label: 'Large', align: 'right', render: (r) => pct(r.rate_percent_large, rates.our_company_size === 'LARGE') },
      { key: 'direction', label: 'Direction', render: (r) => badge(String(r.direction).toLowerCase(), r.direction === 'BOTH' ? 'neutral' : 'info') },
      { key: 'applicable_percent', label: 'Applies to us', align: 'right', render: (r) => el('strong', { text: `${r.applicable_percent}%` }) },
    ], rates.rates || [], { dense: true }),
    el('p', { class: 'hint', text: rates.exemption_note })));

  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title' }, 'Entries', el('button', { class: 'btn btn-sm btn-primary', onclick: () => newEntry(rates.rates, ctx) }, 'Record WHT')),
    table([
      { key: 'entry_date', label: 'Date' },
      { key: 'rate_code', label: 'Type' },
      { key: 'direction', label: 'Direction', render: (r) => badge(String(r.direction).toLowerCase(), r.direction === 'PAYABLE' ? 'warn' : 'info') },
      { key: 'counterparty_name', label: 'Counterparty' },
      { key: 'gross_amount', label: 'Gross', align: 'right', render: (r) => money(r.gross_amount) },
      { key: 'rate_percent', label: 'Rate', align: 'right', render: (r) => `${r.rate_percent}%` },
      { key: 'wht_amount', label: 'WHT', align: 'right', render: (r) => money(r.wht_amount) },
      { key: 'net_amount', label: 'Net', align: 'right', render: (r) => el('strong', { text: money(r.net_amount) }) },
      { key: 'remittance_due_date', label: 'Remit by', render: (r) => r.remittance_due_date || '—' },
      { key: 'status', label: 'Status', render: (r) => badge(String(r.status).replace(/_/g, ' ').toLowerCase(), toneForStatus(r.status)) },
    ], entries || [], { dense: true, empty: 'No withholding-tax entries yet.' }),
    el('p', { class: 'hint', text: rates.remittance_note })));
}

function pct(v, highlight) {
  return highlight ? el('strong', { class: 'text-good', text: `${v}%` }) : `${v}%`;
}

function newEntry(rates, ctx) {
  const dirF = field({ label: 'Direction', name: 'direction', type: 'select', choices: [
    { value: 'PAYABLE', label: 'PAYABLE — we deduct from a supplier' },
    { value: 'RECEIVABLE', label: 'RECEIVABLE — a customer deducts from us' },
  ] });
  const rateF = field({ label: 'Type', name: 'rate_code', type: 'select', choices: (rates || []).map((r) => ({ value: r.code, label: `${r.description} (${r.code})` })) });
  const grossF = field({ label: 'Gross amount (₦)', name: 'gross_amount', type: 'number', min: '0.01', step: '0.01', required: true, hint: 'Enter the invoice value. The net is derived by subtraction — grossing up would be the prohibited "WHT as an additional contract cost" practice.' });
  const partyF = field({ label: 'Counterparty', name: 'counterparty_name', required: true });
  const tinF = field({ label: 'Counterparty TIN', name: 'counterparty_tin', hint: 'Without a TIN the small-company exemption cannot be argued.' });
  const sizeF = field({ label: 'Our company size for this entry', name: 'company_size', type: 'select', choices: ['SMALL', 'MEDIUM', 'LARGE'], hint: 'Turnover ≤ ₦25m is small, ≤ ₦100m is medium, above that is large. The 2024 Regulations differentiate the rate by it.' });
  const computed = el('div', { class: 'receive-preview muted' });
  function recompute() {
    const gross = Number(grossF.querySelector('input').value) || 0;
    const rate = (rates || []).find((r) => r.code === rateF.querySelector('select').value);
    if (!gross || !rate) { computed.textContent = ''; return; }
    const pctValue = Number(rate.applicable_percent) || 0;
    const wht = Math.round(gross * pctValue) / 100;
    computed.textContent = `Gross ${money(gross)} − WHT ${money(wht)} (${pctValue}%) = net ${money(gross - wht)}.`;
  }
  [grossF, rateF].forEach((f) => { const n = f.querySelector('input,select'); if (n) n.addEventListener('input', recompute); });
  const hint = el('p', { class: 'hint' });
  const form = el('form', { onsubmit: async (ev) => {
    ev.preventDefault();
    const v = readForm(form);
    try {
      const res = await api.whtEntry({ ...v, business_id: state.activeBusinessId, branch_id: state.activeBranchId, source_type: 'MANUAL' });
      m.close();
      let msg = `Recorded: gross ${money(res.gross)}, WHT ${money(res.wht)} at ${res.ratePercent}%, net ${money(res.net)}. Remit by ${res.remittance_due_date}.`;
      if (res.exemption_hint) msg += ` ${res.exemption_hint}`;
      toast(msg, { kind: 'good', duration: 11000 });
      ctx.rerender();
    } catch (e) { reportError(e, { context: 'The entry could not be recorded' }); }
  } }, dirF, rateF, grossF, partyF, tinF, sizeF, computed, hint,
  el('div', { class: 'row-end' }, el('button', { type: 'submit', class: 'btn btn-primary' }, 'Record entry')));
  dirF.querySelector('select').addEventListener('change', (ev) => {
    hint.textContent = ev.target.value === 'RECEIVABLE'
      ? 'A RECEIVABLE entry is an asset until the customer\'s credit note arrives — it appears on the receivables list so it can be chased. A rate that is receivable-only cannot be booked as payable, and the reverse.'
      : '';
  });
  const m = modal({ title: 'Record withholding tax', body: form });
  recompute();
}

async function checkIntegrity(ctx) {
  try {
    const r = await api.ledgerIntegrity({ business_id: ctx.query.business_id });
    modal({
      title: 'Ledger integrity',
      body: el('div', {},
        r.ok
          ? el('div', { class: 'ok-box' }, `${r.entries} journal entries, total debits ${money(r.total_debit)} equal total credits ${money(r.total_credit)}. Every entry balances.`)
          : el('div', { class: 'error-box' },
            el('strong', { text: `${r.unbalanced_entries.length} of ${r.entries} entries do not balance. ` }),
            'Do not rely on any accounting report until these are found. Each is listed below with the figures it claims and the figures its lines actually sum to.',
            table([
              { key: 'entry_number', label: 'Entry' },
              { key: 'entry_date', label: 'Date' },
              { key: 'stated_debit', label: 'Stated DR', align: 'right' },
              { key: 'stated_credit', label: 'Stated CR', align: 'right' },
              { key: 'actual_debit', label: 'Actual DR', align: 'right' },
              { key: 'actual_credit', label: 'Actual CR', align: 'right' },
            ], r.unbalanced_entries.slice(0, 50), { dense: true }))),
      footer: el('div', { class: 'row-end' }, el('button', { class: 'btn btn-primary', onclick: (ev) => { ev.target.closest('.modal-host').hidden = true; } }, 'Close')),
    });
  } catch (e) { reportError(e, { context: 'The integrity check could not run' }); }
}
