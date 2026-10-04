// =====================================================================
// shared/lib/fx.js — FOREIGN-CURRENCY SALES AND PURCHASES
// =====================================================================
//
// NEW TO STOCKRIDGE, and unavoidable for two of the four verticals.
//
// Electronics, appliances and building materials are imported. Nigerian
// retailers in those lines routinely:
//   * price in naira but restock at a cost that moves with the dollar,
//   * quote a customer in USD when the item is being ordered in,
//   * accept USD, GBP or CNY cash from a customer,
//   * pay a supplier's pro-forma invoice in foreign currency.
//
// AND NIGERIA HAS HAD TWO EXCHANGE RATES IN PRACTICE. The official CBN window
// and the parallel ("black") market have diverged — sometimes by a wide margin.
// A system that stores one "exchange rate" is storing a fiction: the rate a
// customer was quoted, the rate the goods were actually bought at, and the rate
// the bank settled at are three different numbers, and the difference between
// them is real money that shows up nowhere if the model cannot hold all three.
//
// THE RULE: a transaction records THE RATE IT USED, AT THE TIME, FROM A NAMED
// SOURCE. Nothing ever re-derives a historic conversion from today's rate. A
// sale made at ₦1,450/$ must still read ₦1,450/$ in a report two years later,
// because that is what the customer paid and what the shop banked.
//
// FX GAIN / LOSS is a real P&L line, not a rounding difference. If you bought
// stock at ₦1,200/$ and sold it after the naira moved to ₦1,500/$, your
// replacement cost went up and your reported margin was an illusion. StockRidge
// computes replacement-cost exposure so the owner can see it.

'use strict';

const { round2, toKobo, fromKobo } = require('./money');

const CURRENCIES = Object.freeze([
  { code: 'NGN', label: 'Nigerian Naira', symbol: '₦', decimals: 2, base: true },
  { code: 'USD', label: 'US Dollar',      symbol: '$',  decimals: 2 },
  { code: 'GBP', label: 'Pound Sterling', symbol: '£',  decimals: 2 },
  { code: 'EUR', label: 'Euro',           symbol: '€',  decimals: 2 },
  { code: 'CNY', label: 'Chinese Yuan',   symbol: '¥',  decimals: 2 },
  { code: 'GHS', label: 'Ghanaian Cedi',  symbol: 'GH₵', decimals: 2 },
  { code: 'XOF', label: 'West African CFA franc', symbol: 'CFA', decimals: 0 },
  { code: 'AED', label: 'UAE Dirham',     symbol: 'د.إ', decimals: 2 },
]);
const CURRENCY_CODES = new Set(CURRENCIES.map((c) => c.code));

const RATE_SOURCES = Object.freeze([
  { code: 'CBN_OFFICIAL', label: 'CBN official window' },
  { code: 'NAFEM',        label: 'NAFEM / investors & exporters window' },
  { code: 'PARALLEL',     label: 'Parallel (black) market' },
  { code: 'BANK',         label: 'Our bank\'s dealing rate' },
  { code: 'SUPPLIER',     label: 'Rate quoted by the supplier' },
  { code: 'AGREED',       label: 'Rate agreed with the customer' },
  { code: 'MANUAL',       label: 'Manually entered' },
]);

const BASE_CURRENCY = 'NGN';

function isCurrency(code) { return CURRENCY_CODES.has(String(code || '').toUpperCase()); }
function currencyInfo(code) { return CURRENCIES.find((c) => c.code === String(code || '').toUpperCase()) || CURRENCIES[0]; }

/**
 * Validate a rate before it is stored.
 *
 * A rate of 0 or a rate typed as 0.00069 instead of 1450 is the single most
 * damaging data-entry error in this module: every conversion downstream is
 * wrong by six orders of magnitude, and it looks plausible on a receipt until
 * someone adds the column up. So rates are range-checked against a sane band
 * per currency pair, and the band is DATA (client-editable) rather than
 * hard-coded, because a hard-coded band is wrong within a year.
 */
function validateRate({ currency, rate, band }) {
  const cur = String(currency || '').toUpperCase();
  if (!isCurrency(cur)) {
    const err = new Error(`Unknown currency "${currency}"`);
    err.status = 400; err.code = 'UNKNOWN_CURRENCY';
    throw err;
  }
  if (cur === BASE_CURRENCY) return 1;

  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) {
    const err = new Error(`The ${cur}/NGN rate must be a positive number (e.g. 1450.00, not 0.00069)`);
    err.status = 400; err.code = 'INVALID_FX_RATE';
    throw err;
  }
  const b = band && band[cur];
  if (b) {
    if (r < b.min || r > b.max) {
      const err = new Error(`${r} is outside the plausible ${cur}/NGN range (${b.min}–${b.max}). Check whether you entered naira-per-unit or unit-per-naira.`);
      err.status = 400; err.code = 'FX_RATE_OUT_OF_BAND';
      throw err;
    }
  }
  return round2(r);
}

/**
 * Convert. `rate` is ALWAYS expressed as NGN per 1 unit of `currency`.
 * Storing it the other way round is a real source of errors, so the direction
 * is fixed and documented at every call site.
 */
function toBase(amount, currency, rate) {
  const cur = String(currency || BASE_CURRENCY).toUpperCase();
  if (cur === BASE_CURRENCY) return round2(Number(amount) || 0);
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) {
    const err = new Error(`A valid ${cur}/NGN rate is required to convert this amount`);
    err.status = 400; err.code = 'MISSING_FX_RATE';
    throw err;
  }
  return round2((Number(amount) || 0) * r);
}

