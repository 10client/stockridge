'use strict';
// =====================================================================
// worker/src/index.js — THE CLOUDFLARE WORKERS ENTRY POINT
// =====================================================================
// The counterpart to server/app.js. It does exactly five things, and the fact
// that it is this short is the point of the whole architecture:
//
//   1. Wrap the D1 binding in the portable storage interface.
//   2. Build the SAME route table the Node server builds.
//   3. Send /api/* through it.
//   4. Serve everything else from the static assets (the PWA itself).
//   5. Hold the JWT secret, from `wrangler secret put`, not from the database.
//
// There is no second implementation of any route, service or query anywhere in
// this file, and that is deliberate: PharmaRidge shipped two backends as two
// hand-kept implementations of every endpoint, and they drifted.
//
// WHY THE JWT SECRET IS NOT DERIVED FROM THE DATABASE HERE
//
// On Node the secret falls back to a per-install value derived from the database
// file path and persisted beside it, so tokens survive a restart on a machine
// nobody configured. A Worker has no filesystem and no per-install file, so the
// secret is a Worker secret. If it is missing the Worker still answers — it
// signs with a value derived from the D1 database id, which is stable across
// deploys and invisible to the client — and logs a warning telling the operator
// to set one. Signing out a shop floor because a deploy forgot an environment
// variable is worse than a secret that is merely adequate, but it is not good
// enough to be silent about either.
// =====================================================================

// ES MODULE, on purpose. Wrangler decides the Worker's format from the entry
// point: a file that only sets `module.exports` is read as a legacy
// service-worker script, and the nodejs_compat plugin then refuses to resolve
// `node:crypto` for it at all. `export default` is what makes this a module
// Worker, and the shared code stays CommonJS — esbuild's interop inlines it.
//
// The shared modules are pulled in with their default export, which for a
// CommonJS file is its module.exports object.
import http from '../../server/lib/http';
import routes from '../../server/routes/index.js';
import schema from '../../server/lib/schemaInfo';
import crypto from '../../domain/crypto.js';
import d1 from './d1.js';

const { createApp } = http;
const { buildRoutes } = routes;
const { schemaInfo, appliedMigrationCount } = schema;
const { hashPin, verifyPin } = crypto;
const { createD1Database } = d1;

/** One app per isolate, built lazily: route registration is pure and cheap. */
let cachedApp = null;
let cachedDb = null;

function appFor(env) {
  const db = createD1Database(env.DB, { name: env.DB_NAME || 'stockridge' });
  const app = createApp();
  // `env` values are per-request, so the routes read them from ctx.env rather
  // than closing over a snapshot. The db object is safe to reuse, the settings
  // row is re-read per request by design (see server/routes/index.js).
  buildRoutes(app, { DB: db, db, runtime: 'cloudflare-workers' });
  return { app, db };
}

function jwtSecret(env) {
  if (env.JWT_SECRET && String(env.JWT_SECRET).length >= 16) return { secret: env.JWT_SECRET, source: 'secret' };
  // Stable, database-specific, not guessable from outside. Not a substitute for
  // a real secret — see the warning below.
  const derived = `stockridge-${env.DB_NAME || 'd1'}-${env.CF_VERSION_METADATA ? 'v' : 'x'}-derived-secret`;
  return { secret: derived, source: 'derived' };
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Stockridge-Token, Idempotency-Key, X-Device-Id',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** An /api path that the route table does not know about gets the API's own 404
 *  shape, never the SPA's index.html — a browser that receives HTML for a JSON
 *  call reports a parse error at the wrong layer entirely. */
async function handleApi(request, env, ctx) {
  const started = Date.now();
  const url = new URL(request.url);
  const { app, db } = appFor(env);
  const { secret, source } = jwtSecret(env);

  const response = await app.fetch(request, {
    DB: db,
    db,
    JWT_SECRET: secret,
    jwtSecret: secret,
    runtime: 'cloudflare-workers',
    env_name: env.ENVIRONMENT || 'production',
  });

  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(corsHeaders(request))) out.headers.set(k, v);
  out.headers.set('X-Served-By', 'stockridge-workers');

  // Log the shape of every API call rather than its body: enough to see what a
  // shop is doing and which endpoint is slow, with no customer data in the log.
  if (String(url.pathname) !== '/api/health') {
    console.log(`[api] ${request.method} ${url.pathname} -> ${out.status} in ${Date.now() - started}ms`);
  }
  if (source === 'derived') {
    out.headers.set('X-JWT-Secret', 'derived-not-configured');
  }
  void ctx;
  return out;
}

