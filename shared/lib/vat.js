// =====================================================================
// shared/lib/vat.js — NIGERIAN VALUE ADDED TAX
// =====================================================================
//
// DECOUPLED FROM PHARMARIDGE: glService.postSale()'s inline VAT split and
// client_settings.vat_enabled / vat_rate_percent. The MODEL is unchanged
// because it was a deliberate client decision, and it is the right model for
// Nigerian retail:
//
//   VAT-INCLUSIVE PRICING. Enabling VAT does NOT increase what the customer
//   pays at the counter — shelf prices in Nigeria already include VAT. VAT is
//   EXTRACTED from the existing total for reporting and remittance only.
//
//   This matters enormously in a general store. A furniture shop that turned
//   on VAT and watched every sofa price rise 7.5% overnight would lose the
//   room. The extraction model means compliance is switchable without
//   repricing.
//
// RATE: 7.5% is the FIRS standard rate. It is DATA (client_settings), never a
// constant in code, so a rate change is a settings edit — not a deploy.
//
// EXEMPT / RELIEF CATEGORIES: VAT is not chargeable on everything. Under the
// VAT Act (as amended by the Finance Acts) the following are EXEMPT, and a
// general merchandise store will very often carry some of them:
//   * basic food items (unprocessed)
//   * books and other educational materials
//   * baby products (diapers, formula, baby food)
//   * pharmaceuticals and medical equipment (relevant to the wholesale vertical)
//   * commercial vehicles and their parts
//   * agricultural inputs (seeds, fertiliser, agro-chemicals)
//   * rent (residential)
//
// StockRidge models this as a per-CATEGORY flag (vat_exempt) on the vertical
// profile plus a per-PRODUCT override, so the POS extracts VAT only on the
// chargeable part of a mixed basket. A basket of a TV + a textbook + a bag of
// rice charges VAT on the TV alone. Getting this wrong in either direction is
// a real exposure: over-charging is a consumer-protection complaint,
// under-charging is a FIRS assessment with penalties.

'use strict';

const { round2, toKobo, fromKobo, allocateKobo, extractVat } = require('./money');

const DEFAULT_VAT_RATE_PERCENT = 7.5;

// Categories that ship VAT-exempt in the profiles. Keyed by category code so
// a vertical can inherit the treatment without each product being flagged.
const EXEMPT_CATEGORY_CODES = Object.freeze(new Set([
  // wholesale / general merchandise
  'FOOD_PROVISIONS',     // unprocessed basic food items
  'BABY_PRODUCTS',       // diapers, formula, baby food
  'AGRO_INPUTS',         // seeds, fertiliser, agro-chemicals
  'STATIONERY',          // books & educational materials (paper component)
  // building materials: not exempt as a class, but two sub-cases are relief-
  // bearing in practice; left chargeable by default and flagged for the owner.
]));

// Products whose category is chargeable but which are themselves exempt —
// matched by an explicit per-product flag, never by name guessing.
function isExempt(opts = {}) {
  const { product, categoryCode, category, vatExemptOverride } = opts;
  if (vatExemptOverride != null) return !!vatExemptOverride;
  if (product && product.vat_exempt != null) return !!product.vat_exempt;
  if (opts.vat_exempt != null) return !!opts.vat_exempt;
  const code = String(categoryCode || category || (product && (product.category_code || product.category)) || opts.category_id || '').toUpperCase();
  return EXEMPT_CATEGORY_CODES.has(code);
}

/**
 * Compute the VAT position for a whole SALE from its already-priced lines.
 *
 * Takes lines that have been through pricing.priceLine() (so discounts are
 * already applied) and splits the chargeable subtotal from the exempt
 * subtotal, then extracts VAT from the chargeable part ONLY.
 *
 * INVARIANTS the caller's CHECK constraints rely on:
 *   total            === chargeable + exempt            (exact, in kobo)
 *   vat              === total - net                    (by subtraction)
 *   net              === chargeable_net + exempt
 *   sum(line.vat)    === vat                            (allocated, not summed
 *                                                        from independently
 *                                                        rounded line splits)
 *
 * That last one is the trap: extracting VAT per line and rounding each line
 * independently does NOT sum to extracting VAT once over the total. Over 12
 * lines it can be out by several kobo, and a VAT return that does not foot to
 * the sales ledger is worse than no VAT return. So: compute the sale-level
 * figure first, then ALLOCATE it to lines with allocateKobo weighted by each
 * line's chargeable net.
 */
