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
  function sellingChoice() {
    const biz = SR.state.activeBusiness && SR.state.activeBusiness();
    const mods = biz && biz.modules;
    const known = mods && (Object.prototype.hasOwnProperty.call(mods, 'sellOnSpot') || Object.prototype.hasOwnProperty.call(mods, 'sellOnCredit'));
    const spot = known ? Boolean(mods.sellOnSpot) : true;
    const credit = known ? Boolean(mods.sellOnCredit) : true;
    return {
      spot,
      credit,
      both: spot && credit,
      dispatch: known ? Boolean(mods.dispatchChoosesTerms) : false,
    };
  }
  function saleTypes() {
    const policy = sellingChoice();
    return TYPES.filter((type) => {
      if (type === 'WHOLESALE') return SR.state.moduleOn('wholesale');
      if (type === 'INSTALMENT' || type === 'LAYAWAY') return SR.state.moduleOn('instalments');
      if (type === 'CREDIT') return policy.credit;
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
      settlement: 'SPOT',
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
      claimCode: null,
      changeHolderName: null,
      changeHolderPhone: null,
      salePlace: 'PREMISES',
      vehicleId: null,
      startedAt: U.nowWatSql(),
    };
  }

  async function render(ctx) {
    const plant = Boolean(SR.state.moduleOn && (SR.state.moduleOn('manufacturing') || SR.state.moduleOn('dispatch')));
    const dispatchOn = Boolean(SR.state.moduleOn && SR.state.moduleOn('dispatch'));
    const profileCode = (SR.state.activeBusiness() || {}).profile_code || '';
    ctx.setTitle(plant ? 'Plant counter' : 'Sell');
    const cart = SR.state.loadCart() || blankCart();
    if (!cart.salePlace) cart.salePlace = 'PREMISES';
    let duties = [];
    if (dispatchOn) {
      try {
        const dutyRes = await SR.api.get('/api/dispatch/duties', { query: SR.state.query({ mine: 1, active: 1 }) });
        duties = dutyRes.data || [];
      } catch (e) { duties = []; }
    }

    function chosenDuty() {
      return duties.find((row) => String(row.vehicle_id) === String(cart.vehicleId)) || null;
    }
    function placeLabel() {
      if (cart.salePlace !== 'VEHICLE') return 'Plant premises';
      const duty = chosenDuty();
      if (!duty) return 'Vehicle — not assigned';
      return duty.plate_no ? `${duty.vehicle_name} · ${duty.plate_no}` : duty.vehicle_name;
    }
    function assertPlace() {
      if (!dispatchOn) return true;
      if (cart.salePlace !== 'VEHICLE') return true;
      if (chosenDuty()) return true;
      ui.warn('No vehicle is assigned to you for this sale. Sell on the plant premises, or ask a manager to assign the vehicle.');
      return false;
    }
    function plantPlaceCard() {
      const card = ui.h('div', { class: 'card' });
      const body = ui.h('div', { class: 'card-body stack' });
      card.appendChild(body);
      const title = profileCode === 'WATER_PACKING'
        ? 'Where is this water being sold?'
        : (profileCode === 'BAKERY' ? 'Where is this being sold?' : 'Where is this sale?');
      function paintPlace() {
        const onVehicle = cart.salePlace === 'VEHICLE' && chosenDuty();
        const premisesBtn = ui.h('button', {
          class: onVehicle ? 'btn btn-sm' : 'btn btn-primary btn-sm',
          type: 'button',
          onClick: () => { cart.salePlace = 'PREMISES'; cart.vehicleId = null; save(); paintPlace(); paint(); },
        }, 'On the plant premises');
        const vehicleBtn = ui.h('button', {
          class: onVehicle ? 'btn btn-primary btn-sm' : 'btn btn-sm',
          type: 'button',
          onClick: () => {
            if (!duties.length) return;
            cart.salePlace = 'VEHICLE';
            if (!chosenDuty()) cart.vehicleId = duties[0].vehicle_id;
            save();
            paintPlace();
            paint();
          },
        }, 'From my vehicle');
        if (!duties.length) vehicleBtn.disabled = true;
        const hint = duties.length
          ? (onVehicle
            ? `Recorded on ${placeLabel()}. The stock still comes off the plant. This vehicle keeps the sale, the customer and any fuel or repair you record on it.`
            : `You have ${duties.map((row) => row.vehicle_name).join(', ')}. Use the vehicle when you are selling from it, and the plant premises when you are at the factory.`)
          : 'No vehicle is assigned to you. This sale stays on the plant premises. A manager assigns a vehicle under Vehicles.';
        body.replaceChildren(
          ui.h('h2', {}, title),
          ui.h('div', { class: 'actions' }, premisesBtn, vehicleBtn),
          ui.h('p', { class: 'hint' }, hint),
        );
        if (duties.length > 1 && cart.salePlace === 'VEHICLE') {
          const sel = ui.h('select', { class: 'input', onChange: (e) => { cart.vehicleId = e.target.value; save(); paintPlace(); paint(); } });
          for (const row of duties) {
            sel.appendChild(ui.h('option', { value: row.vehicle_id }, row.plate_no ? `${row.vehicle_name} · ${row.plate_no}` : row.vehicle_name));
          }
          sel.value = cart.vehicleId || duties[0].vehicle_id;
          body.appendChild(ui.field({ label: 'Vehicle', control: sel }));
        }
      }
      paintPlace();
      return card;
    }

    const wrap = ui.h('div', { class: 'stack' });
    let sellStep = cart.lines.length ? 'cart' : 'pay';

    function showStep(step) {
      const next = step === 'find' || step === 'cart' || step === 'pay' ? step : 'pay';
      sellStep = next;
      grid.dataset.step = next;
      for (const pane of grid.querySelectorAll('.sell-pane')) pane.hidden = pane.dataset.pane !== next;
      for (const btn of sellNav.querySelectorAll('[data-step]')) {
        btn.className = btn.dataset.step === next ? 'btn btn-primary btn-sm' : 'btn btn-sm';
      }
      const cartBtn = sellNav.querySelector('[data-step="cart"]');
      if (cartBtn) cartBtn.textContent = cart.lines.length ? `Cart · ${cart.lines.length}` : 'Cart';
    }

    const sellNav = ui.h('div', { class: 'sell-nav', id: 'sell-nav' },
      ui.h('button', { class: 'btn btn-sm', type: 'button', 'data-step': 'find', onClick: () => showStep('find') }, 'Find goods'),
      ui.h('button', { class: 'btn btn-sm', type: 'button', 'data-step': 'cart', onClick: () => showStep('cart') }, 'Cart'),
      ui.h('button', { class: 'btn btn-primary btn-sm', type: 'button', 'data-step': 'pay', onClick: () => showStep('pay') }, 'Take payment'));
    wrap.appendChild(sellNav);

    // ---------------- layout ----------------
    const grid = ui.h('div', { class: 'pos', 'data-step': sellStep });
    const left = ui.h('div', { class: 'stack sell-pane', 'data-pane': 'find' });
    const cartPane = ui.h('div', { class: 'stack sell-pane', 'data-pane': 'cart' });
    const right = ui.h('div', { class: 'stack pos-side sell-pane', 'data-pane': 'pay' });
    grid.appendChild(left);
    grid.appendChild(cartPane);
    grid.appendChild(right);

    // ---------------- the scan box ----------------
    const serialsOn = () => SR.state.usesSerialNumbers();
    const scanInput = ui.h('input', {
      type: 'search',
      placeholder: plant
        ? 'Scan a barcode, or type what this plant sells…'
        : (serialsOn() ? 'Scan a barcode, or type a name, SKU or serial…' : 'Scan a barcode, or type a name, SKU or barcode…'),
      id: 'pos-scan',
      autocomplete: 'off',
      autocorrect: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      enterkeyhint: 'search',
      'aria-label': 'Scan or search',
    });
    const categorySelect = ui.h('select', { id: 'pos-retail-category' });
    categorySelect.appendChild(ui.h('option', { value: '' }, 'Both sides'));
    const scanBox = ui.h('div', { class: 'pos-scan' }, scanInput,
      ui.h('button', { class: 'btn btn-primary scan-btn', type: 'button', onClick: () => commitField(scanInput.value, { fast: wedgeCount >= 4 }) }, 'Find'));
    const results = ui.h('div', { class: 'pos-results', hidden: true });
    const categoryField = ui.h('label', { class: 'field pos-category' },
      ui.h('span', { class: 'field-label' }, 'Selling category'),
      categorySelect,
      ui.h('span', { class: 'hint' }, 'A NAFDAC catalogue drug is pharmaceutical. A shop-added drug counts only when it is filed under a pharmaceutical category. Everything else is the other side.'));
    if (plant) categoryField.hidden = true;
    const scanCard = ui.h('div', { class: 'card' },
      ui.h('div', { class: 'card-body' },
        categoryField,
        scanBox,
        ui.h('div', { class: 'hint' }, serialsOn()
          ? 'A USB scanner types into this box and presses Enter. The shelf barcode is looked up exactly, and a serial number is too.'
          : 'A USB scanner types into this box and presses Enter. The shelf barcode is looked up exactly and the product is added.'),
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
    cartHead.appendChild(ui.h('button', { class: 'btn btn-sm btn-primary', type: 'button', onClick: () => showStep('pay') }, 'Take payment'));
    cartCard.appendChild(cartHead);
    const cartBody = ui.h('div', { class: 'card-body tight' });
    cartCard.appendChild(cartBody);
    cartCard.appendChild(ui.h('div', { class: 'card-body' },
      ui.h('div', { class: 'btn-row' },
        ui.h('button', { class: 'btn', type: 'button', onClick: () => showStep('find') }, 'Add more'),
        ui.h('button', { class: 'btn btn-primary', type: 'button', onClick: () => showStep('pay') }, 'Take payment'))));
    cartPane.appendChild(cartCard);

    // ---------------- pay a printed bill ----------------
    const payBillCard = ui.h('div', { class: 'card', id: 'pos-pay-bill', hidden: true });
    const payBillBody = ui.h('div', { class: 'card-body stack' });
    const payCodeInput = ui.h('input', {
      type: 'text',
      id: 'pos-pay-code',
      placeholder: 'Payment code',
      autocomplete: 'off',
      style: { fontFamily: 'var(--mono)', letterSpacing: '0.08em', textTransform: 'uppercase' },
    });
    const payBillResult = ui.h('div', { class: 'stack' });
    payBillBody.appendChild(ui.h('h2', {}, 'Pay a printed bill'));
    payBillBody.appendChild(ui.h('div', { class: 'hint' }, 'The customer comes back with the bill. Type the payment code printed on it. The code is made from the time the bill was printed, mixed with the bill figures. This marks those goods paid and prints the receipt. The bill is not a receipt.'));
    payBillBody.appendChild(ui.h('div', { class: 'btn-row' },
      payCodeInput,
      ui.h('button', { class: 'btn btn-primary', onClick: () => findPrintedBill() }, 'Find bill'),
      ui.h('button', { class: 'btn', id: 'pos-open-bills', hidden: true, type: 'button', onClick: () => openBills() }, 'Open bills')));
    payBillBody.appendChild(payBillResult);
    payBillCard.appendChild(payBillBody);
    right.appendChild(payBillCard);
    payCodeInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); findPrintedBill(); }
    });

    // ---------------- totals + payment ----------------
    const totalsCard = ui.h('div', { class: 'card' });
    const totalsBody = ui.h('div', { class: 'card-body' });
    const totalsEl = ui.h('div', { class: 'totals' });
    totalsBody.appendChild(totalsEl);
    const termsHost = ui.h('div', { id: 'pos-terms' });
    totalsBody.appendChild(termsHost);
    totalsBody.appendChild(ui.h('div', { class: 'hint', id: 'pos-pay-hint' }, 'Find goods, check the cart, then take payment here. Cancelling or completing a sale returns to this card.'));
    totalsBody.appendChild(ui.h('div', { class: 'btn-row', style: { marginTop: '14px' } },
      ui.h('button', { class: 'btn btn-primary btn-lg grow', id: 'pos-complete', onClick: () => primaryAction() }, 'Take payment'),
      ui.h('button', { class: 'btn btn-lg', id: 'pos-pay-desk', hidden: true, onClick: () => openTender() }, 'Pay at this desk'),
      ui.h('button', { class: 'btn btn-lg', onClick: () => openMeta() }, 'Details')));
    totalsCard.appendChild(totalsBody);
    right.appendChild(totalsCard);

    // ---------------- quick info ----------------
    const infoCard = ui.h('div', { class: 'card' });
    const infoBody = ui.h('div', { class: 'card-body stack' });
    infoCard.appendChild(infoBody);
    right.appendChild(infoCard);

    if (dispatchOn) wrap.appendChild(plantPlaceCard());
    else if (plant) {
      wrap.appendChild(ui.h('div', { class: 'card' },
        ui.h('div', { class: 'card-body' },
          ui.h('h2', {}, 'Plant premises'),
          ui.h('p', { class: 'hint' }, 'This counter is the plant floor. Stock leaves the plant when the sale is recorded.'))));
    }
    if (!SR.state.activeBranchId && SR.state.canSwitchBranch()) {
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
    async function runSearch(term) {
      const q = String(term || '').trim();
      if (!SR.state.activeBranchId) {
        results.replaceChildren();
        results.appendChild(ui.h('div', { class: 'pos-hit' },
          ui.h('div', { class: 'ph-name' }, 'Pick a shop before you sell.'),
          ui.h('div', { class: 'ph-meta' }, 'A sale has to come out of one shop’s received stock.')));
        results.hidden = false;
        return;
      }
      const group = categorySelect.value;
      if (q.length < 2 && !group) { results.hidden = true; results.replaceChildren(); return; }
      const seq = ++searchSeq;
      let hits = []; let source = 'device';
      const offline = !SR.api.isOnline();
      // Offline must not wait on a request that cannot succeed. A failed fetch
      // that comes back as an empty page used to be treated as "nothing matches".
      if (!offline) {
        try {
          const data = await SR.api.get('/api/products', { query: SR.state.query({ q: q.length >= 2 ? q : undefined, limit: 30, for_sale: '1', selling_group: group || undefined }) });
          if (!data || !Array.isArray(data.data)) throw new Error('The till search did not return a list.');
          hits = data.data;
          source = 'server';
        } catch (err) {
          hits = await searchMirror(q, group);
          source = 'device';
        }
      } else {
        hits = await searchMirror(q, group);
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
    }
    let searchTimer = null;
    function scheduleSearch(term) {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { searchTimer = null; runSearch(term); }, 180);
    }
    function cancelSearch() {
      clearTimeout(searchTimer);
      searchTimer = null;
      searchSeq += 1;
    }

    function hitRow(p) {
      const btn = ui.h('button', { class: 'pos-hit', onClick: () => { addFromSearch(p); scanInput.value = ''; results.hidden = true; scanInput.focus(); } });
      btn.appendChild(ui.h('div', { class: 'grow' },
        ui.h('div', { class: 'ph-name' }, p.name),
        ui.h('div', { class: 'ph-meta' }, [
          p.sku ? `SKU ${p.sku}` : null,
          U.sellingGroup(p).label,
          p.category_name && U.sellingGroup(p).label !== p.category_name ? p.category_name : null,
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
          categoryId: b.product_category_id || null,
          categoryCode: b.product_category_code || '',
          categoryName: b.product_category_name || '',
          registrationNo: b.product_registration_no || null,
          nafdacCatalogId: b.product_nafdac_catalog_id || null,
        };
        cur.on_hand += avail;
        if (!cur.name && b.product_name) cur.name = b.product_name;
        if (!cur.sku && b.product_sku) cur.sku = b.product_sku;
        if (!cur.brand && b.product_brand) cur.brand = b.product_brand;
        if (!cur.model && b.product_model_no) cur.model = b.product_model_no;
        if (!cur.dispensing && b.product_dispensing_class) cur.dispensing = b.product_dispensing_class;
        if (!cur.controlled && Number(b.product_is_controlled) === 1) cur.controlled = 1;
        if (!cur.requiresSerial && Number(b.product_requires_serial) === 1) cur.requiresSerial = 1;
        if (!cur.categoryCode && b.product_category_code) cur.categoryCode = b.product_category_code;
        if (!cur.categoryName && b.product_category_name) cur.categoryName = b.product_category_name;
        if (!cur.categoryId && b.product_category_id) cur.categoryId = b.product_category_id;
        if (!cur.nafdacCatalogId && b.product_nafdac_catalog_id) cur.nafdacCatalogId = b.product_nafdac_catalog_id;
        const batchPrice = Number(b.selling_price_per_unit) || Number(b.product_selling_price) || 0;
        if (batchPrice > 0 && !(cur.price > 0)) cur.price = batchPrice;
        byProduct.set(id, cur);
        rows.push(b);
      }
      return { byProduct, rows, branchId };
    }

    async function paintSellingCategories() {
      const rows = await SR.store.all('product_categories').catch(() => []);
      const groups = new Map();
      for (const row of rows || []) {
        if (Number(row.is_deleted) || Number(row.is_active) === 0) continue;
        const group = U.sellingGroup(row);
        const prev = groups.get(group.code) || { code: group.code, label: group.label, count: 0 };
        prev.count += 1;
        groups.set(group.code, prev);
      }
      const current = categorySelect.value;
      categorySelect.replaceChildren(ui.h('option', { value: '' }, 'Both sides'));
      for (const group of U.sellingGroups()) {
        const row = groups.get(group.code);
        categorySelect.appendChild(ui.h('option', { value: group.code }, row ? `${group.label} · ${row.count}` : group.label));
      }
      if ([...categorySelect.options].some((opt) => opt.value === current)) categorySelect.value = current;
    }

    async function searchMirror(term, groupCode) {
      const needle = String(term || '').toLowerCase();
      const categories = await SR.store.all('product_categories').catch(() => []);
      const categoryById = new Map((categories || []).filter((c) => !Number(c.is_deleted)).map((c) => [String(c.id), c]));
      const stock = await sellableIndex();
      if (!stock.byProduct.size) return [];
      const barcodeRows = await SR.store.all('product_barcodes').catch(() => []);
      const codesByProduct = new Map();
      for (const b of barcodeRows) {
        if (Number(b.is_deleted) || !b.barcode) continue;
        const id = String(b.product_id);
        const list = codesByProduct.get(id) || [];
        list.push(String(b.barcode));
        codesByProduct.set(id, list);
      }
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
        const cat = (product && categoryById.get(String(product.category_id))) || null;
        const categoryCode = (product && product.category_code) || (cat && cat.code) || info.categoryCode || '';
        const categoryName = (product && product.category_name) || (cat && cat.name) || info.categoryName || '';
        const codes = (codesByProduct.get(id) || []).join(' ');
        const ownBarcode = (product && product.barcode) || '';
        const blob = `${name} ${sku} ${brand} ${model} ${categoryName} ${codes} ${ownBarcode}`.toLowerCase();
        if (needle && !blob.includes(needle)) continue;
        if (!needle && !groupCode) continue;
        if (groupCode && U.sellingGroup({
          code: categoryCode, name: categoryName,
          parent_code: cat && cat.parent_id ? ((categoryById.get(String(cat.parent_id)) || {}).code) : null,
          nafdac_catalog_id: (product && product.nafdac_catalog_id) || info.nafdacCatalogId,
        }).code !== groupCode) continue;
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
          category_id: (product && product.category_id) || info.categoryId || null,
          category_code: categoryCode || null,
          category_name: categoryName || null,
          registration_no: (product && product.registration_no) || info.registrationNo || null,
          nafdac_catalog_id: (product && product.nafdac_catalog_id) || info.nafdacCatalogId || null,
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

    /**
     * A USB barcode gun in a Nigerian shop is a keyboard. It types the code
     * into whichever box has focus, very fast, then presses Enter (some guns
     * press Tab, and some prefix an AIM mark such as ]E0). This box is kept
     * ready, and a burst that lands on a button is pulled back into it.
     */
    function normalizeScan(raw) {
      let s = String(raw == null ? '' : raw);
      s = s.replace(/[\u0000-\u001f\u007f]/g, '');
      s = s.trim().replace(/^\][A-Za-z][0-9]/, '').replace(/^[*]+|[*]+$/g, '').trim();
      return s;
    }
    function scanCandidates(raw) {
      const code = normalizeScan(raw);
      const list = [];
      const push = (v) => { if (v && !list.includes(v)) list.push(v); };
      push(code);
      if (/^\d{12}$/.test(code)) push('0' + code);
      if (/^\d{13,14}$/.test(code) && code[0] === '0') push(code.slice(1));
      return list;
    }
    function shouldScan(code, fast) {
      if (!code || /\s/.test(code)) return false;
      if (/^\d{6,14}$/.test(code)) return true;
      if (fast && code.length >= 4) return true;
      if (/\d/.test(code) && code.length >= 4 && /^[\w./+-]+$/.test(code)) return true;
      return false;
    }

    let wedgeAt = 0;
    let wedgeCount = 0;
    let wedgeSettle = null;
    let scanQueue = Promise.resolve();
    function noteWedgeKey() {
      const now = Date.now();
      wedgeCount = now - wedgeAt < 50 ? wedgeCount + 1 : 1;
      wedgeAt = now;
      // A gun that is not set to press Enter still finishes in a burst.
      // Waiting past the last character commits the code without a name search.
      clearTimeout(wedgeSettle);
      wedgeSettle = setTimeout(() => {
        wedgeSettle = null;
        if (!scanInput.isConnected || modalOpen()) return;
        if (wedgeCount >= 4 && shouldScan(normalizeScan(scanInput.value), true)) {
          commitField(scanInput.value, { fast: true });
        }
      }, 90);
    }
    function modalOpen() {
      const root = document.getElementById('modal-root');
      return Boolean(root && !root.hidden);
    }
    function otherField(target) {
      if (!target || target === scanInput) return false;
      const tag = target.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
    }
    let lastCommitCode = '';
    let lastCommitAt = 0;
    function commitField(raw, { fast = false } = {}) {
      const code = normalizeScan(raw);
      clearTimeout(wedgeSettle);
      wedgeSettle = null;
      const now = Date.now();
      if (code && code === lastCommitCode && now - lastCommitAt < 250) return;
      lastCommitCode = code;
      lastCommitAt = now;
      cancelSearch();
      wedgeCount = 0;
      if (!code) {
        results.hidden = true;
        results.replaceChildren();
        return;
      }
      if (shouldScan(code, fast)) {
        scanQueue = scanQueue.then(() => scan(code)).catch(() => {});
        return;
      }
      runSearch(code);
    }

    /** An exact barcode, SKU or serial goes straight into the cart. */
    async function scan(raw) {
      const code = normalizeScan(raw);
      if (!code) return;
      cancelSearch();
      try {
        const data = await SR.api.get('/api/catalogue/scan', { query: SR.state.query({ code, for_sale: '1' }) });
        if (data && data.product) {
          if (data.product.on_hand == null && data.onHand != null) data.product.on_hand = data.onHand;
          await acceptScan(data.product, {
            barcode: code,
            variantId: data.barcodeVariantId || data.variant_id || null,
            unitCode: data.scannedUnit || data.unit_code || null,
            serialNo: data.serial_no || null,
            units: data.units,
          });
          return;
        }
      } catch (err) {
        if (err && err.code === 'NOT_IN_RECEIVED_STOCK') {
          const local = await scanMirror(code);
          if (local) { await acceptScan(local.product, local); return; }
          flash(scanBox, false);
          ui.warn(err.message);
          readyForNextScan();
          return;
        }
        if (!err.isOffline && err.status !== 404) ui.apiError(err);
      }
      const local = await scanMirror(code);
      if (local) { await acceptScan(local.product, local); return; }
      const known = await catalogueNameForCode(code);
      if (known) {
        flash(scanBox, false);
        ui.warn(`${known} is in the catalogue, but it is not on this till's shelf yet.`);
        readyForNextScan();
        return;
      }
      flash(scanBox, false);
      ui.warn(`No product with the code “${code}”.`);
      scanInput.value = code;
      runSearch(code);
    }

    async function acceptScan(product, extra) {
      flash(scanBox, true);
      readyForNextScan();
      await addLine(product, extra || {});
      if (scanInput.isConnected && !modalOpen()) scanInput.focus();
    }
    function readyForNextScan() {
      scanInput.value = '';
      results.hidden = true;
      results.replaceChildren();
      if (scanInput.isConnected && !modalOpen()) scanInput.focus();
    }

    async function catalogueNameForCode(code) {
      const wants = new Set(scanCandidates(code).map((c) => c.toUpperCase()));
      const barcodes = await SR.store.all('product_barcodes').catch(() => []);
      const hit = barcodes.find((b) => !Number(b.is_deleted) && wants.has(String(b.barcode).toUpperCase()));
      if (hit) {
        const product = await SR.store.get('products', hit.product_id).catch(() => null);
        return (product && product.name) || 'That product';
      }
      const products = await SR.store.all('products').catch(() => []);
      const row = products.find((p) => !Number(p.is_deleted) && (
        wants.has(String(p.sku || '').toUpperCase())
        || wants.has(String(p.barcode || '').toUpperCase())
        || wants.has(String(p.registration_no || '').toUpperCase())
      ));
      return row ? row.name : null;
    }

    async function scanMirror(code) {
      const stock = await sellableIndex();
      const wants = new Set(scanCandidates(code).map((c) => c.toUpperCase()));
      const withStock = (product, extra) => {
        if (!product || !stock.byProduct.has(String(product.id))) return null;
        return Object.assign({ product: Object.assign({}, product, { on_hand: stock.byProduct.get(String(product.id)) || 0 }) }, extra);
      };
      const barcodes = await SR.store.all('product_barcodes').catch(() => []);
      const hit = barcodes.find((b) => !Number(b.is_deleted) && wants.has(String(b.barcode).toUpperCase()));
      if (hit) {
        const product = await SR.store.get('products', hit.product_id);
        const found = withStock(product, { variantId: hit.variant_id || null, unitCode: hit.unit_code || null, units: hit.units, barcode: code });
        if (found) return found;
      }
      const products = await SR.store.all('products').catch(() => []);
      const byCode = products.find((p) => !Number(p.is_deleted) && Number(p.is_active) !== 0 && (
        wants.has(String(p.sku || '').toUpperCase())
        || wants.has(String(p.barcode || '').toUpperCase())
        || wants.has(String(p.registration_no || '').toUpperCase())
      ));
      if (byCode) {
        const found = withStock(byCode, { barcode: code });
        if (found) return found;
      }
      if (serialsOn()) {
        const serials = await SR.store.all('serial_numbers').catch(() => []);
        const serial = serials.find((s) => wants.has(String(s.serial_no).toUpperCase()));
        if (serial) {
          const product = await SR.store.get('products', serial.product_id);
          const found = withStock(product, { serialNo: serial.serial_no, serialId: serial.id, unitCode: serial.unit_code || null, units: serial.units });
          if (found) return found;
        }
      }
      return null;
    }

    function onScanKey(ev) {
      if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) noteWedgeKey();
      if (ev.key !== 'Enter' && ev.key !== 'Tab') return;
      ev.preventDefault();
      commitField(scanInput.value, { fast: wedgeCount >= 4 });
    }
    function onWedgeKey(ev) {
      if (!scanInput.isConnected || modalOpen()) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (ev.target === scanInput || otherField(ev.target)) return;
      if (ev.key === 'Enter' || ev.key === 'Tab') {
        if (wedgeCount >= 4 && normalizeScan(scanInput.value)) {
          ev.preventDefault();
          ev.stopPropagation();
          commitField(scanInput.value, { fast: true });
        }
        return;
      }
      if (ev.key.length !== 1) return;
      ev.preventDefault();
      ev.stopPropagation();
      noteWedgeKey();
      scanInput.focus();
      const start = scanInput.selectionStart == null ? scanInput.value.length : scanInput.selectionStart;
      const end = scanInput.selectionEnd == null ? start : scanInput.selectionEnd;
      scanInput.value = scanInput.value.slice(0, start) + ev.key + scanInput.value.slice(end);
      const caret = start + 1;
      try { scanInput.setSelectionRange(caret, caret); } catch (err) { /* search inputs on some phones */ }
    }

    scanInput.addEventListener('keydown', onScanKey);
    scanInput.addEventListener('input', () => {
      if (wedgeCount >= 4 && shouldScan(normalizeScan(scanInput.value), true)) {
        cancelSearch();
        return;
      }
      scheduleSearch(scanInput.value);
    });
    document.addEventListener('keydown', onWedgeKey, true);
    categorySelect.addEventListener('change', () => scheduleSearch(scanInput.value));
    paintSellingCategories();
    if (SR.sync && SR.sync.on) SR.sync.on('change', () => { paintSellingCategories(); });
    setTimeout(() => { if (scanInput.isConnected && !modalOpen()) scanInput.focus(); }, 80);

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

    function rentalYard() {
      const branch = SR.state.activeBranch();
      return Boolean(branch && String(branch.branch_type || '').toUpperCase() === 'RENTAL');
    }

    async function askArrangement(product) {
      const hire = Number(product.offers_hire) === 1 && SR.state.moduleOn('hire');
      const lease = Number(product.offers_lease) === 1 && SR.state.moduleOn('lease');
      const sale = product.offers_sale == null || Number(product.offers_sale) === 1;
      if (!hire && !lease) return { channel: 'RETAIL' };
      const yard = rentalYard();
      const choices = [];
      // A rental yard starts on the hire or the lease. A sale is still there
      // when the customer is buying the unit, and that sale takes the cost.
      if (yard && hire) choices.push('HIRE');
      if (yard && lease) choices.push('LEASE');
      if (sale && Number(product.selling_price) > 0) choices.push('SALE');
      if (hire && !choices.includes('HIRE')) choices.push('HIRE');
      if (lease && !choices.includes('LEASE')) choices.push('LEASE');
      let channel = choices[0];
      if (choices.length > 1) {
        const picked = await ui.promptDialog({
          title: product.name,
          label: yard
            ? `Rental yard. Type ${choices.join(' or ')}. A hire or lease earns the fee and holds the deposit. A sale takes the unit off the books.`
            : `How is this going out? Type ${choices.join(', ')}`,
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
          categoryId: product.category_id || null,
          categoryCode: product.category_code || null,
          categoryName: product.category_name || null,
          nafdacCatalogId: product.nafdac_catalog_id || null,
          batchNo: product.batch_no || null,
          expiryDate: product.expiry_date || null,
          registrationNo: product.registration_no || null,
          // `on_hand` is in base units; the line counts cartons, so the badge has
          // to speak the same language as the quantity box beside it.
          onHandBase: product.on_hand != null ? Number(product.on_hand) : null,
          maxQuantity: product.on_hand != null ? Number(product.on_hand) / sell.factor : null,
          fragile: Number(product.is_fragile) === 1,
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
      const added = cart.lines[cart.lines.length - 1];
      if (added && String(added.productId) === String(product.id)) await fillLineFacts(added, product);
      save();
      showStep('cart');
      paint();
      refreshPreview();
    }

    async function fillLineFacts(line, product) {
      if (!line.nafdacCatalogId && product && product.nafdac_catalog_id) line.nafdacCatalogId = product.nafdac_catalog_id;
      if (!line.categoryCode && (line.categoryId || product.category_id)) {
        const cats = await SR.store.all('product_categories').catch(() => []);
        const cat = (cats || []).find((c) => String(c.id) === String(line.categoryId || product.category_id));
        if (cat) {
          line.categoryId = cat.id;
          line.categoryCode = cat.code;
          line.categoryName = cat.name;
        }
      }
      if (line.batchNo) return;
      const stock = await sellableIndex();
      const rows = (stock.rows || []).filter((b) => String(b.product_id) === String(line.productId));
      rows.sort((a, b) => {
        const ae = a.expiry_date ? 0 : 1;
        const be = b.expiry_date ? 0 : 1;
        if (ae !== be) return ae - be;
        return String(a.expiry_date || '').localeCompare(String(b.expiry_date || ''))
          || String(a.batch_no || '').localeCompare(String(b.batch_no || ''));
      });
      const batch = rows[0];
      if (!batch) return;
      line.batchNo = batch.batch_no || null;
      line.expiryDate = batch.expiry_date || null;
      if (!line.categoryCode && batch.product_category_code) {
        line.categoryCode = batch.product_category_code;
        line.categoryName = batch.product_category_name || line.categoryName;
        line.categoryId = batch.product_category_id || line.categoryId;
      }
      if (!line.registrationNo && batch.product_registration_no) line.registrationNo = batch.product_registration_no;
      if (!line.nafdacCatalogId && batch.product_nafdac_catalog_id) line.nafdacCatalogId = batch.product_nafdac_catalog_id;
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
      showStep('pay');
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
        settlement: cart.settlement,
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
      if (complete) complete.disabled = false;
      showStep(sellStep);
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
        U.sellingGroup({ code: line.categoryCode, name: line.categoryName, nafdac_catalog_id: line.nafdacCatalogId }).label,
        line.variantName || null,
        `${U.money(line.unitPrice)} / ${line.unitCode}`,
      ];
      const avail = line.maxQuantity;
      if (avail != null && Number(line.quantity) > avail) meta.push(`only ${U.qty(avail)} in stock`);
      row.appendChild(ui.h('div', { class: 'cl-meta' }, meta.filter(Boolean).join(' · ')));
      if (line.fragile) row.appendChild(ui.h('div', { class: 'hint' }, 'Fragile. It does not ride loose, and it is not stacked.'));

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

    function ensureSettlement() {
      const policy = sellingChoice();
      if (cart.settlement !== 'SPOT' && cart.settlement !== 'CREDIT') {
        cart.settlement = policy.credit && !policy.spot ? 'CREDIT' : 'SPOT';
      }
      if (cart.settlement === 'CREDIT' && !policy.credit) cart.settlement = 'SPOT';
      if (cart.settlement === 'SPOT' && !policy.spot && policy.credit) cart.settlement = 'CREDIT';
      if (cart.settlement === 'CREDIT' && cart.saleType === 'RETAIL') cart.saleType = 'CREDIT';
      if (cart.settlement === 'SPOT' && cart.saleType === 'CREDIT') cart.saleType = 'RETAIL';
    }

    function paintTerms() {
      const host = document.getElementById('pos-terms');
      if (!host) return;
      ensureSettlement();
      const policy = sellingChoice();
      host.replaceChildren();
      if (!policy.spot && !policy.credit) return;
      const row = ui.h('div', { class: 'stack', style: { marginTop: '10px' } });
      row.appendChild(ui.h('div', { class: 'hint' }, policy.both
        ? 'How is this sold? Paid on the spot prints a receipt. On credit prints an invoice. The choice is kept on the sale and on the drop.'
        : (policy.credit ? 'This business sells on credit. The paper is an invoice until the money is taken.' : 'This business sells on the spot. The paper is a receipt.')));
      if (policy.both) {
        const buttons = ui.h('div', { class: 'btn-row' });
        buttons.appendChild(ui.h('button', {
          class: cart.settlement === 'SPOT' ? 'btn btn-sm btn-primary' : 'btn btn-sm',
          type: 'button',
          onClick: () => { cart.settlement = 'SPOT'; if (cart.saleType === 'CREDIT') cart.saleType = 'RETAIL'; save(); paint(); },
        }, 'Paid on the spot'));
        buttons.appendChild(ui.h('button', {
          class: cart.settlement === 'CREDIT' ? 'btn btn-sm btn-primary' : 'btn btn-sm',
          type: 'button',
          onClick: () => { cart.settlement = 'CREDIT'; if (cart.saleType === 'RETAIL') cart.saleType = 'CREDIT'; save(); paint(); },
        }, 'On credit'));
        row.appendChild(buttons);
      }
      host.appendChild(row);
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
      ensureSettlement();
      totalsEl.appendChild(row('Sale', U.humanise(cart.saleType)));
      totalsEl.appendChild(row('Terms', cart.settlement === 'CREDIT' ? 'On credit' : 'Paid on the spot'));
      if (dispatchOn) totalsEl.appendChild(row('Where', placeLabel()));
      const method = dominantMethod();
      if (method) totalsEl.appendChild(row('Paying by', METHOD_LABEL[method] || method));
      const hint = document.getElementById('pos-pay-hint');
      if (hint) {
        hint.textContent = cart.lines.length
          ? 'These goods are ready. Print the bill, or take payment at this desk. The receipt uses this total.'
          : 'Nothing is in the cart. Find goods to start a sale, or type a payment code if the customer already has a bill.';
      }
      const pay = document.getElementById('pos-complete');
      const desk = document.getElementById('pos-pay-desk');
      const billsBtn = document.getElementById('pos-open-bills');
      const billMode = billsFirst() && !cartIsBooking() && cart.settlement !== 'CREDIT';
      if (billsBtn) billsBtn.hidden = !billsFirst();
      const payCard = document.getElementById('pos-pay-bill');
      if (payCard) payCard.hidden = !billsFirst();
      if (desk) desk.hidden = !billMode || !cart.lines.length;
      if (pay) {
        if (cart.settlement === 'CREDIT') pay.textContent = cart.lines.length ? `Supply on credit · ${U.money(t.total)}` : 'Supply on credit';
        else if (billMode && cart.lines.length) pay.textContent = `Print bill · ${U.money(t.collect != null ? t.collect : t.total)}`;
        else if (cart.lines.length) pay.textContent = `Take payment · ${U.money(t.collect != null ? t.collect : t.total)}`;
        else if (billsFirst()) pay.textContent = 'Pay a printed bill';
        else pay.textContent = 'Find goods';
      }
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
      if (billsFirst() && !cartIsBooking()) {
        infoBody.appendChild(ui.h('div', { class: 'hint' }, 'Print a bill first. The goods are held, not sold. The customer pays, the receipt prints, then print the release note before the store hands the goods over.'));
      }
      if (rentalYard()) {
        infoBody.appendChild(ui.h('div', { class: 'hint' }, 'This yard hires goods out. The fee is income. The deposit is held, not earned. The goods stay on the books until they are sold.'));
      }
      if (cart.deliveryRequired) infoBody.appendChild(ui.h('div', { class: 'hint' }, `Delivery to: ${cart.deliveryAddress || cart.customerName || '—'}`));
      infoCard.hidden = infoBody.childElementCount === 0;
      paintTerms();
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
      // The receipt prints the server price. Leaving the cart on a different
      // figure made the cashier collect one amount and the shop refuse the
      // payment as too much or too little. The cart takes the receipt price
      // before the money is counted. A typed counter price is left alone.
      if (result && Array.isArray(result.lines)) {
        let changed = false;
        for (const sl of result.lines) {
          const local = cart.lines.find((l) => String(l.productId) === String(sl.product_id));
          if (!local || local.manualPrice) continue;
          const serverPrice = Number(sl.unit_price != null ? sl.unit_price : local.unitPrice);
          if (serverPrice > 0 && Math.abs(serverPrice - Number(local.unitPrice)) > 0.01) {
            notes.push(`${local.name} is ${U.money(serverPrice)} on the receipt, not ${U.money(local.unitPrice)}.`);
            local.unitPrice = U.round2(serverPrice);
            local.serverPrice = null;
            local.agreedPrice = null;
            changed = true;
          }
        }
        if (changed) {
          save();
          const typing = document.activeElement && cartBody.contains(document.activeElement);
          if (typing) paintTotals();
          else paint();
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
              if (cart.saleType === 'CREDIT') cart.settlement = 'CREDIT';
              if (cart.saleType === 'RETAIL' && cart.settlement === 'CREDIT') cart.settlement = 'SPOT';
              ensureSettlement();
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
    async function alignReceiptPrices() {
      if (!cart.lines.length || !SR.api.isOnline()) return;
      const t = computedTotals();
      let result;
      try {
        result = await SR.api.post('/api/sales/preview', {
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
      } catch (err) {
        return;
      }
      showPreviewWarnings(result);
    }

    async function openTender() {
      const ready = await ensureDispense(cart.lines);
      if (!ready) {
        ui.warn('Payment was not opened. A prescription-only or controlled item still needs the details the register requires.');
        return;
      }
      await alignReceiptPrices();
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
      const changeBox = ui.h('div', {});
      wrapEl.appendChild(changeBox);

      function remaining() { return U.round2(t.total - cart.payments.reduce((a, p) => a + Number(p.amount || 0), 0)); }

      function pushLeg(method, amount, ref, extra) {
        cart.payments.push(Object.assign({ method, amount: U.round2(amount), reference: ref || null }, extra || {}));
        referenceInput.value = '';
        amountInput.value = String(U.round2(Math.max(0, remaining())));
        save();
        paintRunning();
        paintTotals();
      }

      function addPayment(method, amount) {
        const amt = U.round2(Number(amount) || 0);
        if (!method) { ui.warn('Choose how the customer is paying.'); return; }
        if (amt <= 0) { ui.warn('Enter an amount.'); return; }
        const ref = referenceInput.value.trim() || null;
        if (['POS_TERMINAL', 'BANK_TRANSFER', 'CHEQUE', 'MOBILE_MONEY', 'USSD'].includes(method) && !ref) {
          ui.warn(`${METHOD_LABEL[method]} with no reference. It is recorded, but a reference makes a settlement query answerable.`);
        }
        const due = Math.max(0, remaining());
        const excess = U.round2(amt - due);
        if (excess > 0.009 && ['CREDIT', 'INSTALMENT', 'LAYAWAY'].includes(cart.saleType)) {
          ui.warn(`${U.money(excess)} is more than this ${cart.saleType.toLowerCase()} sale still needs. Correct the amount — extra on a credit sale is not change to hold.`);
          return;
        }
        if (excess > 0.009) {
          askAboutExcess(method, amt, due, excess, ref);
          return;
        }
        pushLeg(method, amt, ref);
      }

      function askAboutExcess(method, tendered, due, excess, ref) {
        const nameInput = ui.h('input', {
          type: 'text',
          value: cart.changeHolderName || cart.customerName || '',
          placeholder: 'Customer name',
          autocomplete: 'name',
        });
        const phoneInput = ui.h('input', {
          type: 'tel',
          value: cart.changeHolderPhone || cart.customerPhone || '',
          placeholder: 'Phone (optional)',
          autocomplete: 'tel',
        });
        changeBox.replaceChildren(
          ui.h('div', { class: 'alert alert-warn' },
            `${U.money(tendered)} is ${U.money(excess)} more than the ${U.money(due)} still due.`),
          ui.h('p', {}, 'Hold that difference for the customer and print a code they can bring back, or give the change now.'),
          ui.h('label', { class: 'field' }, ui.h('span', { class: 'field-label' }, 'Name on the claim'), nameInput),
          ui.h('label', { class: 'field' }, ui.h('span', { class: 'field-label' }, 'Phone'), phoneInput),
          ui.h('div', { class: 'row' },
            ui.h('button', { class: 'btn', onClick: () => {
              if (due <= 0.009) { ui.warn('Nothing is left to pay. Remove a payment if that figure was a mistake.'); return; }
              pushLeg(method, due, ref, { cashTendered: tendered, changeGiven: excess });
              changeBox.replaceChildren();
            } }, `Give ${U.money(excess)} now`),
            ui.h('button', { class: 'btn btn-primary', onClick: () => {
              const name = String(nameInput.value || '').trim();
              if (name.length < 2) { ui.warn('Type the customer’s name. The code is how they collect the change, and the name is how you know it is them.'); return; }
              if (!cart.claimCode) cart.claimCode = U.claimCode();
              cart.changeOwedAmount = U.round2((Number(cart.changeOwedAmount) || 0) + excess);
              cart.changeHolderName = name;
              cart.changeHolderPhone = String(phoneInput.value || '').trim() || null;
              pushLeg(method, tendered, ref, { cashTendered: tendered, changeGiven: 0 });
              changeBox.replaceChildren();
            } }, 'Hold it and print a code')),
        );
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
                  onClick: () => {
                    cart.payments.splice(i, 1);
                    const tendered = cart.payments.reduce((a, p) => a + Number(p.amount || 0), 0);
                    if (tendered <= t.total + 0.009) {
                      cart.changeOwedAmount = 0;
                      cart.claimCode = null;
                    }
                    save(); paintRunning(); paintTotals();
                  },
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
        if (bal > 0.01 && cart.settlement !== 'CREDIT' && !['CREDIT', 'INSTALMENT', 'LAYAWAY'].includes(cart.saleType)) {
          creditBox.appendChild(ui.h('div', { class: 'alert alert-warn' },
            `₦${U.amount(Math.max(0, bal))} is still unpaid. This sale is paid on the spot, so it cannot be completed short. Take the rest, or go back and choose On credit so the paper is an invoice.`));
        } else if (bal > 0.01) {
          const overLimit = cart.customerId ? null : 'A credit sale needs a customer, so the debt can be followed up.';
          creditBox.appendChild(ui.h('div', { class: 'alert alert-warn' },
            `₦${U.amount(Math.max(0, bal))} is unpaid. `,
            overLimit ? overLimit : 'Completing now writes the balance to the customer\'s ledger as a debt, and the paper is an invoice, not a receipt.'));
          if (overLimit) {
            const pick = ui.h('button', { class: 'btn btn-sm', onClick: async () => { await pickCustomer(); m.close(); openTender(); } }, 'Choose a customer');
            creditBox.appendChild(pick);
          } else {
            const reason = ui.h('input', { type: 'text', placeholder: 'Reason for selling on credit (recorded)', style: { marginTop: '8px' } });
            creditBox.appendChild(reason);
            creditBox.dataset.reason = '1';
            creditBox.appendChild(ui.h('div', { class: 'hint' }, SR.state.moduleOn('creditUntilPaid')
              ? 'If this customer still owes for a supply, the next batch stays at the plant until that is paid. A reason here releases it, and the reason is kept on the sale. A cash sale is not held.'
              : 'Left blank unless the customer is over their limit.'));
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
          if (!done) return;
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
            showStep('pay');
            paint();
          } else showStep('pay');
        },
      });
      paintButtons();
      paintRunning();
      setTimeout(() => amountInput.focus(), 60);
    }

    function billsFirst() {
      return Boolean(SR.state.moduleOn && SR.state.moduleOn('billBeforeReceipt'));
    }
    function cartIsBooking() {
      return cart.lines.some((l) => l.channel === 'HIRE' || l.channel === 'LEASE');
    }
    function primaryIsBill() {
      return billsFirst() && !cartIsBooking() && cart.lines.length > 0;
    }
    function primaryAction() {
      ensureSettlement();
      if (sellStep !== 'pay') {
        showStep('pay');
        return;
      }
      if (!cart.lines.length) {
        if (billsFirst() && payCodeInput) {
          payCodeInput.focus();
          return;
        }
        showStep('find');
        if (scanInput) scanInput.focus();
        return;
      }
      if (cart.settlement === 'CREDIT') return openTender();
      if (billsFirst() && !cartIsBooking()) return raiseBill();
      return openTender();
    }

    async function ensureBillName() {
      const existing = String(cart.customerName || cart.changeHolderName || '').trim();
      if (existing.length >= 2) return existing;
      const typed = await ui.promptDialog({
        title: 'Who is the bill for?',
        label: 'Customer name',
        required: true,
      });
      if (!typed || String(typed).trim().length < 2) return null;
      cart.customerName = String(typed).trim();
      save();
      paint();
      return cart.customerName;
    }

    async function raiseBill() {
      if (!cart.lines.length) {
        showStep('find');
        if (scanInput) scanInput.focus();
        return;
      }
      await alignReceiptPrices();
      if (!assertPlace()) return;
      if (cartIsBooking()) {
        ui.warn('A hire or a lease is booked, not billed. Take payment for that line on its own.');
        return;
      }
      if (!SR.state.activeBranchId) {
        ui.warn('Pick the shop this bill belongs to. The hold has to sit on one store.');
        return;
      }
      if (!SR.api.isOnline()) {
        ui.warn('A bill that holds stock has to reach the server, or two desks could promise the same goods. Connect, then print the bill. If the customer is paying at this desk now, use Pay at this desk.');
        return;
      }
      const name = await ensureBillName();
      if (!name) return;
      const t = computedTotals();
      const payload = {
        branch_id: SR.state.activeBranchId,
        business_id: SR.state.activeBusinessId,
        sale_type: cart.saleType,
        customer_id: cart.customerId,
        customer_name: name,
        customer_phone: cart.customerPhone || null,
        walk_in_name: name,
        discount_amount: t.discount,
        discount_reason: cart.discountReason || null,
        delivery_fee: t.delivery,
        delivery_required: Boolean(cart.deliveryRequired),
        delivery_address: cart.deliveryAddress || null,
        notes: cart.notes || null,
        sale_place: dispatchOn ? (cart.salePlace || 'PREMISES') : null,
        vehicle_id: dispatchOn && cart.salePlace === 'VEHICLE' ? cart.vehicleId : null,
        manual_price_overrides: cart.manualPriceOverrides,
        lines: cart.lines.map((l) => linePayload(l)),
      };
      const btn = document.getElementById('pos-complete');
      if (btn) { btn.disabled = true; btn.textContent = 'Holding the goods…'; }
      try {
        const res = await SR.api.post('/api/bills', payload, { timeoutMs: 25000 });
        const bill = res.bill || res;
        bill.brand = (SR.state.settings || {}).business_name || 'StockRidge';
        bill.branch_name = bill.branch_name || SR.state.activeBranchName();
        resetTill();
        paint();
        ui.ok(res.message || `Bill ${bill.bill_no} printed. This is not a receipt.`);
        if (SR.print.previewBill) SR.print.previewBill(bill, { autoPrint: true });
      } catch (err) {
        ui.apiError(err);
        paint();
      }
    }

    function staffName() {
      const user = SR.state.user || {};
      return user.fullName || user.full_name || user.username || 'Staff';
    }

    async function findPrintedBill() {
      const typed = String((payCodeInput && payCodeInput.value) || '').trim();
      const code = typed.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length < 4) {
        ui.warn('Type the payment code printed on the bill.');
        return;
      }
      if (!SR.api.isOnline()) {
        ui.warn('An open bill lives on the server, because that is where the goods are held. Connect, then type the code.');
        return;
      }
      payBillResult.replaceChildren(ui.h('div', { class: 'hint' }, 'Looking up the bill…'));
      try {
        const res = await SR.api.get('/api/bills/lookup', {
          query: { code, branch_id: SR.state.activeBranchId || undefined },
        });
        const bill = res && res.bill;
        if (!bill) {
          payBillResult.replaceChildren(ui.h('div', { class: 'alert alert-warn' }, 'No bill has that code.'));
          return;
        }
        paintFoundBill(bill);
      } catch (err) {
        payBillResult.replaceChildren();
        ui.apiError(err);
      }
    }

    function paintFoundBill(bill) {
      payBillResult.replaceChildren();
      if (bill.status === 'PAID') {
        payBillResult.appendChild(ui.h('div', { class: 'alert alert-info' },
          `${bill.bill_no} for ${bill.customer_name} is already paid${bill.paid_receipt_no ? `. Receipt ${bill.paid_receipt_no}` : ''}${bill.paid_by_name ? ` by ${bill.paid_by_name}` : ''}. Do not take the money again.`));
        if (bill.paid_sale_id) {
          payBillResult.appendChild(ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate(`/sales/${bill.paid_sale_id}`) }, 'Open the receipt'));
        }
        return;
      }
      if (bill.status !== 'OPEN' && bill.status !== 'PAYING') {
        payBillResult.appendChild(ui.h('div', { class: 'alert alert-warn' },
          `${bill.bill_no} is ${String(bill.status || '').toLowerCase()}. The goods are not held. Raise a new bill if the customer still wants them.`));
        return;
      }
      payBillResult.appendChild(ui.h('div', {}, ui.h('strong', {}, bill.customer_name || 'Customer'), ` · ${bill.bill_no}`));
      payBillResult.appendChild(ui.h('div', { class: 'hint' },
        `Payment code ${bill.pay_code || '—'}. Raised by ${bill.raised_by_name || 'staff'}. Total ${U.money(bill.total)}.`));
      const lines = ui.h('div', { class: 'stack' });
      for (const line of bill.lines || []) {
        lines.appendChild(ui.h('div', { class: 'slip-row' },
          ui.h('span', {}, `${U.qty(line.quantity)} × ${line.product_name || line.name || 'Item'}`),
          ui.h('span', { class: 'mono' }, U.money(line.line_total != null ? line.line_total : line.unit_price))));
      }
      payBillResult.appendChild(lines);
      payBillResult.appendChild(ui.h('div', { class: 'hint' }, 'Taking the payment prints a receipt for these goods. The bill total, the receipt, and the books must be the same figure. The goods leave only after the release note.'));
      payBillResult.appendChild(ui.h('button', {
        class: 'btn btn-primary',
        onClick: () => payBill(bill, null),
      }, `Mark paid · ${U.money(bill.total)}`));
    }

    async function openBills() {
      if (!SR.api.isOnline()) {
        ui.warn('Open bills live on the server, because that is where the stock is held. Connect, then open the list.');
        return;
      }
      const body = ui.h('div', { class: 'stack' });
      body.appendChild(ui.h('div', { class: 'hint' }, 'An open bill is not a sale. Take payment, print the receipt, then print the release note before the goods leave.'));
      const list = ui.h('div', { class: 'stack' });
      body.appendChild(list);
      const m = ui.openModal({
        title: 'Open bills',
        body,
        size: 'wide',
        footer: [ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Close')],
      });
      async function loadBills() {
        list.replaceChildren(ui.h('div', { class: 'hint' }, 'Loading…'));
        try {
          const res = await SR.api.get('/api/bills', { query: { status: 'OPEN', branch_id: SR.state.activeBranchId || undefined } });
          const rows = (res && res.data) || [];
          list.replaceChildren();
          if (!rows.length) {
            list.appendChild(ui.h('div', { class: 'hint' }, 'No bill is waiting at this shop.'));
            return;
          }
          for (const bill of rows) {
            const row = ui.h('div', { class: 'card' });
            const inner = ui.h('div', { class: 'card-body stack' });
            inner.appendChild(ui.h('div', {}, ui.h('strong', {}, bill.bill_no || 'Bill'), ` · ${bill.customer_name || '—'}`));
            inner.appendChild(ui.h('div', { class: 'hint' }, `${U.money(bill.total)} · code ${bill.pay_code || '—'} · raised by ${bill.raised_by_name || 'staff'} · hold until ${bill.valid_until || '—'}`));
            inner.appendChild(ui.h('div', { class: 'btn-row' },
              ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => payBill(bill, m) }, 'Take payment'),
              ui.h('button', { class: 'btn btn-sm', onClick: () => {
                const copy = Object.assign({ brand: (SR.state.settings || {}).business_name || 'StockRidge' }, bill);
                if (SR.print.previewBill) SR.print.previewBill(copy, { autoPrint: false });
              } }, 'Print bill'),
              ui.h('button', { class: 'btn btn-sm', onClick: () => cancelBill(bill, loadBills) }, 'Cancel')));
            row.appendChild(inner);
            list.appendChild(row);
          }
        } catch (err) {
          list.replaceChildren();
          ui.apiError(err);
        }
      }
      loadBills();
    }

    async function cancelBill(bill, reload) {
      const confirmed = await ui.confirmDialog({
        title: `Cancel ${bill.bill_no}?`,
        message: 'The goods go back on the shelf. Nothing has been paid, so there is no receipt to void.',
        confirmLabel: 'Cancel the bill',
      });
      if (!confirmed) return;
      try {
        const res = await SR.api.post(`/api/bills/${encodeURIComponent(bill.id)}/cancel`, { reason: 'Cancelled at the desk before payment.' });
        ui.ok(res.message || 'Bill cancelled.');
        if (reload) reload();
      } catch (err) { ui.apiError(err); }
    }

    async function payBill(bill, listModal) {
      if (SR.state.activeBranchId && String(SR.state.activeBranchId) !== String(bill.branch_id)) {
        ui.warn(`Bill ${bill.bill_no} belongs to ${bill.branch_name || 'another shop'}. Switch to that shop before taking the money.`);
        return;
      }
      const wrapEl = ui.h('div', { class: 'stack' });
      wrapEl.appendChild(ui.h('div', {}, `${bill.customer_name} · ${U.money(bill.total)}`));
      wrapEl.appendChild(ui.h('div', { class: 'hint' }, 'This payment prints the receipt. The goods are not released until you print the release note as well.'));
      const method = ui.h('select', {},
        ...['CASH', 'POS_TERMINAL', 'BANK_TRANSFER', 'MOBILE_MONEY'].map((code) => ui.h('option', { value: code }, METHOD_LABEL[code] || code)));
      const amount = ui.h('input', { type: 'number', step: '0.01', min: '0', value: String(bill.total) });
      const received = ui.h('input', { type: 'number', step: '0.01', min: '0', value: String(bill.total) });
      const reference = ui.h('input', { type: 'text', placeholder: 'Transfer or POS reference' });
      wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
        ui.h('label', { class: 'field' }, ui.h('span', { class: 'field-label' }, 'Method'), method),
        ui.h('label', { class: 'field' }, ui.h('span', { class: 'field-label' }, 'Applied to the bill'), amount),
        ui.h('label', { class: 'field' }, ui.h('span', { class: 'field-label' }, 'Cash received'), received),
        ui.h('label', { class: 'field' }, ui.h('span', { class: 'field-label' }, 'Reference'), reference)));
      const go = ui.h('button', { class: 'btn btn-primary' }, 'Take payment and print receipt');
      const payModal = ui.openModal({
        title: `Pay ${bill.bill_no}`,
        body: wrapEl,
        size: 'wide',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => payModal.close() }, 'Back'),
          go,
        ],
      });
      go.addEventListener('click', async () => {
        const applied = Number(amount.value);
        const tendered = method.value === 'CASH' ? Number(received.value || applied) : applied;
        if (!(applied > 0)) { ui.warn('Enter the amount being paid.'); return; }
        if (applied - Number(bill.total) > 0.01) { ui.warn('Do not apply more than the bill. Put the extra in Cash received so the change is recorded.'); return; }
        const payments = [{
          method: method.value,
          amount: applied,
          reference: reference.value || null,
          cash_tendered: method.value === 'CASH' ? tendered : applied,
        }];
        const short = U.round2(Number(bill.total) - applied);
        if (short > 0.01) {
          if (!bill.customer_id) {
            ui.warn('The amount is short, and this bill has no customer account to put the rest on. Take the full amount, or cancel and raise the bill against a customer.');
            return;
          }
          payments.push({ method: 'CREDIT', amount: short });
        }
        go.disabled = true;
        go.textContent = 'Recording…';
        try {
          const result = await SR.api.post(`/api/bills/${encodeURIComponent(bill.id)}/pay`, {
            branch_id: bill.branch_id,
            payments,
            walk_in_name: bill.customer_name,
            customer_name: bill.customer_name,
          }, { timeoutMs: 25000 });
          payModal.close();
          if (listModal) listModal.close();
          showPaidDocument(result, bill);
          payBillResult.replaceChildren(ui.h('div', { class: result.figures && result.figures.match === false ? 'alert alert-warn' : 'alert alert-info' },
            result.figures && result.figures.match === false
              ? `Receipt ${result.receiptNo || ''} is recorded, but it does not match ${bill.bill_no}. Do not take the payment again.`
              : `Receipt ${result.receiptNo || ''} recorded for ${bill.customer_name}. Bill, receipt and books agree.`));
          if (payCodeInput) payCodeInput.value = '';
        } catch (err) {
          ui.apiError(err);
          go.disabled = false;
          go.textContent = 'Take payment and print receipt';
        }
      });
    }

    function showPaidDocument(result, bill) {
      const brand = (SR.state.settings || {}).business_name || 'StockRidge';
      const footer = (SR.state.settings || {}).receipt_footer_text || 'Thank you for your custom.';
      const sale = {
        receipt_no: result.receiptNo,
        sold_at: result.soldAt,
        branch_name: bill.branch_name || SR.state.activeBranchName(),
        cashier_name: result.cashierName || staffName(),
        raised_by_name: bill.raised_by_name || null,
        pay_code: result.payCode || bill.pay_code || null,
        bill_no: result.billNo || bill.bill_no,
        figures: result.figures || null,
        customer_name: bill.customer_name,
        customer_phone: bill.customer_phone,
        sale_type: result.saleType || bill.sale_type,
        settlement: result.settlement || null,
        paper: result.paper || null,
        amount_paid: result.paid != null ? result.paid : null,
        subtotal: bill.subtotal,
        total: result.total != null ? result.total : (result.totals && result.totals.total != null ? result.totals.total : bill.total),
        vat_amount: result.vat && result.vat.vatAmount,
        items: result.lines || bill.lines || [],
        payments: [],
        balance_due: result.balanceDue || 0,
        change_given: result.changeGiven || 0,
        change_owed: result.changeOwed || 0,
        claim_code: result.claimCode || null,
      };
      SR.print.previewSale(sale, {
        brand, footer, autoPrint: true,
        banner: result.paper && result.paper.kind === 'INVOICE'
          ? `${result.paper.line} Bill ${bill.bill_no} is not a receipt.`
          : (result.figures && result.figures.match === false)
            ? `Receipt ${result.receiptNo} does not match bill ${bill.bill_no}. Do not take the payment again. Check the sale before the goods leave.`
            : `Paid against bill ${bill.bill_no}${bill.pay_code ? `, code ${bill.pay_code}` : ''}. Receipt, bill and books are ${U.money(sale.total)}. Received by ${sale.cashier_name}. Print the release note before the goods leave.`,
      });
      const foot = document.querySelector('.modal-foot');
      if (foot && SR.print.printRelease) {
        foot.insertBefore(ui.h('button', { class: 'btn', onClick: () => SR.print.printRelease({
          brand,
          branch_name: sale.branch_name,
          bill_no: bill.bill_no,
          receipt_no: result.receiptNo,
          customer_name: bill.customer_name,
          customer_phone: bill.customer_phone,
          sold_at: result.soldAt,
          total: sale.total,
          lines: result.lines || bill.lines || [],
        }, { autoPrint: true }) }, 'Print release note'), foot.firstElementChild);
      }
    }

    /**
     * Drop the sold units from this till's shelf copy.
     *
     * The shop has already recorded the sale by the time this runs. The name
     * used to be called and never defined, so Complete sale threw
     * "applyLocalSale is not defined" after the receipt was already in Sales.
     * A failure here must not look like a failed sale.
     */
    async function applyLocalSale(lines) {
      try {
        const branchId = SR.state.activeBranchId;
        const batches = await SR.store.all('stock_batches', {
          where: (b) => !Number(b.is_deleted)
            && String(b.status || 'ACTIVE').toUpperCase() === 'ACTIVE'
            && (!branchId || String(b.branch_id) === String(branchId)),
        });
        batches.sort((a, b) => String(a.received_at || '').localeCompare(String(b.received_at || '')));
        const need = new Map();
        for (const line of lines || []) {
          const factor = Number(line.unitFactor) > 0 ? Number(line.unitFactor) : 1;
          const base = (Number(line.quantity) || 0) * factor;
          if (!(base > 0) || !line.productId) continue;
          const id = String(line.productId);
          need.set(id, (need.get(id) || 0) + base);
        }
        const changed = [];
        for (const batch of batches) {
          const id = String(batch.product_id);
          const left = need.get(id) || 0;
          if (!(left > 0)) continue;
          const qty = Number(batch.quantity) || 0;
          const take = Math.min(Math.max(0, qty), left);
          if (!(take > 0)) continue;
          need.set(id, left - take);
          const nextQty = Math.max(0, qty - take);
          changed.push(Object.assign({}, batch, {
            quantity: nextQty,
            status: nextQty <= 0 ? 'DEPLETED' : batch.status,
          }));
        }
        if (changed.length) await SR.store.putMany('stock_batches', changed);
      } catch (err) {
        void err;
      }
    }

    // ---------------- complete ----------------
    async function completeSale() {
      const t = computedTotals();
      const creditReasonInput = document.getElementById('pos-credit-reason');
      ensureSettlement();
      if (cart.settlement === 'CREDIT' && !cart.customerId) {
        ui.warn('A credit supply needs a customer. The invoice has to belong to somebody who can pay it later.');
        return null;
      }
      if (!assertPlace()) return null;
      const payload = {
        branch_id: SR.state.activeBranchId,
        business_id: SR.state.activeBusinessId,
        sale_type: cart.saleType,
        settlement: cart.settlement,
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
        sale_place: dispatchOn ? (cart.salePlace || 'PREMISES') : null,
        vehicle_id: dispatchOn && cart.salePlace === 'VEHICLE' ? cart.vehicleId : null,
        credit_override_reason: (creditReasonInput && creditReasonInput.value.trim()) || cart.creditOverrideReason || null,
        manual_price_overrides: cart.manualPriceOverrides,
        payments: cart.payments.map((p) => ({
          method: p.method,
          amount: Number(p.amount),
          reference: p.reference || null,
          cash_tendered: p.cashTendered != null ? Number(p.cashTendered) : Number(p.amount),
        })),
        lines: cart.lines.map((l) => linePayload(l)),
        receipt_lines: cart.lines.map((l) => receiptItem(l)),
        receipt_licences: await branchLicences(),
        change_owed_amount: Number(cart.changeOwedAmount) || 0,
        claim_code: cart.claimCode || null,
        walk_in_name: cart.changeHolderName || cart.customerName || null,
        walk_in_phone: cart.changeHolderPhone || cart.customerPhone || null,
      };
      const paidNow = payload.payments.reduce((a, p) => a + (p.method === 'CREDIT' ? 0 : Number(p.amount) || 0), 0);
      const short = U.round2(t.total - paidNow);
      if (cart.settlement === 'CREDIT' && short > 0.009) {
        payload.payments.push({ method: 'CREDIT', amount: short, reference: null, cash_tendered: 0 });
      } else if (cart.settlement !== 'CREDIT' && short > 0.009 && !['INSTALMENT', 'LAYAWAY'].includes(cart.saleType)) {
        ui.warn('This sale is paid on the spot. Take the rest of the money, or choose On credit so the paper is an invoice.');
        return null;
      }
      const tenderedNow = payload.payments.reduce((a, p) => a + (p.method === 'CREDIT' ? 0 : Number(p.amount) || 0), 0);
      if (U.round2(tenderedNow - t.total - payload.change_owed_amount) > 0.01) {
        ui.warn('The payments are more than the sale, and the difference is not held as change owed. Use Hold it and print a code, or give the change now.');
        return null;
      }

      const online = SR.api.isOnline();
      // Write the sale on this till before asking the shop. A logout or a
      // dropped page while the shop is still answering must not lose it.
      const queued = await queueOffline(payload, { adjustStock: false });
      let result = queued;
      if (online) {
        try {
          const live = await SR.api.post('/api/sales', payload, { timeoutMs: 25000 });
          if (live && !live.offline && !live.queued && SR.store.markSynced) {
            await SR.store.markSynced(queued.clientId, (live.sale && live.sale.id) || live.saleId || live.receiptNo || null).catch(() => {});
          }
          await applyLocalSale(cart.lines).catch(() => {});
          if (live && !live.queued && !live.offline) result = live;
          else result = queued;
        } catch (err) {
          const refused = err && err.status >= 400 && err.status < 500 && !err.isAuth && !err.isOffline && err.code !== 'SHOP_READ_FAILED';
          if (refused) {
            if (SR.store.removeOutbox) await SR.store.removeOutbox(queued.clientId).catch(() => {});
            throw err;
          }
          await applyLocalSale(cart.lines).catch(() => {});
          result = queued;
        }
      } else {
        await applyLocalSale(cart.lines).catch(() => {});
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

    async function queueOffline(payload, { adjustStock = true } = {}) {
      if (adjustStock) await applyLocalSale(cart.lines).catch(() => {});
      const record = await SR.store.enqueue({
        type: 'SALE',
        payload,
        label: `Sale · ${cart.lines.length} line(s) · ${U.money(computedTotals().total)}`,
        occurredAt: payload.sold_at,
      });
      await rememberClaim(payload, { offline: true }).catch(() => {});
      return { offline: true, queued: true, clientId: record.client_id, cachedSale: payload, total: computedTotals().total };
    }

    function UI_afterSale() {
      void 0;
    }

    async function rememberClaim(source, extra) {
      const code = (extra && extra.claimCode) || source.claim_code || source.claimCode;
      const amount = Number((extra && extra.changeOwed) || source.change_owed_amount || source.changeOwed) || 0;
      if (!code || amount <= 0) return null;
      return SR.store.saveLocalClaim({
        claim_code: String(code).toUpperCase(),
        amount,
        customer_name: source.walk_in_name || source.customer_name || source.changeHolderName || (extra && extra.customerName) || 'Customer',
        customer_phone: source.walk_in_phone || source.customer_phone || null,
        status: extra && extra.redeemed ? 'REDEEMED' : 'OUTSTANDING',
        expires_at: (extra && extra.claimExpiresAt) || null,
        sale_id: (extra && extra.saleId) || null,
        receipt_no: (extra && extra.receiptNo) || null,
        synced: extra && extra.offline ? 0 : 1,
        branch_id: SR.state.activeBranchId,
      });
    }

    function receiptItem(line) {
      const group = U.sellingGroup({
        code: line.categoryCode || line.category_code,
        name: line.categoryName || line.category_name,
        selling_group: line.selling_group,
        category_parent_code: line.category_parent_code || line.categoryParentCode,
        nafdac_catalog_id: line.nafdacCatalogId || line.nafdac_catalog_id,
      });
      const unitPrice = line.unit_price != null ? line.unit_price : line.unitPrice;
      const qty = Number(line.quantity) || 0;
      const discount = Number(line.line_discount || line.lineDiscount || 0);
      return {
        product_name: line.product_name || line.name,
        variant_name: line.variant_name || line.variantName || null,
        quantity: line.quantity,
        unit_code: line.unit_code || line.unitCode || '',
        unit_price: unitPrice,
        line_total: line.line_total != null ? line.line_total : U.round2(qty * Number(unitPrice || 0) - discount),
        line_discount: discount,
        category_code: line.category_code || line.categoryCode || null,
        category_name: line.category_name || line.categoryName || null,
        nafdac_catalog_id: line.nafdac_catalog_id || line.nafdacCatalogId || null,
        selling_group: line.selling_group || group.code,
        selling_group_label: line.selling_group_label || group.label,
        batch_no: line.batch_no || line.batchNo || null,
        expiry_date: line.expiry_date || line.expiryDate || null,
        registration_no: line.registration_no || line.registrationNo || null,
        serialNumbers: line.serialNumbers || line.serial_numbers || [],
        serial_no: line.serial_no || ((line.serialNumbers || []).join(', ') || null),
        prescription: line.prescription || null,
        controlled_kyc: line.controlled_kyc || line.controlledKyc || null,
        warranty_months: line.warranty_months || line.warrantyMonths || 0,
      };
    }

    async function branchLicences() {
      const rows = await SR.store.all('branch_compliance_records').catch(() => []);
      const branchId = String(SR.state.activeBranchId || '');
      const out = {};
      for (const row of rows || []) {
        if (Number(row.is_deleted) || !row.record_number) continue;
        if (branchId && String(row.branch_id) !== branchId) continue;
        out[row.record_type] = row.record_number;
      }
      return out;
    }

    function receiptSale(base, lines, licences) {
      const items = (lines || []).map(receiptItem);
      return Object.assign({}, base, {
        items,
        pcn_license_no: (licences && licences.PCN) || base.pcn_license_no || null,
        nafdac_premises_no: (licences && licences.NAFDAC_PREMISES) || base.nafdac_premises_no || null,
        prescriptions: items.map((item) => item.prescription).filter((row) => row && row.prescriber_name),
        controlled_entries: items.filter((item) => item.controlled_kyc && item.controlled_kyc.buyer_name).map((item) => ({
          product_name: item.product_name,
          quantity_dispensed: item.quantity,
          buyer_name: item.controlled_kyc.buyer_name,
        })),
      });
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
        const offlineSale = {
          receipt_no: `OFFLINE-${String(result.clientId).slice(-8)}`,
          sold_at: payload.sold_at,
          branch_name: SR.state.activeBranchName(),
          cashier_name: staffName(),
          customer_name: taken.changeHolderName || taken.customerName,
          customer_phone: taken.changeHolderPhone || taken.customerPhone,
          sale_type: taken.saleType,
          settlement: payload.settlement || taken.settlement || null,
          subtotal: taken.totals.subtotal,
          total: result.total,
          amount_paid: (payload.payments || []).reduce((a, p) => a + (p.method === 'CREDIT' ? 0 : Number(p.amount) || 0), 0),
          vat_amount: taken.totals.vat,
          vat_rate_percent: taken.totals.vatRate,
          discount_amount: payload.discount_amount,
          delivery_fee: payload.delivery_fee,
          items: [],
          payments: taken.payments,
          change_owed: taken.changeOwedAmount || payload.change_owed_amount || 0,
          claim_code: taken.claimCode || payload.claim_code || null,
          balance_due: (payload.payments || []).reduce((a, p) => a + (p.method === 'CREDIT' ? Number(p.amount) || 0 : 0), 0),
        };
        const lines = (payload.receipt_lines && payload.receipt_lines.length) ? payload.receipt_lines : taken.lines;
        SR.print.previewSale(receiptSale(offlineSale, lines, payload.receipt_licences), {
          brand, footer, title: 'Offline sale recorded', autoPrint: true,
          banner: `This sale is on the device and has not reached the office yet. Local reference ${String(result.clientId).slice(-8)}.`,
        });
        return;
      } else {
        const sale = result.sale || Object.assign({}, payload, {
          receipt_no: result.receiptNo,
          sold_at: result.soldAt || payload.sold_at,
          branch_name: SR.state.activeBranchName(),
          branch_code: result.branchCode || (SR.state.activeBranch() || {}).code,
          cashier_name: result.cashierName || staffName(),
          customer_name: taken.changeHolderName || taken.customerName,
          customer_phone: taken.changeHolderPhone || taken.customerPhone,
          sale_type: taken.saleType,
          settlement: result.settlement || payload.settlement || taken.settlement || null,
          paper: result.paper || null,
          amount_paid: result.paid != null ? result.paid : null,
          subtotal: taken.totals.subtotal,
          total: result.total != null ? result.total : (result.totals && result.totals.total != null ? result.totals.total : taken.totals.total),
          vat_amount: result.vatAmount != null ? result.vatAmount : taken.totals.vat,
          vat_rate_percent: taken.totals.vatRate,
          discount_amount: payload.discount_amount,
          delivery_fee: payload.delivery_fee,
          items: [],
          payments: taken.payments,
          change_given: result.changeGiven || 0,
          change_owed: result.changeOwed || taken.changeOwedAmount || 0,
          claim_code: result.claimCode || taken.claimCode || payload.claim_code || null,
          claim_expires_at: result.claimExpiresAt || null,
          balance_due: result.balanceDue || 0,
        });
        void rememberClaim(Object.assign({}, payload, sale), {
          claimCode: sale.claim_code,
          changeOwed: sale.change_owed,
          claimExpiresAt: result.claimExpiresAt,
          saleId: result.saleId,
          receiptNo: result.receiptNo,
        });
        title = null;
        try {
          const lines = (result.lines && result.lines.length) ? result.lines : ((payload.receipt_lines && payload.receipt_lines.length) ? payload.receipt_lines : taken.lines);
          const shown = SR.print.previewSale(receiptSale(sale, lines, result.licences || payload.receipt_licences), {
            brand, footer, title, autoPrint: true,
            banner: (result.paper && result.paper.kind === 'INVOICE')
              ? result.paper.line
              : (billsFirst() && (taken.settlement || payload.settlement) !== 'CREDIT' ? 'Print the release note before the goods leave the store. The receipt is the proof of payment. It is not the gate pass.' : null),
          });
          const foot = document.querySelector('.modal-foot');
          if (foot && billsFirst() && SR.print.printRelease) {
            foot.insertBefore(ui.h('button', { class: 'btn', onClick: () => SR.print.printRelease({
              brand,
              branch_name: sale.branch_name,
              bill_no: result.billNo || null,
              receipt_no: result.receiptNo,
              customer_name: sale.customer_name,
              sold_at: sale.sold_at,
              total: sale.total,
              lines,
            }, { autoPrint: true }) }, 'Print release note'), foot.firstElementChild);
          }
          if (saleId && foot) {
            foot.insertBefore(ui.h('button', { class: 'btn', onClick: () => { SR.app.navigate(`/sales/${saleId}`); } }, 'Open the sale'), foot.firstElementChild);
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
          ui.h('div', { class: 'receipt-pair' },
            ui.h('button', { class: 'btn', onClick: () => shown && shown.close() }, 'Cancel'),
            ui.h('button', { class: 'btn btn-primary', onClick: () => SR.print.printText(text, { title }) }, 'Print')),
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
    showStep(cart.lines.length ? 'cart' : 'pay');
    paint();
    paintTotals();

    // Serials and money in the URL are ignored; a cart is device state.
    ctx.onCleanup(() => {
      clearTimeout(searchTimer);
      clearTimeout(wedgeSettle);
      document.removeEventListener('keydown', onWedgeKey, true);
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
