// =====================================================================
// StockRidge — COMPLIANCE (regulated goods, business licences, register)
// =====================================================================
// DECOUPLED FROM PHARMACY, NOT DELETED.
//
// PharmaRidge carried a `controlled_substance_register`: an append-only,
// HASH-CHAINED log of every controlled-drug dispense recording buyer
// identity, phone, ID type, quantity and dispenser. That table was doing
// something genuinely valuable that has nothing to do with drugs — it made
// a tamper-evident record of WHO TOOK WHAT, WHEN, and PROVED IT, for the
// small subset of transactions where that question is expensive.
//
// The mechanism transfers intact. The trigger changes.
//
// ---------------------------------------------------------------------
// WHAT IS A "REGULATED TRANSACTION" IN A GENERAL RETAIL BUSINESS?
// ---------------------------------------------------------------------
// The honest answer is: whatever the OWNER says it is, plus whatever the
// active business profile says the REGULATOR cares about. Both are
// configurable, and both produce entries in one register.
//
//   From the profile (compliance.regulatedCategories):
//     * Electronics/appliances on SON's mandatory-conformity list — phones,
//       computing, appliances, power equipment. Importing and retailing
//       these without SONCAP is a real offence with real seizure risk.
//     * Cement, steel, cables, roofing for building materials — also
//       mandatory-conformity.
//     * Packaged food and consumables for general merchandise — NAFDAC.
//
//   From the owner (products.is_regulated):
//     * Any single product they want tracked. High-theft items (phones,
//       laptop batteries, designer fixtures), items sold to a government
//       contract, items with an export restriction.
//
// The register then records, for every sale of such an item: the buyer's
// identity as presented, the quantity, the serial numbers where the product
// is serialised, who sold it, and which branch — chained by hash so a row
// cannot be edited or removed afterwards without every subsequent row
// failing verification.
//
// ---------------------------------------------------------------------
// WHY A HASH CHAIN RATHER THAN "JUST DON'T ALLOW EDITS"
// ---------------------------------------------------------------------
// Because the person who would tamper with the register is often the person
// with the keys to the system. An app-level "no update" rule is enforced by
// the app, and the app can be changed, the database can be opened directly,
// and a backup can be restored. A chain where each row stores the hash of
// its predecessor means ANY alteration to ANY historical row makes every
// row after it fail verification — the tampering is not prevented, it is
// DETECTED, permanently, and detection is what actually deters.
// =====================================================================

const { uuid, sha256Hex, normaliseNigerianPhone, normaliseTin } = require('./identity');

// ---------------------------------------------------------------------
// BUYER IDENTITY TYPES
// ---------------------------------------------------------------------
// What a Nigerian counter actually accepts as identification. The list is
// deliberately broad because the register is worthless if it cannot be
// filled in: a clerk who cannot record the ID the customer actually
// presented records nothing, or invents something.
const ID_TYPES = Object.freeze([
  { code: 'NIN', label: 'National Identification Number (NIN)' },
  { code: 'NIN_SLIP', label: 'NIN slip' },
  { code: 'BVN', label: 'Bank Verification Number (BVN)' },
  { code: 'DRIVERS_LICENSE', label: "Driver's licence" },
  { code: 'INTL_PASSPORT', label: 'International passport' },
  { code: 'VOTERS_CARD', label: "Voter's card (PVC)" },
  { code: 'CAC_RC', label: 'CAC certificate (RC/BN) — corporate buyer' },
  { code: 'STAFF_ID', label: 'Employer / staff ID card' },
  { code: 'SCHOOL_ID', label: 'Student ID' },
  { code: 'UTILITY_BILL', label: 'Utility bill (address proof)' },
  { code: 'PHONE_VERIFIED', label: 'Phone number verified by OTP/call-back' },
  { code: 'KNOWN_CUSTOMER', label: 'Known customer on the account (no ID presented)' },
  { code: 'OTHER', label: 'Other (describe in notes)' },
]);

// The MINIMUM acceptable identification for a regulated sale, and what to do
// when it is not met. Never a hard block — see the principle below.
const MINIMUM_ID_FOR_REGULATED = Object.freeze(['NIN', 'BVN', 'DRIVERS_LICENSE', 'INTL_PASSPORT', 'VOTERS_CARD', 'CAC_RC']);

