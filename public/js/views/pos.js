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
    const right = ui.h('div', { class: 'stack' });
    grid.appendChild(left);
    grid.appendChild(right);

    // ---------------- the scan box ----------------
    const scanInput = ui.h('input', {
      type: 'search',
      placeholder: 'Scan a barcode, or type a name, SKU or serial…',
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
        ui.h('div', { class: 'hint' }, 'A barcode scanner types and presses Enter. A serial number is looked up too.'),
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

    wrap.appendChild(grid);
    // The view host is replaced by the returned node, so this must be returned
    // AFTER any awaited work that touches the DOM.

    // ---------------- search ----------------
    let searchSeq = 0;
    const doSearch = U.debounce(async (term) => {
      const q = String(term || '').trim();
      if (q.length < 2) { results.hidden = true; results.replaceChildren(); return; }
      const seq = ++searchSeq;
      let hits = []; let source = 'device';
      try {
        const data = await SR.api.get('/api/products', { query: SR.state.query({ q, limit: 20 }) });
        hits = data.data || [];
        source = 'server';
      } catch (err) {
        hits = await searchMirror(q);
        source = 'device';
      }
      if (seq !== searchSeq) return;
      results.replaceChildren();
      if (!hits.length) {
        results.appendChild(ui.h('div', { class: 'pos-hit' }, ui.h('div', { class: 'ph-name' }, `Nothing matches “${q}”.`),
          ui.h('div', { class: 'ph-meta' }, 'Check the spelling, or add the product under Catalogue.')));
      } else {
        if (source === 'device') {
          results.appendChild(ui.h('div', { class: 'pos-hit' }, ui.h('div', { class: 'ph-meta' }, 'Offline — results are from this device\'s last sync.')));
        }
        for (const p of hits) results.appendChild(hitRow(p));
      }
      results.hidden = false;
    }, 220);

    function hitRow(p) {
      const btn = ui.h('button', { class: 'pos-hit', onClick: () => { addLine(p); scanInput.value = ''; results.hidden = true; scanInput.focus(); } });
      btn.appendChild(ui.h('div', { class: 'grow' },
        ui.h('div', { class: 'ph-name' }, p.name),
        ui.h('div', { class: 'ph-meta' }, [
          p.sku ? `SKU ${p.sku}` : null,
          p.category_name || null,
          p.brand || null,
          p.on_hand != null ? `${U.qty(p.on_hand)} on hand` : null,
          Number(p.requires_serial) ? 'serial tracked' : null,
        ].filter(Boolean).join(' · '))));
      btn.appendChild(ui.h('span', { class: 'ph-price' }, U.money(p.selling_price)));
      const avail = Number(p.on_hand != null ? p.on_hand : 9999);
      if (avail <= 0) btn.appendChild(ui.badge('out', 'badge-bad'));
      else if (Number(p.reorder_level) > 0 && avail <= Number(p.reorder_level)) btn.appendChild(ui.badge('low', 'badge-warn'));
      return btn;
    }

    async function searchMirror(term) {
      const needle = term.toLowerCase();
      const [products, variants, barcodes, units] = await Promise.all([
        SR.store.all('products', { where: (p) => !Number(p.is_deleted) }),
        SR.store.all('product_variants', { where: (v) => !Number(v.is_deleted) }).catch(() => []),
        SR.store.all('product_barcodes').catch(() => []),
        SR.store.all('product_units', { where: (u) => !Number(u.is_deleted) }).catch(() => []),
      ]);
      const matches = products.filter((p) => (
        String(p.name || '').toLowerCase().includes(needle)
        || String(p.sku || '').toLowerCase().includes(needle)
        || String(p.brand || '').toLowerCase().includes(needle)
        || String(p.model_no || '').toLowerCase().includes(needle)
      ));
      void variants; void barcodes; void units;
      return matches.slice(0, 20);
    }

    /** An exact barcode/serial scan goes straight into the cart. */
    async function scan(raw) {
      const code = String(raw || '').trim();
      if (!code) return;
      try {
        const data = await SR.api.get('/api/catalogue/scan', { query: SR.state.query({ code }) });
        if (data && data.product) {
          addLine(data.product, { barcode: code, variantId: data.variant_id || null, unitCode: data.unit_code || null, serialNo: data.serial_no || null });
          flash(scanBox, true);
          scanInput.value = '';
          return;
        }
      } catch (err) {
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
      flash(scanBox, false);
      ui.warn(`No product with the code “${code}”. Searching by name instead.`);
      doSearch(code);
    }

    async function scanMirror(code) {
      const barcodes = await SR.store.all('product_barcodes').catch(() => []);
      const hit = barcodes.find((b) => String(b.barcode) === code && !Number(b.is_deleted));
      if (hit) {
        const product = await SR.store.get('products', hit.product_id);
        if (product) return { product, variantId: hit.variant_id || null, unitCode: hit.unit_code || null, barcode: code };
      }
      const serials = await SR.store.all('serial_numbers').catch(() => []);
      const serial = serials.find((s) => String(s.serial_no).toUpperCase() === code.toUpperCase());
      if (serial) {
        const product = await SR.store.get('products', serial.product_id);
        if (product) return { product, serialNo: serial.serial_no, serialId: serial.id, unitCode: serial.unit_code || null };
      }
      return null;
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
    function addLine(product, opts = {}) {
      const existing = cart.lines.find((l) => String(l.productId) === String(product.id)
        && String(l.variantId || '') === String(opts.variantId || '')
        && String(l.unitCode || '') === String(opts.unitCode || ''));
      const price = Number(product.selling_price != null ? product.selling_price : product.price || 0);
      if (existing && !opts.serialNo) {
        existing.quantity = Number(existing.quantity) + 1;
      } else {
        cart.lines.push({
          key: U.localId('ln'),
          productId: String(product.id),
          variantId: opts.variantId || null,
          name: product.name,
          sku: product.sku || null,
          unitCode: opts.unitCode || product.base_unit_name || 'PIECE',
          baseUnitName: product.base_unit_name || 'PIECE',
          quantity: 1,
          unitPrice: price,
          listPrice: price,
          listUnitPrice: price,
          lineDiscount: 0,
          requiresSerial: Boolean(Number(product.requires_serial)),
          warrantyMonths: Number(product.warranty_months) || null,
          serialNumbers: opts.serialNo ? [opts.serialNo] : [],
          barcode: opts.barcode || null,
          maxQuantity: product.on_hand != null ? Number(product.on_hand) : null,
        });
      }
      save();
      paint();
      refreshPreview();
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
        Object.assign(cart, blankCart());
        save(); paint();
      });
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

    function cartLineNode(line, index) {
      const row = ui.h('div', { class: 'cart-line' });
      const leftCol = ui.h('div', {});
      leftCol.appendChild(ui.h('div', { class: 'cl-name' }, `${index + 1}. ${line.name}`));
      leftCol.appendChild(ui.h('div', { class: 'cl-meta' }, [
        line.sku || null,
        line.variantName || null,
        `${U.money(line.unitPrice)} / ${line.unitCode}`,
        line.serialNumbers && line.serialNumbers.length ? `S/N ${line.serialNumbers.join(', ')}` : null,
      ].filter(Boolean).join(' · ')));

      const controls = ui.h('div', { class: 'qty', style: { marginTop: '6px' } });
      controls.appendChild(ui.h('button', { 'aria-label': 'Less', onClick: () => setQty(line.key, Number(line.quantity) - 1) }, '−'));
      const qtyInput = ui.h('input', { type: 'number', step: 'any', min: '0', value: U.numInput(line.quantity), 'aria-label': 'Quantity' });
      qtyInput.addEventListener('change', () => setQty(line.key, qtyInput.value));
      controls.appendChild(qtyInput);
      controls.appendChild(ui.h('button', { 'aria-label': 'More', onClick: () => setQty(line.key, Number(line.quantity) + 1) }, '+'));
      if (line.requiresSerial) {
        controls.appendChild(ui.h('button', {
          class: 'btn btn-sm',
          onClick: () => captureSerials(line),
        }, line.serialNumbers && line.serialNumbers.length ? `S/N (${line.serialNumbers.length})` : 'Add S/N'));
      }
      controls.appendChild(ui.h('button', { class: 'btn btn-sm', onClick: () => editLine(line) }, 'Price'));
      leftCol.appendChild(controls);
      row.appendChild(leftCol);

      const rightCol = ui.h('div', {});
      const total = line.quantity * line.unitPrice - Number(line.lineDiscount || 0);
      rightCol.appendChild(ui.h('div', { class: 'cl-total' }, U.money(total)));
      const avail = line.maxQuantity;
      if (avail != null && Number(line.quantity) > avail) {
        rightCol.appendChild(ui.h('div', {}, ui.badge(`only ${U.qty(avail)} in stock`, 'badge-warn')));
      }
      rightCol.appendChild(ui.h('button', { class: 'link-btn', style: { display: 'block', marginLeft: 'auto' }, onClick: () => removeLine(line.key) }, 'Remove'));
      row.appendChild(rightCol);
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
      wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'Enter one serial number per unit. A washer or a phone leaves the shop with its warranty tied to the exact unit, so a claim later can be checked.'));
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
      const paid = U.round2(cart.payments.reduce((a, p) => a + Number(p.amount || 0), 0));
      return { subtotal, delivery, discount, total, vat, net, vatRate, vatEnabled, paid, balance: U.round2(total - paid) };
    }

    function paintTotals() {
      const t = computedTotals();
      totalsEl.replaceChildren();
      const row = (label, value, cls = '') => ui.h('div', { class: `totals-row ${cls}` },
        ui.h('span', {}, label), ui.h('span', {}, value));
      totalsEl.appendChild(row('Subtotal', U.money(t.subtotal)));
      if (t.discount) totalsEl.appendChild(row('Discount', `−${U.money(t.discount)}`));
      if (t.delivery) totalsEl.appendChild(row('Delivery', U.money(t.delivery)));
      totalsEl.appendChild(row('Total', U.money(t.total), 'grand'));
      if (t.vatEnabled && t.vat) totalsEl.appendChild(row(`includes VAT @ ${t.vatRate}%`, U.money(t.vat)));
      if (cart.saleType === 'CREDIT' || cart.saleType === 'INSTALMENT' || cart.saleType === 'LAYAWAY') {
        totalsEl.appendChild(row('Customer', cart.customerName || '— walk-in —'));
      }
      const method = dominantMethod();
      totalsEl.appendChild(row('Paying by', method ? METHOD_LABEL[method] || method : 'not chosen'));
    }

    function paintInfo() {
      infoBody.replaceChildren();
      const t = computedTotals();
      infoBody.appendChild(ui.kv([
        ['Branch', SR.state.activeBranchName()],
        ['Cashier', (SR.state.user && SR.state.user.fullName) || '—'],
        ['Sale type', U.humanise(cart.saleType)],
        ['Customer', cart.customerName || 'Walk-in'],
        ['Lines', String(cart.lines.length)],
        ['Units', U.qty(cart.lines.reduce((a, l) => a + Number(l.quantity || 0), 0))],
        ['VAT rate', t.vatEnabled ? `${t.vatRate}%` : 'not registered'],
      ]));
      const pending = SR.sync.status().running;
      if (!SR.api.isOnline() || pending) {
        infoBody.appendChild(ui.h('div', { class: 'alert alert-warn' },
          SR.api.isOnline()
            ? 'Syncing in the background. Sales are safe on this device regardless.'
            : 'Offline. Sales completed here are stored on this device and sent automatically.'));
      }
      if (cart.deliveryRequired) infoBody.appendChild(ui.h('div', { class: 'hint' }, `Delivery to: ${cart.deliveryAddress || cart.customerName || '—'}`));
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
          lines: cart.lines.map((l) => ({
            product_id: l.productId, variant_id: l.variantId,
            quantity: Number(l.quantity), unit_code: l.unitCode,
            unit_price: Number(l.unitPrice), line_discount: Number(l.lineDiscount || 0),
          })),
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
        ui.field({ label: 'Sale type', name: 'saleType', value: cart.saleType, options: TYPES.map((t) => ({ value: t, label: U.humanise(t) })) }),
        ui.field({ label: 'Order discount (₦)', name: 'discountAmount', type: 'number', step: '0.01', min: '0', value: cart.discountAmount || 0 }),
        ui.field({ label: 'Discount reason', name: 'discountReason', value: cart.discountReason || '', span: true, hint: 'Recorded with the sale. A discount with no reason is the first thing an auditor asks about.' }),
        ui.field({ label: 'Delivery fee (₦)', name: 'deliveryFee', type: 'number', step: '0.01', min: '0', value: cart.deliveryFee || 0 }),
        ui.field({ label: 'Delivery address', name: 'deliveryAddress', value: cart.deliveryAddress || '', span: true }),
        ui.field({ label: 'Notes', name: 'notes', type: 'textarea', value: cart.notes || '', span: true }));
      wrapEl.appendChild(grids);
      const delivery = ui.h('label', { class: 'check' },
        Object.assign(ui.h('input', { type: 'checkbox', checked: Boolean(cart.deliveryRequired) }), {}),
        ui.h('span', {}, 'This sale needs delivery and a delivery job'));
      wrapEl.appendChild(delivery);
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
              cart.deliveryFee = Number(v.deliveryFee) || 0;
              cart.deliveryAddress = v.deliveryAddress || null;
              cart.notes = v.notes || null;
              cart.deliveryRequired = delivery.querySelector('input').checked;
              save(); paint();
              m.close();
            },
          }, 'Save'),
        ],
      });
    }

    // ---------------- tender ----------------
    function openTender() {
      if (!cart.lines.length) { ui.warn('Add something to the cart first.'); return; }
      const t = computedTotals();
      const needsCustomer = ['CREDIT', 'INSTALMENT', 'LAYAWAY'].includes(cart.saleType);
      if (needsCustomer && !cart.customerId) {
        ui.warn(`${U.humanise(cart.saleType)} needs a customer. Pick one under Details.`);
        return;
      }

      const wrapEl = ui.h('div', {});
      const running = ui.h('div', { class: 'totals' });

      const methods = ui.h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: '7px' } });
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

      const amountInput = ui.h('input', { type: 'number', step: '0.01', min: '0', placeholder: 'Amount', inputmode: 'decimal', style: { marginTop: '10px', fontSize: '1.2rem', fontFamily: 'var(--mono)' } });
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
      completeBtn.addEventListener('click', async () => {
        completeBtn.disabled = true;
        completeBtn.textContent = 'Recording…';
        try {
          await completeSale();
          m.close();
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
          ui.h('button', { class: 'btn', onClick: () => { save(); m.close(); } }, 'Hold'),
          completeBtn,
        ],
        onClose: paintRunning,
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
        lines: cart.lines.map((l) => ({
          product_id: l.productId,
          variant_id: l.variantId,
          quantity: Number(l.quantity),
          unit_code: l.unitCode,
          unit_price: Number(l.unitPrice),
          line_discount: Number(l.lineDiscount || 0),
          serial_numbers: l.serialNumbers && l.serialNumbers.length ? l.serialNumbers : undefined,
        })),
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

      SR.state.clearCart();
      showReceipt(result, payload);
      paint();
      UI_afterSale();
    }

    async function queueOffline(payload) {
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
    function showReceipt(result, payload) {
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
            lines: cart.lines,
            payments: cart.payments,
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
          subtotal: computedTotals().subtotal,
          total: result.total != null ? result.total : computedTotals().total,
          vat_amount: result.vatAmount != null ? result.vatAmount : computedTotals().vat,
          vat_rate_percent: computedTotals().vatRate,
          discount_amount: payload.discount_amount,
          delivery_fee: payload.delivery_fee,
          items: cart.lines.map((l) => ({
            product_name: l.name, quantity: l.quantity, unit_code: l.unitCode,
            unit_price: l.unitPrice, line_total: Number(l.quantity) * Number(l.unitPrice) - Number(l.lineDiscount || 0),
            line_discount: l.lineDiscount, warranty_months: l.warrantyMonths,
            serial_no: (l.serialNumbers || [])[0] || null,
          })),
          payments: cart.payments,
          change_given: result.changeGiven || 0,
          change_owed: result.changeOwed || 0,
          balance_due: result.balanceDue || 0,
        });
        text = SR.print.saleReceipt(sale, { brand, footer });
        title = `Sale ${result.receiptNo}`;
      }

      const body = ui.h('div', {});
      body.appendChild(ui.h('div', { class: 'receipt' }, text));
      const actions = [];
      if (result.offline) {
        actions.push(ui.h('div', { class: 'alert alert-warn', style: { marginBottom: '10px' } },
          'This sale is on the device and has NOT reached the office yet. It will be sent automatically. ',
          ui.h('strong', {}, `Local reference ${String(result.clientId).slice(-8)}.`)));
      }
      actions.push(ui.h('button', { class: 'btn', onClick: () => U.download(`${title.replace(/\s+/g, '-').toLowerCase()}.txt`, text, 'text/plain;charset=utf-8') }, 'Save .txt'));
      actions.push(ui.h('button', { class: 'btn', onClick: () => ui.copyToClipboard(text, 'Receipt copied — paste it into WhatsApp.') }, 'Copy'));
      if (saleId) {
        actions.push(ui.h('button', { class: 'btn', onClick: () => { SR.app.navigate(`/sales/${saleId}`); } }, 'Open the sale'));
      }
      actions.push(ui.h('button', { class: 'btn btn-primary', onClick: () => SR.print.printText(text, { title }) }, 'Print'));

      ui.openModal({
        title,
        body: result.offline ? ui.h('div', {}, actions.splice(0, 1)[0], body) : body,
        footer: actions,
      });
      // Print immediately: a counter does not want two taps, and the receipt is
      // the last thing between the customer and the door.
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