function computeSaleVat({ lines, vatEnabled, vatRatePercent }) {
  const enabled = !!vatEnabled;
  const rate = Number(vatRatePercent);
  const r = Number.isFinite(rate) && rate >= 0 && rate <= 100 ? rate : DEFAULT_VAT_RATE_PERCENT;

  const norm = (lines || []).map((l) => ({
    ...l,
    netKobo: Number.isFinite(l.netKobo) ? Math.round(l.netKobo) : toKobo(l.net || 0),
    exempt: isExempt(l),
  }));

  if (!enabled || r === 0) {
    // VAT off: the whole total is net, and every line records vat 0 so the
    // ledger columns are populated rather than NULL (NULLs make SUM() report
    // misleading blanks in exports).
    const totalKobo = norm.reduce((a, l) => a + l.netKobo, 0);
    return {
      vatEnabled: false,
      vatRatePercent: r,
      totalKobo, total: fromKobo(totalKobo),
      chargeableKobo: totalKobo, chargeable: fromKobo(totalKobo),
      exemptKobo: 0, exempt: 0,
      netKobo: totalKobo, net: fromKobo(totalKobo),
      vatKobo: 0, vat: 0,
      lines: norm.map((l) => ({ ...l, vatKobo: 0, vat: 0, netOfVatKobo: l.netKobo, netOfVat: fromKobo(l.netKobo), chargeable: !l.exempt })),
    };
  }

  // Split the basket into chargeable and exempt buckets, in kobo.
  let chargeableKobo = 0;
  let exemptKobo = 0;
  for (const l of norm) {
    if (l.exempt) exemptKobo += l.netKobo;
    else chargeableKobo += l.netKobo;
  }
  const totalKobo = chargeableKobo + exemptKobo;

  // Extract VAT from the chargeable bucket only.
  const chargeableSplit = extractVat(fromKobo(chargeableKobo), r);
  const vatKobo = toKobo(chargeableSplit.vat);
  const chargeableNetKobo = chargeableKobo - vatKobo;
  const netKobo = chargeableNetKobo + exemptKobo;

  // Allocate the sale-level VAT onto chargeable lines, weighted by each line's
  // contribution, so sum(line.vat) === sale.vat exactly.
  const chargeableLines = norm.filter((l) => !l.exempt);
  const weights = chargeableLines.map((l) => Math.max(0, l.netKobo));
  const allocated = chargeableLines.length ? allocateKobo(vatKobo, weights) : [];

  const outLines = [];
  let ci = 0;
  for (const l of norm) {
    if (l.exempt) {
      outLines.push({
        ...l, vatKobo: 0, vat: 0,
        netOfVatKobo: l.netKobo, netOfVat: fromKobo(l.netKobo),
        chargeable: false,
      });
    } else {
      const v = allocated[ci] || 0;
      ci += 1;
      outLines.push({
        ...l, vatKobo: v, vat: fromKobo(v),
        netOfVatKobo: l.netKobo - v, netOfVat: fromKobo(l.netKobo - v),
        chargeable: true,
      });
    }
  }

  return {
    vatEnabled: true,
    vatRatePercent: r,
    totalKobo, total: fromKobo(totalKobo),
    chargeableKobo, chargeable: fromKobo(chargeableKobo),
    chargeableNetKobo, chargeableNet: fromKobo(chargeableNetKobo),
    exemptKobo, exempt: fromKobo(exemptKobo),
    netKobo, net: fromKobo(netKobo),
    vatKobo, vat: fromKobo(vatKobo),
    lines: outLines,
  };
}

/**
 * VAT return summary for a period — the four figures an accountant needs.
 *   output VAT  collected on sales
 *   input VAT   paid on purchases/expenses (recoverable if registered)
 *   net payable output - input
 */
function vatReturn({ outputVat, inputVat, rate }) {
  const outK = toKobo(outputVat);
  const inK = toKobo(inputVat);
  const netK = outK - inK;
  return {
    vatRatePercent: Number(rate) || DEFAULT_VAT_RATE_PERCENT,
    outputVat: fromKobo(outK),
    inputVat: fromKobo(inK),
    netPayable: fromKobo(netK),
    position: netK > 0 ? 'PAYABLE' : netK < 0 ? 'REFUNDABLE' : 'NIL',
  };
}

/**
 * Receipt wording. A VAT-registered business must show its TIN and the VAT
 * component; a non-registered one must NOT imply it charged VAT. Both strings
 * are produced here so no receipt template can get this wrong.
 */
function receiptBlock({ vatEnabled, vatRatePercent, vat, net, total, tin, hasExemptLines }) {
  if (!vatEnabled) {
    return { showVat: false, lines: [] };
  }
  const out = [
    { label: `Subtotal (net of VAT)`, value: fromKobo(toKobo(net)) },
    { label: `VAT @ ${vatRatePercent}%`, value: fromKobo(toKobo(vat)) },
    { label: 'Total', value: fromKobo(toKobo(total)) },
  ];
  if (hasExemptLines) {
    out.push({ label: 'Includes VAT-exempt items', value: null, note: true });
  }
  if (tin) out.push({ label: 'TIN', value: String(tin) });
  return { showVat: true, lines: out };
}

module.exports = {
  DEFAULT_VAT_RATE_PERCENT, EXEMPT_CATEGORY_CODES,
  isExempt, computeSaleVat, vatReturn, receiptBlock, round2,
};
