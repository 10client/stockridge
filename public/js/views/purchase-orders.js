'use strict';
// =====================================================================
// public/js/views/purchase-orders.js — ORDERING, AND TAKING DELIVERY
// =====================================================================
// A purchase order does two jobs:
//
//   before delivery — it says what was agreed, at what cost, expected when.
//   at delivery     — receiving against it is the ONLY place in the whole system
//                     where new stock enters with a real cost attached. The
//                     landed cost recorded at this moment becomes the cost of
//                     every unit in the batch, and therefore the cost of goods
//                     sold when it leaves, and therefore the profit reported.
//
// Because of that, receiving is deliberately a step-by-step wizard rather than a
// one-tap "receive all": the person at the gate is asked what actually arrived,
// at what freight, and whether the supplier over-delivered. Over-delivery is a
// decision, not an accident — accepting it means paying for more than was
// budgeted, so it has to be ticked explicitly on that line.
// =====================================================================
(function (global) {
  const SR = global.SR;
  const ui = SR.ui;
  const U = SR.util;

  const STATUS_TABS = [
    ['', 'All'], ['DRAFT', 'Draft'], ['PENDING', 'Pending'],
    ['PARTIALLY_RECEIVED', 'Part received'], ['RECEIVED', 'Received'], ['CANCELLED', 'Cancelled'],
  ];

  async function render(ctx) {
    if (ctx.params.id) return renderDetail(ctx);
    ctx.setTitle('Purchase orders');
    const state = { status: ctx.query.status || '', page: 0, pageSize: 50 };

    const wrap = ui.h('div', { class: 'stack' });
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Purchase orders'),
        ui.h('p', { class: 'sub' }, `${SR.state.activeBranchName()} · what has been ordered from suppliers, and what has landed`)),
      ui.h('div', { class: 'actions' },
        SR.state.atLeast('MANAGER') ? ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => openCreate() }, 'Raise an order') : null,
        ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate('/suppliers') }, 'Suppliers'),
        ui.h('button', { class: 'btn btn-sm', onClick: () => exportList() }, 'Export'))));

    const tabs = ui.h('div', { class: 'tabs' });
    for (const [key, label] of STATUS_TABS) {
      tabs.appendChild(ui.h('button', {
        class: `tab ${state.status === key ? 'is-active' : ''}`,
        onClick: () => {
          state.status = key; state.page = 0;
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
          filename: 'purchase-orders',
          path: '/api/purchase-orders',
          query: SR.state.query({ status: state.status || undefined, days: 180 }),
          mirrorTable: 'purchase_orders',
          columns: [
            { key: 'po_number', label: 'PO' }, { key: 'supplier_name', label: 'Supplier' },
            { key: 'branch_name', label: 'Branch' }, { key: 'ordered_at', label: 'Raised' },
            { key: 'expected_date', label: 'Expected' }, { key: 'status', label: 'Status' },
            { key: 'subtotal', label: 'Subtotal' }, { key: 'vat_total', label: 'VAT' },
            { key: 'wht_amount', label: 'WHT' }, { key: 'total', label: 'Total' },
            { key: 'units_ordered', label: 'Units ordered' }, { key: 'units_received', label: 'Units received' },
          ],
        });
      } catch (err) { ui.apiError(err); }
    }

    async function load() {
      host.replaceChildren(ui.skeleton(6));
      summaryHost.replaceChildren();
      let data; let offline = false;
      try {
        data = await SR.api.get('/api/purchase-orders', {
          query: SR.state.query({ status: state.status || undefined, days: 180, limit: state.pageSize, offset: state.page * state.pageSize }),
        });
      } catch (err) {
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: load } })); return; }
        offline = true;
        let rows = await SR.store.all('purchase_orders', { where: (p) => !Number(p.is_deleted) });
        if (state.status) rows = rows.filter((p) => String(p.status).toUpperCase() === state.status);
        data = { data: rows, paging: { total: rows.length, limit: rows.length, offset: 0 } };
      }
      const rows = data.data || [];
      const paging = data.paging || {};
      const products = await SR.store.all('products', { where: (p) => !Number(p.is_deleted) }).catch(() => []);
      const byId = new Map(products.map((p) => [String(p.id), p]));

      const open = rows.filter((r) => r.status !== 'RECEIVED' && r.status !== 'CANCELLED');
      const late = open.filter((r) => r.overdue || (r.expected_date && r.expected_date < U.todayWat()));
      const value = U.sum(open, (r) => Number(r.total) - Number(r.total_received_cost || 0));

      summaryHost.appendChild(ui.h('div', { class: 'grid grid-4' },
        ui.kpi({ label: 'Outstanding orders', value: String(open.length), foot: U.money(value) + ' still to arrive', small: true }),
        ui.kpi({ label: 'Late', value: String(late.length), tone: late.length ? 'bad' : 'good', foot: late.length ? 'chase these first' : 'nothing overdue', small: true }),
        ui.kpi({ label: 'Received this period', value: String(rows.filter((r) => r.status === 'RECEIVED').length), tone: 'good', small: true }),
        ui.kpi({ label: 'Units on order', value: U.qty(U.sum(open, (r) => r.outstanding_units)), small: true })));

      const table = ui.renderTable({
        columns: [
          { key: 'po_number', label: 'PO', render: (r) => ui.h('span', { class: 'mono' }, r.po_number) },
          { key: 'supplier_name', label: 'Supplier', className: 'wrap', render: (r) => {
            const cell = ui.h('div', {});
            cell.appendChild(ui.h('div', { style: { fontWeight: '600' } }, r.supplier_name || '—'));
            cell.appendChild(ui.h('div', { class: 'hint' }, [r.branch_name, `${r.item_count || 0} line${Number(r.item_count) === 1 ? '' : 's'}`].filter(Boolean).join(' · ')));
            return cell;
          } },
          { key: 'expected_date', label: 'Expected', render: (r) => {
            if (!r.expected_date) return '—';
            const isLate = r.status !== 'RECEIVED' && r.status !== 'CANCELLED' && r.expected_date < U.todayWat();
            return isLate ? ui.badge(`${U.date(r.expected_date)} · late`, 'badge-bad') : U.date(r.expected_date);
          } },
          { key: 'progress', label: 'Received', align: 'right', render: (r) => {
            const ordered = Number(r.units_ordered) || 0;
            const got = Number(r.units_received) || 0;
            if (!ordered) return '—';
            const pct = U.clamp((got / ordered) * 100, 0, 100);
            const bar = ui.h('div', { style: { width: '70px', height: '8px', borderRadius: '4px', background: 'var(--slate-200)', display: 'inline-block', verticalAlign: 'middle', marginRight: '6px' } },
              ui.h('div', { style: { width: `${pct}%`, height: '100%', borderRadius: '4px', background: got >= ordered ? 'var(--green-600)' : 'var(--teal-600)' } }));
            return ui.h('span', {}, bar, ui.h('span', { class: 'hint' }, `${U.qty(got)}/${U.qty(ordered)}`));
          } },
          { key: 'subtotal', label: 'Subtotal', align: 'right', render: (r) => U.money(r.subtotal) },
          { key: 'total', label: 'Total', align: 'right', render: (r) => ui.h('strong', {}, U.money(r.total)) },
          { key: 'status', label: '', render: (r) => ui.statusBadge(r.status) },
          { key: 'x', label: '', render: (r) => ui.h('div', { class: 'btn-row' },
            (r.status !== 'RECEIVED' && r.status !== 'CANCELLED' && SR.state.atLeast('MANAGER'))
              ? ui.h('button', { class: 'btn btn-sm btn-primary', onClick: (ev) => { ev.stopPropagation(); SR.app.navigate(`/purchase-orders/${r.id}`); } }, 'Receive')
              : null,
            ui.h('button', { class: 'btn btn-sm', onClick: (ev) => { ev.stopPropagation(); SR.app.navigate(`/purchase-orders/${r.id}`); } }, 'Open')) },
        ],
        rows,
        onRowClick: (r) => SR.app.navigate(`/purchase-orders/${r.id}`),
        emptyTitle: state.status ? 'Nothing in that state' : 'No purchase orders yet',
        emptyMessage: state.status
          ? 'Try the All tab. Orders older than 180 days are outside this range.'
          : 'Raise an order before goods arrive so the cost is agreed in advance and the delivery can be checked against it.',
        emptyAction: SR.state.atLeast('MANAGER') ? { label: 'Raise an order', run: () => openCreate() } : null,
      });

      host.replaceChildren();
      if (offline) host.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'Offline — from this device\'s last sync. Raising or receiving an order needs a connection: it moves money and stock.'));
      host.appendChild(ui.dataCard({
        title: 'Orders',
        table,
        pager: ui.pager({
          page: state.page, pageSize: paging.limit || state.pageSize, total: paging.total != null ? paging.total : rows.length,
          onPage: (p) => { state.page = p; load(); },
          onSize: (n) => { state.pageSize = n; state.page = 0; load(); },
        }),
      }));
      void byId;
    }

    // ---------------- CREATE ----------------
    function openCreate() {
      const lines = [];
      const wrapEl = ui.h('div', {});
      const head = ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Supplier', name: 'supplier_id', required: true, placeholder: 'Pick a supplier…' }),
        ui.field({ label: 'Expected date', name: 'expected_date', type: 'date' }),
        ui.field({ label: 'Freight / haulage total (₦)', name: 'freight_total', type: 'number', step: '0.01', min: '0', value: '0', hint: 'Spread across the lines at receiving time, so it lands in the cost of the goods.' }),
        ui.field({ label: 'Discount total (₦)', name: 'discount_total', type: 'number', step: '0.01', min: '0' }),
        ui.field({
          label: 'Withholding on this order', name: 'wht_code', value: 'SUPPLY_OF_GOODS',
          options: [
            { value: 'SUPPLY_OF_GOODS', label: '2% — supply of goods' },
            { value: 'SERVICES', label: '5% — services' },
            { value: '', label: 'None' },
          ],
          hint: 'Recorded on the order so the eventual payment already knows what to withhold. A manufacturer is exempt — the server corrects this once a supplier is chosen.',
        }),
        ui.field({ label: 'Notes', name: 'notes', type: 'textarea', span: true }));
      wrapEl.appendChild(head);

      const supplierInput = wrapEl.querySelector('[name="supplier_id"]');
      const list = ui.h('div', { class: 'pos-results', hidden: true });
      supplierInput.parentElement.appendChild(list);
      let pickedSupplier = null;
      supplierInput.addEventListener('input', U.debounce(async () => {
        const term = supplierInput.value.trim();
        pickedSupplier = null;
        if (term.length < 2) { list.hidden = true; return; }
        let rows = [];
        try {
          const d = await SR.api.get('/api/suppliers', { query: SR.state.query({ q: term, limit: 10 }) });
          rows = d.data || [];
        } catch (err) {
          rows = (await SR.store.all('suppliers', { where: (s) => !Number(s.is_deleted) }))
            .filter((s) => String(s.name).toLowerCase().includes(term.toLowerCase())).slice(0, 10);
        }
        list.replaceChildren();
        for (const s of rows) {
          list.appendChild(ui.h('button', {
            class: 'pos-hit', type: 'button',
            onClick: () => {
              pickedSupplier = s;
              supplierInput.value = s.name;
              const whtSel = wrapEl.querySelector('[name="wht_code"]');
              if (whtSel && Number(s.is_manufacturer)) whtSel.value = '';
              let hint = wrapEl.querySelector('.supplier-hint');
              if (!hint) { hint = ui.h('div', { class: 'hint supplier-hint' }); supplierInput.parentElement.appendChild(hint); }
              hint.textContent = Number(s.is_manufacturer)
                ? `${s.name} is a manufacturer — exempt from the 2% supply-of-goods withholding, so it has been set to None.`
                : (s.tin ? `TIN ${s.tin} on file.` : `${s.name} has no TIN recorded, so withholding on payment cannot be credited to them.`);
              list.hidden = true;
            },
          }, ui.h('div', { class: 'grow' }, ui.h('div', { class: 'ph-name' }, s.name),
            ui.h('div', { class: 'ph-meta' }, [s.phone, s.tin ? `TIN ${s.tin}` : 'no TIN'].filter(Boolean).join(' · ')))));
        }
        list.hidden = !rows.length;
      }, 260));

      // ---- lines
      // A LINE IS ON THE ORDER ONLY WHEN A CATALOGUE PRODUCT HAS BEEN PICKED.
      //
      // The line used to be a text box labelled "Product…". Typing a name and a price filled the
      // box and moved the total, and Raise then said "Add at least one item with a quantity" —
      // the order is built from product_id, and a typed name never set one. The line the person
      // added did not reflect in the order they were raising. The picker below IS the line: the
      // count on the button says how many products are actually on the order, a typed name that
      // was never picked is named in the refusal, and it is never dropped in silence.
      let raiseBtn = null;
      const linesCard = ui.h('div', { class: 'card' });
      linesCard.appendChild(ui.h('div', { class: 'card-head' }, ui.h('h2', {}, 'Lines'), ui.h('div', { class: 'spacer' })));
      const linesBody = ui.h('div', { class: 'card-body stack' });
      linesCard.appendChild(linesBody);
      wrapEl.appendChild(linesCard);
      wrapEl.appendChild(ui.h('div', { class: 'hint' }, 'Pick the product from the list under its name. A typed name and a price are not on the order until you do. Quantities are converted to the product\'s base unit when the order is saved.'));

      const totalsBar = ui.h('div', { class: 'alert alert-info' }, 'No lines yet.');

      function onOrder(line) { return Boolean(line.product_id) && Number(line.quantity) > 0; }
      function dangling(line) { return !line.product_id && (String(line.name || '').trim() || Number(line.expected_unit_cost) > 0); }

      async function findProducts(term) {
        try {
          const d = await SR.api.get('/api/products', { query: SR.state.query({ q: term, limit: 8 }) });
          return d.data || [];
        } catch (err) {
          if (!err.isOffline) throw err;
          return (await SR.store.all('products', { where: (p) => !Number(p.is_deleted) }))
            .filter((p) => String(p.name).toLowerCase().includes(term.toLowerCase()) || String(p.sku || '').toLowerCase().includes(term.toLowerCase()))
            .slice(0, 8);
        }
      }
      function adopt(line, product) {
        line.product_id = String(product.id);
        line.name = product.name;
        line.pickedName = product.name;
        line.sku = product.sku || '';
        line.unit_code = product.default_unit_code || line.unit_code || 'PIECE';
        if (!Number(line.expected_unit_cost)) line.expected_unit_cost = Number(product.cost_price) || 0;
        if (!Number(line.quantity)) line.quantity = 1;
      }
      function paintStatus() {
        const ready = lines.filter(onOrder).length;
        if (raiseBtn && !raiseBtn.disabled) {
          raiseBtn.textContent = ready ? `Raise the order · ${ready} line${ready === 1 ? '' : 's'}` : 'Raise the order';
        }
      }
      function paintLines() {
        linesBody.replaceChildren();
        lines.forEach((line, i) => {
          const card = ui.h('div', { class: line.product_id ? 'po-line on-order' : 'po-line' });
          card.appendChild(ui.h('div', { class: 'row' },
            ui.h('strong', {}, `Item ${i + 1}`),
            line.product_id ? ui.badge('On this order', 'badge-good') : ui.badge('Not chosen yet', 'badge-warn'),
            ui.h('span', { class: 'spacer' }),
            ui.h('button', { class: 'btn btn-sm', type: 'button', onClick: () => { lines.splice(i, 1); paintLines(); } }, 'Remove')));

          const search = ui.h('input', {
            type: 'search',
            placeholder: 'Type a product name, SKU or barcode, then pick it from the list…',
            value: line.name || '',
            dataset: line.product_id ? {} : { unlinked: '1' },
          });
          search.setAttribute('data-line-search', '1');
          const results = ui.h('div', { class: 'pos-results', hidden: true });
          const hint = ui.h('div', { class: 'hint' }, line.product_id
            ? `On this order: ${line.name}${line.sku ? ` · ${line.sku}` : ''} at ${U.money(line.expected_unit_cost)} each.`
            : (String(line.name || '').trim()
              ? `"${line.name}" is not on the order yet — pick it from the list. A typed name is not ordered.`
              : 'Nothing is ordered on this line until you pick a product.'));
          card.appendChild(search);
          card.appendChild(results);
          card.appendChild(hint);

          search.addEventListener('input', U.debounce(async () => {
            const term = search.value.trim();
            line.name = search.value;
            if (line.product_id && term !== line.pickedName) {
              line.product_id = '';
              card.classList.remove('on-order');
              hint.textContent = term
                ? `"${term}" is not on the order yet — pick it from the list. A typed name is not ordered.`
                : 'Nothing is ordered on this line until you pick a product.';
              search.dataset.unlinked = '1';
              paintTotals();
            }
            if (term.length < 2) { results.hidden = true; results.replaceChildren(); return; }
            let rows = [];
            try { rows = await findProducts(term); }
            catch (err) { results.hidden = false; results.replaceChildren(ui.h('div', { class: 'hint' }, (err && err.message) || 'The catalogue could not be searched.')); return; }
            results.replaceChildren();
            if (!rows.length) {
              results.hidden = false;
              results.appendChild(ui.h('div', { class: 'hint' }, `Nothing in this business's catalogue matches "${term}". A name that is not in the catalogue cannot be ordered.`));
              return;
            }
            for (const product of rows) {
              results.appendChild(ui.h('button', {
                class: 'pos-hit', type: 'button',
                onClick: () => { adopt(line, product); paintLines(); const drawn = linesBody.children[i]; if (drawn && drawn.scrollIntoView) drawn.scrollIntoView({ block: 'nearest' }); },
              }, ui.h('div', { class: 'grow' },
                ui.h('div', { class: 'ph-name' }, product.name),
                ui.h('div', { class: 'ph-meta' }, [product.sku, product.base_unit_name].filter(Boolean).join(' · '))),
              ui.h('span', { class: 'ph-price' }, U.money(product.cost_price))));
            }
            results.hidden = false;
          }, 260));

          const lineTotal = ui.h('strong', {}, U.money((Number(line.quantity) || 0) * (Number(line.expected_unit_cost) || 0)));
          const showLine = () => { lineTotal.textContent = U.money((Number(line.quantity) || 0) * (Number(line.expected_unit_cost) || 0)); };
          const qty = ui.h('input', { type: 'number', step: 'any', min: '0', value: String(line.quantity || ''), style: { width: '90px' } });
          qty.addEventListener('input', () => { line.quantity = Number(qty.value) || 0; showLine(); paintTotals(); });
          const unit = ui.h('input', { value: line.unit_code || 'PIECE', style: { width: '110px' } });
          unit.addEventListener('input', () => { line.unit_code = unit.value.toUpperCase(); });
          const cost = ui.h('input', { type: 'number', step: '0.01', min: '0', value: U.numInput(line.expected_unit_cost), style: { width: '130px' } });
          cost.addEventListener('input', () => { line.expected_unit_cost = Number(cost.value) || 0; showLine(); paintTotals(); });
          card.appendChild(ui.h('div', { class: 'form-grid' },
            ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Qty'), qty),
            ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Unit'), unit),
            ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Unit cost ₦'), cost),
            ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Line'), lineTotal)));
          linesBody.appendChild(card);
        });
        if (!lines.length) linesBody.appendChild(ui.h('p', { class: 'hint' }, 'No lines yet. Add the products you are ordering.'));
        linesBody.appendChild(ui.h('button', {
          class: 'btn btn-sm', type: 'button',
          onClick: () => {
            lines.push({ product_id: '', name: '', pickedName: '', quantity: 1, unit_code: 'PIECE', expected_unit_cost: 0 });
            paintLines();
            const boxes = linesBody.querySelectorAll('[data-line-search]');
            const last = boxes[boxes.length - 1];
            if (last) last.focus();
          },
        }, 'Add a line'));
        paintTotals();
      }
      function paintTotals() {
        const linked = lines.filter((l) => l.product_id);
        const unnamed = lines.filter(dangling);
        const subtotal = U.sum(linked, (l) => (Number(l.quantity) || 0) * (Number(l.expected_unit_cost) || 0));
        const freight = Number((wrapEl.querySelector('[name="freight_total"]') || {}).value) || 0;
        const discount = Number((wrapEl.querySelector('[name="discount_total"]') || {}).value) || 0;
        const vat = (SR.state.settings && Number(SR.state.settings.vat_enabled)) ? U.round2((subtotal - discount) * (Number(SR.state.settings.vat_rate_percent) || 7.5) / 100) : 0;
        const ready = lines.filter(onOrder).length;
        totalsBar.replaceChildren();
        totalsBar.appendChild(ui.kv([
          ['On this order', ready ? `${ready} line${ready === 1 ? '' : 's'}` : 'nothing yet'],
          ['Subtotal', U.money(subtotal)],
          ['Freight', U.money(freight)],
          ['Discount', discount ? `−${U.money(discount)}` : null],
          ['VAT (reclaimable)', vat ? U.money(vat) : 'not applied — set a supplier TIN to record input VAT'],
          ['Order total', ui.h('strong', {}, U.money(U.round2(subtotal - discount + freight + vat)))],
        ]));
        if (unnamed.length) {
          totalsBar.appendChild(ui.h('div', { class: 'hint' }, unnamed.length === 1
            ? 'One line has a name or a price but no product chosen, so it is not in this total and will not be ordered.'
            : `${unnamed.length} lines have a name or a price but no product chosen, so they are not in this total and will not be ordered.`));
        }
        paintStatus();
      }
      for (const name of ['freight_total', 'discount_total']) {
        const el = wrapEl.querySelector(`[name="${name}"]`);
        if (el) el.addEventListener('input', paintTotals);
      }
      wrapEl.appendChild(totalsBar);
      lines.push({ product_id: '', name: '', pickedName: '', quantity: 1, unit_code: 'PIECE', expected_unit_cost: 0 });
      paintLines();

      const m = ui.openModal({
        title: 'Raise a purchase order',
        body: wrapEl,
        size: 'full',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
          (raiseBtn = ui.h('button', {
            class: 'btn btn-primary',
            onClick: async (ev) => {
              const v = ui.readFormStrings(wrapEl);
              const supplierId = pickedSupplier ? pickedSupplier.id : null;
              if (!supplierId) { ui.warn('Pick a supplier from the list — the order needs somebody to send it to.'); return; }
              const ready = lines.filter((l) => l.product_id && Number(l.quantity) > 0);
              const unnamed = lines.filter((l) => !l.product_id && (String(l.name || '').trim() || Number(l.expected_unit_cost) > 0));
              if (unnamed.length) {
                const first = unnamed[0];
                ui.warn(first.name
                  ? `"${String(first.name).trim()}" has a name or a price, but it is not a catalogue product you picked. Pick it from the list — a typed name is not ordered, so it cannot be raised.`
                  : 'A line has a price but no product chosen. Pick the product from the list — a price on its own is not an order.');
                const box = wrapEl.querySelector('[data-unlinked="1"]');
                if (box) box.focus();
                return;
              }
              if (!ready.length) {
                const chosen = lines.filter((l) => l.product_id);
                ui.warn(chosen.length
                  ? `${chosen[0].name} is chosen, but the quantity is empty. Set how many you are ordering.`
                  : 'Add at least one product. Type its name, pick it from the list, then set the quantity and the price.');
                return;
              }
              const items = ready;
              ev.currentTarget.disabled = true;
              ev.currentTarget.textContent = 'Saving…';
              try {
                const result = await SR.api.post('/api/purchase-orders', {
                  branch_id: SR.state.activeBranchId,
                  business_id: SR.state.activeBusinessId,
                  supplier_id: String(supplierId),
                  expected_date: v.expected_date || null,
                  freight_total: Number(v.freight_total) || 0,
                  discount_total: Number(v.discount_total) || 0,
                  wht_code: v.wht_code || null,
                  notes: v.notes || null,
                  items: items.map((l) => ({
                    product_id: String(l.product_id),
                    unit_code: l.unit_code || 'PIECE',
                    quantity: Number(l.quantity),
                    expected_unit_cost: Number(l.expected_unit_cost) || 0,
                  })),
                });
                ui.ok(result.po_number ? `${result.po_number} raised.` : 'Purchase order raised.');
                m.close();
                load();
              } catch (err) {
                ui.apiError(err);
                ev.currentTarget.disabled = false;
                paintStatus();
              }
            },
          }, 'Raise the order')),
        ],
      });
      paintStatus();
    }

    await load();
    return wrap;
  }

  // -------------------------------------------------------------------
  // ONE ORDER — AND THE RECEIVING WIZARD
  // -------------------------------------------------------------------
  async function renderDetail(ctx) {
    ctx.setTitle('Purchase order');
    const wrap = ui.h('div', { class: 'stack' });
    const host = ui.h('div', { class: 'stack' });
    wrap.appendChild(host);
    await load();

    async function load() {
      host.replaceChildren(ui.skeleton(7));
      let data; let offline = false;
      try {
        data = await SR.api.get(`/api/purchase-orders/${encodeURIComponent(ctx.params.id)}`);
      } catch (err) {
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: load } })); return; }
        offline = true;
        const po = await SR.store.get('purchase_orders', ctx.params.id);
        if (!po) { host.replaceChildren(ui.empty({ title: 'Not on this device', message: 'This order has not been synced here yet. Receiving needs a connection anyway.' })); return; }
        data = { order: po, items: [], receipts: [] };
      }
      const po = data.po || data.order || data.purchaseOrder || data;
      const items = data.items || po.items || [];
      const receipts = data.receipts || [];
      const openForReceiving = po.status !== 'RECEIVED' && po.status !== 'CANCELLED';
      // AN ORDER THAT HAS TAKEN DELIVERY CANNOT BE CANCELLED — the route refuses it
      // (PO_PARTLY_RECEIVED: "the goods exist and the debt is real"), and this screen used to
      // offer the button anyway. The person confirmed a dialog, typed a reason, and was refused:
      // a control the server will always reject is not a control, it is a trap. The honest test
      // is whether anything has been RECEIVED, not which word the status carries.
      const nothingReceived = !items.some((i) => Number(i.quantity_received || 0) > 0);
      const canCancelOrder = openForReceiving && nothingReceived && SR.state.atLeast('MANAGER');
      const outstanding = items.filter((i) => round4(Number(i.quantity_in_base) - Number(i.quantity_received)) > 0);

      host.appendChild(ui.h('div', { class: 'page-head' },
        ui.h('div', {},
          ui.h('h1', {}, po.po_number),
          ui.h('p', { class: 'sub' }, [po.supplier_name, po.branch_name, `raised ${U.date(po.ordered_at)}`].filter(Boolean).join(' · '))),
        ui.h('div', { class: 'actions' },
          ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate('/purchase-orders') }, 'Back'),
          ui.h('button', { class: 'btn btn-sm', onClick: () => printOrder(po, items) }, 'Print'),
          openForReceiving && SR.state.atLeast('MANAGER') ? ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => openReceive(po, outstanding, receipts, load) }, 'Receive goods') : null,
          canCancelOrder ? ui.h('button', { class: 'btn btn-sm btn-danger', onClick: () => cancel(po, load) }, 'Cancel order') : null)));

      if (offline) host.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'Offline — from this device\'s last sync.'));

      host.appendChild(ui.h('div', { class: 'grid grid-4' },
        ui.kpi({ label: 'Order total', value: U.money(po.total), foot: `${U.qty(po.units_ordered)} units on ${items.length} line${items.length === 1 ? '' : 's'}`, small: true }),
        ui.kpi({ label: 'Received', value: `${U.qty(po.units_received)} units`, tone: outstanding.length ? 'warn' : 'good', foot: outstanding.length ? `${outstanding.length} line${outstanding.length === 1 ? '' : 's'} outstanding` : 'complete', small: true }),
        ui.kpi({
          label: 'Expected',
          value: po.expected_date ? U.date(po.expected_date) : '—',
          tone: po.expected_date && po.expected_date < U.todayWat() && openForReceiving ? 'bad' : null,
          foot: po.status,
          small: true,
        }),
        ui.kpi({
          label: 'Withholding',
          value: Number(po.wht_amount) ? U.money(po.wht_amount) : 'none',
          foot: po.wht_code ? `${po.wht_code}${po.wht_rate_percent ? ` @ ${po.wht_rate_percent}%` : ''}` : null,
          small: true,
        })));

      host.appendChild(ui.dataCard({
        title: 'Ordered items',
        table: ui.renderTable({
          columns: [
            { key: 'product_name', label: 'Item', className: 'wrap', render: (i) => ui.h('div', {},
              ui.h('div', { style: { fontWeight: '600' } }, i.product_name || i.name),
              ui.h('div', { class: 'hint' }, [i.sku, i.variant_name].filter(Boolean).join(' · '))) },
            { key: 'quantity', label: 'Ordered', align: 'right', render: (i) => `${U.qty(i.quantity)} ${i.unit_code || ''}` },
            { key: 'quantity_in_base', label: 'In base units', align: 'right', render: (i) => U.qty(i.quantity_in_base) },
            { key: 'quantity_received', label: 'Received', align: 'right', render: (i) => {
              const got = Number(i.quantity_received);
              const want = Number(i.quantity_in_base);
              return ui.h('span', { style: got >= want ? { color: 'var(--green-700)' } : {} }, U.qty(got));
            } },
            { key: 'outstanding', label: 'Outstanding', align: 'right', render: (i) => {
              const left = round4(Number(i.quantity_in_base) - Number(i.quantity_received));
              return left > 0 ? ui.h('strong', { style: { color: 'var(--amber-700)' } }, U.qty(left)) : ui.badge('done', 'badge-good');
            } },
            { key: 'expected_unit_cost', label: 'Unit cost', align: 'right', render: (i) => U.money(i.expected_unit_cost, { kobo: true }) },
            { key: 'expected_total_cost', label: 'Line total', align: 'right', render: (i) => U.money(i.expected_total_cost) },
          ],
          rows: items,
          foot: ['', '', '', '', '', 'Total', U.money(po.total)],
        }),
      }));

      if (receipts.length) {
        host.appendChild(ui.dataCard({
          title: 'Deliveries against this order',
          table: ui.renderTable({
            columns: [
              { key: 'received_at', label: 'Received', render: (r) => U.dateTime(r.received_at) },
              { key: 'product_name', label: 'Item', className: 'wrap' },
              { key: 'quantity_received', label: 'Quantity', align: 'right', render: (r) => U.qty(r.quantity_received) },
              { key: 'batch_no', label: 'Batch', render: (r) => ui.h('span', { class: 'mono' }, r.batch_no || '—') },
              { key: 'cost_per_unit', label: 'Cost/unit', align: 'right', render: (r) => U.money(r.cost_per_unit, { kobo: true }) },
              { key: 'received_by_name', label: 'Received by' },
            ],
            rows: receipts,
          }),
        }));
      }
    }

    function round4(n) { return Math.round((Number(n) || 0) * 10000) / 10000; }

    function cancel(po, after) {
      ui.confirmDialog({
        title: `Cancel ${po.po_number}?`,
        message: 'Nobody can receive against it afterwards. The order stays in the history, marked cancelled, so the supplier conversation is still documented.',
        confirmLabel: 'Cancel the order',
        danger: true,
      }).then(async (yes) => {
        if (!yes) return;
        const reason = await ui.promptDialog({
          title: 'Why is it being cancelled?',
          label: 'Reason',
          required: true,
          hint: 'Example: supplier could not supply at the agreed price.',
        });
        if (!reason) return;
        try {
          await SR.api.post(`/api/purchase-orders/${encodeURIComponent(po.id)}/cancel`, { reason });
          ui.ok('Order cancelled.');
          if (after) after(); else load();
        } catch (err) { ui.apiError(err); }
      });
    }

    function printOrder(po, items) {
      SR.print.printReport({
        title: `Purchase order ${po.po_number}`,
        subtitle: [po.supplier_name, po.branch_name, `Expected ${po.expected_date || 'no date'}`].filter(Boolean).join(' · '),
        columns: [
          { key: 'product_name', label: 'Item' },
          { key: 'quantity', label: 'Qty', value: (i) => `${i.quantity} ${i.unit_code || ''}` },
          { key: 'quantity_in_base', label: 'Base units', value: (i) => U.qty(i.quantity_in_base) },
          { key: 'expected_unit_cost', label: 'Unit cost', value: (i) => U.amount(i.expected_unit_cost) },
          { key: 'expected_total_cost', label: 'Line total', value: (i) => U.amount(i.expected_total_cost) },
        ],
        rows: items,
        foot: ['', '', '', 'TOTAL', U.amount(po.total)],
      });
    }

    return wrap;
  }

  /**
   * The receiving wizard.
   *
   * One row per outstanding line, pre-filled with what is still owed, so the
   * common case — everything arrived — is one tap on "Receive all". Anything
   * else is typed over. The freight box is per line because haulage on a truck of
   * fridges rarely splits evenly across the lines on the order.
   */
  /**
   * Make sure a serial box is on screen and the cursor is in it.
   *
   * `ui.field` returns the WRAPPER div and appends the control to it, so the element carrying the
   * name IS the textarea and its parent is the wrapper that gets hidden for an untracked line.
   * Both had to be opened, and the cursor put in the control — the person is holding a label and
   * should not have to hunt for the box that was just revealed to them.
   */
  function revealSerials(input) {
    if (!input) return;
    input.hidden = false;
    if (input.parentElement) input.parentElement.hidden = false;
    try { input.focus(); } catch (err) { /* focus is a courtesy, never a failure */ }
  }

  function openReceive(po, outstanding, receipts, done) {
    const plan = new Map();
    for (const i of outstanding) {
      plan.set(String(i.id), {
        item: i,
        quantityBase: round4(Number(i.quantity_in_base) - Number(i.quantity_received)),
        // ONE NUMBER PER UNIT, kept per line: `acceptSerials` on the route wants them supplied
        // with the receipt, and this is where the person holding the labels types them.
        serials: [],
        costPerUnit: Number(i.expected_unit_cost) || 0,
        freightPerUnit: 0,
        sellingPrice: Number(i.selling_price) || null,
        batchNo: `${po.po_number}-${String(plan.size + 1).padStart(2, '0')}`,
        expiryDate: null,
        allowOver: false,
      });
    }
    void receipts;

    const wrapEl = ui.h('div', {});
    wrapEl.appendChild(ui.h('div', { class: 'alert alert-info' },
      `Receiving against ${po.po_number} from ${po.supplier_name || 'the supplier'}. The cost recorded here becomes the cost of every unit in the batch, so it is the number your profit is measured against.`));

    const rowsHost = ui.h('div', { class: 'stack' });
    wrapEl.appendChild(rowsHost);

    const money = ui.h('div', { class: 'form-grid' },
      ui.field({ label: 'Paid now (₦)', name: 'paid_now', type: 'number', step: '0.01', min: '0', value: '0', hint: 'What left the account at delivery.' }),
      ui.field({ label: 'On credit (₦)', name: 'on_credit', type: 'number', step: '0.01', min: '0', value: '0', hint: 'What goes onto the creditor ledger to be paid later.' }),
      ui.field({ label: 'Warehouse zone', name: 'warehouse_zone', placeholder: 'e.g. Aisle 3, bay 2' }),
      ui.field({ label: 'Notes', name: 'notes', type: 'textarea', span: true }));
    wrapEl.appendChild(money);

    const totalsBar = ui.h('div', { class: 'alert alert-info' }, '');

    function paint() {
      rowsHost.replaceChildren();
      for (const entry of plan.values()) {
        const i = entry.item;
        const card = ui.h('div', { class: 'card' });
        const body = ui.h('div', { class: 'card-body' });
        body.appendChild(ui.h('div', { class: 'row' },
          ui.h('div', { class: 'grow' },
            ui.h('strong', {}, i.product_name || i.name),
            ui.h('div', { class: 'hint' }, `Outstanding ${U.qty(round4(Number(i.quantity_in_base) - Number(i.quantity_received)))} ${i.base_unit_name || 'units'} of ${U.qty(i.quantity_in_base)} ordered`))));

        const serialName = `serials_${i.id}`;
        const grid = ui.h('div', { class: 'form-grid' });
        grid.appendChild(ui.field({
          label: `Quantity received (${i.base_unit_name || 'units'})`, name: `qty_${i.id}`, type: 'number', step: 'any', min: '0',
          value: String(entry.quantityBase),
          hint: 'In base units. If the supplier delivered a different pack size, enter the pieces, not the cartons.',
        }));
        grid.appendChild(ui.field({ label: 'Cost per unit (₦)', name: `cost_${i.id}`, type: 'number', step: '0.000001', min: '0', value: String(entry.costPerUnit) }));
        grid.appendChild(ui.field({ label: 'Freight per unit (₦)', name: `freight_${i.id}`, type: 'number', step: '0.000001', min: '0', value: '0' }));
        grid.appendChild(ui.field({ label: 'Selling price (₦)', name: `price_${i.id}`, type: 'number', step: '0.01', min: '0', value: entry.sellingPrice != null ? String(entry.sellingPrice) : '' }));
        grid.appendChild(ui.field({ label: 'Batch number', name: `batch_${i.id}`, value: entry.batchNo }));
        grid.appendChild(ui.field({ label: 'Expiry date', name: `expiry_${i.id}`, type: 'date' }));
        body.appendChild(grid);

        // ---- SERIAL NUMBERS ----
        // THE ROUTE REFUSES A DELIVERY OF A SERIAL-TRACKED PRODUCT WITHOUT ONE NUMBER PER UNIT
        // ("…is serial-tracked, so each unit needs its own serial number: 1 expected for 1
        // unit(s), 0 given") — and until now this form had no box to type them in, so a phone, a
        // fridge or a generator bought on a purchase order could not be received AT ALL. The same
        // dead end that was fixed on the direct goods-received screen, one route over.
        //
        // The count is in BASE UNITS — the same unit the quantity box is in — because that is how
        // the route counts and how the warranty follows the individual unit.
        const tracked = Boolean(Number(i.requires_serial));
        const serialBox = ui.field({
          label: 'Serial numbers', name: serialName, type: 'textarea', span: true, rows: 3,
          placeholder: 'One per line — scan or type each label',
          // `ui.field` only renders a hint when one is passed, so the element is created here and
          // filled by paintSerialHint() — an empty string would leave the box with no line at all.
          hint: 'One number per unit.',
        });
        serialBox.hidden = !tracked;
        function paintSerialHint() {
          if (!tracked) return;
          const hint = serialBox.querySelector('.hint');
          const need = Math.ceil(Number(entry.quantityBase) || 0);
          // THE CONTROL IS THE WRAPPER'S DIRECT CHILD, not a `textarea` further down (`ui.field`
          // returns the wrapper) — asking for a descendant textarea of the textarea itself is how
          // "N entered" stayed at 0 however many labels had been scanned.
          const typed = String(((serialBox.querySelector(`[name="${serialName}"]`)) || {}).value || '')
            .split(/[\n,\t]+/).map((x) => x.trim()).filter(Boolean).length;
          if (hint) {
            hint.textContent = need > 0
              ? `${need} unit(s) — ${need} serial number(s) expected, one per unit; ${typed} entered. This delivery is refused without them, and a number captured later cannot be matched to the unit it came in on.`
              : 'Nothing is being received on this line, so no numbers are needed.';
          }
        }
        if (tracked) { paintSerialHint(); serialBox.dataset.tracked = '1'; }
        body.appendChild(serialBox);
        body._paintSerialHint = paintSerialHint;

        const overBox = ui.h('label', { class: 'check' },
          ui.h('input', { type: 'checkbox', name: `over_${i.id}` }),
          ui.h('div', {}, ui.h('strong', {}, 'Allow over-delivery on this line'),
            ui.h('div', { class: 'hint' }, 'Only tick this if the supplier sent MORE than was ordered. Accepting the excess means paying for it and the invoice will not match the order.')));
        body.appendChild(overBox);
        card.appendChild(body);
        rowsHost.appendChild(card);
      }
      recompute();
    }

    function readRowValues() {
      const v = ui.readFormStrings(wrapEl);
      for (const entry of plan.values()) {
        const id = entry.item.id;
        entry.quantityBase = Number(v[`qty_${id}`]) || 0;
        entry.costPerUnit = Number(v[`cost_${id}`]) || 0;
        entry.freightPerUnit = Number(v[`freight_${id}`]) || 0;
        entry.sellingPrice = v[`price_${id}`] == null ? null : Number(v[`price_${id}`]);
        entry.batchNo = v[`batch_${id}`] || null;
        entry.expiryDate = v[`expiry_${id}`] || null;
        // One number per line, one line per number: a label scanner emits a newline and a clerk
        // pasting from a dispatch note emits anything at all.
        entry.serials = String(v[`serials_${id}`] || '')
          .split(/[\n,\t]+/).map((x) => x.trim()).filter(Boolean);
        entry.allowOver = Boolean(wrapEl.querySelector(`[name="over_${id}"]`) && wrapEl.querySelector(`[name="over_${id}"]`).checked);
      }
      return v;
    }

    function recompute() {
      const v = readRowValues();
      const value = U.sum([...plan.values()], (e) => e.quantityBase * (e.costPerUnit + e.freightPerUnit));
      const paid = Number(v.paid_now) || 0;
      const credit = Number(v.on_credit) || 0;
      totalsBar.replaceChildren();
      totalsBar.appendChild(ui.kv([
        ['Landed value of this delivery', ui.h('strong', {}, U.money(value))],
        ['Paid now', U.money(paid)],
        ['On credit', U.money(credit)],
        ['Difference', U.money(U.round2(value - paid - credit))],
      ]));
      if (Math.abs(U.round2(value - paid - credit)) > 0.01) {
        totalsBar.appendChild(ui.h('div', { class: 'hint' }, 'Paid plus credit does not equal the landed value. That is allowed — the remainder simply stays on the creditor ledger — but check it is what you mean.'));
      }
    }
    wrapEl.appendChild(totalsBar);
    wrapEl.addEventListener('input', () => {
      recompute();
      // The serials hint counts the units being received, so it has to follow the quantity box.
      for (const card of rowsHost.querySelectorAll('.card-body')) {
        if (card._paintSerialHint) card._paintSerialHint();
      }
    });
    wrapEl.appendChild(ui.h('div', { class: 'hint' }, 'Selling price defaults to the product\'s current price. Changing it here changes the price on the new batch only.'));
    paint();

    const m = ui.openModal({
      title: `Receive against ${po.po_number}`,
      body: wrapEl,
      size: 'full',
      footer: [
        ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
        ui.h('button', {
          class: 'btn',
          onClick: () => {
            // "Everything arrived, at cost" — the common case.
            for (const entry of plan.values()) {
              entry.quantityBase = round4(Number(entry.item.quantity_in_base) - Number(entry.item.quantity_received));
              entry.freightPerUnit = 0;
            }
            paint();
          },
        }, 'Reset to what was ordered'),
        ui.h('button', {
          class: 'btn btn-primary',
          onClick: async (ev) => {
            const v = readRowValues();

            // THE CLIENT REFUSES FIRST, IN THE SERVER'S OWN SENTENCE. A refusal that arrives
            // without somewhere to type the numbers is a dead end, not a validation — so the box
            // is opened, focused, and the person is told exactly what is missing before a round
            // trip tells them in red.
            for (const e of plan.values()) {
              if (!Number(e.item.requires_serial) || !(e.quantityBase > 0)) continue;
              const need = Math.ceil(e.quantityBase);
              if (e.serials.length === need) continue;
              revealSerials(wrapEl.querySelector(`[name="serials_${e.item.id}"]`));
              ui.warn(`${e.item.product_name || e.item.name} is serial-tracked, so each unit needs its own serial number: ${need} expected for ${U.qty(e.quantityBase)} unit(s), ${e.serials.length} given. Scan or type the number off each label — one number per unit, one line each.`);
              return;
            }

            const receiptsPayload = [...plan.values()]
              .filter((e) => e.quantityBase > 0)
              .map((e) => ({
                item_id: String(e.item.id),
                quantity_received: e.quantityBase,
                // Only for tracked lines: the route refuses numbers on a product that has nowhere
                // to file them (SERIALS_NOT_EXPECTED).
                ...(Number(e.item.requires_serial) && e.serials.length ? { serials: e.serials } : {}),
                cost_per_unit: e.costPerUnit,
                freight_per_unit: e.freightPerUnit,
                selling_price: e.sellingPrice,
                batch_no: e.batchNo,
                expiry_date: e.expiryDate,
                allow_over_receipt: e.allowOver,
              }));
            if (!receiptsPayload.length) { ui.warn('Nothing to receive — every quantity is zero.'); return; }
            ev.currentTarget.disabled = true;
            ev.currentTarget.textContent = 'Recording…';
            try {
              const result = await SR.api.post(`/api/purchase-orders/${encodeURIComponent(po.id)}/receive`, {
                receipts: receiptsPayload,
                paid_now: Number(v.paid_now) || 0,
                on_credit: Number(v.on_credit) || 0,
                warehouse_zone: v.warehouse_zone || null,
                notes: v.notes || null,
              });
              // THE NUMBERS THAT WENT ON FILE ARE NAMED IN THE RECEIPT. A serial is the only
              // proof of which unit arrived, so the person who scanned it should see it land —
              // and a warning (a duplicate across the group, say) is passed on rather than
              // swallowed.
              const registered = Array.isArray(result.serials) ? result.serials.length : 0;
              // The route files them under `warnings` (a duplicate across the group, say).
              const warningList = Array.isArray(result.warnings) ? result.warnings
                : (Array.isArray(result.serialWarnings) ? result.serialWarnings : []);
              const warned = warningList.length
                ? ` ${typeof warningList[0] === 'string' ? warningList[0] : JSON.stringify(warningList[0])}` : '';
              ui.ok(`${result.fullyReceived
                ? 'Received in full. The order is complete and the batches are on the shelf.'
                : 'Delivery recorded. The order remains open for the balance.'}${registered ? ` ${registered} serial number(s) are on file against the units.` : ''}${warned}`);
              m.close();
              if (done) done(); else load();
            } catch (err) {
              // A SERIALS REFUSAL FROM THE SERVER STILL LEAVES SOMEWHERE TO TYPE. The route is
              // the authority on what a delivery needs; if it wants numbers, the boxes are opened
              // and focused whatever this form believed about the product.
              if (err && (err.code === 'SERIALS_REQUIRED' || /serial-tracked/i.test(String(err.message || '')))) {
                for (const input of wrapEl.querySelectorAll('[name^="serials_"]')) revealSerials(input);
              }
              ui.apiError(err);
              ev.currentTarget.disabled = false;
              ev.currentTarget.textContent = 'Record the delivery';
            }
          },
        }, 'Record the delivery'),
      ],
    });
  }

  function round4(n) { return Math.round((Number(n) || 0) * 10000) / 10000; }

  SR.views = SR.views || {};
  SR.views['purchase-orders'] = { render, openReceive };
}(window));
