'use strict';
// =====================================================================
// public/js/views/stock.js — WHAT IS ON THE SHELF, AND FOUR WAYS IT MOVES
// =====================================================================
// Stock moves in exactly four ways in StockRidge, and this screen only ever
// offers those four:
//
//   RECEIVE   goods in from a supplier, at a cost, into a batch
//   SELL      through the POS — never from here
//   ADJUST    damage, theft, expiry, count variance, samples, write-offs
//   TRANSFER  to another branch
//
// There is no fifth "edit the quantity" path, on purpose. Every change is a
// document with a reason, an author and a ledger entry, because a stock figure
// that can be typed over is a stock figure nobody can audit.
//
// The tab that earns its keep is EXPIRING. A building-materials shop barely
// needs it; a wholesale food or paint business cannot run without it, and by the
// time the goods are visibly spoiling it is already too late to sell them.
// =====================================================================
(function (global) {
  const SR = global.SR;
  const ui = SR.ui;
  const U = SR.util;

  const ADJUSTMENT_TYPES = ['DAMAGE', 'THEFT', 'EXPIRED', 'COUNT_VARIANCE', 'SAMPLE', 'SHRINKAGE', 'FOUND', 'RETURN_TO_SUPPLIER', 'WRITE_OFF', 'OTHER'];
  const ADDITIVE = new Set(['FOUND']);

  async function render(ctx) {
    ctx.setTitle('Stock');
    const state = {
      tab: ctx.query.tab || 'on-hand',
      filter: ctx.query.filter || '',
      q: '',
      page: 0,
      pageSize: 50,
    };

    const wrap = ui.h('div', { class: 'stack' });
    const head = ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Stock'),
        ui.h('p', { class: 'sub' }, `${SR.state.activeBranchName()} · cost, batches and every movement`)),
      ui.h('div', { class: 'actions' },
        SR.state.atLeast('STAFF') ? ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => openReceive() }, 'Receive stock') : null,
        ui.h('button', { class: 'btn btn-sm', onClick: () => openAdjust() }, 'Adjust'),
        ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate('/transfers') }, 'Transfer'),
        ui.h('button', { class: 'btn btn-sm', onClick: () => UI_export() }, 'Export')));
    wrap.appendChild(head);

    const tabs = ui.h('div', { class: 'tabs' });
    const TABS = [
      { key: 'on-hand', label: 'On hand' },
      { key: 'valuation', label: 'Valuation' },
      { key: 'expiring', label: 'Expiring' },
      { key: 'adjusted', label: 'Adjustments', roles: ['MANAGER', 'OWNER'] },
    ];
    for (const tab of TABS) {
      if (tab.roles && !tab.roles.some((r) => SR.state.atLeast(r))) continue;
      tabs.appendChild(ui.h('button', {
        class: `tab ${state.tab === tab.key ? 'is-active' : ''}`,
        onClick: () => { state.tab = tab.key; state.page = 0; for (const b of tabs.children) b.classList.toggle('is-active', b.textContent === tab.label); load(); },
      }, tab.label));
    }
    wrap.appendChild(tabs);

    const filtersHost = ui.h('div', {});
    wrap.appendChild(filtersHost);
    const host = ui.h('div', {});
    wrap.appendChild(host);

    function UI_export() {
      SR.exporter.list({
        filename: 'stock',
        path: '/api/stock',
        query: SR.state.query({ q: state.q || undefined, filter: state.filter || undefined }),
        mirrorTable: 'stock_batches',
        columns: [
          { key: 'name', label: 'Product' }, { key: 'sku', label: 'SKU' },
          { key: 'on_shelf', label: 'On shelf' }, { key: 'reserved', label: 'Reserved' },
          { key: 'available', label: 'Available' }, { key: 'book_cost', label: 'Cost' },
          { key: 'stock_value', label: 'Value' }, { key: 'reorder_level', label: 'Reorder at' },
        ],
      }).catch((err) => ui.apiError(err));
    }

    async function load() {
      filtersHost.replaceChildren();
      host.replaceChildren(ui.skeleton(6));
      if (state.tab === 'valuation') return renderValuation();
      if (state.tab === 'expiring') return renderExpiring();
      if (state.tab === 'adjusted') return renderAdjustments();
      return renderOnHand();
    }

    async function renderOnHand() {
      const toolbar = ui.h('div', { class: 'row' });
      const qInput = ui.h('input', { type: 'search', placeholder: 'Product or SKU…', style: { minWidth: '190px' } });
      qInput.value = state.q;
      qInput.addEventListener('input', U.debounce(() => { state.q = qInput.value; state.page = 0; renderOnHand(); }, 320));
      toolbar.appendChild(qInput);
      const filterSel = ui.h('select', { onchange: (e) => { state.filter = e.target.value; state.page = 0; renderOnHand(); } });
      for (const [v, l] of [['', 'Everything'], ['low', 'At or below reorder level'], ['out', 'Out of stock'], ['overstock', 'Overstocked'], ['quarantined', 'Quarantined']]) {
        filterSel.appendChild(ui.h('option', { value: v, selected: v === state.filter }, l));
      }
      toolbar.appendChild(filterSel);
      filtersHost.replaceChildren(ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body row' }, toolbar)));

      let data = null; let offline = false;
      try {
        data = await SR.api.get('/api/stock', { query: SR.state.query({ q: state.q || undefined, filter: state.filter || undefined, limit: state.pageSize, offset: state.page * state.pageSize }) });
      } catch (err) {
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: renderOnHand } })); return; }
        offline = true;
        data = await fromMirror();
      }
      const rows = data.data || [];
      const paging = data.paging || {};

      const table = ui.renderTable({
        columns: [
          { key: 'name', label: 'Product', className: 'wrap', render: (r) => {
            const cell = ui.h('div', {});
            cell.appendChild(ui.h('div', { style: { fontWeight: '600' } }, r.name));
            cell.appendChild(ui.h('div', { class: 'hint' }, [r.sku, r.category_name, r.base_unit_name].filter(Boolean).join(' · ')));
            return cell;
          } },
          { key: 'on_shelf', label: 'On shelf', align: 'right', render: (r) => U.qty(r.on_shelf) },
          { key: 'reserved', label: 'Reserved', align: 'right', render: (r) => (Number(r.reserved) ? U.qty(r.reserved) : '—') },
          { key: 'available', label: 'Available', align: 'right', render: (r) => {
            const v = Number(r.available);
            return ui.h('strong', { style: v <= 0 ? { color: 'var(--red-700)' } : (r.low_stock ? { color: 'var(--amber-700)' } : {}) }, U.qty(v));
          } },
          { key: 'batch_count', label: 'Batches', align: 'right' },
          { key: 'book_cost', label: 'Cost', align: 'right', render: (r) => U.money(r.book_cost) },
          { key: 'selling_price', label: 'Price', align: 'right', render: (r) => U.money(r.selling_price) },
          { key: 'stock_value', label: 'Value', align: 'right', render: (r) => U.money(r.stock_value) },
          { key: 'next_expiry', label: 'Next expiry', render: (r) => (r.next_expiry ? (Number(r.days_to_expiry) <= 30 ? ui.badge(`${r.days_to_expiry}d`, 'badge-bad') : U.date(r.next_expiry)) : '—') },
          { key: 'x', label: '', render: (r) => ui.h('div', { class: 'btn-row' },
            ui.h('button', { class: 'btn btn-sm', onClick: (ev) => { ev.stopPropagation(); openBatches(r); } }, 'Batches'),
            ui.h('button', { class: 'btn btn-sm', onClick: (ev) => { ev.stopPropagation(); openAdjust(r); } }, 'Adjust'),
            SR.state.atLeast('MANAGER') ? ui.h('button', { class: 'btn btn-sm', onClick: (ev) => { ev.stopPropagation(); SR.app.navigate(`/products/${r.product_id}`); } }, 'Open') : null) },
        ],
        rows,
        emptyTitle: state.filter ? 'Nothing matches that filter' : 'No stock at this branch yet',
        emptyMessage: state.filter
          ? 'Try clearing the filter. Low-stock alerts only apply to products that have a reorder level set.'
          : 'Stock appears here once it has been received. Receiving is how goods enter the system — there is no way to type a quantity in.',
        emptyAction: { label: 'Receive stock', run: () => openReceive() },
      });

      host.replaceChildren();
      if (offline) host.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'Offline — these figures are from this device\'s last sync. Receiving and adjusting will be queued.'));
      const total = paging.total != null ? paging.total : rows.length;
      host.appendChild(ui.dataCard({
        title: 'On hand',
        table,
        pager: ui.pager({
          page: state.page, pageSize: paging.limit || state.pageSize, total,
          onPage: (p) => { state.page = p; renderOnHand(); },
          onSize: (n) => { state.pageSize = n; state.page = 0; renderOnHand(); },
        }),
      }));
    }

    async function fromMirror() {
      const branchId = SR.state.activeBranchId;
      const batches = await SR.store.all('stock_batches', { where: (b) => !Number(b.is_deleted) && String(b.branch_id) === String(branchId) });
      const products = await SR.store.all('products', { where: (p) => !Number(p.is_deleted) });
      const cats = await SR.store.all('product_categories').catch(() => []);
      const catName = new Map(cats.map((c) => [String(c.id), c.name]));
      const needle = state.q.toLowerCase();
      const byProduct = new Map();
      for (const b of batches) {
        if (state.filter !== 'quarantined' && ['QUARANTINED', 'EXPIRED'].includes(String(b.status))) continue;
        if (state.filter === 'quarantined' && String(b.status) !== 'QUARANTINED') continue;
        const key = String(b.product_id);
        const cur = byProduct.get(key) || { on_shelf: 0, reserved: 0, value: 0, batches: 0, next_expiry: null };
        cur.on_shelf += Number(b.quantity || 0);
        cur.reserved += Number(b.quantity_reserved || 0);
        cur.value += Number(b.quantity || 0) * Number(b.cost_price_per_unit || 0);
        cur.batches += 1;
        if (b.expiry_date && (!cur.next_expiry || b.expiry_date < cur.next_expiry)) cur.next_expiry = b.expiry_date;
        byProduct.set(key, cur);
      }
      const rows = products
        .filter((p) => byProduct.has(String(p.id)))
        .filter((p) => !needle || `${p.name} ${p.sku || ''}`.toLowerCase().includes(needle))
        .map((p) => {
          const s = byProduct.get(String(p.id));
          const available = s.on_shelf - s.reserved;
          return {
            product_id: p.id, branch_id: branchId, name: p.name, sku: p.sku,
            category_name: catName.get(String(p.category_id)) || null,
            base_unit_name: p.base_unit_name, reorder_level: p.reorder_level,
            book_cost: p.cost_price, selling_price: p.selling_price,
            on_shelf: s.on_shelf, reserved: s.reserved, available,
            stock_value: U.round2(s.value), batch_count: s.batches, next_expiry: s.next_expiry,
            low_stock: Number(p.reorder_level) > 0 && available <= Number(p.reorder_level),
            out_of_stock: available <= 0,
            days_to_expiry: s.next_expiry ? U.daysBetween(U.todayWat(), s.next_expiry) : null,
          };
        })
        .filter((r) => {
          if (state.filter === 'low') return r.low_stock;
          if (state.filter === 'out') return r.out_of_stock;
          return true;
        })
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return { data: rows, paging: { total: rows.length, limit: rows.length, offset: 0 } };
    }

    async function renderValuation() {
      let data; let offline = false;
      try {
        data = await SR.api.get('/api/stock/valuation', { query: SR.state.query() });
      } catch (err) {
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: renderValuation } })); return; }
        offline = true;
        data = { totals: { atCost: 0, atRetail: 0, potentialMargin: 0, units: 0, products: 0 }, byCategory: [], branches: [] };
        const stock = await fromMirror();
        data.totals.atCost = U.sum(stock.data, (r) => r.stock_value);
        data.totals.atRetail = U.sum(stock.data, (r) => Number(r.selling_price) * Number(r.available));
        data.totals.products = stock.data.length;
        data.totals.units = U.sum(stock.data, (r) => r.available);
        data.byCategory = Array.from(U.groupBy(stock.data, (r) => r.category_name || 'Uncategorised').entries())
          .map(([name, list]) => ({ name, at_cost: U.sum(list, (x) => x.stock_value), at_retail: U.sum(list, (x) => Number(x.selling_price) * Number(x.available)), units: U.sum(list, (x) => x.available) }))
          .sort((a, b) => b.at_cost - a.at_cost);
      }
      const t = data.totals || {};
      host.replaceChildren();
      if (offline) host.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'Offline — valued from this device\'s last sync.'));
      host.appendChild(ui.h('div', { class: 'grid grid-4' },
        ui.kpi({ label: 'Stock at cost', value: U.money(t.atCost || t.at_cost), foot: 'The balance-sheet number', small: true }),
        ui.kpi({ label: 'At retail', value: U.money(t.atRetail || t.at_retail), small: true }),
        ui.kpi({ label: 'Margin if all sold', value: U.money(t.potentialMargin || (Number(t.atRetail || t.at_retail || 0) - Number(t.atCost || t.at_cost || 0))), tone: 'good', small: true }),
        ui.kpi({ label: 'Units on hand', value: U.qty(t.units), foot: `${U.plural(t.products || 0, 'product')}`, small: true })));
      if (Array.isArray(data.byCategory) && data.byCategory.length) {
        host.appendChild(ui.dataCard({
          title: 'By category',
          table: ui.renderTable({
            columns: [
              { key: 'name', label: 'Category', className: 'wrap' },
              { key: 'units', label: 'Units', align: 'right', render: (r) => U.qty(r.units) },
              { key: 'at_cost', label: 'At cost', align: 'right', render: (r) => U.money(r.at_cost || r.atCost) },
              { key: 'at_retail', label: 'At retail', align: 'right', render: (r) => U.money(r.at_retail || r.atRetail) },
              { key: 'margin', label: 'Margin', align: 'right', render: (r) => U.money(Number(r.at_retail || r.atRetail || 0) - Number(r.at_cost || r.atCost || 0)) },
            ],
            rows: data.byCategory,
            foot: ['Total', '', U.money(t.atCost || t.at_cost), U.money(t.atRetail || t.at_retail), U.money(Number(t.atRetail || t.at_retail || 0) - Number(t.atCost || t.at_cost || 0))],
          }),
        }));
      }
      if (Array.isArray(data.branches) && data.branches.length > 1) {
        host.appendChild(ui.dataCard({
          title: 'By branch',
          table: ui.renderTable({
            columns: [
              { key: 'name', label: 'Branch' },
              { key: 'at_cost', label: 'At cost', align: 'right', render: (r) => U.money(r.at_cost || r.atCost) },
              { key: 'units', label: 'Units', align: 'right', render: (r) => U.qty(r.units) },
            ],
            rows: data.branches,
          }),
        }));
      }
    }

    async function renderExpiring() {
      let data; let offline = false;
      try {
        data = await SR.api.get('/api/stock/expiring', { query: SR.state.query() });
      } catch (err) {
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: renderExpiring } })); return; }
        offline = true;
        const branchId = SR.state.activeBranchId;
        const batches = await SR.store.all('stock_batches', { where: (b) => !Number(b.is_deleted) && String(b.branch_id) === String(branchId) && b.expiry_date && Number(b.quantity) > 0 });
        const products = await SR.store.all('products').catch(() => []);
        const byId = new Map(products.map((p) => [String(p.id), p]));
        const limit = U.addDays(U.todayWat(), Number((SR.state.settings || {}).expiry_alert_days || 60));
        data = {
          data: batches.filter((b) => b.expiry_date <= limit).map((b) => Object.assign({}, b, {
            product_name: (byId.get(String(b.product_id)) || {}).name,
            sku: (byId.get(String(b.product_id)) || {}).sku,
            days_to_expiry: U.daysBetween(U.todayWat(), b.expiry_date),
            value_at_cost: Number(b.quantity) * Number(b.cost_price_per_unit || 0),
          })).sort((a, b) => b.days_to_expiry - a.days_to_expiry),
        };
      }
      const rows = data.data || [];
      const soon = rows.filter((r) => Number(r.days_to_expiry) <= 0);
      const near = rows.filter((r) => Number(r.days_to_expiry) > 0 && Number(r.days_to_expiry) <= 30);
      host.replaceChildren();
      if (offline) host.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'Offline — from this device\'s last sync.'));
      host.appendChild(ui.h('div', { class: 'grid grid-4' },
        ui.kpi({ label: 'Already expired', value: String(soon.length), foot: U.money(U.sum(soon, (r) => r.value_at_cost)), tone: soon.length ? 'bad' : 'good', small: true }),
        ui.kpi({ label: 'Within 30 days', value: String(near.length), foot: U.money(U.sum(near, (r) => r.value_at_cost)), tone: near.length ? 'warn' : null, small: true }),
        ui.kpi({ label: 'Total at risk', value: U.money(U.sum(rows, (r) => r.value_at_cost)), small: true }),
        ui.kpi({ label: 'Alert window', value: `${Number((SR.state.settings || {}).expiry_alert_days || 60)} days`, small: true })));
      host.appendChild(ui.dataCard({
        title: 'Batches to move first',
        table: ui.renderTable({
          columns: [
            { key: 'product_name', label: 'Product', className: 'wrap' },
            { key: 'batch_no', label: 'Batch', render: (r) => ui.h('span', { class: 'mono' }, r.batch_no || '—') },
            { key: 'expiry_date', label: 'Expires', render: (r) => U.date(r.expiry_date) },
            { key: 'days_to_expiry', label: 'Days left', align: 'right', render: (r) => (Number(r.days_to_expiry) <= 0 ? ui.badge('expired', 'badge-bad') : (Number(r.days_to_expiry) <= 30 ? ui.badge(`${r.days_to_expiry} days`, 'badge-warn') : `${r.days_to_expiry}`)) },
            { key: 'quantity', label: 'Qty', align: 'right', render: (r) => U.qty(r.quantity) },
            { key: 'value_at_cost', label: 'At cost', align: 'right', render: (r) => U.money(r.value_at_cost) },
            { key: 'x', label: '', render: (r) => ui.h('button', { class: 'btn btn-sm', onClick: () => quarantine(r) }, 'Quarantine') },
          ],
          rows,
          emptyTitle: 'Nothing is expiring',
          emptyMessage: `No batch expires within ${Number((SR.state.settings || {}).expiry_alert_days || 60)} days. This is the tab to check when you have paint, food or cosmetics on the shelf.`,
        }),
      }));
    }

    async function quarantine(batch) {
      const reason = await ui.promptDialog({
        title: 'Quarantine this batch',
        label: 'Why?',
        hint: 'Quarantined stock stays on the shelf physically but is excluded from what the system will sell. It is reversible.',
        required: true,
      });
      if (!reason) return;
      try {
        await SR.api.post(`/api/stock/batches/${encodeURIComponent(batch.id)}/quarantine`, { reason }, { queue: false });
        ui.ok('Batch quarantined. It will not be sold from this branch.');
        renderExpiring();
      } catch (err) { ui.apiError(err); }
    }

    async function renderAdjustments() {
      let data; let offline = false;
      try {
        data = await SR.api.get('/api/adjustments', { query: SR.state.query({ limit: 100 }) });
      } catch (err) {
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: renderAdjustments } })); return; }
        offline = true;
        const queued = (await SR.store.outboxAll()).filter((o) => o.type === 'STOCK_ADJUST');
        data = { data: queued.map((o) => ({
          id: o.client_id, adjustment_type: (o.payload || {}).adjustment_type,
          product_name: (o.payload || {}).product_name || (o.payload || {}).product_id,
          quantity: (o.payload || {}).quantity, reason: (o.payload || {}).reason,
          created_at: o.occurred_at, created_by_name: (SR.state.user || {}).fullName,
          status: o.status,
        })) };
      }
      const rows = data.data || [];
      const byType = data.byType || [];
      host.replaceChildren();
      if (offline) host.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'Offline — adjustment records already on this device, plus whatever synced.'));
      if (byType.length) {
        host.appendChild(ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' },
          ui.bars(byType.slice(0, 8).map((b) => ({ label: U.humanise(b.adjustment_type || b.type), value: Math.abs(Number(b.total_value || b.value || 0)) })), { format: U.money, tone: 'b2' }))));
      }
      host.appendChild(ui.dataCard({
        title: 'Adjustments',
        table: ui.renderTable({
          columns: [
            { key: 'created_at', label: 'When', render: (r) => U.dateTime(r.created_at) },
            { key: 'adjustment_type', label: 'Type', render: (r) => ui.badge(r.adjustment_type, ADDITIVE.has(String(r.adjustment_type)) ? 'badge-good' : 'badge-warn') },
            { key: 'product_name', label: 'Product', className: 'wrap' },
            { key: 'quantity', label: 'Qty', align: 'right', render: (r) => `${Number(r.quantity) > 0 ? '+' : ''}${U.qty(r.quantity)}` },
            { key: 'unit_cost', label: 'Unit cost', align: 'right', render: (r) => U.money(r.unit_cost) },
            { key: 'total_value', label: 'Value', align: 'right', render: (r) => U.money(Math.abs(Number(r.total_value))) },
            { key: 'reason', label: 'Reason', className: 'wrap' },
            { key: 'created_by_name', label: 'By' },
          ],
          rows,
          emptyTitle: 'No adjustments recorded',
          emptyMessage: 'Damage, theft, expiry and count corrections all appear here with the person who recorded them.',
        }),
      }));
    }

    // ---------------- RECEIVE ----------------
    function openReceive() {
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'Receiving creates a BATCH. The cost per unit on this form is the cost that will be used for every unit of this batch until it is sold — so freight and clearing charges belong here too, not in expenses.'));
      const grid = ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Product', name: 'product_id', required: true, placeholder: 'Search the catalogue…', span: true }),
        ui.field({ label: 'Batch number', name: 'batch_no', hint: 'The supplier\'s reference. Optional, but it is what you cite in a claim.' }),
        ui.field({ label: 'Quantity received', name: 'quantity', type: 'number', step: 'any', min: '0.001', required: true }),
        // A REAL CHOOSER, defaulting to the base unit. It used to be free text that
        // a product pick silently rewrote to the receipt WORD ("unit", "carton",
        // "square metre") — a value the API has to interpret — while the cost field
        // beside it held a price PER BASE UNIT. The two disagreed by the ladder
        // factor, so receiving a carton recorded the cost of a single piece: a
        // 48-piece carton booked at one forty-eighth of what was paid for it, and
        // every margin and valuation computed from it afterwards was wrong.
        ui.field({
          label: 'Unit', name: 'unit_code',
          options: [{ value: 'PIECE', label: 'Piece' }],
          hint: 'What the quantity and the cost are counted in.',
        }),
        ui.field({ label: 'Cost per unit (₦)', name: 'cost_price_per_unit', type: 'number', step: '0.000001', min: '0', required: true, hint: 'Per the unit chosen above.' }),
        // The whole consignment's carriage, not one unit's: that is what a clearing
        // invoice shows, and the server spreads it across the units received.
        ui.field({ label: 'Freight / clearing for this delivery (₦)', name: 'freight_cost', type: 'number', step: '0.01', min: '0', hint: 'Spread across the units in this receipt.' }),
        ui.field({ label: 'Selling price (₦)', name: 'selling_price', type: 'number', step: '0.01', min: '0' }),
        ui.field({ label: 'Manufactured', name: 'manufacture_date', type: 'date' }),
        ui.field({ label: 'Expires', name: 'expiry_date', type: 'date', hint: 'Refused if it is already in the past — receiving dead stock helps nobody.' }),
        ui.field({ label: 'Supplier', name: 'supplier_id', placeholder: 'Optional' }),
        ui.field({ label: 'Warehouse zone', name: 'warehouse_zone', placeholder: 'e.g. Aisle 3, bay 2' }),
        ui.field({ label: 'Notes', name: 'notes', type: 'textarea', span: true }));
      wrapEl.appendChild(grid);

      const productInput = wrapEl.querySelector('[name="product_id"]');
      const suggestions = ui.h('div', { class: 'pos-results', hidden: true });
      productInput.parentElement.appendChild(suggestions);
      let picked = null;
      productInput.addEventListener('input', U.debounce(async () => {
        const term = productInput.value.trim();
        picked = null;
        if (term.length < 2) { suggestions.hidden = true; return; }
        let rows = [];
        try {
          const d = await SR.api.get('/api/products', { query: SR.state.query({ q: term, limit: 12 }) });
          rows = d.data || [];
        } catch (err) {
          rows = (await SR.store.all('products', { where: (p) => !Number(p.is_deleted) }))
            .filter((p) => `${p.name} ${p.sku || ''}`.toLowerCase().includes(term.toLowerCase())).slice(0, 12);
        }
        suggestions.replaceChildren();
        for (const p of rows) {
          suggestions.appendChild(ui.h('button', {
            class: 'pos-hit', type: 'button',
            onClick: () => {
              picked = p;
              productInput.value = p.name;
              loadUnits(p);
              suggestions.hidden = true;
            },
          }, ui.h('div', { class: 'grow' },
            ui.h('div', { class: 'ph-name' }, p.name),
            ui.h('div', { class: 'ph-meta' }, [p.sku, p.base_unit_name].filter(Boolean).join(' · '))),
          ui.h('span', { class: 'ph-price' }, U.money(p.cost_price))));
        }
        suggestions.hidden = !rows.length;
      }, 260));

      // The catalogue price of a product is per BASE unit. Whatever unit this
      // receipt is counted in, the two figures shown must agree with the unit
      // beside them, so the per-base price is remembered and re-expressed.
      let perBaseCost = 0;
      let perBasePrice = 0;

      function unitsOf(p) {
        return (p && Array.isArray(p.units) ? p.units : [])
          .filter((u) => !Number(u.is_deleted))
          .sort((a, b) => Number(a.quantity_in_base) - Number(b.quantity_in_base));
      }

      function priceFields(factor) {
        const cost = wrapEl.querySelector('[name="cost_price_per_unit"]');
        const price = wrapEl.querySelector('[name="selling_price"]');
        if (cost) cost.value = U.numInput(U.round2(perBaseCost * factor));
        if (price) price.value = U.numInput(U.round2(perBasePrice * factor));
      }

      function fillUnits(ladder) {
        const sel = wrapEl.querySelector('[name="unit_code"]');
        if (!sel) return;
        sel.replaceChildren();
        for (const u of ladder) {
          const factor = Number(u.quantity_in_base) || 1;
          const opt = document.createElement('option');
          opt.value = u.code;
          opt.textContent = factor > 1
            ? `${u.name || u.code} (${U.qty(factor)} ${ladder[0].name || ladder[0].code})`
            : `${u.name || u.code}`;
          sel.appendChild(opt);
        }
        // The base unit by default: it is what stock is counted in, and it is what
        // the catalogue price beside it means.
        sel.value = ladder[0].code;
        priceFields(1);
      }

      /**
       * Load this product's ladder, then price the form in the chosen unit.
       * Offline it falls back to the device mirror, so receiving keeps working on a
       * phone with no line — which is when most receiving actually happens.
       */
      async function loadUnits(p) {
        let ladder = unitsOf(p);
        if (!ladder.length) {
          try {
            const detail = await SR.api.get(`/api/products/${encodeURIComponent(p.id)}`);
            ladder = unitsOf(detail);
          } catch (err) {
            ladder = (await SR.store.all('product_units', { where: (u) => !Number(u.is_deleted) && String(u.product_id) === String(p.id) }).catch(() => []))
              .map((u) => ({ code: u.code, name: u.name, quantity_in_base: Number(u.quantity_in_base) }))
              .sort((a, b) => a.quantity_in_base - b.quantity_in_base);
          }
        }
        perBaseCost = Number(p.cost_price) || 0;
        perBasePrice = Number(p.selling_price) || 0;
        if (ladder.length) {
          fillUnits(ladder);
          return;
        }
        // No ladder at all: one unit, called whatever the product calls its base.
        const sel = wrapEl.querySelector('[name="unit_code"]');
        if (sel) {
          sel.replaceChildren();
          const opt = document.createElement('option');
          opt.value = p.default_unit_code || p.base_unit_name || 'PIECE';
          opt.textContent = p.base_unit_name || 'Piece';
          sel.appendChild(opt);
        }
        priceFields(1);
      }

      // Changing the unit re-prices the two money fields, so "3 CARTON at ₦12,400"
      // never means "three pieces at the price of one".
      const unitSelEl = wrapEl.querySelector('[name="unit_code"]');
      if (unitSelEl) {
        unitSelEl.addEventListener('change', () => {
          const chosen = unitSelEl.selectedOptions && unitSelEl.selectedOptions[0];
          const label = chosen ? chosen.textContent : '';
          const m2 = /\((\d[\d,.]*)\s/.exec(label);
          const factor = m2 ? Number(String(m2[1]).replace(/,/g, '')) : 1;
          priceFields(factor > 0 ? factor : 1);
        });
      }

      const m = ui.openModal({
        title: 'Receive stock',
        body: wrapEl,
        size: 'wide',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: async (ev) => {
              const v = ui.readFormStrings(wrapEl);
              const productId = picked ? picked.id : (v.product_id || '');
              const quantity = Number(v.quantity);
              const cost = Number(v.cost_price_per_unit);
              if (!productId) { ui.warn('Pick a product from the list.'); return; }
              if (!(quantity > 0)) { ui.warn('Enter how many units arrived.'); return; }
              if (!(cost >= 0)) { ui.warn('Enter the cost per unit.'); return; }
              ev.currentTarget.disabled = true;
              ev.currentTarget.textContent = 'Recording…';
              try {
                await SR.api.post('/api/stock/receive', {
                  branch_id: SR.state.activeBranchId,
                  business_id: SR.state.activeBusinessId,
                  product_id: String(productId),
                  batch_no: v.batch_no || null,
                  quantity, unit_code: v.unit_code || 'PIECE',
                  // The endpoint's names. It reads `cost_price` and `freight_cost`;
                  // it never read the `_per_unit` spellings this form used, so the
                  // form could not receive at all.
                  cost_price: cost,
                  freight_cost: Number(v.freight_cost) || 0,
                  selling_price: v.selling_price ? Number(v.selling_price) : null,
                  manufacture_date: v.manufacture_date || null,
                  expiry_date: v.expiry_date || null,
                  supplier_id: v.supplier_id || null,
                  warehouse_zone: v.warehouse_zone || null,
                  notes: v.notes || null,
                }, { queue: false });
                ui.ok(`Received ${U.qty(quantity)} ${v.unit_code || ''} into stock.`);
                m.close();
                load();
              } catch (err) {
                ui.apiError(err);
                ev.currentTarget.disabled = false;
                ev.currentTarget.textContent = 'Receive';
              }
            },
          }, 'Receive'),
        ],
      });
    }

    // ---------------- ADJUST ----------------
    function openAdjust(product) {
      const wrapEl = ui.h('div', {});
      const allowance = SR.state.atLeast('MANAGER') ? null : {
        units: Number((SR.state.settings || {}).staff_adjustment_max_units || 0),
        value: Number((SR.state.settings || {}).staff_adjustment_max_units ? (SR.state.settings || {}).staff_adjustment_max_units : 0),
      };
      if (allowance && Number((SR.state.settings || {}).staff_can_adjust_stock) !== 1) {
        ui.warn('You do not have permission to adjust stock. Ask an owner to enable it for your role.');
        return;
      }
      wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'An adjustment is a document: what changed, why, by whom, and what it cost. Only FOUND and POSITIVE count variances add stock; every other type removes it.'));
      const grid = ui.h('div', { class: 'form-grid' },
        ui.field({
          label: 'Reason', name: 'adjustment_type', value: 'DAMAGE',
          options: ADJUSTMENT_TYPES.map((t) => ({ value: t, label: U.humanise(t) })),
        }),
        ui.field({ label: 'Product', name: 'product_id', value: product ? product.name || product.product_name : '', required: true }),
        ui.field({ label: 'Quantity', name: 'quantity', type: 'number', step: 'any', min: '0', required: true, hint: 'Always a positive number. The reason decides whether it adds or removes.' }),
        ui.field({ label: 'Unit', name: 'unit_code', value: product ? product.base_unit_name : 'PIECE' }),
        ui.field({ label: 'Notes', name: 'reason', type: 'textarea', span: true, required: true, hint: 'What happened? "Two cartons crushed in transit" is a reason. "Adjustment" is not.' }));
      wrapEl.appendChild(grid);
      const chosen = product ? { id: product.product_id || product.id, name: product.name || product.product_name } : null;

      const m = ui.openModal({
        title: 'Adjust stock',
        body: wrapEl,
        size: 'wide',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: async (ev) => {
              const v = ui.readFormStrings(wrapEl);
              const quantity = Number(v.quantity);
              if (!chosen) { ui.warn('Open this from a product row so the system knows which item it is.'); return; }
              if (!(quantity > 0)) { ui.warn('Enter how many units are affected.'); return; }
              if (!v.reason || String(v.reason).trim().length < 4) { ui.warn('Give a real reason. It is read when the month is reviewed.'); return; }
              ev.currentTarget.disabled = true;
              try {
                await SR.api.post('/api/stock/adjust', {
                  branch_id: SR.state.activeBranchId,
                  product_id: String(chosen.id),
                  adjustment_type: v.adjustment_type,
                  quantity,
                  unit_code: v.unit_code || 'PIECE',
                  reason: v.reason,
                }, { queue: 'auto' });
                ui.ok('Adjustment recorded and posted to the ledger.');
                m.close();
                load();
              } catch (err) {
                ui.apiError(err);
                ev.currentTarget.disabled = false;
              }
            },
          }, 'Record'),
        ],
      });
    }

    // ---------------- BATCHES ----------------
    async function openBatches(row) {
      const body = ui.h('div', {});
      body.appendChild(ui.loading('Reading batches…'));
      const m = ui.openModal({ title: `${row.name} — batches`, body, size: 'wide' });
      try {
        const data = await SR.api.get(`/api/stock/${encodeURIComponent(row.product_id)}/batches`, { query: { branch_id: SR.state.activeBranchId } });
        const batches = data.batches || [];
        body.replaceChildren();
        if (Array.isArray(data.units) && data.units.length) {
          body.appendChild(ui.h('div', { class: 'chips-row', style: { marginBottom: '12px' } },
            ...data.units.map((u) => ui.badge(`${u.code || u.unit_code} = ${U.qty(u.quantity_in_base)} ${data.product.base_unit_name}`, 'badge-info'))));
        }
        body.appendChild(ui.renderTable({
          columns: [
            { key: 'batch_no', label: 'Batch', render: (b) => ui.h('span', { class: 'mono' }, b.batch_no || b.id.slice(0, 8)) },
            { key: 'received_at', label: 'Received', render: (b) => U.date(b.received_at) },
            { key: 'expiry_date', label: 'Expires', render: (b) => (b.expiry_date ? U.date(b.expiry_date) : '—') },
            { key: 'quantity', label: 'On hand', align: 'right', render: (b) => U.qty(b.quantity) },
            { key: 'reserved', label: 'Reserved', align: 'right', render: (b) => U.qty(b.quantity_reserved) },
            { key: 'cost_price_per_unit', label: 'Unit cost', align: 'right', render: (b) => U.money(b.cost_price_per_unit, { kobo: true }) },
            { key: 'value', label: 'Value', align: 'right', render: (b) => U.money(Number(b.quantity) * Number(b.cost_price_per_unit)) },
            { key: 'status', label: '', render: (b) => ui.statusBadge(b.status) },
            { key: 'serial_count', label: 'Serials', align: 'right' },
          ],
          rows: batches,
          emptyMessage: 'There is no stock of this product at this branch.',
        }));
        body.appendChild(ui.h('div', { class: 'hint', style: { marginTop: '10px' } },
          'FIFO sells the earliest-expiring batch first, then the oldest received. Within one day, batches leave in batch-number order — so a printed count sheet and the system agree.'));
        if (row.next_expiry) {
          const tools = ui.h('div', { class: 'btn-row', style: { marginTop: '12px' } },
            ui.h('button', {
              class: 'btn',
              onClick: () => {
                SR.barcode.previewLabel({
                  name: row.name, sku: row.sku, price: row.selling_price,
                  unit: row.base_unit_name, spec: row.category_name,
                });
              },
            }, 'Print a shelf label'));
          body.appendChild(tools);
        }
      } catch (err) {
        body.replaceChildren(ui.errorBlock(err, { retry: { label: 'Reload', run: () => { m.close(); openBatches(row); } } }));
      }
    }

    await load();
    return wrap;
  }

  SR.views = SR.views || {};
  SR.views.stock = { render, ADJUSTMENT_TYPES };
}(window));
