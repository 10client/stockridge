// =====================================================================
// StockRidge — UNITS OF MEASURE (UOM) & PACK NESTING
// =====================================================================
// Reconstructed from PharmaRidge's domain/receiving.js, generalised.
//
// THE PROBLEM THIS SOLVES
// -----------------------
// Nigerian retail buys and sells in DIFFERENT units for the same product.
// A wholesaler receives 20 cartons of chargers, each carton holding 24
// packs of 2 — that is 960 pieces on the shelf — and then sells some by
// the piece, some by the pack and some by the carton. Stock must ALWAYS
// be tracked in base pieces (one number, one truth), while pricing and
// selling happen at whichever level the counter is working at.
//
// PharmaRidge solved this with a fixed three-level nest (PIECE -> PACK ->
// CARTON) driven by products.units_per_pack and products.packs_per_carton.
// That is exactly right for medicine and exactly wrong for a building
// materials depot that receives a TRUCKLOAD of 1,000 bags of cement.
//
// STOCKRIDGE'S GENERALISATION
// ---------------------------
// A 4-level nest with a conversion factor at each step:
//
//     PIECE  --(units_per_pack)-->  PACK  --(packs_per_carton)-->  CARTON
//                                                        --(cartons_per_pallet)--> PALLET
//
// Each level is OPTIONAL: a product that arrives loose sets
// units_per_pack = 1 and everything above collapses to pieces. Nothing
// else in the system has to know or care — resolveReceiveLine() returns
// `totalPieces` and that is the ONLY number stock ever moves by.
//
// TWO RULES CARRIED OVER UNCHANGED, because they were each a real bug:
//
//  1. TOTAL-FIRST COSTING. splitTotalCost() takes the amount actually
//     paid for the whole line (the figure on the supplier's invoice) and
//     derives the per-piece cost from it — never the reverse. Asking a
//     storekeeper to divide ₦480,000 by 1,000 and type 480 is asking them
//     to do the system's job, and a decimal slip there silently corrupts
//     every margin that product ever reports.
//
//  2. NEVER ROUND THE PER-PIECE COST. ₦480,000 / 7,000 pieces =
//     ₦68.5714…; rounding to ₦68.57 and multiplying back gives ₦479,990 —
//     the stock would be valued ₦10 below what was paid, on every
//     delivery, forever. Full precision is kept for valuation; only the
//     DISPLAY rounds.
//
// Pure functions, no I/O, no Node APIs — runs on both backends.
// =====================================================================

const { round2 } = require('./money');

// Ordered from the largest container to the smallest. Order matters: it is
// what lets "you cannot sell by the carton if you did not receive cartons"
// be checked by simple position comparison.
const UNIT_LADDER = Object.freeze(['PALLET', 'CARTON', 'PACK', 'PIECE']);

// Vertical-specific receive/sell unit names (BAG, BUNDLE, TRUCKLOAD,
// LENGTH, TONNE…) are ALIASES onto this ladder. A "bag of cement" is a
// PIECE; a "bundle of 10 rods" is a PACK; a "truckload" is a PALLET. This
// keeps every conversion in the codebase a single four-step ladder while
// the SCREENS still say "bag" and "truckload", which is what the user
// actually reads off the delivery note.
const UNIT_ALIASES = Object.freeze({
  PIECE: 'PIECE', UNIT: 'PIECE', EACH: 'PIECE', EA: 'PIECE', BAG: 'PIECE',
  SACHET: 'PIECE', BOTTLE: 'PIECE', TIN: 'PIECE', SHEET: 'PIECE', LENGTH: 'PIECE',
  PACK: 'PACK', BOX: 'PACK', DOZEN: 'PACK', STRIP: 'PACK', BUNDLE: 'PACK',
  INNER: 'PACK', MULTI_PACK: 'PACK',
  CARTON: 'CARTON', CASE: 'CARTON', CARTONS: 'CARTON',
  PALLET: 'PALLET', CRATE: 'PALLET', TRUCKLOAD: 'PALLET', TRUCK: 'PALLET',
  CONTAINER: 'PALLET', TONNE: 'PALLET',
});

// Plausibility ceilings on the nesting factors. These are NOT arbitrary:
// they exist so that a fat-fingered "240" instead of "24" cannot quietly
// inflate a stock receipt by a factor of ten, which is the single most
// destructive typo available on a goods-received screen.
const MAX_UNITS_PER_PACK = 10000;
const MAX_PACKS_PER_CARTON = 10000;
const MAX_CARTONS_PER_PALLET = 10000;

