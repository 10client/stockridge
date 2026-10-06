'use strict';
// =====================================================================
// server/lib/http.js — MINIMAL HONO-SHAPED ROUTER AND CONTEXT
// =====================================================================
// WHY A ROUTER LIVES IN THIS PROJECT AT ALL
//
// The two backends have different HTTP layers: Express-style middleware on
// Node, Hono on Cloudflare Workers. PharmaRidge solved this by writing both
// twice. StockRidge solves it by defining the ONE surface that routes
// actually use, and implementing it twice:
//
//   c.req.param('id')          path parameter
//   c.req.query('status')      query string
//   c.req.json()               parsed body
//   c.req.header('X-Foo')      header
//   c.json(data, status)       JSON response
//   c.text(str, status)        text response
//   c.status / c.set           response mutation
//   c.env                      bindings (db, secrets) on Workers; config on Node
//   c.get('user') / c.set(...) request-scoped values
//   app.get/post/put/delete    route registration
//   app.use(middleware)        global middleware
//   app.notFound / app.onError handlers
//
// Those names are Hono's on purpose. The Worker backend uses real Hono and
// the route files run on it UNCHANGED; this Node implementation is a
// compatible subset, so the same route files run here too. A route that
// only uses this surface is portable by construction, and the unit test
// suite enforces it by refusing any route file that imports a Node-only
// module.
//
// It is deliberately a SUBSET. Anything outside it (streaming, websocket
// upgrade, Hono's validator middleware) is not available, and a route that
// needs it would not be portable anyway.
// =====================================================================

