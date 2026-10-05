'use strict';
// =====================================================================
// tools/lib/page-harness.js — BOOT THE REAL FRONTEND SOMEWHERE IT CAN BE WATCHED
// =====================================================================
// This is the shared piece behind `tools/frontend-smoke.js` (does the app render?)
// and `tools/frontend-sale.js` (can a cashier ring a sale on it?).
//
// It exists as a library because the awkward part of driving this application
// headlessly is not the driving — it is the booting. The app is plain
// `<script src>` files with no bundler, so the harness must load them in the
// order `index.html` lists them; it needs a real IndexedDB (the offline store) and
// a `matchMedia` (the theme) before the first script runs; and every request has to
// reach a live server with the signed-in token attached.
//
// jsdom is and stays a DEVELOPMENT instrument: it is not a dependency of the
// product, which ships with no build step. Install it when you need these tools:
//
//     npm install --no-save jsdom@29.1.1 fake-indexeddb@6.2.5
//
// jsdom is pinned because an unpinned install resolved to a version whose engine
// the runtime could not load, and the failure read as "jsdom is missing". A test
// instrument that moves under you is a test that lies eventually.
// =====================================================================

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

function loadJsdom() {
  try {
    // eslint-disable-next-line global-require
    return { JSDOM: require('jsdom').JSDOM, VirtualConsole: require('jsdom').VirtualConsole };
  } catch (err) {
    // Say WHAT failed. This catch once printed only "jsdom is missing" while jsdom
    // was installed and simply could not load on that Node.
    console.error('\n  This tool needs jsdom, which is not a dependency of the project:\n');
    console.error('      npm install --no-save jsdom@29.1.1 fake-indexeddb@6.2.5\n');
    console.error(`  jsdom could not be loaded: ${err && err.message ? err.message : err}`);
    if (process.version && Number(process.version.slice(1).split('.')[0]) < 22) {
      console.error(`  You are on Node ${process.version}. jsdom 30 needs >= 22.22; pin jsdom 29 or use Node 22.`);
    }
    process.exit(2);
  }
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * Wait until `probe` returns something truthy, or the timeout expires.
 * Polling, never a fixed sleep: this application syncs the catalogue into
 * IndexedDB on first boot, and how long that takes depends on the database.
 */
async function waitUntil(probe, { timeout = 30000, interval = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  for (;;) {
    try {
      // AWAITED, because an async predicate is the natural thing for a caller to
      // write — "wait until the server says the row is gone" is a request, not a
      // DOM read. Without this, `probe()` returned a pending PROMISE, which is
      // always truthy, so the wait "succeeded" on its first tick with the promise
      // itself and the caller's `if (result)` tested its resolved value instead.
      // A probe that polls a server would report failure before the request had
      // even finished. (It did: tools/frontend-price.js reported that a cleared
      // branch price was still on the server, when the server had already said it
      // was gone.)
      last = await probe();
    } catch (err) { last = null; }
    if (last) return last;
    if (Date.now() >= deadline) return null;
    await sleep(interval);
  }
}

/** Every element whose text is exactly (or contains) `text`, visible first. */
function findByText(root, text, { exact = false, tag = '*' } = {}) {
  const wanted = String(text).trim().toLowerCase();
  return [...root.querySelectorAll(tag)].filter((el) => {
    const t = el.textContent.replace(/\s+/g, ' ').trim().toLowerCase();
    return exact ? t === wanted : t.includes(wanted);
  });
}

/** Click a button by its label — how a person actually operates this app. */
async function clickText(root, text, { exact = false, tag = 'button' } = {}) {
  const hits = findByText(root, text, { exact, tag }).filter((el) => !el.disabled);
  if (!hits.length) return null;
  // The innermost match is the real control; clicking an outer container would
  // not fire the handler the user's finger would fire.
  const el = hits[hits.length - 1];
  el.click();
  return el;
}

/**
 * Boot the real frontend against `origin` as `username`.
 *
 * Returns the window so the caller can drive it, plus the page's own console
 * output — the console is where a JavaScript fault explains itself.
 */
async function bootPage({ origin, username, pin, token: givenToken = null, waitMs = 30000 } = {}) {
  const { JSDOM, VirtualConsole } = loadJsdom();
  const logs = [];
  const vc = new VirtualConsole();
  for (const level of ['error', 'warn', 'log']) {
    vc.on(level, (...a) => logs.push(`[${level}] ${a.map((x) => String(x)).join(' ').slice(0, 220)}`));
  }

  // Sign in out of band, so the page boots the way a returning user's does.
  let token = givenToken;
  if (!token) {
    const res = await fetch(`${origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, pin }),
    });
    const body = await res.json().catch(() => null);
    if (!body || !body.token) {
      return { ok: false, reason: `sign-in failed: ${JSON.stringify(body).slice(0, 200)}`, logs };
    }
    token = body.token;
  }

  const dom = new JSDOM(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'), {
    url: `${origin}/`, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
  });
  const { window } = dom;

  // The gaps jsdom leaves, none of which are application bugs.
  let idb;
  try {
    // eslint-disable-next-line global-require
    idb = require('fake-indexeddb');
  } catch (err) {
    console.error('\n  This tool needs fake-indexeddb (the app boots into IndexedDB):\n');
    console.error('      npm install --no-save jsdom@29.1.1 fake-indexeddb@6.2.5\n');
    console.error(`  fake-indexeddb could not be loaded: ${err && err.message ? err.message : err}`);
    process.exit(2);
  }
  window.indexedDB = idb.indexedDB;
  window.IDBKeyRange = idb.IDBKeyRange;
  if (!window.structuredClone) window.structuredClone = (v) => JSON.parse(JSON.stringify(v));
  if (!window.matchMedia) {
    window.matchMedia = (q) => ({
      matches: false, media: q, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
    });
  }
  window.scrollTo = () => {};
  if (!window.print) window.print = () => {};
  if (!window.URL.createObjectURL) window.URL.createObjectURL = () => 'blob:harness';

  // Send the page's requests to the real server, with its token attached.
  const realFetch = globalThis.fetch;
  window.fetch = (url, init = {}) => {
    const u = String(url).startsWith('http') ? String(url) : `${origin}/${String(url).replace(/^\//, '')}`;
    const headers = Object.assign({}, init.headers || {});
    if (/\/api\//.test(u) && !headers.Authorization && window.SR && window.SR.api && window.SR.api.token) {
      headers.Authorization = `Bearer ${window.SR.api.token}`;
    }
    return realFetch(u, { ...init, headers });
  };
  window.localStorage.setItem('sr.token', token);

  // Load the page's own scripts, in the page's own order. Reading the order from
  // the HTML is the point: a script the page forgets to include is exactly the
  // kind of thing these tools should notice.
  const scripts = [...window.document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'));
  const missing = [];
  for (const src of scripts) {
    const file = path.join(PUBLIC_DIR, src.replace(/^\//, ''));
    if (!fs.existsSync(file)) { missing.push(src); continue; }
    const el = window.document.createElement('script');
    el.textContent = fs.readFileSync(file, 'utf8');
    window.document.body.appendChild(el);
  }

  const startedAt = Date.now();
  const settled = await waitUntil(() => {
    const boot = window.document.getElementById('boot');
    const bootText = boot ? boot.textContent.replace(/\s+/g, ' ').trim() : '';
    if (/failed to start/i.test(bootText)) return { state: 'failed', bootText };
    const nav = window.document.getElementById('nav-list');
    const items = nav ? nav.querySelectorAll('.nav-item').length : 0;
    const view = window.document.getElementById('view');
    const viewText = view ? view.textContent.trim() : '';
    if (items > 0 && viewText.length > 0) return { state: 'ready', items, viewChars: viewText.length };
    return null;
  }, { timeout: waitMs, interval: 500 });

  return {
    ok: true,
    window,
    dom,
    logs,
    token,
    missing,
    settleMs: Date.now() - startedAt,
    settled: settled || { state: 'timeout', items: 0, viewChars: 0 },
  };
}

// ---------------------------------------------------------------------
// THE WALK — one definition, shared by every tool that drives the app
// ---------------------------------------------------------------------
// A screen that REFUSES ("Open a till first") and a screen that BROKE
// ("Cannot read properties of null") render the same red block. The
// difference is in the words, so it has to be read out of them: without
// this, a page that could not draw itself passes a walk reporting "no
// problems" — which is exactly how the administrator's Subscription screen
// shipped broken.
const FAULT_TEXT = /cannot read propert|is not a function|is not defined|of undefined|of null|undefined is not|not iterable|before initialization|out of range|Invalid time value|Cannot convert/i;

/** True when an error message describes a fault rather than a deliberate refusal. */
function isFault(alertText) {
  return Boolean(alertText) && FAULT_TEXT.test(alertText);
}

/**
 * Open every destination in the navigation, in turn, and record what appears.
 *
 * Settles on "non-empty text that has stopped changing" rather than a fixed
 * sleep, because a fixed sleep once reported a perfectly good sidebar as EMPTY.
 */
async function walkNav(page, { settleMs = 15000, pauseMs = 400 } = {}) {
  const { window, logs } = page;
  const doc = window.document;
  const nav = doc.getElementById('nav-list');
  const walk = [];
  if (!nav) return walk;

  for (const btn of [...nav.querySelectorAll('.nav-item')]) {
    const label = btn.textContent.trim();
    const path = btn.dataset ? btn.dataset.path : '';
    const logStart = logs.length;
    const started = Date.now();
    let thrown = null;
    try {
      btn.click();
    } catch (err) {
      thrown = err && err.message ? err.message : String(err);
    }
    const deadline = Date.now() + settleMs;
    let text = '';
    let stableSince = 0;
    while (!thrown && Date.now() < deadline) {
      const v = doc.getElementById('view');
      const now = v ? v.textContent.replace(/\s+/g, ' ').trim() : '';
      if (now.length > 0 && now === text) {
        if (Date.now() - stableSince > pauseMs) break;
      } else {
        text = now;
        stableSince = Date.now();
      }
      await sleep(250);
    }
    const view = doc.getElementById('view');
    const alert = view ? view.querySelector('.alert-danger') : null;
    walk.push({
      label,
      path,
      ms: Date.now() - started,
      chars: text.length,
      snippet: text.slice(0, 90),
      alert: alert ? alert.textContent.replace(/\s+/g, ' ').trim().slice(0, 110) : null,
      newLogs: logs.slice(logStart).filter((l) => l.startsWith('[error]')).slice(0, 2),
      thrown,
      fault: Boolean(alert) && FAULT_TEXT.test(alert.textContent),
    });
  }
  // Leave the app where it was, so a later report describes the same screen.
  if (nav.querySelector('.nav-item')) nav.querySelector('.nav-item').click();
  await sleep(1200);
  return walk;
}

module.exports = { bootPage, waitUntil, findByText, clickText, loadJsdom, sleep, walkNav, isFault, PUBLIC_DIR, ROOT };