const RECEIVE_UNITS = Object.freeze(['PALLET', 'CARTON', 'PACK', 'PIECE']);
const SELLING_UNITS = Object.freeze(['CARTON', 'PACK', 'PIECE']);

// The unit_type value stored on sale_items / stock rows.
const UNIT_TYPES = Object.freeze(['BASE_UNIT', 'PACK', 'CARTON']);

function canonicalUnit(unit) {
  if (!unit) return null;
  const key = String(unit).trim().toUpperCase().replace(/[\s-]+/g, '_');
  return UNIT_ALIASES[key] || (UNIT_LADDER.includes(key) ? key : null);
}

function isPositiveInt(n) {
  return Number.isInteger(Number(n)) && Number(n) > 0;
}

// How many base pieces are in ONE of the given unit, for a product with
// this nesting. The whole module exists to make this one number reliable.
function piecesPerUnit(unit, { unitsPerPack = 1, packsPerCarton = 1, cartonsPerPallet = 1 } = {}) {
  const u = canonicalUnit(unit) || 'PIECE';
  const upp = Number(unitsPerPack) > 0 ? Number(unitsPerPack) : 1;
  const ppc = Number(packsPerCarton) > 0 ? Number(packsPerCarton) : 1;
  const cpp = Number(cartonsPerPallet) > 0 ? Number(cartonsPerPallet) : 1;
  switch (u) {
    case 'PIECE': return 1;
    case 'PACK': return upp;
    case 'CARTON': return upp * ppc;
    case 'PALLET': return upp * ppc * cpp;
    default: return 1;
  }
}

// Inverse of the above — how many whole cartons (and the remainder) are in
// N pieces. Used by the POS to show "3 cartons + 5 pieces" and by
// stocktake sheets so a counter can tick cartons rather than count units.
function decomposePieces(totalPieces, nesting) {
  const perPallet = piecesPerUnit('PALLET', nesting);
  const perCarton = piecesPerUnit('CARTON', nesting);
  const perPack = piecesPerUnit('PACK', nesting);
  let rest = Math.max(0, Math.floor(Number(totalPieces) || 0));

  const pallets = perPallet > perCarton ? Math.floor(rest / perPallet) : 0;
  rest -= pallets * perPallet;
  const cartons = perCarton > perPack ? Math.floor(rest / perCarton) : 0;
  rest -= cartons * perCarton;
  const packs = perPack > 1 ? Math.floor(rest / perPack) : 0;
  rest -= packs * perPack;

  return { pallets, cartons, packs, pieces: rest };
}

