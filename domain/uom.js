'use strict';
// =====================================================================
// domain/uom.js — UNIT OF MEASURE LADDER AND CONVERSION
// =====================================================================
// THE INVARIANT THIS FILE PROTECTS
//
// Stock is ALWAYS held and decremented in BASE UNITS. A sale of 2 cartons
// of a product whose carton is 48 base units decrements 96. Every
// valuation, reorder alert, stocktake variance and margin figure therefore
// stays in one unit regardless of what the cashier happened to ring up.
//
// This replaced PharmaRidge's hardcoded base_unit / units_per_pack /
// packs_per_carton ladder, which only worked because a medicine is sold as
// tablet -> strip -> carton and nothing else. A general merchant needs an
// arbitrary ladder (piece -> pack -> carton -> bag -> pallet) PLUS measured
// selling for cable by the metre, tiles by the square metre and nails by
// the kilo.
//
// WHY THE SYSTEM DOES THE ARITHMETIC, NOT THE PERSON
// Asking a storekeeper to divide ₦480,000 by 1,000 pieces and type 480 is
// asking them to do the system's job, and a slipped decimal place there
// silently corrupts every margin the product reports afterwards. So the
// ladder resolves quantities AND costs in both directions, and the UI never
// asks for a per-piece figure when a per-carton figure was supplied.
// =====================================================================

const { round2, roundTo } = require('./money');

const RECEIVE_UNITS = Object.freeze(['BASE', 'UNIT_LEVEL', 'MEASURED']);

// Hard ceilings on a ladder step. Without these a fat-fingered "1 carton =
// 100000 pieces" makes stock numbers meaningless and un-fixable after the
// fact, because every sale already decremented by that factor.
const MAX_QUANTITY_IN_BASE = 100000;
const MAX_LADDER_LEVELS = 8;

/**
 * Build the canonical ladder for a product from its product_units rows.
 * Returns levels sorted ascending, with `base` always present and validated.
 */
// A normaliser MUST be idempotent: feeding it its own output has to give the
// same answer again. This one was not, and the failure was total rather than
// subtle.
//
// It read only snake_case (`r.quantity_in_base`), which is the shape of a row
// from the database. But salesService.prepare() builds the ladder once, then
// hands the RESULT to toBaseUnits(), which builds it again. On the second pass
// `quantity_in_base` is undefined, Number(undefined) is NaN, and the
// `Number.isFinite(...) && > 0` filter below discards EVERY level — so a
// product with a perfectly good two-level ladder was reported as having "no
// unit of measure configured" and could not be sold at all.
//
// Worse, `is_default_sell` read as NaN, so even a ladder that survived would
// have lost its default sell unit and quietly fallen back to the LARGEST one:
// a cashier typing 1 would have sold a carton.
//
// Both shapes are now accepted. `?? ` rather than `||` matters: `is_sellable`
// and `is_default_sell` are 0/1, and `0 || fallback` would discard a real zero.
function buildLadder(unitRows) {
  const rows = (unitRows || [])
    .filter((r) => !r.is_deleted && r.isDeleted !== true)
    .map((r) => ({
      code: String(r.code || '').toUpperCase(),
      name: r.name || r.code,
      pluralName: r.pluralName ?? r.plural_name ?? (r.name ? `${r.name}s` : r.code),
      level: Number(r.level ?? 0) || 0,
      quantityInBase: Number(r.quantityInBase ?? r.quantity_in_base),
      isSellable: r.isSellable !== undefined ? r.isSellable !== false : Number(r.is_sellable ?? 1) !== 0,
      isDefaultSell: r.isDefaultSell !== undefined ? Boolean(r.isDefaultSell) : Number(r.is_default_sell ?? 0) === 1,
    }))
    .filter((r) => Number.isFinite(r.quantityInBase) && r.quantityInBase > 0)
    .sort((a, b) => a.quantityInBase - b.quantityInBase);

  if (!rows.length) {
    return { ok: false, code: 'NO_UNIT_LADDER', error: 'This product has no unit of measure configured. Add at least a base unit.' };
  }
  const base = rows[0];
  if (base.quantityInBase !== 1) {
    return {
      ok: false, code: 'LADDER_MISSING_BASE',
      error: `The lowest unit "${base.code}" is ${base.quantityInBase} base units. The ladder must start at exactly 1 base unit so stock can be counted.`,
    };
  }
  if (rows.length > MAX_LADDER_LEVELS) {
    return { ok: false, code: 'LADDER_TOO_DEEP', error: `A product may have at most ${MAX_LADDER_LEVELS} unit levels.` };
  }
  for (const r of rows) {
    if (r.quantityInBase > MAX_QUANTITY_IN_BASE) {
      return { ok: false, code: 'UNIT_STEP_TOO_LARGE', error: `Unit "${r.code}" is ${r.quantityInBase} base units, above the ${MAX_QUANTITY_IN_BASE.toLocaleString('en-NG')} ceiling. This is almost certainly a typo.` };
    }
  }
  const defaultSell = rows.find((r) => r.isDefaultSell && r.isSellable) || rows[rows.length - 1];
  return {
    ok: true,
    ladder: rows,
    base,
    defaultSell,
    byCode: Object.fromEntries(rows.map((r) => [r.code, r])),
    byLabel: labelIndex(rows),
  };
}

