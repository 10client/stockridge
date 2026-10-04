// =====================================================================
// StockRidge — UNITS OF MEASURE  &  THE SELLING/PACKING LADDER
// =====================================================================
// Ported from PharmaRidge's `receiving.js` [UOM] design, generalised.
//
// THE PROBLEM IT SOLVES (unchanged from the pharmacy original):
// A wholesaler receives "10 cartons" and sells "3 cartons" or "2 packs",
// but stock must be held in ONE canonical unit or the system cannot tell
// you how many items you actually have. Asking the storekeeper to divide
// ₦480,000 by 1,000 units and type 480 is asking them to do the system's
// job, and a slipped decimal silently corrupts every margin figure that
// product reports afterwards.
//
// So: stock is ALWAYS held in base units. Sales and receipts may be
// expressed in BASE_UNIT / PACK / CARTON / PALLET, and this module is the
// only place that converts. Nothing in routes or views does unit maths.
//
// WHAT CHANGED FOR A GENERAL BUSINESS:
//   * PALLET rung added — a wholesale appliance distributor moves
//     pallets, a pharmacy never did.
//   * The ladder is declared per profile, so a furniture showroom never
//     sees "carton" and a cement yard never sees "pallet of pieces".
//   * Fractional base units are allowed for METRE / LITRE / KILOGRAM /
//     SQUARE_METRE / CUBIC_METRE. PharmaRidge's INTEGER quantity was
//     right for tablets and wrong for 2.5 m of curtain fabric or 0.75 m³
//     of sand. `isFractionalUom()` decides, and stock columns are REAL
//     throughout with integer enforcement applied only where it applies.
// =====================================================================

const { BASE_UNITS } = require('./industryProfiles');

const UNIT_CODES = new Set(BASE_UNITS.map((u) => u.code));

const FRACTIONAL_UNITS = Object.freeze(new Set([
  'METRE', 'SQUARE_METRE', 'CUBIC_METRE', 'KILOGRAM', 'GRAM', 'LITRE',
]));

const SELLING_UNITS = Object.freeze(['BASE_UNIT', 'PACK', 'CARTON', 'PALLET']);
const SELLING_UNIT_CODES = new Set(SELLING_UNITS);

// Hard ceilings. PharmaRidge's MAX_PACKS_PER_CARTON / MAX_UNITS_PER_PACK
// existed to catch a fat-fingered "100000" in the pack-size field turning
// every carton into a warehouse. Kept, with PALLET given its own.
const MAX_UNITS_PER_PACK = 10000;
const MAX_PACKS_PER_CARTON = 1000;
const MAX_CARTONS_PER_PALLET = 200;
const MAX_QUANTITY = 1_000_000;
const MAX_QUANTITY_DECIMALS = 3;

function getUnit(code) {
  return BASE_UNITS.find((u) => u.code === String(code || '').trim().toUpperCase()) || null;
}

function isUnit(code) { return UNIT_CODES.has(String(code || '').trim().toUpperCase()); }

function isFractionalUom(code) { return FRACTIONAL_UNITS.has(String(code || '').trim().toUpperCase()); }

function unitLabel(code, count) {
  const u = getUnit(code);
  if (!u) return String(code || 'unit');
  return Number(count) === 1 ? u.label : u.plural;
}

function unitAbbrev(code) {
  const u = getUnit(code);
  return u ? u.abbrev : String(code || 'u');
}

function isSellingUnit(code) { return SELLING_UNIT_CODES.has(String(code || '').trim().toUpperCase()); }

// Quantity sanity check. Applied at every boundary — POS, receiving,
// transfer, adjustment, stocktake — because one bad path is enough to put
// negative stock into the ledger and every report downstream lies.
function validateQuantity(qty, { uom = 'PIECE', allowFractional } = {}) {
  const fractional = allowFractional == null ? isFractionalUom(uom) : !!allowFractional;
  if (!Number.isFinite(qty)) {
    return { ok: false, code: 'QUANTITY_NOT_A_NUMBER', error: 'Enter a quantity as a number.' };
  }
  if (qty <= 0) {
    return { ok: false, code: 'QUANTITY_NOT_POSITIVE', error: 'Quantity must be greater than zero.' };
  }
  if (qty > MAX_QUANTITY) {
    return { ok: false, code: 'QUANTITY_TOO_LARGE', error: `Quantity cannot exceed ${MAX_QUANTITY.toLocaleString('en-NG')}. Check for an extra digit.` };
  }
  if (!fractional && !Number.isInteger(qty)) {
    return { ok: false, code: 'QUANTITY_MUST_BE_WHOLE', error: `${unitLabel(uom, 2)} are counted whole — ${qty} is not a whole number.` };
  }
  if (fractional) {
    const decimals = (String(qty).split('.')[1] || '').length;
    if (decimals > MAX_QUANTITY_DECIMALS) {
      return { ok: false, code: 'QUANTITY_TOO_PRECISE', error: `Use at most ${MAX_QUANTITY_DECIMALS} decimal places (you entered ${decimals}).` };
    }
  }
  return { ok: true, qty: fractional ? Number(qty) : Math.trunc(qty) };
}

