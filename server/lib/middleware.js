// =====================================================================
// StockRidge — REQUEST MIDDLEWARE
// =====================================================================
// Authentication, business-unit resolution and idempotency, applied once per
// route group rather than remembered per route. A guard that has to be
// remembered is a guard that will be forgotten, and one forgotten guard on one
// route is a hole in the whole product.
//
// PUBLIC ROUTES are an explicit allowlist. Everything else requires a token.
// The default is closed: a new route added without thought is protected, and
// making it public is a deliberate act in one visible list.
// =====================================================================

const { HttpError } = require('./http');
const auth = require('./auth');
const { newId } = require('../../shared/ids');
const { getUnitSettings } = require('./planLimits');

const PUBLIC_PATHS = Object.freeze([
  '/api/health',
  '/api/branding',
  '/api/auth/login',
  '/api/auth/business-codes',
]);

function isPublic(pathname, method) {
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    // /api/branding/:id/logo must stay public (the login screen renders it
    // before anyone has signed in); nothing else under a public prefix does.
    if (pathname.startsWith('/api/branding/')) return /\/logo$/.test(pathname);
    return true;
  }
  return false;
}

function bearerToken(ctx) {
  const h = ctx.req.header('Authorization') || ctx.req.header('authorization') || '';
  if (/^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  // The PWA also sends its token in a custom header, because a service-worker
  // replayed request from the offline queue cannot always reconstruct an
  // Authorization header on every browser.
  return ctx.req.header('X-StockRidge-Token') || ctx.req.header('x-stockridge-token') || null;
}

function authMiddleware({ requireDb }) {
  return async function authenticate(ctx) {
    ctx.var.requestId = newId().slice(0, 12);
    const path = ctx.req.path;
    const method = ctx.req.method;

    if (isPublic(path, method)) return;

    const token = bearerToken(ctx);
    if (!token) {
      throw new HttpError(401, 'Sign in to continue.', 'UNAUTHENTICATED');
    }

    // Which business is this request for? Explicit header/query wins; then the
    // session's own unit. A user with access to several units must say which
    // one they mean, because silently defaulting to the first would show one
    // company's cash under another's name.
    const requestedUnit = ctx.req.header('X-Business-Unit') || ctx.req.header('x-business-unit') || ctx.req.query('business_unit_id') || null;

    const db = requireDb();
    const session = await auth.authenticate(db, token, {
      requestUnitId: requestedUnit,
      deviceId: ctx.req.header('X-Device-Id') || ctx.req.header('x-device-id') || null,
      ipAddress: ctx.req.ip,
    });
    if (!session) {
      throw new HttpError(401,
        'Your session has ended or expired. Sign in again — for security a session also ends after a period of inactivity, so a till left signed in overnight does not stay usable.',
        'SESSION_INVALID');
    }

    const unitIds = await auth.accessibleUnitIds(db, session.user);
    if (!unitIds.length) {
      throw new HttpError(403, 'Your account is not attached to any business. Ask an administrator.', 'NO_BUSINESS_ACCESS');
    }

    let unitId = session.businessUnitId;
    if (requestedUnit) {
      if (!unitIds.includes(requestedUnit)) {
        throw new HttpError(403, 'You do not have access to that business.', 'UNIT_ACCESS_DENIED');
      }
      unitId = requestedUnit;
    }
    if (!unitId || !unitIds.includes(unitId)) {
      if (unitIds.length === 1) unitId = unitIds[0];
      else {
        // Several units, none chosen: ask rather than guess. Guessing would
        // show one company's figures under another's branding.
        const e = new HttpError(400, 'Choose which business to work in.', 'BUSINESS_UNIT_REQUIRED');
        e.details = { available_business_units: unitIds };
        throw e;
      }
    }

    // Effective role within THIS unit. A user who is OWNER of one business and
    // MANAGER of another must never carry the higher role across.
    const effectiveRole = await auth.effectiveRoleInUnit(db, session.user, unitId);
    if (!effectiveRole) {
      throw new HttpError(403, 'You do not have access to that business.', 'UNIT_ACCESS_DENIED');
    }

    const businessUnit = await getUnitSettings(db, unitId);
    if (businessUnit.missing) {
      throw new HttpError(404, 'That business was not found.', 'BUSINESS_UNIT_NOT_FOUND');
    }
    if (!businessUnit.is_active && effectiveRole !== 'ADMIN') {
      throw new HttpError(403, 'This business is not active. Contact your account administrator.', 'BUSINESS_UNIT_INACTIVE');
    }

    // A pinned user's branch must belong to the unit they are working in.
    // Without this, switching unit context could carry a branch scope from the
    // other business into the query.
    const user = { ...session.user, role: effectiveRole };
    if (user.branch_id) {
      const branch = await db.prepare('SELECT business_unit_id FROM branches WHERE id = ? AND is_deleted = 0').bind(user.branch_id).first();
      if (!branch || branch.business_unit_id !== unitId) user.branch_id = null;
    }

    ctx.var.user = user;
    ctx.var.session = session.session;
    ctx.var.token = token;
    ctx.var.businessUnitId = unitId;
    ctx.var.businessUnit = businessUnit;
    ctx.var.accessibleUnitIds = unitIds;
    ctx.var.deviceId = ctx.req.header('X-Device-Id') || ctx.req.header('x-device-id') || session.deviceId || null;
    ctx.var.ipAddress = ctx.req.ip;
    ctx.var.userAgent = ctx.req.userAgent;
    ctx.db = db;

    // A convenient shape for services: they need user + unit + branch + device.
    ctx.serviceCtx = {
      user,
      businessUnitId: unitId,
      businessUnit,
      deviceId: ctx.var.deviceId,
      ipAddress: ctx.var.ipAddress,
      userAgent: ctx.var.userAgent,
      requestId: ctx.var.requestId,
    };
  };
}

// Rate limiting for the expensive and abusable endpoints. Deliberately simple
// and in-process: a single-node deployment (the common case for this product)
// does not need a distributed counter, and a distributed one that is wrong is
// worse than a local one that is honest about its scope.
function rateLimit({ windowMs = 60000, max = 120, keyFn = null } = {}) {
  const buckets = new Map();
  return async function limit(ctx) {
    const key = keyFn ? keyFn(ctx) : `${ctx.var.ipAddress || 'unknown'}:${ctx.req.path}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.start > windowMs) {
      bucket = { start: now, count: 0 };
      buckets.set(key, bucket);
      // Opportunistic cleanup: without it a long-running process accumulates a
      // bucket per IP per path forever.
      if (buckets.size > 5000) {
        for (const [k, v] of buckets) if (now - v.start > windowMs * 4) buckets.delete(k);
      }
    }
    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfter = Math.ceil((windowMs - (now - bucket.start)) / 1000);
      const e = new HttpError(429, `Too many requests. Try again in about ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`, 'RATE_LIMITED');
      e.retryAfterSeconds = retryAfter;
      throw e;
    }
  };
}

module.exports = { PUBLIC_PATHS, isPublic, bearerToken, authMiddleware, rateLimit };
'use strict';
