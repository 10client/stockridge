'use strict';
// =====================================================================
// public/js/views/customers.js — CUSTOMERS, AND THE DEBTOR BOOK
// =====================================================================
// In a Nigerian appliance or furniture shop, credit is not an edge case — it is
// how half the stock leaves the building. A customer takes a freezer home on a
// promise, or a builder takes a truckload of tiles on thirty days.
//
// So the debtor book is a first-class screen, not a report:
//
//   * WHO OWES WHAT, sorted so the worst first.
//   * HOW LONG IT HAS BEEN OWED, because a ₦400,000 balance from last month and
//     one from yesterday are different problems.
//   * THE STANDING LEDGER — every invoice, every payment, every adjustment, in
//     order, with the running balance. This is the page that ends an argument.
//
// A payment here is explicitly NOT a sale. It writes a ledger row and posts cash
// against a receivable. Recording it as a new sale would double the revenue.
// =====================================================================
(function (global) {
  const SR = global.SR;
  const ui = SR.ui;
  const U = SR.util;

  async function render(ctx) {
    if (ctx.params.id) return renderDetail(ctx);
    ctx.setTitle('Customers');
    const state = { tab: ctx.query.tab || 'all', page: 0, pageSize: 50, q: '', overdueOnly: false };

    const wrap = ui.h('div', { class: 'stack' });
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Customers'),
        ui.h('p', { class: 'sub' }, 'Contact records, credit limits and what is owed.')),
      ui.h('div', { class: 'actions' },
        ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => openCreate() }, 'Add a customer'),
        ui.h('button', { class: 'btn btn-sm', onClick: () => exportList() }, 'Export'))));

    const tabs = ui.h('div', { class: 'tabs' });
    for (const [key, label] of [['all', 'All customers'], ['debtors', 'Debtor book'], ['credit', 'Credit limits']]) {
      tabs.appendChild(ui.h('button', {
        class: `tab ${state.tab === key ? 'is-active' : ''}`,
        onClick: () => {
          state.tab = key; state.page = 0;
          for (const b of tabs.children) b.classList.toggle('is-active', b.textContent === label);
          load();
        },
      }, label));
    }
    wrap.appendChild(tabs);

    const summaryHost = ui.h('div', {});
    wrap.appendChild(summaryHost);
    const host = ui.h('div', {});
    wrap.appendChild(host);

    async function exportList() {
      try {
        await SR.exporter.list({
          filename: state.tab === 'debtors' ? 'debtors' : 'customers',
          path: state.tab === 'debtors' ? '/api/customers/debtors' : '/api/customers',
          query: SR.state.query({ q: state.q || undefined }),
          mirrorTable: 'customers',
          columns: [
            { key: 'name', label: 'Customer' }, { key: 'company_name', label: 'Company' },
            { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' },
            { key: 'city', label: 'City' }, { key: 'class_name', label: 'Class' },
            { key: 'credit_limit', label: 'Credit limit' }, { key: 'credit_balance', label: 'Owes' },
            { key: 'available_credit', label: 'Available' }, { key: 'lifetime_value', label: 'Lifetime value' },
          ],
        });
      } catch (err) { ui.apiError(err); }
    }

    async function load() {
      host.replaceChildren(ui.skeleton(6));
      summaryHost.replaceChildren();
      if (state.tab === 'debtors') return loadDebtors();
      return loadCustomers();
    }

    async function loadCustomers() {
      const qInput = ui.h('input', { type: 'search', placeholder: 'Name, phone, company or email…', style: { minWidth: '210px' } });
      qInput.value = state.q;
      qInput.addEventListener('input', U.debounce(() => { state.q = qInput.value; state.page = 0; loadCustomers(); }, 320));

      let data; let offline = false;
      try {
        data = await SR.api.get('/api/customers', { query: SR.state.query({ q: state.q || undefined, limit: state.pageSize, offset: state.page * state.pageSize }) });
      } catch (err) {
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: loadCustomers } })); return; }
        offline = true;
        const all = await SR.store.all('customers', { where: (c) => !Number(c.is_deleted) });
        const needle = state.q.toLowerCase();
        const rows = all.filter((c) => !needle || `${c.name} ${c.phone || ''} ${c.company_name || ''} ${c.email || ''}`.toLowerCase().includes(needle))
          .sort((a, b) => Number(b.credit_balance || 0) - Number(a.credit_balance || 0));
        data = { data: rows, paging: { total: rows.length, limit: rows.length, offset: 0 } };
      }
      const rows = data.data || [];
      const paging = data.paging || {};

      host.replaceChildren();
      host.appendChild(ui.dataCard({
        title: 'Customers',
        toolbar: qInput,
        table: ui.renderTable({
          columns: [
            { key: 'name', label: 'Customer', className: 'wrap', render: (c) => {
              const cell = ui.h('div', {});
              cell.appendChild(ui.h('div', { style: { fontWeight: '600' } }, c.name));
              cell.appendChild(ui.h('div', { class: 'hint' }, [c.phone, c.company_name, c.city].filter(Boolean).join(' · ')));
              return cell;
            } },
            { key: 'class_name', label: 'Class', render: (c) => (c.class_name ? ui.badge(c.class_name, 'badge-info') : '—') },
            { key: 'credit_limit', label: 'Limit', align: 'right', render: (c) => (Number(c.credit_limit) ? U.money(c.credit_limit) : '—') },
            { key: 'credit_balance', label: 'Owes', align: 'right', render: (c) => (Number(c.credit_balance) > 0 ? ui.h('strong', { style: { color: 'var(--amber-700)' } }, U.money(c.credit_balance)) : '—') },
            { key: 'available_credit', label: 'Available', align: 'right', render: (c) => (c.credit_limit ? U.money(c.available_credit) : '—') },
            { key: 'lifetime_value', label: 'Lifetime', align: 'right', render: (c) => U.money(c.lifetime_value) },
            { key: 'last_purchase_at', label: 'Last bought', render: (c) => (c.last_purchase_at ? U.relTime(c.last_purchase_at) : 'never') },
            { key: 'x', label: '', render: (c) => ui.h('button', { class: 'btn btn-sm', onClick: (ev) => { ev.stopPropagation(); SR.app.navigate(`/customers/${c.id}`); } }, 'Open') },
          ],
          rows,
          onRowClick: (c) => SR.app.navigate(`/customers/${c.id}`),
          emptyTitle: state.q ? 'No customer matches' : 'No customers yet',
          emptyMessage: state.q ? 'Try a phone number — that is how most are found.' : 'Add a customer before selling on credit, so the debt has a name against it.',
          emptyAction: { label: 'Add a customer', run: () => openCreate() },
        }),
        pager: ui.pager({
          page: state.page, pageSize: paging.limit || state.pageSize, total: paging.total != null ? paging.total : rows.length,
          onPage: (p) => { state.page = p; loadCustomers(); },
          onSize: (n) => { state.pageSize = n; state.page = 0; loadCustomers(); },
        }),
      }));
      if (offline) host.insertBefore(ui.h('div', { class: 'alert alert-warn' }, 'Offline — from this device\'s last sync.'), host.firstChild);
    }

    async function loadDebtors() {
      let data; let offline = false;
      try {
        data = await SR.api.get('/api/customers/debtors', { query: SR.state.query({ limit: 200 }) });
      } catch (err) {
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: loadDebtors } })); return; }
        offline = true;
        const rows = (await SR.store.all('customers', { where: (c) => !Number(c.is_deleted) && Number(c.credit_balance) > 0 }))
          .sort((a, b) => Number(b.credit_balance) - Number(a.credit_balance));
        data = { debtors: rows, summary: { total: U.sum(rows, (r) => r.credit_balance), count: rows.length } };
      }
      const rows = data.debtors || data.data || [];
      const s = data.summary || {};
      const total = s.total != null ? Number(s.total) : U.sum(rows, (r) => r.credit_balance);
      const overdue = rows.filter((r) => Number(r.overdue_amount || 0) > 0 || Number(r.days_overdue || 0) > 0);
      const overLimit = rows.filter((r) => Number(r.credit_limit) > 0 && Number(r.credit_balance) > Number(r.credit_limit));

      summaryHost.replaceChildren(ui.h('div', { class: 'grid grid-5' },
        ui.kpi({ label: 'Total owed to us', value: U.money(total), tone: 'warn', small: true }),
        ui.kpi({ label: 'Debtors', value: String(s.count != null ? s.count : rows.length), small: true }),
        ui.kpi({ label: 'Overdue', value: U.money(U.sum(overdue, (r) => r.overdue_amount || r.credit_balance)), tone: overdue.length ? 'bad' : 'good', foot: `${overdue.length} account${overdue.length === 1 ? '' : 's'}`, small: true }),
        ui.kpi({ label: 'Over their limit', value: String(overLimit.length), tone: overLimit.length ? 'bad' : 'good', small: true }),
        ui.kpi({ label: 'Average debt', value: U.money(rows.length ? total / rows.length : 0), small: true })));
      summaryHost.appendChild(ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' },
        ui.h('div', { class: 'alert alert-info', style: { margin: 0 } },
          'A debtor\'s age is the number that matters. A ₦500,000 balance from three weeks ago is a customer; the same figure from eight months ago is a loss you have not written off yet.')),
        ));

      host.replaceChildren();
      if (offline) host.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'Offline — from this device\'s last sync.'));
      host.appendChild(ui.dataCard({
        title: 'Debtor book',
        actions: [ui.h('button', {
          class: 'btn btn-sm',
          onClick: () => statementAll(rows),
        }, 'Print statements')],
        table: ui.renderTable({
          columns: [
            { key: 'name', label: 'Customer', className: 'wrap', render: (c) => {
              const cell = ui.h('div', {});
              cell.appendChild(ui.h('div', { style: { fontWeight: '600' } }, c.name || c.customer_name));
              cell.appendChild(ui.h('div', { class: 'hint' }, [c.phone, c.company_name].filter(Boolean).join(' · ')));
              return cell;
            } },
            { key: 'credit_balance', label: 'Owes', align: 'right', render: (c) => ui.h('strong', {}, U.money(c.credit_balance || c.balance)) },
            { key: 'current_amount', label: 'Not yet due', align: 'right', render: (c) => U.money(c.current_amount || c.current || 0) },
            { key: 'overdue_amount', label: 'Overdue', align: 'right', render: (c) => (Number(c.overdue_amount) > 0 ? ui.h('strong', { style: { color: 'var(--red-700)' } }, U.money(c.overdue_amount)) : '—') },
            { key: 'days_overdue', label: 'Days late', align: 'right', render: (c) => (Number(c.days_overdue) > 0 ? ui.badge(`${c.days_overdue}d`, Number(c.days_overdue) > 60 ? 'badge-bad' : 'badge-warn') : '—') },
            { key: 'credit_limit', label: 'Limit', align: 'right', render: (c) => (Number(c.credit_limit) ? U.money(c.credit_limit) : 'none') },
            { key: 'at_limit', label: '', render: (c) => (Number(c.credit_limit) > 0 && Number(c.credit_balance) > Number(c.credit_limit) ? ui.badge('over', 'badge-bad') : '') },
            { key: 'x', label: '', render: (c) => ui.h('div', { class: 'btn-row' },
              ui.h('button', { class: 'btn btn-sm', onClick: (ev) => { ev.stopPropagation(); openPayment(c); } }, 'Take payment'),
              ui.h('button', { class: 'btn btn-sm', onClick: (ev) => { ev.stopPropagation(); SR.app.navigate(`/customers/${c.id}`); } }, 'Open')) },
          ],
          rows,
          foot: ['Total', U.money(total), '', U.money(U.sum(rows, (r) => r.overdue_amount || 0)), '', '', '', ''],
          emptyTitle: 'Nobody owes you anything',
          emptyMessage: 'Every customer is paid up. This is the page to check before a busy month, and again before the year closes.',
        }),
      }));
    }

    function statementAll(rows) {
      const brand = (SR.state.settings || {}).business_name || 'StockRidge';
      SR.print.printReport({
        title: `${brand} — Debtor book`,
        subtitle: `${SR.state.activeBranchName()} · ${U.date(U.nowIso())}`,
        columns: [
          { key: 'name', label: 'Customer', value: (r) => r.name || r.customer_name },
          { key: 'phone', label: 'Phone' },
          { key: 'credit_balance', label: 'Balance', value: (r) => U.amount(r.credit_balance) },
          { key: 'overdue_amount', label: 'Overdue', value: (r) => U.amount(r.overdue_amount || 0) },
          { key: 'days_overdue', label: 'Days late', value: (r) => r.days_overdue || 0 },
        ],
        rows,
        foot: ['TOTAL OWED', '', U.amount(U.sum(rows, (r) => r.credit_balance)), '', ''],
      });
    }

    function openCreate() {
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Name', name: 'name', required: true }),
        ui.field({ label: 'Company', name: 'company_name' }),
        ui.field({ label: 'Phone', name: 'phone', hint: 'A phone number is how a balance gets chased.' }),
        ui.field({ label: 'Alt. phone', name: 'alt_phone' }),
        ui.field({ label: 'Email', name: 'email' }),
        ui.field({ label: 'City', name: 'city' }),
        ui.field({ label: 'State', name: 'state' }),
        ui.field({ label: 'TIN', name: 'tin' }),
        ui.field({ label: 'Address', name: 'address', span: true })));
      const m = ui.openModal({
        title: 'Add a customer',
        body: wrapEl,
        size: 'wide',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: async (ev) => {
              const v = ui.readFormStrings(wrapEl);
              if (!v.name) { ui.warn('A customer needs a name.'); return; }
              ev.currentTarget.disabled = true;
              try {
                const created = await SR.api.post('/api/customers', Object.assign(v, {
                  branch_id: SR.state.activeBranchId,
                  business_id: SR.state.activeBusinessId,
                }));
                if (created && created.warning) ui.warn(created.warning);
                ui.ok(`${v.name} added.`);
                m.close();
                load();
              } catch (err) {
                ui.apiError(err);
                ev.currentTarget.disabled = false;
              }
            },
          }, 'Add'),
        ],
      });
    }

    function openPayment(customer) {
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('div', { class: 'alert alert-info' },
        `${customer.name || customer.customer_name} owes ${U.money(customer.credit_balance || customer.balance)}.`));
      wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Amount received (₦)', name: 'amount', type: 'number', step: '0.01', min: '0', value: U.numInput(customer.credit_balance || customer.balance), required: true }),
        ui.field({ label: 'Method', name: 'method', value: 'CASH', options: ['CASH', 'POS_TERMINAL', 'BANK_TRANSFER', 'MOBILE_MONEY', 'USSD', 'CHEQUE'].map((x) => ({ value: x, label: U.humanise(x) })) }),
        ui.field({ label: 'Reference', name: 'reference', span: true }),
        ui.field({ label: 'Notes', name: 'notes', type: 'textarea', span: true })));
      wrapEl.appendChild(ui.h('div', { class: 'hint' }, 'This is a payment against the debtor ledger, not a new sale. The ledger keeps a running balance so the customer can see exactly how it was worked out.'));
      const m = ui.openModal({
        title: 'Take a payment',
        body: wrapEl,
        size: 'narrow',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: async (ev) => {
              const v = ui.readFormStrings(wrapEl);
              const amount = Number(v.amount);
              if (!(amount > 0)) { ui.warn('Enter the amount received.'); return; }
              ev.currentTarget.disabled = true;
              try {
                const cid = customer.id || customer.customer_id;
                await SR.api.post(`/api/customers/${encodeURIComponent(cid)}/payments`, {
                  amount, method: v.method, reference: v.reference || null, notes: v.notes || null,
                  branch_id: SR.state.activeBranchId,
                }, { queue: 'auto' });
                ui.ok(`Payment recorded. ${U.money(amount)} taken off the balance.`);
                m.close();
                load();
              } catch (err) {
                ui.apiError(err);
                ev.currentTarget.disabled = false;
              }
            },
          }, 'Record the payment'),
        ],
      });
    }

    await load();
    return wrap;
  }

  // -------------------------------------------------------------------
  // ONE CUSTOMER
  // -------------------------------------------------------------------
  async function renderDetail(ctx) {
    ctx.setTitle('Customer');
    const wrap = ui.h('div', { class: 'stack' });
    const host = ui.h('div', { class: 'stack' });
    wrap.appendChild(host);
    await load();

    async function load() {
      host.replaceChildren(ui.skeleton(7));
      let data; let ledger = null;
      try {
        data = await SR.api.get(`/api/customers/${encodeURIComponent(ctx.params.id)}`);
        ledger = await SR.api.get(`/api/customers/${encodeURIComponent(ctx.params.id)}/ledger`, { query: { limit: 200 } }).catch(() => null);
      } catch (err) {
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: load } })); return; }
        const c = await SR.store.get('customers', ctx.params.id);
        if (!c) { host.replaceChildren(ui.empty({ title: 'Not on this device', message: 'This customer has not been synced here yet.' })); return; }
        data = { customer: c };
      }
      const c = data.customer || data;
      const sales = data.sales || data.recentSales || [];
      const ledgerRows = (ledger && (ledger.entries || ledger.data)) || data.ledger || [];

      host.appendChild(ui.h('div', { class: 'page-head' },
        ui.h('div', {},
          ui.h('h1', {}, c.name),
          ui.h('p', { class: 'sub' }, [c.phone, c.company_name, c.email, c.city].filter(Boolean).join(' · ') || 'no contact details recorded')),
        ui.h('div', { class: 'actions' },
          ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate('/customers') }, 'Back'),
          ui.h('button', { class: 'btn btn-sm', onClick: () => edit(c) }, 'Edit'),
          Number(c.credit_balance) > 0 ? ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => SR.views.customers.payment(c, load) }, 'Take payment') : null,
          ui.h('button', { class: 'btn btn-sm', onClick: () => statement(c, ledgerRows) }, 'Statement'))));

      host.appendChild(ui.h('div', { class: 'grid grid-4' },
        ui.kpi({ label: 'Owes now', value: U.money(c.credit_balance), tone: Number(c.credit_balance) > 0 ? 'warn' : 'good', small: true }),
        ui.kpi({ label: 'Credit limit', value: Number(c.credit_limit) ? U.money(c.credit_limit) : 'none set', small: true, foot: Number(c.credit_limit) ? `${U.money(c.available_credit)} available` : null }),
        ui.kpi({ label: 'Lifetime value', value: U.money(c.lifetime_value), small: true }),
        ui.kpi({ label: 'Payment terms', value: Number(c.payment_terms_days) ? `${c.payment_terms_days} days` : 'on demand', small: true, foot: c.class_name || null })));

      if (Number(c.credit_limit) > 0 && Number(c.credit_balance) > Number(c.credit_limit)) {
        host.appendChild(ui.h('div', { class: 'alert alert-danger' },
          ui.h('strong', {}, 'Over the credit limit. '),
          `${U.money(c.credit_balance)} owed against a ${U.money(c.credit_limit)} limit. A further credit sale will ask for a reason — it will not be blocked, because the shop may have a reason the system does not know.`));
      }

      const tabs = ui.h('div', { class: 'tabs' });
      const ledgerHost = ui.h('div', {});
      let active = 'ledger';
      for (const [key, label] of [['ledger', 'Ledger'], ['sales', 'Purchases'], ['details', 'Details']]) {
        tabs.appendChild(ui.h('button', { class: `tab ${key === active ? 'is-active' : ''}`, onClick: () => { active = key; for (const b of tabs.children) b.classList.toggle('is-active', b.textContent === label); paint(); } }, label));
      }
      host.appendChild(tabs);
      host.appendChild(ledgerHost);

      function paint() {
        ledgerHost.replaceChildren();
        if (active === 'ledger') ledgerHost.appendChild(ledgerCard(ledgerRows, c));
        else if (active === 'sales') ledgerHost.appendChild(salesCard(sales));
        else ledgerHost.appendChild(detailsCard(c));
      }
      paint();
    }

    function ledgerCard(rows, c) {
      const card = ui.h('div', { class: 'card' });
      card.appendChild(ui.h('div', { class: 'card-head' },
        ui.h('h2', {}, 'Standing ledger'), ui.h('span', { class: 'spacer' }),
        ui.h('span', { class: 'badge badge-info' }, `closing balance ${U.money(c.credit_balance)}`)));
      card.appendChild(ui.h('div', { class: 'card-body tight' }, ui.renderTable({
        columns: [
          { key: 'created_at', label: 'When', render: (r) => U.dateTime(r.created_at) },
          { key: 'entry_type', label: 'Type', render: (r) => ui.badge(r.entry_type, r.entry_type === 'PAYMENT' ? 'badge-good' : (r.entry_type === 'ADJUSTMENT' ? 'badge-violet' : 'badge-mute')) },
          { key: 'notes', label: 'Detail', className: 'wrap' },
          { key: 'amount', label: 'Amount', align: 'right', render: (r) => {
            const n = Number(r.amount);
            return ui.h('span', { style: n < 0 ? { color: 'var(--green-700)' } : {} }, n < 0 ? `(${U.money(Math.abs(n))})` : U.money(n));
          } },
          { key: 'balance_after', label: 'Balance', align: 'right', render: (r) => ui.h('strong', {}, U.money(r.balance_after)) },
          { key: 'created_by_name', label: 'By' },
        ],
        rows,
        emptyTitle: 'No ledger entries',
        emptyMessage: 'Credit sales and payments against them appear here in order, with the running balance after each one.',
      })));
      return card;
    }

    function salesCard(rows) {
      if (!rows.length) return ui.empty({ title: 'No purchases recorded', message: 'Nothing has been sold to this customer yet.' });
      return ui.dataCard({
        title: 'Purchases',
        table: ui.renderTable({
          columns: [
            { key: 'receipt_no', label: 'Receipt' },
            { key: 'sold_at', label: 'When', render: (r) => U.soldAt(r.sold_at) },
            { key: 'total', label: 'Total', align: 'right', render: (r) => U.money(r.total) },
            { key: 'amount_paid', label: 'Paid', align: 'right', render: (r) => U.money(r.amount_paid) },
            { key: 'balance_due', label: 'Balance', align: 'right', render: (r) => U.money(r.balance_due) },
            { key: 'status', label: '', render: (r) => ui.statusBadge(r.status) },
          ],
          rows,
          onRowClick: (r) => SR.app.navigate(`/sales/${r.id}`),
        }),
      });
    }

    function detailsCard(c) {
      const card = ui.h('div', { class: 'card' });
      card.appendChild(ui.h('div', { class: 'card-head' }, ui.h('h2', {}, 'Details')));
      card.appendChild(ui.h('div', { class: 'card-body' },
        ui.kv([
          ['Name', c.name], ['Company', c.company_name], ['Phone', c.phone], ['Alt. phone', c.alt_phone],
          ['Email', c.email], ['Address', c.address], ['City', c.city], ['State', c.state],
          ['TIN', c.tin], ['CAC number', c.cac_reg_no], ['Type', U.humanise(c.customer_type || '')],
          ['Class', c.class_name], ['Discount', Number(c.class_discount_pct) ? U.pct(c.class_discount_pct) : null],
          ['Credit allowed', Number(c.class_credit_allowed) ? 'yes' : 'no'],
          ['Loyalty points', Number(c.loyalty_points) ? String(c.loyalty_points) : null],
          ['Notes', c.notes],
          ['Added', U.dateTime(c.created_at)],
        ])));
      return card;
    }

    function edit(c) {
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Name', name: 'name', value: c.name, required: true }),
        ui.field({ label: 'Company', name: 'company_name', value: c.company_name || '' }),
        ui.field({ label: 'Phone', name: 'phone', value: c.phone || '' }),
        ui.field({ label: 'Alt. phone', name: 'alt_phone', value: c.alt_phone || '' }),
        ui.field({ label: 'Email', name: 'email', value: c.email || '' }),
        ui.field({ label: 'City', name: 'city', value: c.city || '' }),
        ui.field({ label: 'State', name: 'state', value: c.state || '' }),
        ui.field({ label: 'TIN', name: 'tin', value: c.tin || '' }),
        ui.field({ label: 'Address', name: 'address', value: c.address || '', span: true }),
        ui.field({ label: 'Notes', name: 'notes', value: c.notes || '', type: 'textarea', span: true })));
      const m = ui.openModal({
        title: 'Edit customer',
        body: wrapEl,
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: async () => {
              try {
                await SR.api.put(`/api/customers/${encodeURIComponent(c.id)}`, ui.readFormStrings(wrapEl));
                ui.ok('Saved.');
                m.close();
                load();
              } catch (err) { ui.apiError(err); }
            },
          }, 'Save'),
        ],
      });
    }

    function statement(c, rows) {
      const brand = (SR.state.settings || {}).business_name || 'StockRidge';
      SR.print.printReport({
        title: `${brand} — Statement of account`,
        subtitle: `${c.name}${c.phone ? ` · ${c.phone}` : ''} · balance ${U.money(c.credit_balance)}`,
        columns: [
          { key: 'created_at', label: 'Date', value: (r) => U.dateTime(r.created_at) },
          { key: 'entry_type', label: 'Type' },
          { key: 'notes', label: 'Detail' },
          { key: 'amount', label: 'Amount', value: (r) => U.amount(r.amount) },
          { key: 'balance_after', label: 'Balance', value: (r) => U.amount(r.balance_after) },
        ],
        rows,
        foot: ['', '', 'BALANCE OWED', '', U.amount(c.credit_balance)],
      });
    }

    return wrap;
  }

  // Exposed so the detail screen can open the payment dialog without duplicating it.
  function payment(customer, onDone) {
    const wrapEl = ui.h('div', {});
    wrapEl.appendChild(ui.h('div', { class: 'alert alert-info' }, `Balance: ${U.money(customer.credit_balance)}`));
    wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
      ui.field({ label: 'Amount received (₦)', name: 'amount', type: 'number', step: '0.01', min: '0', value: U.numInput(customer.credit_balance), required: true }),
      ui.field({ label: 'Method', name: 'method', value: 'CASH', options: ['CASH', 'POS_TERMINAL', 'BANK_TRANSFER', 'MOBILE_MONEY', 'USSD', 'CHEQUE'].map((x) => ({ value: x, label: U.humanise(x) })) }),
      ui.field({ label: 'Reference', name: 'reference', span: true }),
      ui.field({ label: 'Notes', name: 'notes', type: 'textarea', span: true })));
    const m = ui.openModal({
      title: 'Take a payment',
      body: wrapEl,
      size: 'narrow',
      footer: [
        ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
        ui.h('button', {
          class: 'btn btn-primary',
          onClick: async () => {
            const v = ui.readFormStrings(wrapEl);
            const amount = Number(v.amount);
            if (!(amount > 0)) { ui.warn('Enter the amount received.'); return; }
            try {
              await SR.api.post(`/api/customers/${encodeURIComponent(customer.id)}/payments`, {
                amount, method: v.method, reference: v.reference || null, notes: v.notes || null,
                branch_id: SR.state.activeBranchId,
              }, { queue: 'auto' });
              ui.ok('Payment recorded against the ledger.');
              m.close();
              if (onDone) onDone();
            } catch (err) { ui.apiError(err); }
          },
        }, 'Record'),
      ],
    });
  }

  SR.views = SR.views || {};
  SR.views.customers = { render, payment };
}(window));
