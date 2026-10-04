// =====================================================================
// shared/lib/receiving.js — UNIT-OF-MEASURE LADDER FOR RECEIVING & SELLING
// =====================================================================
//
// DECOUPLED FROM PHARMARIDGE: worker/src/lib/receiving.js. The mechanics are
// preserved exactly (they were hard-won — see the note about dividing
// ₦480,000 by 1,000 capsules) but two things changed:
//
//   1. A FOURTH rung: PALLET. Wholesale appliances, cement and beverages all
//      arrive palletised, and a receiving screen that cannot express
//      "4 pallets x 20 cartons x 12 pieces" makes the storekeeper do the
//      multiplication on a calculator. That is how 960 becomes 96.
//
//   2. The unit vocabulary is vertical-driven. A furniture store receives
//      SETS and ROLLS; a building-materials yard receives BAGS, LENGTHS and
//      TONNES. The ladder names are still fixed (BASE_UNIT/PACK/CARTON/PALLET)
//      because the STOCK is always decremented in base units, but what those
//      rungs are CALLED on screen comes from the product's own base unit and
//      the vertical's unit library.
//
// THE INVARIANT, stated once because everything else follows from it:
//
//   Stock is held, valued and decremented in BASE UNITS ONLY.
//   A pack or carton price is a SELLING convenience; underneath, selling one
//   carton of 12 always decrements 12 base units at the carton's per-piece
//   cost. There is no separate "carton stock" number to drift out of step.

'use strict';

const { round2, toKobo, fromKobo, allocateKobo } = require('./money');

const RECEIVE_UNITS = Object.freeze(['BASE_UNIT', 'PACK', 'CARTON', 'PALLET']);
const SELLING_UNITS = RECEIVE_UNITS;

// Sanity ceilings. These are not arbitrary: they are the point at which a
// typo becomes catastrophic. units_per_pack of 10,000 means someone typed an
// extra zero and every subsequent valuation is off by 10,000x.
const MAX_UNITS_PER_PACK = 5000;
const MAX_PACKS_PER_CARTON = 500;
const MAX_CARTONS_PER_PALLET = 200;

/**
 * How many BASE UNITS one of `unit` represents, given the product's ladder.
 * Returns null when the rung is not configured (a product with no carton
 * cannot be received by the carton).
 *
 * RUNGS ARE INDEPENDENT, NOT A STRICT CHAIN — and this is a deliberate
 * correction to the pharmacy model, which assumed pack ⊂ carton ⊂ pallet.
 * That assumption is false for most general retail:
 *
 *   a TV            unit -> carton (1 per carton) -> pallet (20 cartons)
 *                   there is NO pack rung, and the carton still exists
 *   cement          bag  -> (no pack, no carton) -> pallet? no, a truck
 *   biscuits        piece -> pack (12) -> carton (24 packs) -> pallet (40)
 *   a sofa          piece -> set (a 3+2+1 is one SET of 6 pieces)
 *
 * So each rung carries its own multiplier, and an intermediate rung may simply
 * be absent. `packs_per_carton` is still honoured for backwards-compatible
 * data (it is multiplied by units_per_pack to derive the carton multiplier),
 * but `units_per_carton` and `units_per_pallet` may be set directly and win.
 */
function piecesPerUnit(product, unit) {
  const m = rungMultipliers(product);
  switch (String(unit || '').toUpperCase()) {
    case 'BASE_UNIT': return 1;
    case 'PACK': return m.pack;
    case 'CARTON': return m.carton;
    case 'PALLET': return m.pallet;
    default: return null;
  }
}

/**
 * Resolve a product's ladder into concrete multipliers (or null per rung).
 * Single source of truth — receiving, selling, the POS rung picker and the
 * product form all read this, so they cannot disagree about what a carton is.
 */
function rungMultipliers(product) {
  const p = product || {};
  const upo = Math.floor(Number(p.units_per_pack) || 1);

  // A carton's size: explicit units_per_carton wins; otherwise derive from
  // packs_per_carton (which only means something when there IS a pack rung).
  let carton = Math.floor(Number(p.units_per_carton) || 0);
  if (!(carton > 1)) {
    const ppc = Math.floor(Number(p.packs_per_carton) || 0);
    carton = (upo > 1 && ppc > 1) ? upo * ppc : 0;
  }

  // A pallet's size: explicit units_per_pallet wins; otherwise derive from
  // cartons_per_pallet over whatever the carton turned out to be.
  let pallet = Math.floor(Number(p.units_per_pallet) || 0);
  if (!(pallet > 1)) {
    const cpp = Math.floor(Number(p.cartons_per_pallet) || 0);
    pallet = (carton > 1 && cpp > 1) ? carton * cpp : 0;
  }

  return {
    pack: upo > 1 ? upo : null,
    carton: carton > 1 ? carton : null,
    pallet: pallet > 1 ? pallet : null,
    unitsPerPack: upo,
  };
}

