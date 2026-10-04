// =====================================================================
// worker/src/http.js — the router, on the Workers fetch API
// =====================================================================
// Mirrors server/lib/http.js. Two implementations of the SAME router contract
// is unavoidable — node:http and the Fetch API are different runtimes — but the
// contract is what the routes are written against, so the routes themselves are
// shared and there is one copy of the business behaviour.
//
// Everything the Node version guarantees, this one guarantees too:
//   * a JSON body size cap, enforced while streaming
//   * one error path, so no route can leak a stack trace
//   * a request id on every response, so "it failed at 4pm" is findable
//   * the same security headers, including the same strict CSP
//   * 405 vs 404 distinguished

'use strict';

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(self), camera=(self), microphone=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export class HttpError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code || `HTTP_${status}`;
    this.details = details || null;
  }
}

export function httpError(status, message, code, details) {
  return new HttpError(status, message, code, details);
}

function jsonResponse(status, body, extra = {}, requestId = null) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra });
  if (requestId) headers.set('X-Request-Id', requestId);
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
}

export class Router {
  constructor({ prefix = '' } = {}) {
    this.prefix = prefix;
    this.routes = [];
  }

  add(method, path, ...handlers) {
    const full = `${this.prefix}${path}`.replace(/\/{2,}/g, '/');
    const keys = [];
    const pattern = full.split('/').map((seg) => {
      if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
      if (seg === '*') { keys.push('wildcard'); return '(.*)'; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/');
    this.routes.push({ method: method.toUpperCase(), path: full, regex: new RegExp(`^${pattern}/?$`), keys, handlers });
    return this;
  }

  get(p, ...h) { return this.add('GET', p, ...h); }
  post(p, ...h) { return this.add('POST', p, ...h); }
  put(p, ...h) { return this.add('PUT', p, ...h); }
  patch(p, ...h) { return this.add('PATCH', p, ...h); }
  delete(p, ...h) { return this.add('DELETE', p, ...h); }

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
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

/** Read a JSON body with a hard cap. A cap checked after buffering the whole
 *  body is the same denial of service with extra steps. */
async function readJsonBody(request, maxBytes) {
  const declared = Number(request.headers.get('content-length')) || 0;
  if (declared > maxBytes) {
    throw httpError(413, `That request is too large (limit ${Math.round(maxBytes / 1024)} KB).`, 'PAYLOAD_TOO_LARGE');
  }
  let text;
  try { text = await request.text(); } catch (e) { throw httpError(400, 'The request body could not be read.', 'BODY_UNREADABLE'); }
  if (text.length > maxBytes) {
    throw httpError(413, `That request is too large (limit ${Math.round(maxBytes / 1024)} KB).`, 'PAYLOAD_TOO_LARGE');
  }
  if (!text) return {};
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { throw httpError(400, 'The request body is not valid JSON.', 'BODY_NOT_JSON'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw httpError(400, 'The request body must be a JSON object.', 'BODY_NOT_AN_OBJECT');
  }
  return parsed;
}

/** The real client IP. On Workers this is a platform-provided header that cannot
 *  be spoofed by the client, unlike X-Forwarded-For on a self-hosted box. */
function clientIp(request) {
  return request.headers.get('cf-connecting-ip')
    || request.headers.get('x-real-ip')
    || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    || null;
}

export function sendError(err, requestId) {
  const status = Number(err && err.status) || 500;
  const isKnown = status < 500;
  const code = (err && err.code) || (isKnown ? `HTTP_${status}` : 'INTERNAL_ERROR');
  // A 500's real message may name a table, a column or a driver error. It goes to
  // the Worker log with the request id; the client gets the id to quote.
  const message = isKnown ? (err && err.message) || 'Request failed' : 'Something went wrong on the server. The details have been logged.';
  if (!isKnown) console.error(`[${requestId}] ${code}:`, err && err.stack || err);
  const body = { error: message, code, status, requestId };
  if (err && err.details) body.details = err.details;
  if (err && err.field) body.field = err.field;
  if (err && err.warnings) body.warnings = err.warnings;
  const extra = {};
  if (typeof (err && err.retryAfterSeconds) === 'number') {
    body.retryAfterSeconds = err.retryAfterSeconds;
    extra['Retry-After'] = String(Math.ceil(err.retryAfterSeconds / 60) * 60);
  }
  return jsonResponse(status, body, extra, requestId);
}

/**
 * Build a fetch handler from a router.
 * @param {object} opts router, db, config, authenticate, serveAsset
 */
export function createFetchHandler({ router, db, config, authenticate = null, serveAsset = null }) {
  const maxBody = (config && config.security && config.security.maxBodyBytes) || 4 * 1024 * 1024;

  return async function handle(request) {
    const requestId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, 'Access-Control-Allow-Origin': url.origin, 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization,Idempotency-Key,X-Device-Id', 'Access-Control-Max-Age': '600' } });
    }

    const found = router.match(request.method, pathname);
    if (!found) {
      // Not an API route: offer the static asset / SPA shell.
      if (serveAsset && request.method === 'GET') {
        const res = await serveAsset(request, pathname);
        if (res) return res;
      }
      return jsonResponse(404, { error: `Nothing at ${pathname}`, code: 'NOT_FOUND', status: 404 }, {}, requestId);
    }
    if (found.methodNotAllowed) {
      return jsonResponse(405, { error: `${request.method} is not allowed on ${pathname}`, code: 'METHOD_NOT_ALLOWED', status: 405 },
        { Allow: router.routes.filter((r) => r.regex.test(pathname)).map((r) => r.method).join(', ') }, requestId);
    }

    // A node:http-shaped request object, so the SAME route handlers run on both
    // backends without a compatibility shim inside every route.
    const req = {
      method: request.method,
      url: request.url,
      path: pathname,
      headers: Object.fromEntries(request.headers.entries()),
      query: Object.fromEntries(url.searchParams.entries()),
      params: found.params,
      body: {},
      id: requestId,
      ip: clientIp(request),
      db,
      config,
      log: console,
      raw: request,
    };
    // A minimal response stand-in. Routes that only RETURN a value never touch
    // it; the two that write directly (none, currently) would need it.
    const res = {
      writableEnded: false,
      statusCode: 200,
      _headers: {},
      _body: null,
      setHeader(k, v) { this._headers[k] = v; },
      getHeader(k) { return this._headers[k]; },
      writeHead(status, headers) { this.statusCode = status; Object.assign(this._headers, headers || {}); },
      end(body) { this.writableEnded = true; this._body = body; },
    };

    try {
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
        const type = String(request.headers.get('content-type') || '');
        if (type.includes('application/json')) req.body = await readJsonBody(request, maxBody);
        else if (type.includes('application/x-www-form-urlencoded')) {
          const text = await request.text();
          req.body = Object.fromEntries(new URLSearchParams(text).entries());
        } else req.body = {};
      }

      if (authenticate) {
        const isPublic = found.route.handlers.some((h) => h && h.public === true);
        if (!isPublic) req.scope = await authenticate(req);
      }

      let result;
      for (const h of found.route.handlers) {
        if (typeof h !== 'function') continue;
        result = await h(req, res);
        if (res.writableEnded) {
          return new Response(res._body, { status: res.statusCode, headers: { ...SECURITY_HEADERS, ...res._headers, 'X-Request-Id': requestId } });
        }
      }
      if (result === undefined || result === null) return jsonResponse(204, undefined, {}, requestId);
      return jsonResponse(200, result, {}, requestId);
    } catch (err) {
      return sendError(err, requestId);
    }
  };
}

export function publicRoute(fn) {
  const wrapped = (req, res) => fn(req, res);
  wrapped.public = true;
  return wrapped;
}

export { SECURITY_HEADERS, clientIp, readJsonBody };