// ---------------------------------------------------------------------
// resolveReceiveLine — validate ONE goods-received line
// ---------------------------------------------------------------------
// Returns { ok:true, ...resolved } or { ok:false, code, error } with a
// sentence a storekeeper can act on. Error CODES are stable strings the
// frontend switches on; error TEXT is what the human reads.
//
// The nesting questions are asked CONDITIONALLY. Requiring "pieces per
// pack" when the delivery arrived as loose pieces is a question with no
// meaning, and a form that asks it teaches the user to type anything.
function resolveReceiveLine(line, opts = {}) {
  const label = opts.label || 'This line';

  if (!line || typeof line !== 'object') {
    return { ok: false, code: 'LINE_MISSING', error: `${label}: no receiving details were provided.` };
  }

  const unit = canonicalUnit(opts.receiveUnit || line.receive_unit || line.unit || 'PIECE');
  if (!unit || !RECEIVE_UNITS.includes(unit)) {
    return {
      ok: false,
      code: 'RECEIVE_UNIT_INVALID',
      error: `${label}: choose how the delivery arrived — ${RECEIVE_UNITS.join(', ')}.`,
    };
  }

  const count = Number(line.quantity_received != null ? line.quantity_received : line.quantity);
  if (!Number.isFinite(count) || count <= 0) {
    return { ok: false, code: 'QUANTITY_INVALID', error: `${label}: enter how many ${unit.toLowerCase()}s arrived (a positive number).` };
  }
  if (!Number.isInteger(count)) {
    return { ok: false, code: 'QUANTITY_NOT_WHOLE', error: `${label}: you cannot receive a fraction of a ${unit.toLowerCase()}. Enter a whole number.` };
  }

  // ---- nesting factors, only where the chosen unit needs them --------
  let unitsPerPack = 1;
  let packsPerCarton = 1;
  let cartonsPerPallet = 1;

  if (unit === 'PACK' || unit === 'CARTON' || unit === 'PALLET') {
    unitsPerPack = Number(line.units_per_pack);
    if (!isPositiveInt(unitsPerPack)) {
      return { ok: false, code: 'UNITS_PER_PACK_REQUIRED', error: `${label}: say how many pieces are in one pack.` };
    }
    if (unitsPerPack > MAX_UNITS_PER_PACK) {
      return {
        ok: false, code: 'UNITS_PER_PACK_IMPLAUSIBLE',
        error: `${label}: ${unitsPerPack.toLocaleString('en-NG')} pieces in a pack looks like a mistake. Check for an extra digit.`,
      };
    }
  }

  if (unit === 'CARTON' || unit === 'PALLET') {
    packsPerCarton = Number(line.packs_per_carton);
    if (!isPositiveInt(packsPerCarton)) {
      return { ok: false, code: 'PACKS_PER_CARTON_REQUIRED', error: `${label}: say how many packs are in one carton.` };
    }
    if (packsPerCarton > MAX_PACKS_PER_CARTON) {
      return {
        ok: false, code: 'PACKS_PER_CARTON_IMPLAUSIBLE',
        error: `${label}: ${packsPerCarton.toLocaleString('en-NG')} packs in a carton looks like a mistake. Check for an extra digit.`,
      };
    }
  }

  if (unit === 'PALLET') {
    cartonsPerPallet = Number(line.cartons_per_pallet);
    if (!isPositiveInt(cartonsPerPallet)) {
      return { ok: false, code: 'CARTONS_PER_PALLET_REQUIRED', error: `${label}: say how many cartons are on one pallet/truckload.` };
    }
    if (cartonsPerPallet > MAX_CARTONS_PER_PALLET) {
      return {
        ok: false, code: 'CARTONS_PER_PALLET_IMPLAUSIBLE',
        error: `${label}: ${cartonsPerPallet.toLocaleString('en-NG')} cartons on a pallet looks like a mistake. Check for an extra digit.`,
      };
    }
  }

  const nesting = { unitsPerPack, packsPerCarton, cartonsPerPallet };
  const piecesPerReceiveUnit = piecesPerUnit(unit, nesting);
  const totalPieces = count * piecesPerReceiveUnit;

  // ---- the selling unit ------------------------------------------------
  // How the counter will sell it is NOT required to match how it arrived —
  // buying by the carton and selling by the piece IS the business. But it
  // must be a unit the delivery can actually be broken into.
  const pattern = canonicalUnit(line.selling_pattern || opts.defaultSellingPattern || 'PIECE');
  if (!pattern || !SELLING_UNITS.includes(pattern)) {
    return {
      ok: false, code: 'SELLING_PATTERN_INVALID',
      error: `${label}: choose how this product is sold — ${SELLING_UNITS.join(', ')}.`,
    };
  }
  const receivedRank = UNIT_LADDER.indexOf(unit);
  const sellRank = UNIT_LADDER.indexOf(pattern);
  if (sellRank < receivedRank) {
    // e.g. selling by PALLET when it arrived as CARTONs: the system would
    // not know how many pieces a pallet holds.
    return {
      ok: false, code: 'SELLING_PATTERN_UNREACHABLE',
      error: `${label}: you cannot sell by the ${pattern.toLowerCase()} when the delivery was received as ${unit.toLowerCase()}s — the system would not know how many pieces one holds.`,
    };
  }

  return {
    ok: true,
    unit,
    count,
    unitsPerPack,
    packsPerCarton,
    cartonsPerPallet,
    piecesPerReceiveUnit,
    totalPieces,
    sellingPattern: pattern,
    nesting,
  };
}

// ---------------------------------------------------------------------
// splitTotalCost — TOTAL-FIRST costing (see rule 1 in the header)
// ---------------------------------------------------------------------
function splitTotalCost(totalCost, resolved) {
  if (!Number.isFinite(Number(totalCost)) || Number(totalCost) < 0) {
    return {
      ok: false, code: 'TOTAL_COST_INVALID',
      error: 'Enter the total amount paid for this line — the figure on the supplier invoice.',
    };
  }
  const cost = Number(totalCost);
  const { totalPieces, unitsPerPack, packsPerCarton, cartonsPerPallet, unit } = resolved;
  const perPiece = totalPieces > 0 ? cost / totalPieces : 0; // FULL PRECISION — never round2()

  return {
    ok: true,
    totalCost: round2(cost),
    costPerPiece: perPiece,
    costPerPack: unit === 'PIECE' ? null : perPiece * unitsPerPack,
    costPerCarton: unit === 'PIECE' || unit === 'PACK' ? null : perPiece * unitsPerPack * packsPerCarton,
    costPerPallet: unit !== 'PALLET' ? null : perPiece * unitsPerPack * packsPerCarton * cartonsPerPallet,
  };
}