/** Human label for a rung, using the product's own base unit word. */
function rungLabel(product, unit) {
  const base = String((product && product.base_unit) || 'piece').toLowerCase();
  const plural = base.endsWith('s') ? base : `${base}s`;
  switch (String(unit || '').toUpperCase()) {
    case 'BASE_UNIT': return plural;
    case 'PACK': return 'pack';
    case 'CARTON': return 'carton';
    case 'PALLET': return 'pallet';
    default: return plural;
  }
}

/**
 * Validate + resolve ONE receiving line.
 *
 * Returns { ok:false, code, error } rather than throwing, because the
 * receiving screen shows per-line errors inline while the operator keeps
 * typing the rest of the delivery note.
 */
function resolveReceiveLine({ unit, count, product }) {
  const u = String(unit || '').toUpperCase();
  if (!RECEIVE_UNITS.includes(u)) {
    return { ok: false, code: 'UNKNOWN_UNIT', error: `Unknown receiving unit "${unit}".` };
  }

  const upo = Math.floor(Number(product && product.units_per_pack) || 1);
  const ppc = Math.floor(Number(product && product.packs_per_carton) || 0);
  const cpp = Math.floor(Number(product && product.cartons_per_pallet) || 0);

  if (upo < 1 || upo > MAX_UNITS_PER_PACK) {
    return { ok: false, code: 'BAD_PACK_SIZE', error: `Units per pack must be between 1 and ${MAX_UNITS_PER_PACK}.` };
  }
  if (ppc < 0 || ppc > MAX_PACKS_PER_CARTON) {
    return { ok: false, code: 'BAD_CARTON_SIZE', error: `Packs per carton must be between 0 and ${MAX_PACKS_PER_CARTON}.` };
  }
  if (cpp < 0 || cpp > MAX_CARTONS_PER_PALLET) {
    return { ok: false, code: 'BAD_PALLET_SIZE', error: `Cartons per pallet must be between 0 and ${MAX_CARTONS_PER_PALLET}.` };
  }

  // A rung that the product does not define cannot be received. Saying
  // "this product has no carton configured" is far more useful than
  // silently treating a carton as a single piece.
  const pieces = piecesPerUnit(product, u);
  if (pieces == null) {
    const need = u === 'PACK' ? 'units_per_pack'
      : u === 'CARTON' ? 'units_per_carton (or packs_per_carton)'
        : 'units_per_pallet (or cartons_per_pallet)';
    return {
      ok: false, code: 'UNIT_NOT_CONFIGURED',
      error: `"${product ? product.name : 'This product'}" has no ${u.toLowerCase()} size configured. Set ${need} on the product, or receive in ${rungLabel(product, 'BASE_UNIT')}.`,
    };
  }

  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, code: 'BAD_COUNT', error: 'Enter how many you received — a whole number greater than zero.' };
  }
  if (!Number.isInteger(n)) {
    return { ok: false, code: 'FRACTIONAL_COUNT', error: `You cannot receive ${n} ${u.toLowerCase()}s. Use ${rungLabel(product, 'BASE_UNIT')} for a part quantity.` };
  }

  const totalPieces = n * pieces;
  if (totalPieces > 100000000) {
    return { ok: false, code: 'QUANTITY_TOO_LARGE', error: 'That quantity is implausibly large — check the pack/carton sizes.' };
  }

  return {
    ok: true,
    unit: u,
    count: n,
    unitsPerPack: upo,
    packsPerCarton: ppc,
    cartonsPerPallet: cpp,
    piecesPerUnit: pieces,
    totalPieces,
  };
}

/**
 * Split a line's TOTAL COST (the figure on the supplier's invoice) into a
 * per-piece cost at FULL PRECISION.
 *
 * WHY FULL PRECISION, and why this is not `round2(total / pieces)`:
 *   ₦480,000 for 7,000 pieces is ₦68.571428... each. Rounding to ₦68.57 and
 *   multiplying back gives ₦479,990 — the stock is valued ₦10 below what was
 *   actually paid, on every delivery, forever, and the GL will not balance
 *   against the bank statement.
 *
 *   The rule: VALUATION keeps full precision; DISPLAY rounds. The per-piece
 *   cost is stored as a REAL and every downstream figure (stock value, COGS,
 *   margin) is computed from it, so the error never enters the books.
 *
 * Also returns the per-pack / per-carton / per-pallet costs, because a
 * goods-received note that shows only a per-piece figure for a carton delivery
 * is unreadable to the person checking the truck.
 */
