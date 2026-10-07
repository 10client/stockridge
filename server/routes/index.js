'use strict';
// =====================================================================
// server/routes/index.js — THE API SURFACE
// =====================================================================
// One place that says what the API is. A route module owns a noun; this file
// owns the map. Keeping the map in one file means the whole surface can be
// read top to bottom, which is the only practical way to spot that two modules
// both answer GET /api/stock or that a public endpoint has slipped outside the
// auth guard.
//
// MOUNT ORDER MATTERS, in two ways:
//
//   1. `/api/health` and `/api/auth/login` are mounted BEFORE the auth
//      middleware, because a server that cannot say "I am alive" without a
//      token cannot be health-checked, and a login route guarded by login is a
//      locked door with the key inside.
//   2. `/api/branding` is public for GET (the sign-in screen shows the
//      client's own logo and trading name before anybody has authenticated) but
//      guarded for PUT.
//
// Everything below the guard receives ctx.user and ctx.scope, and every handler
// is expected to scope its own queries — see server/lib/respond.js for why that
// is a shared helper rather than each route's own idea.
// =====================================================================

const { authRequired } = require('../middleware/auth');
const { getSettings, DEFAULT_SETTINGS, assertSubscriptionActive} = require('../../domain/planLimits');

const health = require('./health');
const auth = require('./auth');
const branding = require('./branding');
const admin = require('./admin');
const catalog = require('./catalog');
const stock = require('./stock');
const sales = require('./sales');
const till = require('./till');
const customers = require('./customers');
const finance = require('./finance');
const accounting = require('./accounting');
const reports = require('./reports');
const dashboard = require('./dashboard');
const attendance = require('./attendance');
const afterSales = require('./afterSales');
const compliance = require('./compliance');
const sync = require('./sync');
const dataManagement = require('./dataManagement');
const changeOwed = require('./changeOwed');
const userTransfers = require('./userTransfers');

/**
 * The complete set of endpoints reachable without a token.
 *
 * Matched on method AND exact path (plus a prefix only where a subtree is
 * genuinely public), so a new route can never become public by accident — the
 * default is guarded, and being unguarded requires an entry here.
 *
 *   /api/auth/login     a login route guarded by login is a locked door with the
 *                       key inside; it has its own throttle instead.
 *   /api/health*        so the process can be health-checked by a load balancer
 *                       or an uptime monitor that holds no credentials.
 *   /api/manifest.json  the PWA manifest is fetched by the browser before any
 *                       JavaScript of ours has run.
 *   GET /api/branding   the sign-in screen shows the client's own logo and
 *                       trading name BEFORE anybody has authenticated. PUT is
 *                       guarded separately by branding.mountGuarded.
 */
const PUBLIC_PATHS = [
  { method: 'POST', match: (p) => p === '/api/auth/login' },
  { method: 'GET', match: (p) => p === '/api/health' || p.startsWith('/api/health/') },
  { method: 'GET', match: (p) => p === '/api/manifest.json' },
  { method: 'GET', match: (p) => p === '/api/branding' },
];

/**
 * Paths that must answer even when the database is unreachable.
 *
 * Liveness takes no database access at all; readiness performs its own, inside
 * a try/catch, so that it can name the fault. Both are exempt from the settings
 * middleware for that reason and no other.
 */
function isHealthPath(pathname) {
  const p = String(pathname || '');
  return p === '/api/health' || p === '/api/health/ready' || p === '/health' || p === '/health/ready';
}

function isPublicPath(method, path) {
  const clean = String(path || '').replace(/\/+$/, '') || '/';
  return PUBLIC_PATHS.some((r) => r.method === String(method).toUpperCase() && r.match(clean));
}

/**
 * WHAT A SUSPENDED SUBSCRIPTION STOPS — AND WHAT IT MUST NOT.
 *
 * `assertSubscriptionActive` has always been the intent ("blocks every mutating
 * request when the subscription is SUSPENDED or EXPIRED; READ access is
 * deliberately preserved"), and it was wired to three routes: create business,
 * create branch, create staff. So a client who stopped paying kept ringing
 * sales, receiving stock, paying suppliers and posting journals — the only thing
 * they could not do was add a fourth branch. The vendor's one real lever did
 * nothing to the thing the invoice is for.
 *
 * The gate now runs in the pipeline, so a new route is covered the day it is
 * written rather than the day somebody remembers. Being reachable while
 * suspended therefore requires an entry below, and every entry has to say why:
 * the default is closed, exactly as it is for the public-path list above.
 *
 * The shape of the line: **everything that moves money or stock stops;
 * everything about running the business as an organisation stays open.** A
 * suspended shop still has staff who clock in, a lost phone to revoke, licences
 * to record, an alert board to clear, a queue on a tablet to report, a sacked
 * cashier to disable, and a contact number the vendor is about to ring.
 */
