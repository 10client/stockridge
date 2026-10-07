'use strict';
// =====================================================================
// public/js/api.js — ONE DOOR TO THE SERVER, ONLINE OR NOT
// =====================================================================
// Every call in the app goes through `SR.api`. It exists so that three things
// happen in exactly one place:
//
//   1. THE TOKEN IS ATTACHED, ONCE, and a 401 retires the session everywhere at
//      the same moment rather than in whichever view noticed first.
//   2. AN ERROR IS AN OBJECT, NOT A STRING. The server answers with
//      `{ error, code, problems, fields }` and the UI needs `code` to decide
//      whether to offer "sign in again" or "fix this field".
//   3. WRITES THAT CAN BE QUEUED ARE QUEUED. A sale, a stock adjustment, a
//      clock-in — these are physically happening in the shop whether or not the
//      line is up, so the app records them locally and tells the truth about
//      their status. Reads are never queued: a stale answer silently presented as
//      fresh is worse than "you are offline".
// =====================================================================
(function (global) {
  const SR = global.SR = global.SR || {};

  const TOKEN_KEY = 'sr.token';
  const ONLINE_PROBE_MS = 45000;

  let token = null;
  let online = navigator.onLine !== false;
  let lastProbe = 0;
  let probing = null;
  const listeners = new Map(); // event -> Set<fn>

  function emit(event, detail) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try { fn(detail); } catch (e) { /* one bad listener must not stop the rest */ }
    }
  }
  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  }

  // -------------------------------------------------------------------
  // token
  // -------------------------------------------------------------------
  function loadToken() {
    if (token) return token;
    try { token = sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || null; } catch (e) { token = null; }
    return token;
  }
  function setToken(value, { remember = true } = {}) {
    token = value || null;
    try {
      if (value && remember) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* private mode: the session token lives in memory only */ }
    try {
      // sessionStorage always holds it, so a reload in the same tab keeps the
      // session even where localStorage is blocked.
      if (value) sessionStorage.setItem(TOKEN_KEY, value); else sessionStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* fine */ }
    return token;
  }
  function hasToken() { return Boolean(loadToken()); }

  // -------------------------------------------------------------------
  // connectivity
  // -------------------------------------------------------------------
  function isOnline() { return online; }

  function setOnline(next, { silent = false } = {}) {
    const value = Boolean(next);
    if (value === online) return;
    online = value;
    if (!silent) emit('net', { online });
  }

  global.addEventListener('online', () => setOnline(true));
  global.addEventListener('offline', () => setOnline(false));

  /**
   * Confirm the server is actually reachable.
   *
   * `navigator.onLine` means "there is a network interface", not "the internet
   * works" — a captive portal or a router with a dead uplink reports true while
   * every request fails. A failed fetch is therefore also treated as evidence,
   * and this probe is what recovers the app once the line genuinely returns.
   */
  async function probe({ force = false } = {}) {
    if (!force && Date.now() - lastProbe < 8000) return online;
    if (probing) return probing;
    probing = (async () => {
      lastProbe = Date.now();
      try {
        const res = await fetch('/api/health/ping', { method: 'GET', cache: 'no-store', headers: { 'X-Device-Id': SR.device.current().id } });
        // Any HTTP answer at all means the server is there; a 404 for the ping
        // route still proves the app is reachable, so the status is not tested.
        setOnline(true);
        return true;
      } catch (e) {
        setOnline(false);
        return false;
      } finally {
        probing = null;
      }
    })();
    return probing;
  }

  setInterval(() => { if (!online) probe({ force: true }); }, ONLINE_PROBE_MS);

  // -------------------------------------------------------------------
  // errors
  // -------------------------------------------------------------------
  class ApiError extends Error {
    constructor(message, { status = 0, code = 'ERROR', problems = null, fields = null, retryable = false, payload = null } = {}) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      this.problems = problems || [];
      this.fields = fields || null;
      this.retryable = retryable;
      this.payload = payload;
    }
    get isAuth() { return this.status === 401 || this.code === 'NO_TOKEN' || this.code === 'SESSION_SUPERSEDED'; }
    get isOffline() { return this.status === 0; }
  }

  async function parseError(res, text) {
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
    const raw = (body && (body.error || body.message)) || `The server refused that request (HTTP ${res.status}).`;
    // Constraint failures arrive as a bare SQLite sentence. Restating it as a
    // sentence the counter staff can act on is worth more than the fidelity.
    let message = String(raw);
    if (/UNIQUE constraint failed: ([^\s.]+)\.(\S+)/i.test(message)) {
      const m = /UNIQUE constraint failed: ([^\s.]+)\.(\S+)/i.exec(message);
      message = `That ${m[2].replace(/_/g, ' ')} is already in use.`;
    } else if (/CHECK constraint failed/i.test(message)) {
      message = 'The numbers do not add up, so this was refused. Check the amounts and try again.';
    } else if (/FOREIGN KEY constraint failed/i.test(message)) {
      message = 'That record refers to something that no longer exists. Reload and try again.';
    }
    return new ApiError(message, {
      status: res.status,
      code: (body && body.code) || `HTTP_${res.status}`,
      problems: (body && body.problems) || null,
      fields: (body && body.fields) || null,
      retryable: res.status >= 500,
      payload: body,
    });
  }

  // -------------------------------------------------------------------
  // the call
  // -------------------------------------------------------------------
  function buildUrl(path, query) {
    let url = path;
    if (query && Object.keys(query).length) {
      const usp = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '') continue;
        if (Array.isArray(v)) v.forEach((x) => usp.append(k, x));
        else usp.append(k, String(v));
      }
      const qs = usp.toString();
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    }
    return url;
  }

  /**
   * Perform a request. `queue` is where the offline behaviour is decided:
   *
   *   queue === false (default)  — read: fail loudly when offline
   *   queue === true             — write that CAN be queued from this screen
   *   queue === 'auto'           — write that is queued only if unreachable
   *
   * `queue: true` never even attempts the network for an operation the shop
   * performs at the counter. That is not laziness: the POS shows a receipt the
   * instant the sale is recorded locally and the printer is spun up, and waiting
   * for a 4-second timeout on a bad line makes the queue look like a freeze.
   * A queued write returns `{ queued: true, ... }` so the caller can say so.
   */
  async function request(method, path, { body, query, headers = {}, queue = false, idempotencyKey = null, timeoutMs = 20000, raw = false } = {}) {
    const url = buildUrl(path, query);
    const auth = loadToken();

    const h = Object.assign({ Accept: 'application/json' }, headers);
    if (body !== undefined && body !== null) h['Content-Type'] = 'application/json';
    if (auth) h.Authorization = `Bearer ${auth}`;
    h['X-Device-Id'] = SR.device.current().id;
    if (idempotencyKey) h['Idempotency-Key'] = idempotencyKey;

    // Queued straight away, without a network attempt.
    if (queue === true) {
      ejectToOutbox(method, path, body, { idempotencyKey, label: headers['X-Queue-Label'] });
      return { queued: true, ok: true, offline: true, path };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: h,
        body: body === undefined || body === null ? undefined : JSON.stringify(body),
        signal: controller.signal,
        cache: 'no-store',
      });
      // Any answer at all proves the server is up, even an error answer.
      setOnline(true);
    } catch (e) {
      setOnline(false);
      if (queue === 'auto') {
        ejectToOutbox(method, path, body, { idempotencyKey, label: headers['X-Queue-Label'] });
        return { queued: true, ok: true, offline: true, path };
      }
      throw new ApiError(
        e && e.name === 'AbortError'
          ? 'The server did not answer in time. Check the connection and try again.'
          : 'Cannot reach the server. You appear to be offline.',
        { status: 0, code: 'OFFLINE', retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }

    if (raw) return res;

    const text = await res.text();
    if (!res.ok) {
      const err = await parseError(res, text);
      if (err.isAuth) emit('auth', { reason: err.code });
      // A REFUSAL THE APP SHOULD REACT TO, not just report. `SUBSCRIPTION_NOT_ACTIVE`
      // means the account has been suspended since the settings were last read, and the
      // shell draws a bar from those settings — so it has to be told. The refusal itself
      // is still thrown: the caller shows the server's message where the person tried.
      if (err.code === 'SUBSCRIPTION_NOT_ACTIVE') emit('plan', { code: err.code, status: err.status });
      throw err;
    }
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (e) {
      return { ok: true, raw: text };
    }
  }

  function ejectToOutbox(method, path, body, { idempotencyKey, label }) {
    const { type, pathParams } = classify(method, path);
    SR.store.enqueue({
      type,
      payload: Object.assign({}, body || {}, { _path: path }),
      pathParams,
      label: label || type,
      ref: idempotencyKey || null,
      occurredAt: (body && body.sold_at) || SR.util.nowWatSql(),
    }).then(() => emit('queue', { size: null })).catch(() => {});
  }

  /**
   * Map a REST path onto one of the operation types the sync endpoint knows how
   * to replay. Anything not on this list CANNOT be queued — which is the same
   * whitelist the server enforces, restated here so the UI can refuse to offer a
   * button that would queue work that can never be applied.
   */
  function classify(method, path) {
    const rules = [
      [/^\/api\/sales\/([^/]+)\/void$/, 'POST', 'SALE_VOID'],
      [/^\/api\/sales\/([^/]+)\/pay$/, 'POST', 'SALE_PAYMENT'],
      [/^\/api\/sales$/, 'POST', 'SALE'],
      [/^\/api\/customers\/([^/]+)\/payments$/, 'POST', 'CUSTOMER_PAYMENT'],
      [/^\/api\/stock\/adjust$/, 'POST', 'STOCK_ADJUST'],
      [/^\/api\/attendance\/clock-in$/, 'POST', 'CLOCK_IN'],
      [/^\/api\/attendance\/clock-out$/, 'POST', 'CLOCK_OUT'],
      [/^\/api\/stocktakes\/([^/]+)\/counts$/, 'POST', 'STOCKTAKE_COUNTS'],
      [/^\/api\/deliveries\/([^/]+)\/status$/, 'POST', 'DELIVERY_STATUS'],
      [/^\/api\/deposits\/([^/]+)\/payments$/, 'POST', 'DEPOSIT_PAYMENT'],
      [/^\/api\/instalments\/([^/]+)\/payments$/, 'POST', 'INSTALMENT_PAYMENT'],
      [/^\/api\/expenses$/, 'POST', 'EXPENSE'],
    ];
    for (const [re, m, type] of rules) {
      if (m !== method) continue;
      const hit = re.exec(path);
      if (!hit) continue;
      const names = ['id'];
      const pathParams = {};
      names.forEach((n, i) => { if (hit[i + 1]) pathParams[n] = decodeURIComponent(hit[i + 1]); });
      return { type, pathParams: Object.keys(pathParams).length ? pathParams : null };
    }
    return { type: 'UNSUPPORTED', pathParams: null };
  }

  function canQueue(method, path) {
    return classify(method, path).type !== 'UNSUPPORTED';
  }

  // -------------------------------------------------------------------
  // sugar
  // -------------------------------------------------------------------
  const get = (path, opts) => request('GET', path, opts);
  const post = (path, body, opts) => request('POST', path, Object.assign({ body }, opts));
  const put = (path, body, opts) => request('PUT', path, Object.assign({ body }, opts));
  const patch = (path, body, opts) => request('PATCH', path, Object.assign({ body }, opts));
  const del = (path, opts) => request('DELETE', path, opts);

  // -------------------------------------------------------------------
  // auth
  // -------------------------------------------------------------------
  async function login({ username, pin }) {
    const out = await request('POST', '/api/auth/login', { body: { username, pin }, queue: false });
    if (out.token) setToken(out.token);
    return out;
  }

  async function me() { return request('GET', '/api/auth/me'); }

  async function logout() {
    try { await request('POST', '/api/auth/logout', { body: {} }); } catch (e) { /* the token is being dropped anyway */ }
    setToken(null);
  }

  SR.api = {
    ApiError,
    get, post, put, patch, del, request,
    login, me, logout,
    setToken, hasToken, loadToken,
    isOnline, probe, on, emit, canQueue, classify,
    TOKEN_KEY,
  };
}(window));
