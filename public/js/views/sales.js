'use strict';
// =====================================================================
// public/js/views/sales.js — THE SALES BOOK, AND ONE SALE IN FULL
// =====================================================================
// Two screens in one file: the list (a filterable book of every receipt) and the
// detail (everything that happened on one sale, and the actions available on it).
//
// The detail screen is where the interesting decisions live:
//   * VOID is offered only where the server would allow it, and always asks for
//     a real reason — a void with no reason is the signature of a theft.
//   * SETTLE is offered on anything with a balance, and is explicitly NOT a new
//     sale: it posts cash against a receivable.
//   * The journal entry is shown, because "did this reach the books?" is the
//     question an owner actually asks, and the answer should not require a
//     second screen.
// =====================================================================
(function (global) {
  const SR = global.SR;
  const ui = SR.ui;
  const U = SR.util;

  const PAGE_SIZE = 50;

  async function render(ctx) {
    if (ctx.params.id) return renderDetail(ctx);
    ctx.setTitle('Sales');
    const state = { page: 0, pageSize: PAGE_SIZE, q: '', from: ctx.query.from || U.todayWat(-30), to: ctx.query.to || U.todayWat(), type: '', status: '', method: '', sort: 'date' };

    const wrap = ui.h('div', { class: 'stack' });
    const head = ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Sales'),
        ui.h('p', { class: 'sub' }, 'Every receipt rung through the branches you can see.')),
      ui.h('div', { class: 'actions' },
        ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => SR.app.navigate('/pos') }, 'New sale'),
        ui.h('button', {
          class: 'btn btn-sm',
          onClick: () => SR.exporter.list({
            filename: 'sales', path: '/api/sales', query: filterQuery(), mirrorTable: null,
            columns: [
              { key: 'receipt_no', label: 'Receipt' }, { key: 'sold_at', label: 'Date (WAT)' },
              { key: 'branch_name', label: 'Branch' }, { key: 'cashier_name', label: 'Cashier' },
              { key: 'customer_name', label: 'Customer' }, { key: 'sale_type', label: 'Type' },
              { key: 'payment_method', label: 'Payment' }, { key: 'total', label: 'Total' },
              { key: 'amount_paid', label: 'Paid' }, { key: 'balance_due', label: 'Balance' },
              { key: 'status', label: 'Status' },
            ],
          }),
        }, 'Export CSV'),
        ui.h('button', { class: 'btn btn-sm', onClick: () => SR.exporter.reportDialog() }, 'Server reports')));
    wrap.appendChild(head);

    // ---- filters
    const filters = ui.h('div', { class: 'card' });
    const fbody = ui.h('div', { class: 'card-body row' });
    const qInput = ui.h('input', { type: 'search', placeholder: 'Receipt, customer or cashier…', style: { minWidth: '200px' } });
    qInput.value = state.q;
    fbody.appendChild(ui.h('div', { class: 'grow' }, qInput));
    fbody.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'From'), ui.h('input', { type: 'date', value: state.from, onchange: (e) => { state.from = e.target.value; state.page = 0; load(); } })));
    fbody.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'To'), ui.h('input', { type: 'date', value: state.to, onchange: (e) => { state.to = e.target.value; state.page = 0; load(); } })));
    const typeSel = ui.h('select', { onchange: (e) => { state.type = e.target.value; state.page = 0; load(); } });
    typeSel.appendChild(ui.h('option', { value: '' }, 'All types'));
    for (const t of ['RETAIL', 'WHOLESALE', 'CREDIT', 'INSTALMENT', 'LAYAWAY', 'EXCHANGE']) typeSel.appendChild(ui.h('option', { value: t }, U.humanise(t)));
    fbody.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Type'), typeSel));
    const statusSel = ui.h('select', { onchange: (e) => { state.status = e.target.value; state.page = 0; load(); } });
    for (const [v, l] of [['', 'Any status'], ['COMPLETED', 'Completed'], ['VOIDED', 'Voided'], ['PENDING_DELIVERY', 'Pending delivery']]) statusSel.appendChild(ui.h('option', { value: v }, l));
    fbody.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Status'), statusSel));
    filters.appendChild(fbody);
    wrap.appendChild(filters);

    const summaryHost = ui.h('div', {});
    wrap.appendChild(summaryHost);
    const listHost = ui.h('div', {});
    wrap.appendChild(listHost);

    qInput.addEventListener('input', U.debounce(() => { state.q = qInput.value; state.page = 0; load(); }, 320));

    function filterQuery() {
      return Object.assign(SR.state.query({
        q: state.q || undefined,
        from: state.from, to: state.to,
        sale_type: state.type || undefined,
        status: state.status || undefined,
        limit: state.pageSize, offset: state.page * state.pageSize,
      }));
    }

    async function load() {
      listHost.replaceChildren(ui.skeleton(6));
      summaryHost.replaceChildren();
      let data = null; let offline = false;
      try {
        data = await SR.api.get('/api/sales', { query: filterQuery() });
      } catch (err) {
        if (!err.isOffline) { listHost.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: load } })); return; }
        offline = true;
        data = await fromMirror();
      }
      const rows = data.data || data.rows || [];
      const paging = data.paging || {};
      if (data.summary) {
        summaryHost.appendChild(ui.h('div', { class: 'grid grid-4' },
          ui.kpi({ label: 'Receipts', value: String(data.summary.count || rows.length), small: true }),
          ui.kpi({ label: 'Revenue', value: U.money(data.summary.revenue || data.summary.gross), tone: 'good', small: true }),
          ui.kpi({ label: 'Collected', value: U.money(data.summary.collected || data.summary.paid), small: true }),
          ui.kpi({ label: 'Outstanding', value: U.money(data.summary.outstanding || data.summary.balance), tone: Number(data.summary.outstanding) > 0 ? 'warn' : null, small: true })));
      }
      const columns = [
        { key: 'receipt_no', label: 'Receipt', render: (r) => ui.h('span', { class: 'mono' }, r.receipt_no || '—') },
        { key: 'sold_at', label: 'Date (WAT)', render: (r) => U.soldAt(r.sold_at) },
        { key: 'branch_name', label: 'Branch' },
        { key: 'customer_name', label: 'Customer', className: 'wrap' },
        { key: 'sale_type', label: 'Type', render: (r) => ui.badge(r.sale_type, r.sale_type === 'RETAIL' ? 'badge-mute' : 'badge-info') },
        { key: 'cashier_name', label: 'Cashier' },
        { key: 'item_count', label: 'Items', align: 'right' },
        { key: 'total', label: 'Total', align: 'right', render: (r) => U.money(r.total) },
        { key: 'balance_due', label: 'Balance', align: 'right', render: (r) => (Number(r.balance_due) > 0 ? ui.h('strong', { style: { color: 'var(--amber-700)' } }, U.money(r.balance_due)) : '—') },
        { key: 'status', label: '', render: (r) => ui.statusBadge(r.status) },
      ];
      const table = ui.renderTable({
        columns,
        rows,
        onRowClick: (r) => SR.app.navigate(`/sales/${r.id}`),
        emptyTitle: 'No sales in this range',
        emptyMessage: 'Widen the dates, or clear the filters. Sales rung through the counter appear here the moment they are recorded.',
        emptyAction: { label: 'Go to the counter', run: () => SR.app.navigate('/pos') },
      });
      const total = paging.total != null ? paging.total : rows.length;
      const perPage = paging.limit || state.pageSize;
      const pagerBar = ui.pager({
        page: state.page, pageSize: perPage, total,
        onPage: (p) => { state.page = p; load(); },
        onSize: (n) => { state.pageSize = n; state.page = 0; load(); },
      });
      listHost.replaceChildren();
      if (offline) listHost.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'Offline — showing the sales this device recorded and the ones it last synced.'));
      listHost.appendChild(ui.dataCard({ title: 'Receipts', table, pager: pagerBar }));
    }

    async function fromMirror() {
      const outbox = await SR.store.outboxAll();
      const queued = outbox.filter((o) => o.type === 'SALE' && ['PENDING', 'RETRY'].includes(o.status))
        .map((o) => {
          const p = o.payload || {};
          return {
            id: o.client_id, receipt_no: `(queued) ${String(o.client_id).slice(-6)}`,
            sold_at: o.occurred_at, sale_type: p.sale_type || 'RETAIL',
            customer_name: p.customer_name || 'Walk-in', total: p._expectedTotal || 0,
            balance_due: 0, status: 'QUEUED', item_count: (p.lines || []).length,
            cashier_name: (SR.state.user || {}).fullName,
          };
        });
      return { data: queued, paging: { total: queued.length, limit: queued.length, offset: 0 } };
    }

    function fromMirrorSales() { return fromMirror(); }
    void fromMirrorSales;

    await load();
    return wrap;
  }

  // -------------------------------------------------------------------
  // ONE SALE
  // -------------------------------------------------------------------
  async function renderDetail(ctx) {
    ctx.setTitle('Sale');
    const wrap = ui.h('div', { class: 'stack' });
    const host = ui.h('div', { class: 'stack' });
    wrap.appendChild(host);
    await load();

    async function load() {
      host.replaceChildren(ui.skeleton(7));
      let data;
      try {
        data = await SR.api.get(`/api/sales/${encodeURIComponent(ctx.params.id)}`);
      } catch (err) {
        if (err.status === 404) {
          // It may be a sale this device queued that the server has not seen.
          const queued = (await SR.store.outboxAll()).find((o) => o.client_id === ctx.params.id);
          if (queued) { host.replaceChildren(queuedCard(queued)); return; }
        }
        host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Reload', run: load } }));
        return;
      }
      const sale = data.sale || data;
      const items = data.items || sale.items || [];
      const payments = data.payments || sale.payments || [];
      const journal = data.journal || [];
      const serials = data.serials || [];

      const head = ui.h('div', { class: 'page-head' },
        ui.h('div', {},
          ui.h('h1', {}, `Receipt ${sale.receipt_no || '—'}`),
          ui.h('p', { class: 'sub' }, `${U.soldAt(sale.sold_at)} · ${sale.branch_name || SR.state.activeBranchName()} · ${sale.cashier_name || '—'}`)),
        ui.h('div', { class: 'actions' },
          ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate('/sales') }, 'Back to sales'),
          repaintButton(sale, items, payments)));
      host.appendChild(head);

      if (sale.status === 'VOIDED') {
        host.appendChild(ui.h('div', { class: 'alert alert-danger' },
          ui.h('strong', {}, 'This sale was voided. '),
          `${U.dateTime(sale.voided_at)} — ${sale.void_reason || 'no reason recorded'}. The stock was returned and the ledger reversed; nothing was deleted.`));
      }
      if (Number(sale.balance_due) > 0.01 && sale.status !== 'VOIDED') {
        const settle = ui.h('button', { class: 'btn btn-primary btn-sm', onClick: () => openSettle(sale) }, 'Take payment');
        host.appendChild(ui.h('div', { class: 'alert alert-warn row' },
          ui.h('span', { class: 'grow' }, `${U.money(sale.balance_due)} is still owed on this receipt.`), settle));
      }

      const totals = ui.h('div', { class: 'grid grid-5' },
        ui.kpi({ label: 'Total', value: U.money(sale.total), small: true }),
        ui.kpi({ label: 'Paid', value: U.money(sale.amount_paid), small: true, tone: 'good' }),
        ui.kpi({ label: 'Balance', value: U.money(sale.balance_due), small: true, tone: Number(sale.balance_due) > 0 ? 'warn' : null }),
        ui.kpi({ label: 'VAT included', value: U.money(sale.vat_amount), small: true }),
        ui.kpi({ label: 'Status', value: U.humanise(sale.status), small: true }));
      host.appendChild(totals);

      const cols = ui.h('div', { class: 'grid grid-2' });

      cols.appendChild(ui.dataCard({
        title: 'Items',
        table: ui.renderTable({
          columns: [
            { key: 'product_name', label: 'Item', className: 'wrap' },
            { key: 'serial_no', label: 'Serial', render: (r) => r.serial_no || '—' },
            { key: 'quantity', label: 'Qty', align: 'right', render: (r) => `${U.qty(r.quantity)} ${r.unit_code || ''}` },
            { key: 'unit_price', label: 'Price', align: 'right', render: (r) => U.money(r.unit_price) },
            { key: 'line_total', label: 'Total', align: 'right', render: (r) => U.money(r.line_total) },
          ],
          rows: items,
        }),
      }));

      const side = ui.h('div', { class: 'stack' });
      side.appendChild(ui.dataCard({
        title: 'Payments',
        table: ui.renderTable({
          columns: [
            { key: 'method', label: 'Method', render: (r) => U.humanise(r.method) },
            { key: 'reference', label: 'Reference', render: (r) => r.reference || '—' },
            { key: 'amount', label: 'Amount', align: 'right', render: (r) => U.money(r.amount) },
          ],
          rows: payments,
          emptyMessage: 'No payment was recorded against this receipt.',
        }),
      }));
      side.appendChild(ui.dataCard({
        title: 'What this sale did',
        table: ui.kv([
          ['Branch', sale.branch_name || '—'],
          ['Cashier', sale.cashier_name || '—'],
          ['Customer', sale.customer_name || 'Walk-in'],
          ['Customer phone', sale.customer_phone || null],
          ['Sale type', U.humanise(sale.sale_type)],
          ['Payment method', U.humanise(sale.payment_method || '—')],
          ['Subtotal', U.money(sale.subtotal)],
          ['Line discounts', U.money(sale.discount_amount)],
          ['Order discount', Number(sale.order_discount_amount) ? U.money(sale.order_discount_amount) : null],
          ['Delivery fee', Number(sale.delivery_fee) ? U.money(sale.delivery_fee) : null],
          ['Change given', Number(sale.change_given) ? U.money(sale.change_given) : null],
          ['Change owed', Number(sale.change_owed) ? U.money(sale.change_owed) : null],
          ['Till', sale.till_session_id ? sale.till_session_id.slice(0, 8) : null],
          ['Notes', sale.notes || null],
        ]),
      }));
      cols.appendChild(side);
      host.appendChild(cols);

      if (serials.length) {
        host.appendChild(ui.dataCard({
          title: 'Serial numbers on this sale',
          table: ui.renderTable({
            columns: [
              { key: 'serial_no', label: 'Serial' },
              { key: 'product_name', label: 'Product' },
              { key: 'warranty_start', label: 'Warranty from', render: (r) => U.date(r.warranty_starts_at || sale.sold_at, { zone: 'wat' }) },
              { key: 'warranty_end', label: 'Warranty to', render: (r) => (r.warranty_ends_at ? U.date(r.warranty_ends_at) : '—') },
            ],
            rows: serials,
          }),
        }));
      }

      if (journal.length) {
        const debit = journal.reduce((a, l) => a + Number(l.debit || 0), 0);
        const credit = journal.reduce((a, l) => a + Number(l.credit || 0), 0);
        host.appendChild(ui.dataCard({
          title: 'Posted to the books',
          toolbar: ui.h('span', { class: `badge ${Math.abs(debit - credit) < 0.01 ? 'badge-good' : 'badge-bad'}` },
            Math.abs(debit - credit) < 0.01 ? 'balanced' : `out by ${U.money(Math.abs(debit - credit))}`),
          table: ui.renderTable({
            columns: [
              { key: 'account_code', label: 'Code', render: (r) => ui.h('span', { class: 'mono' }, r.account_code) },
              { key: 'account_name', label: 'Account', className: 'wrap' },
              { key: 'debit', label: 'Debit', align: 'right', render: (r) => (Number(r.debit) ? U.money(r.debit) : '—') },
              { key: 'credit', label: 'Credit', align: 'right', render: (r) => (Number(r.credit) ? U.money(r.credit) : '—') },
            ],
            rows: journal,
            foot: ['', 'Totals', U.money(debit), U.money(credit)],
          }),
        }));
      }

      // ---- actions
      const canVoid = sale.status !== 'VOIDED' && canVoidThis(sale);
      const actions = ui.h('div', { class: 'card' });
      actions.appendChild(ui.h('div', { class: 'card-head' }, ui.h('h2', {}, 'Actions')));
      const abody = ui.h('div', { class: 'card-body' });
      abody.appendChild(ui.h('div', { class: 'btn-row' },
        ui.h('button', { class: 'btn', onClick: () => SR.print.preview(SR.print.saleReceipt(sale, { brand: (SR.state.settings || {}).business_name || 'StockRidge', footer: (SR.state.settings || {}).receipt_footer_text || '' }), { title: `Receipt ${sale.receipt_no}` }) }, 'Print receipt'),
        ui.h('button', {
          class: 'btn',
          onClick: () => openReturn(sale, items),
        }, 'Start a return'),
        canVoid ? ui.h('button', { class: 'btn btn-danger', onClick: () => openVoid(sale) }, 'Void this sale') : null,
        Number(sale.balance_due) > 0.01 && sale.status !== 'VOIDED' ? ui.h('button', { class: 'btn', onClick: () => openSettle(sale) }, 'Settle balance') : null));
      if (!canVoid && sale.status !== 'VOIDED') {
        abody.appendChild(ui.h('div', { class: 'hint' },
          'You cannot void this sale. A void is allowed for a manager at any time, and for staff only on their own sale inside the window the owner has set.'));
      }
      actions.appendChild(abody);
      host.appendChild(actions);

      void payments;
    }

    function canVoidThis(sale) {
      if (SR.state.atLeast('MANAGER')) return true;
      const mine = String(sale.salesperson_id || '') === String((SR.state.user || {}).id);
      const window = Number((SR.state.settings || {}).staff_void_window_minutes || 0);
      if (!mine || !window) return false;
      const mins = minutesSince(sale.sold_at);
      return mins != null && mins >= 0 && mins <= window;
    }

    function minutesSince(watStamp) {
      const d = U.parseStamp(watStamp, { zone: 'wat' });
      return d ? Math.floor((Date.now() - d.getTime()) / 60000) : null;
    }

    function openVoid(sale) {
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('p', {}, `Voiding receipt ${sale.receipt_no} for ${U.money(sale.total)}. The stock goes back onto the shelf at the cost it was bought at, the ledger is reversed by a compensating entry, and the reason is recorded against your name.`));
      const reason = ui.h('textarea', { rows: 3, placeholder: 'What went wrong? e.g. "Wrong item scanned — customer bought the 1.5HP, not the 1HP."' });
      wrapEl.appendChild(ui.h('label', { class: 'ctl' }, 'Reason (at least 4 characters)'));
      wrapEl.appendChild(reason);
      wrapEl.appendChild(ui.h('div', { class: 'hint' }, 'The sale itself is never deleted. That is the point: a voided sale stays visible so the pattern of voids can be reviewed.'));
      const m = ui.openModal({
        title: 'Void this sale',
        body: wrapEl,
        size: 'narrow',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-danger',
            onClick: async () => {
              const text = String(reason.value || '').trim();
              if (text.length < 4) { ui.warn('Give a real reason — “wrong” tells nobody anything in three weeks.'); return; }
              try {
                await SR.api.post(`/api/sales/${encodeURIComponent(sale.id)}/void`, { reason: text }, { queue: 'auto' });
                ui.ok('Sale voided. The stock and the ledger have been reversed.');
                m.close();
                load();
              } catch (err) { ui.apiError(err); }
            },
          }, 'Void the sale'),
        ],
      });
    }

    function openSettle(sale) {
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('div', { class: 'alert alert-info' }, `${U.money(sale.balance_due)} outstanding on receipt ${sale.receipt_no}.`));
      const grid = ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Amount (₦)', name: 'amount', type: 'number', step: '0.01', min: '0', value: U.round2(sale.balance_due), required: true }),
        ui.field({ label: 'Method', name: 'method', value: 'CASH', options: ['CASH', 'POS_TERMINAL', 'BANK_TRANSFER', 'MOBILE_MONEY', 'USSD', 'CHEQUE'].map((m) => ({ value: m, label: U.humanise(m) })) }),
        ui.field({ label: 'Reference', name: 'reference', span: true, hint: 'Terminal auth code, transfer reference or cheque number.' }));
      wrapEl.appendChild(grid);
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
              if (!(amount > 0)) { ui.warn('Enter an amount.'); return; }
              if (amount > Number(sale.balance_due) + 0.01) {
                const go = await ui.confirmDialog({
                  title: 'More than the balance',
                  message: `${U.money(amount)} is more than the ${U.money(sale.balance_due)} owed.`,
                  detail: 'The extra will be recorded as change owed to the customer rather than treated as a payment.',
                  confirmLabel: 'Record it',
                });
                if (!go) return;
              }
              try {
                await SR.api.post(`/api/sales/${encodeURIComponent(sale.id)}/pay`, {
                  amount, method: v.method, reference: v.reference || null,
                }, { queue: 'auto' });
                ui.ok('Payment recorded.');
                m.close();
                load();
              } catch (err) { ui.apiError(err); }
            },
          }, 'Record payment'),
        ],
      });
    }

    function openReturn(sale, items) {
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'Which lines are coming back? A return restocks the goods at the cost they were sold from and reverses the revenue and the VAT on the returned lines only.'));
      const list = ui.h('div', { class: 'stack' });
      const chosen = new Map();
      for (const item of items) {
        const row = ui.h('label', { class: 'check' });
        const cb = ui.h('input', { type: 'checkbox' });
        cb.addEventListener('change', () => {
          if (cb.checked) chosen.set(item.id, Number(item.quantity));
          else chosen.delete(item.id);
          qtyInput.disabled = !cb.checked;
        });
        const qtyInput = ui.h('input', { type: 'number', min: '0', max: String(item.quantity), step: 'any', value: String(item.quantity), disabled: true, style: { width: '88px', minHeight: '32px' } });
        qtyInput.addEventListener('change', () => chosen.set(item.id, Number(qtyInput.value) || 0));
        row.appendChild(cb);
        row.appendChild(ui.h('span', { class: 'grow' }, `${item.product_name || item.name} — ${U.money(item.unit_price)}`));
        row.appendChild(qtyInput);
        list.appendChild(row);
      }
      wrapEl.appendChild(list);
      const grid = ui.h('div', { class: 'form-grid', style: { marginTop: '12px' } },
        ui.field({
          label: 'Reason', name: 'reason_code', value: 'FAULTY',
          options: [
            { value: 'FAULTY', label: 'Faulty on arrival' }, { value: 'WRONG_ITEM', label: 'Wrong item' },
            { value: 'NOT_AS_DESCRIBED', label: 'Not as described' }, { value: 'CHANGED_MIND', label: 'Changed their mind' },
            { value: 'DAMAGED_IN_TRANSIT', label: 'Damaged in transit' }, { value: 'WARRANTY', label: 'Warranty claim' },
            { value: 'OTHER', label: 'Other' },
          ],
        }),
        ui.field({
          label: 'Refund as', name: 'refund_method', value: 'ORIGINAL',
          options: [
            { value: 'ORIGINAL', label: 'Back to the original method' }, { value: 'CASH', label: 'Cash' },
            { value: 'BANK_TRANSFER', label: 'Bank transfer' }, { value: 'STORE_CREDIT', label: 'Store credit' },
            { value: 'EXCHANGE', label: 'Exchange — no money back' },
          ],
        }),
        ui.field({ label: 'Notes', name: 'notes', type: 'textarea', span: true }));
      wrapEl.appendChild(grid);
      const restock = ui.h('label', { class: 'check', style: { marginTop: '8px' } },
        ui.h('input', { type: 'checkbox', checked: true }), ui.h('span', {}, 'Put the goods back on the shelf'));
      wrapEl.appendChild(restock);

      const m = ui.openModal({
        title: `Return against ${sale.receipt_no}`,
        body: wrapEl,
        size: 'wide',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: async () => {
              if (!chosen.size) { ui.warn('Tick at least one line.'); return; }
              const v = ui.readFormStrings(wrapEl);
              try {
                const result = await SR.api.post('/api/returns', {
                  sale_id: sale.id,
                  reason_code: v.reason_code,
                  refund_method: v.refund_method,
                  restock: restock.querySelector('input').checked ? 1 : 0,
                  notes: v.notes || null,
                  lines: Array.from(chosen.entries()).map(([sale_item_id, quantity]) => ({ sale_item_id, quantity })),
                });
                ui.ok(result.message || 'Return recorded. The stock and the books have been updated.');
                m.close();
                SR.app.navigate('/returns');
              } catch (err) { ui.apiError(err); }
            },
          }, 'Record the return'),
        ],
      });
    }

    function repaintButton(sale, items, payments) {
      return ui.h('button', {
        class: 'btn btn-sm',
        onClick: () => SR.print.preview(SR.print.saleReceipt(Object.assign({}, sale, { items, payments }), {
          brand: (SR.state.settings || {}).business_name || 'StockRidge',
          footer: (SR.state.settings || {}).receipt_footer_text || '',
        }), { title: `Receipt ${sale.receipt_no}` }),
      }, 'Print');
    }

    function queuedCard(record) {
      const p = record.payload || {};
      const card = ui.h('div', { class: 'card' });
      card.appendChild(ui.h('div', { class: 'card-head' }, ui.h('h2', {}, 'This sale is queued on this device')));
      const body = ui.h('div', { class: 'card-body stack' });
      body.appendChild(ui.h('div', { class: 'alert alert-warn' },
        `It has not reached the office yet. It was recorded at ${U.soldAt(record.occurred_at)} and will be sent automatically. Local reference ${String(record.client_id).slice(-8)}.`));
      body.appendChild(ui.kv([
        ['Status', U.humanise(record.status)],
        ['Lines', String((p.lines || []).length)],
        ['Customer', p.customer_name || 'Walk-in'],
        ['Attempts', String(record.attempts || 0)],
        ['Last error', record.last_error || null],
      ]));
      body.appendChild(ui.h('div', { class: 'btn-row' },
        ui.h('button', { class: 'btn btn-primary', onClick: async () => { await SR.sync.runOnce(); load(); } }, 'Sync now'),
        ui.h('button', { class: 'btn', onClick: () => SR.app.navigate('/sync') }, 'Open the queue')));
      card.appendChild(body);
      return card;
    }

    return wrap;
  }

  SR.views = SR.views || {};
  SR.views.sales = { render };
}(window));
