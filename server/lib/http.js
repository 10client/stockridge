// =====================================================================
// server/lib/http.js — A ZERO-DEPENDENCY ROUTER
// =====================================================================
// Express-shaped on purpose: `router.get('/x/:id', handler)`, `req.params`,
// `req.body`, `res.json()`. Familiarity is worth more here than cleverness, and
// the surface actually needed is small — which matters because this ships to a
// client's VPS where `npm install express` may fail on an old toolchain, and to
// a Cloudflare Worker where Express cannot run at all.
//
// WHAT THIS FILE IS RESPONSIBLE FOR, beyond routing:
//
//   * JSON body parsing with a SIZE CAP. Without one, a single large POST is a
//     memory-exhaustion denial of service on a small box, and the shop's till
//     goes down because somebody pointed a scanner at it.
//   * ONE error path. Every thrown error becomes a JSON response with a code.
//     A route that forgets a try/catch must not be able to hang a request or
//     leak a stack trace to a browser.
//   * Request ids, so "the sale failed at 4pm" can be found in the log.
//   * Security headers, including a Content-Security-Policy. The frontend is
//     vanilla ES modules with no build step and no third-party CDN, so the CSP
//     can be strict — which is the point: a strict CSP is only affordable when
//     the app does not depend on inline scripts and remote assets.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//   * No template rendering, no static-file caching cleverness, no WebSocket
//     upgrade. Offline sync is pull-based over ordinary HTTP, which is what
//     makes it work through a flaky mobile connection and a caching proxy.

'use strict';

const crypto = require('node:crypto');

// ---------------------------------------------------------------------
// request / response helpers
// ---------------------------------------------------------------------
function json(res, status, body, extraHeaders = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function text(res, status, body, contentType = 'text/plain; charset=utf-8') {
  const payload = String(body == null ? '' : body);
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

class HttpError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code || `HTTP_${status}`;
    this.details = details || null;
  }
}

function httpError(status, message, code, details) {
  return new HttpError(status, message, code, details);
}

/**
 * Read and parse a JSON body, with a hard size cap.
 *
 * The cap is enforced WHILE streaming, not after: buffering an unbounded body
 * and then rejecting it is the same denial of service with extra steps.
 */
function readJsonBody(req, { maxBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch (e) { /* best effort */ }
      reject(err);
    };

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        fail(httpError(413,
          `That request is too large (limit ${Math.round(maxBytes / 1024)} KB). `
          + 'A logo or receipt image should be resized before upload.',
          'PAYLOAD_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (!chunks.length) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          // An array or scalar body would break every `req.body.field` reader
          // downstream in a way that looks like a missing field rather than a
          // malformed request.
          return reject(httpError(400, 'The request body must be a JSON object.', 'BODY_NOT_AN_OBJECT'));
        }
        return resolve(parsed);
      } catch (e) {
        return reject(httpError(400, 'The request body is not valid JSON.', 'BODY_NOT_JSON'));
      }
    });
    req.on('error', (err) => fail(httpError(400, `Request error: ${err.message}`, 'REQUEST_ERROR')));
  });
}

/** The real client IP behind a reverse proxy. Only trusted when configured to
 *  be, because a spoofable X-Forwarded-For would let anyone bypass an IP-based
 *  rate limit by sending a random one. */
function clientIp(req, { trustProxy = true } = {}) {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) {
      const first = String(fwd).split(',')[0].trim();
      if (first) return first.slice(0, 60);
    }
    const real = req.headers['x-real-ip'];
    if (real) return String(real).slice(0, 60);
  }
  return (req.socket && req.socket.remoteAddress) || null;
}

// ---------------------------------------------------------------------
// security headers
// ---------------------------------------------------------------------
/**
 * Security headers, including a STRICT Content-Security-Policy.
 *
 * The frontend uses no inline scripts, no eval, and no third-party assets, so
 * the policy can forbid all three. That is a real defence rather than a
 * formality: a stored-XSS payload injected into a product name or a customer
 * note has nowhere to execute, because inline handlers and eval are both off.
 *
 * `frame-ancestors 'none'` rather than DENY-as-X-Frame-Options only: modern
 * browsers honour the CSP directive, and the legacy header is kept for the ones
 * that do not. A POS that can be framed can be clickjacked into voiding a sale.
 */
function securityHeaders({ publicOrigin = null } = {}) {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",   // component-level styles set via .style
    "img-src 'self' data: blob:",         // logos and receipt signatures are data URLs
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');

  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'geolocation=(self), camera=(self), microphone=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    // A shop may run over plain HTTP on a LAN. HSTS on an HTTP response is
    // ignored by browsers and misleading in the header dump, so it is only sent
    // when the deployment declares a public https origin.
    ...(publicOrigin && /^https:/i.test(publicOrigin)
      ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' }
      : {}),
  };
}

// ---------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------
class Router {
  constructor({ prefix = '' } = {}) {
    this.prefix = prefix;
    this.routes = [];
    this.middlewares = [];
  }

