// =====================================================================
// public/js/api.js — the ONE place that talks to the server
// =====================================================================
// Every view goes through this module. That is not tidiness, it is what makes
// the following true in exactly one place each:
//
//   * the session token is attached
//   * a 401 signs the user out rather than showing a broken screen
//   * a 402 (subscription) says something useful instead of "error"
//   * a failed WRITE is queued for retry rather than lost
//   * an error carries its `code`, so a view can react to
//     SERIAL_CAPTURE_REQUIRED differently from INSUFFICIENT_STOCK
//
// A view that fetches directly would have to reimplement all five, and the one
// that gets missed is the one that loses a sale.

'use strict';

import { state, setSession, clearSession } from './state.js';
import { queueSale, queueSize } from './offline.js';
import { toast } from './ui.js';

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

export class ApiError extends Error {
  constructor(message, { status, code, details, field, warnings, requestId, retryAfterSeconds } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status || 0;
    this.code = code || 'UNKNOWN';
    this.details = details || null;
    this.field = field || null;
    this.warnings = warnings || null;
    this.requestId = requestId || null;
    this.retryAfterSeconds = retryAfterSeconds || null;
  }

  /** A refusal the operator can act on, as opposed to a broken system. */
  get isBusinessRefusal() { return this.status >= 400 && this.status < 500; }
}

function deviceId() {
  // A persistent per-browser id. NOT a hardware serial — no browser can read one.
  // It identifies "this browser profile on this device" for as long as site data
  // survives, which is the same practical guarantee commercial POS
  // terminal-locking relies on, and it is what lets an offline sale be attributed
  // and replayed exactly once.
  try {
    let id = localStorage.getItem('sr.device');
    if (!id) {
      const rand = (crypto && crypto.randomUUID) ? crypto.randomUUID().replace(/-/g, '') : String(Math.random()).slice(2);
      id = `dev-${Date.now().toString(36)}-${rand.slice(0, 16)}`;
      localStorage.setItem('sr.device', id);
    }
    return id;
  } catch (e) {
    return 'dev-unknown';
  }
}

function headers(extra = {}) {
  const h = { ...JSON_HEADERS, 'X-Device-Id': deviceId(), ...extra };
  if (state.token) h.Authorization = `Bearer ${state.token}`;
  return h;
}

/**
 * The core request.
 *
 * @param {string} path
 * @param {object} [opts]
 * @param {string} [opts.method]
 * @param {*}      [opts.body]        JSON-serialisable
 * @param {object} [opts.query]       appended as a query string
 * @param {string} [opts.idempotencyKey]  required for money-moving writes
 * @param {boolean}[opts.offlineOk]   queue instead of failing when offline
 */
