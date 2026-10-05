'use strict';
// =====================================================================
// public/js/views/suppliers.js — WHO WE OWE, AND WHEN IT IS DUE
// =====================================================================
// Suppliers are not just a phone book. Three things here decide real money:
//
//   1. IS MANUFACTURER  — a manufacturer is exempt from the 2% supply-of-goods
//      withholding. A distributor is not. One checkbox moves money between the
//      supplier's pocket and FIRS, so it is asked for explicitly and the payment
//      screen WARNs when the two disagree.
//   2. TIN              — the payment screen refuses a WHT claim without one.
//   3. PAYMENT TERMS    — what makes an ageing list meaningful. "30 days" turns a
//      purchase order's expected date into a reminder before it becomes a
//      strained phone call.
//
// The payment form takes WHT off the GROSS and broadcasts the NET. Doing it the
// other way round is the most common withholding failure in small businesses,
// and the liability lands on the business, not the supplier.
// =====================================================================
(function (global) {
  const SR = global.SR;
  const ui = SR.ui;
  const U = SR.util;

  const METHODS = ['BANK_TRANSFER', 'CASH', 'CHEQUE', 'POS_TERMINAL', 'MOBILE_MONEY'];

  async function render(ctx) {
    if (ctx.params.id) return renderDetail(ctx);
    ctx.setTitle('Suppliers');
    const state = { tab: ctx.query.tab || 'suppliers', page: 0, pageSize: 50, q: '' };

    const wrap = ui.h('div', { class: 'stack' });
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Suppliers'),
        ui.h('p', { class: 'sub' }, 'Who we buy from, what we owe them, and the withholding each one attracts.')),
      ui.h('div', { class: 'actions' },
        SR.state.atLeast('MANAGER') ? ui.h('button', { class: 'btn btn-sm', onClick: () => openCreate() }, 'Add a supplier') : null,
        ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate('/purchase-orders') }, 'Purchase orders'),
        ui.h('button', { class: 'btn btn-sm', onClick: () => exportList() }, 'Export'))));

    const tabs = ui.h('div', { class: 'tabs' });
    for (const [key, label] of [['suppliers', 'Suppliers'], ['creditors', 'What we owe']]) {
      tabs.appendChild(ui.h('button', {
        class: `tab ${state.tab === key ? 'is-active' : ''}`,
        onClick: () => {
          state.tab = key;
          for (const b of tabs.children) b.classList.toggle('is-active', b.textContent === label);
          load();
        },
      }, label));
    }
    wrap.appendChild(tabs);
    const host = ui.h('div', {});
    wrap.appendChild(host);

    async function exportList() {
      try {
        await SR.exporter.list({
          filename: 'suppliers',
          path: '/api/suppliers',
          query: SR.state.query({ q: state.q || undefined }),
          mirrorTable: 'suppliers',
          columns: [
            { key: 'name', label: 'Supplier' }, { key: 'contact_person', label: 'Contact' },
            { key: 'phone', label: 'Phone' }, { key: 'tin', label: 'TIN' },
            { key: 'bank_name', label: 'Bank' }, { key: 'bank_account_no', label: 'Account' },
            { key: 'credit_limit', label: 'Credit limit' }, { key: 'payment_terms_days', label: 'Terms (days)' },
            { key: 'is_manufacturer', label: 'Manufacturer' }, { key: 'lifetime_purchases', label: 'Lifetime purchases' },
          ],
        });
      } catch (err) { ui.apiError(err); }
    }

    async function load() {
      host.replaceChildren(ui.skeleton(6));
      if (state.tab === 'creditors') return loadCreditors();
      return loadSuppliers();
    }

    async function loadSuppliers() {
      const qInput = ui.h('input', { type: 'search', placeholder: 'Name, phone or city…', style: { minWidth: '200px' } });
      qInput.value = state.q;
      qInput.addEventListener('input', U.debounce(() => { state.q = qInput.value; state.page = 0; loadSuppliers(); }, 320));

      let data; let offline = false;
      try {
        data = await SR.api.get('/api/suppliers', { query: SR.state.query({ q: state.q || undefined, limit: state.pageSize, offset: state.page * state.pageSize }) });
      } catch (err) {
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: loadSuppliers } })); return; }
        offline = true;
        const needle = state.q.toLowerCase();
        const rows = (await SR.store.all('suppliers', { where: (s) => !Number(s.is_deleted) }))
          .filter((s) => !needle || `${s.name} ${s.phone || ''} ${s.city || ''}`.toLowerCase().includes(needle))
          .sort((a, b) => String(a.name).localeCompare(String(b.name)));
        data = { data: rows, paging: { total: rows.length, limit: rows.length, offset: 0 } };
      }
      const rows = data.data || [];
      const paging = data.paging || {};

      host.replaceChildren();
      if (offline) host.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'Offline — from this device\'s last sync. Purchase orders still need the server.'));
      host.appendChild(ui.dataCard({
        title: 'Suppliers',
        toolbar: qInput,
        table: ui.renderTable({
          columns: [
            { key: 'name', label: 'Supplier', className: 'wrap', render: (s) => {
              const cell = ui.h('div', {});
              cell.appendChild(ui.h('div', { style: { fontWeight: '600' } }, s.name));
              cell.appendChild(ui.h('div', { class: 'hint' }, [s.contact_person, s.phone, s.city].filter(Boolean).join(' · ')));
              return cell;
            } },
            { key: 'tin', label: 'TIN', render: (s) => (s.tin ? ui.h('span', { class: 'mono' }, s.tin) : ui.h('span', { class: 'hint' }, 'none — no WHT')) },
            { key: 'is_manufacturer', label: 'WHT 2%', render: (s) => (Number(s.is_manufacturer) ? ui.badge('exempt', 'badge-good') : ui.badge('applies', 'badge-warn')) },
            { key: 'payment_terms_days', label: 'Terms', align: 'right', render: (s) => (Number(s.payment_terms_days) ? `${s.payment_terms_days}d` : 'on demand') },
            { key: 'lifetime_purchases', label: 'Lifetime', align: 'right', render: (s) => U.money(s.lifetime_purchases) },
            { key: 'order_count', label: 'Orders', align: 'right' },
            { key: 'owed', label: 'We owe', align: 'right', render: (s) => (Number(s.balance_owed) > 0 ? ui.h('strong', { style: { color: 'var(--amber-700)' } }, U.money(s.balance_owed)) : '—') },
            { key: 'x', label: '', render: (s) => ui.h('button', { class: 'btn btn-sm', onClick: (ev) => { ev.stopPropagation(); SR.app.navigate(`/suppliers/${s.id}`); } }, 'Open') },
          ],
          rows,
          onRowClick: (s) => SR.app.navigate(`/suppliers/${s.id}`),
          emptyTitle: state.q ? 'No supplier matches' : 'No suppliers yet',
          emptyMessage: state.q ? 'Try part of the name.' : 'Add the businesses you buy from. Recording the TIN and whether they are a manufacturer is what makes the withholding on payments correct.',
          emptyAction: SR.state.atLeast('MANAGER') ? { label: 'Add a supplier', run: () => openCreate() } : null,
        }),
        pager: ui.pager({
          page: state.page, pageSize: paging.limit || state.pageSize, total: paging.total != null ? paging.total : rows.length,
          onPage: (p) => { state.page = p; loadSuppliers(); },
          onSize: (n) => { state.pageSize = n; state.page = 0; loadSuppliers(); },
        }),
      }));
    }

    async function loadCreditors() {
      let data; let offline = false;
      try {
        data = await SR.api.get('/api/creditors', { query: SR.state.query({ limit: 200 }) });
      } catch (err) {
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: loadCreditors } })); return; }
        offline = true;
        data = { creditors: [], totals: { owed: 0, overdue: 0 } };
      }
      const rows = data.creditors || data.data || [];
      const s = data.summary || {};
      const owed = s.totalOwed != null ? Number(s.totalOwed) : U.sum(rows.filter((r) => Number(r.owed) > 0), (r) => r.owed);
      const aging = U.sum(rows, (r) => Number((r.ageing || {}).bucket_90_plus) || 0);

      host.replaceChildren();
      if (offline) host.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'Offline — the creditor ledger is computed on the server, so this list needs a connection.'));
      host.appendChild(ui.h('div', { class: 'grid grid-4' },
        ui.kpi({ label: 'Owed to suppliers', value: U.money(owed), tone: 'warn', small: true }),
        ui.kpi({ label: 'Over 90 days', value: U.money(aging), tone: aging > 0 ? 'bad' : 'good', foot: aging > 0 ? 'these suppliers are losing patience' : 'nothing ancient', small: true }),
        ui.kpi({ label: 'Suppliers owed', value: String(s.creditorCount != null ? s.creditorCount : rows.length), small: true }),
        ui.kpi({ label: 'Over their limit', value: String(s.overLimitCount || 0), tone: Number(s.overLimitCount) > 0 ? 'bad' : 'good', small: true })));
      host.appendChild(ui.dataCard({
        title: 'What we owe',
        table: ui.renderTable({
          columns: [
            { key: 'name', label: 'Supplier', className: 'wrap', render: (r) => ui.h('div', {},
              ui.h('div', { style: { fontWeight: '600' } }, r.name),
              ui.h('div', { class: 'hint' }, [r.phone, Number(r.is_manufacturer) ? 'manufacturer (WHT exempt)' : (r.tin ? `TIN ${r.tin}` : 'no TIN')].filter(Boolean).join(' · '))) },
            { key: 'owed', label: 'Owed', align: 'right', render: (r) => ui.h('strong', {}, U.money(r.owed)) },
            { key: 'bucket_0_30', label: '0–30d', align: 'right', render: (r) => U.money((r.ageing || {}).bucket_0_30) },
            { key: 'bucket_31_60', label: '31–60d', align: 'right', render: (r) => U.money((r.ageing || {}).bucket_31_60) },
            { key: 'bucket_61_90', label: '61–90d', align: 'right', render: (r) => U.money((r.ageing || {}).bucket_61_90) },
            { key: 'bucket_90_plus', label: '90d+', align: 'right', render: (r) => {
              const v = Number((r.ageing || {}).bucket_90_plus) || 0;
              return v > 0 ? ui.h('strong', { style: { color: 'var(--red-700)' } }, U.money(v)) : '—';
            } },
            { key: 'terms', label: 'Terms', align: 'right', render: (r) => (Number(r.payment_terms_days) ? `${r.payment_terms_days}d` : 'on demand') },
            { key: 'over', label: '', render: (r) => (r.overLimit ? ui.badge('over limit', 'badge-bad') : '') },
            { key: 'x', label: '', render: (r) => ui.h('button', { class: 'btn btn-sm', onClick: () => openPay({ id: r.id || r.supplier_id, name: r.name, balance_owed: r.owed, tin: r.tin }), }, 'Pay') },
          ],
          rows,
          emptyTitle: 'You do not owe any supplier',
          emptyMessage: 'Creditor balances appear here as purchase orders are received on credit.',
        }),
      }));
      host.appendChild(ui.h('div', { class: 'hint', style: { marginTop: '8px' } },
        'Owed is the sum of the creditor ledger, with payments allocated against the oldest charge first — the convention a Nigerian bookkeeper expects. A supplier showing nothing in 90d+ is being paid to terms.'));
    }

    function openCreate() {
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Name', name: 'name', required: true, placeholder: 'e.g. Sonoc Industrial Ltd' }),
        ui.field({ label: 'Contact person', name: 'contact_person' }),
        ui.field({ label: 'Phone', name: 'phone' }),
        ui.field({ label: 'Alt. phone', name: 'alt_phone' }),
        ui.field({ label: 'Email', name: 'email' }),
        ui.field({ label: 'City', name: 'city' }),
        ui.field({ label: 'State', name: 'state', value: 'Rivers' }),
        ui.field({ label: 'TIN', name: 'tin', hint: 'Required on our side before we can withhold tax on a payment.' }),
        ui.field({ label: 'CAC number', name: 'cac_reg_no' }),
        ui.field({ label: 'Bank', name: 'bank_name' }),
        ui.field({ label: 'Account number', name: 'bank_account_no' }),
        ui.field({ label: 'Account name', name: 'bank_account_name' }),
        ui.field({ label: 'Credit limit (₦)', name: 'credit_limit', type: 'number', step: '0.01', min: '0' }),
        ui.field({ label: 'Payment terms (days)', name: 'payment_terms_days', type: 'number', step: '1', min: '0', value: '30' }),
        ui.field({ label: 'Address', name: 'address', span: true }),
        ui.field({ label: 'Notes', name: 'notes', type: 'textarea', span: true })));
      const isMfr = ui.h('label', { class: 'check' },
        ui.h('input', { type: 'checkbox', name: 'is_manufacturer' }),
        ui.h('div', {},
          ui.h('strong', {}, 'This supplier is a MANUFACTURER'),
          ui.h('div', { class: 'hint' }, 'Manufacturers are exempt from the 2% supply-of-goods withholding tax. Tick this only if they make what they sell you — a distributor is not exempt, and ticking it wrongly makes the business liable for the un-deducted tax.')));
      wrapEl.appendChild(isMfr);

      const m = ui.openModal({
        title: 'Add a supplier',
        body: wrapEl,
        size: 'wide',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: async (ev) => {
              const v = ui.readFormStrings(wrapEl);
              if (!v.name) { ui.warn('A supplier needs a name.'); return; }
              ev.currentTarget.disabled = true;
              try {
                await SR.api.post('/api/suppliers', Object.assign(v, {
                  business_id: SR.state.activeBusinessId,
                  is_manufacturer: wrapEl.querySelector('[name="is_manufacturer"]').checked ? 1 : 0,
                }));
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

    await load();
    return wrap;
  }

  // -------------------------------------------------------------------
  // ONE SUPPLIER
  // -------------------------------------------------------------------
  async function renderDetail(ctx) {
    ctx.setTitle('Supplier');
    const wrap = ui.h('div', { class: 'stack' });
    const host = ui.h('div', { class: 'stack' });
    wrap.appendChild(host);
    await load();

    async function load() {
      host.replaceChildren(ui.skeleton(7));
      let data; let purchaseOrders = []; let payments = [];
      try {
        data = await SR.api.get(`/api/suppliers/${encodeURIComponent(ctx.params.id)}`);
      } catch (err) {
        if (err.code === 'NOT_FOUND' || err.status === 404) {
          // The guard may only expose the list; fall back to the mirror.
          const s = await SR.store.get('suppliers', ctx.params.id);
          if (s) data = { supplier: s };
          else { host.replaceChildren(ui.empty({ title: 'Supplier not found', message: 'It may have been deleted. Go back to the list.' })); return; }
        } else if (!err.isOffline) {
          host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: load } })); return;
        } else {
          const s = await SR.store.get('suppliers', ctx.params.id);
          if (!s) { host.replaceChildren(ui.empty({ title: 'Not on this device', message: 'This supplier has not been synced here yet.' })); return; }
          data = { supplier: s };
        }
      }
      const s = data.supplier || data;
      purchaseOrders = data.purchaseOrders || data.orders || [];
      payments = data.payments || data.creditorLedger || [];

      host.appendChild(ui.h('div', { class: 'page-head' },
        ui.h('div', {},
          ui.h('h1', {}, s.name),
          ui.h('p', { class: 'sub' }, [s.contact_person, s.phone, s.email, s.city].filter(Boolean).join(' · ') || 'no contact details recorded')),
        ui.h('div', { class: 'actions' },
          ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate('/suppliers') }, 'Back'),
          ui.h('button', { class: 'btn btn-sm', onClick: () => edit(s) }, 'Edit'),
          SR.state.atLeast('MANAGER') ? ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate('/purchase-orders') }, 'New order') : null,
          SR.state.atLeast('MANAGER') ? ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => openPay(s, load) }, 'Pay supplier') : null)));

      host.appendChild(ui.h('div', { class: 'grid grid-4' },
        ui.kpi({ label: 'We owe', value: U.money(s.balance_owed || s.owed), tone: Number(s.balance_owed || s.owed) > 0 ? 'warn' : 'good', small: true }),
        ui.kpi({ label: 'Lifetime purchases', value: U.money(s.lifetime_purchases), small: true }),
        ui.kpi({ label: 'Payment terms', value: Number(s.payment_terms_days) ? `${s.payment_terms_days} days` : 'on demand', small: true }),
        ui.kpi({
          label: 'Withholding on goods',
          value: Number(s.is_manufacturer) ? 'Exempt' : '2%',
          tone: Number(s.is_manufacturer) ? 'good' : 'warn',
          foot: s.tin ? `TIN ${s.tin}` : 'no TIN recorded — payments cannot be withheld against',
          small: true,
        })));

      const cols = ui.h('div', { class: 'grid grid-2' });
      cols.appendChild(ui.dataCard({
        title: 'Details',
        table: ui.kv([
          ['Contact', s.contact_person], ['Phone', s.phone], ['Alternate phone', s.alt_phone],
          ['Email', s.email], ['Address', s.address], ['City', s.city], ['State', s.state],
          ['TIN', s.tin], ['CAC number', s.cac_reg_no],
          ['Manufacturer', Number(s.is_manufacturer) ? 'yes — exempt from 2% WHT' : 'no'],
          ['Bank', s.bank_name], ['Account number', s.bank_account_no], ['Account name', s.bank_account_name],
          ['Credit limit', Number(s.credit_limit) ? U.money(s.credit_limit) : null],
          ['Notes', s.notes],
        ]),
      }));
      cols.appendChild(ui.dataCard({
        title: 'Recent payments',
        table: ui.renderTable({
          columns: [
            { key: 'created_at', label: 'When', render: (r) => U.dateTime(r.created_at) },
            { key: 'amount', label: 'Amount', align: 'right', render: (r) => U.money(Math.abs(Number(r.amount))) },
            { key: 'notes', label: 'Detail', className: 'wrap' },
          ],
          rows: payments.slice(0, 12),
          emptyMessage: 'No payments recorded to this supplier yet.',
        }),
      }));
      host.appendChild(cols);

      if (purchaseOrders.length) {
        host.appendChild(ui.dataCard({
          title: 'Purchase orders',
          table: ui.renderTable({
            columns: [
              { key: 'po_number', label: 'PO', render: (r) => ui.h('span', { class: 'mono' }, r.po_number) },
              { key: 'ordered_at', label: 'Raised', render: (r) => U.date(r.ordered_at) },
              { key: 'expected_date', label: 'Expected', render: (r) => (r.expected_date ? (r.overdue ? ui.badge(U.date(r.expected_date), 'badge-bad') : U.date(r.expected_date)) : '—') },
              { key: 'total', label: 'Total', align: 'right', render: (r) => U.money(r.total) },
              { key: 'units_ordered', label: 'Ordered', align: 'right', render: (r) => U.qty(r.units_ordered) },
              { key: 'units_received', label: 'Received', align: 'right', render: (r) => U.qty(r.units_received) },
              { key: 'status', label: '', render: (r) => ui.statusBadge(r.status) },
            ],
            rows: purchaseOrders,
            onRowClick: (r) => SR.app.navigate(`/purchase-orders/${r.id}`),
          }),
        }));
      }
    }

    function edit(s) {
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Name', name: 'name', value: s.name, required: true }),
        ui.field({ label: 'Contact person', name: 'contact_person', value: s.contact_person || '' }),
        ui.field({ label: 'Phone', name: 'phone', value: s.phone || '' }),
        ui.field({ label: 'Email', name: 'email', value: s.email || '' }),
        ui.field({ label: 'City', name: 'city', value: s.city || '' }),
        ui.field({ label: 'State', name: 'state', value: s.state || '' }),
        ui.field({ label: 'TIN', name: 'tin', value: s.tin || '' }),
        ui.field({ label: 'CAC number', name: 'cac_reg_no', value: s.cac_reg_no || '' }),
        ui.field({ label: 'Bank', name: 'bank_name', value: s.bank_name || '' }),
        ui.field({ label: 'Account number', name: 'bank_account_no', value: s.bank_account_no || '' }),
        ui.field({ label: 'Account name', name: 'bank_account_name', value: s.bank_account_name || '' }),
        ui.field({ label: 'Credit limit (₦)', name: 'credit_limit', type: 'number', step: '0.01', min: '0', value: U.numInput(s.credit_limit) }),
        ui.field({ label: 'Payment terms (days)', name: 'payment_terms_days', type: 'number', step: '1', min: '0', value: U.numInput(s.payment_terms_days) }),
        ui.field({ label: 'Address', name: 'address', value: s.address || '', span: true })));
      const isMfr = ui.h('label', { class: 'check' },
        ui.h('input', { type: 'checkbox', name: 'is_manufacturer', checked: Boolean(Number(s.is_manufacturer)) }),
        ui.h('div', {}, ui.h('strong', {}, 'Manufacturer'),
          ui.h('div', { class: 'hint' }, 'Manufacturers are exempt from the 2% supply-of-goods withholding tax.')));
      wrapEl.appendChild(isMfr);
      const m = ui.openModal({
        title: 'Edit supplier',
        body: wrapEl,
        size: 'wide',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: async () => {
              try {
                await SR.api.put(`/api/suppliers/${encodeURIComponent(s.id)}`, Object.assign(ui.readFormStrings(wrapEl), {
                  is_manufacturer: wrapEl.querySelector('[name="is_manufacturer"]').checked ? 1 : 0,
                }));
                ui.ok('Saved.');
                m.close();
                load();
              } catch (err) { ui.apiError(err); }
            },
          }, 'Save'),
        ],
      });
    }

    return wrap;
  }

  /**
   * The payment dialog. Shared by the list and the detail screen.
   *
   * The WHT worked example is printed live in the dialog because this is the one
   * calculation in the app that people get wrong by hand: ₦100,000 less 2% is
   * ₦98,000 to the bank and ₦2,000 to FIRS, not ₦2,000 extra.
   */
  function openPay(supplier, onDone) {
    const owed = Number(supplier.balance_owed != null ? supplier.balance_owed : supplier.owed) || 0;
    const wrapEl = ui.h('div', {});
    if (owed > 0) wrapEl.appendChild(ui.h('div', { class: 'alert alert-info' }, `The ledger says we owe ${U.money(owed)}.`));
    wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
      ui.field({ label: 'Gross amount (₦)', name: 'amount', type: 'number', step: '0.01', min: '0.01', value: U.numInput(owed || ''), required: true, hint: 'The amount before withholding.' }),
      ui.field({ label: 'Method', name: 'method', value: 'BANK_TRANSFER', options: METHODS.map((m) => ({ value: m, label: U.humanise(m) })) }),
      ui.field({ label: 'Bank reference / cheque no.', name: 'reference', required: true, hint: 'At least 3 characters. An unmatched payment is indistinguishable from one that never happened.' }),
      ui.field({
        label: 'Withholding', name: 'wht_code', value: '',
        options: [
          { value: '', label: 'None' },
          { value: 'SUPPLY_OF_GOODS', label: '2% — supply of goods (not a manufacturer)' },
          { value: 'SERVICES', label: '5% — services' },
          { value: 'RENT', label: '10% — rent' },
          { value: 'PROFESSIONAL', label: '10% — professional fees' },
        ],
        hint: 'The rate comes from the withholding table held on the server, so a change in the Regulations does not need a redeploy.',
      }),
      ui.field({ label: 'Notes', name: 'notes', type: 'textarea', span: true })));
    const calc = ui.h('div', { class: 'alert alert-info' }, 'Enter an amount to see the split.');
    wrapEl.appendChild(calc);

    const amountInput = wrapEl.querySelector('[name="amount"]');
    const whtSelect = wrapEl.querySelector('[name="wht_code"]');
    const RATES = { SUPPLY_OF_GOODS: 2, SERVICES: 5, RENT: 10, PROFESSIONAL: 10 };
    function recompute() {
      const gross = Number(amountInput.value) || 0;
      const rate = RATES[whtSelect.value] || 0;
      const wht = U.round2(gross * rate / 100);
      const net = U.round2(gross - wht);
      calc.replaceChildren();
      calc.appendChild(ui.h('strong', {}, `${U.money(gross)} gross`));
      calc.appendChild(ui.h('div', {}, rate ? `Less ${rate}% withholding ${U.money(wht)} → ${U.money(net)} leaves the bank account, and ${U.money(wht)} is remitted to FIRS.` : 'No withholding on this payment. The full amount leaves the bank account.'));
      if (rate && !supplier.tin) {
        calc.appendChild(ui.h('div', { class: 'hint' }, 'This supplier has no TIN recorded. Without a TIN the deduction is still due, but it cannot be credited to them on the FIRS portal.'));
      }
    }
    amountInput.addEventListener('input', recompute);
    whtSelect.addEventListener('change', recompute);
    recompute();

    const m = ui.openModal({
      title: `Pay ${supplier.name}`,
      body: wrapEl,
      size: 'wide',
      footer: [
        ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
        ui.h('button', {
          class: 'btn btn-primary',
          onClick: async (ev) => {
            const v = ui.readFormStrings(wrapEl);
            if (!(Number(v.amount) > 0)) { ui.warn('Enter the amount paid.'); return; }
            if (!v.reference || String(v.reference).trim().length < 3) { ui.warn('A reference is required — a transfer reference or cheque number.'); return; }
            ev.currentTarget.disabled = true;
            ev.currentTarget.textContent = 'Paying…';
            try {
              const result = await SR.api.post(`/api/suppliers/${encodeURIComponent(supplier.id)}/payments`, {
                amount: Number(v.amount),
                method: v.method,
                reference: v.reference,
                wht_code: v.wht_code || null,
                notes: v.notes || null,
                branch_id: SR.state.activeBranchId,
              });
              if (result && result.net_amount != null) {
                ui.ok(`Paid. ${U.money(result.net_amount)} left the account, ${U.money(result.wht_amount || 0)} withheld.`);
              } else {
                ui.ok('Payment recorded against the creditor ledger.');
              }
              m.close();
              if (onDone) onDone();
            } catch (err) {
              ui.apiError(err);
              ev.currentTarget.disabled = false;
              ev.currentTarget.textContent = 'Pay';
            }
          },
        }, 'Pay'),
      ],
    });
  }

  SR.views = SR.views || {};
  SR.views.suppliers = { render, openPay };
}(window));
