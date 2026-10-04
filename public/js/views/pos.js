// =====================================================================
// public/js/views/pos.js — THE TILL
// =====================================================================
// The screen a shop lives in. Every design decision here is about one thing:
// the operator must be able to complete a sale without thinking about the
// system.
//
// WHAT THAT MEANT IN PRACTICE:
//
//   * Search is one field that matches name, SKU and barcode. Nobody at a
//     counter wants to choose which kind of lookup they are doing.
//   * Quantity defaults to 1 and the keypad starts on the quantity field,
//     because "scan, 1, pay" is most of the day.
//   * The unit ladder is a set of buttons showing what each rung CONTAINS
//     ("carton = 24 packs"), not a dropdown of codes. An operator who has to
//     remember whether a carton is 12 or 24 will get it wrong, and the stock
//     report inherits the error silently.
//   * The total is on screen at all times, in large type, from the first line.
//   * Serial capture is not a separate step the operator must remember: the line
//     is marked as needing serials the moment it is added, and the sale button
//     says why it is blocked.
//   * Change is computed and shown before the operator asks.
//   * The pricing trail is available but hidden. When a customer disputes a
//     price, the cashier can show exactly which rule produced it — which ends the
//     argument. Showing it always would clutter the screen for the 99% of sales
//     where nobody asks.
//
// WHAT IT DOES NOT DO:
//   * It never computes a price locally. The server prices the sale
//     (shared/lib/pricing.js) and the screen displays what came back. Two price
//     engines — one in JS, one in SQL — will eventually disagree, and the
//     disagreement will be about money.
//   * It never lets a discount or a below-floor price through without an
//     approval, and it says so in the operator's words rather than as a code.

'use strict';

import { endpoints as api } from '../api.js';
import {
  state, activeBusiness, activeBranch, naira, maxDiscountPercent, atLeast, can,
} from '../state.js';
import { newIdempotencyKey } from '../offline.js';
import {
  el, clear, icon, toast, reportError, modal, field, readForm, badge, table,
  spinner, emptyState, money,
} from '../ui.js';

