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
  // Do not start from navigator.onLine. Electron can report no network while
  // the shop on this computer's proxy is answering. The probe is the authority.
  let online = true;
  let lineReturnedAt = 0;
  let lastProbe = 0;
  let probing = null;
  let probeMisses = 0;
  let probeUp = null;
  let recheckTimer = null;
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

  // The desktop sign-in does not go through request(), so a live token would
  // otherwise leave the flag from the last miss. A connected sign-in is online.
  function noteReachable(up) {
    if (up) {
      probeMisses = 0;
      const was = probeUp;
      probeUp = true;
      setOnline(true);
      if (!was) emit('net', { online: true, confirmed: true });
    }
    return online;
  }

  // A phone with no network is offline. Electron can report the same flag while
  // the shop on this computer's proxy is answering, so that flag is ignored there.
  function browserOfflineTrusted() {
    if (global.stockridgeNative) return false;
    try { return typeof navigator !== 'undefined' && navigator.onLine === false; } catch (e) { return false; }
  }

  function shopConfirmed() { return probeUp === true; }

  function markOfflineNow() {
    if (browserOfflineTrusted()) {
      probeUp = false;
      setOnline(false);
      return true;
    }
    const policy = global.SRReach && global.SRReach.shouldMarkOffline;
    const mark = policy
      ? policy({ probeAttempted: true, probeAnswered: false, consecutiveProbeMisses: probeMisses })
      : probeMisses >= 2;
    if (mark) setOnline(false);
    else armRecheck();
    return mark;
  }

  function armRecheck() {
    if (recheckTimer) return;
    recheckTimer = setTimeout(() => {
      recheckTimer = null;
      probe({ force: true }).catch(() => {});
    }, 4000);
  }

  function holdCatchUp(ms, options) {
    const until = Date.now() + (Number(ms) || 180000);
    const shorten = Boolean(options && options.shorten);
    if (!shorten) lineReturnedAt = Date.now();
    global.SR._catchingUp = true;
    const current = Number(global.SR._holdUntil) || 0;
    global.SR._holdUntil = shorten ? until : Math.max(current, until);
    clearTimeout(global.SR._catchUpTimer);
    global.SR._catchUpTimer = setTimeout(() => {
      if (Date.now() < (Number(global.SR._holdUntil) || 0)) return;
      global.SR._catchingUp = false;
    }, Math.max(1000, until - Date.now()));
  }

  function setOnline(next, { silent = false } = {}) {
    const value = Boolean(next);
    const was = online;
    if (value === online) return;
    online = value;
    if (value && !was) holdCatchUp(180000);
    if (!silent) emit('net', { online, returned: value && !was });
  }

  // The first requests after the line returns are not a sign-out. The saved
  // till stays open while the follower catches up to the shop. Twenty seconds
  // was shorter than the upload.
  function reconnecting() {
    return lineReturnedAt > 0 && Date.now() - lineReturnedAt < 90000;
  }

  function pageJustChanged() {
    const at = global.SR && global.SR._navigatedAt;
    return Boolean(at && Date.now() - at < 45000);
  }

  function catchingUp() {
    if (global.SR && Number(global.SR._holdUntil) > Date.now()) return true;
    return Boolean(global.SR && (global.SR._catchingUp || global.SR._uploading));
  }

  // A browser offline event is not the shop. Ask the shop before changing the chip.
  // The online event is the catch-up, even when the flag was already true.
  global.addEventListener('online', () => {
    holdCatchUp(180000);
    probe({ force: true }).catch(() => {});
  });
  global.addEventListener('offline', () => { probe({ force: true }).catch(() => {}); });

  /**
   * Confirm the server is actually reachable.
   *
   * `navigator.onLine` means "there is a network interface", not "the internet
   * works" — a captive portal or a router with a dead uplink reports true while
   * every request fails. A failed fetch is therefore also treated as evidence,
   * and this probe is what recovers the app once the line genuinely returns.
   */
  function reached(status, text) {
    if (global.SRReach && global.SRReach.shopAnswered) return global.SRReach.shopAnswered(status, text);
    const code = Number(status);
    const body = String(text || '');
    if (!Number.isFinite(code) || code <= 0 || code >= 500) return false;
    return !/UPSTREAM_UNREACHABLE|shop server could not be reached|did not answer from this window/i.test(body);
  }

  async function probe({ force = false } = {}) {
    if (!force && Date.now() - lastProbe < 8000) return online;
    if (probing) return probing;
    probing = (async () => {
      lastProbe = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        // /api/health is a real shop answer. The ping route is a 404, which
        // still proves the shop spoke, but health is the clearer check.
        // Eight seconds is enough to know a dead line did not answer. A longer
        // wait is what left an offline sign-in sitting on "Signing in…".
        const res = await fetch('/api/health', {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal,
          headers: { 'X-Device-Id': SR.device.current().id },
        });
        const text = await res.clone().text().catch(() => '');
        const up = reached(res.status, text);
        if (up) {
          probeMisses = 0;
          probeUp = true;
          setOnline(true);
          return true;
        }
        probeMisses += 1;
        probeUp = false;
        markOfflineNow();
        return false;
      } catch (e) {
        probeMisses += 1;
        probeUp = false;
        markOfflineNow();
        return false;
      } finally {
        clearTimeout(timer);
        probing = null;
      }
    })();
    return probing;
  }

  // Recover a false Offline quickly. A connected till must not sit on the
  // banner for most of a minute after one missed read.
  setInterval(() => { if (!online) probe({ force: true }); }, 12000);

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
    get isOffline() {
      if (this.status === 0 || this.code === 'OFFLINE' || this.code === 'UPSTREAM_UNREACHABLE' || this.code === 'SHOP_UNCONFIRMED') return true;
      return /shop server could not be reached|did not answer from this window|failed to fetch/i.test(String(this.message || ''));
    }
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
  async function settleMiss(err, method, path, opts) {
    const options = opts || {};
    const up = await probe({ force: true }).catch(() => false);
    if (up && !options.retried) {
      setOnline(true);
      return request(method, path, Object.assign({}, options, { retried: true }));
    }
    if (up) {
      setOnline(true);
      if (options.queue === 'auto') {
        ejectToOutbox(method, path, options.body, { idempotencyKey: options.idempotencyKey, label: options.headers && options.headers['X-Queue-Label'] });
        return { queued: true, ok: true, offline: false, path };
      }
      throw new ApiError('The shop is up, but this screen did not load. Try again.', {
        status: 503,
        code: 'SHOP_READ_FAILED',
        retryable: false,
      });
    }
    const marked = markOfflineNow();
    // The probe did not answer. Do not say the shop is up. That sentence was
    // what an offline sign-in showed instead of opening the saved till.
    // The chip still waits for a second miss unless the phone itself is offline.
    if (!marked) {
      if (options.queue === 'auto') {
        ejectToOutbox(method, path, options.body, { idempotencyKey: options.idempotencyKey, label: options.headers && options.headers['X-Queue-Label'] });
        return { queued: true, ok: true, offline: true, path };
      }
      throw new ApiError('The shop did not answer from this window. Try again.', {
        status: 0,
        code: 'SHOP_UNCONFIRMED',
        retryable: true,
      });
    }
    if (options.queue === 'auto') {
      ejectToOutbox(method, path, options.body, { idempotencyKey: options.idempotencyKey, label: options.headers && options.headers['X-Queue-Label'] });
      return { queued: true, ok: true, offline: true, path };
    }
    throw err;
  }

  async function request(method, path, { body, query, headers = {}, queue = false, idempotencyKey = null, timeoutMs = 20000, raw = false, retried = false, quiet = false } = {}) {
    const url = buildUrl(path, query);
    const auth = loadToken();

    const h = Object.assign({ Accept: 'application/json' }, headers);
    if (body !== undefined && body !== null) h['Content-Type'] = 'application/json';
    if (auth) h.Authorization = `Bearer ${auth}`;
    const deviceId = SR.device && SR.device.current ? SR.device.current().id : '';
    if (deviceId && deviceId !== 'SR-UNKNOWN') h['X-Device-Id'] = deviceId;
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
    } catch (e) {
      const missed = new ApiError(
        e && e.name === 'AbortError'
          ? 'The server did not answer in time. Check the connection and try again.'
          : 'The shop did not answer from this window. Try again.',
        { status: 0, code: 'OFFLINE', retryable: true },
      );
      return settleMiss(missed, method, path, { body, query, headers, queue, idempotencyKey, timeoutMs, raw, retried });
    } finally {
      clearTimeout(timer);
    }

    if (raw) return res;

    const text = await res.text();
    if (!res.ok) {
      const err = await parseError(res, text);
      if (err.isOffline) return settleMiss(err, method, path, { body, query, headers, queue, idempotencyKey, timeoutMs, raw, retried });
      probeMisses = 0;
      setOnline(true);
      // A page refusal is not a sign-out. Only a dead session ends the till,
      // and the shell confirms that before leaving. A missing token on one
      // path is a dropped header, not a logout.
      const fatalAuth = err.code === 'SESSION_REVOKED' || err.code === 'BAD_TOKEN' || err.code === 'TOKEN_EXPIRED' || err.code === 'USER_GONE' || err.code === 'SESSION_SUPERSEDED';
      if (err.isAuth && fatalAuth && !quiet && !reconnecting() && !pageJustChanged() && !catchingUp()) {
        err.token = auth;
        emit('auth', { reason: err.code, token: auth, message: err.message });
      }
      // A REFUSAL THE APP SHOULD REACT TO, not just report. `SUBSCRIPTION_NOT_ACTIVE`
      // means the account has been suspended since the settings were last read, and the
      // shell draws a bar from those settings — so it has to be told. The refusal itself
      // is still thrown: the caller shows the server's message where the person tried.
      if (err.code === 'SUBSCRIPTION_NOT_ACTIVE') emit('plan', { code: err.code, status: err.status });
      if (method === 'GET' && err.isAuth && (reconnecting() || pageJustChanged() || catchingUp())) {
        throw new ApiError('The line just returned. Showing the books saved on this till.', { status: 0, code: 'OFFLINE', retryable: true });
      }
      throw err;
    }
    let parsed = {};
    if (text) {
      try { parsed = JSON.parse(text); } catch (e) { parsed = { ok: true, raw: text }; }
    }
    // The saved-till door answers 200 with offline:true. That is this computer,
    // not the shop. Do not mark the till online from it.
    if (!parsed || parsed.offline !== true) {
      probeMisses = 0;
      const was = probeUp;
      probeUp = true;
      setOnline(true);
      if (!was) emit('net', { online: true, confirmed: true });
    }
    return parsed;
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
  async function login({ username, pin, remember = true }) {
    const device = SR.device && SR.device.current ? SR.device.current() : null;
    const out = await request('POST', '/api/auth/login', {
      body: { username, pin, remember: Boolean(remember), deviceId: device && device.id && device.id !== 'SR-UNKNOWN' ? device.id : undefined },
      queue: false,
      timeoutMs: 8000,
    });
    if (out.token) setToken(out.token, { remember: Boolean(remember) });
    return out;
  }

  async function me({ quiet = false } = {}) { return request('GET', '/api/auth/me', { quiet }); }

  async function logout() {
    try { await request('POST', '/api/auth/logout', { body: {} }); } catch (e) { /* the token is being dropped anyway */ }
    setToken(null);
  }

  SR.api = {
    ApiError,
    get, post, put, patch, del, request,
    login, me, logout,
    setToken, hasToken, loadToken,
    isOnline, noteReachable, shopConfirmed, reconnecting, catchingUp, holdCatchUp, probe, on, emit, canQueue, classify,
    TOKEN_KEY,
  };
}(window));