// ---------------------------------------------------------------------
// THE NEVER-BLOCK PRINCIPLE
// ---------------------------------------------------------------------
// Carried over from PharmaRidge's attendance geofencing, where the same
// reasoning applied: a compliance check that STOPS a sale at the counter
// gets worked around, and the workaround is worse than the failure it
// prevented. A clerk who cannot complete a sale because the customer left
// their NIN at home will either (a) not sell, losing real revenue over a
// paperwork gap, or (b) record a made-up ID, destroying the register's
// value entirely — and (b) is invisible.
//
// So: the sale COMPLETES, the gap is FLAGGED on the register entry, and the
// flag appears on a manager's exception report the same day. A flagged
// register is honest about what it does not know. A blocked one is not
// honest about anything.
const COMPLIANCE_FLAG_LEVELS = Object.freeze(['OK', 'ADVISORY', 'REVIEW_REQUIRED']);

function assessRegulatedSale({ product, profile, buyer = {}, serials = [], quantity = 1, isCorporateBuyer = false }) {
  const flags = [];
  const regulatedByProfile = Boolean(
    profile && Array.isArray(profile.compliance && profile.compliance.regulatedCategories)
    && profile.compliance.regulatedCategories.includes(product && product.category_code),
  );
  const regulatedByOwner = Boolean(product && product.is_regulated === 1);
  const requiresRegister = regulatedByProfile || regulatedByOwner;

  if (!requiresRegister) {
    return { requires_register: false, flags: [], level: 'OK', message: null, serials_required: false };
  }

  const idType = String(buyer.id_type || '').toUpperCase();
  const idNumber = String(buyer.id_number || '').trim();
  const phone = normaliseNigerianPhone(buyer.phone);

  if (!idType) {
    flags.push({ code: 'NO_ID_TYPE', level: 'REVIEW_REQUIRED', message: 'No identification type recorded for a regulated sale.' });
  } else if (!MINIMUM_ID_FOR_REGULATED.includes(idType) && idType !== 'OTHER') {
    flags.push({
      code: 'WEAK_ID_TYPE', level: 'ADVISORY',
      message: `"${idType}" is not a government-issued identity document. Acceptable where the buyer is genuinely known, but a manager should review.`,
    });
  }

  if (!idNumber) {
    flags.push({ code: 'NO_ID_NUMBER', level: 'REVIEW_REQUIRED', message: 'Identification type recorded but no number captured.' });
  }
  if (!phone) {
    flags.push({ code: 'NO_PHONE', level: 'REVIEW_REQUIRED', message: 'No valid Nigerian phone number recorded — the buyer cannot be contacted about a recall or a warranty.' });
  }
  if (!buyer.full_name || !String(buyer.full_name).trim()) {
    flags.push({ code: 'NO_BUYER_NAME', level: 'REVIEW_REQUIRED', message: 'No buyer name recorded.' });
  }

  // Serialised regulated goods must have their serials captured. A register
  // entry saying "2 phones sold" cannot answer a recall notice, which is the
  // entire point of keeping it.
  const serialsRequired = Boolean(profile && profile.compliance && profile.compliance.requiresSerialNumbers);
  if (serialsRequired && Number(quantity) > serials.length) {
    flags.push({
      code: 'SERIALS_INCOMPLETE', level: 'REVIEW_REQUIRED',
      message: `${Number(quantity)} serialised unit(s) sold but only ${serials.length} serial number(s) captured. A recall notice cannot be actioned against this sale.`,
    });
  }

  // Compliance reference on the PRODUCT (SONCAP / NAFDAC number). Missing
  // here is an import-compliance exposure for the business, not a problem
  // with this customer, so it is advisory to the sale and a hard item on the
  // product exception report.
  const refLabel = (profile && profile.compliance && profile.compliance.productReferenceLabel) || 'Compliance reference';
  if (!product.compliance_ref_no) {
    flags.push({
      code: 'PRODUCT_NO_COMPLIANCE_REF', level: 'ADVISORY',
      message: `This product has no ${refLabel} on record. It is in a category that may require one — add it in Products, or confirm it is genuinely exempt.`,
    });
  }

  const level = flags.some((f) => f.level === 'REVIEW_REQUIRED')
    ? 'REVIEW_REQUIRED'
    : flags.length ? 'ADVISORY' : 'OK';

  return {
    requires_register: true,
    regulated_by_profile: regulatedByProfile,
    regulated_by_owner: regulatedByOwner,
    serials_required: serialsRequired,
    flags,
    level,
    is_corporate_buyer: isCorporateBuyer,
    message: level === 'OK'
      ? null
      : `Sale recorded with ${flags.length} compliance flag(s). It is NOT blocked — review it in the Regulated Goods Register today.`,
  };
}

