'use strict';
// =====================================================================
// public/js/views/products.js — THE CATALOGUE
// =====================================================================
// A product in StockRidge is not a row with a price. It is a small contract:
//
//   * a UNIT LADDER      — how it is bought, stocked and sold (a carton of 48,
//                          a roll of 100 metres, a 600-piece trip of blocks)
//   * VARIANTS           — the same model in three sizes or four colours
//   * REGISTRATIONS      — SONCAP for a generator, a NAFDAC number for paint
//   * WARRANTY TERMS     — how long, and what kind
//   * A MARGIN FLOOR     — below which a sale needs a reason
//
// All of that lives on this screen, because getting a unit ladder wrong is the
// single most expensive data-entry mistake in the whole system: sell one carton
// as one piece and the stock figure is out by forty-seven.
// =====================================================================
(function (global) {
  const SR = global.SR;
  const ui = SR.ui;

  /**
   * What this shop charges. The catalogue column is 0 on a shared market row
   * and on a product priced only when it was received. The branch override,
   * then the latest batch price, is the figure the till will use.
   */
  function shopSellPrice(product, data) {
    const catalogue = Number(product && product.selling_price) || 0;
    if (catalogue > 0) return catalogue;
    const branchId = SR.state.activeBranchId;
    const overrides = (data && data.priceOverrides) || [];
    const ov = overrides.find((o) => Number(o.default_selling_price) > 0 && !o.variant_id
      && (!branchId || String(o.branch_id) === String(branchId)));
    if (ov) return Number(ov.default_selling_price);
    const shelf = (data && data.shelfPrices) || [];
    const row = shelf.find((s) => Number(s.selling_price_per_unit) > 0
      && (!branchId || String(s.branch_id) === String(branchId)));
    return row ? Number(row.selling_price_per_unit) : 0;
  }
  const U = SR.util;

  const PAGE_SIZE = 50;

  async function openRegister() {
    let data;
    try {
      data = await SR.api.get('/api/pharmacy/register', { query: SR.state.query({ limit: 50 }) });
    } catch (err) {
      ui.apiError(err);
      return;
    }
    const rows = data.data || [];
    const body = rows.length
      ? ui.renderTable({
        columns: [
          { key: 'created_at', label: 'When', render: (r) => U.watClock(r.created_at) },
          { key: 'entry_type', label: 'Entry' },
          { key: 'product_name', label: 'Product' },
          { key: 'quantity_dispensed', label: 'Qty', align: 'right' },
          { key: 'buyer_name', label: 'Buyer' },
          { key: 'buyer_phone', label: 'Phone' },
        ],
        rows,
      })
      : ui.h('p', {}, 'No controlled medicine has been dispensed at this shop yet.');
    ui.openModal({ title: 'Controlled register', body, size: 'wide' });
  }

  async function render(ctx) {
    if (ctx.params.id) return renderDetail(ctx);
    ctx.setTitle('Catalogue');
    const state = { page: 0, pageSize: PAGE_SIZE, q: ctx.query.q || '', category: '', sellingGroup: '', low: false, highlightId: null };

    const wrap = ui.h('div', { class: 'stack' });
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Catalogue'),
        ui.h('p', { class: 'sub' }, SR.state.moduleOn('nafdac')
          ? 'Every NAFDAC registered product is in this catalogue, the same as any other product. Open it. It is not priced until you set a price, and it is not on the shared market list. Search a name or a NAFDAC number to raise a purchase order.'
          : 'The catalogue is in alphabetical order, including the Nigerian-market goods already on this list. A new product is filed where its name belongs. Serial stays off until you turn it on for that product.')),
      ui.h('div', { class: 'actions' },
        ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => openCreate() }, 'Add a product'),
        SR.state.moduleOn('dispensing') ? ui.h('button', { class: 'btn btn-sm', onClick: () => openRegister() }, 'Controlled register') : null,
        ui.h('button', { class: 'btn btn-sm', onClick: () => addCategory() }, 'Add a category'),
        ui.h('button', { class: 'btn btn-sm', onClick: () => exportList() }, 'Export'),
        ui.h('button', { class: 'btn btn-sm', onClick: () => labelSheet() }, 'Print labels'))));

    const toolbar = ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body row' }));
    const qInput = ui.h('input', {
      type: 'search',
      placeholder: SR.state.moduleOn('nafdac') ? 'Name, SKU, ingredient or NAFDAC number…' : 'Name, SKU, brand or model…',
      style: { minWidth: '210px' },
    });
    qInput.value = state.q;
    toolbar.firstElementChild.appendChild(ui.h('div', { class: 'grow' }, qInput));
    const sideSel = ui.h('select', { onchange: (e) => { state.sellingGroup = e.target.value; state.category = ''; state.page = 0; state.highlightId = null; fillCategories().then(load); } });
    sideSel.appendChild(ui.h('option', { value: '' }, 'Both sides'));
    for (const group of U.sellingGroups()) sideSel.appendChild(ui.h('option', { value: group.code }, group.label));
    toolbar.firstElementChild.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Side'), sideSel));
    const catSel = ui.h('select', { onchange: (e) => { state.category = e.target.value; state.page = 0; state.highlightId = null; load(); } });
    toolbar.firstElementChild.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Category'), catSel));
    wrap.appendChild(toolbar);

    const host = ui.h('div', {});
    wrap.appendChild(host);

    function byName(rows) {
      return rows.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }));
    }
    async function fillCategories() {
      try {
        const data = await SR.api.get('/api/categories', { query: SR.state.query() });
        const rows = byName(data.data || []).filter((c) => !state.sellingGroup || U.sellingGroup(c).code === state.sellingGroup);
        catSel.replaceChildren(ui.h('option', { value: '' }, 'All categories'));
        for (const c of rows) catSel.appendChild(ui.h('option', { value: String(c.id) }, `${c.name}${c.product_count ? ` (${c.product_count})` : ''}`));
        return rows;
      } catch (err) {
        const rows = byName(await SR.store.all('product_categories', { where: (c) => !Number(c.is_deleted) }))
          .filter((c) => !state.sellingGroup || U.sellingGroup(c).code === state.sellingGroup);
        catSel.replaceChildren(ui.h('option', { value: '' }, 'All categories'));
        for (const c of rows) catSel.appendChild(ui.h('option', { value: String(c.id) }, c.name));
        return rows;
      }
    }
    fillCategories();

    async function addCategory() {
      const name = await ui.promptDialog({
        title: 'Add a category',
        label: 'Category name',
        required: true,
        hint: 'It is filed alphabetically with the categories this shop already has. Provisions, fabrics, drinks — each keeps its place.',
      });
      if (!name) return;
      try {
        const created = await SR.api.post('/api/categories', {
          name,
          business_id: SR.state.activeBusinessId,
        });
        await fillCategories();
        ui.ok(created.message || `“${created.name}” added.`);
      } catch (err) { ui.apiError(err); }
    }

    qInput.addEventListener('input', U.debounce(() => { state.q = qInput.value; state.page = 0; state.highlightId = null; load(); }, 320));

    async function rowsFromMirror() {
      const needle = state.q.toLowerCase();
      let rows = await SR.store.all('products', { where: (p) => !Number(p.is_deleted) });
      const cats = await SR.store.all('product_categories').catch(() => []);
      const catById = new Map(cats.map((c) => [String(c.id), c]));
      const catName = new Map(cats.map((c) => [String(c.id), c.name]));
      if (state.sellingGroup) {
        rows = rows.filter((p) => U.sellingGroup(Object.assign({}, catById.get(String(p.category_id)) || {}, { nafdac_catalog_id: p.nafdac_catalog_id })).code === state.sellingGroup);
      }
      if (state.category) rows = rows.filter((p) => String(p.category_id) === String(state.category));
      if (needle) rows = rows.filter((p) => `${p.name} ${p.sku || ''} ${p.brand || ''} ${p.model_no || ''}`.toLowerCase().includes(needle));
      const batches = await SR.store.all('stock_batches', { where: (b) => !Number(b.is_deleted) && String(b.branch_id) === String(SR.state.activeBranchId) });
      const onHand = new Map();
      const batchPrice = new Map();
      const ordered = batches.slice().sort((a, b) => String(b.received_at || '').localeCompare(String(a.received_at || '')));
      for (const b of ordered) {
        const k = String(b.product_id);
        onHand.set(k, (onHand.get(k) || 0) + Number(b.quantity || 0) - Number(b.quantity_reserved || 0));
        if (!batchPrice.has(k) && Number(b.selling_price_per_unit) > 0
          && !['QUARANTINED', 'EXPIRED'].includes(String(b.status || '').toUpperCase())) {
          batchPrice.set(k, Number(b.selling_price_per_unit));
        }
      }
      const overrides = await SR.store.all('product_price_overrides', {
        where: (o) => !Number(o.is_deleted) && !o.variant_id && String(o.branch_id) === String(SR.state.activeBranchId) && Number(o.default_selling_price) > 0,
      }).catch(() => []);
      const ovPrice = new Map();
      for (const o of overrides) if (!ovPrice.has(String(o.product_id))) ovPrice.set(String(o.product_id), Number(o.default_selling_price));
      return rows.sort((a, b) => String(a.name).localeCompare(String(b.name))).map((p) => {
        const catalogue = Number(p.selling_price) || 0;
        const price = catalogue > 0 ? catalogue : (ovPrice.get(String(p.id)) || batchPrice.get(String(p.id)) || 0);
        return Object.assign({}, p, {
          category_name: catName.get(String(p.category_id)) || null,
          on_hand: onHand.get(String(p.id)) || 0,
          selling_price: price,
          margin_pct: price > 0 ? U.round2(((price - Number(p.cost_price)) / price) * 100) : null,
        });
      });
    }

    async function load() {
      host.replaceChildren(ui.skeleton(6));
      let data; let offline = false;
      try {
        data = await SR.api.get('/api/products', {
          query: SR.state.query({
            sort: 'name',
            q: state.q || undefined,
            category_id: state.category || undefined,
            selling_group: state.sellingGroup || undefined,
            limit: state.pageSize,
            offset: state.page * state.pageSize,
            nafdac: SR.state.moduleOn('nafdac') ? '1' : undefined,
          }),
        });
      } catch (err) {
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: load } })); return; }
        offline = true;
        const rows = await rowsFromMirror();
        data = { data: rows, paging: { total: rows.length, limit: rows.length, offset: 0 } };
      }
      const rows = data.data || [];
      const paging = data.paging || {};

      const table = ui.renderTable({
        columns: [
          { key: 'name', label: 'Product', className: 'wrap', render: (p) => {
            const cell = ui.h('div', {});
            cell.appendChild(ui.h('div', { style: { fontWeight: '600' } }, p.name));
            cell.appendChild(ui.h('div', { class: 'hint' }, [p.sku, p.brand, p.model_no, U.sellingGroup(p).label, p.category_name].filter(Boolean).join(' · ')));
            const tags = [];
            if (Number(p.tracks_variants)) tags.push('variants');
            const serial = serialSwitch(p, { stop: true, after: () => load() });
            if (serial) cell.appendChild(serial);
            if (Number(p.requires_installation)) tags.push('installation');
            if (Number(p.has_expiry)) tags.push('expiry');
            if (Number(p.warranty_months)) tags.push(`${p.warranty_months}m warranty`);
            if (Number(p.is_bulky)) tags.push('bulky');
            if (p.nafdac_catalog_id || Number(p.from_greenbook)) tags.push('NAFDAC');
            if (tags.length) cell.appendChild(ui.h('div', { class: 'chips-row', style: { marginTop: '4px' } }, ...tags.map((t) => ui.badge(t, 'badge-info'))));
            return cell;
          } },
          { key: 'base_unit_name', label: 'Base unit' },
          { key: 'on_hand', label: 'On hand', align: 'right', render: (p) => U.qty(p.on_hand) },
          { key: 'reorder_level', label: 'Reorder at', align: 'right', render: (p) => U.qty(p.reorder_level) },
          { key: 'cost_price', label: 'Cost', align: 'right', render: (p) => U.money(p.cost_price) },
          { key: 'selling_price', label: 'Price', align: 'right', render: (p) => Number(p.selling_price) > 0 ? ui.h('strong', {}, U.money(p.selling_price)) : ui.h('span', { class: 'hint' }, 'No price') },
          { key: 'margin_pct', label: 'Margin', align: 'right', render: (p) => {
            const m = Number(p.margin_pct);
            if (!Number.isFinite(m)) return '—';
            const floor = Number(p.min_margin_pct) || 0;
            return ui.h('span', { style: m < floor ? { color: 'var(--red-700)', fontWeight: '700' } : (m < floor + 5 ? { color: 'var(--amber-700)' } : {}) }, U.pct(m));
          } },
          { key: 'x', label: '', render: (p) => ui.h('button', { class: 'btn btn-sm', onClick: (ev) => { ev.stopPropagation(); openProduct(p); } }, 'Open') },
        ],
        rows,
        onRowClick: (p) => openProduct(p),
        rowClass: (p) => (state.highlightId && String(p.id) === String(state.highlightId) ? 'is-placed' : ''),
        emptyTitle: state.q ? 'Nothing matches that search' : 'The catalogue is empty',
        emptyMessage: state.q
          ? 'Try a different word, or clear the category filter.'
          : 'Add a product. It is filed alphabetically with the rest of this list. Prices are not included — you set them.',
        emptyAction: state.q ? null : { label: 'Add a product', run: () => openCreate() },
      });

      host.replaceChildren();
      if (offline) host.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'Offline — showing the catalogue as this device last synced it.'));
      const total = paging.total != null ? paging.total : rows.length;
      host.appendChild(ui.dataCard({
        title: 'Products',
        table,
        pager: ui.pager({
          page: state.page, pageSize: paging.limit || state.pageSize, total,
          onPage: (p) => { state.page = p; state.highlightId = null; load(); },
          onSize: (n) => { state.pageSize = n; state.page = 0; state.highlightId = null; load(); },
        }),
      }));
    }

    function greenbookShape(row) {
      return {
        id: row.nafdac_catalog_id,
        product_name: row.name,
        manufacturer: row.brand || '',
        nafdac_reg_no: row.registration_no || row.sku || '',
        base_unit: row.base_unit_name || 'unit',
        dispensing_type: row.dispensing_class || 'OTC',
        is_controlled: Number(row.is_controlled) ? 1 : 0,
        strength: row.model_no || '',
      };
    }

    function addFromGreenbook(row) {
      productForm(null, { greenbook: row }).then((ok) => { if (ok && ok.id) placeInList(ok); else if (ok) load(); });
    }

    async function openProduct(row) {
      if (!row) return;
      // A real product opens. A leftover virtual Greenbook id is not a product,
      // and it must not open the price form under an Open label. Copy it into
      // this shop, then open that copy.
      if (row.id && !String(row.id).startsWith('nafdac:') && !Number(row.from_greenbook)) {
        SR.app.navigate(`/products/${row.id}`);
        return;
      }
      const catalogId = row.nafdac_catalog_id;
      if (!catalogId) return;
      try {
        const created = await SR.api.post(`/api/nafdac/${encodeURIComponent(catalogId)}/adopt`, {
          for_order: true,
          selling_price: 0,
          cost_price: 0,
          business_id: SR.state.activeBusinessId,
        });
        if (created && created.id) SR.app.navigate(`/products/${created.id}`);
      } catch (err) { ui.apiError(err); }
    }

    async function exportList() {
      try {
        await SR.exporter.list({
          filename: 'catalogue',
          path: '/api/products',
          query: SR.state.query({
            sort: 'name',
            q: state.q || undefined,
            nafdac: SR.state.moduleOn('nafdac') ? '1' : undefined,
          }),
          mirrorTable: 'products',
          columns: [
            { key: 'name', label: 'Product' }, { key: 'sku', label: 'SKU' },
            { key: 'category_name', label: 'Category' }, { key: 'brand', label: 'Brand' },
            { key: 'model_no', label: 'Model' }, { key: 'base_unit_name', label: 'Unit' },
            { key: 'cost_price', label: 'Cost' }, { key: 'selling_price', label: 'Price' },
            { key: 'reorder_level', label: 'Reorder at' }, { key: 'warranty_months', label: 'Warranty (months)' },
          ],
        });
      } catch (err) { ui.apiError(err); }
    }

    async function labelSheet() {
      const rows = (await SR.store.all('products', { where: (p) => !Number(p.is_deleted) })).slice(0, 60);
      if (!rows.length) { ui.warn('There is nothing in the catalogue to label.'); return; }
      const codes = await SR.store.all('product_barcodes').catch(() => []);
      const byId = new Map();
      for (const b of codes) {
        if (Number(b.is_deleted) || !b.barcode) continue;
        const id = String(b.product_id);
        if (!byId.has(id) || Number(b.is_primary)) byId.set(id, String(b.barcode));
      }
      SR.barcode.printLabels(rows.map((p) => ({
        name: p.name,
        sku: p.sku,
        barcode: byId.get(String(p.id)) || p.barcode || null,
        price: p.selling_price,
        unit: p.base_unit_name,
        spec: p.model_no || p.brand,
      })), { title: 'StockRidge price labels' });
    }

    // ---------------- create ----------------
    function openCreate() {
      productForm(null).then((ok) => { if (ok && ok.id) placeInList(ok); else if (ok) load(); });
    }

    async function placeInList(product) {
      state.q = '';
      qInput.value = '';
      state.category = '';
      if (catSel) catSel.value = '';
      state.highlightId = product.id;
      state.page = 0;
      try {
        const probe = await SR.api.get('/api/products', {
          query: SR.state.query({
            sort: 'name',
            locate: product.id,
            limit: 1,
            offset: 0,
            nafdac: SR.state.moduleOn('nafdac') ? '1' : undefined,
          }),
        });
        const index = probe.located && Number.isFinite(Number(probe.located.index)) ? Number(probe.located.index) : 0;
        state.page = Math.floor(index / state.pageSize);
      } catch (err) {
        if (err && err.isOffline) {
          const rows = await rowsFromMirror();
          const index = rows.findIndex((p) => String(p.id) === String(product.id));
          state.page = index >= 0 ? Math.floor(index / state.pageSize) : 0;
        }
      }
      await load();
    }

    await load();
    return wrap;
  }

  // -------------------------------------------------------------------
  // CREATE / EDIT FORM
  // -------------------------------------------------------------------
  async function productForm(product, options = {}) {
    const greenbook = options.greenbook || null;
    const editing = Boolean(product);
    let categories = [];
    let units = [];
    try {
      const [c, p] = await Promise.all([
        SR.api.get('/api/categories', { query: SR.state.query() }),
        SR.api.get('/api/profiles', { query: {} }).catch(() => ({ data: [] })),
      ]);
      categories = c.data || [];
      void p;
    } catch (err) {
      categories = await SR.store.all('product_categories', { where: (c) => !Number(c.is_deleted) }).catch(() => []);
    }

    const wrapEl = ui.h('div', {});
    const base = product || (greenbook ? {
      name: greenbook.product_name,
      brand: greenbook.manufacturer || '',
      registration_no: greenbook.nafdac_reg_no || '',
      base_unit_name: greenbook.base_unit || 'Piece',
      dispensing_class: greenbook.dispensing_type || 'OTC',
      is_controlled: Number(greenbook.is_controlled) ? 1 : 0,
      has_expiry: 1,
      is_active: 1,
    } : {});
    if (greenbook) {
      wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'This comes from the NAFDAC catalogue, so it is recorded as pharmaceutical even if you also file it on another shelf. Set your own price. It is added to this shop only, not to the shared market list.'));
    }
    const fields = [
      ui.field({ label: 'Name', name: 'name', value: base.name || '', required: true, span: true, placeholder: 'e.g. Hisense 1.5HP Split Air Conditioner' }),
      ui.field({ label: 'Category', name: 'category_id', value: base.category_id || '', hint: greenbook ? 'Optional. The NAFDAC catalogue link already makes this pharmaceutical.' : 'A new product is pharmaceutical only when you file it under a medicine shelf — Analgesics, Vitamins, Injections and the rest. Provisions, drinks and other shelves are not.', options: [{ value: '', label: '— none —' }].concat(categories.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' })).map((c) => ({ value: String(c.id), label: `${U.sellingGroup(c).code === 'PHARMACEUTICALS' ? 'Pharmaceuticals' : 'Non-pharmaceuticals'} · ${c.name}` }))) }),
      ui.field({ label: 'Brand', name: 'brand', value: base.brand || '' }),
      ui.field({ label: 'Model number', name: 'model_no', value: base.model_no || '' }),
      ui.field({ label: 'SKU', name: 'sku', value: base.sku || '', hint: greenbook ? 'Left blank, one is taken from the NAFDAC number.' : 'Left blank, one is suggested from the name.' }),
      ui.field({ label: 'Base unit name', name: 'base_unit_name', value: base.base_unit_name || 'PIECE', hint: 'The smallest unit you would sell. Everything else is a multiple of it.' }),
      ui.field({ label: 'Cost price (₦)', name: 'cost_price', type: 'number', step: '0.01', min: '0', value: base.cost_price != null ? U.numInput(base.cost_price) : '' }),
      ui.field({ label: 'Selling price (₦)', name: 'selling_price', type: 'number', step: '0.01', min: '0', value: base.selling_price != null ? U.numInput(base.selling_price) : '', required: true }),
    ];
    if (SR.state.moduleOn('hire')) {
      fields.push(
        ui.field({ label: 'Hire rate per day (₦)', name: 'hire_price_per_day', type: 'number', step: '0.01', min: '0', value: base.hire_price_per_day != null ? U.numInput(base.hire_price_per_day) : '', hint: 'What one unit costs for one day out. Leave blank if it is not hired.' }),
        ui.field({ label: 'Hire deposit each (₦)', name: 'hire_deposit', type: 'number', step: '0.01', min: '0', value: base.hire_deposit != null ? U.numInput(base.hire_deposit) : '', hint: 'Held, not earned. Returned when the goods come back undamaged.' }),
      );
    }
    if (SR.state.moduleOn('lease')) {
      fields.push(
        ui.field({ label: 'Lease rent per month (₦)', name: 'lease_price_per_month', type: 'number', step: '0.01', min: '0', value: base.lease_price_per_month != null ? U.numInput(base.lease_price_per_month) : '' }),
        ui.field({ label: 'Lease deposit each (₦)', name: 'lease_deposit', type: 'number', step: '0.01', min: '0', value: base.lease_deposit != null ? U.numInput(base.lease_deposit) : '' }),
      );
    }
    fields.push(
      ui.field({ label: 'Minimum margin %', name: 'min_margin_pct', type: 'number', step: '0.1', min: '0', value: base.min_margin_pct != null ? U.numInput(base.min_margin_pct) : '', hint: 'A header on the POS warns below this. It does not block the sale.' }),
      ui.field({ label: 'Reorder level', name: 'reorder_level', type: 'number', step: 'any', min: '0', value: base.reorder_level != null ? U.numInput(base.reorder_level) : '' }),
      ui.field({ label: 'Reorder quantity', name: 'reorder_quantity', type: 'number', step: 'any', min: '0', value: base.reorder_quantity != null ? U.numInput(base.reorder_quantity) : '' }),
    );
    if (SR.state.moduleOn('warranty')) {
      fields.push(
        ui.field({ label: 'Warranty (months)', name: 'warranty_months', type: 'number', step: '1', min: '0', value: base.warranty_months != null ? U.numInput(base.warranty_months) : '' }),
        ui.field({
          label: 'Warranty type', name: 'warranty_type', value: base.warranty_type || '',
          options: [{ value: '', label: '— none —' }, { value: 'MANUFACTURER', label: 'Manufacturer' }, { value: 'SELLER', label: 'Seller' }, { value: 'EXTENDED', label: 'Extended' }, { value: 'NONE', label: 'No warranty' }],
        }),
      );
    }
    fields.push(ui.field({ label: 'Registration number', name: 'registration_no', value: base.registration_no || '', span: true, hint: greenbook ? 'The NAFDAC number. Recorded with the product.' : 'SONCAP, NAFDAC or MANCAP number. Advisory — recorded, never a blocked sale.' }));
    if (SR.state.moduleOn('dispensing')) {
      fields.push(ui.field({
        label: 'Dispensing class',
        name: 'dispensing_class',
        value: base.dispensing_class || '',
        options: [
          { value: '', label: 'Not a medicine' },
          { value: 'OTC', label: 'OTC — sold without a prescription' },
          { value: 'POM', label: 'POM — prescription required' },
        ],
        hint: 'Leave this blank for everything that is not a medicine.',
      }));
    }
    const grid = ui.h('div', { class: 'form-grid' }, fields);
    wrapEl.appendChild(grid);

    const serialOn = editing ? Boolean(Number(base.requires_serial)) : false;
    const serialBox = ui.h('fieldset');
    serialBox.appendChild(ui.h('legend', {}, 'Serial number'));
    serialBox.appendChild(ui.h('p', { class: 'hint' }, 'Off, this product is sold without a number. On, the till asks for one number per unit, from this catalogue through to the receipt.'));
    serialBox.appendChild(ui.h('label', { class: 'check' },
      ui.h('input', { type: 'checkbox', name: 'requires_serial', checked: serialOn }),
      ui.h('strong', {}, 'Use a serial number on this product')));
    if (SR.state.moduleOn('serials')) wrapEl.appendChild(serialBox);

    const flags = ui.h('fieldset');
    flags.appendChild(ui.h('legend', {}, 'Behaviour'));
    const flagList = [
      ['tracks_variants', 'Has variants', 'The same product in several sizes, colours or capacities.', 'variants'],
      ['has_expiry', 'Has an expiry date', 'Batches carry an expiry and the system will refuse to receive already-expired stock.', 'expiry'],
      ['requires_installation', 'Needs installation', 'Selling it creates an installation job for a technician.', 'installation'],
      ['is_bulky', 'Bulky item', 'Affects delivery planning.', 'bulky'],
      ['is_fragile', 'Fragile', 'Warns at goods-out.', 'fragile'],
      ['offers_hire', 'Available for hire', 'Goes out for days and comes back. Stock is not sold.', 'hire'],
      ['offers_lease', 'Available for lease', 'Goes out for months. Rent is income. The asset stays yours until a buyout.', 'lease'],
      ['is_returnable', 'Returnable', 'A customer may return it inside the window.', null],
      ['is_controlled', 'Controlled medicine', 'The till asks for the buyer’s name and phone, and the sale is written into the register.', 'dispensing'],
      ['is_active', 'Active', 'Turn off to hide it from the POS without deleting its history.', null],
    ].filter((row) => !row[3] || SR.state.moduleOn(row[3]));
    for (const [name, label, hint] of flagList) {
      const checked = editing || greenbook
        ? (name === 'is_active' && base[name] == null ? true : Boolean(Number(base[name])))
        : (name === 'is_active');
      const row = ui.h('label', { class: 'check', style: { marginBottom: '8px', alignItems: 'flex-start' } },
        ui.h('input', { type: 'checkbox', name, checked }),
        ui.h('div', {}, ui.h('strong', {}, label), ui.h('div', { class: 'hint' }, hint)));
      flags.appendChild(row);
    }
    wrapEl.appendChild(flags);

    // ---- unit ladder: the highest-value part of this form
    const ladderWrap = ui.h('fieldset');
    ladderWrap.appendChild(ui.h('legend', {}, 'Units'));
    ladderWrap.appendChild(ui.h('p', { class: 'hint' },
      'How this product is bought, held and sold. Level 1 is always exactly one base unit. Add a level for a pack (a carton of 48), a roll of 100 metres, or a 600-piece trip of blocks. Every quantity the system records is converted to the base unit.'));
    const ladderList = ui.h('div', { class: 'stack' });
    const ladder = (editing && Array.isArray(base.units) && base.units.length)
      ? base.units.map((u) => ({ code: u.code || u.unit_code, name: u.name, quantity_in_base: u.quantity_in_base, is_base: Boolean(Number(u.is_base)) }))
      : [{ code: 'PIECE', name: base.base_unit_name || 'Piece', quantity_in_base: 1, is_base: true }];
    function paintLadder() {
      ladderList.replaceChildren();
      ladder.forEach((level, i) => {
        const row = ui.h('div', { class: 'row' });
        row.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, `Level ${i + 1}`),
          ui.h('input', {
            value: level.name || '',
            placeholder: i === 0 ? 'Piece' : 'Carton',
            oninput: (e) => { level.name = e.target.value; level.code = String(e.target.value || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_') || `UNIT${i}`; },
          })));
        row.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Base units'),
          ui.h('input', {
            type: 'number', step: 'any', min: '0',
            value: String(level.quantity_in_base),
            disabled: i === 0,
            oninput: (e) => { level.quantity_in_base = Number(e.target.value) || 0; },
          })));
        row.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Price for this unit (₦)'),
          ui.h('input', { type: 'number', step: '0.01', min: '0', value: U.numInput(level.unit_price || ''), oninput: (e) => { level.unit_price = Number(e.target.value) || null; } })));
        if (i > 0) {
          row.appendChild(ui.h('button', { class: 'btn btn-sm', style: { alignSelf: 'flex-end' }, onClick: () => { ladder.splice(i, 1); paintLadder(); } }, 'Remove'));
        }
        ladderList.appendChild(row);
      });
    }
    paintLadder();
    ladderWrap.appendChild(ladderList);
    ladderWrap.appendChild(ui.h('button', {
      class: 'btn btn-sm',
      onClick: () => { ladder.push({ name: '', code: '', quantity_in_base: 0, unit_price: null }); paintLadder(); },
    }, 'Add another unit level'));
    wrapEl.appendChild(ladderWrap);
    if (!editing) {
      wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'A shelf barcode is assigned when you save, the same as the other products in this catalogue. A USB scanner at the till reads that code. You do not type it.'));
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (settled) return; settled = true; resolve(v); m.close(); };
      const m = ui.openModal({
        title: editing ? `Edit ${base.name}` : (greenbook ? `Add ${greenbook.product_name}` : 'Add a product'),
        body: wrapEl,
        size: 'wide',
        onClose: () => finish(false),
        footer: [
          ui.h('button', { class: 'btn', onClick: () => finish(false) }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: async (ev) => {
              const v = ui.readFormStrings(wrapEl);
              if (!v.name) { ui.warn('A product needs a name.'); return; }
              if (SR.app.guardWorkingBusiness && !SR.app.guardWorkingBusiness()) return;
              if (!(Number(v.selling_price) >= 0)) { ui.warn('Enter a selling price.'); return; }
              const flagValues = {};
              for (const el of flags.querySelectorAll('input[type="checkbox"]')) flagValues[el.name] = el.checked ? 1 : 0;
              const serialEl = wrapEl.querySelector('input[name="requires_serial"]');
              if (serialEl) flagValues.requires_serial = serialEl.checked ? 1 : 0;
              const moneyOrNull = (value) => (value === null || value === '' || value === undefined ? null : Number(value));
              const payload = Object.assign({
                branch_id: SR.state.activeBranchId,
                business_id: SR.state.activeBusinessId,
                name: v.name,
                category_id: v.category_id || null,
                brand: v.brand || null,
                model_no: v.model_no || null,
                sku: v.sku || null,
                registration_no: v.registration_no || null,
                base_unit_name: v.base_unit_name || 'PIECE',
                cost_price: v.cost_price === null || v.cost_price === '' ? 0 : Number(v.cost_price),
                selling_price: Number(v.selling_price),
                min_margin_pct: v.min_margin_pct === null || v.min_margin_pct === '' ? null : Number(v.min_margin_pct),
                reorder_level: v.reorder_level === null || v.reorder_level === '' ? 0 : Number(v.reorder_level),
                reorder_quantity: v.reorder_quantity === null || v.reorder_quantity === '' ? null : Number(v.reorder_quantity),
                units: ladder.map((l, i) => ({
                  code: l.code || (i === 0 ? 'PIECE' : `UNIT_${i}`),
                  name: l.name || l.code || `Unit ${i + 1}`,
                  quantity_in_base: i === 0 ? 1 : Number(l.quantity_in_base),
                  is_base: i === 0,
                  unit_price: i === 0 ? Number(v.selling_price) : (l.unit_price != null ? l.unit_price : null),
                })),
              }, flagValues);
              if (SR.state.moduleOn('hire')) {
                payload.hire_price_per_day = moneyOrNull(v.hire_price_per_day);
                payload.hire_deposit = moneyOrNull(v.hire_deposit);
              }
              if (SR.state.moduleOn('lease')) {
                payload.lease_price_per_month = moneyOrNull(v.lease_price_per_month);
                payload.lease_deposit = moneyOrNull(v.lease_deposit);
              }
              if (SR.state.moduleOn('warranty')) {
                payload.warranty_months = moneyOrNull(v.warranty_months);
                payload.warranty_type = v.warranty_type || null;
              }
              if (SR.state.moduleOn('dispensing')) payload.dispensing_class = v.dispensing_class || null;
              ev.currentTarget.disabled = true;
              ev.currentTarget.textContent = 'Saving…';
              try {
                const result = greenbook
                  ? await SR.api.post(`/api/nafdac/${encodeURIComponent(greenbook.id)}/adopt`, payload)
                  : editing
                    ? await SR.api.put(`/api/products/${encodeURIComponent(product.id)}`, payload)
                    : await SR.api.post('/api/products', payload);
                if (result && result.warning) ui.warn(result.warning);
                else if (result && result.barcodeWarning) ui.warn(result.barcodeWarning);
                if (!editing && result && result.barcode && SR.store && SR.store.putMany) {
                  await SR.store.putMany('product_barcodes', [{
                    id: result.barcodeId || `bc-${result.id}`,
                    product_id: result.id,
                    barcode: result.barcode,
                    unit_code: result.barcodeUnit || 'PIECE',
                    label: 'Shelf label',
                    is_primary: 1,
                    is_deleted: 0,
                  }]).catch(() => {});
                }
                if (flagValues.requires_serial === 1 && !SR.state.usesSerialNumbers() && SR.state.can('OWNER')) {
                  await SR.api.put('/api/settings', { serial_tracking_enabled: 1 });
                  await SR.state.load({ force: true }).catch(() => {});
                }
                ui.ok(editing ? 'Product updated.' : (result && result.message) || `${v.name} is in the catalogue, in alphabetical order.`);
                finish({ id: (result && result.id) || (product && product.id), name: v.name });
              } catch (err) {
                ui.apiError(err);
                ev.currentTarget.disabled = false;
                ev.currentTarget.textContent = 'Save';
              }
            },
          }, editing ? 'Save changes' : 'Add the product'),
        ],
      });
    });
  }

  // -------------------------------------------------------------------
  // ONE PRODUCT
  // -------------------------------------------------------------------
  /**
   * SET A BRANCH PRICE.
   *
   * The counterpart to the two endpoints in server/routes/catalog.js. Until this
   * existed, `domain/pricing.js` honoured a per-branch override that no screen
   * could create: an Ikeja shop priced a kettle exactly like the Aba shop, and a
   * wholesale counter could not carry a carton price different from the piece
   * price times twenty-four.
   *
   * The form offers only the levels the product ACTUALLY sells in, taken from its
   * own unit ladder. Offering a carton price for a product with no carton is how
   * a shop ends up with a price that nothing can ever charge.
   */
  async function branchPriceForm(product, units, existing, onDone) {
    const branches = SR.state.branches() || [];
    if (!branches.length) { ui.warn('There are no branches to price against yet.'); return; }
    const ladder = Array.isArray(units) ? units : [];
    const cartonUnit = ladder.find((u) => String(u.code).toUpperCase() === 'CARTON');
    const packUnit = ladder.find((u) => String(u.code).toUpperCase() === 'PACK');
    const base = existing || {};
    const wrapEl = ui.h('div', {});
    wrapEl.appendChild(ui.h('p', { class: 'hint' },
      `This price applies in ONE branch. Everywhere else keeps the catalogue price of ${U.money(product.selling_price)} per ${String(product.base_unit_name || 'unit').toLowerCase()}.`));

    const grid = ui.h('div', { class: 'form-grid' },
      ui.field({
        label: 'Branch', name: 'branch_id', required: true,
        value: base.branch_id || SR.state.activeBranchId || '',
        options: branches.map((b) => ({ value: String(b.id), label: b.name })),
      }),
      ui.field({
        label: `Price per ${String(product.base_unit_name || 'unit').toLowerCase()} (₦)`,
        name: 'default_selling_price', type: 'number', step: '0.01', min: '0', required: true,
        value: base.default_selling_price != null ? U.numInput(base.default_selling_price) : U.numInput(product.selling_price),
        hint: `The catalogue price is ${U.money(product.selling_price)}; the cost is ${U.money(product.cost_price)}.`,
      }));
    if (packUnit) {
      grid.appendChild(ui.field({
        label: `Pack price (₦) — a pack of ${U.qty(packUnit.quantity_in_base)}`,
        name: 'pack_price', type: 'number', step: '0.01', min: '0',
        value: base.pack_price != null ? U.numInput(base.pack_price) : '',
        hint: 'Leave blank to charge the per-piece price × the pack size.',
      }));
    }
    if (cartonUnit) {
      grid.appendChild(ui.field({
        label: `Carton price (₦) — a carton of ${U.qty(cartonUnit.quantity_in_base)}`,
        name: 'carton_price', type: 'number', step: '0.01', min: '0',
        value: base.carton_price != null ? U.numInput(base.carton_price) : '',
        hint: 'Leave blank to charge the per-piece price × the carton size.',
      }));
    }
    wrapEl.appendChild(grid);
    if (product.cost_price > 0) {
      const warnLine = ui.h('div', { class: 'hint' });
      wrapEl.appendChild(warnLine);
      const check = () => {
        const v = ui.readFormStrings(wrapEl);
        const price = v.default_selling_price === null ? NaN : Number(v.default_selling_price);
        const loser = Number.isFinite(price) && price < Number(product.cost_price);
        warnLine.textContent = loser
          ? `Below cost: every ${String(product.base_unit_name || 'unit').toLowerCase()} sold at this branch would lose ${U.money(Number(product.cost_price) - price)}.`
          : '';
        warnLine.style.color = loser ? 'var(--danger, #b42318)' : '';
      };
      wrapEl.addEventListener('input', check);
      check();
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (settled) return; settled = true; resolve(v); m.close(); };
      const m = ui.openModal({
        title: existing ? `Change the price in ${existing.branch_name || 'this branch'}` : `Set a branch price for ${product.name}`,
        body: wrapEl,
        onClose: () => finish(false),
        footer: [
          ui.h('button', { class: 'btn', onClick: () => finish(false) }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: async (ev) => {
              const v = ui.readFormStrings(wrapEl);
              if (!v.branch_id) { ui.warn('Choose the branch this price applies to.'); return; }
              if (!(Number(v.default_selling_price) >= 0)) { ui.warn('Enter the price per piece.'); return; }
              const payload = {
                branch_id: String(v.branch_id),
                default_selling_price: Number(v.default_selling_price),
                pack_price: v.pack_price === null || v.pack_price === '' ? null : Number(v.pack_price),
                carton_price: v.carton_price === null || v.carton_price === '' ? null : Number(v.carton_price),
              };
              ev.currentTarget.disabled = true;
              ev.currentTarget.textContent = 'Saving…';
              try {
                const result = await SR.api.put(`/api/products/${encodeURIComponent(product.id)}/price-override`, payload);
                ui.ok(result.message || 'Branch price saved.');
                for (const w of result.warnings || []) ui.warn(w);
                finish(true);
                if (onDone) onDone();
              } catch (err) {
                ev.currentTarget.disabled = false;
                ev.currentTarget.textContent = 'Save the price';
                ui.error(err && err.isOffline
                  ? 'Changing a price needs a line. It will be here when you are back on.'
                  : (err && err.message) || 'Could not save the price.');
              }
            },
          }, 'Save the price'),
        ],
      });
    });
  }

  async function renderDetail(ctx) {
    ctx.setTitle('Product');
    const wrap = ui.h('div', { class: 'stack' });
    const host = ui.h('div', { class: 'stack' });
    wrap.appendChild(host);
    await load();

    async function load() {
      host.replaceChildren(ui.skeleton(7));
      let data; let offline = false;
      try {
        data = await SR.api.get(`/api/products/${encodeURIComponent(ctx.params.id)}`);
      } catch (err) {
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: load } })); return; }
        offline = true;
        const p = await SR.store.get('products', ctx.params.id);
        if (!p) { host.replaceChildren(ui.empty({ title: 'Not on this device', message: 'This product has not been synced to this device yet.' })); return; }
        data = {
          product: p,
          units: await SR.store.all('product_units', { where: (u) => String(u.product_id) === String(p.id) }),
          variants: [], batches: [], barcodes: [],
          priceOverrides: await SR.store.all('product_price_overrides', { where: (o) => !Number(o.is_deleted) && String(o.product_id) === String(p.id) }).catch(() => []),
          shelfPrices: (await SR.store.all('stock_batches', { where: (b) => !Number(b.is_deleted) && String(b.product_id) === String(p.id) && Number(b.selling_price_per_unit) > 0 }).catch(() => []))
            .map((b) => ({ branch_id: b.branch_id, selling_price_per_unit: b.selling_price_per_unit, received_at: b.received_at })),
        };
      }
      const p = data.product || data;
      const price = shopSellPrice(p, data);
      const units = data.units || p.units || [];
      const variants = data.variants || [];
      const batches = data.batches || [];
      const barcodes = data.barcodes || [];
      const primary = barcodes.find((b) => Number(b.is_primary)) || barcodes[0] || null;
      const primaryCode = (primary && primary.barcode) || p.barcode || null;
      const labelItem = { name: p.name, sku: p.sku, barcode: primaryCode, price: price || p.selling_price, unit: p.base_unit_name, spec: p.model_no };

      host.replaceChildren();
      const overview = [];
      const stockNodes = [];
      const head = ui.h('div', { class: 'page-head' },
        ui.h('div', {},
          ui.h('h1', {}, p.name),
          ui.h('p', { class: 'sub' }, [p.sku, primaryCode ? `barcode ${primaryCode}` : null, p.brand, p.model_no, data.category ? data.category.name : p.category_name].filter(Boolean).join(' · '))),
        ui.h('div', { class: 'actions' },
          ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate('/products') }, 'Back'),
          ui.h('button', { class: 'btn btn-sm', onClick: async () => {
            try {
              await setSerial(p, !Number(p.requires_serial));
              ui.toast(Number(p.requires_serial) ? `${p.name} is sold without a serial number.` : `${p.name} uses a serial number. The till will ask for one per unit.`);
              load();
            } catch (err) { ui.apiError(err); }
          } }, Number(p.requires_serial) ? 'Serial off' : 'Serial on'),
          ui.h('button', { class: 'btn btn-sm', onClick: () => { productForm(data).then((ok) => { if (ok) load(); }); } }, 'Edit'),
          ui.h('button', { class: 'btn btn-sm', onClick: () => SR.barcode.previewLabel(labelItem) }, 'Label')));

      if (offline) overview.push(ui.h('div', { class: 'alert alert-warn' }, 'Offline — from this device\'s last sync.'));

      overview.push(ui.h('div', { class: 'grid grid-4' },
        ui.kpi({
          label: 'Selling price',
          value: price > 0 ? U.money(price) : 'No price',
          foot: price > 0 && !(Number(p.selling_price) > 0) ? 'This shop, from the receipt' : null,
          small: true,
        }),
        ui.kpi({ label: 'Cost', value: U.money(p.cost_price), small: true }),
        ui.kpi({
          label: 'Margin',
          value: U.pct(price > 0 ? U.round2(((price - Number(p.cost_price)) / price) * 100) : 0),
          tone: Number(p.min_margin_pct) && price > 0 && ((price - Number(p.cost_price)) / price) * 100 < Number(p.min_margin_pct) ? 'bad' : 'good',
          foot: Number(p.min_margin_pct) ? `floor ${p.min_margin_pct}%` : null,
          small: true,
        }),
        ui.kpi({ label: 'Reorder level', value: U.qty(p.reorder_level), foot: Number(p.reorder_quantity) ? `order ${U.qty(p.reorder_quantity)}` : null, small: true })));

      const cols = ui.h('div', { class: 'grid grid-2' });

      cols.appendChild(ui.dataCard({
        title: 'Units and prices',
        table: ui.renderTable({
          columns: [
            { key: 'name', label: 'Unit' },
            { key: 'code', label: 'Code', render: (u) => ui.h('span', { class: 'mono' }, u.code || u.unit_code) },
            { key: 'quantity_in_base', label: 'Base units', align: 'right', render: (u) => U.qty(u.quantity_in_base) },
            { key: 'unit_price', label: 'Price', align: 'right', render: (u) => U.money(u.unit_price != null ? u.unit_price : (Number(u.quantity_in_base) * price)) },
            { key: 'base', label: '', render: (u) => (Number(u.is_base) ? ui.badge('base', 'badge-good') : '') },
          ],
          rows: units,
          emptyMessage: 'No unit ladder. The product is sold as a single base unit only.',
        }),
      }));

      const facts = ui.h('div', { class: 'stack' });
      facts.appendChild(ui.dataCard({
        title: 'Terms',
        table: ui.kv([
          ['Base unit', p.base_unit_name],
          ['Category', data.category ? data.category.name : p.category_name],
          ['Brand', p.brand], ['Model', p.model_no],
          ['Registration', p.registration_no],
          SR.state.moduleOn('dispensing') ? ['Dispensing', p.dispensing_class || 'not a medicine'] : null,
          SR.state.moduleOn('dispensing') ? ['Controlled', Number(p.is_controlled) ? 'yes — buyer name and phone required' : 'no'] : null,
          SR.state.moduleOn('warranty') ? ['Warranty', Number(p.warranty_months) ? `${p.warranty_months} months (${U.humanise(p.warranty_type || 'manufacturer')})` : 'none'] : null,
          ['Return window', Number(p.return_window_days) ? `${p.return_window_days} days` : null],
          SR.state.moduleOn('serials') ? ['Serial number', Number(p.requires_serial) ? 'On — the till asks for one number per unit' : 'Off'] : null,
          SR.state.moduleOn('variants') ? ['Variants', Number(p.tracks_variants) ? 'yes' : 'no'] : null,
          SR.state.moduleOn('expiry') ? ['Expiry tracked', Number(p.has_expiry) ? 'yes' : 'no'] : null,
          SR.state.moduleOn('installation') ? ['Needs installation', Number(p.requires_installation) ? 'yes' : 'no'] : null,
          ['Active', Number(p.is_active) ? 'yes' : 'NO — hidden from the POS'],
        ].filter(Boolean)),
      }));
      if (variants.length) {
        facts.appendChild(ui.dataCard({
          title: 'Variants',
          table: ui.renderTable({
            columns: [
              { key: 'name', label: 'Variant' },
              { key: 'sku', label: 'SKU' },
              { key: 'price_adjustment', label: 'Price adj.', align: 'right', render: (v) => U.money(v.price_adjustment) },
            ],
            rows: variants,
          }),
        }));
      }
      cols.appendChild(facts);
      overview.push(cols);

      if (barcodes.length) {
        const chips = ui.h('div', { class: 'card' });
        chips.appendChild(ui.h('div', { class: 'card-head' }, ui.h('h2', {}, 'Barcodes')));
        const body = ui.h('div', { class: 'card-body' });
        for (const b of barcodes.slice(0, 8)) {
          const code = b.barcode;
          const svg = SR.barcode.autoSvg(code, { height: 44, moduleWidth: 1.4 });
          const box = ui.h('div', { style: { display: 'inline-block', marginRight: '14px', marginBottom: '10px', textAlign: 'center' } });
          if (svg) box.appendChild(ui.h('div', { html: svg }));
          box.appendChild(ui.h('div', { class: 'hint' }, code));
          body.appendChild(box);
        }
        if (barcodes.length > 8) body.appendChild(ui.h('div', { class: 'hint' }, `and ${barcodes.length - 8} more`));
        body.appendChild(ui.h('div', { class: 'btn-row' },
          ui.h('button', { class: 'btn btn-sm', onClick: () => SR.barcode.printLabels([labelItem]) }, 'Print these as labels')));
        chips.appendChild(body);
        stockNodes.push(chips);
      }

      if (batches.length) {
        stockNodes.push(ui.dataCard({
          title: 'Batches at this branch',
          table: ui.renderTable({
            columns: [
              { key: 'batch_no', label: 'Batch', render: (b) => ui.h('span', { class: 'mono' }, b.batch_no || String(b.id).slice(0, 8)) },
              { key: 'received_at', label: 'Received', render: (b) => U.date(b.received_at) },
              { key: 'expiry_date', label: 'Expires', render: (b) => (b.expiry_date ? U.date(b.expiry_date) : '—') },
              { key: 'quantity', label: 'On hand', align: 'right', render: (b) => U.qty(b.quantity) },
              { key: 'cost_price_per_unit', label: 'Unit cost', align: 'right', render: (b) => U.money(b.cost_price_per_unit, { kobo: true }) },
              { key: 'selling_price', label: 'Selling', align: 'right', render: (b) => U.money(b.selling_price) },
              { key: 'status', label: '', render: (b) => ui.statusBadge(b.status) },
            ],
            rows: batches,
          }),
        }));
      }
      // ---- BRANCH PRICES. The engine has always honoured these; this is the
      // first screen that can create one.
      const overrides = data.priceOverrides || [];
      const priceCard = ui.h('div', { class: 'card' });
      priceCard.appendChild(ui.h('div', { class: 'card-head' },
        ui.h('h2', {}, 'Branch prices'),
        ui.h('div', { class: 'actions' },
          ui.h('button', {
            class: 'btn btn-sm btn-primary',
            onClick: () => branchPriceForm(p, units, null, load),
          }, 'Set a branch price'))));
      const priceBody = ui.h('div', { class: 'card-body' });
      priceBody.appendChild(ui.h('p', { class: 'hint' },
        price > 0 && !(Number(p.selling_price) > 0)
          ? `The shared list has no price. This shop sells it at ${U.money(price)} per ${String(p.base_unit_name || 'unit').toLowerCase()}, from the price typed when the goods were received.`
          : `The catalogue price is ${U.money(p.selling_price)} per ${String(p.base_unit_name || 'unit').toLowerCase()}, the same in every branch. A branch price here overrules it in that one shop — for a market that will not pay it, a shop carrying the delivery cost, or a wholesale counter that sells by the carton.`));
      if (!overrides.length) {
        priceBody.appendChild(ui.h('div', { class: 'hint' }, 'Every branch sells this at the catalogue price.'));
      } else {
        priceBody.appendChild(ui.renderTable({
          columns: [
            { key: 'branch_name', label: 'Branch' },
            { key: 'default_selling_price', label: 'Per unit', align: 'right', render: (o) => U.money(o.default_selling_price) },
            { key: 'pack_price', label: 'Pack', align: 'right', render: (o) => (o.pack_price == null ? '—' : U.money(o.pack_price)) },
            { key: 'carton_price', label: 'Carton', align: 'right', render: (o) => (o.carton_price == null ? '—' : U.money(o.carton_price)) },
            { key: 'vs_catalogue', label: 'Vs catalogue', align: 'right', render: (o) => {
              const diff = U.round2(Number(o.default_selling_price) - Number(p.selling_price));
              if (!diff) return ui.h('span', { class: 'hint' }, 'the same');
              return ui.h('span', { class: diff > 0 ? 'badge' : 'badge badge-warn' }, `${diff > 0 ? '+' : '−'}${U.money(Math.abs(diff))}`);
            } },
            { key: 'x', label: '', render: (o) => ui.h('button', {
              class: 'btn btn-sm',
              onClick: async (ev) => {
                const yes = await ui.confirmDialog({
                  title: 'Remove this branch price?',
                  message: `${p.name} would sell at the catalogue price of ${U.money(p.selling_price)} in ${o.branch_name} again.`,
                  confirmLabel: 'Remove it',
                  danger: true,
                });
                if (!yes) return;
                ev.currentTarget.disabled = true;
                ev.currentTarget.textContent = 'Removing…';
                try {
                  const result = await SR.api.del(`/api/products/${encodeURIComponent(p.id)}/price-override`, { query: { branch_id: o.branch_id } });
                  ui.ok(result.message || 'Removed.');
                  load();
                } catch (err) {
                  ev.currentTarget.disabled = false;
                  ev.currentTarget.textContent = 'Remove';
                  ui.error((err && err.message) || 'Could not remove it.');
                }
              },
            }, 'Remove') },
          ],
          rows: overrides,
        }));
      }
      priceCard.appendChild(priceBody);
      if (!stockNodes.length) {
        stockNodes.push(ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' },
          ui.h('h2', {}, 'Stock'),
          ui.h('p', { class: 'sub' }, 'No barcodes or batches are on file for this product at this branch.'))));
      }
      host.replaceChildren(ui.sectionTabs({
        head,
        remember: 'sr.productTab',
        sections: [
          { id: 'overview', label: 'Overview', nodes: overview },
          { id: 'stock', label: 'Stock', nodes: stockNodes },
          { id: 'prices', label: 'Prices', nodes: [priceCard] },
        ],
      }));
    }

    return wrap;
  }

  function serialSwitch(product, { stop = false, after = null } = {}) {
    if (!SR.state.moduleOn('serials')) return null;
    const on = Boolean(Number(product.requires_serial));
    return ui.h('button', {
      class: on ? 'btn btn-sm btn-primary' : 'btn btn-sm',
      type: 'button',
      title: on ? 'The till asks for a serial number' : 'Sold without a serial number',
      onClick: async (ev) => {
        if (stop) ev.stopPropagation();
        ev.currentTarget.disabled = true;
        try {
          await setSerial(product, !on);
          ui.toast(on ? `${product.name} is sold without a serial number.` : `${product.name} uses a serial number. The till will ask for one per unit.`);
          if (after) after();
        } catch (err) {
          ev.currentTarget.disabled = false;
          ui.apiError(err);
        }
      },
    }, on ? 'Serial on' : 'Serial off');
  }

  async function setSerial(product, on) {
    const next = on ? 1 : 0;
    await SR.api.put(`/api/products/${encodeURIComponent(product.id)}`, { requires_serial: next });
    if (next === 1 && !SR.state.usesSerialNumbers()) {
      if (SR.state.can('OWNER')) {
        await SR.api.put('/api/settings', { serial_tracking_enabled: 1 });
        await SR.state.load({ force: true }).catch(() => {});
      } else {
        ui.toast('Saved on this product. An owner turns serial numbers on in Settings before the till will ask.', { type: 'warn', ms: 7000 });
      }
    }
  }

  SR.views = SR.views || {};
  SR.views.products = { render, productForm };
}(window));