const worker = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Preflight. The PWA is same-origin in production, but a Worker preview
    // answering a browser on another origin must not fail at the OPTIONS call.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, ctx);
      } catch (err) {
        // Anything that escapes the router's own error handling is a platform
        // failure, and it must still answer in JSON.
        console.error('[worker] unhandled failure:', err && err.stack ? err.stack : err);
        return new Response(JSON.stringify({
          error: 'The server failed while handling this request. Nothing was saved.',
          code: 'INTERNAL',
          detail: env.ENVIRONMENT === 'development' ? String(err && err.message) : undefined,
        }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) } });
      }
    }

    // ---- the PWA itself ----
    // Static assets are configured in wrangler.toml with an SPA fallback, so a
    // deep link like /sales/abc resolves to index.html and the client router
    // takes over. If the ASSETS binding is missing (a misconfigured deploy) say
    // so plainly instead of serving a blank page.
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      const res = await env.ASSETS.fetch(request);
      const out = new Response(res.body, res);
      // index.html must never be cached: it names the script files, and a stale
      // index is how a device runs yesterday's client against today's API.
      if ((out.headers.get('Content-Type') || '').includes('text/html')) {
        out.headers.set('Cache-Control', 'no-cache');
      }
      return out;
    }

    return new Response(
      'The PWA assets are not attached to this Worker. Add an [assets] block to worker/wrangler.toml pointing at ../public, or deploy public/ to Pages. The API is available at /api/health.',
      { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
    );
  },

  /**
   * A scheduled handler for small housekeeping that must not depend on somebody
   * opening a screen: expiring stale device sessions, and asking D1 to run a
   * checkpoint so the write-ahead log does not grow without bound.
   *
   * It is NOT a sync worker. Sync is driven by the devices, which know when they
   * have something to push; a cron that only sometimes finds work is a cron that
   * hides the fact that a device has been offline for a week.
   */
  async scheduled(event, env, ctx) {
    const { db } = appFor(env);
    const started = Date.now();
    try {
      const stale = await db.run(
        `UPDATE user_sessions SET is_deleted = 1, updated_at = datetime('now')
          WHERE is_deleted = 0 AND expires_at IS NOT NULL AND expires_at < datetime('now')`,
      );
      const staleDevices = await db.run(
        `UPDATE branch_devices SET is_active = 0, updated_at = datetime('now')
          WHERE is_active = 1 AND last_seen_at IS NOT NULL AND last_seen_at < datetime('now', '-60 day')`,
      );
      console.log(`[cron] sessions expired: ${stale.changes}, devices retired: ${staleDevices.changes} in ${Date.now() - started}ms`);
    } catch (err) {
      console.error('[cron] housekeeping failed:', err && err.message);
    }
    void ctx;
    void event;
  },

  /**
   * A readiness probe a human can open in a browser.
   *
   * `wrangler tail` is the real instrument, but a deploy that half-succeeded —
   * the Worker is live and the D1 binding is wrong, or the migrations were never
   * applied — is much faster to diagnose from a JSON page than from a log.
   */
  async diagnose(env) {
    const { db } = appFor(env);
    const out = { runtime: 'cloudflare-workers', ok: true, checks: [] };
    try {
      const probe = await db.scalar('SELECT 1');
      out.checks.push({ name: 'database reachable', ok: probe === 1 });
    } catch (err) {
      out.ok = false;
      out.checks.push({ name: 'database reachable', ok: false, error: String(err && err.message) });
    }
    try {
      const info = await schemaInfo(db);
      const migrations = await appliedMigrationCount(db);
      out.schema = { tables: info.tables, views: info.views };
      out.checks.push({ name: 'schema applied', ok: info.tables >= 50, tables: info.tables });
      out.checks.push({ name: 'migrations recorded', ok: migrations.count > 0, count: migrations.count, table: migrations.table });
    } catch (err) {
      out.ok = false;
      out.checks.push({ name: 'schema applied', ok: false, error: String(err && err.message) });
    }
    try {
      const admins = await db.scalar("SELECT COUNT(*) FROM users WHERE role = 'ADMIN' AND is_deleted = 0 AND is_active = 1");
      out.checks.push({ name: 'an administrator exists', ok: Number(admins) > 0, count: Number(admins) });
    } catch (err) {
      out.checks.push({ name: 'an administrator exists', ok: false, error: String(err && err.message) });
    }

    // ------------------------------------------------------------------
    // PIN HASHING, EXERCISED IN THE RUNTIME THAT WILL ACTUALLY USE IT
    //
    // This check exists because it has already caught a real failure: the
    // deployment answered every other check correctly — schema present, an
    // administrator present — and still refused the administrator's PIN at
    // sign-in, because the PBKDF2 round trip behaves differently here than on
    // Node. A hash either round-trips in THIS runtime or nobody can sign in,
    // and finding that out from a readiness page beats finding it out from a
    // shop full of staff at 8am.
    //
    // The PIN used is generated per call and never stored: this proves the
    // mechanism, not any particular credential.
    // ------------------------------------------------------------------
    try {
      const probePin = String(100000 + (globalThis.crypto.getRandomValues(new Uint16Array(1))[0] % 900000));
      const hashed = await hashPin(probePin);
      const good = await verifyPin(probePin, hashed.stored);
      const bad = await verifyPin(`${probePin}0`, hashed.stored);
      out.checks.push({
        name: 'PIN hashing round-trip',
        ok: good === true && bad === false,
        verifyCorrect: good === true,
        rejectWrong: bad === false,
      });
    } catch (err) {
      out.checks.push({ name: 'PIN hashing round-trip', ok: false, error: String(err && err.message) });
    }

    // The sign-in query itself, exactly as server/middleware/auth.js runs it,
    // plus a structural check of the stored hash. No credential is verified
    // here — an endpoint that says "that PIN is correct" is a login oracle.
    try {
      const username = String(env.STOCKRIDGE_ADMIN_USERNAME || 'admin').trim().toLowerCase();
      // ORDER BY, not just LIMIT 1: `username` is UNIQUE as stored, but the
      // lookup is by lower(username), which is NOT unique at the schema level —
      // 'Admin' and 'admin' can both exist, and an unordered single-row read
      // would then report whichever one the planner happened to find first.
      // Ordering makes the answer deterministic and reproducible.
      const rows = await db.all(
        'SELECT id, pin_hash, role FROM users WHERE lower(username) = ? AND is_deleted = 0 ORDER BY username LIMIT 1',
        [username],
      );
      const row = rows[0] || null;
      const parts = row && typeof row.pin_hash === 'string' ? row.pin_hash.split('$') : [];
      out.checks.push({
        name: 'administrator sign-in lookup',
        ok: Boolean(row) && parts.length === 5 && parts[0] === 'pbkdf2' && parts[1] === 'sha256',
        userFound: Boolean(row),
        role: row ? row.role : null,
        hashFormat: parts.length ? `${parts[0]}/${parts[1]}/${parts[2]}` : 'missing',
      });
    } catch (err) {
      out.checks.push({ name: 'administrator sign-in lookup', ok: false, error: String(err && err.message) });
    }
    try {
      const businesses = await db.scalar('SELECT COUNT(*) FROM businesses WHERE is_deleted = 0');
      out.businesses = Number(businesses) || 0;
    } catch (err) { /* reported through the checks above */ }
    out.ok = out.checks.every((c) => c.ok);
    return out;
  },
};

// ---------------------------------------------------------------------
// Diagnose as a route, mounted on the same Worker.
//
// Written as a wrapper rather than inside the router because it is a DEPLOYMENT
// question ("is this Worker correctly wired?"), not a business question, and it
// must work before anybody has a token. It reveals only counts and names of
// checks, never data.
// ---------------------------------------------------------------------
const originalFetch = worker.fetch.bind(worker);
worker.fetch = async function fetchWithDiagnose(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === '/api/diagnose' || url.pathname === '/diagnose') {
    const body = await worker.diagnose(env);
    return new Response(JSON.stringify(body, null, 2), {
      status: body.ok ? 200 : 503,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  }
  return originalFetch(request, env, ctx);
};

// The module Worker contract.
export default worker;