// ---------------------------------------------------------------------
// HASH CHAIN
// ---------------------------------------------------------------------
// The canonical string is built from EXACTLY the fields that matter, in a
// fixed order, with nulls rendered as the literal string "null" so that a
// null and an empty string cannot produce the same hash. Any change to the
// canonical form invalidates every existing chain, so it is versioned.
const CHAIN_VERSION = 1;

function canonicalRegisterEntry(entry) {
  return [
    `v${CHAIN_VERSION}`,
    entry.branch_id || null,
    entry.sale_id || null,
    entry.product_id || null,
    entry.serial_number || null,
    entry.quantity == null ? null : Number(entry.quantity),
    entry.buyer_name || null,
    entry.buyer_phone || null,
    entry.buyer_id_type || null,
    entry.buyer_id_number || null,
    entry.recorded_by || null,
    entry.recorded_at || null,
    entry.prev_hash || null,
  ].map((v) => (v === null || v === undefined ? 'null' : String(v))).join('|');
}

async function computeEntryHash(entry) {
  return sha256Hex(canonicalRegisterEntry(entry));
}

// The genesis hash for a branch's chain. Derived from the branch id so two
// branches cannot accidentally share a first link, which would let an entry
// from one branch be spliced into another's chain.
async function genesisHash(branchId) {
  return sha256Hex(`stockridge-register-genesis|v${CHAIN_VERSION}|${branchId}`);
}

// Verify a chain. Returns the first broken link and how far verification
// got, rather than a bare boolean — "the chain is broken" is not actionable,
// "the chain is broken at entry 4,182 recorded on 12 March by user X" is.
async function verifyChain(entries = [], branchId) {
  if (!entries.length) return { ok: true, verified: 0, broken_at: null };

  let expectedPrev = await genesisHash(branchId);
  let verified = 0;

  for (const entry of entries) {
    if (String(entry.prev_hash || '') !== expectedPrev) {
      return {
        ok: false, verified,
        broken_at: {
          id: entry.id,
          index: verified,
          recorded_at: entry.recorded_at,
          recorded_by: entry.recorded_by,
          reason: 'PREV_HASH_MISMATCH',
          message: 'This entry does not link to the one before it. A prior row was altered, removed or inserted out of order.',
          expected_prev_hash: expectedPrev,
          found_prev_hash: entry.prev_hash || null,
        },
      };
    }
    const computed = await computeEntryHash(entry);
    if (String(entry.entry_hash || '') !== computed) {
      return {
        ok: false, verified,
        broken_at: {
          id: entry.id,
          index: verified,
          recorded_at: entry.recorded_at,
          recorded_by: entry.recorded_by,
          reason: 'ENTRY_HASH_MISMATCH',
          message: 'This entry\'s own contents no longer match its recorded hash. The row was edited after it was written.',
          expected_hash: computed,
          found_hash: entry.entry_hash || null,
        },
      };
    }
    expectedPrev = computed;
    verified += 1;
  }

  return { ok: true, verified, broken_at: null };
}

