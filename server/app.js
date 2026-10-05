'use strict';
// =====================================================================
// server/app.js — NODE HTTP ENTRY POINT
// =====================================================================
// This is the adapter between `node:http` and the portable Context in
// server/lib/http.js. Everything above this file — routes, services, domain —
// is written against that Context and never touches a Node request object,
// which is what lets the SAME route files run on Cloudflare Workers against D1
// (see worker/src/index.js). The only backend-specific code in the request path
// is the ~60 lines below.
//
// RESPONSIBILITIES
//   1. Open the database once, at startup, and hand it to every request via env.
//      A connection per request would exhaust file handles and lose the
//      statement cache.
//   2. Apply migrations on boot. A server that starts against a stale schema
//      fails in confusing ways later; failing at boot is honest.
//   3. Serve public/ as static files, with the SPA fallback that lets the
//      client own its own routing.
//   4. Mount /api from the route registry.
//   5. Bind 0.0.0.0 so the process is reachable from outside the sandbox.
//
// THE JWT SECRET
//
// Taken from STOCKRIDGE_JWT_SECRET. If absent, a per-install secret is derived
// from the database file path and persisted next to the database, so tokens
// survive a restart without anyone having to configure anything. It is NOT
// left random-per-boot: that would sign every user out on every deploy, which
// on a shop floor means the till cannot sell while it re-authenticates.
// =====================================================================

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { openDatabase, migrate, schemaInfo } = require('./lib/db');
const { createApp, HttpError, toHttpError } = require('./lib/http');
const { buildRoutes } = require('./routes');

const PROJECT_ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
});

/**
 * Resolve the JWT secret: explicit env var first, then a persisted per-install
 * secret, then generate and persist one.
 */
function resolveJwtSecret(dbFile) {
  const explicit = process.env.STOCKRIDGE_JWT_SECRET || process.env.JWT_SECRET;
  if (explicit && explicit.length >= 16) return { secret: explicit, source: 'environment' };

  const secretFile = `${dbFile}.jwt`;
  try {
    if (fs.existsSync(secretFile)) {
      const existing = fs.readFileSync(secretFile, 'utf8').trim();
      if (existing.length >= 32) return { secret: existing, source: 'persisted' };
    }
  } catch (e) {
    console.warn('[app] could not read the persisted JWT secret, generating a new one:', e.message);
  }

  const generated = crypto.randomBytes(48).toString('base64url');
  try {
    fs.mkdirSync(path.dirname(secretFile), { recursive: true });
    fs.writeFileSync(secretFile, generated, { mode: 0o600 });
  } catch (e) {
    // A read-only filesystem is survivable: the secret lives for this process
    // only, and everybody is signed out on restart. Said loudly, because on a
    // shop floor that is a real disruption.
    console.warn('[app] could not persist the JWT secret — sessions will not survive a restart:', e.message);
  }
  return { secret: generated, source: 'generated' };
}

// ---------------------------------------------------------------------
// STATIC FILES
// ---------------------------------------------------------------------
/**
 * Serve a file from public/, or null if it does not exist.
 *
 * Path traversal is refused by resolving and then checking the result is still
 * inside PUBLIC_DIR. A request for `/../../etc/passwd` must not escape the
 * document root, and `path.join` alone will happily do exactly that.
 */
function serveStatic(req, res, urlPath) {
  if (!urlPath || urlPath.startsWith('/api')) return false;
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const candidate = path.resolve(PUBLIC_DIR, rel || 'index.html');
  if (!candidate.startsWith(PUBLIC_DIR + path.sep) && candidate !== PUBLIC_DIR) return false;

  let stat = null;
  try { stat = fs.statSync(candidate); } catch (e) { return false; }
  if (!stat.isFile()) return false;

  const ext = path.extname(candidate).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  // Hashed assets could be cached forever; nothing here is hashed yet, so a
  // short revalidation window keeps a deploy from being invisible to a client
  // that cached the old bundle. The service worker owns offline caching.
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(candidate).pipe(res);
  return true;
}