/** Validate a proposed ladder before it is written. */
function validateLadder(levels) {
  const rows = Array.isArray(levels) ? levels : [];
  if (!rows.length) return { ok: false, code: 'EMPTY_LADDER', error: 'At least one unit level is required.' };
  if (rows.length > MAX_LADDER_LEVELS) return { ok: false, code: 'LADDER_TOO_DEEP', error: `A product may have at most ${MAX_LADDER_LEVELS} unit levels.` };

  const seen = new Set();
  let previous = 0;
  const normalised = [];
  for (let i = 0; i < rows.length; i += 1) {
    const raw = rows[i];
    const code = String(raw.code || '').trim().toUpperCase();
    const qty = Number(raw.quantityInBase);
    if (!code) return { ok: false, code: 'UNIT_CODE_REQUIRED', error: `Unit ${i + 1} needs a code (e.g. PIECE, CARTON).` };
    if (seen.has(code)) return { ok: false, code: 'DUPLICATE_UNIT_CODE', error: `Unit code "${code}" appears twice on the same product.` };
    seen.add(code);
    if (!Number.isFinite(qty) || qty <= 0) return { ok: false, code: 'UNIT_QUANTITY_INVALID', error: `Unit "${code}" needs a positive number of base units.` };
    if (qty > MAX_QUANTITY_IN_BASE) return { ok: false, code: 'UNIT_STEP_TOO_LARGE', error: `Unit "${code}" is ${qty} base units, above the ${MAX_QUANTITY_IN_BASE.toLocaleString('en-NG')} ceiling.` };
    if (qty <= previous) return { ok: false, code: 'LADDER_NOT_ASCENDING', error: `Unit "${code}" (${qty} base units) must contain MORE than the previous unit (${previous}).` };
    previous = qty;
    normalised.push({
      code,
      name: String(raw.name || code),
      pluralName: String(raw.pluralName || raw.plural_name || `${raw.name || code}s`),
      level: i,
      quantityInBase: qty,
      isSellable: raw.isSellable !== false && Number(raw.is_sellable) !== 0,
      isDefaultSell: Boolean(raw.isDefaultSell || raw.is_default_sell),
    });
  }
  if (normalised[0].quantityInBase !== 1) {
    return { ok: false, code: 'LADDER_MISSING_BASE', error: 'The first unit level must be exactly 1 base unit.' };
  }
  if (!normalised.some((r) => r.isDefaultSell)) normalised[normalised.length - 1].isDefaultSell = true;
  return { ok: true, levels: normalised };
}