// The ladder a product declares, read off the product row. Returns the
// multiplier from each rung to base units.
//   units_per_pack    base units in one PACK
//   packs_per_carton  PACKs in one CARTON
//   cartons_per_pallet CARTONs in one PALLET
// A rung that is not configured has no multiplier and cannot be sold at.
function ladderOf(product) {
  const unitsPerPack = Number(product && product.units_per_pack) > 0 ? Number(product.units_per_pack) : 1;
  const packsPerCarton = Number(product && product.packs_per_carton) > 0 ? Number(product.packs_per_carton) : null;
  const cartonsPerPallet = Number(product && product.cartons_per_pallet) > 0 ? Number(product.cartons_per_pallet) : null;
  const perPack = unitsPerPack;
  const perCarton = packsPerCarton ? perPack * packsPerCarton : null;
  const perPallet = (perCarton && cartonsPerPallet) ? perCarton * cartonsPerPallet : null;
  const rungs = ['BASE_UNIT', 'PACK'];
  if (perCarton) rungs.push('CARTON');
  if (perPallet) rungs.push('PALLET');
  return { unitsPerPack, packsPerCarton, cartonsPerPallet, perPack, perCarton, perPallet, rungs };
}

function piecesPerUnit(product, unit) {
  const l = ladderOf(product);
  switch (String(unit || 'BASE_UNIT').toUpperCase()) {
    case 'PACK': return l.perPack;
    case 'CARTON': return l.perCarton;
    case 'PALLET': return l.perPallet;
    default: return 1;
  }
}

// Resolve one line of a receipt or a sale: the caller says "10 CARTON",
// this returns how many base units that is and whether it is even legal
// for this product. Never throws — returns { ok:false, code, error } so
// the route can answer with a message a storekeeper understands.
function resolveLine(product, { quantity, unit = 'BASE_UNIT' }) {
  const uom = product && product.base_unit ? product.base_unit : 'PIECE';
  const allowed = (product && Array.isArray(product.selling_units) && product.selling_units.length)
    ? product.selling_units
    : SELLING_UNITS;

  const u = String(unit || 'BASE_UNIT').trim().toUpperCase();
  if (!isSellingUnit(u)) {
    return { ok: false, code: 'UNKNOWN_SELLING_UNIT', error: `Selling unit must be one of: ${allowed.join(', ')}.` };
  }
  if (!allowed.includes(u)) {
    return {
      ok: false,
      code: 'SELLING_UNIT_NOT_CONFIGURED',
      error: u === 'BASE_UNIT'
        ? `This product is not sold in base units.`
        : `This product has no ${u.toLowerCase()} size configured. Set it on the product first (units per pack / packs per carton / cartons per pallet).`,
    };
  }

  const q = validateQuantity(quantity, { uom, allowFractional: u === 'BASE_UNIT' ? undefined : false });
  if (!q.ok) return q;

  const per = piecesPerUnit(product, u);
  if (u !== 'BASE_UNIT' && !(per > 0)) {
    return { ok: false, code: 'PACKING_NOT_CONFIGURED', error: `This product has no ${u.toLowerCase()} conversion set, so it cannot be sold by the ${u.toLowerCase()}.` };
  }

  const totalPieces = q.qty * per;
  // A carton count that overflows into absurdity is a data-entry error,
  // not a sale. Caught before it reaches stock.
  if (totalPieces > MAX_QUANTITY) {
    return { ok: false, code: 'TOTAL_PIECES_TOO_LARGE', error: `${describeCount(q.qty, u, product)} is more than ${MAX_QUANTITY.toLocaleString('en-NG')} ${unitLabel(uom, 2)}. Check the quantity.` };
  }

  return {
    ok: true,
    unit: u,
    count: q.qty,
    uom,
    unitsPerPack: ladderOf(product).unitsPerPack,
    packsPerCarton: ladderOf(product).packsPerCarton,
    cartonsPerPallet: ladderOf(product).cartonsPerPallet,
    piecesPerUnit: per,
    totalPieces: isFractionalUom(uom) ? Number(totalPieces.toFixed(MAX_QUANTITY_DECIMALS)) : Math.round(totalPieces),
  };
}

