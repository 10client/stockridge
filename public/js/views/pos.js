'use strict';
// =====================================================================
// public/js/views/pos.js — THE COUNTER
// =====================================================================
// This is the screen the business actually runs on, and it is the one that has
// to survive the worst conditions in the building: a queue of customers, a
// cashier who has used it for a week, and a data connection that drops for
// twenty minutes at a time.
//
// HOW A SALE IS RECORDED, in order, and why each step is where it is:
//
//   1. Scan or search.        The search runs against the DEVICE MIRROR first,
//                             so it answers in under 30 ms with no network.
//   2. Add to the cart.       Price comes from the mirror; when the server is
//                             reachable a background preview confirms it and
//                             any disagreement is SHOWN, not silently applied.
//   3. Take payment.          Tendered, change, split methods, credit.
//   4. COMPLETE.              The cart is written to the device outbox FIRST.
//                             Only then is the receipt offered. If the line is
//                             up the outbox flushes within seconds; if it is
//                             down the sale is already safe on the device.
//
// The one thing this screen will not do is pretend. A sale completed offline
// prints "OFFLINE SALE — not yet sent to the office" with a local reference,
// because a customer holding a receipt the shop's own records cannot find is a
// dispute nobody wins.
// =====================================================================
(function (global) {
  const SR = global.SR;
  const ui = SR.ui;
  const U = SR.util;

  const TYPES = ['RETAIL', 'WHOLESALE', 'CREDIT', 'INSTALMENT', 'LAYAWAY', 'EXCHANGE'];
  function saleTypes() {
    return TYPES.filter((type) => {
      if (type === 'WHOLESALE') return SR.state.moduleOn('wholesale');
      if (type === 'INSTALMENT' || type === 'LAYAWAY') return SR.state.moduleOn('instalments');
      return true;
    });
  }
  const METHODS = ['CASH', 'POS_TERMINAL', 'BANK_TRANSFER', 'MOBILE_MONEY', 'USSD', 'CHEQUE', 'INSTALMENT', 'DEPOSIT'];
  const METHOD_LABEL = {
    CASH: 'Cash', POS_TERMINAL: 'Card / POS', BANK_TRANSFER: 'Transfer',
    MOBILE_MONEY: 'Mobile money', USSD: 'USSD', CHEQUE: 'Cheque',
    INSTALMENT: 'Instalment', DEPOSIT: 'Deposit held', CREDIT: 'On credit',
  };

  function blankCart() {
    return {
      lines: [],
      saleType: 'RETAIL',
      customerId: null,
      customerName: null,
      customerPhone: null,
      discountAmount: 0,
      discountReason: null,
      deliveryFee: 0,
      deliveryRequired: false,
      deliveryAddress: null,
      payments: [],
      notes: null,
      manualPriceOverrides: {},
      creditOverrideReason: null,
      changeOwedAmount: 0,
      startedAt: U.nowWatSql(),
    };
  }

  async function render(ctx) {
    ctx.setTitle('Sell');
    const cart = SR.state.loadCart() || blankCart();

    const wrap = ui.h('div', { class: 'stack' });

    // ---------------- layout ----------------
    const grid = ui.h('div', { class: 'pos' });
    const left = ui.h('div', { class: 'stack' });
    const right = ui.h('div', { class: 'stack pos-side' });
    grid.appendChild(left);
    grid.appendChild(right);

    // ---------------- the scan box ----------------
    const serialsOn = () => SR.state.usesSerialNumbers();
    const scanInput = ui.h('input', {
      type: 'search',
      placeholder: serialsOn() ? 'Scan a barcode, or type a name, SKU or serial…' : 'Scan a barcode, or type a name or SKU…',
      id: 'pos-scan',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
    });
    const scanBox = ui.h('div', { class: 'pos-scan' }, scanInput,
      ui.h('button', { class: 'btn btn-primary scan-btn', onClick: () => doSearch(scanInput.value) }, 'Find'));
    const results = ui.h('div', { class: 'pos-results', hidden: true });
    const scanCard = ui.h('div', { class: 'card' },
      ui.h('div', { class: 'card-body' },
        scanBox,
        ui.h('div', { class: 'hint' }, serialsOn()
          ? 'A barcode scanner types and presses Enter. A serial number is looked up too.'
          : 'A barcode scanner types and presses Enter. Serial numbers stay off until the business turns them on in Settings.'),
        results));
    left.appendChild(scanCard);

    // ---------------- the cart ----------------
    const cartCard = ui.h('div', { class: 'card' });
    const cartHead = ui.h('div', { class: 'card-head' },
      ui.h('h2', {}, 'Cart'),
      ui.h('span', { class: 'spacer' }));
    const lineCount = ui.h('span', { class: 'badge badge-mute' }, '0 lines');
    cartHead.appendChild(lineCount);
    cartHead.appendChild(ui.h('button', { class: 'btn btn-sm btn-ghost', onClick: clearCart }, 'Clear'));
    cartCard.appendChild(cartHead);
    const cartBody = ui.h('div', { class: 'card-body tight' });
    cartCard.appendChild(cartBody);
    left.appendChild(cartCard);

    // ---------------- totals + payment ----------------
    const totalsCard = ui.h('div', { class: 'card' });
    const totalsBody = ui.h('div', { class: 'card-body' });
    const totalsEl = ui.h('div', { class: 'totals' });
    totalsBody.appendChild(totalsEl);
    totalsBody.appendChild(ui.h('div', { class: 'btn-row', style: { marginTop: '14px' } },
      ui.h('button', { class: 'btn btn-primary btn-lg grow', id: 'pos-complete', onClick: () => openTender() }, 'Take payment'),
      ui.h('button', { class: 'btn btn-lg', onClick: () => openMeta() }, 'Details')));
    totalsCard.appendChild(totalsBody);
    right.appendChild(totalsCard);

    // ---------------- quick info ----------------
    const infoCard = ui.h('div', { class: 'card' });
    const infoBody = ui.h('div', { class: 'card-body stack' });
    infoCard.appendChild(infoBody);
    right.appendChild(infoCard);

    if (!SR.state.activeBranchId && SR.state.canSeeAllBranches()) {
      wrap.appendChild(ui.h('div', { class: 'alert alert-warn' },
        ui.h('strong', {}, 'Pick a shop before you sell. '),
        'Switching business does not guess one, and a sale has to belong to a shop.',
        ui.h('button', { class: 'btn btn-sm', type: 'button', style: { marginLeft: '8px' }, onClick: () => { if (SR.app.openBranchPicker) SR.app.openBranchPicker(); } }, 'Choose a shop')));
    }
    wrap.appendChild(grid);
    // The view host is replaced by the returned node, so this must be returned
    // AFTER any awaited work that touches the DOM.

    // ---------------- search ----------------
    let searchSeq = 0;
    const doSearch = U.debounce(async (term) => {
      const q = String(term || '').trim();
      if (q.length < 2) { results.hidden = true; results.replaceChildren(); return; }
      if (!SR.state.activeBranchId) {
        results.replaceChildren();
        results.appendChild(ui.h('div', { class: 'pos-hit' },
          ui.h('div', { class: 'ph-name' }, 'Pick a shop before you sell.'),
          ui.h('div', { class: 'ph-meta' }, 'A sale has to come out of one shop’s received stock.')));
        results.hidden = false;
        return;
      }
      const seq = ++searchSeq;
      let hits = []; let source = 'device';
      const offline = !SR.api.isOnline() || (typeof navigator !== 'undefined' && navigator.onLine === false);
      // Offline must not wait on a request that cannot succeed. A failed fetch
      // that comes back as an empty page used to be treated as "nothing matches".
      if (!offline) {
        try {
          const data = await SR.api.get('/api/products', { query: SR.state.query({ q, limit: 20, for_sale: '1' }) });
          if (!data || !Array.isArray(data.data)) throw new Error('The till search did not return a list.');
          hits = data.data;
          source = 'server';
        } catch (err) {
          hits = await searchMirror(q);
          source = 'device';
        }
      } else {
        hits = await searchMirror(q);
        source = 'device';
      }
      if (seq !== searchSeq) return;
      results.replaceChildren();
      if (!hits.length) {
        const recorded = source === 'device' ? await sellableIndex() : null;
        const noneYet = recorded && recorded.byProduct.size === 0;
        results.appendChild(ui.h('div', { class: 'pos-hit' },
          ui.h('div', { class: 'ph-name' }, noneYet ? 'No received stock on this device yet.' : `Nothing in stock matches “${q}”.`),
          ui.h('div', { class: 'ph-meta' }, noneYet
            ? 'Connect once so the till can download what was received. It then sells from that record when the line drops.'
            : 'The till only offers goods received on a purchase order that are still on the shelf.')));
      } else {
        if (source === 'device') {
          results.appendChild(ui.h('div', { class: 'pos-hit' }, ui.h('div', { class: 'ph-meta' }, 'Offline — results are from this device\'s last sync.')));
        }
        for (const p of hits) results.appendChild(hitRow(p));
      }
      results.hidden = false;
    }, 220);

    function hitRow(p) {
      const btn = ui.h('button', { class: 'pos-hit', onClick: () => { addFromSearch(p); scanInput.value = ''; results.hidden = true; scanInput.focus(); } });
      btn.appendChild(ui.h('div', { class: 'grow' },
        ui.h('div', { class: 'ph-name' }, p.name),
        ui.h('div', { class: 'ph-meta' }, [
          p.sku ? `SKU ${p.sku}` : null,
          p.category_name || null,
          p.brand || null,
          p.on_hand != null ? `${U.qty(p.on_hand)} on hand` : null,
          serialsOn() && Number(p.requires_serial) ? 'serial tracked' : null,
        ].filter(Boolean).join(' · '))));
      btn.appendChild(ui.h('span', { class: 'ph-price' }, U.money(p.selling_price)));
      const avail = Number(p.on_hand != null ? p.on_hand : 9999);
      if (avail <= 0) btn.appendChild(ui.badge('out', 'badge-bad'));
      else if (Number(p.reorder_level) > 0 && avail <= Number(p.reorder_level)) btn.appendChild(ui.badge('low', 'badge-warn'));
      return btn;
    }

    /**
     * What this device can sell right now: active batches at this shop that
     * still have quantity, after any sale already queued here. The product
     * name is read off the batch when the catalogue row was never downloaded.
     */
    async function sellableIndex() {
      const branchId = SR.state.activeBranchId;
      const batches = await SR.store.all('stock_batches').catch(() => []);
      const byProduct = new Map();
      const rows = [];
      for (const b of batches) {
        if (Number(b.is_deleted)) continue;
        const status = String(b.status || 'ACTIVE').toUpperCase();
        if (status === 'QUARANTINED' || status === 'EXPIRED' || status === 'DEPLETED') continue;
        if (branchId && String(b.branch_id) !== String(branchId)) continue;
        const avail = Number(b.quantity) - Number(b.quantity_reserved || 0);
        if (!(avail > 0)) continue;
        const id = String(b.product_id);
        const cur = byProduct.get(id) || {
          on_hand: 0,
          name: b.product_name || '',
          sku: b.product_sku || '',
          brand: b.product_brand || '',
          model: b.product_model_no || '',
          price: 0,
          dispensing: b.product_dispensing_class || '',
          controlled: Number(b.product_is_controlled) === 1 ? 1 : 0,
          requiresSerial: Number(b.product_requires_serial) === 1 ? 1 : 0,
        };
        cur.on_hand += avail;
        if (!cur.name && b.product_name) cur.name = b.product_name;
        if (!cur.sku && b.product_sku) cur.sku = b.product_sku;
        if (!cur.brand && b.product_brand) cur.brand = b.product_brand;
        if (!cur.model && b.product_model_no) cur.model = b.product_model_no;
        if (!cur.dispensing && b.product_dispensing_class) cur.dispensing = b.product_dispensing_class;
        if (!cur.controlled && Number(b.product_is_controlled) === 1) cur.controlled = 1;
        if (!cur.requiresSerial && Number(b.product_requires_serial) === 1) cur.requiresSerial = 1;
        const batchPrice = Number(b.selling_price_per_unit) || Number(b.product_selling_price) || 0;
        if (batchPrice > 0 && !(cur.price > 0)) cur.price = batchPrice;
        byProduct.set(id, cur);
        rows.push(b);
      }
      return { byProduct, rows, branchId };
    }

    async function searchMirror(term) {
      const needle = String(term || '').toLowerCase();
      const stock = await sellableIndex();
      if (!stock.byProduct.size) return [];
      // Look up only the products that are on the shelf. Loading the whole
      // catalogue here used to fail on a phone, and the till then said nothing
      // matched even though the shoe was in the stock it already held.
      const hits = [];
      for (const [id, info] of stock.byProduct) {
        const product = await SR.store.get('products', id).catch(() => null);
        if (product && Number(product.is_deleted)) continue;
        if (product && Number(product.is_active) === 0) continue;
        const name = (product && product.name) || info.name || '';
        const sku = (product && product.sku) || info.sku || '';
        const brand = (product && product.brand) || info.brand || '';
        const model = (product && product.model_no) || info.model || '';
        const blob = `${name} ${sku} ${brand} ${model}`.toLowerCase();
        if (!blob.includes(needle)) continue;
        const price = product && Number(product.selling_price) > 0
          ? Number(product.selling_price)
          : (info.price || 0);
        hits.push(Object.assign({}, product || {
          id,
          name,
          sku,
          brand,
          model_no: model,
          is_active: 1,
          base_unit_name: 'PIECE',
          dispensing_class: info.dispensing || null,
          is_controlled: info.controlled || 0,
          requires_serial: info.requiresSerial || 0,
        }, {
          name,
          sku,
          brand,
          on_hand: info.on_hand,
          selling_price: price,
        }));
        if (hits.length >= 20) break;
      }
      return withShopPrice(hits);
    }

    /**
     * The catalogue column is 0 for a shared market row and for a product
     * priced only when it was received. The till used to refuse those before
     * the batch price — the figure typed at the gate — was ever read.
     * This branch's override wins, then the latest batch price.
     */
    async function withShopPrice(products) {
      const list = products || [];
      const need = list.filter((p) => p && !(Number(p.selling_price) > 0));
      if (!need.length) return list;
      const branchId = SR.state.activeBranchId;
      const ids = new Set(need.map((p) => String(p.id)));
      const overrides = await SR.store.all('product_price_overrides', {
        where: (o) => !Number(o.is_deleted) && !o.variant_id && ids.has(String(o.product_id))
          && (!branchId || String(o.branch_id) === String(branchId))
          && Number(o.default_selling_price) > 0,
      }).catch(() => []);
      const batches = await SR.store.all('stock_batches', {
        where: (b) => !Number(b.is_deleted) && ids.has(String(b.product_id))
          && (!branchId || String(b.branch_id) === String(branchId))
          && Number(b.selling_price_per_unit) > 0
          && !['QUARANTINED', 'EXPIRED'].includes(String(b.status || '').toUpperCase()),
      }).catch(() => []);
      const ov = new Map();
      for (const o of overrides) if (!ov.has(String(o.product_id))) ov.set(String(o.product_id), Number(o.default_selling_price));
      batches.sort((a, b) => String(b.received_at || '').localeCompare(String(a.received_at || '')));
      const batch = new Map();
      for (const b of batches) if (!batch.has(String(b.product_id))) batch.set(String(b.product_id), Number(b.selling_price_per_unit));
      return list.map((p) => {
        if (!p || Number(p.selling_price) > 0) return p;
        const price = ov.get(String(p.id)) || batch.get(String(p.id)) || 0;
        return price > 0 ? Object.assign({}, p, { selling_price: price }) : p;
      });
    }

    /** An exact barcode/serial scan goes straight into the cart. */
    async function scan(raw) {
      const code = String(raw || '').trim();
      if (!code) return;
      try {
        const data = await SR.api.get('/api/catalogue/scan', { query: SR.state.query({ code, for_sale: '1' }) });
        if (data && data.product) {
          if (data.product.on_hand == null && data.onHand != null) data.product.on_hand = data.onHand;
          addLine(data.product, { barcode: code, variantId: data.variant_id || null, unitCode: data.unit_code || null, serialNo: data.serial_no || null, units: data.units });
          flash(scanBox, true);
          scanInput.value = '';
          return;
        }
      } catch (err) {
        if (err && err.code === 'NOT_IN_RECEIVED_STOCK') {
          flash(scanBox, false);
          ui.warn(err.message);
          return;
        }
        if (!err.isOffline && err.status !== 404) { ui.apiError(err); }
      }
      // Offline, or not found on the server: try the mirror, then fall back to
      // a name search so a mistyped barcode still finds something plausible.
      const local = await scanMirror(code);
      if (local) {
        addLine(local.product, local);
        flash(scanBox, true);
        scanInput.value = '';
        return;
      }
      const known = (await SR.store.all('product_barcodes').catch(() => [])).find((b) => String(b.barcode) === code && !Number(b.is_deleted));
      if (known) {
        flash(scanBox, false);
        ui.warn('That code is in the catalogue, but it is not on the shelf from a received purchase order.');
        return;
      }
      flash(scanBox, false);
      ui.warn(`No product with the code “${code}”. Searching by name instead.`);
      doSearch(code);
    }

    async function scanMirror(code) {
      const stock = await sellableIndex();
      const withStock = (product, extra) => {
        if (!product || !stock.byProduct.has(String(product.id))) return null;
        return Object.assign({ product: Object.assign({}, product, { on_hand: stock.byProduct.get(String(product.id)) || 0 }) }, extra);
      };
      const barcodes = await SR.store.all('product_barcodes').catch(() => []);
      const hit = barcodes.find((b) => String(b.barcode) === code && !Number(b.is_deleted));
      if (hit) {
        const product = await SR.store.get('products', hit.product_id);
        const found = withStock(product, { variantId: hit.variant_id || null, unitCode: hit.unit_code || null, units: hit.units, barcode: code });
        if (found) return found;
      }
      const serials = await SR.store.all('serial_numbers').catch(() => []);
      const serial = serials.find((s) => String(s.serial_no).toUpperCase() === code.toUpperCase());
      if (serial) {
        const product = await SR.store.get('products', serial.product_id);
        const found = withStock(product, { serialNo: serial.serial_no, serialId: serial.id, unitCode: serial.unit_code || null, units: serial.units });
        if (found) return found;
      }
      return null;
    }

    /**
     * Take the sale off the on-device stock before the server has seen it.
     * The next search on this till must not offer units that were just rung
     * up. The pull after a successful sync replaces these rows with the
     * server's figures, which include the same sale.
     */
    async function applyLocalSale(lines) {
      const stock = await sellableIndex();
      const batches = stock.rows.slice().sort((a, b) => {
        const ae = a.expiry_date ? 0 : 1;
        const be = b.expiry_date ? 0 : 1;
        if (ae !== be) return ae - be;
        const exp = String(a.expiry_date || '').localeCompare(String(b.expiry_date || ''));
        if (exp) return exp;
        const rec = String(a.received_at || '').localeCompare(String(b.received_at || ''));
        if (rec) return rec;
        return String(a.batch_no || '').localeCompare(String(b.batch_no || '')) || String(a.id).localeCompare(String(b.id));
      });
      const changed = [];
      for (const line of lines || []) {
        let need = Number(line.quantity) * (Number(line.unitFactor) > 0 ? Number(line.unitFactor) : 1);
        if (!(need > 0)) continue;
        for (const b of batches) {
          if (need <= 0) break;
          if (String(b.product_id) !== String(line.productId)) continue;
          if (line.variantId && b.variant_id && String(b.variant_id) !== String(line.variantId)) continue;
          const avail = Number(b.quantity) - Number(b.quantity_reserved || 0);
          if (!(avail > 0)) continue;
          const take = Math.min(avail, need);
          b.quantity = Number(b.quantity) - take;
          if (Number(b.quantity) - Number(b.quantity_reserved || 0) <= 0) b.status = 'DEPLETED';
          changed.push(b);
          need -= take;
        }
      }
      if (changed.length) await SR.store.putMany('stock_batches', changed);
    }

    scanInput.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      const value = scanInput.value.trim();
      if (!value) return;
      // A code that looks like a barcode (8–14 digits or an SR serial) is looked
      // up exactly; anything else is a name search.
      if (/^[0-9]{8,14}$/.test(value) || /^[A-Z0-9-]{6,}$/i.test(value) && !/\s/.test(value)) scan(value);
      else doSearch(value);
    });
    scanInput.addEventListener('input', () => doSearch(scanInput.value));

    // ---------------- cart mutations ----------------
    /**
     * The unit code a cashier is selling in.
     *
     * The ladder's DEFAULT SELL level is the answer, because that is what the shop
     * sells in (a carton of noodles, a bag of cement, a piece of a power bank).
     * `default_unit_code` comes from the API; `base_unit_name` is the last resort
     * and it is a WORD, not a code — the appliance ladder names PIECE "Unit", and
     * sending that word was refused as `Unknown unit "UNIT"` at payment, after the
     * customer had already handed over the money.
     */
    function sellUnit(product, units) {
      const ladder = Array.isArray(units) ? units
        : (product && Array.isArray(product.units) ? product.units : []);
      const def = ladder.find((u) => Number(u.is_default_sell) === 1 && Number(u.is_sellable) !== 0)
        || ladder.find((u) => Number(u.is_sellable) !== 0) || ladder[0];
      const code = (def && def.code) || (product && product.default_unit_code) || (product && product.base_unit_name) || 'PIECE';
      // The ladder when the caller has it; otherwise the factor the API reports for
      // the same unit its `default_unit_code` names.
      const raw = Number(def
        ? (def.quantity_in_base != null ? def.quantity_in_base : def.quantityInBase)
        : (product && product.default_unit_factor));
      const factor = Number.isFinite(raw) && raw > 0 ? raw : 1;
      return { code, factor };
    }

    function linePayload(l) {
      return {
        product_id: l.productId,
        variant_id: l.variantId,
        quantity: Number(l.quantity),
        unit_code: l.unitCode,
        unit_price: Number(l.unitPrice),
        line_discount: Number(l.lineDiscount || 0),
        channel: l.channel || undefined,
        starts_on: l.startsOn || undefined,
        ends_on: l.endsOn || undefined,
        periods: l.periods || undefined,
        months: l.channel === 'LEASE' ? l.periods : undefined,
        rate: l.rate != null ? Number(l.rate) : undefined,
        deposit: l.depositEach != null ? U.round2(Number(l.depositEach) * Number(l.quantity || 0)) : undefined,
        serial_numbers: l.serialNumbers && l.serialNumbers.length ? l.serialNumbers : undefined,
        prescription: l.prescription || undefined,
        controlled_kyc: l.controlledKyc || undefined,
      };
    }

    function todayIso() {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    async function askArrangement(product) {
      const hire = Number(product.offers_hire) === 1 && SR.state.moduleOn('hire');
      const lease = Number(product.offers_lease) === 1 && SR.state.moduleOn('lease');
      const sale = product.offers_sale == null || Number(product.offers_sale) === 1;
      if (!hire && !lease) return { channel: 'RETAIL' };
      const choices = [];
      if (sale && Number(product.selling_price) > 0) choices.push('SALE');
      if (hire) choices.push('HIRE');
      if (lease) choices.push('LEASE');
      let channel = choices[0];
      if (choices.length > 1) {
        const picked = await ui.promptDialog({
          title: product.name,
          label: `How is this going out? Type ${choices.join(', ')}`,
          value: choices[0],
          required: true,
        });
        if (!picked) return null;
        channel = String(picked).trim().toUpperCase();
        if (!choices.includes(channel) && channel !== 'SALE') {
          ui.warn(`Type one of ${choices.join(', ')}.`);
          return null;
        }
        if (channel === 'SALE') channel = 'RETAIL';
      }
      if (channel !== 'HIRE' && channel !== 'LEASE') return { channel: 'RETAIL' };
      const start = await ui.promptDialog({
        title: channel === 'HIRE' ? 'Hire dates' : 'Lease start',
        label: 'Starts on (YYYY-MM-DD)',
        value: todayIso(),
        required: true,
      });
      if (!start) return null;
      const endLabel = channel === 'HIRE' ? 'Back on (YYYY-MM-DD)' : 'Months (whole number)';
      const end = await ui.promptDialog({
        title: channel === 'HIRE' ? 'Hire dates' : 'Lease term',
        label: endLabel,
        value: channel === 'HIRE' ? start : '1',
        required: true,
      });
      if (!end) return null;
      const rate = channel === 'HIRE' ? Number(product.hire_price_per_day) : Number(product.lease_price_per_month);
      const eachDeposit = channel === 'HIRE' ? Number(product.hire_deposit) || 0 : Number(product.lease_deposit) || 0;
      if (!(rate > 0)) {
        ui.warn(`${product.name} has no ${channel === 'HIRE' ? 'daily hire rate' : 'monthly rent'}. Set it in the catalogue first.`);
        return null;
      }
      let periods = 1;
      let endsOn = end;
      if (channel === 'LEASE') {
        periods = Math.max(1, Math.round(Number(end) || 1));
        const parts = String(start).split('-').map(Number);
        const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
        dt.setUTCMonth(dt.getUTCMonth() + periods);
        dt.setUTCDate(dt.getUTCDate() - 1);
        const pad = (n) => String(n).padStart(2, '0');
        endsOn = `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
      } else {
        const a = new Date(`${start}T00:00:00Z`);
        const b = new Date(`${end}T00:00:00Z`);
        periods = Math.round((b - a) / 86400000) + 1;
        if (!(periods > 0)) {
          ui.warn('The return date has to be on or after the start date.');
          return null;
        }
      }
      return {
        channel,
        startsOn: start,
        endsOn,
        periods,
        rate,
        deposit: eachDeposit,
        unitPrice: channel === 'LEASE' ? rate : U.round2(rate * periods),
      };
    }

    async function askDispense(product) {
      const pom = String(product.dispensing_class || '') === 'POM';
      const controlled = Number(product.is_controlled) === 1;
      if (!pom && !controlled) return {};
      const out = {};
      if (pom) {
        const prescriber = await ui.promptDialog({
          title: product.name,
          label: 'Prescriber name',
          required: true,
          hint: 'This is prescription-only. It cannot leave the counter without the prescriber’s name.',
        });
        if (!prescriber) return null;
        const patient = await ui.promptDialog({
          title: product.name,
          label: 'Patient name (optional)',
          required: false,
        });
        if (patient === null) return null;
        out.prescription = { prescriber_name: String(prescriber).trim(), patient_name: patient ? String(patient).trim() : null };
      }
      if (controlled) {
        const buyer = await ui.promptDialog({
          title: product.name,
          label: 'Buyer name',
          required: true,
          hint: 'A controlled medicine is written into the register. Name and phone are required.',
        });
        if (!buyer) return null;
        const phone = await ui.promptDialog({
          title: product.name,
          label: 'Buyer phone',
          required: true,
        });
        if (!phone) return null;
        out.controlledKyc = { buyer_name: String(buyer).trim(), buyer_phone: String(phone).trim() };
      }
      return out;
    }

    /**
     * A shelf-only hit can name the product and still not know it is
     * prescription-only. The till then queues a sale the server will refuse,
     * and the refusal used to arrive with the reason written into a field the
     * Sync screen did not read. Look the marks up before the line is added.
     */
    async function withDispenseMarks(product) {
      if (!product || !product.id) return product;
      if (product.dispensing_class || Number(product.is_controlled) === 1) return product;
      const stored = await SR.store.get('products', product.id).catch(() => null);
      if (stored && (stored.dispensing_class || Number(stored.is_controlled) === 1)) {
        return Object.assign({}, product, {
          dispensing_class: stored.dispensing_class,
          is_controlled: stored.is_controlled,
          requires_serial: product.requires_serial != null ? product.requires_serial : stored.requires_serial,
          name: product.name || stored.name,
        });
      }
      const batches = await SR.store.all('stock_batches', {
        where: (b) => String(b.product_id) === String(product.id),
      }).catch(() => []);
      const hit = (batches || []).find((b) => b.product_dispensing_class || Number(b.product_is_controlled) === 1);
      if (hit) {
        return Object.assign({}, product, {
          dispensing_class: hit.product_dispensing_class || product.dispensing_class || null,
          is_controlled: Number(hit.product_is_controlled) === 1 ? 1 : (product.is_controlled || 0),
          requires_serial: product.requires_serial != null ? product.requires_serial : hit.product_requires_serial,
          name: product.name || hit.product_name,
        });
      }
      if (!SR.api.isOnline()) return product;
      try {
        const data = await SR.api.get('/api/products/' + encodeURIComponent(product.id));
        const remote = data && data.product;
        if (!remote) return product;
        return Object.assign({}, product, {
          dispensing_class: remote.dispensing_class || null,
          is_controlled: remote.is_controlled,
          requires_serial: product.requires_serial != null ? product.requires_serial : remote.requires_serial,
          name: product.name || remote.name,
        });
      } catch (e) {
        return product;
      }
    }

    /** Ask now if a line is marked and the details were never collected. */
    async function ensureDispense(lines) {
      for (const line of lines) {
        const marks = await withDispenseMarks({ id: line.productId, name: line.name });
        const pom = String(marks.dispensing_class || '').toUpperCase() === 'POM';
        const controlled = Number(marks.is_controlled) === 1;
        if (pom && !(line.prescription && line.prescription.prescriber_name)) {
          const asked = await askDispense({
            name: marks.name || line.name,
            dispensing_class: 'POM',
            is_controlled: controlled ? 1 : 0,
          });
          if (!asked) return false;
          line.prescription = asked.prescription || null;
          if (asked.controlledKyc) line.controlledKyc = asked.controlledKyc;
        } else if (controlled && !(line.controlledKyc && line.controlledKyc.buyer_name)) {
          const asked = await askDispense({
            name: marks.name || line.name,
            dispensing_class: '',
            is_controlled: 1,
          });
          if (!asked) return false;
          line.controlledKyc = asked.controlledKyc || null;
        }
      }
      return true;
    }

    async function addLine(product, opts = {}) {
      product = await withDispenseMarks(product);
      if (product && !(Number(product.selling_price) > 0) && opts.priceOverride == null) {
        const priced = await withShopPrice([product]);
        if (priced[0] && Number(priced[0].selling_price) > 0) product = priced[0];
      }
      const arrangement = opts.arrangement || await askArrangement(product);
      if (!arrangement) return;
      const dispense = opts.dispense || await askDispense(product);
      if (!dispense) return;
      const hiring = arrangement.channel === 'HIRE' || arrangement.channel === 'LEASE';
      const base = Number(opts.priceOverride != null ? opts.priceOverride : hiring ? arrangement.unitPrice : product.selling_price != null ? product.selling_price : product.price || 0);
      if (!(base > 0)) {
        ui.warn(`${product.name} has no price. Set a price in the catalogue before selling it.`);
        return;
      }
      const marked = String(product.dispensing_class || '') === 'POM' || Number(product.is_controlled) === 1;
      const existing = !hiring && !marked && cart.lines.find((l) => String(l.productId) === String(product.id)
        && String(l.variantId || '') === String(opts.variantId || '')
        && String(l.unitCode || '') === String(opts.unitCode || '')
        && (l.channel || 'RETAIL') === 'RETAIL');
      // CATALOGUE PRICES ARE PER BASE UNIT. A line sold by the carton is priced
      // per carton: 48 bottles of water at ₦300 is ₦14,400, not ₦300. The server
      // has always resolved it that way (resolveUnitPrice multiplies by the ladder
      // factor), so a till showing the base price quoted the customer one figure
      // and then either charged another or refused the sale outright.
      const sell = opts.unitCode
        ? { code: opts.unitCode, factor: Number(opts.factor) > 0 ? Number(opts.factor) : 1 }
        : sellUnit(product, opts.units);
      const basePrice = Number(opts.priceOverride != null ? opts.priceOverride
        : hiring ? arrangement.unitPrice
        : product.selling_price != null ? product.selling_price : product.price || 0);
      const price = hiring ? U.round2(basePrice) : U.round2(basePrice * sell.factor);
      if (existing && !opts.serialNo) {
        existing.quantity = Number(existing.quantity) + 1;
      } else {
        cart.lines.push({
          key: U.localId('ln'),
          productId: String(product.id),
          variantId: opts.variantId || null,
          name: product.name,
          sku: product.sku || null,
          unitCode: sell.code,
          unitFactor: sell.factor,
          baseUnitName: product.base_unit_name || 'PIECE',
          quantity: 1,
          unitPrice: price,
          listPrice: price,
          listUnitPrice: price,
          lineDiscount: 0,
          requiresSerial: serialsOn() && Boolean(Number(product.requires_serial)),
          tracksVariants: Boolean(Number(product.tracks_variants)),
          variantName: opts.variantName || null,
          warrantyMonths: Number(product.warranty_months) || null,
          serialNumbers: opts.serialNo ? [opts.serialNo] : [],
          barcode: opts.barcode || null,
          // `on_hand` is in base units; the line counts cartons, so the badge has
          // to speak the same language as the quantity box beside it.
          onHandBase: product.on_hand != null ? Number(product.on_hand) : null,
          maxQuantity: product.on_hand != null ? Number(product.on_hand) / sell.factor : null,
          channel: arrangement.channel || 'RETAIL',
          startsOn: arrangement.startsOn || null,
          endsOn: arrangement.endsOn || null,
          periods: arrangement.periods || null,
          rate: arrangement.rate || null,
          depositEach: hiring ? U.round2(arrangement.deposit || 0) : 0,
          prescription: dispense.prescription || null,
          controlledKyc: dispense.controlledKyc || null,
        });
      }
      save();
      paint();
      refreshPreview();
    }

    /**
     * Ask which variant, BEFORE the money is taken.
     *
     * A sofa comes in three fabrics, a phone in four colours, a mattress in three
     * sizes. Clicking such a product in search used to drop it in the cart with no
     * variant, and the sale was refused only at the end:
     *
     *   Line 1: "3-Seater Tiffany Fabric Sofa" comes in variants — choose the
     *   specific one (colour, size or finish) the customer is buying.
     *
     * by which time the customer had paid. The endpoint always said so; the screen
     * simply never asked. So it asks now — and if the variants cannot be read, it
     * says that too, rather than letting a line be rung up that cannot complete.
     */
    async function chooseVariant(product, { onPick }) {
      let variants = [];
      let priceOverrides = [];
      try {
        const detail = await SR.api.get(`/api/products/${encodeURIComponent(product.id)}`);
        variants = detail.variants || (detail.product && detail.product.variants) || [];
      } catch (err) {
        // Offline: the device mirror usually has the variants from the last sync.
        variants = await SR.store.all('product_variants', { where: (v) => !Number(v.is_deleted) && String(v.product_id) === String(product.id) }).catch(() => []);
        if (!variants.length) { ui.apiError(err); return null; }
      }
      variants = variants.filter((v) => !Number(v.is_deleted) && Number(v.is_active !== 0));
      if (!variants.length) {
        ui.toast(`${product.name} is marked as coming in variants, but none are set up. Add them under Catalogue before selling it.`, { type: 'err', ms: 9000 });
        return null;
      }

      const list = ui.h('div', { class: 'stack' });
      const pick = (v) => {
        onPick(v);
        m.close();
      };
      for (const v of variants) {
        const price = Number(v.price_override != null ? v.price_override : v.selling_price != null ? v.selling_price : product.selling_price || 0);
        const onHand = v.on_hand != null ? Number(v.on_hand) : null;
        list.appendChild(ui.h('button', {
          class: 'pos-hit',
          disabled: onHand != null && onHand <= 0,
          onClick: () => pick(v),
        },
        ui.h('div', { class: 'grow' },
          ui.h('div', { class: 'ph-name' }, v.name || v.sku || 'Variant'),
          ui.h('div', { class: 'ph-meta' }, [
            v.sku ? `SKU ${v.sku}` : null,
            onHand != null ? `${U.qty(onHand)} on hand` : null,
          ].filter(Boolean).join(' · '))),
        ui.h('span', { class: 'ph-price' }, U.money(price))));
      }
      const m = ui.openModal({
        title: `${product.name} — which one?`,
        body: list,
        size: 'narrow',
        footer: [ui.h('button', { class: 'btn', onClick: () => m.close(null) }, 'Cancel')],
      });
      return variants[0];
    }

    /**
     * Change the unit a line is sold in — a carton or a piece.
     *
     * A wholesale branch defaults to the carton, because that is what it sells.
     * But a customer who wants one kettle is standing at the counter with sixteen
     * on the shelf, and the till used to answer:
     *
     *   Line 1: only 16 pieces of "Binatone Kettle 1.8L" is available at this
     *   branch, and this line needs 48. Short by 32.
     *
     * — a refusal the cashier could do nothing about, because nothing on the screen
     * offered a way to sell one piece. The ladder was in the database all along.
     */
    async function chooseUnit(line) {
      let units = [];
      try {
        const detail = await SR.api.get(`/api/products/${encodeURIComponent(line.productId)}`);
        units = detail.units || (detail.product && detail.product.units) || [];
      } catch (err) {
        units = await SR.store.all('product_units', { where: (u) => !Number(u.is_deleted) && String(u.product_id) === String(line.productId) }).catch(() => []);
        if (!units.length) { ui.apiError(err); return; }
      }
      const sellable = units
        .filter((u) => !Number(u.is_deleted) && Number(u.is_sellable) !== 0)
        .sort((a, b) => Number(a.quantity_in_base) - Number(b.quantity_in_base));
      if (!sellable.length) { ui.toast(`${line.name} has no sellable unit set up. Add one under Catalogue.`, { type: 'err', ms: 8000 }); return; }

      const basePrice = Number(line.listPrice) / (Number(line.unitFactor) > 0 ? Number(line.unitFactor) : 1);
      const body = ui.h('div', { class: 'stack' });
      const m = ui.openModal({ title: `${line.name} — sold in what?`, body, size: 'narrow' });
      for (const u of sellable) {
        const factor = Number(u.quantity_in_base) || 1;
        const stock = line.onHandBase != null ? line.onHandBase / factor : null;
        body.appendChild(ui.h('button', {
          class: `pos-hit ${u.code === line.unitCode ? 'is-active' : ''}`,
          disabled: stock != null && stock <= 0,
          onClick: () => {
            line.unitCode = u.code;
            line.unitFactor = factor;
            // The catalogue price is per BASE unit, so the price of a carton is the
            // price of a piece times what a carton holds.
            line.unitPrice = U.round2(basePrice * factor);
            line.listPrice = line.unitPrice;
            line.listUnitPrice = line.unitPrice;
            line.maxQuantity = stock;
            if (Number(line.quantity) > stock) line.quantity = Number(stock.toFixed(2)) || 1;
            save(); paint(); refreshPreview(); m.close();
          },
        },
        ui.h('div', { class: 'grow' },
          ui.h('div', { class: 'ph-name' }, u.name || u.code),
          ui.h('div', { class: 'ph-meta' }, [
            factor > 1 ? `${U.qty(factor)} base units` : 'the base unit',
            stock != null ? `${U.qty(stock)} available` : null,
          ].filter(Boolean).join(' · '))),
        ui.h('span', { class: 'ph-price' }, U.money(U.round2(basePrice * factor)))));
      }
    }

    /** Add a search hit, asking for the variant when the product has them. */
    function addFromSearch(product) {
      if (!Number(product.tracks_variants)) { addLine(product); return; }
      chooseVariant(product, {
        onPick: (v) => addLine(product, {
          variantId: v.id,
          variantName: v.name,
          units: product.units,
          priceOverride: v.price_override != null ? v.price_override : (v.selling_price != null ? v.selling_price : null),
        }),
      });
    }

    function removeLine(key) {
      cart.lines = cart.lines.filter((l) => l.key !== key);
      save(); paint(); refreshPreview();
    }

    function setQty(key, qty) {
      const line = cart.lines.find((l) => l.key === key);
      if (!line) return;
      const n = Math.max(0, Number(qty) || 0);
      if (n === 0) { removeLine(key); return; }
      line.quantity = n;
      save(); paint(); refreshPreview();
    }

    function setPrice(key, price) {
      const line = cart.lines.find((l) => l.key === key);
      if (!line) return;
      const n = Number(price);
      if (!Number.isFinite(n) || n < 0) return;
      line.unitPrice = n;
      if (n !== Number(line.listPrice)) {
        // A manual override is recorded with the sale. Without it, a below-cost
        // sale at the end of the month is indistinguishable from a mistake.
        cart.manualPriceOverrides[line.productId] = { from: Number(line.listPrice), to: n, reason: 'Manual price at the counter' };
      }
      save(); paint(); refreshPreview();
    }

    function save() { SR.state.saveCart(cart); }

    function clearCart() {
      ui.confirmDialog({
        title: 'Empty the cart?',
        message: 'This removes every line. It cannot be undone.',
        confirmLabel: 'Empty it',
        danger: true,
      }).then((yes) => {
        if (!yes) return;
        resetTill();
      });
    }

    /** The till after a sale is paid, or after payment is cancelled. Nothing from that checkout stays on the screen. */
    function resetTill() {
      const fresh = blankCart();
      Object.keys(cart).forEach((key) => { delete cart[key]; });
      Object.assign(cart, fresh);
      save();
      scanInput.value = '';
      results.hidden = true;
      results.replaceChildren();
      paint();
    }

    function checkoutSnapshot() {
      return {
        lines: cart.lines.map((l) => Object.assign({}, l, { serialNumbers: (l.serialNumbers || []).slice() })),
        payments: cart.payments.map((p) => Object.assign({}, p)),
        totals: computedTotals(),
        customerName: cart.customerName,
        customerPhone: cart.customerPhone,
        saleType: cart.saleType,
        discountAmount: cart.discountAmount,
        deliveryFee: cart.deliveryFee,
      };
    }

    // ---------------- paint cart + totals ----------------
    function paint() {
      cartBody.replaceChildren();
      lineCount.textContent = `${cart.lines.length} line${cart.lines.length === 1 ? '' : 's'}`;
      if (!cart.lines.length) {
        cartBody.appendChild(ui.empty({
          title: 'Nothing in the cart',
          message: 'Scan a barcode or search for a product to begin.',
          mark: 'cart',
        }));
      } else {
        cart.lines.forEach((line, index) => cartBody.appendChild(cartLineNode(line, index)));
      }
      paintTotals();
      paintInfo();
      const complete = document.getElementById('pos-complete');
      if (complete) complete.disabled = cart.lines.length === 0;
    }

    function serialsNeeded(line) {
      return line.requiresSerial && serialsOn() ? Math.ceil(Number(line.quantity) || 0) : 0;
    }
    function missingSerials() {
      if (!serialsOn()) return [];
      return cart.lines.filter((line) => {
        const need = serialsNeeded(line);
        return need > 0 && (line.serialNumbers || []).length < need;
      });
    }

    function cartLineNode(line, index) {
      const total = Number(line.quantity) * Number(line.unitPrice) - Number(line.lineDiscount || 0);
      const row = ui.h('div', { class: 'cart-line' });
      row.appendChild(ui.h('div', { class: 'cl-top' },
        ui.h('div', { class: 'cl-name' }, `${index + 1}. ${line.name}`),
        ui.h('div', { class: 'cl-total' }, U.money(total))));
      const meta = [
        line.sku ? `SKU ${line.sku}` : null,
        line.variantName || null,
        `${U.money(line.unitPrice)} / ${line.unitCode}`,
      ];
      const avail = line.maxQuantity;
      if (avail != null && Number(line.quantity) > avail) meta.push(`only ${U.qty(avail)} in stock`);
      row.appendChild(ui.h('div', { class: 'cl-meta' }, meta.filter(Boolean).join(' · ')));

      const actions = ui.h('div', { class: 'cl-actions' });
      const qty = ui.h('div', { class: 'qty' });
      qty.appendChild(ui.h('button', { 'aria-label': 'Less', onClick: () => setQty(line.key, Number(line.quantity) - 1) }, '−'));
      const qtyInput = ui.h('input', { type: 'number', step: 'any', min: '0', value: U.numInput(line.quantity), 'aria-label': 'Quantity' });
      qtyInput.addEventListener('change', () => setQty(line.key, qtyInput.value));
      qty.appendChild(qtyInput);
      qty.appendChild(ui.h('button', { 'aria-label': 'More', onClick: () => setQty(line.key, Number(line.quantity) + 1) }, '+'));
      actions.appendChild(qty);
      if (line.tracksVariants && !line.variantId) {
        actions.appendChild(ui.h('button', {
          class: 'btn btn-sm btn-primary',
          onClick: () => chooseVariant({ id: line.productId, name: line.name, selling_price: line.unitPrice, tracks_variants: 1 }, {
            onPick: (v) => {
              line.variantId = v.id;
              line.variantName = v.name;
              if (v.price_override != null || v.selling_price != null) {
                line.unitPrice = Number(v.price_override != null ? v.price_override : v.selling_price);
              }
              save(); paint();
            },
          }),
        }, 'Choose variant'));
      }
      actions.appendChild(ui.h('button', { class: 'btn btn-sm', onClick: () => chooseUnit(line) }, line.unitCode || 'Unit'));
      actions.appendChild(ui.h('button', { class: 'btn btn-sm', onClick: () => editLine(line) }, 'Price'));
      actions.appendChild(ui.h('button', { class: 'link-btn', onClick: () => removeLine(line.key) }, 'Remove'));
      row.appendChild(actions);
      if (line.tracksVariants && !line.variantId) {
        row.appendChild(ui.h('div', { class: 'hint' }, 'Choose the variant before taking payment.'));
      }

      const need = serialsNeeded(line);
      if (need) {
        const have = (line.serialNumbers || []).length;
        const missing = have < need;
        const serialRow = ui.h('div', { class: `cl-serial${missing ? ' is-missing' : ''}` },
          ui.h('span', {}, missing
            ? `Serial ${have} of ${need} — one number per unit`
            : `S/N ${line.serialNumbers.join(', ')}`),
          ui.h('button', { class: 'btn btn-sm', onClick: () => captureSerials(line) }, have ? 'Edit serials' : 'Enter serials'));
        row.appendChild(serialRow);
      }
      return row;
    }

    function editLine(line) {
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Unit price (₦)', name: 'unitPrice', type: 'number', step: '0.01', min: '0', value: line.unitPrice, required: true }),
        ui.field({ label: 'Line discount (₦)', name: 'lineDiscount', type: 'number', step: '0.01', min: '0', value: line.lineDiscount || 0 })));
      const listPrice = Number(line.listPrice);
      wrapEl.appendChild(ui.h('div', { class: 'hint' }, `List price is ${U.money(listPrice)}. A different figure is recorded as a counter override with your name on it.`));
      const m = ui.openModal({
        title: line.name,
        body: wrapEl,
        size: 'narrow',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close(null) }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: () => {
              const v = ui.readFormStrings(wrapEl);
              line.lineDiscount = Number(v.lineDiscount) || 0;
              setPrice(line.key, v.unitPrice);
              m.close();
            },
          }, 'Apply'),
        ],
      });
    }

    function captureSerials(line) {
      const wrapEl = ui.h('div', {});
      const need = serialsNeeded(line) || Math.ceil(Number(line.quantity) || 0);
      wrapEl.appendChild(ui.h('p', { class: 'hint' }, `One serial number per unit — ${need} for this line. The receipt prints each number under the item.`));
      const area = ui.h('textarea', { rows: 4, placeholder: 'One serial per line' });
      area.value = (line.serialNumbers || []).join('\n');
      wrapEl.appendChild(area);
      const m = ui.openModal({
        title: 'Serial numbers',
        body: wrapEl,
        size: 'narrow',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close(null) }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: () => {
              line.serialNumbers = String(area.value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
              save(); paint(); m.close();
            },
          }, 'Save'),
        ],
      });
    }

    // ---------------- totals ----------------
    function computedTotals() {
      const vatEnabled = SR.state.feature('vat_enabled') !== false && Boolean(Number((SR.state.settings || {}).vat_enabled));
      const vatRate = Number((SR.state.settings || {}).vat_rate_percent || 7.5);
      let subtotal = 0;
      for (const line of cart.lines) subtotal += Number(line.quantity) * Number(line.unitPrice) - Number(line.lineDiscount || 0);
      subtotal = U.round2(subtotal);
      const delivery = U.round2(Number(cart.deliveryFee) || 0);
      const discount = U.round2(Number(cart.discountAmount) || 0);
      const total = U.round2(Math.max(0, subtotal - discount) + delivery);
      // VAT is INCLUSIVE: the tax is extracted FROM the total, never added on top.
      // Adding it on top is the single most common way a Nigerian SME ends up
      // charging 7.5% more than the price on the shelf.
      const vat = vatEnabled && vatRate > 0 ? U.round2(total * (vatRate / (100 + vatRate))) : 0;
      const net = U.round2(total - vat);
      const deposit = U.round2(cart.lines.reduce((a, l) => a + Number(l.depositEach || 0) * Number(l.quantity || 0), 0));
      const paid = U.round2(cart.payments.reduce((a, p) => a + Number(p.amount || 0), 0));
      const collect = U.round2(total + deposit);
      return { subtotal, delivery, discount, total, deposit, collect, vat, net, vatRate, vatEnabled, paid, balance: U.round2(collect - paid) };
    }

    function paintTotals() {
      const t = computedTotals();
      totalsEl.replaceChildren();
      const row = (label, value, cls = '') => ui.h('div', { class: `totals-row ${cls}` },
        ui.h('span', {}, label), ui.h('span', {}, value));
      totalsEl.appendChild(row('Total', U.money(t.total), 'grand'));
      totalsEl.appendChild(row('Subtotal', U.money(t.subtotal)));
      if (t.discount) totalsEl.appendChild(row('Discount', `−${U.money(t.discount)}`));
      if (t.delivery) totalsEl.appendChild(row('Delivery', U.money(t.delivery)));
      if (t.vatEnabled && t.vat) totalsEl.appendChild(row(`VAT included @ ${t.vatRate}%`, U.money(t.vat)));
      totalsEl.appendChild(row('Customer', cart.customerName || 'Walk-in'));
      totalsEl.appendChild(row('Sale', U.humanise(cart.saleType)));
      const method = dominantMethod();
      if (method) totalsEl.appendChild(row('Paying by', METHOD_LABEL[method] || method));
      const pay = document.getElementById('pos-complete');
      if (pay) pay.textContent = cart.lines.length ? `Take payment · ${U.money(t.collect != null ? t.collect : t.total)}` : 'Take payment';
    }

    function paintInfo() {
      infoBody.replaceChildren();
      const pending = SR.sync.status().running;
      if (!SR.api.isOnline() || pending) {
        infoBody.appendChild(ui.h('div', { class: 'alert alert-warn' },
          SR.api.isOnline()
            ? 'Syncing in the background. Sales are safe on this device regardless.'
            : 'Offline. Sales completed here are stored on this device and sent automatically.'));
      }
      if (cart.deliveryRequired) infoBody.appendChild(ui.h('div', { class: 'hint' }, `Delivery to: ${cart.deliveryAddress || cart.customerName || '—'}`));
      infoCard.hidden = infoBody.childElementCount === 0;
    }

    function dominantMethod() {
      const counts = new Map();
      for (const p of cart.payments) counts.set(p.method, (counts.get(p.method) || 0) + Number(p.amount || 0));
      let best = null; let top = 0;
      for (const [m, v] of counts) if (v > top) { top = v; best = m; }
      return best;
    }

    // ---------------- the server preview (price confirmation) ----------------
    let previewSeq = 0;
    const refreshPreview = U.debounce(async () => {
      if (!cart.lines.length || !SR.api.isOnline()) return;
      const seq = ++previewSeq;
      const t = computedTotals();
      try {
        const result = await SR.api.post('/api/sales/preview', {
          branch_id: SR.state.activeBranchId,
          business_id: SR.state.activeBusinessId,
          customer_id: cart.customerId,
          sale_type: cart.saleType,
          discount_amount: t.discount,
          delivery_fee: t.delivery,
          lines: cart.lines.map((l) => linePayload(l)),
          walk_in_name: cart.customerName || null,
          walk_in_phone: cart.customerPhone || null,
        }, { timeoutMs: 9000 });
        if (seq !== previewSeq) return;
        showPreviewWarnings(result);
      } catch (err) {
        if (seq !== previewSeq) return;
        // A preview failure is NOT a blocked sale. It is a lost reassurance.
        if (!err.isOffline && err.status >= 400 && err.status < 500) {
          previewWarn(err.message || 'The server would not accept this cart as it stands.');
        }
      }
    }, 700);

    function showPreviewWarnings(result) {
      const notes = [];
      if (result && Array.isArray(result.warnings)) notes.push(...result.warnings);
      if (result && Array.isArray(result.advisories)) notes.push(...result.advisories);
      if (result && result.credit && result.credit.overLimit) notes.push(`This sale puts the customer ${U.money(result.credit.over)} over their credit limit.`);
      // A server price that differs from the mirror is worth mentioning once,
      // quietly — the counter price is the one the customer was quoted.
      if (result && Array.isArray(result.lines)) {
        for (const sl of result.lines) {
          const local = cart.lines.find((l) => String(l.productId) === String(sl.product_id));
          if (!local) continue;
          const serverPrice = Number(sl.unit_price != null ? sl.unit_price : local.unitPrice);
          if (serverPrice && Math.abs(serverPrice - Number(local.unitPrice)) > 0.01) {
            local.agreedPrice = local.unitPrice;
            local.serverPrice = serverPrice;
          }
        }
      }
      if (notes.length) previewWarn(notes.join(' '));
    }

    let lastPreviewNote = null;
    function previewWarn(message) {
      if (message === lastPreviewNote) return;
      lastPreviewNote = message;
      const bar = document.getElementById('pos-preview-warn');
      if (bar) bar.remove();
      const el = ui.h('div', { class: 'alert alert-warn', id: 'pos-preview-warn' }, message);
      totalsBody.insertBefore(el, totalsEl);
    }

    // ---------------- customer ----------------
    async function pickCustomer() {
      const body = ui.h('div', {});
      const search = ui.h('input', { type: 'search', placeholder: 'Name, phone or company…' });
      body.appendChild(search);
      const list = ui.h('div', { class: 'pos-results', style: { maxHeight: '300px' } });
      body.appendChild(list);
      const chosen = ui.h('div', { class: 'hint' }, 'Walk-in unless a customer is picked. Credit and instalments need one.');
      body.appendChild(chosen);
      const m = ui.openModal({ title: 'Which customer?', body, size: 'narrow' });

      async function search2(term) {
        const q = String(term || '').trim();
        let rows = [];
        try {
          const data = await SR.api.get('/api/customers', { query: SR.state.query({ q: q || undefined, limit: 25 }) });
          rows = data.data || [];
        } catch (err) {
          rows = (await SR.store.all('customers', { where: (c) => !Number(c.is_deleted) }))
            .filter((c) => !q || `${c.name} ${c.phone || ''} ${c.company_name || ''}`.toLowerCase().includes(q.toLowerCase()))
            .slice(0, 25);
        }
        list.replaceChildren();
        if (!rows.length) list.appendChild(ui.h('div', { class: 'pos-hit' }, ui.h('div', { class: 'ph-meta' }, 'No match. Add the customer to sell on credit.')));
        for (const c of rows) {
          list.appendChild(ui.h('button', {
            class: 'pos-hit',
            onClick: () => { choose(c); },
          }, ui.h('div', { class: 'grow' },
            ui.h('div', { class: 'ph-name' }, c.name),
            ui.h('div', { class: 'ph-meta' }, [c.phone, c.company_name, c.class_name, Number(c.credit_balance) ? `owes ${U.money(c.credit_balance)}` : null].filter(Boolean).join(' · '))),
          ui.h('span', { class: 'ph-price' }, c.credit_limit ? U.money(c.available_credit != null ? c.available_credit : c.credit_limit) : '—')));
        }
      }
      search.addEventListener('input', U.debounce((v) => search2(v), 250));
      search2('');

      function choose(c) {
        cart.customerId = String(c.id);
        cart.customerName = c.name;
        cart.customerPhone = c.phone || null;
        chosen.textContent = `${c.name}${c.phone ? ` · ${c.phone}` : ''}${Number(c.credit_balance) ? ` · owes ${U.money(c.credit_balance)}` : ''}`;
        save(); paint();
        m.close();
      }

      const addNew = ui.h('button', { class: 'btn btn-sm' }, 'New customer');
      addNew.addEventListener('click', async () => {
        const name = await ui.promptDialog({ title: 'New customer', label: 'Name', required: true });
        if (!name) return;
        const phone = await ui.promptDialog({ title: 'New customer', label: 'Phone (optional)', hint: 'A phone number is how you find them when a balance is overdue.' });
        try {
          const created = await SR.api.post('/api/customers', {
            name, phone: phone || null,
            branch_id: SR.state.activeBranchId,
            business_id: SR.state.activeBusinessId,
          });
          const row = created.customer || created;
          cart.customerId = String(row.id);
          cart.customerName = row.name || name;
          cart.customerPhone = row.phone || null;
          save(); paint();
          ui.ok(`${cart.customerName} added.`);
          m.close();
        } catch (err) { ui.apiError(err); }
      });
      return { addNew };
    }

    function openMeta() {
      const wrapEl = ui.h('div', {});
      const grids = ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Sale type', name: 'saleType', value: saleTypes().includes(cart.saleType) ? cart.saleType : 'RETAIL', options: saleTypes().map((t) => ({ value: t, label: U.humanise(t) })) }),
        ui.field({ label: 'Order discount (₦)', name: 'discountAmount', type: 'number', step: '0.01', min: '0', value: cart.discountAmount || 0 }),
        ui.field({ label: 'Discount reason', name: 'discountReason', value: cart.discountReason || '', span: true, hint: 'Recorded with the sale. A discount with no reason is the first thing an auditor asks about.' }),
        SR.state.moduleOn('deliveries') ? ui.field({ label: 'Delivery fee (₦)', name: 'deliveryFee', type: 'number', step: '0.01', min: '0', value: cart.deliveryFee || 0 }) : null,
        SR.state.moduleOn('deliveries') ? ui.field({ label: 'Delivery address', name: 'deliveryAddress', value: cart.deliveryAddress || '', span: true }) : null,
        ui.field({ label: 'Notes', name: 'notes', type: 'textarea', value: cart.notes || '', span: true }));
      wrapEl.appendChild(grids);
      const delivery = ui.h('label', { class: 'switch' },
        Object.assign(ui.h('input', { type: 'checkbox', checked: Boolean(cart.deliveryRequired) }), {}),
        ui.h('span', { class: 'switch-track', 'aria-hidden': 'true' }, ui.h('span', { class: 'switch-knob' })),
        ui.h('span', {}, 'This sale needs delivery and a delivery job'));
      if (SR.state.moduleOn('deliveries')) wrapEl.appendChild(delivery);
      const custRow = ui.h('div', { class: 'row', style: { marginTop: '12px' } },
        ui.h('span', { class: 'badge badge-info' }, cart.customerName || 'Walk-in'),
        ui.h('button', {
          class: 'btn btn-sm',
          onClick: async () => {
            const picker = await pickCustomer();
            wrapEl.appendChild(picker.addNew);
          },
        }, 'Choose customer'));
      wrapEl.appendChild(custRow);

      const m = ui.openModal({
        title: 'Sale details',
        body: wrapEl,
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close(null) }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: () => {
              const v = ui.readFormStrings(wrapEl);
              cart.saleType = v.saleType || 'RETAIL';
              cart.discountAmount = Number(v.discountAmount) || 0;
              cart.discountReason = v.discountReason || null;
              cart.deliveryFee = SR.state.moduleOn('deliveries') ? (Number(v.deliveryFee) || 0) : 0;
              cart.deliveryAddress = SR.state.moduleOn('deliveries') ? (v.deliveryAddress || null) : null;
              cart.notes = v.notes || null;
              cart.deliveryRequired = SR.state.moduleOn('deliveries') && delivery.querySelector('input').checked;
              save(); paint();
              m.close();
            },
          }, 'Save'),
        ],
      });
    }

    // ---------------- tender ----------------
    async function openTender() {
      const ready = await ensureDispense(cart.lines);
      if (!ready) {
        ui.warn('Payment was not opened. A prescription-only or controlled item still needs the details the register requires.');
        return;
      }
      if (!cart.lines.length) { ui.warn('Add something to the cart first.'); return; }
      const missing = missingSerials();
      if (missing.length) {
        ui.warn(`${missing[0].name} needs one serial number per unit before it can be sold.`);
        captureSerials(missing[0]);
        return;
      }
      const t = computedTotals();
      const needsCustomer = ['CREDIT', 'INSTALMENT', 'LAYAWAY'].includes(cart.saleType);
      if (needsCustomer && !cart.customerId) {
        ui.warn(`${U.humanise(cart.saleType)} needs a customer. Pick one under Details.`);
        return;
      }

      const wrapEl = ui.h('div', {});
      const ticket = ui.h('div', { class: 'stack', style: { marginBottom: '12px' } });
      for (const line of cart.lines) {
        const lineTotal = Number(line.quantity) * Number(line.unitPrice) - Number(line.lineDiscount || 0);
        ticket.appendChild(ui.h('div', { class: 'slip-row' },
          ui.h('span', {}, `${U.qty(line.quantity)} × ${line.name}`),
          ui.h('span', { class: 'mono' }, U.money(lineTotal))));
      }
      wrapEl.appendChild(ticket);
      wrapEl.appendChild(ui.h('div', { class: 'hint', style: { marginBottom: '8px' } }, 'How is the customer paying?'));
      const running = ui.h('div', { class: 'totals' });

      const methods = ui.h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(108px, 1fr))', gap: '7px' } });
      let activeMethod = t.balance <= 0 && cart.payments.length ? null : (cart.payments[cart.payments.length - 1] || {}).method || 'CASH';
      const methodButtons = new Map();
      for (const m of METHODS) {
        if (m === 'INSTALMENT' && cart.saleType !== 'INSTALMENT') continue;
        if (m === 'DEPOSIT' && cart.saleType !== 'LAYAWAY') continue;
        const btn = ui.h('button', { class: `pay-btn ${m === activeMethod ? 'is-active' : ''}`, onClick: () => { activeMethod = m; paintRunning(); paintButtons(); } },
          METHOD_LABEL[m] || U.humanise(m));
        methodButtons.set(m, btn);
        methods.appendChild(btn);
      }
      wrapEl.appendChild(methods);

      wrapEl.appendChild(ui.h('label', { class: 'hint', style: { display: 'block', marginTop: '12px' } }, 'Amount received'));
      const amountInput = ui.h('input', { type: 'number', step: '0.01', min: '0', placeholder: 'Amount', inputmode: 'decimal', style: { marginTop: '4px', fontSize: '1.2rem', fontFamily: 'var(--mono)' } });
      amountInput.value = String(U.round2(Math.max(0, t.balance)));
      wrapEl.appendChild(amountInput);

      const numpad = ui.h('div', { class: 'numpad', style: { marginTop: '8px' } });
      for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', '.']) {
        numpad.appendChild(ui.h('button', {
          onClick: () => { amountInput.value = amountInput.value === '0' ? k : amountInput.value + k; },
        }, k));
      }
      numpad.appendChild(ui.h('button', { onClick: () => { amountInput.value = amountInput.value.slice(0, -1); } }, '⌫'));
      numpad.appendChild(ui.h('button', { onClick: () => { amountInput.value = String(U.round2(Math.max(0, remaining()))); } }, 'Exact'));
      numpad.appendChild(ui.h('button', {
        class: 'btn-primary', style: { border: 0, color: '#fff', background: 'var(--green-700)' },
        onClick: () => addPayment(activeMethod, Number(amountInput.value) || 0),
      }, 'Add'));
      wrapEl.appendChild(numpad);

      const referenceInput = ui.h('input', { type: 'text', placeholder: 'Reference (POS auth code, transfer ref, cheque no) — optional', style: { marginTop: '8px' } });
      wrapEl.appendChild(referenceInput);
      const referenceWrap = ui.h('div', {}, referenceInput);
      referenceWrap.hidden = true;
      wrapEl.appendChild(referenceWrap);

      const paymentsList = ui.h('div', { class: 'card-body tight', style: { border: '1px solid var(--line)', borderRadius: '8px', marginTop: '10px' } });
      wrapEl.appendChild(paymentsList);

      wrapEl.appendChild(ui.h('div', { style: { marginTop: '10px' } }, running));

      const creditBox = ui.h('div', {});
      wrapEl.appendChild(creditBox);

      function remaining() { return U.round2(t.total - cart.payments.reduce((a, p) => a + Number(p.amount || 0), 0)); }

      function addPayment(method, amount) {
        const amt = U.round2(Number(amount) || 0);
        if (!method) { ui.warn('Choose how the customer is paying.'); return; }
        if (amt <= 0) { ui.warn('Enter an amount.'); return; }
        const ref = referenceInput.value.trim() || null;
        if (['POS_TERMINAL', 'BANK_TRANSFER', 'CHEQUE', 'MOBILE_MONEY', 'USSD'].includes(method) && !ref) {
          // Advisory, not blocking: the shop may be using a terminal that does
          // not print a reference, and refusing the sale would be worse.
          ui.warn(`${METHOD_LABEL[method]} with no reference. It is recorded, but a reference makes a settlement query answerable.`);
        }
        cart.payments.push({ method, amount: amt, reference: ref });
        referenceInput.value = '';
        amountInput.value = String(U.round2(Math.max(0, remaining())));
        save(); paintRunning(); paintTotals();
      }

      function paintButtons() {
        for (const [m, btn] of methodButtons) btn.classList.toggle('is-active', m === activeMethod);
        referenceWrap.hidden = !['POS_TERMINAL', 'BANK_TRANSFER', 'CHEQUE', 'MOBILE_MONEY', 'USSD'].includes(activeMethod);
      }

      function paintRunning() {
        paymentsList.replaceChildren();
        if (!cart.payments.length) {
          paymentsList.appendChild(ui.h('div', { class: 'hint', style: { padding: '10px 12px' } }, 'No payment added yet.'));
        } else {
          cart.payments.forEach((p, i) => {
            paymentsList.appendChild(ui.h('div', { class: 'cart-line' },
              ui.h('div', {},
                ui.h('div', { class: 'cl-name' }, METHOD_LABEL[p.method] || U.humanise(p.method)),
                ui.h('div', { class: 'cl-meta' }, p.reference || 'no reference')),
              ui.h('div', {},
                ui.h('div', { class: 'cl-total' }, U.money(p.amount)),
                ui.h('button', {
                  class: 'link-btn', style: { display: 'block', marginLeft: 'auto' },
                  onClick: () => { cart.payments.splice(i, 1); save(); paintRunning(); paintTotals(); },
                }, 'Remove'))));
          });
        }
        running.replaceChildren();
        const rr = (l, v, cls = '') => ui.h('div', { class: `totals-row ${cls}` }, ui.h('span', {}, l), ui.h('span', {}, v));
        running.appendChild(rr('Total', U.money(t.total)));
        running.appendChild(rr('Paid', U.money(cart.payments.reduce((a, p) => a + Number(p.amount || 0), 0))));
        const bal = remaining();
        running.appendChild(rr('Balance', U.money(Math.max(0, bal)), 'grand'));

        creditBox.replaceChildren();
        if (bal > 0.01) {
          const overLimit = cart.customerId ? null : 'A credit sale needs a customer, so the debt can be followed up.';
          creditBox.appendChild(ui.h('div', { class: 'alert alert-warn' },
            `₦${U.amount(Math.max(0, bal))} is unpaid. `,
            overLimit ? overLimit : 'Completing now writes the balance to the customer\'s ledger as a debt.'));
          if (overLimit) {
            const pick = ui.h('button', { class: 'btn btn-sm', onClick: async () => { await pickCustomer(); m.close(); openTender(); } }, 'Choose a customer');
            creditBox.appendChild(pick);
          } else {
            const reason = ui.h('input', { type: 'text', placeholder: 'Reason for selling on credit (recorded)', style: { marginTop: '8px' } });
            creditBox.appendChild(reason);
            creditBox.dataset.reason = '1';
            creditBox.appendChild(ui.h('div', { class: 'hint' }, 'Left blank unless the customer is over their limit.'));
            creditBox.querySelector('input').id = 'pos-credit-reason';
          }
        }
      }

      const completeBtn = ui.h('button', { class: 'btn btn-primary btn-lg' }, 'Complete sale');
      let outcome = 'cancel';
      const paymentsAtOpen = cart.payments.map((p) => Object.assign({}, p));
      completeBtn.addEventListener('click', async () => {
        completeBtn.disabled = true;
        completeBtn.textContent = 'Recording…';
        try {
          const done = await completeSale();
          outcome = 'paid';
          m.close();
          // Only now, with the payment sheet gone, is a modal free to occupy the
          // one slot the modal system has.
          if (done) showReceipt(done.result, done.payload, done.snapshot);
        } catch (err) {
          ui.apiError(err);
        } finally {
          completeBtn.disabled = false;
          completeBtn.textContent = 'Complete sale';
        }
      });

      const m = ui.openModal({
        title: `Take payment — ${U.money(t.total)}`,
        body: wrapEl,
        size: 'wide',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => { outcome = 'abandon'; m.close(); } }, 'Cancel sale'),
          ui.h('button', { class: 'btn', onClick: () => { outcome = 'hold'; save(); m.close(); } }, 'Hold'),
          completeBtn,
        ],
        onClose: () => {
          // Paid already emptied the till. Hold keeps the basket. Closing the
          // sheet drops payment lines typed in it. Cancel sale clears the
          // checkout entirely, because that sale was not taken.
          if (outcome === 'abandon') resetTill();
          else if (outcome === 'cancel') {
            cart.payments = paymentsAtOpen;
            save();
            paint();
          }
        },
      });
      paintButtons();
      paintRunning();
      setTimeout(() => amountInput.focus(), 60);
    }

    // ---------------- complete ----------------
    async function completeSale() {
      const t = computedTotals();
      const creditReasonInput = document.getElementById('pos-credit-reason');
      const payload = {
        branch_id: SR.state.activeBranchId,
        business_id: SR.state.activeBusinessId,
        sale_type: cart.saleType,
        customer_id: cart.customerId,
        customer_name: cart.customerName || null,
        customer_phone: cart.customerPhone || null,
        sold_at: U.nowWatSql(),
        device_id: SR.device.current().id,
        discount_amount: t.discount,
        discount_reason: cart.discountReason || null,
        delivery_fee: t.delivery,
        delivery_required: Boolean(cart.deliveryRequired),
        delivery_address: cart.deliveryAddress || null,
        notes: cart.notes || null,
        credit_override_reason: (creditReasonInput && creditReasonInput.value.trim()) || cart.creditOverrideReason || null,
        manual_price_overrides: cart.manualPriceOverrides,
        payments: cart.payments.map((p) => ({ method: p.method, amount: Number(p.amount), reference: p.reference || null })),
        lines: cart.lines.map((l) => linePayload(l)),
      };

      const online = SR.api.isOnline();
      let result;
      if (online) {
        try {
          result = await SR.api.post('/api/sales', payload, { timeoutMs: 25000 });
        } catch (err) {
          if (err.isOffline || err.retryable) {
            // The line dropped between the button and the request. The sale
            // happened; queue it rather than telling the cashier to try again.
            result = await queueOffline(payload);
          } else {
            throw err;
          }
        }
      } else {
        result = await queueOffline(payload);
      }

      const snapshot = checkoutSnapshot();
      resetTill();
      UI_afterSale();
      // The receipt is SHOWN BY THE CALLER, after it has closed the payment sheet.
      // `ui.openModal` renders into a single root with replaceChildren(), and the
      // tender sheet's close() clears that root — so showing the receipt from in
      // here meant the payment sheet's close wiped it a moment later. Every
      // completed sale ended with the screen back on an empty cart: no receipt, no
      // confirmation, nothing to print, and every reason for the cashier to ring
      // the sale again.
      return { result, payload, snapshot };
    }

    async function queueOffline(payload) {
      await applyLocalSale(cart.lines).catch(() => {});
      const record = await SR.store.enqueue({
        type: 'SALE',
        payload,
        label: `Sale · ${cart.lines.length} line(s) · ${U.money(computedTotals().total)}`,
        occurredAt: payload.sold_at,
      });
      return { offline: true, queued: true, clientId: record.client_id, cachedSale: payload, total: computedTotals().total };
    }

    function UI_afterSale() {
      void 0;
    }

    // ---------------- receipt ----------------
    function showReceipt(result, payload, snapshot) {
      const taken = snapshot || checkoutSnapshot();
      const brand = (SR.state.settings || {}).business_name || 'StockRidge';
      const footer = (SR.state.settings || {}).receipt_footer_text || 'Thank you for your custom.';
      let text;
      let title;
      let saleId = result.saleId || null;

      if (result.offline) {
        text = SR.print.pendingReceipt({
          client_id: result.clientId,
          occurred_at: payload.sold_at,
          device_id: payload.device_id,
          payload: {
            lines: taken.lines,
            payments: taken.payments,
            expectedTotal: result.total,
          },
        }, { brand });
        title = 'Offline sale recorded';
      } else {
        const sale = result.sale || Object.assign({}, payload, {
          receipt_no: result.receiptNo,
          sold_at: result.soldAt || payload.sold_at,
          branch_name: SR.state.activeBranchName(),
          branch_code: (SR.state.activeBranch() || {}).code,
          cashier_name: (SR.state.user || {}).fullName,
          customer_name: taken.customerName,
          customer_phone: taken.customerPhone,
          sale_type: taken.saleType,
          subtotal: taken.totals.subtotal,
          total: result.total != null ? result.total : taken.totals.total,
          vat_amount: result.vatAmount != null ? result.vatAmount : taken.totals.vat,
          vat_rate_percent: taken.totals.vatRate,
          discount_amount: payload.discount_amount,
          delivery_fee: payload.delivery_fee,
          items: taken.lines.map((l) => ({
            product_name: l.name, quantity: l.quantity, unit_code: l.unitCode,
            unit_price: l.unitPrice, line_total: Number(l.quantity) * Number(l.unitPrice) - Number(l.lineDiscount || 0),
            line_discount: l.lineDiscount, warranty_months: l.warrantyMonths,
            serial_no: (l.serialNumbers || []).join(', ') || null,
            serialNumbers: l.serialNumbers || [],
          })),
          payments: taken.payments,
          change_given: result.changeGiven || 0,
          change_owed: result.changeOwed || 0,
          balance_due: result.balanceDue || 0,
        });
        title = `Sale ${result.receiptNo}`;
        try {
          const shown = SR.print.previewSale(sale, { brand, footer, title, autoPrint: true });
          if (saleId) {
            const foot = document.querySelector('.modal-foot');
            if (foot) foot.insertBefore(ui.h('button', { class: 'btn', onClick: () => { SR.app.navigate(`/sales/${saleId}`); } }, 'Open the sale'), foot.firstElementChild);
          }
          void shown;
          return;
        } catch (err) {
          // The sale IS recorded. Losing the slip to a layout fault must not
          // send the cashier back to an empty cart with nothing to show.
          console.error('[pos] the receipt could not be formatted', err);
          text = [
            brand,
            `Receipt ${result.receiptNo || ''}`,
            `Total   ${U.money(result.total != null ? result.total : taken.totals.total)}`,
            '',
            'The receipt could not be laid out, but the sale is recorded.',
            'Open it from Sales to see or reprint it.',
          ].join('\n');
        }
      }

      const body = ui.h('div', {});
      if (result.offline) {
        body.appendChild(ui.h('div', { class: 'alert alert-warn' },
          'This sale is on the device and has NOT reached the office yet. It will be sent automatically. ',
          ui.h('strong', {}, `Local reference ${String(result.clientId).slice(-8)}.`)));
      }
      body.appendChild(ui.h('div', { class: 'receipt' }, text));
      const shown = ui.openModal({
        title,
        body,
        size: 'narrow',
        onClose: () => {
          const root = document.getElementById('modal-root');
          if (root) root.classList.remove('is-receipt');
        },
        footer: [
          ui.h('button', { class: 'btn', onClick: () => U.download(`${title.replace(/\s+/g, '-').toLowerCase()}.txt`, text, 'text/plain;charset=utf-8') }, 'Save'),
          ui.h('button', { class: 'btn', onClick: () => ui.copyToClipboard(text, 'Receipt copied — paste it into WhatsApp.') }, 'Copy'),
          ui.h('button', { class: 'btn btn-primary', onClick: () => SR.print.printText(text, { title }) }, 'Print'),
        ],
      });
      if (shown && shown.dialog) shown.dialog.classList.add('receipt-sheet');
      const receiptRoot = document.getElementById('modal-root');
      if (receiptRoot) receiptRoot.classList.add('is-receipt');
      if (SR.print.prefs().autoPrint !== false) {
        setTimeout(() => SR.print.printText(text, { title }), 350);
      }
    }

    // ---------------- mount ----------------
    paint();
    paintTotals();

    // Serials and money in the URL are ignored; a cart is device state.
    ctx.onCleanup(() => {
      clearTimeout(0);
    });

    return wrap;
  }

  function flash(el, good) {
    el.classList.remove('scan-flash', 'scan-flash-bad');
    void el.offsetWidth;
    el.classList.add(good ? 'scan-flash' : 'scan-flash-bad');
    setTimeout(() => el.classList.remove('scan-flash', 'scan-flash-bad'), 600);
  }

  SR.views = SR.views || {};
  SR.views.pos = { render, METHODS, METHOD_LABEL, blankCart };
}(window));
