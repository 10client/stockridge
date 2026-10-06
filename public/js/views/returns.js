'use strict';
// =====================================================================
// public/js/views/returns.js — WHEN IT COMES BACK
// =====================================================================
// Three different things arrive back at the counter, and conflating them is how
// a shop loses money quietly:
//
//   A RETURN   the customer wants their money or a swap. Stock may come back on
//              the shelf (a resellable item) or may not (a damaged one), and the
//              difference is a decision that has to be made deliberately.
//   A WARRANTY CLAIM  the item failed. The shop may fix it, swap it, refund it,
//              or send it to the supplier — and any of those costs MONEY, which
//              belongs in the accounts rather than in a WhatsApp message.
//   A SERIAL LOOKUP   "this unit came in on Tuesday, what did we sell and when
//              does the cover end?" The single query that ends most arguments.
//
// The return window matters: an item returned inside its window needs no
// approval; outside it, a manager decides, and the reason is recorded either
// way. Cash and transfer refunds always need a manager — a cashier cannot hand
// money back to themselves.
// =====================================================================
(function (global) {
  const SR = global.SR;
  const ui = SR.ui;
  const U = SR.util;

  const REASONS = ['DEFECTIVE', 'WRONG_ITEM', 'DAMAGED_IN_TRANSIT', 'CUSTOMER_CHANGE_OF_MIND', 'OVERCHARGE', 'RECALL', 'WARRANTY', 'OTHER'];
  const REFUND_METHODS = ['ORIGINAL', 'CASH', 'BANK_TRANSFER', 'STORE_CREDIT', 'EXCHANGE'];
  const RESOLUTIONS = ['REPAIRED', 'REPLACED', 'REFUNDED', 'SUPPLIER_RETURN', 'PAID_REPAIR', 'REJECTED'];

  async function render(ctx) {
    ctx.setTitle('Returns & warranty');
    const state = { tab: ctx.query.tab || 'returns', page: 0, pageSize: 50, status: '', q: '' };

    const wrap = ui.h('div', { class: 'stack' });
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Returns & warranty'),
        ui.h('p', { class: 'sub' }, `${SR.state.activeBranchName()} · refunds, swaps and warranty claims, with what each one cost`)),
      ui.h('div', { class: 'actions' },
        ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => startReturn() }, 'Start a return'),
        ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate('/deliveries') }, 'Deliveries'),
        ui.h('button', { class: 'btn btn-sm', onClick: () => exportList() }, 'Export'))));

    const tabs = ui.h('div', { class: 'tabs' });
    for (const [key, label] of [['returns', 'Returns'], ['claims', 'Warranty claims'], ['serials', 'Serial lookup'], ['board', 'Cost of after-sales']]) {
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
    const host = ui.h('div', {});
    wrap.appendChild(host);

    async function exportList() {
      try {
        await SR.exporter.list({
          filename: 'returns',
          path: '/api/returns',
          query: SR.state.query({ days: 90, status: state.status || undefined }),
          columns: [
            { key: 'return_no', label: 'Return' }, { key: 'receipt_no', label: 'Receipt' },
            { key: 'reason_code', label: 'Reason' }, { key: 'refund_amount', label: 'Refund' },
            { key: 'refund_method', label: 'Method' }, { key: 'restock', label: 'Restocked' },
            { key: 'status', label: 'Status' }, { key: 'processed_by_name', label: 'By' },
            { key: 'created_at', label: 'When' },
          ],
        });
      } catch (err) { ui.apiError(err); }
    }

    async function load() {
      host.replaceChildren(ui.skeleton(6));
      if (state.tab === 'claims') return renderClaims();
      if (state.tab === 'serials') return renderSerialLookup();
      if (state.tab === 'board') return renderBoard();
      return renderReturns();
    }

    // ---------------- RETURNS ----------------
    async function renderReturns() {
      let data; let offline = false;
      try {
        data = await SR.api.get('/api/returns', { query: SR.state.query({ days: 90, status: state.status || undefined, limit: state.pageSize, offset: state.page * state.pageSize }) });
      } catch (err) {
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: renderReturns } })); return; }
        offline = true;
        data = { data: [], summary: {}, byReason: [] };
      }
      const rows = data.data || [];
      const s = data.summary || {};
      const paging = data.paging || {};
      const canApprove = SR.state.atLeast('MANAGER');

      host.replaceChildren();
      if (offline) host.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'Offline — a return moves money and stock, so it is recorded on the server.'));
      host.appendChild(ui.h('div', { class: 'grid grid-4' },
        ui.kpi({ label: 'Returns in 90 days', value: String(s.count || rows.length), small: true }),
        ui.kpi({ label: 'Refunded', value: U.money(s.refunded), tone: 'warn', small: true }),
        ui.kpi({ label: 'Awaiting approval', value: String(s.pending || 0), tone: Number(s.pending) > 0 ? 'bad' : 'good', foot: Number(s.pending) > 0 ? 'a manager must decide these' : null, small: true }),
        ui.kpi({
          label: 'Most common reason',
          value: (data.byReason && data.byReason.length) ? U.humanise(data.byReason[0].reason_code) : '—',
          foot: (data.byReason && data.byReason.length) ? `${data.byReason[0].count} returns · ${U.money(data.byReason[0].refunded)}` : null,
          small: true,
        })));

      const filterRow = ui.h('div', { class: 'row' });
      const statusSel = ui.h('select', { onchange: (e) => { state.status = e.target.value; state.page = 0; renderReturns(); } });
      for (const [v, l] of [['', 'Any status'], ['PENDING_APPROVAL', 'Awaiting approval'], ['APPROVED', 'Approved'], ['REJECTED', 'Rejected']]) {
        statusSel.appendChild(ui.h('option', { value: v, selected: v === state.status }, l));
      }
      filterRow.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Status'), statusSel));

      host.appendChild(ui.dataCard({
        title: 'Returns',
        toolbar: filterRow,
        table: ui.renderTable({
          columns: [
            { key: 'return_no', label: 'Return', render: (r) => ui.h('span', { class: 'mono' }, r.return_no || String(r.id).slice(0, 8)) },
            { key: 'created_at', label: 'When', render: (r) => U.dateTime(r.created_at) },
            { key: 'receipt_no', label: 'Against receipt', render: (r) => (r.receipt_no ? ui.h('a', { href: `#/sales/${r.sale_id}`, onClick: (e) => { e.preventDefault(); SR.app.navigate(`/sales/${r.sale_id}`); } }, r.receipt_no) : '—') },
            { key: 'reason_code', label: 'Reason', render: (r) => ui.badge(r.reason_code, r.reason_code === 'DEFECTIVE' || r.reason_code === 'DAMAGED_IN_TRANSIT' ? 'badge-bad' : 'badge-info') },
            { key: 'item_count', label: 'Items', align: 'right' },
            { key: 'refund_amount', label: 'Refund', align: 'right', render: (r) => ui.h('strong', {}, U.money(r.refund_amount)) },
            { key: 'refund_method', label: 'By', render: (r) => U.humanise(r.refund_method || '') },
            { key: 'restock', label: 'Stock', render: (r) => (Number(r.restock) ? ui.badge('back on shelf', 'badge-good') : ui.badge('written off', 'badge-warn')) },
            { key: 'status', label: '', render: (r) => ui.statusBadge(r.status) },
            { key: 'x', label: '', render: (r) => {
              const cell = ui.h('div', { class: 'btn-row' });
              if (r.status === 'PENDING_APPROVAL' && canApprove) {
                cell.appendChild(ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => decide(r, true) }, 'Approve'));
                cell.appendChild(ui.h('button', { class: 'btn btn-sm', onClick: () => decide(r, false) }, 'Reject'));
              } else {
                cell.appendChild(ui.h('span', { class: 'hint' }, r.processed_by_name || ''));
              }
              return cell;
            } },
          ],
          rows,
          emptyTitle: 'No returns in this period',
          emptyMessage: 'When something comes back, record it here rather than adjusting stock by hand — a return reverses the sale, the cost of goods and the VAT together, which a manual adjustment cannot.',
          emptyAction: { label: 'Start a return', run: () => startReturn() },
        }),
        pager: ui.pager({
          page: state.page, pageSize: paging.limit || state.pageSize, total: paging.total != null ? paging.total : rows.length,
          onPage: (p) => { state.page = p; renderReturns(); },
          onSize: (n) => { state.pageSize = n; state.page = 0; renderReturns(); },
        }),
      }));
    }

    async function renderClaims() {
      let data; let offline = false;
      try {
        data = await SR.api.get('/api/warranty-claims', { query: SR.state.query({ status: state.status || undefined, q: state.q || undefined, limit: state.pageSize }) });
      } catch (err) {
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: renderClaims } })); return; }
        offline = true;
        data = { data: [] };
      }
      const rows = data.data || [];
      host.replaceChildren();
      if (offline) host.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'Offline — warranty claims live on the server.'));

      const toolbar = ui.h('div', { class: 'row' });
      const qInput = ui.h('input', { type: 'search', placeholder: 'Claim, serial, product or customer…', style: { minWidth: '220px' } });
      qInput.value = state.q;
      qInput.addEventListener('input', U.debounce(() => { state.q = qInput.value; renderClaims(); }, 350));
      toolbar.appendChild(qInput);
      const statusSel = ui.h('select', { onchange: (e) => { state.status = e.target.value; renderClaims(); } });
      for (const [v, l] of [['', 'Open claims'], ['OPEN', 'Open'], ['IN_PROGRESS', 'In progress'], ['RESOLVED', 'Resolved'], ['CLOSED', 'Closed'], ['REJECTED', 'Rejected']]) {
        statusSel.appendChild(ui.h('option', { value: v, selected: v === state.status }, l));
      }
      toolbar.appendChild(statusSel);
      toolbar.appendChild(ui.h('button', { class: 'btn btn-primary btn-sm', onClick: () => openClaim() }, 'Open a claim'));

      host.appendChild(ui.dataCard({
        title: 'Warranty claims',
        toolbar,
        table: ui.renderTable({
          columns: [
            { key: 'claim_no', label: 'Claim', render: (c) => ui.h('span', { class: 'mono' }, c.claim_no || String(c.id).slice(0, 8)) },
            { key: 'opened_at', label: 'Opened', render: (c) => U.dateTime(c.opened_at) },
            { key: 'product_name', label: 'Product', className: 'wrap', render: (c) => ui.h('div', {},
              ui.h('div', { style: { fontWeight: '600' } }, c.product_name || '—'),
              ui.h('div', { class: 'hint' }, [c.sku, c.serial_no ? `serial ${c.serial_no}` : null].filter(Boolean).join(' · '))) },
            { key: 'customer_name', label: 'Customer', render: (c) => ui.h('div', {}, ui.h('div', {}, c.customer_name || 'Walk-in'), ui.h('div', { class: 'hint' }, c.customer_phone || '')) },
            { key: 'in_warranty', label: 'Cover', render: (c) => (Number(c.in_warranty) ? ui.badge('in warranty', 'badge-good') : ui.badge('out of warranty', 'badge-warn')) },
            { key: 'fault_reported', label: 'Fault', className: 'wrap' },
            { key: 'net_cost', label: 'Cost to us', align: 'right', render: (c) => {
              const net = U.round2(Number(c.cost_to_business || 0) - Number(c.supplier_recovery_amount || 0));
              return net === 0 && !c.resolution ? '—' : U.money(net);
            } },
            { key: 'status', label: '', render: (c) => ui.statusBadge(c.status) },
            { key: 'x', label: '', render: (c) => (['CLOSED', 'RESOLVED', 'REJECTED'].includes(String(c.status)) ? ui.h('span', { class: 'hint' }, c.resolution ? U.humanise(c.resolution) : '') : ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => resolveClaim(c) }, 'Resolve')) },
          ],
          rows,
          emptyTitle: 'No open warranty claims',
          emptyMessage: 'A claim is how a failed appliance stops being a loss and becomes a supplier conversation. Opening one records the serial, the fault and the cover, so the answer does not depend on anybody\'s memory.',
          emptyAction: { label: 'Open a claim', run: () => openClaim() },
        }),
      }));
    }

    async function renderSerialLookup() {
      host.replaceChildren();
      const wrapEl = ui.h('div', { class: 'card' });
      wrapEl.appendChild(ui.h('div', { class: 'card-head' }, ui.h('h2', {}, 'Serial number lookup')));
      const body = ui.h('div', { class: 'card-body stack' });
      const row = ui.h('div', { class: 'row' });
      const input = ui.h('input', { placeholder: 'Scan or type a serial number…', class: 'grow' });
      const go = ui.h('button', { class: 'btn btn-primary', onClick: () => lookup(input.value.trim()) }, 'Look it up');
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') lookup(input.value.trim()); });
      row.appendChild(ui.h('div', { class: 'grow' }, input));
      row.appendChild(go);
      body.appendChild(row);
      body.appendChild(ui.h('p', { class: 'hint' }, 'This answers the two questions the counter actually gets: when was this sold, and is it still covered? It searches the serial numbers recorded against sales, batches and warranty claims.'));
      const result = ui.h('div', { class: 'stack' });
      body.appendChild(result);
      wrapEl.appendChild(body);
      host.appendChild(wrapEl);

      async function lookup(value) {
        if (!value) { ui.warn('Type or scan a serial number.'); return; }
        result.replaceChildren(ui.loading('Looking it up…'));
        let data; let offline = false;
        try {
          data = await SR.api.get(`/api/serials/${encodeURIComponent(value)}`);
        } catch (err) {
          if (!err.isOffline) { result.replaceChildren(ui.h('div', { class: 'alert alert-warn' }, err.code === 'SERIAL_NOT_FOUND' || err.status === 404 ? `No unit with serial ${value} has been recorded at this business.` : err.message)); return; }
          offline = true;
          const all = await SR.store.all('serial_numbers').catch(() => []);
          const hit = all.find((s) => String(s.serial_no).toLowerCase() === value.toLowerCase());
          if (!hit) { result.replaceChildren(ui.h('div', { class: 'alert alert-warn' }, 'Offline and this serial is not in the device cache.')); return; }
          data = { serial: hit };
        }
        const serial = data.serial || data;
        const history = data.history || data.movements || [];
        const claims = data.claims || [];
        const sale = data.sale || serial.sale || null;
        result.replaceChildren();
        if (offline) result.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'Offline — from this device\'s cache.'));

        const warrantyEnd = serial.warranty_ends_at || (serial.warranty_ends_at === null ? null : null);
        const covered = warrantyEnd ? String(warrantyEnd).slice(0, 10) >= U.todayWat() : false;
        result.appendChild(ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' }, ui.kv([
          ['Serial', serial.serial_no],
          ['Product', data.product_name || serial.product_name],
          ['Status', ui.statusBadge(serial.status)],
          ['Sold on', sale ? U.dateTime(sale.sold_at) : (serial.sold_at ? U.dateTime(serial.sold_at) : 'not sold yet')],
          ['Receipt', sale ? sale.receipt_no : null],
          ['Customer', serial.customer_name || (sale ? sale.customer_name : null)],
          ['Warranty starts', serial.warranty_starts_at ? U.date(serial.warranty_starts_at) : null],
          ['Warranty ends', warrantyEnd ? U.date(warrantyEnd) : null],
          ['Cover today', warrantyEnd ? (covered ? 'YES — still under warranty' : 'no — cover has expired') : 'no warranty recorded'],
          ['Notes', serial.notes],
        ]))));

        if (history.length) {
          result.appendChild(ui.dataCard({
            title: 'Where this unit has been',
            table: ui.renderTable({
              columns: [
                { key: 'created_at', label: 'When', render: (h) => U.dateTime(h.created_at || h.at) },
                { key: 'type', label: 'Event', render: (h) => U.humanise(h.type || h.event || '') },
                { key: 'detail', label: 'Detail', className: 'wrap', render: (h) => h.detail || h.notes || '' },
                { key: 'actor', label: 'By', render: (h) => h.actor_name || h.created_by_name || '' },
              ],
              rows: history,
            }),
          }));
        }
        if (claims.length) {
          result.appendChild(ui.dataCard({
            title: 'Claims on this unit',
            table: ui.renderTable({
              columns: [
                { key: 'claim_no', label: 'Claim' },
                { key: 'opened_at', label: 'Opened', render: (c) => U.dateTime(c.opened_at) },
                { key: 'fault_reported', label: 'Fault', className: 'wrap' },
                { key: 'status', label: '', render: (c) => ui.statusBadge(c.status) },
                { key: 'resolution', label: 'Outcome', render: (c) => (c.resolution ? U.humanise(c.resolution) : '—') },
              ],
              rows: claims,
            }),
          }));
        }
      }
    }

    async function renderBoard() {
      host.replaceChildren();
      let claims = []; let returns = [];
      try {
        const [c, r] = await Promise.all([
          SR.api.get('/api/warranty-claims', { query: SR.state.query({ status: 'ALL', limit: 250 }) }),
          SR.api.get('/api/returns', { query: SR.state.query({ days: 365, limit: 250 }) }),
        ]);
        claims = (c.data || []).filter((x) => x.resolution);
        returns = r.data || [];
      } catch (err) {
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: renderBoard } })); return; }
      }
      const items = claims.map((c) => ({
        kind: 'Warranty',
        label: `${c.claim_no || ''} ${c.product_name || ''}`.trim(),
        when: c.resolved_at || c.opened_at,
        cost: U.round2(Number(c.cost_to_business || 0) - Number(c.supplier_recovery_amount || 0)),
        resolution: c.resolution,
        supplier: c.supplier_name,
      })).concat(returns.map((r) => ({
        kind: 'Return',
        label: `${r.return_no || ''} ${U.humanise(r.reason_code || '')}`.trim(),
        when: r.created_at,
        cost: Number(r.restock) ? 0 : Number(r.refund_amount || 0),
        resolution: r.refund_method,
        supplier: null,
      })));
      const totalCost = U.sum(items, (i) => i.cost);
      host.appendChild(ui.h('div', { class: 'grid grid-4' },
        ui.kpi({ label: 'After-sales cost, 12 months', value: U.money(totalCost), tone: totalCost > 0 ? 'warn' : 'good', foot: 'money that left the business after the sale', small: true }),
        ui.kpi({ label: 'Warranty claims settled', value: String(claims.length), small: true }),
        ui.kpi({ label: 'Returns taken', value: String(returns.length), foot: U.money(U.sum(returns, (r) => r.refund_amount)), small: true }),
        ui.kpi({
          label: 'Recovered from suppliers',
          value: U.money(U.sum(claims, (c) => c.supplier_recovery_amount)),
          tone: 'good',
          foot: 'credit notes chased and received',
          small: true,
        })));
      const byResolution = Array.from(U.groupBy(claims, (c) => c.resolution).entries())
        .map(([label, list]) => ({ label: U.humanise(label), value: U.sum(list, (x) => U.round2(Number(x.cost_to_business || 0) - Number(x.supplier_recovery_amount || 0))), count: list.length }))
        .sort((a, b) => b.value - a.value);
      const byReason = Array.from(U.groupBy(returns, (r) => r.reason_code).entries())
        .map(([label, list]) => ({ label: U.humanise(label), value: list.length }))
        .sort((a, b) => b.value - a.value);
      host.appendChild(ui.h('div', { class: 'grid grid-2' },
        ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' },
          ui.h('h2', { style: { marginTop: 0 } }, 'What settling a claim cost'),
          byResolution.length ? ui.bars(byResolution, { format: U.money, tone: 'b3' }) : ui.h('div', { class: 'hint' }, 'No settled claims yet.'))),
        ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' },
          ui.h('h2', { style: { marginTop: 0 } }, 'Why things come back'),
          byReason.length ? ui.bars(byReason, { format: (v) => `${v}`, tone: 'b2' }) : ui.h('div', { class: 'hint' }, 'No returns recorded yet.')))));

      if (items.length) {
        host.appendChild(ui.dataCard({
          title: 'Every after-sales event',
          table: ui.renderTable({
            columns: [
              { key: 'when', label: 'When', render: (i) => U.date(i.when) },
              { key: 'kind', label: 'Kind', render: (i) => ui.badge(i.kind, i.kind === 'Warranty' ? 'badge-violet' : 'badge-info') },
              { key: 'label', label: 'What', className: 'wrap' },
              { key: 'resolution', label: 'Outcome', render: (i) => (i.resolution ? U.humanise(i.resolution) : '—') },
              { key: 'supplier', label: 'Supplier', render: (i) => i.supplier || '—' },
              { key: 'cost', label: 'Net cost', align: 'right', render: (i) => (i.cost ? ui.h('span', { style: { color: 'var(--red-700)' } }, U.money(i.cost)) : ui.h('span', { class: 'hint' }, 'nil')) },
            ],
            rows: items.sort((a, b) => String(b.when).localeCompare(String(a.when))).slice(0, 120),
            foot: ['', '', '', '', 'TOTAL', U.money(totalCost)],
          }),
        }));
      }
    }

    // ---------------- RETURN CREATION ----------------
    async function startReturn() {
      const receipt = await ui.promptDialog({
        title: 'Which sale is coming back?',
        label: 'Receipt number',
        hint: 'Type the receipt number printed on the customer\'s slip, or scan it. The items come back from that sale, so the refund reverses the right VAT and cost of goods.',
        required: true,
      });
      if (!receipt) return;
      let sale;
      try {
        const data = await SR.api.get(`/api/sales/by-receipt/${encodeURIComponent(String(receipt).trim())}`);
        sale = data.sale || data;
      } catch (err) {
        if (err.status === 404) ui.warn(`No sale with receipt ${receipt} was found at this business.`);
        else ui.apiError(err);
        return;
      }
      const items = sale.items || [];
      if (!items.length) { ui.warn('That sale has no items recorded — it may have been fully returned already.'); return; }
      openReturnForm(sale, items);
    }

    function openReturnForm(sale, items) {
      const picked = new Map();
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('div', { class: 'alert alert-info' },
        `${sale.receipt_no} · ${U.soldAt(sale.sold_at)} · total ${U.money(sale.total)}${sale.customer_name ? ` · ${sale.customer_name}` : ''}`));

      const listCard = ui.h('div', { class: 'card' });
      listCard.appendChild(ui.h('div', { class: 'card-head' }, ui.h('h2', {}, 'What is coming back')));
      const listBody = ui.h('div', { class: 'card-body tight' });
      for (const item of items) {
        const returned = Number(item.quantity_returned || 0);
        const remaining = U.round2(Number(item.quantity) - returned);
        const row = ui.h('div', { class: 'row', style: { padding: '8px 4px', borderBottom: '1px solid var(--slate-200)' } });
        row.appendChild(ui.h('div', { class: 'grow' },
          ui.h('div', { style: { fontWeight: '600' } }, item.product_name || item.name),
          ui.h('div', { class: 'hint' }, [
            `sold ${U.qty(item.quantity)}${returned ? `, ${U.qty(returned)} already returned` : ''}`,
            item.serial_no ? `serial ${item.serial_no}` : null,
            `@ ${U.money(item.unit_price)}`,
          ].filter(Boolean).join(' · '))));
        const qtyInput = ui.h('input', { type: 'number', step: 'any', min: '0', max: String(remaining), value: '0', style: { width: '90px' } });
        qtyInput.addEventListener('input', () => {
          const v = Number(qtyInput.value) || 0;
          if (v > 0) picked.set(String(item.id), { item, quantity: v, sale_item_id: String(item.id) });
          else picked.delete(String(item.id));
          paintTotals();
        });
        row.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, `Coming back (of ${U.qty(remaining)})`), qtyInput));
        if (returned) row.appendChild(ui.h('div', { class: 'hint', style: { alignSelf: 'center' } }, `${U.qty(returned)} already returned — the server refuses the rest if you go past it`));
        listBody.appendChild(row);
      }
      listCard.appendChild(listBody);
      wrapEl.appendChild(listCard);

      const form = ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Why', name: 'reason_code', value: 'DEFECTIVE', options: REASONS.map((r) => ({ value: r, label: U.humanise(r) })), required: true }),
        ui.field({ label: 'Refund by', name: 'refund_method', value: 'ORIGINAL', options: REFUND_METHODS.map((r) => ({ value: r, label: U.humanise(r) })), hint: 'ORIGINAL sends the money back the way it came. Cash and transfer refunds need a manager.' }),
        ui.field({ label: 'Put the goods back on the shelf?', name: 'restock', value: '1', options: [{ value: '1', label: 'Yes — resellable' }, { value: '', label: 'No — damaged, write it off' }], hint: 'A damaged item put back on the shelf is a loss waiting for a customer to discover it.' }),
        ui.field({ label: 'Notes', name: 'notes', type: 'textarea', span: true, hint: 'Required if the return is outside its window, so the decision is on the record.' }));
      wrapEl.appendChild(form);
      const totals = ui.h('div', { class: 'alert alert-info' }, 'Pick the quantities coming back.');
      wrapEl.appendChild(totals);

      function paintTotals() {
        const refund = U.sum([...picked.values()], (p) => Number(p.item.unit_price) * p.quantity);
        // `sale_items.vat_amount` is the whole line's VAT, so it is apportioned
      // across the units actually coming back rather than copied wholesale.
      const tax = U.sum([...picked.values()], (p) => (Number(p.item.vat_amount || 0) / Math.max(1, Number(p.item.quantity))) * p.quantity);
        totals.replaceChildren();
        totals.appendChild(ui.kv([
          ['Items', `${picked.size} line${picked.size === 1 ? '' : 's'}`],
          ['Refund value', ui.h('strong', {}, U.money(refund))],
          ['VAT being reversed', tax ? U.money(tax) : '—'],
        ]));
      }
      paintTotals();

      const m = ui.openModal({
        title: 'Record a return',
        body: wrapEl,
        size: 'full',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: async (ev) => {
              const v = ui.readFormStrings(wrapEl);
              const lines = [...picked.values()].map((p) => ({ sale_item_id: p.sale_item_id, quantity: p.quantity }));
              if (!lines.length) { ui.warn('Enter at least one quantity that is coming back.'); return; }
              ev.currentTarget.disabled = true;
              ev.currentTarget.textContent = 'Recording…';
              try {
                const result = await SR.api.post('/api/returns', {
                  sale_id: String(sale.id),
                  reason_code: v.reason_code,
                  refund_method: v.refund_method,
                  restock: v.restock === '1',
                  items: lines,
                  notes: v.notes || null,
                }, { queue: 'auto' });
                if (result && result.queued) ui.info('Offline — the return is queued and will be recorded when the connection returns.');
                else if (result && result.status === 'PENDING_APPROVAL') ui.warn(result.message || 'Recorded and queued for a manager\'s approval.');
                else ui.ok(result.message || 'Return processed.');
                if (result && Array.isArray(result.advisories)) for (const a of result.advisories) if (a) ui.warn(a);
                m.close();
                load();
              } catch (err) {
                ui.apiError(err);
                ev.currentTarget.disabled = false;
                ev.currentTarget.textContent = 'Record the return';
              }
            },
          }, 'Record the return'),
        ],
      });
    }

    function decide(ret, approved) {
      const go = async (note) => {
        try {
          await SR.api.post(`/api/returns/${encodeURIComponent(ret.id)}/approve`, { approved, note });
          ui.ok(approved ? 'Return approved — the refund is recorded and the ledger reversed.' : 'Return rejected.');
          load();
        } catch (err) { ui.apiError(err); }
      };
      if (approved) {
        ui.confirmDialog({
          title: `Approve a ${U.money(ret.refund_amount)} refund?`,
          message: `${U.humanise(ret.reason_code || '')} on receipt ${ret.receipt_no || '—'}, refunded by ${U.humanise(ret.refund_method || '').toLowerCase()}${Number(ret.restock) ? ', goods back on the shelf' : ', goods written off'}. Approving records the refund and reverses the sale\'s revenue, tax and cost of goods.`,
          confirmLabel: 'Approve the refund',
        }).then((yes) => { if (yes) go(null); });
      } else {
        ui.promptDialog({ title: 'Why is this rejected?', label: 'Reason', required: true }).then((note) => { if (note) go(note); });
      }
    }

    // ---------------- WARRANTY CLAIMS ----------------
    function openClaim(presetSerial) {
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Serial number', name: 'serial_no', value: presetSerial || '', placeholder: 'Scan the unit, or type it', hint: 'If the unit is on record, the product, the sale and the remaining cover are filled in automatically — and the claim is far harder to dispute.' }),
        ui.field({ label: 'Customer', name: 'customer_phone', placeholder: 'Phone, to find the customer' }),
        ui.field({ label: 'What is wrong?', name: 'fault_reported', type: 'textarea', span: true, required: true, placeholder: 'e.g. unit runs for ten minutes then trips the breaker; noisy compressor' }),
        ui.field({ label: 'Supplier to claim from', name: 'supplier_id', placeholder: 'Optional — search suppliers' }),
        ui.field({ label: 'Notes', name: 'notes', type: 'textarea', span: true })));
      const m = ui.openModal({
        title: 'Open a warranty claim',
        body: wrapEl,
        size: 'wide',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: async (ev) => {
              const v = ui.readFormStrings(wrapEl);
              // THE SAME RULE THE SERVER ENFORCES: what the unit does, and when it started.
              // This used to accept four characters, so the screen let through the one example
              // its own message named as unusable and the server then refused it.
              const faultText = String(v.fault_reported || '').trim();
              const faultWords = faultText.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
              if (faultText.length < 12 || faultWords < 3) { ui.warn('Describe the fault in the customer’s own words — what it does, and when it started. “Not working” cannot be sent to a supplier.'); return; }
              if (!v.serial_no && !v.customer_phone) { ui.warn('Give a serial number or a customer phone — the claim needs to point at a specific unit.'); return; }
              ev.currentTarget.disabled = true;
              try {
                const result = await SR.api.post('/api/warranty-claims', {
                  serial_no: v.serial_no || null,
                  customer_id: v.customer_id || null,
                  supplier_id: v.supplier_id || null,
                  fault_reported: v.fault_reported,
                  notes: v.notes || null,
                }, { queue: 'auto' });
                if (result && result.queued) ui.info('Offline — the claim is queued.');
                else ui.ok(`${result.claim_no || 'Claim'} opened${result.in_warranty ? ' — the unit is still under warranty' : ' — note the unit is OUT of warranty'}.`);
                m.close();
                load();
              } catch (err) {
                ui.apiError(err);
                ev.currentTarget.disabled = false;
              }
            },
          }, 'Open the claim'),
        ],
      });
    }

    function resolveClaim(claim) {
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('div', { class: 'alert alert-info' },
        `${claim.claim_no || ''} · ${claim.product_name || ''}${claim.serial_no ? ` · serial ${claim.serial_no}` : ''} · ${Number(claim.in_warranty) ? 'in warranty' : 'OUT of warranty'}`));
      wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Outcome', name: 'resolution', value: 'REPAIRED', options: RESOLUTIONS.map((r) => ({ value: r, label: U.humanise(r) })), required: true }),
        ui.field({ label: 'Fault found', name: 'fault_found', placeholder: 'What the technician actually found' }),
        ui.field({ label: 'What it cost the business (₦)', name: 'cost_to_business', type: 'number', step: '0.01', min: '0', value: '0', hint: 'Parts, labour, transport. This is the number that tells you whether a product line is worth stocking.' }),
        ui.field({ label: 'Recovered from supplier (₦)', name: 'supplier_recovery_amount', type: 'number', step: '0.01', min: '0', value: '0', hint: 'Supplier credit notes rarely arrive unasked — recording it here gives you something to chase.' }),
        ui.field({ label: 'Supplier claim reference', name: 'supplier_claim_ref' }),
        ui.field({ label: 'Replacement serial', name: 'replacement_serial_id', hint: 'If the unit was swapped, the replacement inherits the remaining cover rather than starting a new one.' }),
        ui.field({ label: 'Notes', name: 'resolution_notes', type: 'textarea', span: true })));
      const m = ui.openModal({
        title: 'Resolve the claim',
        body: wrapEl,
        size: 'wide',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: async (ev) => {
              const v = ui.readFormStrings(wrapEl);
              ev.currentTarget.disabled = true;
              try {
                const result = await SR.api.post(`/api/warranty-claims/${encodeURIComponent(claim.id)}/resolve`, {
                  resolution: v.resolution,
                  fault_found: v.fault_found || null,
                  resolution_notes: v.resolution_notes || null,
                  cost_to_business: Number(v.cost_to_business) || 0,
                  supplier_recovery_amount: Number(v.supplier_recovery_amount) || 0,
                  supplier_claim_ref: v.supplier_claim_ref || null,
                  replacement_serial_id: v.replacement_serial_id || null,
                });
                ui.ok(result.message || 'Claim closed.');
                for (const a of (result.advisories || [])) if (a) ui.warn(a);
                m.close();
                load();
              } catch (err) {
                ui.apiError(err);
                ev.currentTarget.disabled = false;
              }
            },
          }, 'Close the claim'),
        ],
      });
    }

    await load();
    return wrap;
  }

  SR.views = SR.views || {};
  SR.views.returns = { render, REASONS, RESOLUTIONS };
}(window));