function splitTotalCost(totalCost, resolved) {
  const tc = Number(totalCost);
  if (!Number.isFinite(tc) || tc < 0) {
    return { ok: false, code: 'TOTAL_COST_INVALID', error: 'Enter the total amount paid for this line — the figure on the supplier invoice.' };
  }
  if (!resolved || !resolved.ok) {
    return { ok: false, code: 'LINE_UNRESOLVED', error: 'Resolve the quantity before splitting the cost.' };
  }
  const { totalPieces, unitsPerPack, piecesPerUnit, unit } = resolved;
  const perPiece = totalPieces > 0 ? tc / totalPieces : 0;
  const packMult = unitsPerPack > 1 ? unitsPerPack : 1;

  return {
    ok: true,
    totalCost: tc,
    totalPieces,
    costPerPiece: perPiece,                       // FULL precision — do not round
    costPerPack: unit === 'BASE_UNIT' ? null : perPiece * packMult,
    costPerCarton: ['CARTON', 'PALLET'].includes(unit) ? perPiece * (piecesPerUnit || 1) : null,
    costPerPallet: unit === 'PALLET' ? perPiece * (piecesPerUnit || 1) : null,
    // Display-only rounded figures for the GRN.
    display: {
      costPerPiece: round2(perPiece),
      costPerPack: perPiece ? round2(perPiece * packMult) : null,
    },
  };
}

/**
 * One human-readable sentence for the receive screen and the goods-received
 * note, e.g. "4 pallets x 20 cartons x 12 packs x 10 pieces = 9,600 pieces".
 */
function describeReceipt(resolved) {
  const n = (x) => Number(x).toLocaleString('en-NG');
  const { unit, count, unitsPerPack, packsPerCarton, cartonsPerPallet, totalPieces, piecesPerUnit } = resolved;
  const base = `${n(totalPieces)} piece${totalPieces === 1 ? '' : 's'}`;
  if (unit === 'BASE_UNIT') return base;
  if (unit === 'PACK') return `${n(count)} pack${count === 1 ? '' : 's'} x ${n(unitsPerPack)} = ${base}`;
  if (unit === 'CARTON') {
    if (packsPerCarton > 0 && unitsPerPack > 1) {
      return `${n(count)} carton${count === 1 ? '' : 's'} x ${n(packsPerCarton)} packs x ${n(unitsPerPack)} = ${base}`;
    }
    return `${n(count)} carton${count === 1 ? '' : 's'} x ${n(piecesPerUnit || (totalPieces / count))} = ${base}`;
  }
  if (unit === 'PALLET') {
    if (cartonsPerPallet > 0 && packsPerCarton > 0 && unitsPerPack > 1) {
      return `${n(count)} pallet${count === 1 ? '' : 's'} x ${n(cartonsPerPallet)} cartons x ${n(packsPerCarton)} packs x ${n(unitsPerPack)} = ${base}`;
    }
    return `${n(count)} pallet${count === 1 ? '' : 's'} x ${n(piecesPerUnit || (totalPieces / count))} = ${base}`;
  }
  return base;
}

// ---------------------------------------------------------------------
// SELLING-SIDE CONVERSION
// ---------------------------------------------------------------------

/**
 * Convert a SELLING quantity expressed at some rung into base units, plus the
 * per-base-unit price implied by the rung price the operator entered.
 *
 * This is the function that lets a cashier sell "2 cartons" at a carton price
 * while stock, revenue and COGS all remain denominated in base units.
 *
 * The price split uses allocateKobo so the base-unit prices of the N pieces
 * SUM EXACTLY to the rung price paid — no kobo is invented or lost, which is
 * what keeps `sale_items.line_total === sum(base quantities x base price)`
 * true on the receipt and in the GL.
 */