const SUSPENDED_EXEMPT = [
  {
    match: (m, p) => p.startsWith('/api/auth/'),
    why: 'the door, not the trading: signing in, signing out, changing your own PIN, unlocking a seat',
  },
  {
    match: (m, p) => p.startsWith('/api/sync/'),
    why: 'a device that has been off the network has to report what it did and hear back per operation; each replayed sale is refused on its own way through this same pipeline, and the refusal is what the device shows the shop',
  },
  {
    match: (m, p) => p.startsWith('/api/notifications/'),
    why: 'clearing an alert is not discharging it — and the board is how they hear that service was suspended',
  },
  {
    match: (m, p) => p === '/api/users' || p.startsWith('/api/users/'),
    why: 'people and permissions, not money: a suspended shop must still be able to sack a cashier, move staff between branches and reset a PIN, which is also the only way the vendor can help them',
  },
  {
    match: (m, p) => p.startsWith('/api/sessions/'),
    why: 'revoking a lost or stolen device is security, and it has to work precisely when nobody is answering the telephone',
  },
  {
    match: (m, p) => p.startsWith('/api/attendance/'),
    why: 'shifts are people, not money — blocking a clock-in files a payroll gap over an unpaid invoice',
  },
  {
    match: (m, p) => p.startsWith('/api/compliance/'),
    why: 'a statutory register is a legal obligation, not a sale',
  },
  {
    match: (m, p) => m === 'PUT' && p === '/api/settings',
    why: 'their own configuration, including the contact line the vendor is about to ring. The six commercial fields stay ADMIN-only at every status (see PUT /api/settings), so this cannot be used to lift a suspension',
  },
  {
    match: (m, p) => p === '/api/sales/preview',
    why: 'a preview creates nothing: reads continue, and a cashier should read the refusal when they try to complete the sale rather than at the first scan of a customer’s basket',
  },
  {
    match: (m, p) => p === '/api/data-management/purge/preview',
    why: 'a preview creates nothing',
  },
];

/** Only GET/HEAD/OPTIONS are reads. Nothing else is exempt by method alone. */
function isReadMethod(method) {
  const m = String(method || 'GET').toUpperCase();
  return m === 'GET' || m === 'HEAD' || m === 'OPTIONS';
}

function exemptionFor(method, path) {
  const m = String(method || '').toUpperCase();
  const p = String(path || '').replace(/\/+$/, '') || '/';
  return SUSPENDED_EXEMPT.find((r) => r.match(m, p)) || null;
}

/**
 * Build the whole API onto an app.
 *
 * `env` carries the database, the JWT secret and the settings row. Routes read
 * them from `ctx.env` rather than closing over them, so the identical route
 * modules work under Workers where the bindings arrive per-request.
 */
