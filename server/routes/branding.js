'use strict';
// =====================================================================
// server/routes/branding.js — WHITE-LABELLING
// =====================================================================
// GET is PUBLIC, PUT is guarded. That split is not laziness:
//
// The sign-in screen shows the client's own trading name and logo BEFORE
// anybody has authenticated — a cashier at "Ridge Furniture Palace" should see
// their shop's name, not the vendor's. If GET required a token, the login page
// could not be branded, and a white-label product that shows someone else's
// brand at the front door is not white-labelled.
//
// What GET returns is therefore deliberately tiny: a name, a logo and two
// colours. No plan limits, no contact details, no feature toggles — those are
// inside the guarded /api/auth/me response where they belong.
//
// PUT is OWNER or ADMIN. Letting a manager rename the shop would let one branch
// rebrand the whole deployment, including every other branch's receipts.
// =====================================================================

const { HttpError } = require('../lib/http');
const { recordFromCtx } = require('../lib/audit');
const { logoDataUrl, MAX_LOGO_BYTES } = require('../../domain/validation');
const { atLeast } = require('../../domain/roles');
const { requireField } = require('../lib/respond');

/** The public face of the deployment. Safe to call with no token. */
async function publicBranding(db) {
  // THE FALLBACK READ THE COLUMN IT FALLS BACK TO. This query selected three fields and the
  // next line used a fourth — `row.primary_business_id` — which was therefore always
  // `undefined`. The lookup it feeds returned nothing, so a deployment that had not yet typed
  // a trading name showed the VENDOR'S name at the front door: `name` fell through to the
  // literal 'StockRidge' while `businesses` held "Ridge Electronics Ltd". The one screen that
  // exists to carry the client's brand carried somebody else's, and only in the state where it
  // matters most — a fresh deployment, the day it is handed over. Proven by blanking
  // `business_name` on a copy of the database and reading the endpoint.
  const row = await db.first('SELECT business_name, logo_data_url, receipt_footer_text, primary_business_id FROM client_settings WHERE id = 1').catch(() => null);
  const primary = row && row.primary_business_id ? await db.first('SELECT name FROM businesses WHERE id = ?', [row.primary_business_id]).catch(() => null) : null;
  return {
    name: (row && row.business_name) || (primary && primary.name) || 'StockRidge',
    logoDataUrl: (row && row.logo_data_url) || null,
    receiptFooter: (row && row.receipt_footer_text) || null,
    // A vendor mark, kept separate from the client's own name so the UI can show
    // "Powered by StockRidge" without competing with the shop's brand.
    poweredBy: 'StockRidge',
  };
}

function mountPublic(app, base = '/api/branding') {
  app.get(base, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    ctx.header('Cache-Control', 'public, max-age=300');
    ctx.json({ ok: true, ...(await publicBranding(db)) });
  });
}