export async function api(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const url = opts.query ? `${path}?${new URLSearchParams(
    Object.entries(opts.query).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]),
  ).toString()}` : path;

  const doFetch = async () => {
    const init = { method, headers: headers(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}) };
    if (opts.body !== undefined && method !== 'GET') init.body = JSON.stringify(opts.body);

    let res;
    try {
      res = await fetch(url, init);
    } catch (networkErr) {
      // No response at all: DNS, TLS, server down, or the device is offline.
      const offline = !navigator.onLine;
      if (opts.offlineOk && method !== 'GET') {
        const queued = await queueSale({ path: url, method, body: opts.body, idempotencyKey: opts.idempotencyKey });
        return {
          __queued: true, queued, offline,
          message: offline
            ? 'No connection. This has been saved on this device and will send itself when you are back online.'
            : 'The server could not be reached. This has been saved on this device and will retry.',
        };
      }
      throw new ApiError(
        offline ? 'You are offline. Read-only screens still work from the cache.' : 'Could not reach the server.',
        { status: 0, code: offline ? 'OFFLINE' : 'NETWORK_ERROR' },
      );
    }

    const text = await res.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch (e) { body = { error: text.slice(0, 300) }; }
    }

    if (!res.ok) {
      // A 401 means the session is gone. Signing out here, once, is what stops
      // every subsequent screen from failing individually and confusingly.
      if (res.status === 401 && state.token && path !== '/auth/login') {
        clearSession();
        window.dispatchEvent(new CustomEvent('sr:signed-out', { detail: { code: body && body.code } }));
      }
      throw new ApiError(
        (body && body.error) || `Request failed (${res.status})`,
        {
          status: res.status,
          code: body && body.code,
          details: body && body.details,
          field: body && body.field,
          warnings: body && body.warnings,
          requestId: body && body.requestId,
          retryAfterSeconds: body && body.retryAfterSeconds,
        },
      );
    }
    if (res.status === 204) return null;
    return body;
  };

  try {
    return await doFetch();
  } catch (err) {
    // A 402 is a billing state, not a bug, and it deserves a message that tells
    // the proprietor who to call rather than a generic failure.
    if (err instanceof ApiError && err.status === 402) {
      toast(err.message, { kind: 'warn', duration: 9000 });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------
// endpoints, grouped by domain
// ---------------------------------------------------------------------
export const endpoints = {
  health: () => api('/api/health'),
  branding: () => api('/branding'),
  reference: () => api('/reference'),

  login: (username, pin) => api('/auth/login', { method: 'POST', body: { username, pin } }),
  logout: () => api('/auth/logout', { method: 'POST', body: {} }),
  me: () => api('/auth/me'),
  changePin: (current_pin, new_pin) => api('/auth/change-pin', { method: 'POST', body: { current_pin, new_pin } }),

  businesses: () => api('/businesses'),
  createBusiness: (b) => api('/businesses', { method: 'POST', body: b }),
  updateBusiness: (id, b) => api(`/businesses/${encodeURIComponent(id)}`, { method: 'PATCH', body: b }),

  branches: () => api('/branches'),
  createBranch: (b) => api('/branches', { method: 'POST', body: b }),
  updateBranch: (id, b) => api(`/branches/${encodeURIComponent(id)}`, { method: 'PATCH', body: b }),

  products: (q) => api('/products', { query: q }),
  product: (id) => api(`/products/${encodeURIComponent(id)}`),
  createProduct: (p) => api('/products', { method: 'POST', body: p }),
  updateProduct: (id, p) => api(`/products/${encodeURIComponent(id)}`, { method: 'PATCH', body: p }),
  categories: (businessId) => api('/catalog/categories', { query: { business_id: businessId } }),
  barcode: (code, branchId) => api(`/catalog/barcode/${encodeURIComponent(code)}`, { query: { branch_id: branchId } }),

  // A sale is the one call that MUST be idempotent and MUST be queueable: the POS
  // retries after a dropped connection, and without a key that is a second stock
  // decrement and a second drawer total.
  createSale: (body, idempotencyKey) => api('/sales', { method: 'POST', body, idempotencyKey, offlineOk: true }),
  sales: (q) => api('/sales', { query: q }),
  sale: (id) => api(`/sales/${encodeURIComponent(id)}`),
  receipt: (id) => api(`/sales/${encodeURIComponent(id)}/receipt`),
  voidSale: (id, reason) => api(`/sales/${encodeURIComponent(id)}/void`, { method: 'POST', body: { reason } }),

  stock: (q) => api('/stock', { query: q }),
  stockAlerts: (q) => api('/stock/alerts', { query: q }),
  stockBatches: (productId) => api(`/stock/batches/${encodeURIComponent(productId)}`),
  stockMovements: (q) => api('/stock/movements', { query: q }),
  receiveStock: (body, key) => api('/stock/receive', { method: 'POST', body, idempotencyKey: key }),

  customers: (q) => api('/customers', { query: q }),
  createCustomer: (c) => api('/customers', { method: 'POST', body: c }),
  customerStatement: (id) => api(`/customers/${encodeURIComponent(id)}/statement`),
  customerPayment: (id, body, key) => api(`/customers/${encodeURIComponent(id)}/payments`, { method: 'POST', body, idempotencyKey: key }),

  tills: () => api('/till'),
  openTill: (body) => api('/till/open', { method: 'POST', body }),
  closeTill: (id, body) => api(`/till/${encodeURIComponent(id)}/close`, { method: 'POST', body }),

  safe: (branchId) => api(`/safe/${encodeURIComponent(branchId)}`),
  safeMovement: (body) => api('/safe/movements', { method: 'POST', body }),
  changeOwed: () => api('/change-owed'),
  changeOwedLookup: (code) => api(`/change-owed/lookup/${encodeURIComponent(code)}`),
  changeOwedCollect: (id) => api(`/change-owed/${encodeURIComponent(id)}/collect`, { method: 'POST', body: {} }),

  holds: (q) => api('/holds', { query: q }),
  createHold: (body) => api('/holds', { method: 'POST', body }),
  releaseHold: (id, body) => api(`/holds/${encodeURIComponent(id)}/release`, { method: 'POST', body }),

  instalments: () => api('/instalments'),
  createPlan: (body) => api('/instalments', { method: 'POST', body }),
  planPayment: (id, body, key) => api(`/instalments/${encodeURIComponent(id)}/payments`, { method: 'POST', body, idempotencyKey: key }),

  warrantyLookup: (serial) => api(`/warranty/lookup/${encodeURIComponent(serial)}`),
  warrantyClaim: (body) => api('/warranty/claims', { method: 'POST', body }),

  deliveryZones: () => api('/delivery/zones'),
  deliveryQuote: (body) => api('/delivery/quote', { method: 'POST', body }),
  deliveryJobs: (q) => api('/delivery/jobs', { query: q }),
  createJob: (body) => api('/delivery/jobs', { method: 'POST', body }),
  dispatchJob: (id, body) => api(`/delivery/jobs/${encodeURIComponent(id)}/dispatch`, { method: 'POST', body }),
  completeJob: (id, body) => api(`/delivery/jobs/${encodeURIComponent(id)}/complete`, { method: 'POST', body }),

  trialBalance: (q) => api('/gl/trial-balance', { query: q }),
  profitAndLoss: (q) => api('/gl/profit-and-loss', { query: q }),
  balanceSheet: (q) => api('/gl/balance-sheet', { query: q }),
  ledgerIntegrity: (q) => api('/gl/integrity', { query: q }),
  vatReturn: (q) => api('/vat/return', { query: q }),
  whtRates: () => api('/wht/rates'),
  whtEntries: () => api('/wht/entries'),
  whtEntry: (body) => api('/wht/entries', { method: 'POST', body }),

  register: (type, q) => api(`/registers/${encodeURIComponent(type)}`, { query: q }),
  verifyRegister: (type, q) => api(`/registers/${encodeURIComponent(type)}/verify`, { method: 'POST', body: q || {} }),

  dashboard: (q) => api('/dashboard', { query: q }),
  settings: () => api('/settings'),
  updateSettings: (body) => api('/settings', { method: 'PATCH', body }),
  planUsage: () => api('/admin/usage'),
  updatePlan: (body) => api('/admin/plan', { method: 'PATCH', body }),

  syncPull: (body) => api('/sync/pull', { method: 'POST', body }),
  syncPush: (body) => api('/sync/push', { method: 'POST', body }),
  syncStatus: () => api('/sync/status'),

  queueSize,
};

export default endpoints;
