// =====================================================================
// worker/src/index.js — the Cloudflare Workers + D1 backend
// =====================================================================
//
// WHAT IS SHARED, AND WHAT CANNOT BE
// ----------------------------------
// SHARED, byte for byte, with the Node backend:
//   shared/lib/*        every domain rule — money, pricing, VAT, WHT, UoM
//                       ladders, stock picking, instalments, layaway, warranty,
//                       delivery, credit, FX, hash chains, time and geography
//   shared/services/*   every business flow — createSale, the GL postings,
//                       settings, plan limits, document numbering, audit
//   server/routes/index.js   the whole API surface, including its
//                       authorisation calls
//
// NOT shared, because the runtime differs and pretending otherwise would be a
// lie:
//   the HTTP layer      node:http vs the Fetch API (two thin routers, one
//                       contract — see worker/src/http.js)
//   the data driver     better-sqlite3/sql.js vs D1 (two adapters, one shape —
//                       see worker/src/d1Adapter.js)
//   crypto              node:crypto vs Web Crypto. auth.js uses scrypt from
//                       node:crypto, which Workers exposes through the
//                       `nodejs_compat` flag; see wrangler.toml.
//   static files        the filesystem vs an ASSETS binding
//
// That is the whole decoupling argument in one file list. The pharmacy product
// this came from maintained two parallel route trees and two parallel service
// trees, and its own audit recorded a parity gap that nobody noticed until
// somebody went looking: the Node backend pruned sync_change_log on a schedule
// and the Worker never did. There is no equivalent gap possible here, because
// there is no second copy.
//
// DEPLOYING
//   npx wrangler d1 create stockridge
//   put the database_id in wrangler.toml
//   npx wrangler d1 execute stockridge --remote --file=../server/db/migrations/0001_core_schema.sql
//   ... for each migration in order (or use tools/worker-migrate.js)
//   npx wrangler secret put JWT_SECRET
//   npx wrangler deploy

import { wrapD1 } from './d1Adapter.js';
import { createFetchHandler, sendError, SECURITY_HEADERS } from './http.js';
import { buildRoutes } from '../../server/routes/index.js';
import { makeWorkerAuthenticator, workerConfig } from './auth.js';
import { serveAssetFromBinding, SPA_SHELL } from './assets.js';

const API_ROUTE_PATTERN = /^\/(api|auth|branding|reference|businesses|branches|products|catalog|sales|stock|customers|till|safe|change-owed|holds|instalments|warranty|delivery|gl|vat|wht|registers|dashboard|settings|admin|sync)\b/;

export default {
  async fetch(request, env, ctx) {
    const started = Date.now();
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname);
    const requestId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);

    try {
      const config = workerConfig(env);

      // D1 is the only database. There is no fallback driver here: on Workers
      // there is nothing to fall back to, and pretending otherwise would mean
      // silently losing writes.
      if (!env.DB) {
        return new Response(JSON.stringify({
          error: 'This deployment has no D1 database bound. Add a [[d1_databases]] binding named DB to wrangler.toml and redeploy.',
          code: 'NO_DATABASE_BINDING', status: 503, requestId,
        }), { status: 503, headers: { 'Content-Type': 'application/json', ...SECURITY_HEADERS } });
      }
      const db = wrapD1(env.DB);

      // Migrations must have been applied out of band (wrangler d1 execute or
      // tools/worker-migrate.js). A Worker cannot run them at request time:
      // DDL inside a request is both slow and unsafe, and a partially migrated
      // schema serving traffic is worse than an error.
      if (pathname === '/api/health') {
        return healthResponse(db, config, requestId, started);
      }

      const authenticate = makeWorkerAuthenticator(db, config, env);
      const router = buildRoutes({ config, db });

      const handler = createFetchHandler({
        router, db, config, authenticate,
        serveAsset: (req, p) => serveAssetFromBinding(env, req, p, requestId),
      });

      // API first. Anything under API routes is processed by the router.
      if (API_ROUTE_PATTERN.test(pathname)) {
        const res = await handler(request);
        ctx.waitUntil(logRequest(env, requestId, request.method, pathname, res.status, Date.now() - started));
        return res;
      }

      const asset = await serveAssetFromBinding(env, request, pathname, requestId);
      if (asset) return asset;

      // SPA fallback: any unknown GET path serves the shell.
      if (request.method === 'GET' && !pathname.includes('.')) {
        return new Response(SPA_SHELL, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate', ...SECURITY_HEADERS, 'X-Request-Id': requestId },
        });
      }
      return new Response(JSON.stringify({ error: `Nothing at ${pathname}`, code: 'NOT_FOUND', status: 404, requestId }),
        { status: 404, headers: { 'Content-Type': 'application/json', ...SECURITY_HEADERS } });
    } catch (err) {
      return sendError(err, requestId);
    }
  },

  /**
   * Scheduled maintenance.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMaintenance(env));
  },
};

async function healthResponse(db, config, requestId, started) {
  let tables = 0; let schemaOk = true;
  try {
    const row = await db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'").first();
    tables = row ? Number(row.c) : 0;
  } catch (e) { schemaOk = false; }
  return new Response(JSON.stringify({
    ok: schemaOk,
    service: config.app.productName,
    version: config.app.version,
    backend: 'cloudflare-workers',
    time: new Date().toISOString(),
    database: { driver: 'd1', tables },
    uptime_seconds: Math.round((Date.now() - started) / 1000),
    note: 'This deployment serves the same shared/lib and shared/services code as the Node backend. Only the HTTP layer and the database driver differ.',
  }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, 'X-Request-Id': requestId } });
}

async function runMaintenance(env) {
  const { runScheduledJobs } = await import('./maintenance.js');
  const db = wrapD1(env.DB);
  const config = workerConfig(env);
  const result = await runScheduledJobs(db, config);
  console.log('[stockridge:worker] maintenance', JSON.stringify(result));
  return result;
}

async function logRequest(env, requestId, method, pathname, status, ms) {
  if (status < 400 && ms < 1000) return;
  console.log(`[${requestId}] ${method} ${pathname} -> ${status} in ${ms}ms`);
}