function resolveSellingLine({ product, unit, count, pricePerRung }) {
  const resolved = resolveReceiveLine({ unit, count, product });
  if (!resolved.ok) return resolved;

  const { totalPieces, piecesPerUnit } = resolved;
  const rungTotalKobo = toKobo(pricePerRung) * resolved.count;

  // Equal split across the pieces in this rung, allocated so it balances.
  const perPieceKoboList = allocateKobo(rungTotalKobo, new Array(totalPieces).fill(1));
  const perPieceKobo = totalPieces > 0 ? perPieceKoboList[0] : 0;

  return {
    ok: true,
    ...resolved,
    rungPrice: round2(Number(pricePerRung) || 0),
    rungTotalKobo,
    rungTotal: fromKobo(rungTotalKobo),
    baseQuantity: totalPieces,
    // Stored at full precision for valuation/reporting; the receipt shows
    // the rung price the customer actually agreed to.
    pricePerBaseUnit: totalPieces > 0 ? rungTotalKobo / totalPieces / 100 : 0,
    pricePerBaseUnitKobo: perPieceKobo,
    piecesPerUnit,
  };
}

/**
 * Ladder display for a product card: shows each rung's size and lets the POS
 * offer rung prices without the operator doing arithmetic.
 */
function ladder(product) {
  const m = rungMultipliers(product);
  const base = String((product && product.base_unit) || 'piece');
  return [
    { unit: 'BASE_UNIT', label: base, pieces: 1, configured: true },
    { unit: 'PACK', label: 'Pack', pieces: m.pack || 1, configured: m.pack != null },
    { unit: 'CARTON', label: 'Carton', pieces: m.carton || 1, configured: m.carton != null },
    { unit: 'PALLET', label: 'Pallet', pieces: m.pallet || 1, configured: m.pallet != null },
  ];
}

/**
 * Validate a product's UOM ladder as a whole. Called on product create/update
 * so a broken ladder is caught when the product is saved, not when a cashier
 * tries to sell a carton of it six weeks later.
 */
function validateLadder(product) {
  const p = product || {};
  const upo = Number(p.units_per_pack != null ? p.units_per_pack : 1);
  const upc = p.units_per_carton != null && p.units_per_carton !== '' ? Number(p.units_per_carton) : null;
  const ppc = p.packs_per_carton != null && p.packs_per_carton !== '' ? Number(p.packs_per_carton) : null;
  const upp = p.units_per_pallet != null && p.units_per_pallet !== '' ? Number(p.units_per_pallet) : null;
  const cpp = p.cartons_per_pallet != null && p.cartons_per_pallet !== '' ? Number(p.cartons_per_pallet) : null;
  const errors = [];

  if (!Number.isInteger(upo) || upo < 1) errors.push('units_per_pack must be a whole number of 1 or more.');
  else if (upo > MAX_UNITS_PER_PACK) errors.push(`units_per_pack cannot exceed ${MAX_UNITS_PER_PACK}.`);

  if (ppc != null) {
    if (!Number.isInteger(ppc) || ppc < 1) errors.push('packs_per_carton must be a whole number of 1 or more, or left blank.');
    else if (ppc > MAX_PACKS_PER_CARTON) errors.push(`packs_per_carton cannot exceed ${MAX_PACKS_PER_CARTON}.`);
  }

  if (upc != null) {
    if (!Number.isInteger(upc) || upc < 1) errors.push('units_per_carton must be a whole number of 1 or more, or left blank.');
    if (upo > 1 && upc <= upo) errors.push('units_per_carton must be greater than units_per_pack.');
  }

  if (cpp != null) {
    if (!Number.isInteger(cpp) || cpp < 1) errors.push('cartons_per_pallet must be a whole number of 1 or more, or left blank.');
    else if (cpp > MAX_CARTONS_PER_PALLET) errors.push(`cartons_per_pallet cannot exceed ${MAX_CARTONS_PER_PALLET}.`);
  }

  if (upp != null) {
    if (!Number.isInteger(upp) || upp < 1) errors.push('units_per_pallet must be a whole number of 1 or more, or left blank.');
    const cartonPieces = upc != null ? upc : (ppc != null && upo > 1 ? ppc * upo : null);
    if (cartonPieces != null && cartonPieces > 0) {
      if (upp % cartonPieces !== 0 || upp <= cartonPieces) {
        errors.push('units_per_pallet must be an exact multiple greater than carton size.');
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
  RECEIVE_UNITS, SELLING_UNITS,
  MAX_UNITS_PER_PACK, MAX_PACKS_PER_CARTON, MAX_CARTONS_PER_PALLET,
  piecesPerUnit, rungLabel, resolveReceiveLine, splitTotalCost, describeReceipt,
  resolveSellingLine, ladder, validateLadder,
};