function fromBase(amountBase, currency, rate) {
  const cur = String(currency || BASE_CURRENCY).toUpperCase();
  if (cur === BASE_CURRENCY) return round2(Number(amountBase) || 0);
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) {
    const err = new Error(`A valid ${cur}/NGN rate is required to convert this amount`);
    err.status = 400; err.code = 'MISSING_FX_RATE';
    throw err;
  }
  return round2((Number(amountBase) || 0) / r);
}

/**
 * A complete conversion record for one transaction. EVERYTHING the audit needs
 * is captured here, so no historic figure can ever be re-derived from a rate
 * that has since moved.
 */
function conversionRecord({ amount, currency, rate, source, rateDate, note }) {
  const cur = String(currency || BASE_CURRENCY).toUpperCase();
  const isBase = cur === BASE_CURRENCY;
  return {
    currency: cur,
    amount: round2(Number(amount) || 0),
    // For the base currency the rate is 1 and the source is irrelevant; storing
    // them keeps every row uniform so a report never has to special-case NGN.
    fx_rate: isBase ? 1 : round2(Number(rate) || 0),
    fx_source: isBase ? null : String(source || 'MANUAL').toUpperCase(),
    fx_rate_date: isBase ? null : String(rateDate || new Date().toISOString()).slice(0, 10),
    amount_ngn: isBase ? round2(Number(amount) || 0) : toBase(amount, cur, rate),
    fx_note: note || null,
  };
}

/**
 * Replacement-cost exposure.
 *
 * The question an importer actually needs answered: "if the naira moves to X
 * tomorrow, what does my current stock cost to replace, and what is my real
 * margin at today's prices?"
 *
 * This is not a hedge recommendation and does not pretend to be. It is a
 * number that tells an owner their reported margin was earned at a rate that no
 * longer exists.
 */
function replacementExposure({ stockValueAtCostNgn, currentRate, costRate, stressRates = [] }) {
  const costR = Number(costRate) || 0;
  const curR = Number(currentRate) || 0;
  if (costR <= 0 || curR <= 0) {
    return { ok: false, code: 'MISSING_RATE', error: 'Both the cost rate and the current rate are needed.' };
  }
  // The foreign-currency cost implied by what was actually paid.
  const foreignCost = stockValueAtCostNgn / costR;
  const replacementNgn = foreignCost * curR;
  const exposureKobo = toKobo(replacementNgn) - toKobo(stockValueAtCostNgn);

  return {
    ok: true,
    stockValueAtCost: round2(Number(stockValueAtCostNgn) || 0),
    impliedForeignCost: round2(foreignCost),
    costRate: round2(costR),
    currentRate: round2(curR),
    rateMovementPercent: round2(((curR - costR) / costR) * 100),
    replacementCost: round2(replacementNgn),
    exposureKobo: exposureKobo,
    exposure: fromKobo(exposureKobo),
    direction: exposureKobo > 0 ? 'UNDER_VALUED' : exposureKobo < 0 ? 'OVER_VALUED' : 'NEUTRAL',
    note: exposureKobo > 0
      ? `Replacing this stock at today's rate costs ${fromKobo(exposureKobo)} more than the books show. Reported margin on these lines is overstated by that amount.`
      : exposureKobo < 0
        ? `This stock is worth ${fromKobo(-exposureKobo)} less to replace than the books show — a favourable movement.`
        : 'No exposure at the current rate.',
    stress: (stressRates || []).map((r) => {
      const rr = Number(r);
      if (!Number.isFinite(rr) || rr <= 0) return null;
      const repl = foreignCost * rr;
      return {
        rate: round2(rr),
        replacementCost: round2(repl),
        exposure: fromKobo(toKobo(repl) - toKobo(stockValueAtCostNgn)),
        movementPercent: round2(((rr - costR) / costR) * 100),
      };
    }).filter(Boolean),
  };
}

/**
 * An FX-cash tender: the customer handed over foreign notes.
 * The till holds NAIRA. Foreign notes are a separate asset that must be
 * counted, and the conversion used must be recorded on the tender.
 */
function fxCashTender({ foreignAmount, currency, rate, source }) {
  const cur = String(currency || '').toUpperCase();
  if (cur === BASE_CURRENCY) {
    const err = new Error('An FX tender cannot be in naira — record it as CASH');
    err.status = 400; err.code = 'FX_TENDER_IN_BASE';
    throw err;
  }
  const rec = conversionRecord({ amount: foreignAmount, currency: cur, rate, source });
  return {
    ...rec,
    method: 'FX_CASH',
    // The naira figure is what settles the sale; the foreign figure is what
    // goes into the FX drawer and must be counted separately at till close.
    settles_ngn: rec.amount_ngn,
    goes_to_fx_drawer: true,
  };
}

/** Format any currency for display. */
function format(amount, currency) {
  const info = currencyInfo(currency);
  const v = Number(amount) || 0;
  return `${info.symbol}${Math.abs(v).toLocaleString('en-NG', {
    minimumFractionDigits: info.decimals, maximumFractionDigits: info.decimals,
  })}`;
}

module.exports = {
  CURRENCIES, CURRENCY_CODES, RATE_SOURCES, BASE_CURRENCY,
  isCurrency, currencyInfo, validateRate, toBase, fromBase,
  conversionRecord, replacementExposure, fxCashTender, format,
};