function mountGuarded(app, base = '/api/branding') {
  /** The full branding record, for the settings screen. */
  app.get(`${base}/full`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'MANAGER')) throw new HttpError('Only a manager or above can review the branding settings.', { status: 403, code: 'ROLE_REQUIRED' });
    const row = await db.first('SELECT business_name, logo_data_url, receipt_footer_text, admin_contact_name, admin_contact_phone, admin_contact_email FROM client_settings WHERE id = 1');
    ctx.json({ ok: true, ...(await publicBranding(db)), admin: row ? {
      contactName: row.admin_contact_name, contactPhone: row.admin_contact_phone, contactEmail: row.admin_contact_email,
      receiptFooter: row.receipt_footer_text,
    } : null });
  });

  /** Update the trading name, receipt footer and vendor contact details. */
  app.put(base, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'OWNER')) {
      // An owner-level decision: this renames the deployment for EVERY branch
      // and every receipt. A manager who could do it could rebrand a shop they
      // do not own.
      throw new HttpError('Only the owner or an administrator can change the trading name or branding.', { status: 403, code: 'ROLE_REQUIRED' });
    }
    const body = await ctx.req.json();
    const before = await db.first('SELECT * FROM client_settings WHERE id = 1');
    if (!before) throw new HttpError('This deployment has not been provisioned yet.', { status: 409, code: 'NOT_PROVISIONED' });

    const updates = [];
    const params = [];
    const allow = {
      // `String(null)` IS THE STRING "null", and this line used to store it. A client that sent
      // `business_name: null` — which is how a JSON body says "no name" — renamed the shop to
      // the word "null" on every receipt and on the sign-in screen. An absent value is refused
      // like a blank one now, and neither can become a name.
      business_name: (v) => { const s = v == null ? '' : String(v).trim(); if (!s) throw new HttpError('The trading name cannot be blank.', { status: 400, code: 'MISSING_FIELD' }); if (s.length > 120) throw new HttpError('Keep the trading name under 120 characters — it has to fit a receipt header.', { status: 400, code: 'TOO_LONG' }); return s; },
      receipt_footer_text: (v) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, 500)),
      admin_contact_name: (v) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, 120)),
      admin_contact_phone: (v) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, 40)),
      admin_contact_email: (v) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, 160)),
    };
    for (const [field, clean] of Object.entries(allow)) {
      if (body[field] !== undefined) { updates.push(`${field} = ?`); params.push(clean(body[field])); }
    }
    if (!updates.length) throw new HttpError('Nothing to update. Send at least one of: business_name, receipt_footer_text, admin_contact_name, admin_contact_phone, admin_contact_email.', { status: 400, code: 'NOTHING_TO_UPDATE' });

    updates.push("updated_at = datetime('now')");
    updates.push('updated_by = ?'); params.push(String(user.id));
    params.push(1);
    await db.run(`UPDATE client_settings SET ${updates.join(', ')} WHERE id = ?`, params);

    await recordFromCtx(ctx, { action: 'BRANDING_UPDATED', entityType: 'CLIENT_SETTINGS', entityId: '1', before: redact(before), after: redact(body) });
    ctx.json({ ok: true, message: 'Branding updated. The sign-in screen and new receipts pick this up immediately.', ...(await publicBranding(db)) });
  });

  /**
   * Upload the logo as a data URL.
   *
   * VALIDATED BY MAGIC BYTES, NOT BY THE CLAIMED MIME TYPE. A browser tells the
   * truth about a file it read from disk, but a crafted request can claim
   * `image/png` for anything. Since this value is later injected into an <img
   * src>, an SVG carrying a script would run in the context of the settings
   * page — so the bytes are sniffed against an allowlist that deliberately
   * excludes SVG, and the size is capped.
   */
  app.post(`${base}/logo`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'OWNER')) throw new HttpError('Only the owner or an administrator can change the logo.', { status: 403, code: 'ROLE_REQUIRED' });

    const body = await ctx.req.json();
    const value = requireField(body, 'logoDataUrl', 'Logo');
    const check = logoDataUrl(String(value));
    if (!check.ok) throw new HttpError(check.error, { status: 400, code: check.code, fields: { logoDataUrl: check.error } });

    await db.run("UPDATE client_settings SET logo_data_url = ?, updated_at = datetime('now'), updated_by = ? WHERE id = 1", [check.value, String(user.id)]);
    await recordFromCtx(ctx, { action: 'BRANDING_UPDATED', entityType: 'CLIENT_SETTINGS', entityId: '1', after: { logoBytes: Math.round(String(check.value).length * 0.75) } });

    ctx.json({
      ok: true,
      message: `Logo updated (${Math.round(String(check.value).length * 0.75 / 1024)} KB of the ${Math.round(MAX_LOGO_BYTES / 1024)} KB limit).`,
      logoDataUrl: check.value,
    });
  });

  /** Remove the logo, reverting to the wordmark. */
  app.delete(`${base}/logo`, async (ctx) => {
    const db = ctx.env.DB || ctx.env.db;
    const user = ctx.get('user');
    if (!atLeast(user.role, 'OWNER')) throw new HttpError('Only the owner or an administrator can change the logo.', { status: 403, code: 'ROLE_REQUIRED' });
    await db.run("UPDATE client_settings SET logo_data_url = NULL, updated_at = datetime('now'), updated_by = ? WHERE id = 1", [String(user.id)]);
    await recordFromCtx(ctx, { action: 'BRANDING_UPDATED', entityType: 'CLIENT_SETTINGS', entityId: '1', after: { logoDataUrl: null } });
    ctx.json({ ok: true, message: 'Logo removed. The wordmark will be used instead.' });
  });
}

/** Keep a settings snapshot out of the audit log's way: the logo is hundreds of KB. */
function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = k === 'logo_data_url' && v ? `[${Math.round(String(v).length * 0.75 / 1024)} KB image]` : v;
  }
  return out;
}

module.exports = { mountPublic, mountGuarded, publicBranding };