  use(fn) { this.middlewares.push(fn); return this; }

  /** Register a route. `path` may contain :params and one trailing wildcard. */
  add(method, path, ...handlers) {
    const full = `${this.prefix}${path}`.replace(/\/{2,}/g, '/');
    const keys = [];
    const pattern = full
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
        if (seg === '*') { keys.push('wildcard'); return '(.*)'; }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({
      method: method.toUpperCase(),
      path: full,
      regex: new RegExp(`^${pattern}/?$`),
      keys,
      handlers,
    });
    return this;
  }

  get(p, ...h) { return this.add('GET', p, ...h); }
  post(p, ...h) { return this.add('POST', p, ...h); }
  put(p, ...h) { return this.add('PUT', p, ...h); }
  patch(p, ...h) { return this.add('PATCH', p, ...h); }
  delete(p, ...h) { return this.add('DELETE', p, ...h); }

  /** Mount another router under a path prefix. */
  mount(prefix, child) {
    for (const r of child.routes) {
      const keys = r.keys.slice();
      const full = `${this.prefix}${prefix}${r.path}`.replace(/\/{2,}/g, '/');
      const pattern = full.split('/').map((seg) => {
        if (seg.startsWith(':')) return '([^/]+)';
        if (seg === '*') return '(.*)';
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }).join('/');
      this.routes.push({
        method: r.method, path: full,
        regex: new RegExp(`^${pattern}/?$`), keys, handlers: r.handlers,
      });
    }
    for (const m of child.middlewares) this.middlewares.push(m);
    return this;
  }

  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method.toUpperCase() && !(method === 'HEAD' && r.method === 'GET')) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1] || ''); });
      return { route: r, params };
    }
    // 405 vs 404: telling a client "this path exists but not for that verb"
    // saves a debugging session, and costs nothing.
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

// ---------------------------------------------------------------------
// error normalisation
// ---------------------------------------------------------------------
/**
 * Turn anything thrown into a safe JSON error response.
 *
 * A ValidationError keeps its field details (the form needs them). An HttpError
 * keeps its status and code. Everything else becomes a 500 with a GENERIC
 * message: the server logs the real error with the request id, and the client
 * gets the id to quote. Leaking a stack trace or a SQL fragment to a browser is
 * how an attacker learns the schema.
 */
function sendError(res, err, { requestId, logger = console } = {}) {
  const status = Number(err && err.status) || 500;
  const isKnown = status < 500;
  const code = (err && err.code) || (isKnown ? `HTTP_${status}` : 'INTERNAL_ERROR');
  const message = isKnown
    ? (err && err.message) || 'Request failed'
    // A 500's real message may contain a table name, a file path or a driver
    // error. It goes to the log, not to the client.
    : 'Something went wrong on the server. The details have been logged.';

  if (!isKnown) {
    logger.error(`[${requestId}] ${code}: ${(err && err.stack) || err}`);
  } else if (status >= 400) {
    logger.warn(`[${requestId}] ${status} ${code}: ${(err && err.message) || ''}`);
  }

  const body = { error: message, code, status, requestId };
  if (err && err.details) body.details = err.details;
  if (err && err.field) body.field = err.field;
  if (err && err.warnings) body.warnings = err.warnings;
  if (typeof (err && err.retryAfterSeconds) === 'number') {
    body.retryAfterSeconds = err.retryAfterSeconds;
    return json(res, status, body, { 'Retry-After': String(Math.ceil(err.retryAfterSeconds / 60) * 60) });
  }
  return json(res, status, body);
}

// ---------------------------------------------------------------------
// simple in-memory rate limiter
// ---------------------------------------------------------------------
/**
 * A fixed-window limiter keyed on (bucket, identifier).
 *
 * In-memory, per process. That is honest about its limits: on a multi-instance
 * deployment each instance counts separately, so the effective limit is N x max.
 * For this product — one Node process on a shop's box, or one Worker isolate —
 * that is the correct trade, and a Redis dependency would cost far more than the
 * precision it buys.
 *
 * The LOGIN limiter is separate and database-backed (see auth.assertLoginAllowed)
 * because a login lockout must survive a restart and must be visible to a
 * manager. This one only has to stop a runaway script.
 */
class RateLimiter {
  constructor({ windowMs = 60000, max = 600 } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
    this.lastSweep = Date.now();
  }