/** The SPA fallback: an unknown non-API path is a client route. */
function serveSpaFallback(req, res) {
  const indexFile = path.join(PUBLIC_DIR, 'index.html');
  if (!fs.existsSync(indexFile)) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('StockRidge is running but the client bundle is missing from public/. Run the build or restore public/index.html.\n');
    return;
  }
  const body = fs.readFileSync(indexFile);
  res.writeHead(200, {
    'Content-Type': MIME['.html'],
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

// ---------------------------------------------------------------------
// APP
// ---------------------------------------------------------------------
function createHttpApp({ db, jwtSecret, settings }) {
  const app = createApp();
  buildRoutes(app, { db, jwtSecret, settings });
  return app;
}

async function main() {
  const args = process.argv.slice(2);
  const argValue = (name, fallback) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split('=')[1] : fallback;
  };

  const port = Number(argValue('port', process.env.PORT || 8787));
  const host = argValue('host', process.env.HOST || '0.0.0.0');
  const dbFile = argValue('db', process.env.STOCKRIDGE_DB || path.join(PROJECT_ROOT, '.data', 'stockridge.db'));
  const skipMigrate = args.includes('--no-migrate');

  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = openDatabase({ file: dbFile });

  if (!skipMigrate) {
    const result = await migrate(db);
    if (result.applied.length) console.log(`[app] applied migrations: ${result.applied.join(', ')}`);
  }
  const info = await schemaInfo(db);
  const { secret: jwtSecret, source } = resolveJwtSecret(dbFile);

  const settingsRow = await db.first('SELECT * FROM client_settings WHERE id = 1').catch(() => null);
  const app = createHttpApp({ db, jwtSecret, settings: settingsRow });

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // CORS. The PWA is same-origin in production, but a developer running the
    // client from a bundler on another port, or the Worker preview against this
    // API, needs it. Credentials are not used (the token is in a header), so a
    // permissive origin is safe here.
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Stockridge-Token, Idempotency-Key, X-Device-Id');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // Static first: it is the cheapest path and must not depend on the API.
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (serveStatic(req, res, url.pathname)) return;
    }

    if (url.pathname.startsWith('/api')) {
      let body = null;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        body = await new Promise((resolve, reject) => {
          const chunks = [];
          let size = 0;
          req.on('data', (c) => {
            size += c.length;
            // A body cap protects the process: an unbounded read is how one
            // request takes the whole shop offline. 10 MB leaves room for a
            // base64 logo and a large offline sync batch.
            if (size > 10 * 1024 * 1024) { reject(new HttpError('The request body is too large (limit 10 MB).', { status: 413, code: 'BODY_TOO_LARGE' })); req.destroy(); return; }
            chunks.push(c);
          });
          req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          req.on('error', reject);
        }).catch((e) => { throw e; });
      }

      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(', '));
      }

      try {
        const response = await app.fetch(req.method, url.pathname + url.search, {
          headers, body, env: { DB: db, db, JWT_SECRET: jwtSecret, SETTINGS: settingsRow },
        });
        const outHeaders = {};
        response.headers.forEach((v, k) => { outHeaders[k] = v; });
        res.writeHead(response.status, outHeaders);
        // Written as BYTES, not through `.text()`. Reading the body as text runs
        // the UTF-8 decoder, which silently drops a leading BOM — that is how the
        // CSV export's BOM was disappearing between the handler and the socket.
        // Bytes in, bytes out: the file the browser downloads is the file the
        // handler built.
        const bytes = Buffer.from(await response.arrayBuffer());
        res.end(req.method === 'HEAD' ? undefined : bytes);
        const ms = Date.now() - started;
        if (ms > 800 || response.status >= 500) {
          console.log(`[api] ${req.method} ${url.pathname} -> ${response.status} in ${ms}ms${ms > 800 ? ' (SLOW)' : ''}`);
        }
      } catch (e) {
        const err = toHttpError(e);
        if (err.status >= 500) console.error(`[api] ${req.method} ${url.pathname}:`, err.message);
        res.writeHead(err.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message, code: err.code || undefined }));
      }
      return;
    }

    serveSpaFallback(req, res);
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`[app] port ${port} is already in use. Pass --port=NNNN to choose another.`);
      process.exit(1);
    }
    throw e;
  });

  server.listen(port, host, () => {
    const businesses = settingsRow ? 1 : 0;
    console.log('──────────────────────────────────────────────────────────');
    console.log(' StockRidge');
    console.log('──────────────────────────────────────────────────────────');
    console.log(` listening : http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    console.log(` database  : ${dbFile}`);
    console.log(` schema    : ${info.tables} tables, ${info.views} views, ${info.indexes} indexes`);
    console.log(` jwt secret: from ${source}`);
    console.log(` branding  : ${settingsRow ? (settingsRow.business_name || 'StockRidge') : 'StockRidge (not yet provisioned)'}`);
    if (!businesses) console.log(' setup     : run `npm run db:seed` for a four-business demo deployment');
    console.log('──────────────────────────────────────────────────────────');
  });

  // Graceful shutdown: finish in-flight requests, then close the database. An
  // abrupt kill mid-transaction is survivable because SQLite journals it, but
  // closing cleanly is what keeps WAL files from accumulating.
  const shutdown = (signal) => {
    console.log(`\n[app] ${signal} received, shutting down`);
    server.close(() => {
      try { db.close(); } catch (e) { /* already closed */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[app] failed to start:', e.message);
    if (e.stack) console.error(e.stack.split('\n').slice(1, 5).join('\n'));
    process.exit(1);
  });
}

module.exports = { createHttpApp, resolveJwtSecret, PUBLIC_DIR, MIME };
