'use strict';
// =====================================================================
// public/js/deviceId.js — THIS DEVICE'S NAME, AND WHY IT MATTERS
// =====================================================================
// Every sync push and every till session is stamped with a device id. It is not
// telemetry: it is the answer to "who wrote this row, and from which handset?"
// when two tills in one shop disagree about the day's takings. A shared id, or
// an id that resets when the browser clears storage, makes that question
// unanswerable — so the id is generated once and kept in THREE places, and the
// first one that still has a value wins.
//
//   1. localStorage  — survives everything except an explicit site-data wipe
//   2. IndexedDB     — survives a localStorage clear in most browsers
//   3. a generated one, immediately written to both
//
// A cashier can rename the device ("Front counter till") from Settings; the id
// never changes.
// =====================================================================
(function (global) {
  const SR = global.SR = global.SR || {};
  const LS_KEY = 'sr.deviceId';
  const LS_LABEL = 'sr.deviceLabel';

  /** A short, readable, stable token: SR-K3F7-2QX9 */
  function generate() {
    const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I — this gets read aloud
    const block = (n) => Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
    return `SR-${block(4)}-${block(4)}`;
  }

  function guessLabel() {
    const ua = navigator.userAgent || '';
    const platform = /Android/i.test(ua) ? 'Android'
      : /iPhone|iPad|iPod/i.test(ua) ? 'iOS'
        : /Windows/i.test(ua) ? 'Windows'
          : /Mac OS X/i.test(ua) ? 'Mac'
            : /Linux/i.test(ua) ? 'Linux' : 'Device';
    const browser = /Edg\//i.test(ua) ? 'Edge'
      : /OPR\//i.test(ua) ? 'Opera'
        : /Chrome\//i.test(ua) ? 'Chrome'
          : /Firefox\//i.test(ua) ? 'Firefox'
            : /Safari\//i.test(ua) ? 'Safari' : 'Browser';
    return `${platform} ${browser}`;
  }

  function fromLocalStorage() {
    try { return localStorage.getItem(LS_KEY) || null; } catch (e) { return null; }
  }
  function toLocalStorage(id, label) {
    try {
      localStorage.setItem(LS_KEY, id);
      if (label) localStorage.setItem(LS_LABEL, label);
    } catch (e) { /* private mode: IndexedDB still holds it */ }
  }

  /** Resolve the device identity, consulting the local mirror as a fallback. */
  async function resolve() {
    let id = fromLocalStorage();
    let label = null;
    try { label = localStorage.getItem(LS_LABEL) || null; } catch (e) { /* fine */ }

    if (!id && SR.store) {
      try {
        id = await SR.store.metaGet('device_id');
        label = label || await SR.store.metaGet('device_label');
      } catch (e) { /* the store may not be open yet */ }
    }
    if (!id) id = generate();
    if (!label) label = guessLabel();

    toLocalStorage(id, label);
    if (SR.store) {
      try {
        await SR.store.metaSet('device_id', id);
        await SR.store.metaSet('device_label', label);
      } catch (e) { /* a mirror that refuses a write must not break sign-in */ }
    }
    return { id, label };
  }

  let cached = null;
  async function get() {
    if (!cached) cached = await resolve();
    return cached;
  }
  function current() { return cached || { id: fromLocalStorage() || 'SR-UNKNOWN', label: 'Device' }; }

  async function setLabel(label) {
    const clean = String(label || '').trim().slice(0, 60) || guessLabel();
    const id = current().id;
    cached = { id, label: clean };
    toLocalStorage(id, clean);
    if (SR.store) await SR.store.metaSet('device_label', clean).catch(() => {});
    return cached;
  }

  SR.device = { get, current, setLabel, generate, guessLabel };
}(window));