// One human-readable sentence for the receive screen and the goods-received
// note. It must READ as a multiplication that equals the total, because a
// GRN the storekeeper cannot check against the truck is a GRN that hides a
// short delivery:
//
//   "20 cartons x 2 packs x 24 pieces = 960 pieces"
//    ^count    ^packs/carton ^pieces/pack
//
// PharmaRidge rendered this as "N cartons x <packs_per_carton> packs x
// <units_per_pack> pieces", which happens to read correctly only when the
// two factors are equal (its demo data used 10 x 10). With 2 packs holding
// 24 pieces each, that order prints "x 24 packs x 2 pieces" — the right
// total, the wrong description, and a storekeeper who cannot verify it.
// The factors are therefore named explicitly here so the sentence cannot
// silently invert.
function describeReceipt(resolved) {
  const n = (x) => Number(x).toLocaleString('en-NG');
  const { unit, count, unitsPerPack, packsPerCarton, cartonsPerPallet, totalPieces } = resolved;
  const plural = (c, w) => `${n(c)} ${w}${c === 1 ? '' : 's'}`;

  if (unit === 'PIECE') return plural(count, 'piece');
  if (unit === 'PACK') return `${plural(count, 'pack')} x ${n(unitsPerPack)} pieces = ${n(totalPieces)} pieces`;
  if (unit === 'CARTON') {
    return `${plural(count, 'carton')} x ${n(packsPerCarton)} packs x ${n(unitsPerPack)} pieces = ${n(totalPieces)} pieces`;
  }
  return `${plural(count, 'pallet')} x ${n(cartonsPerPallet)} cartons x ${n(packsPerCarton)} packs x ${n(unitsPerPack)} pieces = ${n(totalPieces)} pieces`;
}

// Convert a quantity expressed in one unit into another, for the same
// product. Returns null when the conversion is not defined by the nest
// (e.g. asking for pallets on a product that only has pack/carton data)
// rather than guessing — a guessed conversion silently misprices stock.
function convertQuantity(qty, fromUnit, toUnit, nesting) {
  const from = canonicalUnit(fromUnit);
  const to = canonicalUnit(toUnit);
  if (!from || !to) return null;
  const pieces = Number(qty) * piecesPerUnit(from, nesting);
  const perTarget = piecesPerUnit(to, nesting);
  if (!perTarget) return null;
  const out = pieces / perTarget;
  return Number.isInteger(out) ? out : round2(out);
}

// Weight/length-based stock (iron rods by the tonne, cable by the metre).
// These are NOT part of the pack ladder — they are a measured quantity with
// its own tolerance, because a weighbridge ticket and a counted bundle
// disagree in the real world and the system must say which one won.
const MEASURED_UNITS = Object.freeze(['KG', 'TONNE', 'METRE', 'LITRE', 'GALLON']);

function isMeasuredUnit(unit) {
  const u = String(unit || '').trim().toUpperCase();
  return MEASURED_UNITS.includes(u) || u === 'TON' || u === 'M' || u === 'L';
}

// Tolerance for counted-vs-measured variance on weighing stock. 2% is the
// practical floor for a truck of iron rods: below that, every delivery
// raises a variance that nobody can resolve and the feature gets ignored,
// which is worse than a slightly loose tolerance.
const WEIGHING_TOLERANCE_PERCENT = 2;

module.exports = {
  UNIT_LADDER,
  UNIT_ALIASES,
  UNIT_TYPES,
  RECEIVE_UNITS,
  SELLING_UNITS,
  MEASURED_UNITS,
  MAX_UNITS_PER_PACK,
  MAX_PACKS_PER_CARTON,
  MAX_CARTONS_PER_PALLET,
  WEIGHING_TOLERANCE_PERCENT,
  canonicalUnit,
  piecesPerUnit,
  decomposePieces,
  convertQuantity,
  resolveReceiveLine,
  splitTotalCost,
  describeReceipt,
  isMeasuredUnit,
};