function buildRoutes(app, env = {}) {
  // The app is placed in env so the sync module can replay a queued operation
  // through the real router. Without it, sync would have to call the services
  // directly — a second entry point that bypasses the auth guard, the settings
  // load and the idempotency wrapper, i.e. exactly the guarantees that make an
  // offline sale safe.
  const makeEnv = (ctx) => Object.assign({}, env, ctx.env || {}, { app });

  // ---- PUBLIC (no token) -------------------------------------------------
  health.mount(app, '/api');
  auth.mount(app, '/api/auth', makeEnv);
  branding.mountPublic(app, '/api/branding');

  // ---- AUTH GUARD --------------------------------------------------------
  // A single middleware for everything below. `authRequired` re-reads the live
  // user row on every request rather than trusting the token's claims, so
  // deactivating a user or moving them to another branch takes effect on their
  // NEXT request instead of at token expiry — which for a 12-hour token is the
  // difference between a sacked cashier losing access at 6pm and losing it now.
  //
  // THE PUBLIC LIST IS EXPLICIT, AND THAT IS DELIBERATE.
  //
  // This router runs every path-matching middleware BEFORE route dispatch, so
  // mounting `health` and `auth` above the guard does NOT exempt them — the
  // guard still applies to /api/auth/login and the door locks from the inside.
  // Relying on registration order for a security boundary is the kind of thing
  // that works in one router and silently fails in another (and did, here). So
  // the exempt paths are written down, matched exactly, and covered by a test.
  app.use('/api/*', async (ctx, next) => {
    ctx.env = makeEnv(ctx);
    if (isPublicPath(ctx.method, ctx.path)) return next();
    await authRequired({ secret: ctx.env.JWT_SECRET || ctx.env.jwtSecret })(ctx, next);
  });

  // Refresh the settings row per request. It is one indexed read of a single
  // row, and caching it would mean an owner changing their VAT rate or a staff
  // permission would not take effect until a restart — on a shop floor that
  // reads as "the setting did nothing".
  //
  // IT MUST NOT BE ABLE TO FAIL THE HEALTH ENDPOINTS.
  //
  // This middleware runs before route dispatch, so a database that is down or
  // unmigrated used to make `getSettings` throw and every /api/* path answer an
  // opaque 500 — including /api/health, the one endpoint written to say WHY
  // nothing works. A liveness probe that only answers when the database answers
  // tells an operator nothing and restarts a server that was healthy. So the
  // health paths skip the settings load entirely (their handler reports the
  // fault itself), and every other path falls back to defaults rather than
  // failing, with the reason logged.
  app.use('/api/*', async (ctx, next) => {
    if (isHealthPath(ctx.path)) return next();
    const db = ctx.env.DB || ctx.env.db;
    try {
      ctx.set('settings', await getSettings(db));
    } catch (e) {
      // Defaults keep the request alive; a route that needs real settings will
      // fail loudly on its own terms rather than through a middleware 500.
      ctx.set('settings', { ...DEFAULT_SETTINGS });
      ctx.set('settingsError', e.message);
      console.error(`[routes] settings could not be loaded, using defaults: ${e.message}`);
    }
    return next();
  });

  // EVERY MUTATING REQUEST PASSES THE SUBSCRIPTION GATE.
  //
  // Here rather than inside each route, for the same reason the auth guard is
  // here: a rule enforced at 97 call sites is a rule that will be missing from
  // the 98th. `assertSubscriptionActive` throws 402 `SUBSCRIPTION_NOT_ACTIVE`
  // with the client's contact line in it, and returns early for ADMIN — the
  // vendor is never locked out of the instance they are trying to help.
  app.use('/api/*', async (ctx, next) => {
    if (isReadMethod(ctx.method)) return next();
    if (isHealthPath(ctx.path)) return next();
    if (isPublicPath(ctx.method, ctx.path)) return next();
    if (exemptionFor(ctx.method, ctx.path)) return next();
    assertSubscriptionActive(ctx.get('settings'), ctx.get('user'));
    return next();
  });

  // ---- GUARDED -----------------------------------------------------------
  branding.mountGuarded(app, '/api/branding');
  // BEFORE `admin`, because these paths live under /api/users/... and belong to the
  // same resource: whoever registers first matches first, and the transfer routes are
  // the more specific ones.
  userTransfers.mount(app, '/api');
  admin.mount(app, '/api');
  catalog.mount(app, '/api');
  stock.mount(app, '/api');
  sales.mount(app, '/api');
  till.mount(app, '/api');
  customers.mount(app, '/api');
  finance.mount(app, '/api');
  accounting.mount(app, '/api');
  reports.mount(app, '/api');
  dashboard.mount(app, '/api');
  attendance.mount(app, '/api');
  afterSales.mount(app, '/api');
  compliance.mount(app, '/api');
  sync.mount(app, '/api');
  dataManagement.mount(app, '/api');
  changeOwed.mount(app, '/api');

  // ---- 404 shape ---------------------------------------------------------
  app.notFound((ctx) => {
    ctx.json({
      error: `There is no ${ctx.method} ${ctx.path} endpoint on this API.`,
      code: 'NOT_FOUND',
      // A hint, because the most common cause of a 404 during development is a
      // client calling a path that was renamed, and the message is the only
      // place to say so.
      hint: ctx.path.startsWith('/api') ? undefined : 'API routes live under /api. Everything else is served from public/.',
    }, 404);
  });

  return app;
}

module.exports = { buildRoutes, isPublicPath, PUBLIC_PATHS, SUSPENDED_EXEMPT, exemptionFor, isReadMethod };
