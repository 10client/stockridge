'use strict';
// =====================================================================
// public/js/views/accounting.js — THE BOOKS
// =====================================================================
// Every figure on this screen is derived from the ledger, and the ledger is
// derived from things that happened: a sale, a receipt, a payment, a stock
// adjustment. Nobody types a balance sheet.
//
// That has one consequence worth designing around. When the books do not
// balance, the useful output is not a red number — it is a sentence saying how
// far out they are and what that means, because ₦0.01 and ₦400,000 require
// completely different reactions and the figure alone does not tell you which
// one you are looking at. So the trial balance leads with the message the server
// computed, and the tables follow it.
//
// The VAT and WHT tabs exist because both returns are due on the 21st of the
// following month, both are the business's own liability (not the customer's or
// the supplier's), and both are routinely missed by small businesses that are
// otherwise keeping good records.
// =====================================================================
(function (global) {
  const SR = global.SR;
  const ui = SR.ui;
  const U = SR.util;

  const TABS = [
    ['trial-balance', 'Trial balance'],
    ['profit-loss', 'Profit & loss'],
    ['balance-sheet', 'Balance sheet'],
    ['journal', 'Journal'],
    ['vat', 'VAT'],
    ['wht', 'Withholding tax'],
    ['accounts', 'Chart of accounts'],
  ];

  async function render(ctx) {
    ctx.setTitle('Accounting');
    const state = {
      tab: ctx.query.tab || 'trial-balance',
      from: ctx.query.from || U.addDays(U.todayWat(), -30),
      to: ctx.query.to || U.todayWat(),
      page: 0,
      pageSize: 50,
      branchScope: ctx.query.branch_scope === '1',
      q: '',
      sourceType: '',
    };

    const wrap = ui.h('div', { class: 'stack' });
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Accounting'),
        ui.h('p', { class: 'sub' }, `${SR.state.activeBusinessName()} · derived from the ledger, never typed in`)),
      ui.h('div', { class: 'actions' },
        SR.state.atLeast('OWNER') ? ui.h('button', { class: 'btn btn-sm', onClick: () => openJournal() }, 'Post a manual journal') : null)));

    // ---- period + scope controls. The trial balance and balance sheet are
    // as-at; the P&L and the tax tabs are for a period. Both controls stay on
    // screen so the user can always see what they are looking at.
    const toolbar = ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body row' }));
    const fromInput = ui.h('input', { type: 'date', value: state.from });
    const toInput = ui.h('input', { type: 'date', value: state.to });
    fromInput.addEventListener('change', () => { state.from = fromInput.value; state.page = 0; load(); });
    toInput.addEventListener('change', () => { state.to = toInput.value; state.page = 0; load(); });
    const scopeToggle = ui.h('button', {
      class: `btn btn-sm ${state.branchScope ? 'btn-primary' : ''}`,
      onClick: (ev) => {
        state.branchScope = !state.branchScope;
        ev.currentTarget.className = `btn btn-sm ${state.branchScope ? 'btn-primary' : ''}`;
        ev.currentTarget.textContent = state.branchScope ? `Branch: ${SR.state.activeBranchName()}` : 'Whole business';
        load();
      },
    }, state.branchScope ? `Branch: ${SR.state.activeBranchName()}` : 'Whole business');

    toolbar.firstElementChild.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'From'), fromInput));
    toolbar.firstElementChild.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'To'), toInput));
    toolbar.firstElementChild.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Scope'), scopeToggle));
    for (const [d, label] of [[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last quarter'], [365, 'Last year']]) {
      toolbar.firstElementChild.appendChild(ui.h('button', {
        class: 'btn btn-sm',
        onClick: () => {
          state.from = U.addDays(U.todayWat(), -d);
          state.to = U.todayWat();
          fromInput.value = state.from; toInput.value = state.to;
          state.page = 0; load();
        },
      }, label));
    }
    wrap.appendChild(toolbar);

    const tabs = ui.h('div', { class: 'tabs' });
    for (const [key, label] of TABS) {
      tabs.appendChild(ui.h('button', {
        class: `tab ${state.tab === key ? 'is-active' : ''}`,
        onClick: (ev) => {
          state.tab = key; state.page = 0;
          for (const b of ev.currentTarget.parentElement.children) b.classList.remove('is-active');
          ev.currentTarget.classList.add('is-active');
          load();
        },
      }, label));
    }
    wrap.appendChild(tabs);

    const host = ui.h('div', {});
    wrap.appendChild(host);

    function scopeQuery(extra) {
      return SR.state.query(Object.assign({
        from: state.from, to: state.to,
        branch_scope: state.branchScope ? '1' : undefined,
      }, extra || {}));
    }

    async function load() {
      host.replaceChildren(ui.skeleton(8));
      try {
        if (state.tab === 'trial-balance') return renderTrialBalance(await SR.api.get('/api/accounting/trial-balance', { query: scopeQuery({ as_at: state.to }) }));
        if (state.tab === 'profit-loss') return renderProfitLoss(await SR.api.get('/api/accounting/profit-loss', { query: scopeQuery({}) }));
        if (state.tab === 'balance-sheet') return renderBalanceSheet(await SR.api.get('/api/accounting/balance-sheet', { query: scopeQuery({ as_at: state.to }) }));
        if (state.tab === 'journal') return renderJournal(await SR.api.get('/api/accounting/journal', {
          query: scopeQuery({ q: state.q || undefined, source_type: state.sourceType || undefined, limit: state.pageSize, offset: state.page * state.pageSize }),
        }));
        if (state.tab === 'vat') return renderVat(await SR.api.get('/api/accounting/vat', { query: scopeQuery({}) }));
        if (state.tab === 'wht') return renderWht(await SR.api.get('/api/accounting/wht', { query: scopeQuery({}) }));
        if (state.tab === 'accounts') return renderAccounts(await SR.api.get('/api/accounting/accounts', { query: SR.state.query({}) }));
      } catch (err) {
        host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: load } }));
      }
    }

    // ------------------------------------------------------ trial balance
    function renderTrialBalance(data) {
      const ok = data.balances !== false;
      const accounts = data.accounts || [];
      host.replaceChildren(ui.h('div', { class: 'stack' },
        ui.h('div', { class: `alert ${ok ? 'alert-ok' : 'alert-danger'}` }, data.message),
        ui.h('div', { class: 'kpis' },
          ui.kpi({ label: 'Debits', value: U.money(data.totalDebit) }),
          ui.kpi({ label: 'Credits', value: U.money(data.totalCredit) }),
          ui.kpi({ label: 'Difference', value: U.money(data.difference), tone: ok ? 'good' : 'bad', foot: ok ? 'the two sides agree' : 'unequal legs somewhere in the ledger' })),
        ui.dataCard({
          title: `As at ${data.asAt || state.to}`,
          table: ui.renderTable({
            columns: [
              { key: 'code', label: 'Code' },
              { key: 'name', label: 'Account' },
              { key: 'accountType', label: 'Type', render: (a) => U.humanise(a.accountType) },
              { key: 'totalDebit', label: 'Debit', align: 'right', render: (a) => (Number(a.totalDebit) ? U.money(a.totalDebit) : '—') },
              { key: 'totalCredit', label: 'Credit', align: 'right', render: (a) => (Number(a.totalCredit) ? U.money(a.totalCredit) : '—') },
              { key: 'balance', label: 'Balance', align: 'right', render: (a) => U.money(a.balance) },
              { key: 'balanceSide', label: 'Side', render: (a) => ui.badge(a.balanceSide, a.balanceSide === 'DEBIT' ? 'badge-info' : 'badge-mute') },
            ],
            rows: accounts,
            foot: ['', 'Totals', '', U.money(data.totalDebit), U.money(data.totalCredit), '', ''],
            emptyTitle: 'Nothing has been posted yet',
            emptyMessage: 'The ledger fills up the moment the first sale is rung up, a purchase is received or an expense is paid.',
          }),
        })));
    }

    // -------------------------------------------------------- profit & loss
    function renderProfitLoss(data) {
      const groupTable = (title, rows, total, emptyMessage) => ui.dataCard({
        title,
        table: ui.renderTable({
          columns: [
            { key: 'code', label: 'Code' },
            { key: 'name', label: 'Account' },
            { key: 'amount', label: 'Amount', align: 'right', render: (r) => U.money(r.amount) },
          ],
          rows,
          foot: ['', 'Total', U.money(total)],
          emptyTitle: title === 'Revenue' ? 'No sales in this period' : 'Nothing here',
          emptyMessage,
        }),
      });

      const stack = ui.h('div', { class: 'stack' });
      if (data.commentary) {
        const margin = Number(data.grossMarginPct || 0);
        stack.appendChild(ui.h('div', { class: `alert ${margin >= 15 ? 'alert-ok' : 'alert-warn'}` }, data.commentary));
      }
      stack.appendChild(ui.h('div', { class: 'kpis' },
        ui.kpi({ label: 'Revenue', value: U.money(data.totalRevenue), foot: data.range ? `${data.range.from} → ${data.range.to}` : null }),
        ui.kpi({ label: 'Cost of goods sold', value: U.money(data.totalCogs) }),
        ui.kpi({ label: 'Gross profit', value: U.money(data.grossProfit), tone: Number(data.grossProfit) >= 0 ? 'good' : 'bad', foot: data.grossMarginPct == null ? null : `${data.grossMarginPct}% margin` }),
        ui.kpi({ label: 'Operating expenses', value: U.money(data.totalExpenses) }),
        ui.kpi({ label: 'Net profit', value: U.money(data.netProfit), tone: Number(data.netProfit) >= 0 ? 'good' : 'bad', foot: data.netMarginPct == null ? null : `${data.netMarginPct}% of revenue` })));
      stack.appendChild(groupTable('Revenue', data.revenue || [], data.totalRevenue, 'Sell something and it appears here.'));
      stack.appendChild(groupTable('Cost of goods sold', data.cogs || [], data.totalCogs, 'Cost of sales follows the stock you sold, valued at what it cost to land.'));
      stack.appendChild(groupTable('Operating expenses', data.expenses || [], data.totalExpenses, 'Rent, diesel, wages — everything that is not stock.'));
      if ((data.byCategory || []).length) {
        stack.appendChild(ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' },
          ui.h('h2', {}, 'Revenue by product category'),
          ui.bars((data.byCategory || []).map((c) => ({ label: c.category || c.name || 'Uncategorised', value: c.revenue || c.amount || 0 })), { format: (v) => U.money(v) }))));
      }
      host.replaceChildren(stack);
    }

    // -------------------------------------------------------- balance sheet
    function renderBalanceSheet(data) {
      const side = (label, rows, total) => ui.dataCard({
        title: label,
        table: ui.renderTable({
          columns: [
            { key: 'code', label: 'Code' },
            { key: 'name', label: 'Account' },
            { key: 'balance', label: 'Balance', align: 'right', render: (r) => U.money(r.balance) },
          ],
          rows,
          foot: ['', 'Total', U.money(total)],
          emptyTitle: `No ${label.toLowerCase()}`,
          emptyMessage: 'Nothing posted to this side yet.',
        }),
      });
      host.replaceChildren(ui.h('div', { class: 'stack' },
        ui.h('div', { class: `alert ${data.balances === false ? 'alert-danger' : 'alert-ok'}` }, data.message),
        ui.h('div', { class: 'kpis' },
          ui.kpi({ label: 'Total assets', value: U.money(data.totalAssets) }),
          ui.kpi({ label: 'Total liabilities', value: U.money(data.totalLiabilities) }),
          ui.kpi({ label: 'Equity stated', value: U.money(data.statedEquity) }),
          ui.kpi({ label: 'Profit to date (retained)', value: U.money(data.retainedEarnings), foot: 'unclosed profit, added back to equity' }),
          ui.kpi({ label: 'Liabilities + equity', value: U.money(data.totalLiabilitiesAndEquity), tone: data.balances === false ? 'bad' : 'good' })),
        side('Assets', data.assets || [], data.totalAssets),
        side('Liabilities', data.liabilities || [], data.totalLiabilities),
        side('Equity', data.equity || [], data.statedEquity)));
    }

    // ---------------------------------------------------------------- journal
    function renderJournal(data) {
      const rows = data.data || data.records || [];
      const total = (data.paging && data.paging.total != null) ? data.paging.total : rows.length;

      const search = ui.h('input', { type: 'search', placeholder: 'Entry number or description', value: state.q, style: { maxWidth: '280px' } });
      search.addEventListener('input', ui.debounceInput(search, (v) => { state.q = v; state.page = 0; load(); }, 300));
      const sourceSel = ui.h('select', { onchange: (e) => { state.sourceType = e.target.value; state.page = 0; load(); } });
      for (const s of ['', 'SALE', 'SALE_RETURN', 'PURCHASE_RECEIPT', 'EXPENSE', 'STOCK_ADJUSTMENT', 'STOCK_TRANSFER', 'DEBTOR_PAYMENT', 'CREDITOR_PAYMENT', 'BANKING', 'MANUAL']) {
        sourceSel.appendChild(ui.h('option', { value: s, selected: s === state.sourceType }, s ? U.humanise(s) : 'Any source'));
      }

      host.replaceChildren(ui.dataCard({
        title: 'Journal entries',
        toolbar: ui.h('div', { class: 'row' }, search, sourceSel),
        table: ui.renderTable({
          columns: [
            { key: 'entry_no', label: 'Entry' },
            { key: 'entry_date', label: 'Date' },
            { key: 'description', label: 'Description' },
            { key: 'source_type', label: 'Source', render: (e) => ui.badge(U.humanise(e.source_type || 'MANUAL'), 'badge-mute') },
            { key: 'branch_name', label: 'Branch', render: (e) => e.branch_name || 'All' },
            { key: 'line_count', label: 'Lines', align: 'right', render: (e) => U.qty(e.line_count || 0) },
            { key: 'posted_by_name', label: 'Posted by', render: (e) => e.posted_by_name || 'system' },
          ],
          rows,
          onRowClick: (e) => openEntry(e),
          emptyTitle: 'No entries in this period',
          emptyMessage: 'Every sale, receipt, payment and adjustment posts here automatically. A quiet ledger means a quiet shop.',
        }),
        pager: total > state.pageSize ? ui.pager({
          page: state.page, pageSize: state.pageSize, total,
          onPage: (p) => { state.page = p; load(); },
          onSize: (s) => { state.pageSize = s; state.page = 0; load(); },
        }) : null,
      }));
    }

    async function openEntry(entry) {
      const body = ui.h('div', {}, ui.skeleton(3));
      const m = ui.openModal({ title: `Entry ${entry.entry_no}`, body, size: 'wide' });
      try {
        const data = await SR.api.get(`/api/accounting/journal/${encodeURIComponent(entry.id)}`, { query: SR.state.query({}) });
        const lines = data.lines || [];
        body.replaceChildren(ui.h('div', { class: 'stack' },
          ui.kv([
            ['Date', data.entry.entry_date],
            ['Source', U.humanise(data.entry.source_type || 'MANUAL')],
            ['Branch', data.entry.branch_name || '—'],
            ['Description', data.entry.description || '—'],
          ]),
          ui.renderTable({
            columns: [
              { key: 'account_code', label: 'Code', render: (l) => l.account_code || l.code || '—' },
              { key: 'account_name', label: 'Account', render: (l) => l.account_name || l.name || '—' },
              { key: 'description', label: 'Memo', render: (l) => l.description || '—' },
              { key: 'debit', label: 'Debit', align: 'right', render: (l) => (Number(l.debit) ? U.money(l.debit) : '—') },
              { key: 'credit', label: 'Credit', align: 'right', render: (l) => (Number(l.credit) ? U.money(l.credit) : '—') },
            ],
            rows: lines,
            foot: ['', '', '', U.money(data.totals ? data.totals.debit : lines.reduce((a, l) => a + Number(l.debit || 0), 0)), U.money(data.totals ? data.totals.credit : lines.reduce((a, l) => a + Number(l.credit || 0), 0))],
          })));
      } catch (err) {
        body.replaceChildren(ui.h('div', { class: 'alert alert-danger' }, err.message || 'Could not load the entry.'));
      }
      return m;
    }

    // -------------------------------------------------------------- VAT
    function renderVat(data) {
      const out = data.output || {};
      const input = data.input || {};
      const children = [
        ui.h('div', { class: `alert ${data.position === 'PAYABLE' ? 'alert-warn' : 'alert-ok'}` }, data.message),
        ui.h('div', { class: 'kpis' },
          ui.kpi({ label: 'Output VAT on sales', value: U.money(out.vat), foot: `${U.money(out.sales)} gross, ${U.money(out.netRevenue)} net` }),
          ui.kpi({ label: 'Input VAT recoverable', value: U.money(input.vat), foot: `${U.qty(input.entries || 0)} purchase and expense entries` }),
          ui.kpi({ label: 'Net position', value: U.money(data.netPayable), tone: data.position === 'PAYABLE' ? 'warn' : 'good', foot: data.position }),
          ui.kpi({ label: 'Due by', value: data.dueBy || '—', foot: `rate ${data.ratePercent}%` })),
      ];

      if (Number(out.voidedVat) > 0) {
        children.push(ui.dataCard({
          title: 'Voided sales in this period',
          table: ui.renderTable({
            columns: [
              { key: 'sales', label: 'Voided sales', align: 'right', render: (r) => U.money(r.sales) },
              { key: 'vat', label: 'VAT reversed', align: 'right', render: (r) => U.money(r.vat) },
            ],
            rows: [out],
          }),
        }));
      }

      children.push(ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' },
        ui.h('h2', {}, 'How this is calculated'),
        ui.h('p', { class: 'sub' }, 'Sales are recorded VAT-INCLUSIVE in Nigeria, so the tax is extracted from the price rather than added to it: ₦107,500 at 7.5% is ₦7,500 of VAT and ₦100,000 of revenue, not ₦107,500 plus tax. Both figures here come from the ledger — the same numbers the return is filed against.'))));

      host.replaceChildren(ui.h('div', { class: 'stack' }, ...children));
    }

    // -------------------------------------------------------------- WHT
    function renderWht(data) {
      const s = data.summary || {};
      const rows = data.entries || [];
      host.replaceChildren(ui.h('div', { class: 'stack' },
        ui.h('div', { class: `alert ${Number(s.unremittedTotal) > 0 ? 'alert-warn' : 'alert-ok'}` }, data.message),
        ui.h('div', { class: 'kpis' },
          ui.kpi({ label: 'Withheld from suppliers', value: U.money(s.payableTotal), foot: 'you hold it, FIRS is owed it' }),
          ui.kpi({ label: 'Already remitted', value: U.money(s.remittedTotal), tone: 'good' }),
          ui.kpi({ label: 'Still to remit', value: U.money(s.unremittedTotal), tone: Number(s.unremittedTotal) > 0 ? 'bad' : 'good', foot: `${U.qty(s.unremittedCount || 0)} entr(ies)` }),
          ui.kpi({ label: 'Withheld from us', value: U.money(s.receivableTotal), foot: 'credit notes to claim' }),
          ui.kpi({ label: 'Next deadline', value: s.nextRemittanceDue || '—', small: true, foot: `the ${s.remittanceDay || 21}st of the month` })),
        ui.dataCard({
          title: 'Withholding entries',
          table: ui.renderTable({
            columns: [
              { key: 'entry_date', label: 'Date' },
              { key: 'direction', label: 'Direction', render: (r) => ui.badge(r.direction === 'RECEIVABLE' ? 'withheld from us' : 'we withheld', r.direction === 'RECEIVABLE' ? 'badge-info' : 'badge-warn') },
              { key: 'counterparty_name', label: 'Counterparty', render: (r) => r.counterparty_name || '—' },
              { key: 'rate_code', label: 'Rate', render: (r) => `${U.humanise(r.rate_code || '—')}${r.rate_percent ? ` · ${r.rate_percent}%` : ''}` },
              { key: 'gross_amount', label: 'Gross', align: 'right', render: (r) => U.money(r.gross_amount) },
              { key: 'wht_amount', label: 'Withheld', align: 'right', render: (r) => U.money(r.wht_amount) },
              { key: 'net_amount', label: 'Net paid', align: 'right', render: (r) => U.money(r.net_amount) },
              {
                key: 'remitted_at',
                label: 'Remitted',
                render: (r) => (r.remitted_at
                  ? ui.badge('filed', 'badge-good')
                  : (r.direction === 'PAYABLE' && SR.state.atLeast('OWNER')
                    ? ui.h('button', { class: 'btn btn-xs', onClick: (ev) => { ev.stopPropagation(); markRemitted(r); } }, 'Mark remitted')
                    : ui.badge('outstanding', 'badge-warn'))),
              },
            ],
            rows,
            emptyTitle: 'No withholding in this period',
            emptyMessage: 'Withholding appears here when a supplier is paid with a deduction, or when a customer withholds tax from you.',
          }),
        }),
        ui.dataCard({
          title: 'The 2024 schedule (data, not code)',
          table: ui.renderTable({
            columns: [
              { key: 'code', label: 'Code' },
              { key: 'name', label: 'Nature of payment' },
              { key: 'rate_percent', label: 'Rate', align: 'right', render: (r) => `${r.rate_percent}%` },
              { key: 'direction', label: 'Direction', render: (r) => U.humanise(r.direction) },
              { key: 'note', label: 'Note' },
            ],
            rows: data.schedule || [],
            emptyTitle: 'Schedule not loaded',
            emptyMessage: 'The rate table is seeded when the deployment is provisioned.',
          }),
        })));
    }

    async function markRemitted(entry) {
      const reference = await ui.promptDialog({
        title: 'Mark as remitted to FIRS',
        label: 'FIRS receipt / remittance reference',
        required: true,
        hint: `₦${U.amount(entry.wht_amount)} withheld from ${entry.counterparty_name || 'the counterparty'} in ${String(entry.entry_date).slice(0, 7)}.`,
      });
      if (!reference) return;
      try {
        const res = await SR.api.post(`/api/accounting/wht/${encodeURIComponent(entry.id)}/remitted`, { body: { reference } });
        ui.ok(res.message || 'Marked as remitted.');
        load();
      } catch (err) { ui.apiError(err); }
    }

    // ---------------------------------------------------------- chart of accounts
    function renderAccounts(data) {
      const rows = data.data || data.records || [];
      const byType = data.byType || [];
      host.replaceChildren(ui.h('div', { class: 'stack' },
        ui.h('div', { class: 'kpis' }, ...byType.map((t) => ui.kpi({
          label: U.humanise(t.account_type || t.type || ''),
          value: U.qty(t.count || 0),
          foot: U.money(t.balance || 0),
        }))),
        ui.dataCard({
          title: 'Chart of accounts',
          actions: [SR.state.atLeast('OWNER') ? ui.h('button', { class: 'btn btn-sm', onClick: () => openAccount() }, 'Add an account') : null].filter(Boolean),
          table: ui.renderTable({
            columns: [
              { key: 'code', label: 'Code' },
              { key: 'name', label: 'Account' },
              { key: 'account_type', label: 'Type', render: (a) => U.humanise(a.account_type) },
              { key: 'normal_side', label: 'Normal side', render: (a) => U.humanise(a.normal_side) },
              { key: 'is_system', label: 'Source', render: (a) => (Number(a.is_system) ? ui.badge('from the profile', 'badge-mute') : ui.badge('added by you', 'badge-info')) },
            ],
            rows,
            emptyTitle: 'No accounts',
            emptyMessage: 'The chart of accounts is built from the business profile when the deployment is provisioned.',
          }),
        })));
    }

    function openAccount() {
      const form = ui.h('div', {});
      form.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Code (four digits)', name: 'code', required: true, placeholder: '6410', hint: '1000 assets · 2000 liabilities · 4000 revenue · 5000 cost of sales · 6000 expenses' }),
        ui.field({ label: 'Name', name: 'name', required: true, span: true }),
        ui.field({ label: 'Type', name: 'account_type', required: true, options: ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'].map((t) => ({ value: t, label: U.humanise(t) })) })));
      const cancel = ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel');
      const go = ui.h('button', { class: 'btn btn-primary' }, 'Create the account');
      const m = ui.openModal({ title: 'Add a ledger account', body: form, footer: [cancel, go], size: 'narrow' });
      go.addEventListener('click', async () => {
        const v = ui.readFormStrings(form);
        await ui.withBusy(form, async () => {
          try {
            const res = await SR.api.post('/api/accounting/accounts', { body: v });
            m.close();
            ui.ok(res.message || 'Account created.');
            load();
          } catch (err) { ui.apiError(err); }
        });
      });
    }

    // ----------------------------------------------------- manual journal
    function openJournal() {
      const form = ui.h('div', {});
      const lines = [];
      form.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Entry date', name: 'entry_date', type: 'date', value: U.todayWat(), required: true }),
        ui.field({ label: 'Branch', name: 'branch_id', options: [{ value: '', label: 'Whole business' }].concat(SR.state.branches().map((b) => ({ value: b.id, label: b.name }))) }),
        ui.field({
          label: 'What is this entry for',
          name: 'description',
          span: true,
          type: 'textarea',
          required: true,
          hint: 'A sentence, not a word. This is what an auditor reads first, two years from now, with no memory of the day.',
        })));

      const lineHost = ui.h('div', { class: 'stack' });
      form.appendChild(ui.h('h2', {}, 'Lines'));
      form.appendChild(lineHost);
      const totalsLine = ui.h('div', { class: 'alert alert-info' }, 'Debits and credits must be equal before this can post.');
      form.appendChild(totalsLine);
      form.appendChild(ui.h('button', { class: 'btn btn-sm', onClick: () => lineHost.appendChild(lineRow()) }, 'Add a line'));

      function lineRow() {
        const row = ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' }));
        const entry = { account_code: '', debit: 0, credit: 0, description: '' };
        const code = ui.h('input', { placeholder: 'account code', style: { maxWidth: '120px' } });
        const memo = ui.h('input', { placeholder: 'memo' });
        const debit = ui.h('input', { type: 'number', step: '0.01', min: '0', placeholder: 'debit', style: { maxWidth: '130px' } });
        const credit = ui.h('input', { type: 'number', step: '0.01', min: '0', placeholder: 'credit', style: { maxWidth: '130px' } });
        const recompute = () => {
          entry.account_code = code.value.trim();
          entry.debit = Number(debit.value) || 0;
          entry.credit = Number(credit.value) || 0;
          entry.description = memo.value.trim();
          // Typing in one column clears the other: a line that is both a debit
          // and a credit is not a double entry, and the server rejects it.
          if (entry.debit > 0 && debit === document.activeElement) credit.value = '';
          if (entry.credit > 0 && credit === document.activeElement) debit.value = '';
          const d = lines.reduce((a, l) => a + (Number(l.debit) || 0), 0);
          const c = lines.reduce((a, l) => a + (Number(l.credit) || 0), 0);
          const diff = U.round2(d - c);
          if (Math.abs(diff) < 0.005 && d > 0) { totalsLine.className = 'alert alert-ok'; totalsLine.textContent = `Balanced at ${U.money(d)}.`; }
          else { totalsLine.className = 'alert alert-warn'; totalsLine.textContent = `Debits ${U.money(d)} · credits ${U.money(c)} · out by ${U.money(Math.abs(diff))}.`; }
        };
        for (const el of [code, memo, debit, credit]) el.addEventListener('input', recompute);
        row.firstElementChild.appendChild(ui.h('div', { class: 'row' },
          ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Account'), code),
          ui.h('div', { class: 'grow' }, ui.h('label', { class: 'ctl' }, 'Memo'), memo),
          ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Debit'), debit),
          ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Credit'), credit),
          ui.h('div', {}, ui.h('button', { class: 'btn btn-sm btn-danger', onClick: () => { const i = lines.indexOf(entry); if (i >= 0) lines.splice(i, 1); row.remove(); recompute(); } }, 'Remove'))));
        lines.push(entry);
        return row;
      }

      lineHost.appendChild(lineRow());
      lineHost.appendChild(lineRow());

      const cancel = ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel');
      const go = ui.h('button', { class: 'btn btn-primary' }, 'Post the entry');
      const m = ui.openModal({ title: 'Manual journal entry', body: form, footer: [cancel, go], size: 'wide' });

      go.addEventListener('click', async () => {
        const v = ui.readForm(form);
        const payload = lines.filter((l) => l.account_code && (l.debit || l.credit));
        if (payload.length < 2) { ui.warn('A double entry needs at least two lines — a debit and a credit.'); return; }
        await ui.withBusy(form, async () => {
          try {
            const res = await SR.api.post('/api/accounting/journal', {
              body: {
                entry_date: v.entry_date,
                branch_id: v.branch_id || undefined,
                description: v.description,
                lines: payload,
              },
            });
            m.close();
            ui.ok(res.message || `Entry ${res.entryNo || ''} posted.`);
            state.tab = 'journal';
            load();
          } catch (err) { ui.apiError(err); }
        });
      });
    }

    await load();
    return wrap;
  }

  SR.views = SR.views || {};
  SR.views.accounting = { render };
}(window));
