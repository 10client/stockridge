'use strict';
// The shelf on this device must move the same way the shop moves it.
// Stock is counted in base units. A sale takes free stock first (quantity
// minus what a bill or a layaway already holds), soonest expiry, then the
// oldest receipt. A hire or a lease does not take the unit off the shelf.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.SR = root.SR || {};
    root.SR.shelf = api;
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function roundTo(value, places) {
    const factor = 10 ** places;
    return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
  }

  function factorFor(unitCode, units, fallback) {
    const code = String(unitCode || '').trim().toUpperCase();
    const rows = (units || []).filter((row) => row && !Number(row.is_deleted) && Number(row.quantity_in_base) > 0);
    if (code && rows.length) {
      const hit = rows.find((row) => String(row.code || '').toUpperCase() === code)
        || rows.find((row) => String(row.name || '').toUpperCase() === code);
      if (hit) return Number(hit.quantity_in_base);
    }
    const explicit = Number(fallback);
    return explicit > 0 ? explicit : 1;
  }

  function baseQuantity(line, units) {
    const qty = Number(line && (line.quantity != null ? line.quantity : line.qty));
    if (!(qty > 0)) return 0;
    const factor = factorFor(
      line.unitCode || line.unit_code,
      units,
      line.unitFactor != null ? line.unitFactor : line.unit_factor,
    );
    return roundTo(qty * factor, 4);
  }

  function holdsStock(line) {
    const channel = String((line && (line.channel || line.sale_type || line.saleType)) || 'RETAIL').toUpperCase();
    return channel === 'HIRE' || channel === 'LEASE';
  }

  function freeOf(batch) {
    return Math.max(0, (Number(batch.quantity) || 0) - (Number(batch.quantity_reserved) || 0));
  }

  function sortBatches(batches, preferIds, asOf) {
    return (batches || []).filter((batch) => {
      if (!batch || Number(batch.is_deleted)) return false;
      if (String(batch.status || 'ACTIVE').toUpperCase() !== 'ACTIVE') return false;
      if (asOf && batch.expiry_date && String(batch.expiry_date).slice(0, 10) < asOf) return false;
      return freeOf(batch) > 0;
    }).sort((a, b) => {
      if (preferIds) {
        const pa = preferIds.has(String(a.id)) ? 0 : 1;
        const pb = preferIds.has(String(b.id)) ? 0 : 1;
        if (pa !== pb) return pa - pb;
      }
      const ea = a.expiry_date ? Date.parse(a.expiry_date) : Number.POSITIVE_INFINITY;
      const eb = b.expiry_date ? Date.parse(b.expiry_date) : Number.POSITIVE_INFINITY;
      if (ea !== eb) return ea - eb;
      const ra = Date.parse(a.received_at || a.created_at || 0) || 0;
      const rb = Date.parse(b.received_at || b.created_at || 0) || 0;
      if (ra !== rb) return ra - rb;
      const ba = String(a.batch_no || '');
      const bb = String(b.batch_no || '');
      if (ba !== bb) return ba < bb ? -1 : 1;
      return String(a.id).localeCompare(String(b.id));
    });
  }

  /**
   * Apply sale lines to a copy of the shelf. Returns only the batches that
   * changed. Reserved units stay reserved unless this sale was allowed to
   * take that hold (a bill being paid).
   */
  function consumeLines(batches, lines, options) {
    const opts = options || {};
    const unitsByProduct = opts.unitsByProduct || new Map();
    const asOf = opts.asOf ? String(opts.asOf).slice(0, 10) : null;
    const holdMap = new Map();
    for (const hold of opts.holds || []) {
      const id = String((hold && (hold.batchId || hold.batch_id)) || '');
      const qty = Number(hold && (hold.quantityBase != null ? hold.quantityBase : hold.quantity_base));
      if (!id || !(qty > 0)) continue;
      holdMap.set(id, roundTo((holdMap.get(id) || 0) + qty, 4));
    }
    const byId = new Map((batches || []).filter((batch) => batch && batch.id != null).map((batch) => [String(batch.id), Object.assign({}, batch)]));
    const changed = new Map();
    for (const line of lines || []) {
      if (!line || (holdsStock(line) && !line.buyout && !line.buy_out)) continue;
      const productId = String(line.productId || line.product_id || '');
      if (!productId) continue;
      const variantId = line.variantId || line.variant_id || '';
      let need = baseQuantity(line, unitsByProduct.get ? unitsByProduct.get(productId) : null);
      if (!(need > 0)) continue;
      const pool = [...byId.values()].filter((batch) => {
        if (String(batch.product_id) !== productId) return false;
        if (variantId && String(batch.variant_id || '') !== String(variantId)) return false;
        return true;
      }).map((batch) => {
        const asked = holdMap.get(String(batch.id)) || 0;
        const giveBack = Math.min(Math.max(0, Number(batch.quantity_reserved) || 0), asked);
        return Object.assign({}, batch, {
          quantity_reserved: roundTo(Math.max(0, (Number(batch.quantity_reserved) || 0) - giveBack), 4),
          _giveBack: giveBack,
        });
      });
      for (const row of sortBatches(pool, new Set(holdMap.keys()), asOf)) {
        if (!(need > 0)) break;
        const take = Math.min(roundTo(freeOf(row), 4), need);
        if (!(take > 0)) continue;
        const live = byId.get(String(row.id));
        if (!live) continue;
        const held = Math.min(row._giveBack || 0, take);
        const nextQty = roundTo(Math.max(0, (Number(live.quantity) || 0) - take), 4);
        const nextReserved = roundTo(Math.max(0, (Number(live.quantity_reserved) || 0) - held), 4);
        const next = Object.assign({}, live, {
          quantity: nextQty,
          quantity_reserved: nextReserved,
          status: nextQty <= 0 ? 'DEPLETED' : (String(live.status || 'ACTIVE').toUpperCase() === 'DEPLETED' ? 'ACTIVE' : live.status),
        });
        byId.set(String(row.id), next);
        changed.set(String(row.id), next);
        if (held > 0) holdMap.set(String(row.id), roundTo(Math.max(0, (holdMap.get(String(row.id)) || 0) - held), 4));
        need = roundTo(need - take, 4);
      }
    }
    for (const [batchId, qty] of holdMap) {
      if (!(qty > 0.0001)) continue;
      const live = byId.get(batchId);
      if (!live) continue;
      const next = Object.assign({}, live, {
        quantity_reserved: roundTo(Math.max(0, (Number(live.quantity_reserved) || 0) - qty), 4),
      });
      byId.set(batchId, next);
      changed.set(batchId, next);
    }
    return [...changed.values()];
  }

  function adjustLine(batches, body, units) {
    if (!body || !body.product_id) return [];
    const adds = String(body.adjustment_type || '').toUpperCase() === 'FOUND';
    const qty = Math.abs(baseQuantity({
      quantity: body.quantity,
      unitCode: body.unit_code,
      unitFactor: body.unit_factor,
    }, units));
    if (!(qty > 0)) return [];
    const branchId = body.branch_id ? String(body.branch_id) : '';
    const productId = String(body.product_id);
    const pool = (batches || []).filter((batch) => batch && !Number(batch.is_deleted)
      && String(batch.product_id) === productId
      && (!branchId || String(batch.branch_id) === branchId));
    if (adds) {
      const target = (body.batch_id && pool.find((batch) => String(batch.id) === String(body.batch_id))) || pool[0];
      if (!target) return [];
      const nextQty = roundTo((Number(target.quantity) || 0) + qty, 4);
      return [Object.assign({}, target, {
        quantity: nextQty,
        initial_quantity: roundTo((Number(target.initial_quantity) || 0) + qty, 4),
        status: String(target.status || '').toUpperCase() === 'DEPLETED' ? 'ACTIVE' : target.status,
      })];
    }
    const named = body.batch_id ? pool.find((batch) => String(batch.id) === String(body.batch_id)) : null;
    const ordered = named ? [named] : sortBatches(pool, null, null);
    let left = qty;
    const changed = [];
    for (const batch of ordered) {
      if (!(left > 0)) break;
      const free = roundTo(freeOf(batch), 4);
      const take = Math.min(free, left);
      if (!(take > 0)) continue;
      const nextQty = roundTo(Math.max(0, (Number(batch.quantity) || 0) - take), 4);
      changed.push(Object.assign({}, batch, {
        quantity: nextQty,
        status: nextQty <= 0 ? 'DEPLETED' : batch.status,
      }));
      left = roundTo(left - take, 4);
    }
    return changed;
  }

  return { roundTo, factorFor, baseQuantity, consumeLines, adjustLine };
});
