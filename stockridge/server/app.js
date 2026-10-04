// =====================================================================
// server/app.js — THE NODE BACKEND
// =====================================================================
// Boots the database, authenticates, routes, and serves the PWA. No framework:
// node:http plus the router in server/lib/http.js. A shop deploying this on a
// small VPS should not need a native build step or a dependency tree to open
// its till, and every dependency that fails to install is a shop that cannot
// trade.
//
// STARTUP ORDER MATTERS, and each step says why:
//   1. resolve config      — one source of truth, validated, frozen
//   2. open the database   — better-sqlite3 if available, sql.js otherwise
//   3. migrate             — and REFUSE to start on a schema mismatch
//   4. seed if empty       — only when explicitly enabled
//   5. verify the ledger   — a trial balance that does not balance is reported
//                            at boot, not discovered at month end
//   6. listen              — and only then accept traffic
//
// Binding before the migration completes would serve requests against a
// half-built schema, which produces errors that look like data corruption.

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig, getConfig } = require('./lib/config');
const { openDatabase } = require('./db/adapter');
const { migrate } = require('../tools/migrate');
const { createHandler, json } = require('./lib/http');
const auth = require('./lib/auth');
const scopeLib = require('./lib/scope');
const { buildRoutes } = require('./routes');
const core = require('../shared/services/coreService');
const gl = require('../shared/services/glService');
const TG = require('../shared/lib/timegeo');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

// ---------------------------------------------------------------------
// static file serving
// ---------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Serve a file from public/, or false if it does not exist.
 *
 * Path traversal is prevented by resolving and then verifying that the result is
 * still inside PUBLIC_DIR. `decodeURIComponent` runs BEFORE the check, because
 * `%2e%2e%2f` decodes to `../` and a check on the encoded string would pass.
 */
