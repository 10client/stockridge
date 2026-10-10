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
  const U = SR.util;

  const PAGE_SIZE = 50;

  async function render(ctx) {
    if (ctx.params.id) return renderDetail(ctx);
    ctx.setTitle('Catalogue');
    const state = { page: 0, pageSize: PAGE_SIZE, q: ctx.query.q || '', category: '', low: false };

    const wrap = ui.h('div', { class: 'stack' });
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Catalogue'),
        ui.h('p', { class: 'sub' }, 'Search your goods, or add from the Nigerian market. Serial stays off until you turn it on for that product.')),
      ui.h('div', { class: 'actions' },
        ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => openMarket() }, 'Nigerian market'),
        ui.h('button', { class: 'btn btn-sm', onClick: () => openCreate() }, 'Add a product'),
        ui.h('button', { class: 'btn btn-sm', onClick: () => exportList() }, 'Export'),
        ui.h('button', { class: 'btn btn-sm', onClick: () => labelSheet() }, 'Print labels'))));

    const toolbar = ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body row' }));
    const qInput = ui.h('input', { type: 'search', placeholder: 'Name, SKU, brand or model…', style: { minWidth: '210px' } });
    qInput.value = state.q;
    toolbar.firstElementChild.appendChild(ui.h('div', { class: 'grow' }, qInput));
    const catSel = ui.h('select', { onchange: (e) => { state.category = e.target.value; state.page = 0; load(); } });
    toolbar.firstElementChild.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Category'), catSel));
    wrap.appendChild(toolbar);

    const host = ui.h('div', {});
    wrap.appendChild(host);

    // Categories arrive with the list; load them once.
    (async () => {
      try {
        const data = await SR.api.get('/api/categories', { query: SR.state.query() });
        const rows = data.data || [];
        catSel.replaceChildren(ui.h('option', { value: '' }, 'All categories'));
        for (const c of rows) catSel.appendChild(ui.h('option', { value: String(c.id) }, `${c.name}${c.product_count ? ` (${c.product_count})` : ''}`));
      } catch (err) {
        const rows = await SR.store.all('product_categories', { where: (c) => !Number(c.is_deleted) });
        catSel.replaceChildren(ui.h('option', { value: '' }, 'All categories'));
        for (const c of rows) catSel.appendChild(ui.h('option', { value: String(c.id) }, c.name));
      }
    })();

    qInput.addEventListener('input', U.debounce(() => { state.q = qInput.value; state.page = 0; load(); }, 320));

    async function rowsFromMirror() {
      const needle = state.q.toLowerCase();
      let rows = await SR.store.all('products', { where: (p) => !Number(p.is_deleted) });
      const cats = await SR.store.all('product_categories').catch(() => []);
      const catName = new Map(cats.map((c) => [String(c.id), c.name]));
      if (state.category) rows = rows.filter((p) => String(p.category_id) === String(state.category));
      if (needle) rows = rows.filter((p) => `${p.name} ${p.sku || ''} ${p.brand || ''} ${p.model_no || ''}`.toLowerCase().includes(needle));
      const batches = await SR.store.all('stock_batches', { where: (b) => !Number(b.is_deleted) && String(b.branch_id) === String(SR.state.activeBranchId) });
      const onHand = new Map();
      for (const b of batches) {
        const k = String(b.product_id);
        onHand.set(k, (onHand.get(k) || 0) + Number(b.quantity || 0) - Number(b.quantity_reserved || 0));
      }
      return rows.sort((a, b) => String(a.name).localeCompare(String(b.name))).map((p) => Object.assign({}, p, {
        category_name: catName.get(String(p.category_id)) || null,
        on_hand: onHand.get(String(p.id)) || 0,
        margin_pct: Number(p.selling_price) > 0 ? U.round2(((Number(p.selling_price) - Number(p.cost_price)) / Number(p.selling_price)) * 100) : null,
      }));
    }

    async function load() {
      host.replaceChildren(ui.skeleton(6));
      let data; let offline = false;
      try {
        data = await SR.api.get('/api/products', {
          query: SR.state.query({ q: state.q || undefined, category_id: state.category || undefined, limit: state.pageSize, offset: state.page * state.pageSize }),
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
            cell.appendChild(ui.h('div', { class: 'hint' }, [p.sku, p.brand, p.model_no, p.category_name].filter(Boolean).join(' · ')));
            const tags = [];
            if (Number(p.tracks_variants)) tags.push('variants');
            cell.appendChild(serialSwitch(p, { stop: true, after: () => load() }));
            if (Number(p.requires_installation)) tags.push('installation');
            if (Number(p.has_expiry)) tags.push('expiry');
            if (Number(p.warranty_months)) tags.push(`${p.warranty_months}m warranty`);
            if (Number(p.is_bulky)) tags.push('bulky');
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
          { key: 'x', label: '', render: (p) => ui.h('button', { class: 'btn btn-sm', onClick: (ev) => { ev.stopPropagation(); SR.app.navigate(`/products/${p.id}`); } }, 'Open') },
        ],
        rows,
        onRowClick: (p) => SR.app.navigate(`/products/${p.id}`),
        emptyTitle: state.q ? 'Nothing matches that search' : 'The catalogue is empty',
        emptyMessage: state.q
          ? 'Try a different word, or clear the category filter.'
          : 'Add one yourself, or pick from the Nigerian market. Prices are not included — you set them.',
        emptyAction: state.q ? null : { label: 'Nigerian market', run: () => openMarket() },
      });

      host.replaceChildren();
      if (offline) host.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'Offline — showing the catalogue as this device last synced it.'));
      const total = paging.total != null ? paging.total : rows.length;
      host.appendChild(ui.dataCard({
        title: 'Products',
        table,
        pager: ui.pager({
          page: state.page, pageSize: paging.limit || state.pageSize, total,
          onPage: (p) => { state.page = p; load(); },
          onSize: (n) => { state.pageSize = n; state.page = 0; load(); },
        }),
      }));
    }

    async function exportList() {
      try {
        await SR.exporter.list({
          filename: 'catalogue',
          path: '/api/products',
          query: SR.state.query({ q: state.q || undefined }),
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
      SR.barcode.printLabels(rows.map((p) => ({
        name: p.name, sku: p.sku, price: p.selling_price, unit: p.base_unit_name, spec: p.model_no || p.brand,
      })), { title: 'StockRidge price labels' });
    }

    // ---------------- create ----------------
    function openCreate() {
      productForm(null).then((ok) => { if (ok) load(); });
    }

    loadList = load;
    await load();
    return wrap;
  }

  // -------------------------------------------------------------------
  // CREATE / EDIT FORM
  // -------------------------------------------------------------------
  async function productForm(product) {
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
    const base = product || {};
    const grid = ui.h('div', { class: 'form-grid' },
      ui.field({ label: 'Name', name: 'name', value: base.name || '', required: true, span: true, placeholder: 'e.g. Hisense 1.5HP Split Air Conditioner' }),
      ui.field({ label: 'Category', name: 'category_id', value: base.category_id || '', options: [{ value: '', label: '— none —' }].concat(categories.map((c) => ({ value: String(c.id), label: c.name }))) }),
      ui.field({ label: 'Brand', name: 'brand', value: base.brand || '' }),
      ui.field({ label: 'Model number', name: 'model_no', value: base.model_no || '' }),
      ui.field({ label: 'SKU', name: 'sku', value: base.sku || '', hint: 'Left blank, one is suggested from the name.' }),
      ui.field({ label: 'Base unit name', name: 'base_unit_name', value: base.base_unit_name || 'PIECE', hint: 'The smallest unit you would sell. Everything else is a multiple of it.' }),
      ui.field({ label: 'Cost price (₦)', name: 'cost_price', type: 'number', step: '0.01', min: '0', value: base.cost_price != null ? U.numInput(base.cost_price) : '' }),
      ui.field({ label: 'Selling price (₦)', name: 'selling_price', type: 'number', step: '0.01', min: '0', value: base.selling_price != null ? U.numInput(base.selling_price) : '', required: true }),
      ui.field({ label: 'Minimum margin %', name: 'min_margin_pct', type: 'number', step: '0.1', min: '0', value: base.min_margin_pct != null ? U.numInput(base.min_margin_pct) : '', hint: 'A header on the POS warns below this. It does not block the sale.' }),
      ui.field({ label: 'Reorder level', name: 'reorder_level', type: 'number', step: 'any', min: '0', value: base.reorder_level != null ? U.numInput(base.reorder_level) : '' }),
      ui.field({ label: 'Reorder quantity', name: 'reorder_quantity', type: 'number', step: 'any', min: '0', value: base.reorder_quantity != null ? U.numInput(base.reorder_quantity) : '' }),
      ui.field({ label: 'Warranty (months)', name: 'warranty_months', type: 'number', step: '1', min: '0', value: base.warranty_months != null ? U.numInput(base.warranty_months) : '' }),
      ui.field({
        label: 'Warranty type', name: 'warranty_type', value: base.warranty_type || '',
        options: [{ value: '', label: '— none —' }, { value: 'MANUFACTURER', label: 'Manufacturer' }, { value: 'SELLER', label: 'Seller' }, { value: 'EXTENDED', label: 'Extended' }, { value: 'NONE', label: 'No warranty' }],
      }),
      ui.field({ label: 'Registration number', name: 'registration_no', span: true, hint: 'SONCAP, NAFDAC or MANCAP number. Advisory — recorded, never a blocked sale.' }));
    wrapEl.appendChild(grid);

    const serialOn = editing ? Boolean(Number(base.requires_serial)) : false;
    const serialBox = ui.h('fieldset');
    serialBox.appendChild(ui.h('legend', {}, 'Serial number'));
    serialBox.appendChild(ui.h('p', { class: 'hint' }, 'Off, this product is sold without a number. On, the till asks for one number per unit, from this catalogue through to the receipt.'));
    serialBox.appendChild(ui.h('label', { class: 'check' },
      ui.h('input', { type: 'checkbox', name: 'requires_serial', checked: serialOn }),
      ui.h('strong', {}, 'Use a serial number on this product')));
    wrapEl.appendChild(serialBox);

    const flags = ui.h('fieldset');
    flags.appendChild(ui.h('legend', {}, 'Behaviour'));
    const flagList = [
      ['tracks_variants', 'Has variants', 'The same product in several sizes, colours or capacities.'],
      ['has_expiry', 'Has an expiry date', 'Batches carry an expiry and the system will refuse to receive already-expired stock.'],
      ['requires_installation', 'Needs installation', 'Selling it creates an installation job for a technician.'],
      ['is_bulky', 'Bulky item', 'Affects delivery planning.'],
      ['is_fragile', 'Fragile', 'Warns at goods-out.'],
      ['is_returnable', 'Returnable', 'A customer may return it inside the window.'],
      ['is_active', 'Active', 'Turn off to hide it from the POS without deleting its history.'],
    ];
    for (const [name, label, hint] of flagList) {
      const row = ui.h('label', { class: 'check', style: { marginBottom: '8px', alignItems: 'flex-start' } },
        ui.h('input', { type: 'checkbox', name, checked: editing ? Boolean(Number(base[name])) : (name === 'is_active' ? true : false) }),
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

    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (settled) return; settled = true; resolve(v); m.close(); };
      const m = ui.openModal({
        title: editing ? `Edit ${base.name}` : 'Add a product',
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
              if (!(Number(v.selling_price) >= 0)) { ui.warn('Enter a selling price.'); return; }
              const flagValues = {};
              for (const el of flags.querySelectorAll('input[type="checkbox"]')) flagValues[el.name] = el.checked ? 1 : 0;
              const serialEl = wrapEl.querySelector('input[name="requires_serial"]');
              flagValues.requires_serial = serialEl && serialEl.checked ? 1 : 0;
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
                cost_price: v.cost_price === null ? 0 : Number(v.cost_price),
                selling_price: Number(v.selling_price),
                min_margin_pct: v.min_margin_pct === null ? null : Number(v.min_margin_pct),
                reorder_level: v.reorder_level === null ? 0 : Number(v.reorder_level),
                reorder_quantity: v.reorder_quantity === null ? null : Number(v.reorder_quantity),
                warranty_months: v.warranty_months === null ? null : Number(v.warranty_months),
                warranty_type: v.warranty_type || null,
                units: ladder.map((l, i) => ({
                  code: l.code || (i === 0 ? 'PIECE' : `UNIT_${i}`),
                  name: l.name || l.code || `Unit ${i + 1}`,
                  quantity_in_base: i === 0 ? 1 : Number(l.quantity_in_base),
                  is_base: i === 0,
                  unit_price: i === 0 ? Number(v.selling_price) : (l.unit_price != null ? l.unit_price : null),
                })),
              }, flagValues);
              ev.currentTarget.disabled = true;
              ev.currentTarget.textContent = 'Saving…';
              try {
                const result = editing
                  ? await SR.api.put(`/api/products/${encodeURIComponent(product.id)}`, payload)
                  : await SR.api.post('/api/products', payload);
                if (result && result.barcodeWarning) ui.warn(result.barcodeWarning);
                if (flagValues.requires_serial === 1 && !SR.state.usesSerialNumbers() && SR.state.can('OWNER')) {
                  await SR.api.put('/api/settings', { serial_tracking_enabled: 1 });
                  await SR.state.load({ force: true }).catch(() => {});
                }
                ui.ok(editing ? 'Product updated.' : `${v.name} added to the catalogue.`);
                finish(true);
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
        data = { product: p, units: await SR.store.all('product_units', { where: (u) => String(u.product_id) === String(p.id) }), variants: [], batches: [], barcodes: [] };
      }
      const p = data.product || data;
      const units = data.units || p.units || [];
      const variants = data.variants || [];
      const batches = data.batches || [];
      const barcodes = data.barcodes || [];

      host.appendChild(ui.h('div', { class: 'page-head' },
        ui.h('div', {},
          ui.h('h1', {}, p.name),
          ui.h('p', { class: 'sub' }, [p.sku, p.brand, p.model_no, data.category ? data.category.name : p.category_name].filter(Boolean).join(' · '))),
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
          ui.h('button', { class: 'btn btn-sm', onClick: () => SR.barcode.previewLabel({ name: p.name, sku: p.sku, price: p.selling_price, unit: p.base_unit_name, spec: p.model_no }) }, 'Label'))));

      if (offline) host.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'Offline — from this device\'s last sync.'));

      host.appendChild(ui.h('div', { class: 'grid grid-4' },
        ui.kpi({ label: 'Selling price', value: Number(p.selling_price) > 0 ? U.money(p.selling_price) : 'No price', small: true }),
        ui.kpi({ label: 'Cost', value: U.money(p.cost_price), small: true }),
        ui.kpi({
          label: 'Margin',
          value: U.pct(Number(p.selling_price) > 0 ? U.round2(((Number(p.selling_price) - Number(p.cost_price)) / Number(p.selling_price)) * 100) : 0),
          tone: Number(p.min_margin_pct) && ((Number(p.selling_price) - Number(p.cost_price)) / Number(p.selling_price)) * 100 < Number(p.min_margin_pct) ? 'bad' : 'good',
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
            { key: 'unit_price', label: 'Price', align: 'right', render: (u) => U.money(u.unit_price != null ? u.unit_price : (Number(u.quantity_in_base) * Number(p.selling_price))) },
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
          ['Warranty', Number(p.warranty_months) ? `${p.warranty_months} months (${U.humanise(p.warranty_type || 'manufacturer')})` : 'none'],
          ['Return window', Number(p.return_window_days) ? `${p.return_window_days} days` : null],
          ['Serial number', Number(p.requires_serial) ? 'On — the till asks for one number per unit' : 'Off'],
          ['Variants', Number(p.tracks_variants) ? 'yes' : 'no'],
          ['Expiry tracked', Number(p.has_expiry) ? 'yes' : 'no'],
          ['Needs installation', Number(p.requires_installation) ? 'yes' : 'no'],
          ['Active', Number(p.is_active) ? 'yes' : 'NO — hidden from the POS'],
        ]),
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
      host.appendChild(cols);

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
          ui.h('button', { class: 'btn btn-sm', onClick: () => SR.barcode.printLabels([{ name: p.name, sku: p.sku, price: p.selling_price, unit: p.base_unit_name }]) }, 'Print these as labels')));
        chips.appendChild(body);
        host.appendChild(chips);
      }

      if (batches.length) {
        host.appendChild(ui.dataCard({
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
        `The catalogue price is ${U.money(p.selling_price)} per ${String(p.base_unit_name || 'unit').toLowerCase()}, the same in every branch. A branch price here overrules it in that one shop — for a market that will not pay it, a shop carrying the delivery cost, or a wholesale counter that sells by the carton.`));
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
      host.appendChild(priceCard);
    }

    return wrap;
  }

  function serialSwitch(product, { stop = false, after = null } = {}) {
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

  function openMarket() {
    const state = { q: '', category: '', page: 0, pageSize: 40, serials: new Set() };
    const wrap = ui.h('div', { class: 'stack' });
    wrap.appendChild(ui.h('p', { class: 'hint' }, 'Goods sold in Nigerian markets. No prices — set the price after you add the item. Serial stays off unless you turn it on here.'));
    const bar = ui.h('div', { class: 'row' });
    const q = ui.h('input', { type: 'search', placeholder: 'Rice, cement, Indomie, phone…', style: { minWidth: '220px' } });
    const cat = ui.h('select');
    bar.appendChild(ui.h('div', { class: 'grow' }, q));
    bar.appendChild(cat);
    wrap.appendChild(bar);
    const host = ui.h('div', {});
    wrap.appendChild(host);
    const foot = ui.h('div', { class: 'row' });
    wrap.appendChild(foot);

    async function load() {
      host.replaceChildren(ui.skeleton(5));
      try {
        const data = await SR.api.get('/api/market-catalogue', {
          query: { q: state.q || undefined, category: state.category || undefined, limit: state.pageSize, offset: state.page * state.pageSize },
        });
        const cats = data.categories || [];
        const current = state.category;
        cat.replaceChildren(ui.h('option', { value: '' }, `All (${data.count || ''})`));
        for (const c of cats) cat.appendChild(ui.h('option', { value: c.code }, `${c.name} (${c.count})`));
        cat.value = current;
        const rows = data.data || [];
        const list = ui.h('div', { class: 'stack' });
        if (!rows.length) list.appendChild(ui.h('p', { class: 'hint' }, 'Nothing matches. Try a shorter word, such as rice, fan or cement.'));
        for (const item of rows) {
          const serialOn = state.serials.has(item.sku);
          const row = ui.h('div', { class: 'row', style: { alignItems: 'center', gap: '8px', padding: '8px 0', borderBottom: '1px solid var(--line)' } });
          row.appendChild(ui.h('div', { class: 'grow' },
            ui.h('div', { style: { fontWeight: '600' } }, item.name),
            ui.h('div', { class: 'hint' }, [item.brand, item.categoryName, item.unitName, 'No price'].filter(Boolean).join(' · '))));
          row.appendChild(ui.h('button', {
            class: serialOn ? 'btn btn-sm btn-primary' : 'btn btn-sm',
            type: 'button',
            onClick: () => {
              if (state.serials.has(item.sku)) state.serials.delete(item.sku);
              else state.serials.add(item.sku);
              load();
            },
          }, serialOn ? 'Serial on' : 'Serial off'));
          row.appendChild(ui.h('button', {
            class: 'btn btn-sm btn-primary',
            type: 'button',
            onClick: () => adopt([item]),
          }, 'Add'));
          list.appendChild(row);
        }
        host.replaceChildren(list);
        const total = (data.paging && data.paging.total) || 0;
        foot.replaceChildren(ui.pager({
          page: state.page, pageSize: state.pageSize, total,
          onPage: (n) => { state.page = n; load(); },
        }));
      } catch (err) {
        host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: load } }));
      }
    }

    async function adopt(items) {
      try {
        const result = await SR.api.post('/api/market-catalogue/adopt', {
          business_id: SR.state.activeBusinessId,
          items: items.map((item) => ({ sku: item.sku, serial: state.serials.has(item.sku) })),
        });
        const turnedOn = items.some((item) => state.serials.has(item.sku));
        if (turnedOn && !SR.state.usesSerialNumbers() && SR.state.can('OWNER')) {
          await SR.api.put('/api/settings', { serial_tracking_enabled: 1 });
          await SR.state.load({ force: true }).catch(() => {});
        }
        ui.toast(result.message || 'Added.');
        if (typeof loadList === 'function') loadList();
      } catch (err) { ui.apiError(err); }
    }

    q.addEventListener('input', U.debounce(() => { state.q = q.value; state.page = 0; load(); }, 280));
    cat.addEventListener('change', () => { if (cat.value === state.category) return; state.category = cat.value; state.page = 0; load(); });
    ui.openModal({ title: 'Nigerian market', body: wrap, size: 'wide' });
    load();
  }

  let loadList = null;

  SR.views = SR.views || {};
  SR.views.products = { render, productForm };
}(window));
