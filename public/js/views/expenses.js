'use strict';
// =====================================================================
// public/js/views/expenses.js — MONEY OUT THAT IS NOT STOCK
// =====================================================================
// Rent, diesel for the generator, the boy who sweeps the shop, a signwriter, a
// lawyer, the NEPA bill that arrives whether or not the power does. None of it
// is stock, all of it is money, and leaving it in a paper book is how a business
// with good sales ends the year with nothing to show.
//
// Two tax facts are handled HERE, at the point of entry, rather than at
// month-end when the receipt has been lost:
//
//   VAT   — an expense with a VAT-inclusive amount has the tax extracted, not
//           added, so the input VAT that can be claimed is real.
//   WHT   — under the 2024 Withholding Regulations (effective 1 January 2025) the
//           payer withholds and remits by the 21st of the following month. An
//           expense recorded gross with no withholding line is a liability
//           nobody has booked.
//
// So the form asks for the amount, whether it already includes VAT, and which
// withholding applies — in that order, because that is the order the invoice
// reads in.
// =====================================================================
(function (global) {
  const SR = global.SR;
  const ui = SR.ui;
  const U = SR.util;

  const CATEGORIES = [
    'RENT', 'UTILITIES', 'ELECTRICITY', 'FUEL', 'DIESEL', 'GENERATOR', 'TRANSPORT', 'HAULAGE',
    'SALARIES', 'WAGES', 'SECURITY', 'CLEANING', 'MAINTENANCE', 'REPAIRS', 'MARKETING',
    'ADVERTISING', 'PRINTING', 'BANK_CHARGES', 'LEGAL', 'AUDIT', 'LICENCES', 'PERMITS',
    'TELECOM', 'INTERNET', 'WATER', 'RATES', 'INSURANCE', 'TRAINING', 'CONSUMABLES', 'OTHER',
  ];
  const WHT_CODES = [
    { value: '', label: 'None' },
    { value: 'SERVICES', label: '5% — services' },
    { value: 'PROFESSIONAL', label: '10% — professional fees' },
    { value: 'RENT', label: '10% — rent' },
    { value: 'DIRECTORS_FEES', label: '10% — directors\' fees' },
    { value: 'CONSTRUCTION', label: '2.5% — construction' },
    { value: 'SUPPLY_OF_GOODS', label: '2% — supply of goods' },
  ];

  async function render(ctx) {
    ctx.setTitle('Expenses');
    const settings = SR.state.settings || {};
    const state = { page: 0, pageSize: 50, status: ctx.query.status || '', category: ctx.query.category || '', days: 30 };

    const wrap = ui.h('div', { class: 'stack' });
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Expenses'),
        ui.h('p', { class: 'sub' }, `${SR.state.activeBranchName()} · what the business spent, with the VAT and withholding already extracted`)),
      ui.h('div', { class: 'actions' },
        ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => openCreate() }, 'Record an expense'),
        ui.h('button', { class: 'btn btn-sm', onClick: () => exportList() }, 'Export'))));

    const toolbar = ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body row' }));
    const statusSel = ui.h('select', { onchange: (e) => { state.status = e.target.value; state.page = 0; load(); } });
    for (const [v, l] of [['', 'Any status'], ['PENDING_APPROVAL', 'Awaiting approval'], ['APPROVED', 'Approved'], ['REJECTED', 'Rejected']]) {
      statusSel.appendChild(ui.h('option', { value: v, selected: v === state.status }, l));
    }
    const catSel = ui.h('select', { onchange: (e) => { state.category = e.target.value; state.page = 0; load(); } });
    catSel.appendChild(ui.h('option', { value: '' }, 'Any category'));
    for (const c of CATEGORIES) catSel.appendChild(ui.h('option', { value: c, selected: c === state.category }, U.humanise(c)));
    const daysSel = ui.h('select', { onchange: (e) => { state.days = Number(e.target.value); state.page = 0; load(); } });
    for (const [v, l] of [[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [365, 'Last year']]) {
      daysSel.appendChild(ui.h('option', { value: v, selected: v === state.days }, l));
    }
    toolbar.firstElementChild.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Status'), statusSel));
    toolbar.firstElementChild.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Category'), catSel));
    toolbar.firstElementChild.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Period'), daysSel));
    wrap.appendChild(toolbar);

    const summaryHost = ui.h('div', {});
    wrap.appendChild(summaryHost);
    const host = ui.h('div', {});
    wrap.appendChild(host);

    async function exportList() {
      try {
        await SR.exporter.list({
          filename: 'expenses',
          path: '/api/expenses',
          query: SR.state.query({ days: state.days, status: state.status || undefined, category: state.category || undefined }),
          mirrorTable: 'expenses',
          columns: [
            { key: 'expense_date', label: 'Date' }, { key: 'category', label: 'Category' },
            { key: 'description', label: 'Description' }, { key: 'payee', label: 'Payee' },
            { key: 'amount', label: 'Amount' }, { key: 'vat_amount', label: 'VAT' },
            { key: 'wht_amount', label: 'WHT withheld' }, { key: 'net_amount', label: 'Net paid' },
            { key: 'payment_method', label: 'Paid from' }, { key: 'status', label: 'Status' },
            { key: 'created_by_name', label: 'Recorded by' },
          ],
        });
      } catch (err) { ui.apiError(err); }
    }

    async function load() {
      host.replaceChildren(ui.skeleton(6));
      let data; let offline = false;
      try {
        data = await SR.api.get('/api/expenses', {
          query: SR.state.query({ days: state.days, status: state.status || undefined, category: state.category || undefined, limit: state.pageSize, offset: state.page * state.pageSize }),
        });
      } catch (err) {
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: load } })); return; }
        offline = true;
        const all = await SR.store.all('expenses', { where: (e) => !Number(e.is_deleted) });
        const from = U.addDays(U.todayWat(), -state.days);
        let rows = all.filter((e) => String(e.expense_date) >= from);
        if (state.status) rows = rows.filter((e) => String(e.status).toUpperCase() === state.status);
        if (state.category) rows = rows.filter((e) => String(e.category).toUpperCase() === state.category);
        rows.sort((a, b) => String(b.expense_date).localeCompare(String(a.expense_date)));
        data = {
          data: rows,
          paging: { total: rows.length, limit: rows.length, offset: 0 },
          summary: {
            amount: U.sum(rows, (e) => e.amount),
            whtWithheld: U.sum(rows, (e) => e.wht_amount),
            pendingApproval: rows.filter((e) => e.status === 'PENDING_APPROVAL').length,
          },
          byCategory: Array.from(U.groupBy(rows, (e) => e.category).entries()).map(([category, list]) => ({ category, amount: U.sum(list, (x) => x.amount), entries: list.length, wht: U.sum(list, (x) => x.wht_amount) })).sort((a, b) => b.amount - a.amount),
        };
      }
      const rows = data.data || [];
      const paging = data.paging || {};
      const s = data.summary || {};
      const byCategory = data.byCategory || [];
      const canApprove = SR.state.atLeast('MANAGER') && Number(settings.managers_can_approve_expenses) !== 0;

      summaryHost.replaceChildren(ui.h('div', { class: 'grid grid-4' },
        ui.kpi({ label: 'Spent in period', value: U.money(s.amount), foot: `${rows.length} entries`, small: true }),
        ui.kpi({ label: 'Withholding deducted', value: U.money(s.whtWithheld), foot: 'due to FIRS by the 21st of the next month', small: true }),
        ui.kpi({ label: 'Awaiting approval', value: String(s.pendingApproval || 0), tone: Number(s.pendingApproval) > 0 ? 'warn' : 'good', small: true }),
        ui.kpi({ label: 'Largest category', value: byCategory.length ? U.humanise(byCategory[0].category) : '—', foot: byCategory.length ? U.money(byCategory[0].amount) : null, small: true })));

      host.replaceChildren();
      if (offline) host.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'Offline — expenses already synced to this device, plus anything queued. Recording a new expense will be queued too.'));
      if (byCategory.length > 1) {
        host.appendChild(ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' },
          ui.h('h2', { style: { marginTop: 0 } }, 'Where the money went'),
          ui.bars(byCategory.slice(0, 10).map((c) => ({ label: U.humanise(c.category), value: Number(c.amount) })), { format: U.money, tone: 'b2' }))));
      }

      host.appendChild(ui.dataCard({
        title: 'Expenses',
        table: ui.renderTable({
          columns: [
            { key: 'expense_date', label: 'Date', render: (e) => U.date(e.expense_date) },
            { key: 'category', label: 'Category', render: (e) => ui.badge(e.category, 'badge-info') },
            { key: 'description', label: 'What it was for', className: 'wrap', render: (e) => {
              const cell = ui.h('div', {});
              cell.appendChild(ui.h('div', { style: { fontWeight: '600' } }, e.description));
              cell.appendChild(ui.h('div', { class: 'hint' }, [e.supplier_name, e.branch_name, e.created_by_name].filter(Boolean).join(' · ')));
              if (e.notes) cell.appendChild(ui.h('div', { class: 'hint' }, e.notes));
              return cell;
            } },
            { key: 'amount', label: 'Gross', align: 'right', render: (e) => U.money(e.amount) },
            { key: 'vat_amount', label: 'VAT in it', align: 'right', render: (e) => (Number(e.vat_amount) ? U.money(e.vat_amount) : '—') },
            { key: 'wht_amount', label: 'WHT', align: 'right', render: (e) => (Number(e.wht_amount) ? ui.h('span', { style: { color: 'var(--amber-700)' } }, U.money(e.wht_amount)) : '—') },
            { key: 'net_amount', label: 'Net paid', align: 'right', render: (e) => U.money(e.net_amount != null ? e.net_amount : e.amount) },
            { key: 'status', label: '', render: (e) => ui.statusBadge(e.status) },
            { key: 'x', label: '', render: (e) => {
              const cell = ui.h('div', { class: 'btn-row' });
              if (e.status === 'PENDING_APPROVAL' && canApprove) {
                cell.appendChild(ui.h('button', { class: 'btn btn-sm btn-primary', onClick: (ev) => { ev.stopPropagation(); decide(e, true); } }, 'Approve'));
                cell.appendChild(ui.h('button', { class: 'btn btn-sm', onClick: (ev) => { ev.stopPropagation(); decide(e, false); } }, 'Reject'));
              }
              cell.appendChild(ui.h('button', { class: 'btn btn-sm', onClick: (ev) => { ev.stopPropagation(); openDetail(e); } }, 'Details'));
              return cell;
            } },
          ],
          rows,
          emptyTitle: 'Nothing recorded in this period',
          emptyMessage: 'Recorded expenses are what make a profit-and-loss statement mean anything. Rent, diesel and the generator are not optional extras — they are the cost of trading.',
          emptyAction: { label: 'Record an expense', run: () => openCreate() },
          foot: ['', '', 'Total', U.money(s.amount), '', U.money(s.whtWithheld), '', '', ''],
        }),
        pager: ui.pager({
          page: state.page, pageSize: paging.limit || state.pageSize, total: paging.total != null ? paging.total : rows.length,
          onPage: (p) => { state.page = p; load(); },
          onSize: (n) => { state.pageSize = n; state.page = 0; load(); },
        }),
      }));

      if (Number(s.whtWithheld) > 0) {
        host.appendChild(ui.h('div', { class: 'alert alert-info' },
          ui.h('strong', {}, `${U.money(s.whtWithheld)} of withholding was deducted in this period. `),
          'That is money the business is holding on FIRS\'s behalf, not money the business saved. It falls due by the 21st of the following month, and it is reported on the Accounting screen alongside VAT.'));
      }
    }

    function decide(expense, approved) {
      const proceed = async () => {
        let note = null;
        if (!approved) {
          note = await ui.promptDialog({
            title: 'Why is this being rejected?',
            label: 'Reason',
            required: true,
            hint: 'The reason is kept on the expense and shown to whoever recorded it.',
          });
          if (!note) return;
        }
        try {
          await SR.api.post(`/api/expenses/${encodeURIComponent(expense.id)}/approve`, { approved, note });
          ui.ok(approved ? 'Approved and posted to the ledger.' : 'Rejected.');
          load();
        } catch (err) { ui.apiError(err); }
      };
      if (approved) {
        ui.confirmDialog({
          title: `Approve ${U.money(expense.amount)}?`,
          message: `${expense.description} — ${U.humanise(expense.category)}${Number(expense.wht_amount) ? `, withholding ${U.money(expense.wht_amount)}` : ''}. Approving posts it to the general ledger and it can no longer be edited, only reversed.`,
          confirmLabel: 'Approve and post',
        }).then((yes) => { if (yes) proceed(); });
      } else proceed();
    }

    function openDetail(expense) {
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.kv([
        ['Date', U.date(expense.expense_date)],
        ['Category', U.humanise(expense.category)],
        ['Description', expense.description],
        ['Paid to', expense.supplier_name || 'cash payee, not a registered supplier'],
        ['Paid from', U.humanise(expense.payment_method || expense.paid_from || '')],
        ['Gross amount', U.money(expense.amount)],
        ['VAT extracted', Number(expense.vat_amount) ? U.money(expense.vat_amount) : 'none'],
        ['Withholding', Number(expense.wht_amount) ? `${U.money(expense.wht_amount)}${expense.wht_code ? ` (${expense.wht_code}${expense.wht_rate_percent ? ` @ ${expense.wht_rate_percent}%` : ''})` : ''}` : 'none'],
        ['Net paid out', U.money(expense.net_amount != null ? expense.net_amount : expense.amount)],
        ['Status', expense.status],
        ['Recorded by', expense.created_by_name],
        ['Notes', expense.notes],
      ]));
      if (Number(expense.wht_amount) > 0) {
        wrapEl.appendChild(ui.h('div', { class: 'alert alert-info', style: { marginTop: '10px' } },
          `On a gross of ${U.money(expense.amount)}, ${U.money(expense.net_amount != null ? expense.net_amount : Number(expense.amount) - Number(expense.wht_amount))} was paid to the payee and ${U.money(expense.wht_amount)} is owed to FIRS. Paying the gross and withholding nothing would have made that the business's own liability.`));
      }
      const m = ui.openModal({ title: 'Expense', body: wrapEl, size: 'narrow' });
      return m;
    }

    // ---------------- RECORD ----------------
    function openCreate() {
      const wrapEl = ui.h('div', {});
      const grid = ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Date', name: 'expense_date', type: 'date', value: U.todayWat(), required: true }),
        ui.field({ label: 'Category', name: 'category', value: 'UTILITIES', options: CATEGORIES.map((c) => ({ value: c, label: U.humanise(c) })), required: true }),
        ui.field({ label: 'Description', name: 'description', span: true, required: true, placeholder: 'e.g. PHED bill for September — shop and showroom', hint: '“Expense” cannot be approved or audited three months later.' }),
        ui.field({ label: 'Paid to (supplier)', name: 'supplier_id', placeholder: 'Search suppliers, or leave blank', hint: 'Pick one and the withholding can be credited to a TIN. Leave it blank for a cash payee.' }),
        ui.field({ label: 'Or type the payee\'s name', name: 'supplier_name', placeholder: 'e.g. PHED, or the signwriter on Ikwerre Road' }),
        ui.field({ label: 'Paid from', name: 'payment_method', value: 'CASH', options: ['CASH', 'BANK_TRANSFER', 'POS_TERMINAL', 'MOBILE_MONEY', 'CHEQUE', 'SAFE'].map((x) => ({ value: x, label: U.humanise(x) })), hint: 'Paying from the safe is checked against the safe balance before it is accepted.' }),
        ui.field({ label: 'Amount (₦)', name: 'amount', type: 'number', step: '0.01', min: '0.01', required: true, hint: 'The figure on the receipt.' }),
        ui.field({ label: 'Is that amount VAT-inclusive?', name: 'vat_inclusive', value: '1', options: [{ value: '1', label: 'Yes — extract the VAT from it and claim it back' }, { value: '', label: 'No — the business is not VAT-registered for this' }] }),
        ui.field({ label: 'Withholding', name: 'wht_code', value: '', options: WHT_CODES, hint: 'Rates come from the withholding table held on the server, so a change in the Regulations does not need a redeploy.' }),
        ui.field({ label: 'Reference', name: 'reference', placeholder: 'Receipt or invoice number' }),
        ui.field({ label: 'Notes', name: 'notes', type: 'textarea', span: true }));
      wrapEl.appendChild(grid);

      const preview = ui.h('div', { class: 'alert alert-info' }, '');
      wrapEl.appendChild(preview);
      const amountEl = wrapEl.querySelector('[name="amount"]');
      const vatEl = wrapEl.querySelector('[name="vat_inclusive"]');
      const whtEl = wrapEl.querySelector('[name="wht_code"]');
      const RATES = { SERVICES: 5, PROFESSIONAL: 10, RENT: 10, DIRECTORS_FEES: 10, CONSTRUCTION: 2.5, SUPPLY_OF_GOODS: 2 };
      function recompute() {
        const gross = Number(amountEl.value) || 0;
        const rate = Number(SR.state.settings && SR.state.settings.vat_rate_percent) || 7.5;
        const extractVat = vatEl.value === '1' && Number((SR.state.settings || {}).vat_enabled);
        const vat = extractVat ? U.round2(gross - (gross / (1 + rate / 100))) : 0;
        const net = U.round2(gross - vat);
        const whtRate = RATES[whtEl.value] || 0;
        const wht = U.round2(net * whtRate / 100);
        preview.replaceChildren();
        preview.appendChild(ui.h('div', {}, ui.h('strong', {}, `Gross ${U.money(gross)}`)));
        if (vat) preview.appendChild(ui.h('div', {}, `VAT inside it ${U.money(vat)} (${rate}%) — this is the input VAT the business can claim back.`));
        if (wht) preview.appendChild(ui.h('div', {}, `Withholding ${whtRate}% of ${U.money(net)} = ${U.money(wht)} — deducted from the gross and remitted to FIRS by the 21st of the next month.`));
        preview.appendChild(ui.h('div', { style: { marginTop: '6px' } },
          ui.h('strong', {}, wht ? `${U.money(U.round2(net - wht))} to the payee, ${U.money(wht)} to FIRS` : `${U.money(gross)} to the payee`)));
      }
      amountEl.addEventListener('input', recompute);
      vatEl.addEventListener('change', recompute);
      whtEl.addEventListener('change', recompute);
      recompute();

      const needsApproval = Number(settings.managers_can_approve_expenses) !== 0 && !SR.state.atLeast('MANAGER');
      if (needsApproval) {
        wrapEl.appendChild(ui.h('div', { class: 'hint' }, 'This will be recorded as awaiting approval. A manager approves it before it reaches the ledger.'));
      }

      const m = ui.openModal({
        title: 'Record an expense',
        body: wrapEl,
        size: 'wide',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: async (ev) => {
              const v = ui.readFormStrings(wrapEl);
              if (!(Number(v.amount) > 0)) { ui.warn('Enter the amount.'); return; }
              if (!v.description || String(v.description).trim().length < 4) { ui.warn('Describe what this was actually for.'); return; }
              ev.currentTarget.disabled = true;
              ev.currentTarget.textContent = 'Recording…';
              try {
                const result = await SR.api.post('/api/expenses', {
                  branch_id: SR.state.activeBranchId,
                  business_id: SR.state.activeBusinessId,
                  expense_date: v.expense_date,
                  category: v.category,
                  description: v.description,
                  supplier_id: v.supplier_id || null,
                  supplier_name: v.supplier_name || null,
                  payment_method: v.payment_method,
                  amount: Number(v.amount),
                  vat_registered: v.vat_inclusive === '1',
                  wht_code: v.wht_code || null,
                  reference: v.reference || null,
                  notes: v.notes || null,
                }, { queue: 'auto' });
                if (result && result.queued) ui.info('Offline — the expense is queued and will be recorded when the connection returns.');
                else ui.ok(result && result.status === 'PENDING_APPROVAL' ? 'Recorded and sent for approval.' : 'Expense recorded.');
                m.close();
                load();
              } catch (err) {
                ui.apiError(err);
                ev.currentTarget.disabled = false;
                ev.currentTarget.textContent = 'Record it';
              }
            },
          }, 'Record it'),
        ],
      });
    }

    await load();
    return wrap;
  }

  SR.views = SR.views || {};
  SR.views.expenses = { render, CATEGORIES, WHT_CODES };
}(window));