// "10 cartons x 10 packs x 10 pieces = 1,000 pieces" — the one sentence
// that appears on the goods-received note and the receipt, so the person
// signing for the delivery and the person auditing it later read the same
// arithmetic.
function describeCount(count, unit, product) {
  const n = (x) => Number(x).toLocaleString('en-NG');
  const l = ladderOf(product);
  const uom = product && product.base_unit ? product.base_unit : 'PIECE';
  const baseWord = unitLabel(uom, count).toLowerCase();
  const u = String(unit || 'BASE_UNIT').toUpperCase();
  if (u === 'BASE_UNIT') return `${n(count)} ${baseWord}`;
  if (u === 'PACK') return `${n(count)} pack${count === 1 ? '' : 's'} x ${n(l.unitsPerPack)} ${baseWord} = ${n(count * l.perPack)} ${baseWord}`;
  if (u === 'CARTON') {
    return `${n(count)} carton${count === 1 ? '' : 's'} x ${n(l.packsPerCarton)} packs x ${n(l.unitsPerPack)} ${baseWord} = ${n(count * l.perCarton)} ${baseWord}`;
  }
  return `${n(count)} pallet${count === 1 ? '' : 's'} x ${n(l.cartonsPerPallet)} cartons x ${n(l.packsPerCarton)} packs x ${n(l.unitsPerPack)} ${baseWord} = ${n(count * l.perPallet)} ${baseWord}`;
}

// Cost splitting. PharmaRidge kept FULL precision per piece and rounded
// only for display, because rounding 480,000/7,000 to 68.57 and
// multiplying back gives 479,990 — the stock would be valued ₦10 below
// what was paid, on every delivery, forever. That reasoning is domain-
// independent and is kept verbatim.
function splitTotalCost(totalCost, resolved) {
  if (!Number.isFinite(totalCost) || totalCost < 0) {
    return { ok: false, code: 'TOTAL_COST_INVALID', error: 'Enter the total amount paid for this line — the figure on the supplier invoice.' };
  }
  const { totalPieces, unitsPerPack, packsPerCarton, cartonsPerPallet, unit } = resolved;
  const perPiece = totalPieces > 0 ? totalCost / totalPieces : 0;
  return {
    ok: true,
    totalCost,
    costPerPiece: perPiece,
    costPerPack: unit === 'BASE_UNIT' ? null : perPiece * unitsPerPack,
    costPerCarton: (unit === 'CARTON' || unit === 'PALLET') ? perPiece * unitsPerPack * (packsPerCarton || 1) : null,
    costPerPallet: unit === 'PALLET' ? perPiece * unitsPerPack * (packsPerCarton || 1) * (cartonsPerPallet || 1) : null,
  };
}

// Validate the packing configuration itself when a product is created or
// edited. Rejecting it here beats discovering at goods-in that a "carton"
// was never defined.
function validatePacking({ units_per_pack, packs_per_carton, cartons_per_pallet }) {
  const upn = units_per_pack == null || units_per_pack === '' ? 1 : Number(units_per_pack);
  if (!Number.isFinite(upn) || upn < 1) return { ok: false, code: 'PACKING_INVALID', error: 'Units per pack must be a whole number of 1 or more.' };
  if (upn > MAX_UNITS_PER_PACK) return { ok: false, code: 'PACKING_INVALID', error: `Units per pack cannot exceed ${MAX_UNITS_PER_PACK.toLocaleString('en-NG')}.` };
  if (!Number.isInteger(upn)) return { ok: false, code: 'PACKING_INVALID', error: 'Units per pack must be a whole number.' };

  const check = (value, max, label, code) => {
    if (value == null || value === '') return { ok: true, value: null };
    const n = Number(value);
    if (!Number.isFinite(n) || n < 1) return { ok: false, code, error: `${label} must be a whole number of 1 or more.` };
    if (!Number.isInteger(n)) return { ok: false, code, error: `${label} must be a whole number.` };
    if (n > max) return { ok: false, code, error: `${label} cannot exceed ${max.toLocaleString('en-NG')}.` };
    return { ok: true, value: n };
  };

  const pc = check(packs_per_carton, MAX_PACKS_PER_CARTON, 'Packs per carton', 'PACKING_INVALID');
  if (!pc.ok) return pc;
  const cp = check(cartons_per_pallet, MAX_CARTONS_PER_PALLET, 'Cartons per pallet', 'PACKING_INVALID');
  if (!cp.ok) return cp;
  if (cp.value && !pc.value) {
    return { ok: false, code: 'PACKING_INVALID', error: 'A pallet is built from cartons — set packs per carton first.' };
  }
  return { ok: true, units_per_pack: upn, packs_per_carton: pc.value, cartons_per_pallet: cp.value };
}

module.exports = {
  BASE_UNITS, SELLING_UNITS, UNIT_CODES, FRACTIONAL_UNITS,
  MAX_UNITS_PER_PACK, MAX_PACKS_PER_CARTON, MAX_CARTONS_PER_PALLET, MAX_QUANTITY, MAX_QUANTITY_DECIMALS,
  getUnit, isUnit, isFractionalUom, unitLabel, unitAbbrev, isSellingUnit,
  validateQuantity, ladderOf, piecesPerUnit, resolveLine, describeCount,
  splitTotalCost, validatePacking,
};
'use strict';
