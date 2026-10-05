'use strict';
// =====================================================================
// public/js/theme.js — LIGHT / DARK, REMEMBERED PER DEVICE
// =====================================================================
// Deliberately not a "settings" row on the server. The theme belongs to the
// SCREEN: the back-office laptop and the counter phone can disagree, and neither
// has any business overwriting the other's choice.
// =====================================================================
(function (global) {
  const SR = global.SR = global.SR || {};
  const KEY = 'sr.theme';
  const listeners = new Set();

  function current() {
    try { return localStorage.getItem(KEY) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); }
    catch (e) { return 'light'; }
  }

  function apply(theme) {
    const value = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = value;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', value === 'dark' ? '#0d1519' : '#0f5c4a');
    for (const fn of listeners) {
      try { fn(value); } catch (e) { /* a bad listener must not break the toggle */ }
    }
    return value;
  }

  function set(theme) {
    const value = theme === 'dark' ? 'dark' : 'light';
    try { localStorage.setItem(KEY, value); } catch (e) { /* private mode */ }
    return apply(value);
  }

  function toggle() { return set(current() === 'dark' ? 'light' : 'dark'); }

  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  function init() {
    apply(current());
    // Follow the operating system only while the user has never chosen.
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', (e) => {
      let chosen = null;
      try { chosen = localStorage.getItem(KEY); } catch (err) { /* fine */ }
      if (!chosen) apply(e.matches ? 'dark' : 'light');
    });
  }

  SR.theme = { init, current, set, toggle, apply, onChange };
}(window));
