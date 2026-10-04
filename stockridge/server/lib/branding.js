// =====================================================================
// StockRidge — BRANDING (white-label)
// =====================================================================
// Every deployment shows the CLIENT's own business name and logo — in the
// topbar, on the login screen, in the browser tab title, on printed
// receipts and in the PWA install manifest — not the "StockRidge" software
// product name. A shop in Kano does not want its customers installing an
// app with someone else's brand on the home screen.
//
// /api/branding is PUBLIC and unauthenticated, because the login screen
// needs the name and logo before anyone has signed in. It therefore
// discloses the business name and nothing else: no address, no phone, no
// plan, no staff. What is on the door of the shop is what is in this
// response.
//
// /api/branding/logo serves the decoded image BYTES with a real
// Content-Type, because a browser needs a same-origin image URL for <img>
// and for manifest icons — a multi-hundred-kilobyte data: URI repeated
// across every icon size is both slow and rejected by some install flows.
// =====================================================================

const { HttpError } = require('./http');

const MAX_LOGO_BYTES = 500 * 1024;          // 500 KB hard cap
const ALLOWED_LOGO_TYPES = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
});

// Real magic-byte sniffing, not the declared MIME type. A data: URL's
// declared type is attacker-controlled text; the first bytes are not. This
// is the difference between "we accept PNG" and "we accept whatever the
// caller says", and it is what stops an HTML/JS payload being stored and
// then served back with Content-Type: image/svg+xml — an SVG is XML and can
// carry script, so an unvalidated SVG upload is a stored-XSS vector on
// every screen that renders the logo.
function sniffImageType(base64) {
  const buf = Buffer.from(String(base64).slice(0, 64), 'base64');
  if (buf.length >= 8
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  const head = buf.toString('utf8', 0, Math.min(buf.length, 64)).replace(/\s+/g, '');
  if (/^<\?xml/i.test(head) || /^<svg/i.test(head)) return 'image/svg+xml';
  return null;
}

function assertValidLogoDataUrl(dataUrl) {
  if (dataUrl == null || dataUrl === '') return null;          // clearing the logo is allowed
  if (typeof dataUrl !== 'string') {
    throw new HttpError(400, 'The logo must be provided as a data: URL string.', 'LOGO_INVALID');
  }
  const m = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
  if (!m) {
    throw new HttpError(400,
      'The logo must be a base64 data: URL, e.g. data:image/png;base64,iVBORw0K... A file path or http:// URL is not accepted.',
      'LOGO_INVALID_FORMAT');
  }
  const base64 = m[2].replace(/\s+/g, '');
  const byteLength = Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
  if (byteLength > MAX_LOGO_BYTES) {
    throw new HttpError(413,
      `That logo is about ${Math.round(byteLength / 1024)} KB. The limit is ${Math.round(MAX_LOGO_BYTES / 1024)} KB — export it smaller or as PNG/WebP.`,
      'LOGO_TOO_LARGE');
  }
  const actualType = sniffImageType(base64);
  if (!actualType) {
    throw new HttpError(400,
      'That file is not a recognisable PNG, JPEG, WebP or SVG image. The declared type is checked against the actual file contents.',
      'LOGO_NOT_AN_IMAGE');
  }
  const declared = m[1].toLowerCase();
  if (declared !== actualType) {
    // Mismatch is rejected rather than silently corrected: a caller who
    // declares the wrong type is either confused or probing, and either way
    // the stored value should be what the file actually is.
    throw new HttpError(400,
      `That file is actually ${actualType} but was declared as ${declared}. Re-save it and try again.`,
      'LOGO_TYPE_MISMATCH');
  }
  if (actualType === 'image/svg+xml') {
    // An SVG is XML and may carry <script>, event handlers and external
    // references. Since it is served same-origin, sanitising is not
    // optional. Refusing is simpler and safer than shipping a partial
    // sanitiser that misses one attribute.
    const svg = Buffer.from(base64, 'base64').toString('utf8');
    if (/<script|on\w+\s*=|javascript:|<foreignObject|<use\s[^>]*href\s*=\s*["']?data:/i.test(svg)) {
      throw new HttpError(400,
        'That SVG contains script or event handlers and cannot be used as a logo. Export a PNG or WebP instead, or save a plain SVG without scripting.',
        'LOGO_SVG_UNSAFE');
    }
    if (/(href|xlink:href)\s*=\s*["']?(https?:)?\/\//i.test(svg)) {
      throw new HttpError(400,
        'That SVG references an external resource, which would make the logo depend on a third-party server. Export a PNG or WebP instead.',
        'LOGO_SVG_EXTERNAL_REF');
    }
  }
  return { dataUrl: `data:${actualType};base64,${base64}`, type: actualType, byteLength };
}

function decodeLogo(dataUrl) {
  if (!dataUrl) return null;
  const m = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(String(dataUrl).trim());
  if (!m) return null;
  return { type: m[1].toLowerCase(), bytes: Buffer.from(m[2], 'base64') };
}

const DEFAULT_BRAND = Object.freeze({
  name: 'StockRidge',
  tagline: 'Multi-branch stock, sales & back office',
  accent: '#0f766e',
  logo: null,
  logo_type: null,
});

// What the public branding endpoint may disclose. Explicit allowlist rather
// than a spread of the row: a new sensitive column added to business_units
// must not become public by accident.
function publicBranding(unit) {
  if (!unit) return { ...DEFAULT_BRAND, is_default: true };
  return {
    name: unit.name || DEFAULT_BRAND.name,
    legal_name: unit.legal_name || null,
    code: unit.code || null,
    industry_profile: unit.industry_profile || null,
    tagline: DEFAULT_BRAND.tagline,
    accent: DEFAULT_BRAND.accent,
    has_logo: !!unit.logo_data_url,
    // The logo URL is a route, not a data URI: see the header comment.
    logo_url: unit.logo_data_url ? `/api/branding/${unit.id}/logo` : null,
    is_default: false,
  };
}

// What the authenticated app may see (includes the data URL for the Admin
// Portal's own preview).
function internalBranding(unit) {
  const pub = publicBranding(unit);
  return { ...pub, logo_data_url: unit && unit.logo_data_url ? unit.logo_data_url : null };
}

module.exports = {
  MAX_LOGO_BYTES, ALLOWED_LOGO_TYPES, DEFAULT_BRAND,
  sniffImageType, assertValidLogoDataUrl, decodeLogo,
  publicBranding, internalBranding,
};
'use strict';
