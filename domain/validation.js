'use strict';
// =====================================================================
// domain/validation.js — INPUT VALIDATION, NIGERIAN FORMATS
// =====================================================================
// MESSAGES ARE WRITTEN FOR THE PERSON TYPING, NOT FOR A DEVELOPER.
// Every error string here ends up in a red box on a shop-floor screen.
// "Invalid input" is not a message; "Nigerian mobile numbers are 11 digits
// starting with 0, or +234 followed by 10" is.
//
// NOTHING HERE THROWS. Validators return { ok, value, error, code } so a
// caller can collect several failures and show them together — a form that
// reports one error at a time makes a cashier fill in a twelve-field screen
// twelve times.
// =====================================================================

const { round2, roundTo } = require('./money');

// ---------------------------------------------------------------------
// PRIMITIVES
// ---------------------------------------------------------------------
function ok(value) { return { ok: true, value }; }
function bad(code, error) { return { ok: false, code, error }; }

function required(value, { field = 'This field', maxLength = null } = {}) {
  if (value == null || String(value).trim() === '') return bad('REQUIRED', `${field} is required.`);
  const s = String(value).trim();
  if (maxLength && s.length > maxLength) return bad('TOO_LONG', `${field} must be ${maxLength} characters or fewer (you entered ${s.length}).`);
  return ok(s);
}

function optionalString(value, { maxLength = 500 } = {}) {
  if (value == null || String(value).trim() === '') return ok(null);
  const s = String(value).trim();
  if (s.length > maxLength) return bad('TOO_LONG', `That is longer than ${maxLength} characters. Shorten it, or put the detail in the notes field.`);
  return ok(s);
}