// ---------------------------------------------------------------------
// BUSINESS LICENCES & REGISTRATIONS
// ---------------------------------------------------------------------
// Generalised from PharmaRidge's pcn_license_expiry_date /
// superintendent_registration_expiry_date. Every Nigerian trading business
// carries a set of registrations that EXPIRE, and letting one lapse is a
// fine, a shutdown, or worse. Which ones apply depends on the vertical and
// the locality, so they are DATA on the branch row plus this schedule.
const BUSINESS_REGISTRATION_TYPES = Object.freeze([
  { code: 'CAC_RC', label: 'CAC certificate (RC/BN)', appliesTo: ['ALL'], renewalTypicalDays: 365, critical: true },
  { code: 'TIN_FIRS', label: 'Tax Identification Number (NRS/FIRS)', appliesTo: ['ALL'], renewalTypicalDays: null, critical: true },
  { code: 'VAT_REG', label: 'VAT registration', appliesTo: ['ALL'], renewalTypicalDays: null, critical: true },
  { code: 'LGA_TRADE_PERMIT', label: 'LGA trade / business permit', appliesTo: ['ALL'], renewalTypicalDays: 365, critical: true },
  { code: 'SONCAP_IMPORTER', label: 'SON / SONCAP importer registration', appliesTo: ['ELECTRONICS_APPLIANCES', 'BUILDING_MATERIALS', 'GENERAL_MERCHANDISE'], renewalTypicalDays: 365, critical: true },
  { code: 'NAFDAC_FACILITY', label: 'NAFDAC facility licence (food/consumables)', appliesTo: ['GENERAL_MERCHANDISE'], renewalTypicalDays: 730, critical: true },
  { code: 'STATE_FIRE_CERT', label: 'State fire service certificate', appliesTo: ['ALL'], renewalTypicalDays: 365, critical: false },
  { code: 'SIGNAGE_PERMIT', label: 'Signage / advertising permit', appliesTo: ['ALL'], renewalTypicalDays: 365, critical: false },
  { code: 'WAREHOUSE_PERMIT', label: 'Warehouse / storage permit', appliesTo: ['BUILDING_MATERIALS', 'GENERAL_MERCHANDISE'], renewalTypicalDays: 365, critical: false },
  { code: 'HAZMAT_STORAGE', label: 'Hazardous materials storage approval (paints, gas)', appliesTo: ['BUILDING_MATERIALS'], renewalTypicalDays: 365, critical: true },
  { code: 'CARRIER_PERMIT', label: 'Goods-in-transit / haulage permit', appliesTo: ['BUILDING_MATERIALS'], renewalTypicalDays: 365, critical: false },
  { code: 'CONTRACTOR_REG', label: 'State contractor / supplier registration', appliesTo: ['BUILDING_MATERIALS', 'FURNITURE_HOME'], renewalTypicalDays: 365, critical: false },
  { code: 'E_WASTE_REG', label: 'E-waste / take-back registration (NESREA)', appliesTo: ['ELECTRONICS_APPLIANCES'], renewalTypicalDays: 365, critical: false },
  { code: 'DATA_PROTECTION', label: 'NDPA data protection filing (NDPC)', appliesTo: ['ALL'], renewalTypicalDays: 365, critical: false },
]);

function registrationsForProfiles(profileCodes) {
  const set = new Set(profileCodes || []);
  return BUSINESS_REGISTRATION_TYPES.filter((r) => r.appliesTo.includes('ALL') || r.appliesTo.some((p) => set.has(p)));
}

// Advance-warning windows. 90 days is the outer one because a SONCAP or LGA
// permit renewal in Nigeria is not a same-day errand, and discovering a
// lapse 7 days out means the business is already exposed while it waits.
const LICENCE_WARNING_WINDOWS_DAYS = Object.freeze([90, 60, 30, 14, 7, 0]);

function licenceStatus({ expiryDate, now = new Date() }) {
  if (!expiryDate) return { status: 'NO_EXPIRY_ON_RECORD', level: 'ADVISORY', days: null, window: null };
  const today = isoOf(now);
  const exp = String(expiryDate).slice(0, 10);
  const days = Math.round((Date.parse(exp) - Date.parse(today)) / 86400000);
  if (!Number.isFinite(days)) return { status: 'UNKNOWN', level: 'REVIEW_REQUIRED', days: null, window: null };
  if (days < 0) return { status: 'EXPIRED', level: 'CRITICAL', days: -days, window: 'EXPIRED', message: `Expired ${-days} day(s) ago on ${exp}. The business is trading without a valid registration.` };
  if (days === 0) return { status: 'EXPIRES_TODAY', level: 'CRITICAL', days: 0, window: 'TODAY', message: 'Expires today.' };
  const window = [...LICENCE_WARNING_WINDOWS_DAYS].sort((a, b) => a - b).find((w) => days <= w);
  return {
    status: window != null ? 'EXPIRING_SOON' : 'VALID',
    level: window == null ? 'OK' : (days <= 14 ? 'CRITICAL' : 'WARN'),
    days,
    window: window == null ? null : `WITHIN_${window}`,
    message: window == null ? null : `Expires in ${days} day(s) on ${exp}.`,
  };
}