/**
 * Index the ladder by the WORDS a unit is called, not just its code.
 *
 * WHY THIS EXISTS — a defect found by ringing a sale through the real Sell screen:
 *
 *   Line 1 ("Anker 20000mAh Power Bank"): Unknown unit "UNIT".
 *   This product is sold in: PIECE, CARTON.
 *
 * The appliance ladder names its base unit "Unit" under the code `PIECE`. The
 * product row carries `base_unit_name` ("unit") because that is the word a receipt
 * prints, and the till used it as if it were the code: uppercased to `UNIT`, which
 * is not in the ladder. A cashier could search the product, add it to the cart and
 * take the payment — and then the sale was refused, on every appliance and gadget
 * in the catalogue.
 *
 * Nothing caught it because for most verticals the name and the code coincide:
 * `piece`→PIECE, `bag`→BAG, `metre`→METRE. Only where a ladder names a level
 * differently from its code does the guess fail, and only running the screen shows
 * it.
 *
 * A name is accepted when it identifies exactly ONE level. Two levels sharing a
 * word ("Unit" for both a piece and a carton) stay ambiguous and are refused,
 * because guessing between them is the bug, not the fix.
 */
function labelIndex(rows) {
  const seen = new Map();
  for (const r of rows) {
    for (const label of [r.name, r.pluralName]) {
      const key = String(label || '').trim().toUpperCase();
      if (!key) continue;
      if (!seen.has(key)) seen.set(key, { level: r, ambiguous: false });
      else if (seen.get(key).level !== r) seen.get(key).ambiguous = true;
    }
  }
  return seen;
}

/**
 * Resolve a quantity expressed in any ladder unit into base units.
 *
 * `quantity` may be fractional ONLY for a measured product; for a discrete
 * ladder it must be a whole number, because 1.5 cartons is not a thing a
 * warehouse can hand over and accepting it hides a data-entry error that
 * will later show up as an unexplained stocktake variance.
 */
function toBaseUnits({ quantity, unitCode, ladder, measure = null }) {
  const q = Number(quantity);
  if (!Number.isFinite(q) || q <= 0) {
    return { ok: false, code: 'QUANTITY_INVALID', error: 'Quantity must be a positive number.' };
  }
  const code = String(unitCode || '').trim().toUpperCase();

  // Measured goods: the measure's own unit wins, and fractions are allowed.
  if (measure && measure.axis && code && code === String(measure.sellUnitCode || measure.sell_unit_code || '').toUpperCase()) {
    const factor = Number(measure.sellUnitBaseFactor || measure.sell_unit_base_factor || 1);
    if (!(factor > 0)) return { ok: false, code: 'MEASURE_FACTOR_INVALID', error: 'The measured conversion factor must be positive.' };
    const baseQty = roundTo(q * factor, 4);
    return { ok: true, baseQuantity: baseQty, unitCode: code, factor, measured: true, discrete: false };
  }

  const resolved = buildLadder(Array.isArray(ladder) ? ladder : (ladder && ladder.ladder) || []);
  if (!resolved.ok) return resolved;

  // By code first; then by the word the unit is called. A caller holding a
  // product row has the NAME (`base_unit_name` is the receipt word), and for most
  // verticals the two are the same string once uppercased — which is precisely why
  // the difference went unnoticed until an appliance ladder disagreed.
  let level = resolved.byCode[code];
  let resolvedFrom = level ? 'code' : null;
  if (!level) {
    const match = resolved.byLabel ? resolved.byLabel.get(code) : null;
    if (match && match.ambiguous) {
      return {
        ok: false,
        code: 'AMBIGUOUS_UNIT',
        error: `"${unitCode}" names more than one unit on this product. Use the unit code instead: ${resolved.ladder.map((r) => r.code).join(', ')}.`,
      };
    }
    if (match) { level = match.level; resolvedFrom = 'name'; }
  }
  if (!level) {
    const available = resolved.ladder.map((r) => `${r.code} (${r.name})`).join(', ');
    return { ok: false, code: 'UNKNOWN_UNIT', error: `Unknown unit "${unitCode}". This product is sold in: ${available}.` };
  }
  if (!level.isSellable) {
    return { ok: false, code: 'UNIT_NOT_SELLABLE', error: `"${level.name}" is a receiving unit only and cannot be sold.` };
  }
  const discrete = !measure || !measure.axis;
  if (discrete && !Number.isInteger(q)) {
    return { ok: false, code: 'FRACTIONAL_DISCRETE_QTY', error: `"${level.name}" must be a whole number — ${q} is not. Use ${resolved.base.name} for a part of a ${level.name.toLowerCase()}.` };
  }
  return {
    ok: true,
    baseQuantity: roundTo(q * level.quantityInBase, 4),
    unitCode: level.code,
    unitName: level.name,
    // 'code' or 'name' — so a caller can tell that it sent a word rather than a
    // code, and warn or tighten up.
    resolvedFrom,
    factor: level.quantityInBase,
    measured: false,
    discrete,
    level,
  };
}