function serveStatic(req, res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch (e) { return false; }
  if (rel.includes('\0')) return false;
  const resolved = path.resolve(PUBLIC_DIR, `.${path.posix.normalize(rel)}`);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep) && resolved !== PUBLIC_DIR) return false;

  let target = resolved;
  try {
    const st = fs.statSync(target);
    if (st.isDirectory()) target = path.join(target, 'index.html');
  } catch (e) {
    return false;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return false;

  const ext = path.extname(target).toLowerCase();
  const body = fs.readFileSync(target);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    // The service worker versions its own cache, so HTML must never be cached
    // or a client can be stuck on an old shell with new assets. Assets are
    // content-addressed by the SW, so they can be cached hard.
    'Cache-Control': ext === '.html' || target.endsWith('sw.js') || target.endsWith('manifest.json')
      ? 'no-cache, must-revalidate'
      : 'public, max-age=86400',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

// ---------------------------------------------------------------------
// authentication middleware
// ---------------------------------------------------------------------
function makeAuthenticator(db, config) {
  return async function authenticate(req) {
    const token = auth.extractToken(req);
    if (!token) {
      throw Object.assign(new Error('Sign in to continue.'), { status: 401, code: 'UNAUTHENTICATED' });
    }
    const verified = auth.verifyToken(token, {
      secret: config.jwt.secret, issuer: config.jwt.issuer, audience: config.jwt.audience,
    });
    if (!verified.valid) {
      const messages = {
        expired: 'Your session has expired. Sign in again.',
        bad_signature: 'This session token is not valid. Sign in again.',
        missing: 'Sign in to continue.',
      };
      throw Object.assign(new Error(messages[verified.reason] || 'This session token is not valid. Sign in again.'),
        { status: 401, code: verified.reason === 'expired' ? 'SESSION_EXPIRED' : 'INVALID_TOKEN' });
    }

    // The token carries the role and scope as a SNAPSHOT. The database is
    // authoritative: a user deactivated or demoted five minutes ago must not
    // keep operating on a token minted before the change.
    const session = await db.prepare(
      "SELECT * FROM user_sessions WHERE session_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')"
    ).bind(verified.payload.sid).first();
    if (!session) {
      throw Object.assign(new Error('This session has been signed out. Sign in again.'), { status: 401, code: 'SESSION_REVOKED' });
    }
    const user = await db.prepare('SELECT * FROM users WHERE id = ? AND is_deleted = 0').bind(verified.payload.sub).first();
    if (!user) throw Object.assign(new Error('This account no longer exists.'), { status: 401, code: 'USER_GONE' });
    if (Number(user.is_active) !== 1) {
      throw Object.assign(new Error('This account is deactivated.'), { status: 403, code: 'USER_INACTIVE' });
    }
    // A PIN reset invalidates every outstanding token. Without this, signing out
    // "everywhere" would not actually sign out anywhere.
    if (verified.payload.ver !== (Number(user.pin_version) || 0)) {
      throw Object.assign(new Error('Your PIN was changed, so this session was signed out.'), { status: 401, code: 'SESSION_SUPERSEDED' });
    }

    const scope = await scopeLib.loadScope(db, user);
    // Touch last_seen occasionally rather than on every request: a write per
    // request on a busy till is measurable load for a field nobody reads live.
    if (!session.last_seen_at || Date.now() - Date.parse(`${session.last_seen_at.replace(' ', 'T')}Z`) > 60000) {
      await db.prepare("UPDATE user_sessions SET last_seen_at = datetime('now') WHERE id = ?").bind(session.id).run();
    }
    return { ...scope, sessionId: verified.payload.sid, user };
  };
}

// ---------------------------------------------------------------------
// startup
// ---------------------------------------------------------------------
async function createApp(overrides = {}) {
  const config = overrides.config || getConfig();
  const log = overrides.logger || console;

  const db = await openDatabase({
    file: overrides.dbFile || config.db.file,
    driver: overrides.driver || config.db.driver,
    wal: config.db.wal,
  });
  log.log(`[stockridge] database: ${db.info().driver} @ ${db.info().file || ':memory:'} (SQLite ${db.info().sqliteVersion})`);

  const migrationResult = await migrate(db, { verbose: false });
  log.log(`[stockridge] schema: ${migrationResult.total} migrations (${migrationResult.ran} applied now, ${migrationResult.skipped} already present)`);

  // Ensure default client settings and admin user exist on an empty database
  const settingsCount = await db.prepare('SELECT COUNT(*) AS c FROM client_settings WHERE id = 1').first();
  if (!settingsCount || !settingsCount.c) {
    await db.prepare(`
      INSERT INTO client_settings (
        id, product_name, max_businesses, max_branches, max_staff,
        subscription_status, subscription_plan, multi_business_enabled,
        multi_branch_enabled, instalments_module_enabled,
        warranty_module_enabled, delivery_module_enabled,
        updated_at
      ) VALUES (
        1, 'StockRidge', 50, 100, 500,
        'ACTIVE', 'Enterprise', 1, 1, 1, 1, 1,
        datetime('now')
      );
    `).run();
  }

  const userCount = await db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_deleted = 0').first();
  if (!userCount || !userCount.c) {
    const adminPinHash = auth.hashPin('9999');
    await db.prepare(`
      INSERT INTO users (
        id, branch_id, business_id, full_name, username, pin_hash,
        role, job_title, phone, email, is_driver, is_active, is_deleted, created_at, updated_at
      ) VALUES (
        'usr_admin_platform', NULL, NULL, 'Platform Administrator', 'admin', ?,
        'ADMIN', 'Vendor seat', '08000000000', 'admin@stockridge.ng', 0, 1, 0, datetime('now'), datetime('now')
      );
    `).bind(adminPinHash).run();
    log.log('[stockridge] initialized platform administrator (admin / 9999)');
  }

  // Ensure statutory reference data (WHT rates and statutory public holidays)
  const whtCount = await db.prepare('SELECT COUNT(*) AS c FROM wht_rates WHERE is_deleted = 0').first();
  if (!whtCount || !whtCount.c) {
    const WHT = require('../shared/lib/wht');
    for (let i = 0; i < WHT.SEED_RATES.length; i++) {
      const r = WHT.SEED_RATES[i];
      await db.prepare(`
        INSERT INTO wht_rates (
          id, code, description, rate_percent_small, rate_percent_medium, rate_percent_large,
          rate_percent, direction, statutory_reference, is_active, sort_order, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now'), datetime('now')
        );
      `).bind(
        `wht_${r.code.toLowerCase()}`,
        r.code,
        r.description || r.label || r.code,
        r.rate_percent_small != null ? r.rate_percent_small : (r.small || 0),
        r.rate_percent_medium != null ? r.rate_percent_medium : (r.medium || 0),
        r.rate_percent_large != null ? r.rate_percent_large : (r.large || 0),
        r.rate_percent != null ? r.rate_percent : (r.small || 0),
        r.direction || 'BOTH',
        'WHT Regulations 2024',
        i + 1
      ).run();
    }
  }

  const holCount = await db.prepare('SELECT COUNT(*) AS c FROM public_holidays').first();
  if (!holCount || !holCount.c) {
    const year = new Date().getFullYear();
    const defs = [
      ['01-01', "New Year's Day", 'FEDERAL'],
      ['05-01', "Workers' Day", 'FEDERAL'],
      ['06-12', 'Democracy Day', 'FEDERAL'],
      ['10-01', "Independence Day", 'FEDERAL'],
      ['12-25', 'Christmas Day', 'FEDERAL'],
      ['12-26', 'Boxing Day', 'FEDERAL'],
      ['03-31', 'Eid el-Fitr', 'RELIGIOUS'],
      ['06-07', 'Eid el-Kabir', 'RELIGIOUS'],
      ['06-16', 'Eid el-Mawlid', 'RELIGIOUS'],
      ['05-29', 'Lagos State founding day', 'STATE'],
    ];
    for (const y of [year, year + 1]) {
      for (const [mmdd, name, type] of defs) {
        const date = `${y}-${mmdd}`;
        const state = type === 'STATE' ? 'LA' : null;
        await db.prepare(`
          INSERT INTO public_holidays (
            id, holiday_date, name, state_code, holiday_type, banks_closed, trading_affected, year, notes, created_at, updated_at
          ) VALUES (
            ?, ?, ?, ?, ?, 1, ?, ?, 'Statutory holiday', datetime('now'), datetime('now')
          );
        `).bind(
          `hol_${y}_${mmdd.replace('-', '_')}`,
          date,
          name,
          state,
          type,
          type === 'RELIGIOUS' ? 1 : 0,
          y
        ).run();
      }
    }
  }

  const businesses = await db.prepare('SELECT COUNT(*) AS c FROM businesses WHERE is_deleted = 0').first();

  if (!businesses.c && (config.app.autoseed || overrides.seed)) {
    log.log('[stockridge] empty database — seeding demo data');
    // eslint-disable-next-line global-require
    const { seed } = require('./db/seed');
    await seed({ db, options: overrides.seedOptions || {}, log: (m) => log.log(m) });
  } else if (!businesses.c) {
    log.warn('[stockridge] the database has no businesses. Run `npm run db:seed` for demo data, or create one from the UI.');
  }

  // Boot-time ledger check. Cheap, and it converts "the accounts are wrong" from
  // a month-end discovery into a startup message.
  try {
    const integrity = await gl.checkLedgerIntegrity(db, {});
    if (integrity.entries > 0) {
      if (integrity.ok) log.log(`[stockridge] ledger: ${integrity.entries} journal entries, in balance`);
      else log.error(`[stockridge] LEDGER DOES NOT BALANCE: ${integrity.entries} entries, ${integrity.unbalanced_entries.length} unbalanced. Do not rely on any accounting report until this is fixed.`);
    }
  } catch (e) {
    log.warn(`[stockridge] could not check ledger integrity at boot: ${e.message}`);
  }

  const router = buildRoutes({ config, db });
  const authenticate = makeAuthenticator(db, config);

  const apiHandler = createHandler({ router, db, config, authenticate, logger: log });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // API first. Anything under /api, /auth, /branding or /reference is JSON.
    if (/^\/(api|auth|branding|reference|businesses|branches|users|products|catalog|sales|stock|customers|till|safe|change-owed|holds|instalments|warranty|delivery|gl|vat|wht|registers|dashboard|settings|admin|sync)\b/.test(pathname)) {
      return apiHandler(req, res);
    }
    // The service worker and manifest are served from public/ but must not be
    // cached, or a client is stuck on an old shell.
    if (pathname === '/manifest.json' || pathname === '/manifest.webmanifest') {
      const file = path.join(PUBLIC_DIR, 'manifest.json');
      if (fs.existsSync(file)) {
        const body = fs.readFileSync(file);
        res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
        return res.end(body);
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: `${req.method} is not allowed on ${pathname}`, code: 'METHOD_NOT_ALLOWED' });
    }
    if (serveStatic(req, res, pathname)) return undefined;
    // Single-page app: any unknown GET path serves the shell, so a deep link
    // like /pos or /stock works on a hard refresh rather than 404ing.
    if (!path.extname(pathname) && serveStatic(req, res, '/index.html')) return undefined;
    return json(res, 404, { error: `Nothing at ${pathname}`, code: 'NOT_FOUND' });
  });

  // A clean shutdown matters more here than in most apps: sql.js holds the whole
  // database in memory and only reaches disk when WE write it. Dying without a
  // flush loses everything since the last commit.
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    log.log(`[stockridge] ${signal} — flushing and closing`);
    try { db.flush(); } catch (e) { log.error(`[stockridge] flush failed: ${e.message}`); }
    server.close(() => {
      try { db.close(); } catch (e) { /* best effort */ }
      process.exit(0);
    });
    // Do not hang forever waiting for a long request to finish.
    setTimeout(() => { try { db.close(); } catch (e) { /* ignore */ } process.exit(0); }, 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  // An unhandled rejection in a request path must not take the process down
  // mid-sale, but it must not be swallowed silently either.
  process.on('unhandledRejection', (reason) => log.error('[stockridge] unhandled rejection:', reason));
  process.on('uncaughtException', (err) => {
    log.error('[stockridge] uncaught exception:', err && err.stack || err);
    // Flush before dying, or a sql.js deployment loses the last few sales.
    try { db.flush(); } catch (e) { /* best effort */ }
    shutdown('uncaughtException');
  });

  return { server, db, config, router, shutdown };
}