// ---------------------------------------------------------------------
// E-INVOICING READINESS (NTA 2025 phased rollout)
// ---------------------------------------------------------------------
// A retailer in the ₦1bn–₦5bn band went live in July 2026 and is enforced
// from January 2027; below ₦1bn it goes live July 2027. The fields an
// e-invoice needs are the ones a receipt printer does not usually carry, so
// "are we ready" is a real question with a real answer, computed from data
// the app already holds.
function eInvoiceReadiness({ business, band }) {
  const gaps = [];
  if (!business.tin) gaps.push({ field: 'tin', label: 'Business TIN', severity: 'BLOCKER' });
  if (!business.cac_reg_no) gaps.push({ field: 'cac_reg_no', label: 'CAC registration number', severity: 'BLOCKER' });
  if (!business.vat_enabled) gaps.push({ field: 'vat_enabled', label: 'VAT registration enabled', severity: 'BLOCKER' });
  if (!business.registered_address) gaps.push({ field: 'registered_address', label: 'Registered business address', severity: 'MAJOR' });
  if (!business.sequential_invoice_numbering) gaps.push({ field: 'sequential_invoice_numbering', label: 'Sequential, gap-free invoice numbering', severity: 'MAJOR' });

  const enforced = band && band.enforcedFrom ? new Date(band.enforcedFrom) <= new Date() : false;
  return {
    band: band ? band.code : null,
    ready: gaps.filter((g) => g.severity === 'BLOCKER').length === 0,
    gaps,
    enforcement_live: enforced,
    message: gaps.length === 0
      ? 'All fields required for e-invoicing are present.'
      : `${gaps.length} e-invoicing gap(s): ${gaps.map((g) => g.label).join('; ')}.`,
  };
}

// ---------------------------------------------------------------------
// PRODUCT RECALL HANDLING
// ---------------------------------------------------------------------
// The reason the regulated register and serial tracking exist. A recall
// notice arrives naming a model and a serial range or a batch; the business
// must answer "which of these did we sell, and to whom" in hours, not weeks.
function recallMatchCriteria({ model, batchNo, serialPrefixes = [], serialRange = null, manufactureDateFrom = null, manufactureDateTo = null }) {
  return {
    model: model ? String(model).trim() : null,
    batch_no: batchNo ? String(batchNo).trim() : null,
    serial_prefixes: (serialPrefixes || []).map((s) => String(s).trim().toUpperCase()).filter(Boolean),
    serial_range: serialRange && serialRange.from && serialRange.to
      ? { from: String(serialRange.from).trim().toUpperCase(), to: String(serialRange.to).trim().toUpperCase() }
      : null,
    manufacture_date_from: manufactureDateFrom || null,
    manufacture_date_to: manufactureDateTo || null,
  };
}

function unitMatchesRecall(unit, criteria) {
  if (!unit || !criteria) return false;
  if (criteria.model && String(unit.model || '').trim().toLowerCase() !== criteria.model.toLowerCase()) return false;
  if (criteria.batch_no && String(unit.batch_no || '').trim().toLowerCase() !== criteria.batch_no.toLowerCase()) return false;
  const serial = String(unit.serial_number || '').trim().toUpperCase();
  if (criteria.serial_prefixes.length && !criteria.serial_prefixes.some((p) => serial.startsWith(p))) return false;
  if (criteria.serial_range && (serial < criteria.serial_range.from || serial > criteria.serial_range.to)) return false;
  if (criteria.manufacture_date_from && unit.manufacture_date && unit.manufacture_date < criteria.manufacture_date_from) return false;
  if (criteria.manufacture_date_to && unit.manufacture_date && unit.manufacture_date > criteria.manufacture_date_to) return false;
  return true;
}

// NDPA / data-protection note. The register stores personal data (names,
// phones, ID numbers) and Nigeria Data Protection Act 2023 applies. The
// retention period is therefore explicit rather than "forever", and
// redaction is a supported operation — but redaction must NOT break the
// hash chain, so a redacted entry keeps its hash and gains a redaction
// marker rather than having its fields blanked in place.
const REGISTER_RETENTION_YEARS = 6; // aligns with the statutory limitation window for commercial records

function isoOf(d) {
  const date = d instanceof Date ? d : new Date(String(d || new Date().toISOString()));
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

module.exports = {
  ID_TYPES,
  MINIMUM_ID_FOR_REGULATED,
  COMPLIANCE_FLAG_LEVELS,
  CHAIN_VERSION,
  BUSINESS_REGISTRATION_TYPES,
  LICENCE_WARNING_WINDOWS_DAYS,
  REGISTER_RETENTION_YEARS,
  assessRegulatedSale,
  canonicalRegisterEntry,
  computeEntryHash,
  genesisHash,
  verifyChain,
  registrationsForProfiles,
  licenceStatus,
  eInvoiceReadiness,
  recallMatchCriteria,
  unitMatchesRecall,
};