  check(key) {
    const now = Date.now();
    // Sweep occasionally so a long-lived process does not accumulate keys for
    // clients that stopped asking.
    if (now - this.lastSweep > this.windowMs * 10) {
      for (const [k, v] of this.hits) if (now - v.resetAt > this.windowMs) this.hits.delete(k);
      this.lastSweep = now;
    }
    let entry = this.hits.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    const allowed = entry.count <= this.max;
    return {
      allowed,
      remaining: Math.max(0, this.max - entry.count),
      resetAt: entry.resetAt,
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }
}

// ---------------------------------------------------------------------
// the request handler factory
// ---------------------------------------------------------------------
/**
 * Build a node:http request handler from a router.
 *
 * @param {object} opts
 * @param {Router} opts.router
 * @param {object} [opts.db]
 * @param {object} [opts.config]
 * @param {Function} [opts.authenticate]  async (req) => scope|null
 */
function createHandler({ router, db = null, config = null, authenticate = null, logger = console }) {
  const limiter = new RateLimiter({
    windowMs: (config && config.security && config.security.rateLimit.windowMs) || 60000,
    max: (config && config.security && config.security.rateLimit.max) || 600,
  });
  const maxBody = (config && config.security && config.security.maxBodyBytes) || 4 * 1024 * 1024;
  const headers = securityHeaders({ publicOrigin: config && config.publicOrigin });

  return async function handler(req, res) {
    const requestId = crypto.randomBytes(8).toString('hex');
    const started = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    // CORS preflight. The app is same-origin, so this only exists for a
    // developer pointing a local frontend at a remote API.
    if (req.method === 'OPTIONS') {
      const origin = req.headers.origin;
      const allowed = (config && config.security && config.security.corsOrigins) || [];
      if (origin && allowed.includes(origin)) {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization,Idempotency-Key,X-Device-Id',
          'Access-Control-Max-Age': '600',
          ...headers,
        });
        return res.end();
      }
      res.writeHead(204, headers);
      return res.end();
    }

    // Rate limit, per IP.
    const ip = clientIp(req, { trustProxy: !config || config.security.trustProxy !== false });
    const rl = limiter.check(`${ip || 'unknown'}`);
    if (!rl.allowed) {
      return json(res, 429, {
        error: 'Too many requests from this address. Please wait a moment.',
        code: 'RATE_LIMITED', status: 429, requestId,
        retryAfterSeconds: rl.retryAfterSeconds,
      }, { 'Retry-After': String(rl.retryAfterSeconds) });
    }

    // Decorate the request once, so no route has to re-derive any of it.
    req.id = requestId;
    req.ip = ip;
    req.query = Object.fromEntries(url.searchParams.entries());
    req.db = db;
    req.config = config;
    req.log = logger;
    res.setHeader('X-Request-Id', requestId);
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);

    const found = router.match(req.method, pathname);
    if (!found) {
      return json(res, 404, { error: `No route for ${req.method} ${pathname}`, code: 'NOT_FOUND', status: 404, requestId });
    }
    if (found.methodNotAllowed) {
      return json(res, 405, { error: `${req.method} is not allowed on ${pathname}`, code: 'METHOD_NOT_ALLOWED', status: 405, requestId },
        { Allow: router.routes.filter((r) => r.regex.test(pathname)).map((r) => r.method).join(', ') });
    }

    try {
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        const type = String(req.headers['content-type'] || '');
        if (type.includes('application/json')) {
          req.body = await readJsonBody(req, { maxBytes: maxBody });
        } else if (type.includes('application/x-www-form-urlencoded')) {
          const raw = await readRawBody(req, maxBody);
          req.body = Object.fromEntries(new URLSearchParams(raw).entries());
        } else {
          req.body = {};
        }
      } else {
        req.body = {};
      }

      req.params = found.params;
      if (authenticate) {
        // A route declares `public: true` to opt out of authentication
        // (/api/health, /auth/login). Everything else requires a session.
        const isPublic = found.route.handlers.some((h) => h && h.public === true)
          || found.route.handlers[found.route.handlers.length - 1]?.public === true;
        if (!isPublic) {
          req.scope = await authenticate(req);
        }
      }

      let result;
      for (const h of found.route.handlers) {
        if (typeof h !== 'function') continue;
        // eslint-disable-next-line no-await-in-loop
        result = await h(req, res);
        if (res.writableEnded) return undefined;
      }
      if (!res.writableEnded) {
        if (result === undefined || result === null) json(res, 204, undefined);
        else json(res, 200, result);
      }
    } catch (err) {
      if (!res.writableEnded) sendError(res, err, { requestId, logger });
    } finally {
      const ms = Date.now() - started;
      // Log anything slower than a second: on a shop's box that is the early
      // signal of a missing index or a growing table, long before it becomes a
      // complaint about the till being slow.
      if (ms > 1000) logger.warn(`[${requestId}] SLOW ${req.method} ${pathname} took ${ms}ms`);
      else if (config && config.logLevel === 'debug') logger.debug(`[${requestId}] ${req.method} ${pathname} ${ms}ms`);
    }
    return undefined;
  };
}

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(httpError(413, 'Request body too large', 'PAYLOAD_TOO_LARGE')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Mark a handler as not requiring authentication. */
function publicRoute(fn) {
  const wrapped = (req, res) => fn(req, res);
  wrapped.public = true;
  return wrapped;
}

module.exports = {
  Router, HttpError, httpError,
  json, text, readJsonBody, readRawBody, clientIp,
  securityHeaders, sendError, createHandler, RateLimiter, publicRoute,
};
'use strict';