async function start() {
  const config = loadConfig();
  const log = console;
  log.log(`[stockridge] ${config.app.productName} v${config.app.version} — ${config.env}`);
  log.log(`[stockridge] timezone ${TG.TIMEZONE_LABEL}; "today" is ${TG.todayWat()}`);
  if (config.jwt.ephemeral) {
    log.warn('[stockridge] using an EPHEMERAL signing secret — every restart signs all sessions out.');
  }
  const { server } = await createApp({ config, logger: log });
  server.listen(config.port, config.host, () => {
    const addr = server.address();
    log.log('');
    log.log(`[stockridge] listening on http://${config.host}:${addr.port}`);
    log.log(`[stockridge] open http://localhost:${addr.port} in a browser`);
    if (config.host === '0.0.0.0') log.log('[stockridge] bound to all interfaces — other devices on this network can reach it');
    log.log('');
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.error(`[stockridge] port ${config.port} is already in use. Set PORT in .env to something else.`);
    } else {
      log.error(`[stockridge] server error: ${err.message}`);
    }
    process.exit(1);
  });
}

if (require.main === module) {
  start().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[stockridge] failed to start: ${err && err.stack || err}`);
    process.exit(1);
  });
}

module.exports = { createApp, start, serveStatic, PUBLIC_DIR };