/** The reverse: express base units in a chosen ladder unit (for display). */
function fromBaseUnits({ baseQuantity, unitCode, ladder }) {
  const resolved = buildLadder(Array.isArray(ladder) ? ladder : (ladder && ladder.ladder) || []);
  if (!resolved.ok) return resolved;
  const base = Number(baseQuantity) || 0;
  const level = resolved.byCode[String(unitCode || '').trim().toUpperCase()] || resolved.base;
  return { ok: true, quantity: roundTo(base / level.quantityInBase, 4), unitCode: level.code, unitName: level.name, remainderBase: roundTo(base % level.quantityInBase, 4) };
}

/**
 * Split a total cost paid for a delivery across the ladder.
 *
 * The per-base-unit figure is deliberately NOT rounded to kobo. Rounding
 * 480,000/7,000 to 68.57 and multiplying back gives 479,990 — the stock
 * would be valued ₦10 below what was actually paid, on every delivery,
 * forever. Full precision is kept for valuation; the DISPLAY rounds.
 */
function splitTotalCost(totalCost, baseQuantity) {
  const cost = Number(totalCost);
  const qty = Number(baseQuantity);
  if (!Number.isFinite(cost) || cost < 0) {
    return { ok: false, code: 'TOTAL_COST_INVALID', error: 'Enter the total amount paid for this line — the figure on the supplier invoice.' };
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, code: 'QUANTITY_INVALID', error: 'Quantity received must be greater than zero.' };
  }
  return { ok: true, totalCost: cost, baseQuantity: qty, costPerBaseUnit: cost / qty };
}

/**
 * Convert a per-base-unit price to every ladder level, so the POS can show
 * "₦500 / piece · ₦24,000 / carton" without the cashier multiplying.
 */
function priceLadder(pricePerBaseUnit, ladder) {
  const resolved = buildLadder(Array.isArray(ladder) ? ladder : (ladder && ladder.ladder) || []);
  if (!resolved.ok) return {};
  const p = Number(pricePerBaseUnit) || 0;
  const out = {};
  for (const level of resolved.ladder) out[level.code] = round2(p * level.quantityInBase);
  return out;
}

/** One human-readable sentence for the receive screen and the GRN. */
function describeReceipt({ quantity, unitCode, ladder, measure = null }) {
  const n = (x) => Number(x).toLocaleString('en-NG');
  const resolved = buildLadder(Array.isArray(ladder) ? ladder : (ladder && ladder.ladder) || []);
  if (!resolved.ok) return `${n(quantity)} ${unitCode}`;
  const base = toBaseUnits({ quantity, unitCode, ladder, measure });
  if (!base.ok) return `${n(quantity)} ${unitCode}`;
  const level = resolved.byCode[String(unitCode || '').toUpperCase()];
  if (measure && measure.axis && base.measured) {
    return `${n(quantity)} ${String(measure.sellUnitName || unitCode).toLowerCase()} = ${n(base.baseQuantity)} ${resolved.base.name.toLowerCase()}`;
  }
  if (!level || level.quantityInBase === 1) return `${n(quantity)} ${resolved.base.pluralName.toLowerCase()}`;
  return `${n(quantity)} ${level.pluralName.toLowerCase()} x ${n(level.quantityInBase)} = ${n(base.baseQuantity)} ${resolved.base.pluralName.toLowerCase()}`;
}

