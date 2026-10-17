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

  // A purchase order does not invent a unit. Stock is held in the product's base
  // unit, and the server refuses a code that is not on that product's ladder.
  // The raise form used to offer a free text box defaulting to PIECE, so a
  // person could type PCS over a unit the catalogue had already set, and the
  // order was refused after the supplier had been promised the goods.
  const BASE_UNIT_CHOICES = [
    { code: 'PIECE', name: 'Piece', plural: 'Pieces' },
    { code: 'TABLET', name: 'Tablet', plural: 'Tablets' },
    { code: 'CAPSULE', name: 'Capsule', plural: 'Capsules' },
    { code: 'BOTTLE', name: 'Bottle', plural: 'Bottles' },
    { code: 'SACHET', name: 'Sachet', plural: 'Sachets' },
    { code: 'TUBE', name: 'Tube', plural: 'Tubes' },
    { code: 'VIAL', name: 'Vial', plural: 'Vials' },
    { code: 'BAG', name: 'Bag', plural: 'Bags' },
    { code: 'KILOGRAM', name: 'Kilogram', plural: 'Kilograms' },
    { code: 'LITRE', name: 'Litre', plural: 'Litres' },
    { code: 'METRE', name: 'Metre', plural: 'Metres' },
  ];
  const PACK_UNIT_CHOICES = [
    { code: 'PACK', name: 'Pack', plural: 'Packs' },
    { code: 'STRIP', name: 'Strip', plural: 'Strips' },
    { code: 'CARTON', name: 'Carton', plural: 'Cartons' },
    { code: 'BOX', name: 'Box', plural: 'Boxes' },
    { code: 'ROLL', name: 'Roll', plural: 'Rolls' },
    { code: 'DOZEN', name: 'Dozen', plural: 'Dozens', suggest: 12 },
  ];

  function titleWord(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function countWord(n, one, many) {
    const single = one || 'unit';
    return Math.abs(Number(n)) === 1 ? single : (many || `${single}s`);
  }

  function pluralise(name) {
    const word = String(name || '').trim();
    if (!word) return '';
    if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
    if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
    return `${word}s`;
  }

  function codeFromWord(word) {
    return String(word || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20);
  }

  function wordOk(word) {
    const text = String(word || '').trim();
    if (text.length < 2 || text.length > 24) return false;
    return /^[A-Za-z][A-Za-z0-9 ./-]*$/.test(text);
  }

  function matchChoice(name, choices) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return null;
    return choices.find((c) => c.name.toLowerCase() === key || c.plural.toLowerCase() === key || c.code.toLowerCase() === key) || null;
  }

  function normaliseUnits(rows) {
    return (rows || [])
      .filter((u) => u && !Number(u.is_deleted) && u.isDeleted !== true)
      .map((u) => {
        const factor = Number(u.quantity_in_base != null ? u.quantity_in_base : u.quantityInBase);
        const name = u.name || u.code || '';
        return {
          code: String(u.code || '').trim().toUpperCase(),
          name: name || String(u.code || ''),
          plural: u.plural_name || u.pluralName || (name ? `${name}s` : ''),
          factor,
          isDefault: Number(u.is_default_sell) === 1 || u.isDefaultSell === true,
          sellable: u.is_sellable == null && u.isSellable == null
            ? true
            : (u.isSellable !== undefined ? u.isSellable !== false : Number(u.is_sellable) !== 0),
        };
      })
      .filter((u) => u.code && Number.isFinite(u.factor) && u.factor > 0)
      .sort((a, b) => a.factor - b.factor || a.code.localeCompare(b.code));
  }

  function pickCatalogueUnit(units, fallbackCode) {
    const sellable = units.filter((u) => u.sellable);
    const pool = sellable.length ? sellable : units;
    const wanted = String(fallbackCode || '').toUpperCase();
    return pool.find((u) => u.isDefault)
      || pool.find((u) => u.code === wanted)
      || pool[0]
      || null;
  }

  function applyChosenUnit(line, unit) {
    line.unit_code = unit ? unit.code : '';
    line.unit_name = unit ? unit.name : '';
    line.unit_plural = unit ? (unit.plural || `${unit.name}s`) : '';
    line.unit_factor = unit ? (Number(unit.factor) || 1) : 1;
  }

  function rememberBase(line, units, fallbackName) {
    const base = (units || []).slice().sort((a, b) => a.factor - b.factor)[0];
    line.base_name = (base && base.name) || titleWord(fallbackName) || line.unit_name || 'base unit';
    line.base_plural = (base && base.plural) || (line.base_name ? `${line.base_name}s` : 'base units');
  }

  function blankOrderLine() {
    return {
      product_id: '', name: '', pickedName: '', sku: '', quantity: 1,
      unit_code: '', unit_name: '', unit_plural: '', unit_factor: 1,
      expected_unit_cost: 0, units: [], unit_state: 'empty', unit_full_ladder: false,
      base_name: '', base_plural: '', measured: false, measure_code: '', business_id: null, guided: null, unit_error: '',
    };
  }

  function clearPick(line) {
    const kept = { name: line.name, quantity: line.quantity, expected_unit_cost: line.expected_unit_cost };
    Object.assign(line, blankOrderLine(), kept);
  }

  function suggestGuided(baseName) {
    const hit = matchChoice(baseName, BASE_UNIT_CHOICES);
    return {
      baseChoice: hit ? hit.code : (String(baseName || '').trim() ? '__other__' : 'PIECE'),
      baseWord: hit ? '' : titleWord(baseName),
      mode: '',
      packChoice: 'CARTON',
      packWord: '',
      packFactor: '',
    };
  }

  function resolveChoice(choice, word, list) {
    if (choice === '__other__') {
      if (!wordOk(word)) return { ok: false, error: 'Type the unit as a word, such as Piece or Carton. A code on its own is not enough.' };
      const code = codeFromWord(word);
      if (!code) return { ok: false, error: 'That word does not make a unit the catalogue can store.' };
      const name = titleWord(String(word).trim());
      return { ok: true, unit: { code, name, plural: pluralise(name) } };
    }
    const found = (list || []).find((c) => c.code === choice);
    if (!found) return { ok: false, error: 'Choose a unit from the list.' };
    return { ok: true, unit: { code: found.code, name: found.name, plural: found.plural, suggest: found.suggest } };
  }

  function buildGuidedLadder(guided) {
    const spec = guided || {};
    const base = resolveChoice(spec.baseChoice || '', spec.baseWord, BASE_UNIT_CHOICES);
    if (!base.ok) return base;
    if (spec.mode !== 'same' && spec.mode !== 'pack') {
      return { ok: false, error: 'Say whether you are ordering in that unit, or in a pack of them.' };
    }
    const levels = [{ code: base.unit.code, name: base.unit.name, plural: base.unit.plural, factor: 1 }];
    let order = levels[0];
    if (spec.mode === 'pack') {
      const pack = resolveChoice(spec.packChoice || '', spec.packWord, PACK_UNIT_CHOICES);
      if (!pack.ok) return pack;
      if (pack.unit.code === base.unit.code) {
        return { ok: false, error: `${pack.unit.name} is the same unit as ${base.unit.name}. Order in ${base.unit.name}, or use a different word for the pack.` };
      }
      const factor = Number(spec.packFactor);
      if (!Number.isInteger(factor) || factor < 2) {
        return { ok: false, error: `Say how many ${base.unit.plural.toLowerCase()} are in one ${pack.unit.name.toLowerCase()}. It has to be a whole number of 2 or more.` };
      }
      if (factor > 100000) {
        return { ok: false, error: `${U.qty(factor)} is too large for one ${pack.unit.name.toLowerCase()}. Check the pack size.` };
      }
      order = { code: pack.unit.code, name: pack.unit.name, plural: pack.unit.plural, factor };
      levels.push(order);
    }
    return {
      ok: true,
      baseName: base.unit.name.toLowerCase(),
      orderCode: order.code,
      orderName: order.name,
      orderPlural: order.plural,
      orderFactor: order.factor,
      units: levels,
      payload: levels.map((level) => ({
        code: level.code,
        name: level.name,
        pluralName: level.plural,
        plural_name: level.plural,
        quantityInBase: level.factor,
        quantity_in_base: level.factor,
        isDefaultSell: level.code === order.code,
        is_default_sell: level.code === order.code ? 1 : 0,
        isSellable: true,
        is_sellable: 1,
      })),
    };
  }

  function previewGuided(line) {
    if (!line || line.unit_state !== 'guided') return;
    const built = buildGuidedLadder(line.guided);
    if (!built.ok) {
      applyChosenUnit(line, null);
      return;
    }
    line.base_name = titleWord(built.baseName);
    line.base_plural = built.units[0].plural;
    applyChosenUnit(line, {
      code: built.orderCode,
      name: built.orderName,
      plural: built.orderPlural,
      factor: built.orderFactor,
    });
  }

  function conversionSentence(line) {
    const name = line.unit_name || '';
    const plural = line.unit_plural || (name ? `${name}s` : 'units');
    const base = line.base_name || name || 'base unit';
    const basePlural = line.base_plural || (base ? `${base}s` : 'base units');
    const factor = Number(line.unit_factor) || 1;
    const qty = Number(line.quantity) || 0;
    if (!name) return '';
    const baseQty = Math.round(qty * factor * 10000) / 10000;
    if (!(qty > 0)) {
      return factor === 1
        ? `Quantity and cost are per ${name.toLowerCase()}. 1 ${name.toLowerCase()} is the base unit stock is held in.`
        : `Quantity and cost are per ${name.toLowerCase()}. 1 ${name.toLowerCase()} is ${U.qty(factor)} ${countWord(factor, base, basePlural).toLowerCase()}.`;
    }
    if (factor === 1) {
      return `${U.qty(qty)} ${countWord(qty, name, plural).toLowerCase()} ordered. Stock is held in ${countWord(baseQty, base, basePlural).toLowerCase()}, so that is ${U.qty(baseQty)} on the shelf. The cost is per ${name.toLowerCase()}.`;
    }
    const verb = Math.abs(Number(qty)) === 1 ? 'is' : 'are';
    return `${U.qty(qty)} ${countWord(qty, name, plural).toLowerCase()} ${verb} ${U.qty(baseQty)} ${countWord(baseQty, base, basePlural).toLowerCase()} on the shelf. The cost is per ${name.toLowerCase()}, not per ${String(base).toLowerCase()}.`;
  }

  function allowsFraction(line) {
    return Boolean(line.measure_code) && String(line.unit_code || '').toUpperCase() === String(line.measure_code).toUpperCase();
  }

  function quantityWarning(line) {
    if (!line.unit_name || allowsFraction(line)) return '';
    const qty = Number(line.quantity);
    if (!(qty > 0) || Number.isInteger(qty)) return '';
    return `${line.unit_name} must be a whole number — ${U.qty(qty)} is not.`;
  }

  function guidedConfirm(built) {
    if (!built.ok) return built.error;
    if (built.orderFactor > 1) {
      return `1 ${built.orderName.toLowerCase()} = ${U.qty(built.orderFactor)} ${built.units[0].plural.toLowerCase()}. Quantity and cost on this line are per ${built.orderName.toLowerCase()}. Raising the order saves this on the product. Later orders cannot change it here.`;
    }
    return `Quantity and cost are per ${built.orderName.toLowerCase()}. 1 ${built.orderName.toLowerCase()} is the base unit stock is held in. Raising the order saves this on the product. Later orders cannot change it here.`;
  }

  function unitOptionLabel(unit, line) {
    const factor = Number(unit.factor) || 1;
    if (factor === 1) return `${unit.name} — the base unit`;
    const base = line.base_name || 'base unit';
    const basePlural = line.base_plural || `${base}s`;
    return `${unit.name} — 1 ${unit.name.toLowerCase()} is ${U.qty(factor)} ${countWord(factor, base, basePlural).toLowerCase()}`;
  }

  function ladderSentence(line) {
    const base = line.base_name || 'base unit';
    const basePlural = line.base_plural || `${base}s`;
    return (line.units || []).map((u) => {
      if (Number(u.factor) === 1) return `${u.name} (the base unit)`;
      return `${u.name} (1 = ${U.qty(u.factor)} ${countWord(u.factor, base, basePlural).toLowerCase()})`;
    }).join(' · ');
  }

  function searchUnitNote(product) {
    const base = product.base_unit_name || product.base_unit || '';
    if (product.default_unit_code) {
      const factor = Number(product.default_unit_factor) || 1;
      const name = factor === 1 && base ? titleWord(base) : U.humanise(product.default_unit_code);
      return factor > 1
        ? `${name} · ${U.qty(factor)} ${base || 'base units'} each`
        : `${name} · set in the catalogue`;
    }
    if (base) return `${titleWord(base)} · unit not on the ladder yet`;
    return 'unit not set';
  }

  function orderedPhrase(item) {
    const qty = item.quantity != null ? item.quantity : item.quantity_ordered;
    const base = item.base_unit_name || '';
    const inBase = Number(item.quantity_in_base);
    const q = Number(qty);
    const same = !Number.isFinite(inBase) || !Number.isFinite(q) || Math.abs(inBase - q) <= 0.0001;
    // A factor of 1 means the order unit is the base unit. The receipt word
    // (base_unit_name) is the one to show: the code can be PIECE while the
    // catalogue calls it Unit.
    const name = item.unit_name
      || (same && base ? titleWord(base) : '')
      || (item.unit_code ? U.humanise(item.unit_code) : '');
    const ordered = `${U.qty(qty)}${name ? ` ${name}` : ''}`;
    if (base && Number.isFinite(inBase) && Number.isFinite(q) && !same) {
      return `${ordered} · ${U.qty(inBase)} ${base}`;
    }
    return ordered;
  }

  function basePhrase(item) {
    const base = item.base_unit_name || '';
    return `${U.qty(item.quantity_in_base)}${base ? ` ${base}` : ''}`;
  }

  function lockKnownDefault(line, product) {
    const code = String((product && product.default_unit_code) || '').toUpperCase();
    if (!code) return false;
    const factor = Number(product.default_unit_factor) || 1;
    const baseWord = titleWord(product.base_unit_name || product.base_unit || '');
    const name = factor === 1 && baseWord ? baseWord : U.humanise(code);
    const unit = { code, name, plural: pluralise(name), factor, isDefault: true, sellable: true };
    line.units = [unit];
    line.unit_state = 'locked';
    line.unit_full_ladder = false;
    line.base_name = baseWord || name;
    line.base_plural = pluralise(line.base_name);
    applyChosenUnit(line, unit);
    return true;
  }

  async function loadCatalogueUnits(productId) {
    try {
      const detail = await SR.api.get(`/api/products/${encodeURIComponent(productId)}`);
      const product = detail.product || {};
      const measure = detail.measures || null;
      return {
        loaded: true,
        units: normaliseUnits(detail.units || []),
        baseName: product.base_unit_name || '',
        businessId: product.business_id,
        measureCode: measure ? String(measure.sell_unit_code || measure.sellUnitCode || '').toUpperCase() : '',
      };
    } catch (err) {
      const units = await SR.store.all('product_units', {
        where: (u) => !Number(u.is_deleted) && String(u.product_id) === String(productId),
      }).catch(() => []);
      const row = await SR.store.get('products', productId).catch(() => null);
      if (units.length || (err && err.isOffline)) {
        return {
          loaded: true,
          units: normaliseUnits(units),
          baseName: (row && row.base_unit_name) || '',
          businessId: row ? row.business_id : null,
          measureCode: '',
        };
      }
      return { loaded: false, error: err, units: [], baseName: '', businessId: null, measureCode: '' };
    }
  }

  async function applyCatalogueUnit(line, product) {
    const pack = await loadCatalogueUnits(line.product_id);
    line.measure_code = String(pack.measureCode || '').toUpperCase();
    line.measured = Boolean(line.measure_code);
    if (pack.businessId != null) line.business_id = pack.businessId;
    else if (product && product.business_id != null) line.business_id = product.business_id;
    const fallbackName = pack.baseName || (product && (product.base_unit_name || product.base_unit)) || '';
    if (pack.loaded && pack.units.length) {
      const sellable = pack.units.filter((u) => u.sellable);
      line.units = pack.units;
      line.unit_full_ladder = true;
      rememberBase(line, pack.units, fallbackName);
      if (!sellable.length) {
        line.unit_state = 'unsellable';
        applyChosenUnit(line, null);
        return;
      }
      line.unit_state = 'locked';
      applyChosenUnit(line, pickCatalogueUnit(sellable, product && product.default_unit_code));
      return;
    }
    if (!pack.loaded && lockKnownDefault(line, product)) return;
    if (!pack.loaded) {
      line.unit_state = 'missing';
      line.unit_error = (pack.error && pack.error.message) || 'The catalogue unit could not be loaded.';
      line.units = [];
      line.unit_full_ladder = false;
      applyChosenUnit(line, null);
      return;
    }
    line.units = [];
    line.unit_full_ladder = false;
    line.base_name = titleWord(fallbackName);
    line.base_plural = line.base_name ? `${line.base_name}s` : '';
    if (!line.business_id) {
      line.unit_state = 'shared';
      applyChosenUnit(line, null);
      return;
    }
    line.unit_state = 'guided';
    line.guided = suggestGuided(fallbackName);
    applyChosenUnit(line, null);
  }

  async function commitGuidedUnit(line) {
    const built = buildGuidedLadder(line.guided);
    if (!built.ok) throw new Error(built.error);
    await SR.api.put(`/api/products/${encodeURIComponent(line.product_id)}`, {
      base_unit_name: built.baseName,
      units: built.payload,
    });
    const detail = await SR.api.get(`/api/products/${encodeURIComponent(line.product_id)}`).catch(() => null);
    const units = normaliseUnits((detail && detail.units) || built.units.map((u) => ({
      code: u.code,
      name: u.name,
      plural_name: u.plural,
      quantity_in_base: u.factor,
      is_default_sell: u.code === built.orderCode ? 1 : 0,
      is_sellable: 1,
    })));
    if (detail && Array.isArray(detail.units) && SR.store.putMany) {
      await SR.store.putMany('product_units', detail.units).catch(() => {});
    }
    line.units = units;
    line.unit_state = 'locked';
    line.unit_full_ladder = true;
    line.guided = null;
    line.measure_code = detail && detail.measures
      ? String(detail.measures.sell_unit_code || detail.measures.sellUnitCode || '').toUpperCase()
      : '';
    line.measured = Boolean(line.measure_code);
    rememberBase(line, units, built.baseName);
    applyChosenUnit(line, pickCatalogueUnit(units, built.orderCode));
  }

  function unitProblem(line) {
    if (!line.product_id) return '';
    if (line.unit_state === 'locked' && line.unit_code) {
      if (line.units.length && !line.units.some((u) => u.sellable !== false && u.code === line.unit_code)) {
        return `${line.name} is not using a unit from its catalogue.`;
      }
      return quantityWarning(line);
    }
    if (line.unit_state === 'missing') {
      return `${line.name}: the catalogue unit could not be loaded. Try again on that line before raising. A typed unit would be refused if the product already has one.`;
    }
    if (line.unit_state === 'shared') {
      return `${line.name} is on the shared market list and has no unit. Copy it into this shop’s catalogue and set the unit there before ordering.`;
    }
    if (line.unit_state === 'unsellable') {
      return `${line.name} has catalogue units, but none of them can be ordered. Set a sellable unit on the product first.`;
    }
    if (line.unit_state === 'guided') {
      const built = buildGuidedLadder(line.guided);
      if (!built.ok) return `${line.name}: ${built.error}`;
      return quantityWarning(line);
    }
    if (!line.unit_code) return `${line.name} has no unit yet. Pick it again so the catalogue unit can be used.`;
    return quantityWarning(line);
  }

  function syncGuidedFromDom(root, orderLines) {
    if (!root) return;
    root.querySelectorAll('[data-unit-host]').forEach((host) => {
      const line = orderLines[Number(host.getAttribute('data-line-index'))];
      if (!line || line.unit_state !== 'guided') return;
      const g = line.guided || (line.guided = suggestGuided(line.base_name));
      const read = (sel) => {
        const el = host.querySelector(sel);
        return el ? el.value : null;
      };
      const baseChoice = read('[data-base-choice]');
      if (baseChoice != null) g.baseChoice = baseChoice;
      const baseWord = read('[data-base-word]');
      if (baseWord != null) g.baseWord = baseWord;
      const mode = read('[data-order-mode]');
      if (mode != null) g.mode = mode;
      const packChoice = read('[data-pack-choice]');
      if (packChoice != null) g.packChoice = packChoice;
      const packWord = read('[data-pack-word]');
      if (packWord != null) g.packWord = packWord;
      const factor = read('[data-pack-factor]');
      if (factor != null) g.packFactor = factor;
      previewGuided(line);
    });
  }

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
        SR.exporter.buttons((format) => exportList(format)))));

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

    async function exportList(format) {
      try {
        await SR.exporter.list({
          format,
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
            { key: 'units_ordered', label: 'Base units ordered' }, { key: 'units_received', label: 'Base units received' },
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
        ui.kpi({ label: 'Units on order', value: U.qty(U.sum(open, (r) => r.outstanding_units)), foot: 'in each product’s base unit', small: true })));

      const table = ui.renderTable({
        exportable: false,
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
            return ui.h('span', {}, bar, ui.h('span', { class: 'hint' }, `${U.qty(got)}/${U.qty(ordered)} base units`));
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
      const unitRule = 'The unit comes from the catalogue. If the product already has one, this order uses it and it cannot be changed here. If it has none, choose it on the line — a typed code the catalogue does not know is refused. Quantity and cost are in the unit shown. Stock is stored in the base unit, and the line says what that quantity becomes.';
      wrapEl.appendChild(ui.h('div', { class: 'hint' }, SR.state.moduleOn('nafdac')
        ? `Every NAFDAC registration is already in this shop’s catalogue, unpriced until you set a price, and it is not on the shared market list. A typed name is not ordered until you pick it. ${unitRule}`
        : `Pick the product from the list under its name. A typed name is not ordered until you do. ${unitRule}`));

      const totalsBar = ui.h('div', { class: 'alert alert-info' }, 'No lines yet.');

      function onOrder(line) { return Boolean(line.product_id) && Number(line.quantity) > 0; }
      function dangling(line) { return !line.product_id && (String(line.name || '').trim() || Number(line.expected_unit_cost) > 0); }

      async function findProducts(term) {
        try {
          const d = await SR.api.get('/api/products', {
            query: SR.state.query({ q: term, limit: 12, nafdac: SR.state.moduleOn('nafdac') ? '1' : undefined }),
          });
          return d.data || [];
        } catch (err) {
          if (!err.isOffline) throw err;
          return (await SR.store.all('products', { where: (p) => !Number(p.is_deleted) }))
            .filter((p) => String(p.name).toLowerCase().includes(term.toLowerCase()) || String(p.sku || '').toLowerCase().includes(term.toLowerCase()))
            .slice(0, 12);
        }
      }
      async function adopt(line, product) {
        let chosen = product;
        if (Number(product.from_greenbook) === 1 || String(product.id || '').startsWith('nafdac:')) {
          const created = await SR.api.post(`/api/nafdac/${encodeURIComponent(product.nafdac_catalog_id)}/adopt`, {
            for_order: true,
            selling_price: 0,
            cost_price: Number(line.expected_unit_cost) || 0,
            business_id: SR.state.activeBusinessId,
          });
          chosen = {
            id: created.id,
            name: created.name || product.name,
            sku: product.sku || '',
            base_unit_name: product.base_unit || product.base_unit_name || '',
            business_id: SR.state.activeBusinessId,
            cost_price: Number(line.expected_unit_cost) || 0,
          };
        }
        line.product_id = String(chosen.id);
        line.name = chosen.name;
        line.pickedName = chosen.name;
        line.sku = chosen.sku || product.sku || '';
        line.business_id = chosen.business_id != null ? chosen.business_id : product.business_id;
        if (!Number(line.expected_unit_cost)) line.expected_unit_cost = Number(chosen.cost_price) || Number(product.cost_price) || 0;
        if (!Number(line.quantity)) line.quantity = 1;
        // The list row knows the default code, not the ladder. Load the ladder
        // before the line is painted, so a catalogue unit is locked rather than
        // offered as a box the person can type over.
        await applyCatalogueUnit(line, {
          default_unit_code: chosen.default_unit_code || product.default_unit_code || '',
          default_unit_factor: chosen.default_unit_factor || product.default_unit_factor,
          base_unit_name: chosen.base_unit_name || product.base_unit_name || product.base_unit || '',
          base_unit: product.base_unit || '',
          business_id: line.business_id,
        });
      }
      function paintStatus() {
        const ready = lines.filter(onOrder).length;
        if (raiseBtn && !raiseBtn.disabled) {
          raiseBtn.textContent = ready ? `Raise the order · ${ready} line${ready === 1 ? '' : 's'}` : 'Raise the order';
        }
      }
      function pickedHint(line) {
        if (!line.product_id) {
          return String(line.name || '').trim()
            ? `"${line.name}" is not on the order yet — pick it from the list. A typed name is not ordered.`
            : 'Nothing is ordered on this line until you pick a product.';
        }
        const unit = line.unit_name ? ` Ordered in ${line.unit_name}.` : '';
        const cost = Number(line.expected_unit_cost)
          ? ` ${U.money(line.expected_unit_cost)} per ${(line.unit_name || 'unit').toLowerCase()}.`
          : '';
        return `On this order: ${line.name}${line.sku ? ` · ${line.sku}` : ''}.${unit}${cost}`;
      }

      function refreshLineChrome(card, line) {
        if (line.unit_state === 'guided') previewGuided(line);
        if (!card) return;
        const qtyLabel = card.querySelector('[data-qty-label]');
        const costLabel = card.querySelector('[data-cost-label]');
        const hint = card.querySelector('[data-picked-hint]');
        const math = card.querySelector('[data-unit-math]');
        const warn = card.querySelector('[data-unit-warn]');
        const qty = card.querySelector('[data-qty]');
        if (qtyLabel) qtyLabel.textContent = line.unit_name ? `Qty (${countWord(2, line.unit_name, line.unit_plural).toLowerCase()})` : 'Qty';
        if (costLabel) costLabel.textContent = line.unit_name ? `Cost per ${line.unit_name.toLowerCase()} ₦` : 'Unit cost ₦';
        if (hint) hint.textContent = pickedHint(line);
        if (math) math.textContent = (line.unit_state === 'locked' || (line.unit_state === 'guided' && line.unit_name)) ? conversionSentence(line) : '';
        if (warn) warn.textContent = quantityWarning(line);
        const confirm = card.querySelector('[data-unit-confirm]');
        if (confirm && line.unit_state === 'guided') confirm.textContent = guidedConfirm(buildGuidedLadder(line.guided));
        if (qty) qty.step = allowsFraction(line) ? 'any' : '1';
      }

      function paintGuidedUnit(host, line, card) {
        const g = line.guided || (line.guided = suggestGuided(line.base_name));
        host.appendChild(ui.h('label', { class: 'ctl' }, 'Unit · not set in the catalogue'));
        host.appendChild(ui.h('div', { class: 'hint' }, 'This product has no unit the order can use. Choose what you are counting. It is saved on the product when you raise the order, and later orders use that unit and cannot change it here. A free-typed code is refused.'));
        if (SR.api.isOnline && !SR.api.isOnline()) {
          host.appendChild(ui.h('div', { class: 'err' }, 'Saving this unit needs a connection. The order cannot be raised offline.'));
        }

        const baseSel = ui.h('select', { 'aria-label': 'What one of these is counted as', dataset: { baseChoice: '1' } });
        for (const c of BASE_UNIT_CHOICES) {
          baseSel.appendChild(ui.h('option', { value: c.code, selected: g.baseChoice === c.code }, c.name));
        }
        baseSel.appendChild(ui.h('option', { value: '__other__', selected: g.baseChoice === '__other__' }, 'Another word…'));
        baseSel.addEventListener('change', () => {
          g.baseChoice = baseSel.value;
          previewGuided(line);
          paintUnit(host, line, card);
          paintTotals();
        });
        host.appendChild(ui.h('label', { class: 'ctl' }, 'What is one of these counted as?'));
        host.appendChild(baseSel);
        if (g.baseChoice === '__other__') {
          const word = ui.h('input', {
            type: 'text', value: g.baseWord || '', placeholder: 'For example, Tin',
            autocomplete: 'off', 'aria-label': 'Unit word', dataset: { baseWord: '1' },
          });
          word.addEventListener('input', () => {
            g.baseWord = word.value;
            previewGuided(line);
            refreshLineChrome(card, line);
            paintTotals();
          });
          host.appendChild(word);
          host.appendChild(ui.h('div', { class: 'hint' }, 'Use the word you would say to a supplier. Piece, not PCS.'));
        }

        const baseLabel = (() => {
          const built = resolveChoice(g.baseChoice, g.baseWord, BASE_UNIT_CHOICES);
          return built.ok ? built.unit.name.toLowerCase() : 'that unit';
        })();
        const mode = ui.h('select', { 'aria-label': 'Order in the same unit or a pack', dataset: { orderMode: '1' } });
        mode.appendChild(ui.h('option', { value: '', selected: !g.mode }, 'Choose…'));
        mode.appendChild(ui.h('option', { value: 'same', selected: g.mode === 'same' }, `In ${baseLabel} — the same unit`));
        mode.appendChild(ui.h('option', { value: 'pack', selected: g.mode === 'pack' }, 'In a pack of them'));
        mode.addEventListener('change', () => {
          g.mode = mode.value;
          previewGuided(line);
          paintUnit(host, line, card);
          paintTotals();
        });
        host.appendChild(ui.h('label', { class: 'ctl' }, 'Are you ordering in that unit, or in a pack?'));
        host.appendChild(mode);

        if (g.mode === 'pack') {
          const packSel = ui.h('select', { 'aria-label': 'Pack name', dataset: { packChoice: '1' } });
          for (const c of PACK_UNIT_CHOICES) {
            packSel.appendChild(ui.h('option', {
              value: c.code,
              selected: g.packChoice === c.code,
            }, c.suggest ? `${c.name} — usually ${c.suggest}` : c.name));
          }
          packSel.appendChild(ui.h('option', { value: '__other__', selected: g.packChoice === '__other__' }, 'Another word…'));
          packSel.addEventListener('change', () => {
            g.packChoice = packSel.value;
            const choice = PACK_UNIT_CHOICES.find((c) => c.code === packSel.value);
            if (choice && choice.suggest && !String(g.packFactor || '').trim()) g.packFactor = String(choice.suggest);
            previewGuided(line);
            paintUnit(host, line, card);
            paintTotals();
          });
          host.appendChild(ui.h('label', { class: 'ctl' }, 'What is the pack called?'));
          host.appendChild(packSel);
          if (g.packChoice === '__other__') {
            const word = ui.h('input', {
              type: 'text', value: g.packWord || '', placeholder: 'For example, Crate',
              autocomplete: 'off', 'aria-label': 'Pack word', dataset: { packWord: '1' },
            });
            word.addEventListener('input', () => {
              g.packWord = word.value;
              previewGuided(line);
              refreshLineChrome(card, line);
              paintTotals();
            });
            host.appendChild(word);
          }
          const counted = (() => {
            const built = resolveChoice(g.baseChoice, g.baseWord, BASE_UNIT_CHOICES);
            return built.ok ? built.unit.plural.toLowerCase() : 'base units';
          })();
          const factor = ui.h('input', {
            type: 'number', min: '2', step: '1', value: g.packFactor || '',
            placeholder: 'For example 24', 'aria-label': 'How many base units in one pack',
            dataset: { packFactor: '1' },
          });
          factor.addEventListener('input', () => {
            g.packFactor = factor.value;
            previewGuided(line);
            refreshLineChrome(card, line);
            paintTotals();
          });
          host.appendChild(ui.h('label', { class: 'ctl' }, `How many ${counted} are in one pack?`));
          host.appendChild(factor);
          host.appendChild(ui.h('div', { class: 'hint' }, 'A whole number of 2 or more. 1 is the same unit, not a pack.'));
        }

        previewGuided(line);
        const built = buildGuidedLadder(g);
        host.appendChild(ui.h('div', { class: 'hint', dataset: { unitConfirm: '1' } }, guidedConfirm(built)));
        host.appendChild(ui.h('div', { class: 'hint', dataset: { unitMath: '1' }, 'aria-live': 'polite' }, line.unit_name ? conversionSentence(line) : ''));
        host.appendChild(ui.h('div', { class: 'err', dataset: { unitWarn: '1' } }, quantityWarning(line)));
      }

      function paintUnit(host, line, card) {
        if (!host) return;
        if (!Array.isArray(line.units)) line.units = [];
        host.replaceChildren();
        host.className = 'po-unit span-all';
        if (line.unit_state === 'locked') host.classList.add('is-locked');
        else if (line.unit_state && line.unit_state !== 'empty') host.classList.add('is-need');

        if (!line.product_id || line.unit_state === 'empty') {
          host.appendChild(ui.h('label', { class: 'ctl' }, 'Unit'));
          host.appendChild(ui.h('div', { class: 'hint' }, 'The unit appears when you pick a product. It comes from the catalogue. It is not typed here.'));
          refreshLineChrome(card, line);
          return;
        }
        if (line.unit_state === 'missing') {
          host.appendChild(ui.h('label', { class: 'ctl' }, 'Unit'));
          host.appendChild(ui.h('div', { class: 'err' }, line.unit_error || 'The catalogue unit could not be loaded.'));
          host.appendChild(ui.h('div', { class: 'hint' }, 'A typed unit would be refused if this product already has one. Load the catalogue unit, then order in that.'));
          host.appendChild(ui.h('button', {
            class: 'btn btn-sm', type: 'button',
            onClick: async (ev) => {
              ev.currentTarget.disabled = true;
              ev.currentTarget.textContent = 'Loading…';
              try {
                await applyCatalogueUnit(line, {
                  default_unit_code: line.unit_code,
                  base_unit_name: line.base_name,
                  business_id: line.business_id,
                });
                paintUnit(host, line, card);
                paintTotals();
              } catch (err) {
                ui.apiError(err);
                ev.currentTarget.disabled = false;
                ev.currentTarget.textContent = 'Try again';
              }
            },
          }, 'Try again'));
          refreshLineChrome(card, line);
          return;
        }
        if (line.unit_state === 'shared') {
          host.appendChild(ui.h('label', { class: 'ctl' }, 'Unit'));
          host.appendChild(ui.h('div', { class: 'err' }, 'This name is on the shared market list and has no unit. Copy it into this shop’s catalogue and set the unit there before ordering. A unit typed here would not stick, and it must not be written onto the shared list.'));
          refreshLineChrome(card, line);
          return;
        }
        if (line.unit_state === 'unsellable') {
          const names = line.units.map((u) => u.name).filter(Boolean).join(', ');
          host.appendChild(ui.h('label', { class: 'ctl' }, 'Unit'));
          host.appendChild(ui.h('div', { class: 'po-unit-name' }, names || 'Receiving units only'));
          host.appendChild(ui.h('div', { class: 'err' }, 'These units are set in the catalogue, but none of them can be ordered. Set a sellable unit on the product first. This line cannot invent a different one.'));
          refreshLineChrome(card, line);
          return;
        }
        if (line.unit_state === 'locked') {
          const sellable = line.units.filter((u) => u.sellable);
          const canChoose = line.unit_full_ladder && sellable.length > 1;
          host.appendChild(ui.h('label', { class: 'ctl' }, canChoose ? 'Unit · set in the catalogue' : 'Unit · locked from the catalogue'));
          if (canChoose) {
            const sel = ui.h('select', { 'aria-label': `Unit for ${line.name || 'this line'}` });
            for (const u of sellable) {
              sel.appendChild(ui.h('option', { value: u.code, selected: u.code === line.unit_code }, unitOptionLabel(u, line)));
            }
            sel.addEventListener('change', () => {
              const unit = sellable.find((u) => u.code === sel.value);
              if (!unit) return;
              applyChosenUnit(line, unit);
              paintUnit(host, line, card);
              paintTotals();
            });
            host.appendChild(sel);
            host.appendChild(ui.h('div', { class: 'hint' }, 'These units are already on the product. Choose which one this line is ordered in. A unit that is not listed cannot be typed.'));
          } else {
            host.appendChild(ui.h('div', { class: 'po-unit-name' }, line.unit_name || line.unit_code || 'Unit'));
            host.appendChild(ui.h('div', { class: 'hint' }, line.unit_full_ladder
              ? `${line.unit_name || 'This unit'} is set in the catalogue. This order uses it. It cannot be changed here.`
              : `${line.unit_name || 'This unit'} is the catalogue default. The rest of the unit list could not be loaded, so this line stays on that unit and cannot be changed.`));
          }
          if (line.unit_full_ladder && line.units.length) {
            host.appendChild(ui.h('div', { class: 'hint' }, `On this product: ${ladderSentence(line)}.`));
          }
          const blocked = line.units.filter((u) => !u.sellable).map((u) => u.name).filter(Boolean);
          if (blocked.length) {
            host.appendChild(ui.h('div', { class: 'hint' }, `${blocked.join(', ')} ${blocked.length === 1 ? 'is a receiving unit and is' : 'are receiving units and are'} not offered on an order.`));
          }
          host.appendChild(ui.h('div', { class: 'hint', dataset: { unitMath: '1' }, 'aria-live': 'polite' }, conversionSentence(line)));
          host.appendChild(ui.h('div', { class: 'err', dataset: { unitWarn: '1' } }, quantityWarning(line)));
          refreshLineChrome(card, line);
          return;
        }
        if (line.unit_state === 'guided') {
          paintGuidedUnit(host, line, card);
          refreshLineChrome(card, line);
          return;
        }
        host.appendChild(ui.h('label', { class: 'ctl' }, 'Unit'));
        host.appendChild(ui.h('div', { class: 'err' }, 'This line has no unit. Pick the product again.'));
        refreshLineChrome(card, line);
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
          const hint = ui.h('div', { class: 'hint', dataset: { pickedHint: '1' } }, pickedHint(line));
          card.appendChild(search);
          card.appendChild(results);
          card.appendChild(hint);

          search.addEventListener('input', U.debounce(async () => {
            const term = search.value.trim();
            line.name = search.value;
            if (line.product_id && term !== line.pickedName) {
              clearPick(line);
              line.name = search.value;
              card.classList.remove('on-order');
              const badge = card.querySelector('.badge');
              if (badge) {
                badge.className = 'badge badge-warn';
                badge.textContent = U.humanise('Not chosen yet');
              }
              search.dataset.unlinked = '1';
              paintUnit(card.querySelector('[data-unit-host]'), line, card);
              paintTotals();
            }
                        if (term.length < 2) { results.hidden = true; results.replaceChildren(); return; }
            let rows = [];
            try { rows = await findProducts(term); }
            catch (err) { results.hidden = false; results.replaceChildren(ui.h('div', { class: 'hint' }, (err && err.message) || 'The catalogue could not be searched.')); return; }
            results.replaceChildren();
            if (!rows.length) {
              results.hidden = false;
              results.appendChild(ui.h('div', { class: 'hint' }, SR.state.moduleOn('nafdac')
                ? `Nothing in this shop or the NAFDAC Greenbook matches "${term}".`
                : `Nothing in this business's catalogue matches "${term}". A name that is not in the catalogue cannot be ordered.`));
              return;
            }
            for (const product of rows) {
              results.appendChild(ui.h('button', {
                class: 'pos-hit', type: 'button',
                onClick: async () => {
                  try {
                    await adopt(line, product);
                    paintLines();
                    const drawn = linesBody.children[i];
                    if (drawn && drawn.scrollIntoView) drawn.scrollIntoView({ block: 'nearest' });
                  } catch (err) { ui.apiError(err); }
                },
              }, ui.h('div', { class: 'grow' },
                ui.h('div', { class: 'ph-name' }, product.name),
                ui.h('div', { class: 'ph-meta' }, [(product.nafdac_catalog_id || Number(product.from_greenbook)) ? 'NAFDAC' : null, product.sku, searchUnitNote(product)].filter(Boolean).join(' · '))),
              ui.h('span', { class: 'ph-price' }, U.money(product.cost_price))));
            }
            results.hidden = false;
          }, 260));

          const lineTotal = ui.h('strong', {}, U.money((Number(line.quantity) || 0) * (Number(line.expected_unit_cost) || 0)));
          const showLine = () => { lineTotal.textContent = U.money((Number(line.quantity) || 0) * (Number(line.expected_unit_cost) || 0)); };
          const qty = ui.h('input', {
            type: 'number', step: allowsFraction(line) ? 'any' : '1', min: '0',
            value: String(line.quantity || ''), dataset: { qty: '1' },
          });
          qty.addEventListener('input', () => {
            line.quantity = Number(qty.value) || 0;
            showLine();
            refreshLineChrome(card, line);
            paintTotals();
          });
          const cost = ui.h('input', { type: 'number', step: '0.01', min: '0', value: U.numInput(line.expected_unit_cost) });
          cost.addEventListener('input', () => {
            line.expected_unit_cost = Number(cost.value) || 0;
            showLine();
            refreshLineChrome(card, line);
            paintTotals();
          });
          const unitHost = ui.h('div', { dataset: { unitHost: '1', lineIndex: String(i) } });
          const grid = ui.h('div', { class: 'form-grid' },
            unitHost,
            ui.h('div', {}, ui.h('label', { class: 'ctl', dataset: { qtyLabel: '1' } }, 'Qty'), qty),
            ui.h('div', {}, ui.h('label', { class: 'ctl', dataset: { costLabel: '1' } }, 'Unit cost ₦'), cost),
            ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Line'), lineTotal));
          card.appendChild(grid);
          paintUnit(unitHost, line, card);
          linesBody.appendChild(card);
        });
        if (!lines.length) linesBody.appendChild(ui.h('p', { class: 'hint' }, 'No lines yet. Add the products you are ordering.'));
        linesBody.appendChild(ui.h('button', {
          class: 'btn btn-sm', type: 'button',
          onClick: () => {
            lines.push(blankOrderLine());
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
        const unitNote = lines.map(unitProblem).find(Boolean);
        if (unitNote) totalsBar.appendChild(ui.h('div', { class: 'hint' }, unitNote));
                paintStatus();
      }
      for (const name of ['freight_total', 'discount_total']) {
        const el = wrapEl.querySelector(`[name="${name}"]`);
        if (el) el.addEventListener('input', paintTotals);
      }
      wrapEl.appendChild(totalsBar);
      lines.push(blankOrderLine());
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
              syncGuidedFromDom(wrapEl, lines);
              const items = ready;
              const unitNote = items.map(unitProblem).find(Boolean);
              if (unitNote) { ui.warn(unitNote); return; }
              const guidedKey = new Map();
              for (const l of items) {
                if (l.unit_state !== 'guided') continue;
                const built = buildGuidedLadder(l.guided);
                const key = built.ok ? `${built.orderCode}:${built.orderFactor}:${built.baseName}` : 'incomplete';
                const prev = guidedKey.get(l.product_id);
                if (prev && prev !== key) {
                  ui.warn(`${l.name} is on more than one line, with different units. Use the same unit on each line.`);
                  return;
                }
                guidedKey.set(l.product_id, key);
              }
              if (SR.app.guardWorkingBusiness && !SR.app.guardWorkingBusiness()) return;
              ev.currentTarget.disabled = true;
              ev.currentTarget.textContent = 'Saving…';
              let committed = false;
              try {
                const saved = new Map();
                for (const l of items) {
                  if (l.unit_state !== 'guided') continue;
                  const already = saved.get(l.product_id);
                  if (already) {
                    l.units = already.units;
                    l.unit_state = 'locked';
                    l.unit_full_ladder = true;
                    l.guided = null;
                    l.base_name = already.base_name;
                    l.base_plural = already.base_plural;
                    applyChosenUnit(l, pickCatalogueUnit(already.units, already.unit_code));
                    continue;
                  }
                  await commitGuidedUnit(l);
                  committed = true;
                  saved.set(l.product_id, l);
                }
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
                    unit_code: l.unit_code,
                    quantity: Number(l.quantity),
                    expected_unit_cost: Number(l.expected_unit_cost) || 0,
                  })),
                });
                ui.ok(result.po_number ? `${result.po_number} raised.` : 'Purchase order raised.');
                m.close();
                load();
              } catch (err) {
                if (committed) paintLines();
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
      // The list route adds units_ordered / units_received as aggregates. The detail row does not,
      // so the top cards have to count the lines or they render as an empty dash.
      const unitsOrdered = items.reduce((sum, i) => sum + Number(i.quantity_in_base || 0), 0);
      const unitsReceived = items.reduce((sum, i) => sum + Number(i.quantity_received || 0), 0);
      const whtRate = po.wht_rate_percent != null ? po.wht_rate_percent : po.wht_percent;

      host.replaceChildren();
      const head = ui.h('div', { class: 'page-head' },
        ui.h('div', {},
          ui.h('h1', {}, po.po_number),
          ui.h('p', { class: 'sub' }, [po.supplier_name, po.branch_name, `raised ${U.date(po.ordered_at)}`].filter(Boolean).join(' · '))),
        ui.h('div', { class: 'actions' },
          ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate('/purchase-orders') }, 'Back'),
          ui.h('button', { class: 'btn btn-sm', onClick: () => printOrder(po, items) }, 'Print'),
          openForReceiving && SR.state.atLeast('MANAGER') ? ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => openReceive(po, outstanding, receipts, load) }, 'Receive goods') : null,
          canCancelOrder ? ui.h('button', { class: 'btn btn-sm btn-danger', onClick: () => cancel(po, load) }, 'Cancel order') : null));

      const orderNodes = [];
      if (offline) orderNodes.push(ui.h('div', { class: 'alert alert-warn' }, 'Offline — from this device\'s last sync.'));

      orderNodes.push(ui.h('div', { class: 'grid grid-4' },
        ui.kpi({ label: 'Order total', value: U.money(po.total), foot: `${U.qty(unitsOrdered)} units on ${items.length} line${items.length === 1 ? '' : 's'}`, small: true }),
        ui.kpi({ label: 'Received', value: `${U.qty(unitsReceived)} units`, tone: outstanding.length ? 'warn' : 'good', foot: outstanding.length ? `${outstanding.length} line${outstanding.length === 1 ? '' : 's'} outstanding` : 'complete', small: true }),
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
          foot: po.wht_code ? `${po.wht_code}${whtRate != null && whtRate !== '' ? ` @ ${whtRate}%` : ''}` : null,
          small: true,
        })));

      orderNodes.push(ui.dataCard({
        title: 'Ordered items',
        table: ui.renderTable({
          columns: [
            { key: 'product_name', label: 'Item', className: 'wrap', render: (i) => ui.h('div', {},
              ui.h('div', { style: { fontWeight: '600' } }, i.product_name || i.name),
              ui.h('div', { class: 'hint' }, [i.sku, i.variant_name].filter(Boolean).join(' · '))) },
            { key: 'quantity', label: 'Ordered', align: 'right', render: (i) => orderedPhrase(i) },
            { key: 'quantity_in_base', label: 'In base units', align: 'right', render: (i) => basePhrase(i) },
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

      const deliveryNodes = [];
      if (receipts.length) {
        deliveryNodes.push(ui.dataCard({
          title: 'Deliveries against this order',
          table: ui.renderTable({
            columns: [
              { key: 'received_at', label: 'Received', render: (r) => U.watClock(r.received_at) },
              { key: 'product_name', label: 'Item', className: 'wrap' },
              { key: 'quantity_received', label: 'Quantity', align: 'right', render: (r) => U.qty(r.quantity_received) },
              { key: 'batch_no', label: 'Batch', render: (r) => ui.h('span', { class: 'mono' }, r.batch_no || '—') },
              { key: 'cost_per_unit', label: 'Cost/unit', align: 'right', render: (r) => U.money(r.cost_per_unit, { kobo: true }) },
              { key: 'received_by_name', label: 'Received by' },
            ],
            rows: receipts,
          }),
        }));
      } else {
        deliveryNodes.push(ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' },
          ui.h('h2', {}, 'Deliveries'),
          ui.h('p', { class: 'sub' }, 'Nothing has been received against this order yet.'))));
      }
      host.replaceChildren(ui.sectionTabs({
        head,
        remember: 'sr.poTab',
        sections: [
          { id: 'order', label: 'Order', nodes: orderNodes },
          { id: 'deliveries', label: 'Deliveries', nodes: deliveryNodes },
        ],
      }));
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
          { key: 'quantity', label: 'Ordered', value: (i) => orderedPhrase(i) },
          { key: 'quantity_in_base', label: 'In base units', value: (i) => basePhrase(i) },
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
            ui.h('div', { class: 'hint' }, `Still to come: ${basePhrase({ quantity_in_base: round4(Number(i.quantity_in_base) - Number(i.quantity_received)), base_unit_name: i.base_unit_name })}. Ordered as ${orderedPhrase(i)}.`))));

        const serialName = `serials_${i.id}`;
        const grid = ui.h('div', { class: 'form-grid' });
        grid.appendChild(ui.field({
          label: `Quantity received (${i.base_unit_name || 'units'})`, name: `qty_${i.id}`, type: 'number', step: 'any', min: '0',
          value: String(entry.quantityBase),
          hint: `Enter ${i.base_unit_name || 'base units'}, not the order pack. The order was ${orderedPhrase(i)}.`,
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
        const tracked = Boolean(Number(i.requires_serial) && SR.state.usesSerialNumbers());
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
    wrapEl.appendChild(ui.h('div', { class: 'hint' }, 'Selling price defaults to the product\'s current price. If this shop has no price yet, the figure you type becomes the price the till charges. A later delivery does not change a price already set — it only prices the new batch.'));
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
              if (!SR.state.usesSerialNumbers() || !Number(e.item.requires_serial) || !(e.quantityBase > 0)) continue;
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
              if (Array.isArray(result.prices)) {
                for (const priced of result.prices) {
                  try { await SR.store.rememberShopPrice(priced); } catch (err) { /* the till reads the server */ }
                }
              }
              const registered = Array.isArray(result.serials) ? result.serials.length : 0;
              // The route files them under `warnings` (a duplicate across the group, say).
              const warningList = Array.isArray(result.warnings) ? result.warnings
                : (Array.isArray(result.serialWarnings) ? result.serialWarnings : []);
              const warned = warningList.length
                ? ` ${typeof warningList[0] === 'string' ? warningList[0] : JSON.stringify(warningList[0])}` : '';
              ui.ok(`${result.fullyReceived
                ? 'Received in full. The order is complete and the batches are on the shelf.'
                : 'Delivery recorded. The order remains open for the balance.'}${registered ? ` ${registered} serial number(s) are on file against the units.` : ''}${(result.prices || []).some((p) => p.catalogue || p.override_id) ? ' The selling price is what the till will charge.' : ''}${warned}`);
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