class HttpError extends Error {
  constructor(message, { status = 400, code = null, fields = null, headers = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.headers = headers;
  }
}

/** Normalise anything thrown into an HttpError with a usable status. */
function toHttpError(e) {
  if (e instanceof HttpError) return e;
  const status = Number(e && e.status);
  if (Number.isFinite(status) && status >= 400 && status < 600) {
    return new HttpError(e.message || 'Request failed', { status, code: e.code || null, fields: e.fields || null });
  }
  // A SQLite/D1 constraint failure is a 409 or 400, never a 500: the client
  // sent something the schema refuses, and telling them "internal error"
  // sends them away without the information they need to fix it.
  const msg = String((e && e.message) || '');
  if (/UNIQUE constraint failed/i.test(msg)) {
    return new HttpError('That record already exists — a unique value on it is already in use.', { status: 409, code: 'DUPLICATE' });
  }
  if (/FOREIGN KEY constraint failed/i.test(msg)) {
    return new HttpError('That record refers to something which does not exist (or was deleted). Reload the screen and try again.', { status: 400, code: 'BAD_REFERENCE' });
  }
  if (/CHECK constraint failed/i.test(msg)) {
    return new HttpError(`The figures do not add up: ${msg.replace(/^.*CHECK constraint failed:\s*/i, '')}`, { status: 400, code: 'CHECK_FAILED' });
  }
  if (/NOT NULL constraint failed/i.test(msg)) {
    return new HttpError('A required value is missing.', { status: 400, code: 'MISSING_VALUE' });
  }
  const wrapped = new HttpError(msg || 'Unexpected error', { status: 500, code: 'INTERNAL' });
  // THE ORIGINAL STACK, KEPT AS THE CAUSE. `toHttpError` turns a thrown TypeError into a
  // 500 and, in doing so, throws away the line that caused it — which is how a bug like
  // `Cannot read properties of null (reading 'id')` reaches a shopkeeper as a sentence with
  // no address. Attaching the original costs one property and gives the debug print
  // something to show. It never reaches the client: the response body is unchanged.
  if (e && e.stack) wrapped.cause = e;
  return wrapped;
}

// ---------------------------------------------------------------------
// PATH MATCHING
// ---------------------------------------------------------------------
/**
 * Compile a route pattern to a matcher.
 *
 * Supports `:name` segments and a trailing `*` wildcard. Patterns are
 * compiled once at registration, not per request — a router that recompiles
 * its regexes on every request is measurably slower on a till that fires
 * dozens of requests per sale.
 */
function compilePath(pattern) {
  const keys = [];
  const source = String(pattern)
    .split('/')
    .map((segment) => {
      if (segment === '') return '';
      if (segment === '*') { keys.push('*'); return '(?:\\/(.*))?'; }
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '\\/([^\\/]+)';
      }
      return `\\/${segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
    })
    .join('');
  return { regex: new RegExp(`^${source}\\/?$`), keys };
}

function matchPath(compiled, pathname) {
  const m = compiled.regex.exec(pathname);
  if (!m) return null;
  const params = {};
  compiled.keys.forEach((key, i) => {
    const raw = m[i + 1];
    params[key] = raw === undefined ? null : decodeURIComponent(raw);
  });
  return params;
}

// ---------------------------------------------------------------------
// CONTEXT
// ---------------------------------------------------------------------
class Context {
  constructor({ method, url, headers, body, env, params }) {
    const parsed = new URL(url, 'http://localhost');
    this.method = method.toUpperCase();
    this.path = parsed.pathname;
    this.url = parsed;
    this.env = env || {};
    this._headers = headers || new Headers();
    this._body = body;
    this._params = params || {};
    this._store = new Map();
    this._status = 200;
    this._responseHeaders = new Headers();
    this._body_out = null;
    this.finalized = false;
    this.res = null;

    const self = this;
    this.req = {
      get method() { return self.method; },
      get path() { return self.path; },
      get url() { return self.url.toString(); },
      get query() { return Object.fromEntries(parsed.searchParams.entries()); },
      param(name) {
        if (name === undefined) return { ...self._params };
        return self._params[name] === undefined ? null : self._params[name];
      },
      queryParam(name) { return parsed.searchParams.get(name); },
      queryAll(name) { return parsed.searchParams.getAll(name); },
      header(name) {
        if (name === undefined) return Object.fromEntries(self._headers.entries());
        return self._headers.get(name);
      },
      async json() {
        if (self._body === null || self._body === undefined) return {};
        if (typeof self._body === 'string') {
          if (!self._body.trim()) return {};
          try { return JSON.parse(self._body); } catch (e) {
            throw new HttpError('The request body is not valid JSON.', { status: 400, code: 'BAD_JSON' });
          }
        }
        if (typeof self._body === 'object') return self._body;
        throw new HttpError('The request body could not be read.', { status: 400, code: 'BAD_BODY' });
      },
      async text() { return self._body == null ? '' : String(self._body); },
      async parseBody() { return self.req.json(); },
      get raw() { return { method: self.method, url: self.url.toString(), headers: self._headers }; },
    };
  }

  get(key) { return this._store.get(key); }
  set(key, value) { this._store.set(key, value); return this; }

  status(code) { this._status = code; return this; }

  header(name, value) {
    if (value === null || value === undefined) this._responseHeaders.delete(name);
    else this._responseHeaders.set(name, String(value));
    return this;
  }

  json(data, status) {
    if (status !== undefined) this._status = status;
    this._responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
    this._body_out = JSON.stringify(data === undefined ? null : data);
    this.finalized = true;
    return this;
  }

  text(body, status) {
    if (status !== undefined) this._status = status;
    this._responseHeaders.set('Content-Type', 'text/plain; charset=utf-8');
    this._body_out = body == null ? '' : String(body);
    this.finalized = true;
    return this;
  }

  html(body, status) {
    if (status !== undefined) this._status = status;
    this._responseHeaders.set('Content-Type', 'text/html; charset=utf-8');
    this._body_out = body == null ? '' : String(body);
    this.finalized = true;
    return this;
  }

  body(value, status) {
    if (status !== undefined) this._status = status;
    this._body_out = value;
    this.finalized = true;
    return this;
  }

  redirect(location, status = 302) {
    this._status = status;
    this._responseHeaders.set('Location', String(location));
    this._body_out = '';
    this.finalized = true;
    return this;
  }

  /** Build the outgoing Response. Used by the Node adapter to write to res. */
  toResponse() {
    let body = this._body_out;
    // A leading U+FEFF is a BOM the handler deliberately added — the CSV export
    // does, so Excel detects UTF-8 instead of guessing a legacy codepage and
    // turning ₦ into mojibake. The WHATWG text decoder STRIPS a leading BOM by
    // design (it is built for decoding noise, not for carrying data), so the
    // string is encoded to bytes here and the BOM rides on the wire intact.
    // Anything reading the body as text will still not see it — that is the
    // standard's behaviour, not ours — so the CSV test checks the raw bytes.
    if (typeof body === 'string' && body.charCodeAt(0) === 0xFEFF) {
      body = new TextEncoder().encode(body);
    }
    return new Response(body, { status: this._status, headers: this._responseHeaders });
  }
}

// ---------------------------------------------------------------------
// APP
// ---------------------------------------------------------------------
class App {
  constructor() {
    this.routes = [];       // { method, pattern, compiled, handler }
    this.middlewares = [];  // { matcher, handler }
    this._notFound = null;
    this._onError = null;
  }

  use(pathOrFn, maybeFn) {
    if (typeof pathOrFn === 'function') { this.middlewares.push({ pattern: '*', compiled: null, handler: pathOrFn }); return this; }
    // Passed to compilePath UNCHANGED. compilePath already turns a segment that
    // is exactly `*` into `(?:\/(.*))?`, so '/api/*' correctly matches /api,
    // /api/stock and /api/reports/sales.
    //
    // It used to be rewritten here first: '/api/*' -> '/api*'. But '/api*' is a
    // single segment whose text is "api*", and compilePath escapes the asterisk
    // in a literal segment, producing ^\/api\*\/?$ — a pattern that matches only
    // the literal path "/api*" and therefore NOTHING in the real API. The effect
    // was that every `app.use('/api/*', ...)` middleware silently never ran, so
    // the auth guard was bypassed on all 160-odd guarded endpoints and
    // ctx.user/ctx.scope were simply undefined inside them.
    const compiled = compilePath(pathOrFn);
    this.middlewares.push({ pattern: pathOrFn, compiled, handler: maybeFn });
    return this;
  }

  _add(method, pattern, handler) {
    if (typeof pattern === 'function') { this.middlewares.push({ pattern: '*', compiled: null, handler: pattern }); return this; }
    this.routes.push({ method, pattern, compiled: compilePath(pattern), handler });
    return this;
  }

  get(p, h) { return this._add('GET', p, h); }
  post(p, h) { return this._add('POST', p, h); }
  put(p, h) { return this._add('PUT', p, h); }
  patch(p, h) { return this._add('PATCH', p, h); }
  delete(p, h) { return this._add('DELETE', p, h); }
  all(p, h) { return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].reduce((app, m) => app._add(m, p, h), this); }

  /** Mount a sub-app's routes under a prefix. Mirrors Hono's app.route(). */
  route(prefix, subApp) {
    if (!subApp || !Array.isArray(subApp.routes)) {
      throw new Error(`app.route('${prefix}', ...) expects a sub-app created by createApp()`);
    }
    for (const r of subApp.routes) {
      const joined = (prefix.replace(/\/$/, '') + (r.pattern.startsWith('/') ? r.pattern : `/${r.pattern}`)) || '/';
      this.routes.push({ method: r.method, pattern: joined, compiled: compilePath(joined), handler: r.handler });
    }
    for (const m of subApp.middlewares) {
      const joined = m.pattern === '*' ? `${prefix.replace(/\/$/, '')}/*` : prefix.replace(/\/$/, '') + m.pattern;
      // Same rule as use(): the pattern goes to compilePath unchanged, because
      // compilePath is what understands a `*` segment.
      this.middlewares.push({ pattern: joined, compiled: compilePath(joined), handler: m.handler });
    }
    if (subApp._notFound && !this._notFound) this._notFound = subApp._notFound;
    if (subApp._onError && !this._onError) this._onError = subApp._onError;
    return this;
  }

  notFound(fn) { this._notFound = fn; return this; }
  onError(fn) { this._onError = fn; return this; }

  /** Find the matching route and its params. Exported so tests can assert routing. */
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method && r.method !== 'ALL') continue;
      const params = matchPath(r.compiled, pathname);
      if (params) return { route: r, params };
    }
    return null;
  }

  async handle(ctx) {
    // Middleware chain. `next` advances; a middleware that does not call next
    // short-circuits, which is how the auth guard refuses unauthenticated
    // requests without every route re-checking.
    const applicable = this.middlewares.filter((m) => {
      if (m.pattern === '*' || !m.compiled) return true;
      return matchPath(m.compiled, ctx.path) !== null;
    });

    let index = 0;
    const dispatch = async () => {
      if (ctx.finalized) return;
      if (index < applicable.length) {
        const mw = applicable[index];
        index += 1;
        const params = mw.compiled ? matchPath(mw.compiled, ctx.path) : {};
        if (params) ctx._params = { ...params, ...ctx._params };
        await mw.handler(ctx, dispatch);
        return;
      }
      const found = this.match(ctx.method, ctx.path);
      if (!found) {
        if (this._notFound) { await this._notFound(ctx); return; }
        ctx.json({ error: `No route for ${ctx.method} ${ctx.path}`, code: 'NOT_FOUND' }, 404);
        return;
      }
      ctx._params = { ...found.params };
      await found.route.handler(ctx, dispatch);
    };

    try {
      await dispatch();
      if (!ctx.finalized) {
        if (this._notFound) await this._notFound(ctx);
        else ctx.json({ error: 'The server produced no response for this request.', code: 'EMPTY_RESPONSE' }, 500);
      }
    } catch (e) {
      const err = toHttpError(e);
      if (this._onError) {
        try { await this._onError(err, ctx); return ctx; } catch (inner) {
          // An error handler that itself throws must not leave the client
          // hanging; fall through to the default shape.
          ctx.finalized = false;
        }
      }
      if (err.status >= 500) console.error(`[http] ${ctx.method} ${ctx.path}:`, err.message, err.stack);
      const headers = err.headers || {};
      ctx.json({ error: err.message, code: err.code || undefined, fields: err.fields || undefined }, err.status);
      for (const [k, v] of Object.entries(headers)) ctx.header(k, v);
    }
    return ctx;
  }

  /**
   * Hono-compatible entry point: `app.fetch(requestOrMethod, urlOrEnv, init)`.
   *
   * Both call shapes are accepted because the two backends naturally reach for
   * different ones — a Workers handler already holds a `Request`, while the Node
   * adapter has method/url/headers/body sitting separately on `req`. Supporting
   * both here means neither adapter has to construct the other's type, and the
   * route files cannot tell which runtime they are on.
   *
   * Returns a web `Response`, which Node 20 has natively.
   */
  async fetch(requestOrMethod, urlOrEnv, init = {}) {
    let method; let url; let headers; let body; let env;

    if (requestOrMethod && typeof requestOrMethod === 'object' && typeof requestOrMethod.method === 'string' && requestOrMethod.url) {
      // A Request-like object.
      const request = requestOrMethod;
      method = request.method;
      url = request.url;
      headers = request.headers;
      env = urlOrEnv || {};
      body = request.body == null ? null : request.body;
      if (body && typeof body !== 'string' && typeof request.text === 'function') body = await request.text();
    } else {
      method = String(requestOrMethod || 'GET');
      url = String(urlOrEnv || '/');
      headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers || {});
      body = init.body === undefined ? null : init.body;
      env = init.env || {};
    }

    // A relative URL is completed so `new URL()` cannot throw. The host is
    // never used for routing — only the pathname and query are.
    const absolute = /^https?:\/\//i.test(url) ? url : `http://localhost${url.startsWith('/') ? '' : '/'}${url}`;
    const ctx = new Context({ method, url: absolute, headers, body, env });
    decorate(ctx);
    await this.handle(ctx);
    return ctx.toResponse();
  }
}

/**
 * Give a Context its convenience accessors.
 *
 * Applied here rather than in the constructor so `handle()` can also be called
 * directly with a bare Context (the tests do this) and still read `ctx.user`.
 */
function decorate(ctx) {
  if (ctx._decorated) return;
  ctx._decorated = true;
  Object.defineProperty(ctx, 'user', { get: () => ctx.get('user'), configurable: true });
  Object.defineProperty(ctx, 'scope', { get: () => ctx.get('scope'), configurable: true });
  Object.defineProperty(ctx, 'db', { get: () => ctx.env.DB || ctx.env.db, configurable: true });
}

function createApp() { return new App(); }

module.exports = { App, Context, HttpError, createApp, compilePath, matchPath, toHttpError };