/**
 * Pick the batch to sell from. FIFO on received_at, then on expiry where
 * batches carry one. Centralised so POS, transfers and warranty
 * replacements all consume stock in the same order — otherwise two routes
 * can each believe they own the same batch and one oversells.
 *
 * Quarantined and expired batches are never candidates. Reserved quantity
 * is subtracted, because it is already spoken for by a layaway or an open
 * delivery job.
 */
function selectBatchesFifo(batches, requiredBaseQty) {
  const available = (batches || [])
    .filter((b) => !b.is_deleted && b.status === 'ACTIVE')
    .filter((b) => (Number(b.quantity) || 0) - (Number(b.quantity_reserved) || 0) > 0)
    .sort((a, b) => {
      // Expiry first when both carry one: sell the stock that will go off.
      const ea = a.expiry_date ? Date.parse(a.expiry_date) : Number.POSITIVE_INFINITY;
      const eb = b.expiry_date ? Date.parse(b.expiry_date) : Number.POSITIVE_INFINITY;
      if (ea !== eb) return ea - eb;
      const ra = Date.parse(a.received_at || a.created_at || 0) || 0;
      const rb = Date.parse(b.received_at || b.created_at || 0) || 0;
      if (ra !== rb) return ra - rb;
      // FINAL TIEBREAK, and why it is not the id.
      //
      // Receipt timestamps are stored to the second, so two batches received in
      // the same second are genuinely tied — and that happens routinely when a
      // goods-received note books several lines at once. It used to fall through
      // to `id.localeCompare`, but ids are random hex, so the winner was
      // arbitrary and DIFFERENT on every run. Two identical sales could consume
      // different batches and therefore snapshot different costs, which makes
      // margin history irreproducible and a seeded fixture impossible to replay
      // against a bug report.
      //
      // batch_no is stable, human-meaningful and what a warehouse person reads
      // off a label, so it is the tiebreak of record. The id stays last purely to
      // guarantee a total order when batch numbers repeat or are absent.
      const ba = String(a.batch_no || '');
      const bb = String(b.batch_no || '');
      if (ba !== bb) return ba < bb ? -1 : 1;
      return String(a.id).localeCompare(String(b.id));
    });

  const picks = [];
  let remaining = roundTo(Number(requiredBaseQty) || 0, 4);
  for (const b of available) {
    if (remaining <= 0) break;
    const free = roundTo((Number(b.quantity) || 0) - (Number(b.quantity_reserved) || 0), 4);
    const take = Math.min(free, remaining);
    if (take > 0) {
      picks.push({ batch: b, quantityBase: roundTo(take, 4), costPerBaseUnit: Number(b.cost_price_per_unit) || 0 });
      remaining = roundTo(remaining - take, 4);
    }
  }
  return {
    ok: remaining <= 0,
    picks,
    shortfallBase: roundTo(Math.max(0, remaining), 4),
    totalCost: round2(picks.reduce((acc, p) => acc + p.quantityBase * p.costPerBaseUnit, 0)),
  };
}

/** Weighted-average cost across batches — what the GL uses by default. */
function weightedAverageCost(batches) {
  const rows = (batches || []).filter((b) => !b.is_deleted && Number(b.quantity) > 0);
  const qty = rows.reduce((a, b) => a + Number(b.quantity), 0);
  if (qty <= 0) return 0;
  const value = rows.reduce((a, b) => a + Number(b.quantity) * Number(b.cost_price_per_unit || 0), 0);
  return value / qty; // FULL PRECISION — see splitTotalCost
}

module.exports = {
  RECEIVE_UNITS, MAX_QUANTITY_IN_BASE, MAX_LADDER_LEVELS,
  buildLadder, validateLadder, toBaseUnits, fromBaseUnits,
  splitTotalCost, priceLadder, describeReceipt,
  selectBatchesFifo, weightedAverageCost,
};