export default async function posView(ctx) {
  const host = ctx.host;
  const branch = activeBranch();
  const business = activeBusiness();

  if (!branch) {
    host.appendChild(emptyState('Choose a branch first',
      'A sale has to belong to a branch, because that is which drawer the cash goes into and which shelf the stock comes off.',
      null, null));
    return {};
  }

  // The basket lives in memory and is rebuilt into the DOM on every change.
  const basket = [];
  let customer = null;
  let saleDiscountPercent = 0;
  let quote = null;          // the server's priced view of the basket
  let registerBuyer = null;
  let tillWarningShown = false;

  // -------------------------------------------------------------------
  // layout
  // -------------------------------------------------------------------
  const linesHost = el('div', { class: 'pos-lines', id: 'pos-lines' });
  const totalsHost = el('div', { class: 'pos-totals', id: 'pos-totals' });
  const payHost = el('div', { class: 'pos-pay', id: 'pos-pay' });
  const searchInput = el('input', {
    id: 'pos-search', type: 'search', placeholder: 'Scan a barcode, or type a name / SKU…',
    autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
  });
  const resultsHost = el('div', { class: 'pos-results', id: 'pos-results' });

  host.appendChild(el('div', { class: 'pos' },
    el('section', { class: 'pos-left' },
      el('header', { class: 'pos-head' },
        el('div', { class: 'pos-search-wrap' },
          el('span', { class: 'pos-search-icon' }, icon('barcode')),
          searchInput,
          el('button', { class: 'btn btn-ghost btn-sm', id: 'pos-clear', title: 'Clear the basket' }, 'Clear')),
        el('div', { class: 'pos-customer' },
          el('button', { class: 'btn btn-ghost btn-sm', id: 'pos-customer-btn' },
            icon('users'), el('span', { id: 'pos-customer-label', text: 'Walk-in' }))),
      ),
      resultsHost,
      linesHost,
    ),
    el('section', { class: 'pos-right' },
      totalsHost,
      payHost,
    ),
  ));

  // -------------------------------------------------------------------
  // product search
  // -------------------------------------------------------------------
  let searchTimer = null;
  let productsCache = [];

  async function loadProducts(term = '') {
    try {
      const rows = await api.products({ business_id: business.id, search: term, limit: 40 });
      productsCache = rows;
      paintResults(rows, term);
    } catch (e) {
      reportError(e, { context: 'Could not load products' });
    }
  }

  function paintResults(rows, term) {
    clear(resultsHost);
    if (!term && !rows.length) return;
    if (!rows.length) {
      resultsHost.appendChild(el('div', { class: 'pos-noresult' },
        `Nothing matches “${term}”. Check the spelling, or scan the barcode instead.`));
      return;
    }
    const list = el('div', { class: 'pos-result-grid' });
    for (const p of rows.slice(0, 24)) {
      const out = Number(p.sellable) <= 0;
      const needsSerial = !!Number(p.serial_tracking);
      list.appendChild(el('button', {
        class: 'pos-tile', disabled: false,
        onclick: () => addLine(p),
        title: out ? 'No sellable stock at this branch — you can still add it, but the sale will be refused' : p.name,
      },
      el('span', { class: 'pos-tile-name', text: p.name }),
      el('span', { class: 'pos-tile-meta' },
        el('strong', { text: naira(p.default_selling_price) }),
        el('span', { class: out ? 'pos-tile-out' : 'pos-tile-stock', text: out ? 'none in stock' : `${p.sellable} ${String(p.base_unit || '').toLowerCase()}` })),
      needsSerial ? el('span', { class: 'pos-tile-flag', title: 'This line needs a serial number per unit' }, 'SN') : null,
      Number(p.register_required) === 1 ? el('span', { class: 'pos-tile-flag pos-tile-flag-reg', title: 'High-value: the buyer must be named in the register' }, 'REG') : null));
    }
    resultsHost.appendChild(list);
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const term = searchInput.value.trim();
    // A barcode scan arrives as a burst of characters followed by Enter. Waiting
    // 180ms before searching keeps a scan from firing six partial queries while
    // still feeling instant to a human typing.
    searchTimer = setTimeout(() => {
      if (/^\d{8,14}$/.test(term)) { lookupBarcode(term); return; }
      loadProducts(term);
    }, 180);
  });

  searchInput.addEventListener('keydown', async (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const term = searchInput.value.trim();
      if (!term) return;
      // A pure-digit entry is treated as a barcode FIRST. That is the right
      // order: a scan must never be misread as a product-name search and return
      // eleven approximate matches for the cashier to choose from mid-queue.
      if (/^\d{8,14}$/.test(term)) { await lookupBarcode(term); return; }
      const rows = productsCache;
      if (rows.length === 1) { addLine(rows[0]); searchInput.value = ''; clear(resultsHost); }
      else if (rows.length) { await loadProducts(term); }
      else { await loadProducts(term); }
    }
    if (ev.key === 'Escape') { clear(resultsHost); }
  });

  async function lookupBarcode(code) {
    try {
      const res = await api.barcode(code, branch.id);
      if (!res.found) {
        toast(`No product has the barcode ${code}. If this is a new item, add it under Stock first.`, { kind: 'warn', duration: 5000 });
        searchInput.select();
        return;
      }
      const p = await api.product(res.product.id);
      addLine({ ...p, unit_type: res.unit_type, sellable: res.stock ? res.stock.sellable : null });
      searchInput.value = '';
      clear(resultsHost);
    } catch (e) {
      reportError(e, { context: 'Barcode lookup failed' });
    }
  }

  // -------------------------------------------------------------------
  // basket
  // -------------------------------------------------------------------
  function addLine(product, opts = {}) {
    const unitType = opts.unit_type || product.unit_type || 'BASE_UNIT';
    const existing = basket.find((l) => l.product.id === product.id && l.unit_type === unitType && !l.serials.length);
    if (existing && !opts.replace) {
      existing.quantity += 1;
    } else {
      basket.push({
        product,
        quantity: opts.quantity || 1,
        unit_type: unitType,
        serials: [],
        discount: null,
        rung_price: opts.rung_price != null ? Number(opts.rung_price) : null,
        age_confirmed: false,
        age_stated: null,
        authority_document: null,
      });
    }
    clear(resultsHost);
    render();
    // Ask for the serial immediately, while the unit is physically in the
    // operator's hand. Collecting serials at the end means walking back to the
    // shelf, and in practice it means not collecting them at all.
    if (needsSerialCapture(basket[basket.length - 1])) promptSerials(basket[basket.length - 1]);
  }

  function needsSerialCapture(line) {
    const p = line.product;
    const restriction = p.restriction || p.restriction_reason;
    return restriction === 'SERIAL_CAPTURE' || Number(p.serial_tracking) === 1;
  }

  function needsRegister(line) {
    return Number(line.product.register_required) === 1;
  }

  function removeLine(idx) {
    basket.splice(idx, 1);
    render();
  }

  function lineRungChoices(product) {
    const ladder = product.ladder || [];
    return ladder.filter((r) => r.configured && r.pieces != null);
  }

  // -------------------------------------------------------------------
  // render
  // -------------------------------------------------------------------
  function render() {
    renderLines();
    renderTotals();
    renderPay();
  }

  function renderLines() {
    clear(linesHost);
    if (!basket.length) {
      linesHost.appendChild(el('div', { class: 'pos-empty' },
        el('p', { text: 'Scan or search to start a sale.' }),
        el('p', { class: 'muted', text: 'Enter to add the highlighted item. The quantity field takes focus automatically.' })));
      return;
    }
    for (let i = 0; i < basket.length; i += 1) {
      const line = basket[i];
      const p = line.product;
      const priced = quote && quote.lines ? quote.lines[i] : null;
      const rungs = lineRungChoices(p);

      const qtyInput = el('input', {
        class: 'pos-qty', type: 'number', min: p.allows_fractional_qty ? '0.01' : '1',
        step: p.allows_fractional_qty ? '0.01' : '1', value: line.quantity,
        'aria-label': `Quantity of ${p.name}`,
        onchange: (ev) => { line.quantity = Number(ev.target.value) || 1; priceBasket(); },
      });

      const unitSel = rungs.length > 1
        ? el('select', {
          class: 'pos-unit', 'aria-label': `Selling unit for ${p.name}`,
          onchange: (ev) => { line.unit_type = ev.target.value; line.rung_price = null; priceBasket(); },
        }, rungs.map((r) => el('option', {
          value: r.unit,
          // Spell out what the rung contains. "CARTON" alone is a guess;
          // "carton (24 packs = 288 pieces)" is not.
          text: r.unit === 'BASE_UNIT' ? String(p.base_unit || 'unit').toLowerCase()
            : `${r.unit.toLowerCase()} = ${r.pieces.toLocaleString('en-NG')} ${String(p.base_unit || 'unit').toLowerCase()}s`,
          selected: r.unit === line.unit_type,
        })))
        : el('span', { class: 'pos-unit-fixed', text: String(p.base_unit || 'unit').toLowerCase() });

      const serialBtn = needsSerialCapture(line)
        ? el('button', {
          class: `btn btn-sm ${line.serials.length >= requiredSerials(line) ? 'btn-ok' : 'btn-warn'}`,
          onclick: () => promptSerials(line),
          title: 'One serial number per unit being sold',
        }, `${line.serials.length}/${requiredSerials(line)} serial${requiredSerials(line) === 1 ? '' : 's'}`)
        : null;

      const regBtn = needsRegister(line)
        ? el('button', {
          class: `btn btn-sm ${registerBuyer ? 'btn-ok' : 'btn-warn'}`,
          onclick: () => promptRegisterBuyer(),
          title: 'High-value item: the buyer must be named in the register',
        }, registerBuyer ? 'Buyer recorded' : 'Buyer needed')
        : null;

      const ageBtn = (p.restriction === 'AGE_VERIFICATION' || p.restriction_reason === 'AGE_VERIFICATION')
        ? el('button', {
          class: `btn btn-sm ${line.age_confirmed ? 'btn-ok' : 'btn-warn'}`,
          onclick: () => promptAge(line),
        }, line.age_confirmed ? `Age ${line.age_stated}` : 'Confirm age')
        : null;

      const authBtn = (p.restriction === 'AUTHORITY_DOCUMENT' || p.restriction_reason === 'AUTHORITY_DOCUMENT')
        ? el('button', {
          class: `btn btn-sm ${line.authority_document ? 'btn-ok' : 'btn-warn'}`,
          onclick: () => promptAuthority(line),
        }, line.authority_document ? 'PO recorded' : 'Authority doc')
        : null;

      linesHost.appendChild(el('div', { class: 'pos-line' },
        el('div', { class: 'pos-line-main' },
          el('span', { class: 'pos-line-name', text: p.name }),
          el('span', { class: 'pos-line-sku muted', text: p.sku || '' }),
          el('div', { class: 'pos-line-controls' }, qtyInput, unitSel, serialBtn, regBtn, ageBtn, authBtn,
            el('button', { class: 'btn btn-sm btn-ghost', onclick: () => promptLineDiscount(line), title: 'Discount this line' }, '%'),
            el('button', { class: 'btn btn-sm btn-danger-ghost', onclick: () => removeLine(i), 'aria-label': `Remove ${p.name}` }, '×')),
        ),
        el('div', { class: 'pos-line-money' },
          el('span', { class: 'pos-line-total', text: priced ? money(priced.net) : money(Number(p.default_selling_price) * line.quantity) }),
          priced && priced.discount > 0 ? el('span', { class: 'pos-line-discount', text: `−${money(priced.discount)}` }) : null,
          el('button', { class: 'pos-line-trail', title: 'Why this price?', onclick: () => showTrail(line, priced) }, '?')),
      ));
    }
    linesHost.appendChild(el('div', { class: 'pos-add-more' },
      el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { searchInput.focus(); } }, icon('plus'), ' Add another item')));
  }

  function requiredSerials(line) {
    const p = line.product;
    const rung = (p.ladder || []).find((r) => r.unit === line.unit_type);
    const perUnit = rung && rung.pieces ? rung.pieces : 1;
    return Math.round(Number(line.quantity) * perUnit);
  }

  function renderTotals() {
    clear(totalsHost);
    const t = quote ? quote.totals : localEstimate();
    totalsHost.appendChild(el('div', { class: 'pos-total-grid' },
      el('div', {}, el('span', { text: 'Subtotal' }), el('span', { text: money(t.subtotal) })),
      t.discount > 0 ? el('div', { class: 'row-discount' }, el('span', { text: 'Discount' }), el('span', { text: `−${money(t.discount)}` })) : null,
      state.settings && Number(state.settings.default_vat_enabled || (business && business.vat_enabled)) || (business && Number(business.vat_enabled))
        ? el('div', { class: 'row-vat', title: 'VAT is included in the prices shown, not added on top' },
          el('span', { text: `VAT @ ${Number(business.vat_rate_percent || 7.5)}% (included)` }), el('span', { text: money(t.vat) }))
        : null,
      t.exempt > 0 ? el('div', { class: 'row-exempt', title: 'Some items on this sale are VAT-exempt' },
        el('span', { text: 'of which exempt' }), el('span', { text: money(t.exempt) })) : null,
    ));
    totalsHost.appendChild(el('div', { class: 'pos-grand' },
      el('span', { text: 'TOTAL' }),
      el('strong', { id: 'pos-grand-total', text: money(t.total) })));
    if (quote && quote.margin_percent != null && atLeast('MANAGER')) {
      totalsHost.appendChild(el('div', { class: 'pos-margin muted', title: 'Revenue net of VAT less the cost of the batches actually picked' },
        `Margin ${money(quote.totals.margin)} (${quote.margin_percent}%)`));
    }
  }

  /** A local estimate is shown ONLY until the server prices the basket. It is
   *  deliberately simple and deliberately labelled as an estimate, because two
   *  price engines that disagree about money is worse than a brief flicker. */
  function localEstimate() {
    let subtotal = 0;
    for (const l of basket) {
      const rung = (l.product.ladder || []).find((r) => r.unit === l.unit_type);
      const perUnit = rung && rung.pieces ? rung.pieces : 1;
      const price = l.rung_price != null ? l.rung_price : Number(l.product.default_selling_price) || 0;
      subtotal += l.rung_price != null ? price * Number(l.quantity) : price * perUnit * Number(l.quantity);
    }
    return { subtotal, discount: 0, vat: 0, exempt: 0, total: subtotal, margin: 0 };
  }

  function renderPay() {
    clear(payHost);
    const t = quote ? quote.totals : localEstimate();
    const blockers = currentBlockers();

    if (blockers.length) {
      payHost.appendChild(el('div', { class: 'pos-blocked' },
        el('strong', { text: 'This sale cannot be completed yet' }),
        el('ul', {}, blockers.map((b) => el('li', { text: b })))));
    }

    payHost.appendChild(el('div', { class: 'pos-tender-grid' },
      tenderButton('CASH', 'Cash', t.total),
      tenderButton('POS_TERMINAL', 'POS terminal', t.total),
      tenderButton('BANK_TRANSFER', 'Bank transfer', t.total),
      tenderButton('MOBILE_MONEY', 'Mobile money', t.total),
      el('button', { class: 'btn btn-tender btn-tender-split', onclick: () => openSplitPayment(t) }, 'Split / part pay'),
      el('button', {
        class: 'btn btn-tender btn-tender-credit',
        onclick: () => openCreditSale(t),
        title: customer ? `Put the balance on ${customer.name}'s account` : 'Choose a customer first — an anonymous debt cannot be chased',
      }, 'On account'),
    ));

    payHost.appendChild(el('div', { class: 'pos-sale-actions' },
      saleDiscountPercent > 0
        ? el('button', { class: 'btn btn-ghost btn-sm', onclick: () => promptSaleDiscount() }, `Whole-sale discount ${saleDiscountPercent}% — change`)
        : el('button', { class: 'btn btn-ghost btn-sm', onclick: () => promptSaleDiscount() }, 'Discount the whole sale'),
      el('button', { class: 'btn btn-ghost btn-sm', onclick: () => openDeliveryOptions(t) }, 'Delivery…'),
      el('button', { class: 'btn btn-ghost btn-sm', onclick: () => openHoldOptions() }, 'Hold / layaway…'),
    ));

    payHost.appendChild(el('div', { class: 'pos-footer-note muted' },
      `Branch: ${branch.name} · ${t && basket.length ? `${basket.reduce((a, l) => a + Number(l.quantity), 0)} item(s)` : 'basket empty'}`));
  }

  function currentBlockers() {
    const out = [];
    if (!basket.length) out.push('The basket is empty.');
    for (let i = 0; i < basket.length; i += 1) {
      const l = basket[i];
      if (needsSerialCapture(l) && l.serials.length < requiredSerials(l)) {
        out.push(`${l.product.name}: ${requiredSerials(l) - l.serials.length} more serial number(s) needed.`);
      }
      if (needsRegister(l) && !registerBuyer) {
        out.push(`${l.product.name} is high-value: record the buyer's name for the register.`);
      }
      if ((l.product.restriction === 'AGE_VERIFICATION' || l.product.restriction_reason === 'AGE_VERIFICATION') && !l.age_confirmed) {
        out.push(`${l.product.name} is age-restricted: confirm the buyer is 18 or over.`);
      }
      if ((l.product.restriction === 'AUTHORITY_DOCUMENT' || l.product.restriction_reason === 'AUTHORITY_DOCUMENT') && !l.authority_document) {
        out.push(`${l.product.name} needs an authorising document reference.`);
      }
      if (l.product.sellable != null && Number(l.product.sellable) < requiredBaseQty(l)) {
        out.push(`${l.product.name}: only ${l.product.sellable} sellable at ${branch.name}.`);
      }
    }
    return out;
  }

  function requiredBaseQty(line) {
    const rung = (line.product.ladder || []).find((r) => r.unit === line.unit_type);
    const perUnit = rung && rung.pieces ? rung.pieces : 1;
    return Math.round(Number(line.quantity) * perUnit);
  }

  function tenderButton(method, label, total) {
    return el('button', {
      class: `btn btn-tender btn-tender-${method.toLowerCase()}`,
      onclick: () => completeSale([{ method, amount: total }]),
    }, el('strong', { text: label }), el('span', { text: money(total) }));
  }

  // -------------------------------------------------------------------
  // pricing (server-authoritative)
  // -------------------------------------------------------------------
  let priceTimer = null;
  function priceBasket() {
    render();
    clearTimeout(priceTimer);
    if (!basket.length) { quote = null; render(); return; }
    priceTimer = setTimeout(async () => {
      try {
        quote = await api.createSale(buildPayload(), null);
      } catch (e) {
        quote = null;
      }
      render();
    }, 250);
  }

  function buildPayload() {
    return {
      business_id: business.id,
      branch_id: branch.id,
      customer_id: customer ? customer.id : null,
      lines: basket.map((l) => ({
        product_id: l.product.id,
        quantity: Number(l.quantity),
        unit_type: l.unit_type,
        rung_price: l.rung_price,
        serial_numbers: l.serials,
        discount: l.discount,
      })),
      discount_percent: saleDiscountPercent || undefined,
      register_buyer: registerBuyer || undefined,
      age_verification: basket.reduce((acc, l, i) => {
        if (l.age_confirmed) acc[i] = { confirmed: true, age_stated: l.age_stated };
        return acc;
      }, {}),
      authority_documents: basket.reduce((acc, l, i) => {
        if (l.authority_document) acc[i] = l.authority_document;
        return acc;
      }, {}),
    };
  }

  // -------------------------------------------------------------------
  // completion
  // -------------------------------------------------------------------
  async function completeSale(tenders, extra = {}) {
    const blockers = currentBlockers();
    if (blockers.length) {
      toast(blockers[0], { kind: 'warn', duration: 6000 });
      return;
    }
    // ONE key per operator action, reused on every retry. Without it a dropped
    // connection followed by a retry records the sale twice: stock out twice,
    // cash counted twice, and the customer's receipt contradicted by the books.
    const key = extra.__key || newIdempotencyKey('sale');
    const payload = { ...buildPayload(), tenders, ...extra };
    delete payload.__key;

    try {
      const res = await api.createSale(payload, key);
      if (res.__queued) {
        toast(res.message, { kind: 'warn', duration: 9000 });
        resetBasket();
        return;
      }
      onSaleComplete(res);
    } catch (e) {
      if (e.status === 409 && e.code === 'NO_OPEN_TILL') {
        // Offer to open the till rather than just refusing: a cashier who cannot
        // sell is a shop that is closed, and the fix is one counted float away.
        const doOpen = await confirmOpenTill(e.message);
        if (doOpen) return completeSale(tenders, { ...extra, __key: key });
        return;
      }
      if (e.details && Array.isArray(e.details) && e.details.length) {
        showValidationErrors(e);
        return;
      }
      reportError(e, { context: 'The sale could not be completed' });
    }
  }

  function onSaleComplete(res) {
    const t = res.totals;
    toast(`Sale ${res.saleNumber} — ${money(t.total)}${t.change > 0 ? ` · change ${money(t.change)}` : ''}`, { kind: 'good', duration: 5000 });
    showReceipt(res, t);
    resetBasket();
  }

  function resetBasket() {
    basket.length = 0;
    quote = null;
    saleDiscountPercent = 0;
    registerBuyer = null;
    searchInput.value = '';
    clear(resultsHost);
    render();
    searchInput.focus();
    loadProducts('');
  }

  function showReceipt(res, t) {
    const changeRow = t.change > 0
      ? el('div', { class: 'receipt-change' }, el('span', { text: 'CHANGE DUE' }), el('strong', { text: money(t.change) }))
      : null;
    const queued = res.changeRoute === 'CHANGE_OWED'
      ? el('p', { class: 'receipt-note' }, `The drawer could not make this change. A claim code was issued: ${res.changeOwedCode || '—'}. The customer can collect it at any branch.`)
      : null;
    const m = modal({
      title: `Sale ${res.saleNumber}`,
      size: 'sm',
      body: el('div', { class: 'receipt' },
        el('div', { class: 'receipt-row' }, el('span', { text: 'Total' }), el('strong', { text: money(t.total) })),
        t.vat > 0 ? el('div', { class: 'receipt-row muted' }, el('span', { text: `includes VAT @ ${business.vat_rate_percent || 7.5}%` }), el('span', { text: money(t.vat) })) : null,
        el('div', { class: 'receipt-row' }, el('span', { text: 'Paid' }), el('span', { text: money(t.paid) })),
        changeRow,
        t.balance_due > 0 ? el('div', { class: 'receipt-row receipt-balance' }, el('span', { text: 'BALANCE DUE' }), el('strong', { text: money(t.balance_due) })) : null,
        queued,
        el('p', { class: 'muted receipt-meta', text: `${branch.name} · ${new Date().toLocaleString('en-NG')}` })),
      footer: el('div', { class: 'row-end' },
        el('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Close'),
        el('button', { class: 'btn btn-primary', onclick: () => printReceipt(res.saleId) }, 'Print receipt')),
    });
    // Focus the close button so Enter dismisses and the operator can start the
    // next sale without reaching for the mouse.
    setTimeout(() => searchInput.focus(), 50);
  }

  async function printReceipt(saleId) {
    try {
      const r = await api.receipt(saleId);
      openPrintWindow(r);
    } catch (e) { reportError(e, { context: 'Could not load the receipt' }); }
  }

  // -------------------------------------------------------------------
  // prompts
  // -------------------------------------------------------------------
  function promptSerials(line) {
    const need = requiredSerials(line);
    const inputs = [];
    for (let i = 0; i < need; i += 1) {
      inputs.push(el('input', {
        class: 'serial-input', placeholder: `Serial ${i + 1}`, value: line.serials[i] || '',
        autocapitalize: 'characters', spellcheck: 'false',
        oninput: (ev) => { line.serials[i] = ev.target.value.trim().toUpperCase(); },
        onkeydown: (ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            const next = inputs[i + 1];
            // A scanner sends Enter after the code. Moving focus to the next field
            // means one scan per unit with no clicking, which is the difference
            // between serial capture being used and being skipped.
            if (next) next.focus(); else { render(); m.close(); }
          }
        },
      }));
    }
    const hint = el('p', { class: 'hint', text: `One serial per unit. A scanner types the code and presses Enter, so each scan moves to the next box automatically.` });
    const m = modal({
      title: `Serial numbers — ${line.product.name}`,
      body: el('div', {}, hint, el('div', { class: 'serial-grid' }, inputs)),
      footer: el('div', { class: 'row-end' },
        el('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Done')),
    });
    inputs[0].focus();
  }

  function promptRegisterBuyer() {
    const nameF = field({ label: 'Buyer name', name: 'name', required: true, value: registerBuyer ? registerBuyer.name : (customer ? customer.name : '') });
    const phoneF = field({ label: 'Phone', name: 'phone', type: 'tel', value: registerBuyer ? registerBuyer.phone : (customer ? customer.phone : ''), hint: 'So the buyer can be contacted about a recall or a warranty claim.' });
    const idTypeF = field({ label: 'ID type', name: 'id_type', type: 'select', choices: ['', 'NIN', 'BVN', 'DRIVERS_LICENCE', 'INTERNATIONAL_PASSPORT', 'VOTERS_CARD', 'WORK_ID', 'COMPANY_CAC', 'OTHER'], value: registerBuyer ? registerBuyer.id_type : '' });
    const idNumF = field({ label: 'ID number', name: 'id_number', value: registerBuyer ? registerBuyer.id_number : '' });
    const form = el('form', { onsubmit: (ev) => {
      ev.preventDefault();
      const v = readForm(form);
      if (!v.name || v.name.trim().length < 2) { toast('The buyer\'s name is required for a register entry.', { kind: 'warn' }); return; }
      if ((v.id_type && !v.id_number) || (!v.id_type && v.id_number)) {
        toast('Record both an ID type and an ID number, or neither. Half an identification is not an identification.', { kind: 'warn', duration: 7000 });
        return;
      }
      registerBuyer = { name: v.name.trim(), phone: v.phone || null, id_type: v.id_type || null, id_number: v.id_number || null };
      m.close(); render();
    } }, nameF, phoneF, idTypeF, idNumF,
    el('p', { class: 'hint', text: 'This sale includes a high-value item, so the buyer is recorded in a tamper-evident register. If this item goes missing, or a police inquiry arrives, this is the record that says who bought it.' }),
    el('div', { class: 'row-end' }, el('button', { type: 'submit', class: 'btn btn-primary' }, 'Record buyer')));
    const m = modal({ title: 'Buyer details for the register', size: 'sm', body: form });
  }

  function promptAge(line) {
    const ageF = field({ label: "Buyer's stated age", name: 'age', type: 'number', min: 1, max: 120, required: true });
    const idF = field({ label: 'ID checked?', name: 'id_checked', type: 'checkbox' });
    const form = el('form', { onsubmit: (ev) => {
      ev.preventDefault();
      const v = readForm(form);
      const age = Number(v.age) || 0;
      if (age < 18) {
        toast('This item is age-restricted and the buyer is under 18. The sale cannot proceed.', { kind: 'error', duration: 7000 });
        return;
      }
      line.age_confirmed = true;
      line.age_stated = age;
      m.close(); render();
    } },
    el('p', { class: 'modal-message', text: `${line.product.name} is age-restricted. Confirm the buyer is 18 or over, and record their stated age.` }),
    ageF, idF,
    el('p', { class: 'hint', text: 'The confirmation is written to a tamper-evident log. If the sale is ever questioned, this is the evidence that the check was made.' }),
    el('div', { class: 'row-end' }, el('button', { type: 'submit', class: 'btn btn-primary' }, 'Confirm and record')));
    const m = modal({ title: 'Age verification', size: 'sm', body: form });
  }

  function promptAuthority(line) {
    const typeF = field({ label: 'Document type', name: 'document_type', type: 'select', choices: ['PURCHASE_ORDER', 'WORKS_INSTRUCTION', 'CONSULTANT_APPROVAL', 'CONTRACTOR_LETTER', 'GOVERNMENT_AWARD', 'INSURANCE_AUTHORISATION', 'PRO_FORMA_ACCEPTANCE', 'OTHER'] });
    const refF = field({ label: 'Document reference', name: 'document_reference', required: true, placeholder: 'e.g. PO/FCT/2026/114' });
    const partyF = field({ label: 'Authorising organisation', name: 'authorising_party', required: true });
    const personF = field({ label: 'Authorising person', name: 'authorising_person' });
    const form = el('form', { onsubmit: (ev) => {
      ev.preventDefault();
      const v = readForm(form);
      if (!v.document_reference || !v.authorising_party) { toast('A reference and an authorising organisation are both required.', { kind: 'warn' }); return; }
      line.authority_document = v;
      m.close(); render();
    } },
    el('p', { class: 'modal-message', text: `${line.product.name} is sold against an authorising document. Record which one, and who authorised it.` }),
    typeF, refF, partyF, personF,
    el('p', { class: 'hint', text: 'Six months from now, when this invoice is disputed, "who authorised it?" has to have an answer.' }),
    el('div', { class: 'row-end' }, el('button', { type: 'submit', class: 'btn btn-primary' }, 'Record document')));
    const m = modal({ title: 'Authorising document', size: 'sm', body: form });
  }

  async function promptLineDiscount(line) {
    const pctF = field({ label: 'Discount %', name: 'percent', type: 'number', min: 0, max: 100, step: '0.5', value: line.discount ? line.discount.value : '' });
    const reasonF = field({ label: 'Reason', name: 'reason', type: 'textarea', rows: 2, placeholder: 'e.g. display model, damaged carton, bulk order' });
    const approveF = field({ label: 'Manager override (needed if this goes below cost or past your limit)', name: 'approved_by_manager', type: 'checkbox' });
    const form = el('form', { onsubmit: (ev) => {
      ev.preventDefault();
      const v = readForm(form);
      const pct = Number(v.percent) || 0;
      if (pct <= 0) { line.discount = null; m.close(); priceBasket(); return; }
      const limit = maxDiscountPercent();
      if (pct > limit && !v.approved_by_manager) {
        toast(`You may discount up to ${limit}%. Above that needs a manager's override — tick the box only if a manager has approved it, because the approval is recorded against your login.`, { kind: 'warn', duration: 9000 });
        return;
      }
      line.discount = { kind: 'PERCENT', value: pct, reason: v.reason || null, approved_by_manager: !!v.approved_by_manager };
      m.close(); priceBasket();
    } }, pctF, reasonF, atLeast('OWNER') ? null : approveF,
    el('p', { class: 'hint', text: `Your limit is ${maxDiscountPercent()}%. A discount that would take this line below its cost is blocked unless a manager overrides it, and the override is logged.` }),
    el('div', { class: 'row-end' }, el('button', { type: 'submit', class: 'btn btn-primary' }, 'Apply')));
    const m = modal({ title: `Discount — ${line.product.name}`, size: 'sm', body: form });
  }

  async function promptSaleDiscount() {
    const pctF = field({ label: 'Discount the whole sale by %', name: 'percent', type: 'number', min: 0, max: 100, step: '0.5', value: saleDiscountPercent || '' });
    const form = el('form', { onsubmit: (ev) => {
      ev.preventDefault();
      const v = readForm(form);
      const pct = Number(v.percent) || 0;
      const limit = maxDiscountPercent();
      if (pct > limit) {
        toast(`Your limit is ${limit}%. Ask a manager, or discount individual lines.`, { kind: 'warn', duration: 7000 });
        return;
      }
      saleDiscountPercent = pct;
      m.close(); priceBasket();
    } }, pctF, el('div', { class: 'row-end' }, el('button', { type: 'submit', class: 'btn btn-primary' }, 'Apply')));
    const m = modal({ title: 'Whole-sale discount', size: 'sm', body: form });
  }

  function showTrail(line, priced) {
    const trail = (priced && priced.pricing_trail) || [];
    const body = trail.length
      ? el('div', {},
        el('p', { class: 'modal-message', text: `${line.product.name} — how this price was reached, in order.` }),
        el('ol', { class: 'trail' }, trail.map((t) => el('li', {},
          el('strong', { text: t.label || t.layer }),
          t.amount != null ? el('span', { class: 'trail-amount', text: money(t.amount) }) : null,
          t.note ? el('span', { class: 'muted trail-note', text: ` — ${t.note}` }) : null))),
        el('p', { class: 'hint', text: 'The order is fixed: batch price, then a branch override, then a promotion, then the customer tier, then a volume break. A promotion outranks a tier, so a sale is never priced twice down.' }))
      : el('p', { class: 'modal-message', text: 'The price has not been computed yet. Add the line and wait a moment.' });
    modal({ title: 'Why this price?', size: 'sm', body, footer: el('div', { class: 'row-end' }, el('button', { class: 'btn btn-primary', onclick: (ev) => ev.target.closest('.modal-host').hidden = true }, 'Close')) });
  }

  function showValidationErrors(err) {
    const list = el('ul', { class: 'error-list' }, (err.details || []).map((d) => el('li', {},
      el('strong', { text: d.field || 'line' }), el('span', { text: ` — ${d.message}` }))));
    modal({
      title: 'This sale needs changes',
      body: el('div', {}, el('p', { class: 'modal-message', text: err.message || 'Some lines could not be accepted.' }), list),
      footer: el('div', { class: 'row-end' }, el('button', { class: 'btn btn-primary', onclick: (ev) => { ev.target.closest('.modal-host').hidden = true; } }, 'Close')),
    });
  }

  // -------------------------------------------------------------------
  // payment dialogs
  // -------------------------------------------------------------------
  function openSplitPayment(t) {
    const tenders = [];
    const listHost = el('div', { class: 'tender-list' });
    const remainingHost = el('strong', { text: money(t.total) });

    function repaint() {
      const paid = tenders.reduce((a, x) => a + Number(x.amount || 0), 0);
      remainingHost.textContent = money(Math.max(0, t.total - paid));
      remainingHost.className = paid > t.total ? 'overpaid' : '';
      clear(listHost);
      tenders.forEach((td, i) => {
        listHost.appendChild(el('div', { class: 'tender-row' },
          badge(td.method, 'neutral'),
          el('span', { text: money(td.amount) }),
          td.reference ? el('span', { class: 'muted', text: td.reference }) : null,
          el('button', { class: 'btn btn-sm btn-danger-ghost', onclick: () => { tenders.splice(i, 1); repaint(); } }, '×')));
      });
    }

    const methodSel = el('select', {}, ['CASH', 'POS_TERMINAL', 'BANK_TRANSFER', 'MOBILE_MONEY', 'USSD', 'VOUCHER', 'FX_CASH']
      .map((mm) => el('option', { value: mm, text: mm.replace(/_/g, ' ') })));
    const amtInput = el('input', { type: 'number', min: '0.01', step: '0.01', placeholder: '0.00' });
    const refInput = el('input', { type: 'text', placeholder: 'Reference (required for transfers, POS and wallets)' });

    const addBtn = el('button', { class: 'btn btn-ghost', onclick: () => {
      const amount = Number(amtInput.value) || 0;
      if (amount <= 0) { toast('Enter an amount greater than zero.', { kind: 'warn' }); return; }
      const method = methodSel.value;
      const needsRef = ['POS_TERMINAL', 'BANK_TRANSFER', 'MOBILE_MONEY', 'USSD', 'VOUCHER'].includes(method);
      if (needsRef && !refInput.value.trim()) {
        // A transfer with no reference cannot be reconciled, which is how a shop
        // "loses" money it actually received.
        toast(`${method.replace(/_/g, ' ')} needs a reference — the code from the transfer alert or the POS receipt. Without it this payment cannot be matched to the bank.`, { kind: 'warn', duration: 8000 });
        refInput.focus();
        return;
      }
      tenders.push({ method, amount, reference: refInput.value.trim() || undefined });
      amtInput.value = ''; refInput.value = '';
      repaint();
    } }, 'Add tender');

    repaint();
    const m = modal({
      title: 'Split / part payment',
      body: el('div', {},
        el('div', { class: 'row-between' }, el('span', { text: 'Total' }), el('strong', { text: money(t.total) })),
        el('div', { class: 'row-between' }, el('span', { text: 'Still to pay' }), remainingHost),
        el('div', { class: 'tender-inputs' }, methodSel, amtInput, refInput, addBtn),
        listHost,
        el('p', { class: 'hint', text: 'If the total is not reached, the balance goes on the customer\'s account — which needs a named customer. Over-payment comes back as cash change from the drawer.' })),
      footer: el('div', { class: 'row-end' },
        el('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Cancel'),
        el('button', { class: 'btn btn-primary', onclick: () => {
          if (!tenders.length) { toast('Add at least one tender.', { kind: 'warn' }); return; }
          m.close();
          completeSale(tenders);
        } }, 'Complete sale')),
    });
  }

  function openCreditSale(t) {
    if (!customer) {
      // Not a soft prompt: an anonymous debt cannot be chased, aged, provisioned
      // or recovered. It is a loss the moment it is recorded.
      toast('A credit sale must be against a named customer. Add them first — an anonymous debt cannot be chased.', { kind: 'warn', duration: 8000 });
      pickCustomer();
      return;
    }
    const termsF = field({ label: 'Terms', name: 'terms', type: 'select', choices: ['CASH', 'NET_7', 'NET_14', 'NET_30', 'NET_60', 'NET_90', 'ON_DELIVERY', 'MILESTONE'], value: customer.terms_code || 'NET_30' });
    const m = modal({
      title: `Put ${money(t.total)} on ${customer.name}'s account`,
      size: 'sm',
      body: el('div', {},
        el('p', { class: 'modal-message', text: `Current balance ${money(customer.balance || 0)}${customer.credit_limit ? ` · limit ${money(customer.credit_limit)}` : ' · no limit set'}.` }),
        termsF,
        el('p', { class: 'hint', text: 'This creates a receivable with a due date, so it ages, appears on the chase list, and blocks further credit once it is overdue.' })),
      footer: el('div', { class: 'row-end' },
        el('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Cancel'),
        el('button', { class: 'btn btn-primary', onclick: () => {
          const v = readForm(m.panel.querySelector('form') || document.createElement('form'));
          m.close();
          completeSale([{ method: 'CREDIT', amount: t.total }], { credit_terms_code: termsF.querySelector('select').value });
        } }, 'Confirm credit sale')),
    });
  }

  function openDeliveryOptions(t) {
    toast('Book the delivery from Operations → Delivery after the sale, or hold the item and convert the hold later.', { kind: 'info', duration: 7000 });
  }

  function openHoldOptions() {
    if (!basket.length) { toast('Add the items to hold first.', { kind: 'warn' }); return; }
    const daysF = field({ label: 'Hold for (days)', name: 'hold_days', type: 'number', min: 1, max: 180, value: 7 });
    const depF = field({ label: 'Deposit taken (₦)', name: 'deposit', type: 'number', min: 0, step: '0.01', value: 0 });
    const reasonF = field({ label: 'Reason', name: 'reason', type: 'select', choices: ['CUSTOMER_REQUEST', 'DEPOSIT_PAID', 'AWAITING_PAYMENT', 'AWAITING_DELIVERY', 'CORPORATE_PO', 'OTHER'] });
    const m = modal({
      title: 'Hold these items (layaway)',
      body: el('div', {},
        el('p', { class: 'modal-message', text: `${basket.length} line(s), ${basket.reduce((a, l) => a + Number(l.quantity), 0)} unit(s). A hold reserves real stock: it stays on the shelf but nobody else can sell it, and it is released automatically when the hold expires.` }),
        daysF, depF, reasonF,
        el('p', { class: 'hint', text: 'A deposit requires a named customer — money taken against nobody cannot be reconciled or refunded.' })),
      footer: el('div', { class: 'row-end' },
        el('button', { class: 'btn btn-ghost', onclick: () => m.close() }, 'Cancel'),
        el('button', { class: 'btn btn-primary', onclick: async () => {
          const values = {
            hold_days: Number(daysF.querySelector('input').value) || 7,
            deposit: Number(depF.querySelector('input').value) || 0,
            reason: reasonF.querySelector('select').value,
          };
          m.close();
          try {
            const res = await api.createHold({
              branch_id: branch.id,
              customer_id: customer ? customer.id : null,
              customer_name: customer ? null : 'Walk-in',
              items: basket.map((l) => ({ product_id: l.product.id, quantity: requiredBaseQty(l), unit_price: Number(l.product.default_selling_price) })),
              ...values,
            });
            toast(`Hold ${res.hold_number} created. Stock is reserved until ${res.expires_on}.`, { kind: 'good', duration: 7000 });
            resetBasket();
          } catch (e) { reportError(e, { context: 'The hold could not be created' }); }
        } }, 'Create hold')),
    });
  }

  async function confirmOpenTill(message) {
    const floatF = field({ label: 'Opening float (₦, counted)', name: 'opening_float', type: 'number', min: 0, step: '0.01', required: true, value: branch.default_till_float || 0, hint: 'Count the drawer. A float nobody counted cannot be reconciled at close.' });
    const tillF = field({ label: 'Till number', name: 'till_no', value: '1' });
    let done = false;
    const form = el('form', { onsubmit: async (ev) => {
      ev.preventDefault();
      const v = readForm(form);
      try {
        await api.openTill({ branch_id: branch.id, till_no: v.till_no || '1', opening_float: Number(v.opening_float) || 0 });
        done = true;
        m.close();
        toast('Till opened. Complete the sale again.', { kind: 'good', duration: 4000 });
      } catch (e) { reportError(e, { context: 'The till could not be opened' }); }
    } },
    el('p', { class: 'modal-message', text: message }),
    tillF, floatF,
    el('div', { class: 'row-end' },
      el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => m.close() }, 'Cancel'),
      el('button', { type: 'submit', class: 'btn btn-primary' }, 'Open till')));
    const m = modal({ title: 'Open the till', size: 'sm', body: form });
    return new Promise((resolve) => {
      const t = setInterval(() => { if (done) { clearInterval(t); resolve(true); } }, 200);
      setTimeout(() => { clearInterval(t); resolve(false); }, 120000);
    });
  }

  // -------------------------------------------------------------------
  // customer picker
  // -------------------------------------------------------------------
  function pickCustomer() {
    const search = el('input', { type: 'search', placeholder: 'Name or phone…', autofocus: true });
    const list = el('div', { class: 'picker-list' });
    async function run() {
      clear(list);
      list.appendChild(spinner('Searching…'));
      try {
        const rows = await api.customers({ search: search.value.trim(), limit: 30 });
        clear(list);
        if (!rows.length) {
          list.appendChild(el('p', { class: 'muted', text: 'No match. You can add them below.' }));
          return;
        }
        for (const c of rows) {
          list.appendChild(el('button', { class: 'picker-row', onclick: () => { customer = c; document.getElementById('pos-customer-label').textContent = c.name; m.close(); render(); } },
            el('strong', { text: c.name }),
            el('span', { class: 'muted', text: `${c.phone || 'no phone'} · ${c.customer_class}` }),
            Number(c.balance) > 0 ? badge(`owes ${money(c.balance)}`, c.account_status === 'ACTIVE' ? 'warn' : 'bad') : null));
        }
      } catch (e) { clear(list); list.appendChild(el('p', { text: e.message })); }
    }
    search.addEventListener('input', () => { clearTimeout(search._t); search._t = setTimeout(run, 200); });
    const m = modal({
      title: 'Choose a customer',
      body: el('div', {}, search, list,
        el('div', { class: 'row-end' },
          el('button', { class: 'btn btn-ghost', onclick: () => { customer = null; document.getElementById('pos-customer-label').textContent = 'Walk-in'; m.close(); render(); } }, 'Walk-in (no customer)')),
        el('button', { class: 'btn btn-primary btn-block', onclick: () => { m.close(); newCustomerDialog(); } }, icon('plus'), ' Add a new customer')),
    });
    run();
  }

  function newCustomerDialog() {
    const nameF = field({ label: 'Name', name: 'name', required: true });
    const phoneF = field({ label: 'Phone', name: 'phone', type: 'tel', placeholder: '0803…', hint: 'A Nigerian mobile number. Needed for a receipt, a delivery and a chase.' });
    const classF = field({ label: 'Customer class', name: 'customer_class', type: 'select', choices: ['RETAIL', 'TRADE', 'WHOLESALE', 'DISTRIBUTOR', 'CORPORATE', 'STAFF'] });
    const typeF = field({ label: 'Type', name: 'customer_type', type: 'select', choices: ['INDIVIDUAL', 'COMPANY', 'GOVERNMENT', 'NGO'] });
    const form = el('form', { onsubmit: async (ev) => {
      ev.preventDefault();
      const v = readForm(form);
      try {
        const created = await api.createCustomer({ ...v, business_id: business.id, home_branch_id: branch.id });
        customer = created;
        document.getElementById('pos-customer-label').textContent = created.name;
        m.close(); render();
        toast(`${created.name} added.`, { kind: 'good', duration: 3000 });
      } catch (e) { reportError(e, { context: 'The customer could not be added' }); }
    } }, nameF, phoneF, classF, typeF,
    el('div', { class: 'row-end' }, el('button', { type: 'submit', class: 'btn btn-primary' }, 'Save customer')));
    const m = modal({ title: 'New customer', size: 'sm', body: form });
  }

  document.getElementById('pos-customer-btn').addEventListener('click', pickCustomer);
  document.getElementById('pos-clear').addEventListener('click', () => {
    if (!basket.length) return;
    if (window.confirm('Clear the whole basket?')) resetBasket();
  });

  // -------------------------------------------------------------------
  await loadProducts('');
  render();
  searchInput.focus();

  return {
    unmount() { clearTimeout(searchTimer); clearTimeout(priceTimer); },
  };
}