function integer(value, { field = 'This number', min = null, max = null, required: isRequired = true } = {}) {
  if (value == null || String(value).trim() === '') {
    return isRequired ? bad('REQUIRED', `${field} is required.`) : ok(null);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return bad('NOT_A_NUMBER', `${field} must be a number.`);
  if (!Number.isInteger(n)) return bad('NOT_WHOLE', `${field} must be a whole number — ${n} is not.`);
  if (min != null && n < min) return bad('TOO_SMALL', `${field} must be at least ${min.toLocaleString('en-NG')}.`);
  if (max != null && n > max) return bad('TOO_LARGE', `${field} must be ${max.toLocaleString('en-NG')} or fewer.`);
  return ok(n);
}

/**
 * Money input.
 *
 * Strips the ₦ symbol, commas and spaces because cashiers type "₦12,500"
 * into money fields constantly and refusing it teaches them to work around
 * the system rather than with it. Rejects negatives unless explicitly
 * allowed (a ledger amount may be negative; a price may not).
 */
function money(value, { field = 'This amount', min = 0, max = null, allowNegative = false, required: isRequired = true } = {}) {
  if (value == null || String(value).trim() === '') {
    return isRequired ? bad('REQUIRED', `${field} is required.`) : ok(null);
  }
  const cleaned = String(value).replace(/[₦,\s]/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return bad('NOT_A_NUMBER', `${field} must be an amount, e.g. 12500 or 12500.50.`);
  if (!allowNegative && n < 0) return bad('NEGATIVE', `${field} cannot be negative.`);
  if (min != null && n < min) return bad('TOO_SMALL', `${field} must be at least ${min.toLocaleString('en-NG')}.`);
  if (max != null && n > max) return bad('TOO_LARGE', `${field} must be ${max.toLocaleString('en-NG')} or less.`);
  return ok(round2(n));
}

/** Quantity. Fractional ONLY when the caller says the product is measured. */
function quantity(value, { field = 'Quantity', min = 0, max = null, allowFraction = false, places = 4, required: isRequired = true } = {}) {
  if (value == null || String(value).trim() === '') {
    return isRequired ? bad('REQUIRED', `${field} is required.`) : ok(null);
  }
  const n = Number(String(value).replace(/,/g, ''));
  if (!Number.isFinite(n)) return bad('NOT_A_NUMBER', `${field} must be a number.`);
  if (!allowFraction && !Number.isInteger(n)) {
    return bad('NOT_WHOLE', `${field} must be a whole number. For a part of a unit, sell in the smaller unit instead — 1.5 cartons cannot be handed over.`);
  }
  if (min != null && n < min) return bad('TOO_SMALL', `${field} must be at least ${min}.`);
  if (max != null && n > max) return bad('TOO_LARGE', `${field} must be ${max} or fewer.`);
  if (n === 0) return bad('ZERO', `${field} must be more than zero.`);
  return ok(roundTo(n, places));
}

function booleanFlag(value, { default: dflt = false } = {}) {
  if (value == null || value === '') return ok(dflt);
  if (typeof value === 'boolean') return ok(value);
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return ok(true);
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return ok(false);
  return bad('NOT_A_BOOLEAN', 'That must be yes or no.');
}

function oneOf(value, allowed, { field = 'This option', required: isRequired = true } = {}) {
  if (value == null || String(value).trim() === '') {
    return isRequired ? bad('REQUIRED', `${field} is required.`) : ok(null);
  }
  const s = String(value).trim().toUpperCase();
  if (!allowed.map(String).map((a) => a.toUpperCase()).includes(s)) {
    return bad('NOT_ALLOWED', `${field} must be one of: ${allowed.join(', ')}.`);
  }
  return ok(s);
}

function isoDate(value, { field = 'This date', min = null, max = null, required: isRequired = true } = {}) {
  if (value == null || String(value).trim() === '') {
    return isRequired ? bad('REQUIRED', `${field} is required.`) : ok(null);
  }
  const s = String(value).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return bad('NOT_A_DATE', `${field} must be a date in YYYY-MM-DD format.`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return bad('NOT_A_DATE', `${field} is not a real calendar date.`);
  if (min && s < String(min).slice(0, 10)) return bad('TOO_EARLY', `${field} cannot be before ${String(min).slice(0, 10)}.`);
  if (max && s > String(max).slice(0, 10)) return bad('TOO_LATE', `${field} cannot be after ${String(max).slice(0, 10)}.`);
  return ok(s);
}

// ---------------------------------------------------------------------
// NIGERIAN FORMATS
// ---------------------------------------------------------------------

/**
 * Nigerian mobile number.
 *
 * Accepts the four forms actually seen at a counter and normalises all of
 * them to 11-digit local format (08031234567), because that is what the
 * shop's own customer list is full of and what an SMS gateway in Nigeria
 * expects:
 *   08031234567      local
 *   +2348031234567   international
 *   2348031234567    international without the +
 *   0803 123 4567    spaced
 *
 * Rejected: a 10-digit local number (a very common typo — dropping the
 * leading 0 or a digit), and a number whose prefix is not a real Nigerian
 * mobile prefix. The prefix check matters because a mistyped digit produces
 * a valid-looking number that belongs to somebody else, and a shop that
 * SMSes a receipt to a stranger has a problem.
 */
const NIGERIAN_MOBILE_PREFIXES = new Set([
  '0701', '0702', '0703', '0704', '0705', '0706', '0707', '0708', '0709',
  '0801', '0802', '0803', '0804', '0805', '0806', '0807', '0808', '0809',
  '0810', '0811', '0812', '0813', '0814', '0815', '0816', '0817', '0818', '0819',
  '0901', '0902', '0903', '0904', '0905', '0906', '0907', '0908', '0909',
  '0911', '0912', '0913', '0915', '0916', '0918',
  '0700', // fixed-line / prepaid services, accepted so a shop phone is not rejected
]);

function nigerianPhone(value, { field = 'Phone number', required: isRequired = false, strictPrefix = true } = {}) {
  if (value == null || String(value).trim() === '') {
    return isRequired ? bad('REQUIRED', `${field} is required.`) : ok(null);
  }
  let s = String(value).replace(/[\s\-().]/g, '');
  if (s.startsWith('00234')) s = `0${s.slice(5)}`;
  else if (s.startsWith('+234')) s = `0${s.slice(4)}`;
  else if (s.startsWith('234') && s.length === 13) s = `0${s.slice(3)}`;

  if (!/^\d+$/.test(s)) return bad('NOT_A_NUMBER', `${field} may only contain digits (spaces and +234 are fine).`);
  if (s.length === 10 && !s.startsWith('0')) return bad('PHONE_TOO_SHORT', `${field} looks like it is missing the leading 0 — Nigerian mobile numbers are 11 digits, e.g. 08031234567.`);
  if (s.length !== 11) return bad('PHONE_LENGTH', `${field} must be 11 digits starting with 0 (e.g. 08031234567), or +234 followed by 10 digits. You entered ${s.length} digits.`);
  if (!s.startsWith('0')) return bad('PHONE_FORMAT', `${field} must start with 0 in local format.`);
  if (strictPrefix && !NIGERIAN_MOBILE_PREFIXES.has(s.slice(0, 4))) {
    return bad('PHONE_PREFIX', `${field} starts with ${s.slice(0, 4)}, which is not a known Nigerian network prefix. Check for a transposed digit — a wrong number here means the customer never gets their receipt or warranty SMS.`);
  }
  return ok(s);
}

/** Normalise without validating, for search and matching. */
function normalisePhone(value) {
  if (!value) return null;
  let s = String(value).replace(/[\s\-().]/g, '');
  if (s.startsWith('00234')) s = `0${s.slice(5)}`;
  else if (s.startsWith('+234')) s = `0${s.slice(4)}`;
  else if (s.startsWith('234') && s.length === 13) s = `0${s.slice(3)}`;
  return /^\d+$/.test(s) ? s : null;
}

/**
 * FIRS Tax Identification Number.
 *
 * Format is 8 digits for companies and 8-11 for individuals; the FIRS has
 * issued both. The check is deliberately loose on LENGTH and strict on
 * DIGITS, because a strict length rule rejects real registered taxpayers
 * and teaches the user to put a fake value in the field — which is worse
 * than no value, since a WHT credit note needs a genuine TIN.
 */
function tin(value, { field = 'TIN', required: isRequired = false } = {}) {
  if (value == null || String(value).trim() === '') {
    return isRequired ? bad('REQUIRED', `${field} is required.`) : ok(null);
  }
  const s = String(value).replace(/[\s-]/g, '');
  if (!/^\d+$/.test(s)) return bad('TIN_FORMAT', `${field} is digits only.`);
  if (s.length < 8 || s.length > 11) {
    return bad('TIN_LENGTH', `${field} should be 8-11 digits as issued by FIRS. You entered ${s.length}.`);
  }
  return ok(s);
}

/** CAC registration: RC/BN/IT followed by digits. */
function cacNumber(value, { field = 'CAC number', required: isRequired = false } = {}) {
  if (value == null || String(value).trim() === '') {
    return isRequired ? bad('REQUIRED', `${field} is required.`) : ok(null);
  }
  const s = String(value).replace(/\s/g, '').toUpperCase();
  if (!/^(RC|BN|IT|LP)?-?\d{4,12}$/.test(s)) {
    return bad('CAC_FORMAT', `${field} looks like RC123456 (a company), BN123456 (a business name) or IT123456 (an incorporated trustee). The RC/BN/IT prefix is optional but the digits are not.`);
  }
  return ok(s.replace(/^(RC|BN|IT|LP)-/, '$1'));
}

/** NIN: 11 digits. */
function nin(value, { field = 'NIN', required: isRequired = false } = {}) {
  if (value == null || String(value).trim() === '') {
    return isRequired ? bad('REQUIRED', `${field} is required.`) : ok(null);
  }
  const s = String(value).replace(/[\s-]/g, '');
  if (!/^\d{11}$/.test(s)) return bad('NIN_FORMAT', `${field} is 11 digits (as printed on the NIN slip). You entered ${s.length}.`);
  return ok(s);
}

/** BVN: 11 digits. This app stores only the last 4 by default. */
function bvn(value, { field = 'BVN', required: isRequired = false, storeLast4Only = true } = {}) {
  if (value == null || String(value).trim() === '') {
    return isRequired ? bad('REQUIRED', `${field} is required.`) : ok(null);
  }
  const s = String(value).replace(/[\s-]/g, '');
  if (!/^\d{11}$/.test(s)) return bad('BVN_FORMAT', `${field} is 11 digits. You entered ${s.length}.`);
  // A BVN is a bank-account identifier. Storing the whole thing in a shop's
  // back-office database is a liability with no operational benefit — the
  // payroll use case needs only enough to confirm identity. Default to last4.
  return ok(storeLast4Only ? s.slice(-4) : s);
}

/** Nigerian bank account number: 10 digits. */
function bankAccount(value, { field = 'Account number', required: isRequired = false } = {}) {
  if (value == null || String(value).trim() === '') {
    return isRequired ? bad('REQUIRED', `${field} is required.`) : ok(null);
  }
  const s = String(value).replace(/[\s-]/g, '');
  if (!/^\d{10}$/.test(s)) return bad('ACCOUNT_FORMAT', `${field} is 10 digits for a Nigerian bank account. You entered ${s.length}.`);
  return ok(s);
}

/**
 * NUBAN check-digit hint — ADVISORY ONLY, and that is a deliberate choice.
 *
 * The published CBN algorithm computes a check digit over the concatenation
 * of the 6-digit zero-padded bank code and the first 9 account digits,
 * weighted 3,7,3,7,... from the left, then (10 - sum mod 10) mod 10.
 *
 * This implementation reproduces that construction, but it is NOT used to
 * reject an account number anywhere in the app, for an honest reason: there
 * is no authoritative public test-vector set for it, and Nigerian banks have
 * issued account numbers under more than one scheme over the years. A check
 * that is right 95% of the time and refuses the other 5% is worse than no
 * check at all here, because the failure mode is a shop unable to record a
 * real supplier's or employee's genuine account — which then gets recorded
 * on paper instead, outside the system entirely.
 *
 * So: compute it, show it as a hint ("this looks mistyped, please confirm"),
 * never gate on it. Callers that want a hard check can pass
 * `{ strict: true }` and accept the consequence themselves.
 */
function validateNuban(accountNumber, bankCode, { strict = false } = {}) {
  const acct = String(accountNumber || '').replace(/\D/g, '');
  const bank = String(bankCode || '').replace(/\D/g, '');
  if (acct.length !== 10) return { valid: false, checked: false, reason: 'A Nigerian bank account number is 10 digits.' };
  if (bank && bank.length !== 3) return { valid: false, checked: false, reason: 'A Nigerian bank code is 3 digits (e.g. 058 for Guaranty Trust).' };
  if (!bank) return { valid: true, checked: false, reason: null };

  const combined = `${bank.padStart(6, '0')}${acct.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < combined.length; i += 1) sum += Number(combined[i]) * (i % 2 === 0 ? 3 : 7);
  const expected = (10 - (sum % 10)) % 10;
  const matches = expected === Number(acct[9]);
  return {
    valid: matches || !strict,
    checked: true,
    expectedCheckDigit: expected,
    reason: matches
      ? null
      : `The NUBAN check digit suggests ${expected}, but the number ends in ${acct[9]}. This often means a transposed digit — please confirm the account number with the bank or the person before paying into it. (This is a hint, not a block: some genuine accounts do not match the published algorithm.)`,
  };
}

/**
 * PIN.
 *
 * 4-8 digits. The MINIMUM of 4 is what makes loginThrottle mandatory rather
 * than optional: a 10,000-value keyspace is exhaustible in minutes without
 * it. The MAXIMUM of 8 is a usability ceiling — a longer numeric PIN on a
 * shop-floor touchscreen slows the queue and gets written on a sticker,
 * which is worse than a short PIN.
 *
 * Rejects the patterns people actually choose when told to pick a number:
 * all-same, straight runs, and the year. Not because those are uncrackable
 * elsewhere, but because the throttle assumes an attacker is guessing and
 * these are the first hundred guesses.
 */
const PIN_MIN_LENGTH = 4;
const PIN_MAX_LENGTH = 8;

function pin(value, { field = 'PIN', confirm = null } = {}) {
  if (value == null || String(value).trim() === '') return bad('REQUIRED', `${field} is required.`);
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) return bad('PIN_NOT_NUMERIC', `${field} must be digits only.`);
  if (s.length < PIN_MIN_LENGTH) return bad('PIN_TOO_SHORT', `${field} must be at least ${PIN_MIN_LENGTH} digits.`);
  if (s.length > PIN_MAX_LENGTH) return bad('PIN_TOO_LONG', `${field} must be ${PIN_MAX_LENGTH} digits or fewer — a longer PIN gets written down, which is worse than a short one.`);
  if (/^(\d)\1+$/.test(s)) return bad('PIN_WEAK', `${field} cannot be one repeated digit. That is the first thing anybody tries.`);
  const ascending = s.split('').every((d, i) => i === 0 || Number(d) === Number(s[i - 1]) + 1);
  const descending = s.split('').every((d, i) => i === 0 || Number(d) === Number(s[i - 1]) - 1);
  if (ascending || descending) return bad('PIN_WEAK', `${field} cannot be a straight run like 1234. It is one of the first few guesses.`);
  const thisYear = String(new Date().getFullYear());
  if (s === thisYear || s === thisYear.slice(2)) return bad('PIN_WEAK', `${field} cannot be the current year.`);
  if (confirm != null && String(confirm).trim() !== s) return bad('PIN_MISMATCH', 'The two PINs do not match.');
  return ok(s);
}

function username(value, { field = 'Username' } = {}) {
  if (value == null || String(value).trim() === '') return bad('REQUIRED', `${field} is required.`);
  const s = String(value).trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(s)) {
    return bad('USERNAME_FORMAT', `${field} must be 3-32 characters using letters, numbers, dot, underscore or hyphen — no spaces. It is what the person types at the counter, so keep it short.`);
  }
  const reserved = ['admin', 'root', 'system', 'null', 'undefined', 'api', 'stockridge'];
  if (reserved.includes(s)) return bad('USERNAME_RESERVED', `"${s}" is reserved. Choose another.`);
  return ok(s);
}

function email(value, { field = 'Email', required: isRequired = false } = {}) {
  if (value == null || String(value).trim() === '') {
    return isRequired ? bad('REQUIRED', `${field} is required.`) : ok(null);
  }
  const s = String(value).trim();
  if (s.length > 254) return bad('TOO_LONG', `${field} is too long.`);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) return bad('EMAIL_FORMAT', `${field} does not look like an email address — it needs one @ and a domain, e.g. name@shop.com.`);
  return ok(s.toLowerCase());
}

/**
 * Barcode. EAN-13/EAN-8/UPC-A check digits are verified when the length
 * matches, because a mistyped barcode silently attaches to the WRONG
 * product and the error only surfaces at the next stocktake.
 */
function barcode(value, { field = 'Barcode', required: isRequired = true } = {}) {
  if (value == null || String(value).trim() === '') {
    return isRequired ? bad('REQUIRED', `${field} is required.`) : ok(null);
  }
  const s = String(value).replace(/[\s-]/g, '');
  if (!/^\d+$/.test(s)) return bad('BARCODE_FORMAT', `${field} is digits only.`);
  if (![8, 12, 13, 14].includes(s.length)) {
    return bad('BARCODE_LENGTH', `${field} should be 8, 12, 13 or 14 digits (EAN-8, UPC-A, EAN-13, ITF-14). You entered ${s.length}.`);
  }
  const check = eanCheckDigit(s.slice(0, -1));
  if (check !== Number(s[s.length - 1])) {
    return bad('BARCODE_CHECK_DIGIT', `${field} fails its check digit — expected ${check} as the last digit, got ${s[s.length - 1]}. It is probably mistyped, and a wrong barcode attaches to the wrong product.`);
  }
  return ok(s);
}

/**
 * EAN / UPC / ITF-14 check digit (GS1 modulo-10).
 *
 * The weighting alternates 3 and 1 across the body, but WHICH one the
 * rightmost body digit gets depends on the body's parity:
 *
 *   body length ODD  (EAN-13, EAN-8, ITF-14) -> rightmost body digit = 3
 *   body length EVEN (UPC-A)                 -> rightmost body digit = 1
 *
 * This is the detail that is easy to get silently wrong in a way that
 * accepts mistyped barcodes and rejects correct ones. Verified against the
 * published GS1 example codes — see test/unit/domain.test.js, which asserts
 * all five formats rather than one.
 */
function eanCheckDigit(digitsWithoutCheck) {
  const digits = String(digitsWithoutCheck).replace(/\D/g, '');
  if (!digits.length) return 0;
  const firstWeight = digits.length % 2 === 1 ? 3 : 1;
  const otherWeight = firstWeight === 3 ? 1 : 3;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    sum += Number(digits[i]) * (i % 2 === 0 ? firstWeight : otherWeight);
  }
  return (10 - (sum % 10)) % 10;
}

/** IMEI: 15 digits with a Luhn check digit. */
function imei(value, { field = 'IMEI', required: isRequired = false } = {}) {
  if (value == null || String(value).trim() === '') {
    return isRequired ? bad('REQUIRED', `${field} is required.`) : ok(null);
  }
  const s = String(value).replace(/[\s-]/g, '');
  if (!/^\d{15}$/.test(s)) return bad('IMEI_LENGTH', `${field} is 15 digits (dial *#06# on the handset to read it). You entered ${s.length}.`);
  if (!luhnValid(s)) return bad('IMEI_CHECK', `${field} fails its Luhn check digit — it is probably mistyped.`);
  return ok(s);
}

function luhnValid(digits) {
  const s = String(digits).replace(/\D/g, '');
  let sum = 0;
  let double = false;
  for (let i = s.length - 1; i >= 0; i -= 1) {
    let d = Number(s[i]);
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Serial number: loose by design, because manufacturers are not consistent. */
function serialNumber(value, { field = 'Serial number', minLength = 4, maxLength = 64, required: isRequired = true } = {}) {
  if (value == null || String(value).trim() === '') {
    return isRequired ? bad('REQUIRED', `${field} is required.`) : ok(null);
  }
  const s = String(value).trim();
  if (s.length < minLength) return bad('SERIAL_TOO_SHORT', `${field} must be at least ${minLength} characters — this is usually printed on a label on the item itself.`);
  if (s.length > maxLength) return bad('SERIAL_TOO_LONG', `${field} must be ${maxLength} characters or fewer.`);
  if (!/^[A-Za-z0-9./\-_ ]+$/.test(s)) return bad('SERIAL_FORMAT', `${field} may contain letters, numbers, spaces, dash, dot, slash and underscore only.`);
  return ok(s.toUpperCase());
}

/**
 * A data: URL that is REALLY an image.
 *
 * Validates by magic bytes, not by the declared MIME type, because the
 * declared type is attacker-controlled and a stored `<script>` inside an
 * "image/svg+xml" data URL executes when the logo is rendered in the
 * topbar of every screen. SVG is therefore REFUSED outright even though it
 * is a legitimate image format — the branding use case does not need it and
 * the risk is not worth it.
 */
const MAX_LOGO_BYTES = 500 * 1024;
const ALLOWED_LOGO_MAGIC = [
  { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', magic: [0x52, 0x49, 0x46, 0x46], extra: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] } },
];

function logoDataUrl(value, { field = 'Logo', maxBytes = MAX_LOGO_BYTES } = {}) {
  if (value == null || String(value).trim() === '') return ok(null);
  const s = String(value).trim();
  if (!s.startsWith('data:')) return bad('LOGO_NOT_DATA_URL', `${field} must be a data: URL produced by the upload control.`);
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(s);
  if (!match) return bad('LOGO_MALFORMED', `${field} is not a valid base64 data URL.`);
  const declaredMime = match[1].toLowerCase();
  if (declaredMime === 'image/svg+xml') {
    return bad('LOGO_SVG_REFUSED', 'SVG logos are refused: an SVG can contain a script, and the logo is rendered on every screen. Export it as PNG or JPEG instead.');
  }
  const base64 = match[2].replace(/\s/g, '');
  const byteLength = Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
  if (byteLength > maxBytes) {
    return bad('LOGO_TOO_LARGE', `${field} is ${(byteLength / 1024).toFixed(0)} KB. The limit is ${(maxBytes / 1024).toFixed(0)} KB — resize it before uploading.`);
  }
  // Decode and sniff magic bytes.
  let bytes;
  try {
    const binary = atob(base64);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  } catch (e) {
    return bad('LOGO_NOT_BASE64', `${field} is not decodable base64.`);
  }
  const matched = ALLOWED_LOGO_MAGIC.find((candidate) => {
    if (!candidate.magic.every((b, i) => bytes[i] === b)) return false;
    if (candidate.extra && !candidate.extra.bytes.every((b, i) => bytes[candidate.extra.offset + i] === b)) return false;
    return true;
  });
  if (!matched) return bad('LOGO_NOT_AN_IMAGE', `${field} does not contain PNG, JPEG, GIF or WebP image data, whatever the declared type says.`);
  if (matched.mime !== declaredMime) {
    return bad('LOGO_MIME_MISMATCH', `${field} claims to be ${declaredMime} but the bytes are ${matched.mime}. Re-export the image.`);
  }
  return ok(s);
}

// ---------------------------------------------------------------------
// COMPOSITE HELPERS
// ---------------------------------------------------------------------

/**
 * Validate a whole body against a spec, collecting every failure.
 *
 * spec: { fieldName: [validatorFn, options] } — returns
 * { ok, values, errors:[{field, code, error}] }
 */
function validateBody(body, spec) {
  const values = {};
  const errors = [];
  for (const field of Object.keys(spec)) {
    const [validator, options] = spec[field];
    const result = validator(body ? body[field] : undefined, { field: fieldLabel(field), ...(options || {}) });
    if (result.ok) values[field] = result.value;
    else errors.push({ field, code: result.code, error: result.error });
  }
  return { ok: errors.length === 0, values, errors };
}

function fieldLabel(field) {
  return String(field).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Turn a validateBody result into the HTTP error the routes throw. */
function validationError(result) {
  const first = result.errors[0];
  const err = new Error(result.errors.length === 1
    ? first.error
    : `${result.errors.length} fields need attention: ${result.errors.map((e) => e.error).join(' ')}`);
  err.status = 400;
  err.code = 'VALIDATION_FAILED';
  err.fields = result.errors;
  return err;
}

module.exports = {
  ok, bad,
  required, optionalString, integer, money, quantity, booleanFlag, oneOf, isoDate,
  nigerianPhone, normalisePhone, tin, cacNumber, nin, bvn, bankAccount, validateNuban,
  pin, PIN_MIN_LENGTH, PIN_MAX_LENGTH, username, email,
  barcode, eanCheckDigit, imei, luhnValid, serialNumber,
  logoDataUrl, MAX_LOGO_BYTES, ALLOWED_LOGO_MAGIC,
  validateBody, validationError, fieldLabel,
  NIGERIAN_MOBILE_PREFIXES,
};