// ---------------------------------------------------------------------
// printing
// ---------------------------------------------------------------------
// A separate window with its own minimal stylesheet, rather than printing the
// app shell. Thermal printers are 58/80mm and a page of dashboard chrome wastes
// three metres of paper a day.
function openPrintWindow(receipt) {
  const w = window.open('', '_blank', 'width=380,height=640');
  if (!w) { toast('The browser blocked the print window. Allow pop-ups for this site to print receipts.', { kind: 'warn', duration: 9000 }); return; }
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const b = receipt.business || {};
  const lines = (receipt.lines || []).map((l) => `
    <tr>
      <td>${esc(l.name)}${l.serials && l.serials.length ? `<br><small>SN: ${l.serials.map(esc).join(', ')}</small>` : ''}</td>
      <td class="r">${esc(l.quantity)}${l.unit_type !== 'BASE_UNIT' ? ` ${esc(l.unit_type.toLowerCase())}` : ''}</td>
      <td class="r">${esc(money(l.net))}</td>
    </tr>`).join('');
  const vatLines = ((receipt.vat && receipt.vat.lines) || []).map((l) => `<tr><td>${esc(l.label)}</td><td class="r">${l.value == null ? '' : esc(l.value)}</td></tr>`).join('');
  w.document.write(`<!DOCTYPE html><html lang="en-NG"><head><meta charset="utf-8"><title>${esc(receipt.sale ? receipt.sale.number : 'Receipt')}</title>
  <style>
    body{font:12px/1.35 ui-monospace,Menlo,Consolas,monospace;margin:8px;color:#000}
    h1{font-size:14px;margin:0 0 2px;text-align:center}
    .c{text-align:center}.muted{color:#333}
    table{width:100%;border-collapse:collapse;margin:6px 0}
    td{padding:1px 0;vertical-align:top}.r{text-align:right}
    hr{border:0;border-top:1px dashed #000;margin:6px 0}
    .tot{font-weight:700;font-size:13px}
    small{font-size:10px}
  </style></head><body>
  <h1>${esc(b.name || 'StockRidge')}</h1>
  ${b.legal_name && b.legal_name !== b.name ? `<div class="c muted"><small>${esc(b.legal_name)}</small></div>` : ''}
  ${b.address ? `<div class="c"><small>${esc(b.address)}</small></div>` : ''}
  ${b.phone ? `<div class="c"><small>${esc(b.phone)}</small></div>` : ''}
  ${b.cac ? `<div class="c"><small>CAC ${esc(b.cac)}</small></div>` : ''}
  ${b.tin ? `<div class="c"><small>TIN ${esc(b.tin)}</small></div>` : ''}
  <hr>
  <div>Receipt: <strong>${esc(receipt.sale ? receipt.sale.receipt_number || receipt.sale.number : '')}</strong></div>
  <div>Date: ${esc(receipt.sale ? receipt.sale.date : '')} ${esc(receipt.sale ? receipt.sale.time : '')}</div>
  <div>Branch: ${esc(receipt.branch ? receipt.branch.name : '')}</div>
  ${receipt.customer ? `<div>Customer: ${esc(receipt.customer.name)}${receipt.customer.phone ? ` · ${esc(receipt.customer.phone)}` : ''}</div>` : ''}
  <hr>
  <table>${lines}</table>
  <hr>
  <table>${vatLines}</table>
  <table>
    <tr><td>Paid</td><td class="r">${esc(money(receipt.totals ? receipt.totals.paid : 0))}</td></tr>
    ${receipt.totals && receipt.totals.balance_due > 0 ? `<tr><td><strong>BALANCE DUE</strong></td><td class="r tot">${esc(money(receipt.totals.balance_due))}</td></tr>` : ''}
    ${receipt.totals && receipt.totals.change > 0 ? `<tr><td>Change</td><td class="r">${esc(money(receipt.totals.change))}</td></tr>` : ''}
  </table>
  ${(receipt.payments || []).length ? `<hr><table>${receipt.payments.map((p) => `<tr><td>${esc(p.label)}${p.reference ? ` <small>${esc(p.reference)}</small>` : ''}</td><td class="r">${esc(money(p.amount))}</td></tr>`).join('')}</table>` : ''}
  ${receipt.register_entries && receipt.register_entries.length ? `<hr><div><small>Recorded in the high-value register: ${receipt.register_entries.map((r) => esc(r.product)).join(', ')}</small></div>` : ''}
  ${receipt.delivery_note ? `<hr><div><small>${esc(receipt.delivery_note)}</small></div>` : ''}
  <hr>
  <div class="c"><small>${esc(receipt.footer || '')}</small></div>
  <script>window.onload=function(){setTimeout(function(){window.print();},150);};<\/script>
  </body></html>`);
  w.document.close();
}

export { openPrintWindow };
