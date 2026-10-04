// =====================================================================
// public/js/theme.js — flash-free light/dark theme system
// =====================================================================
// Runs render-blocking in <head> so [data-theme] is applied BEFORE the body
// is painted. This prevents any white or black flashes on page load.
// No modern syntax that would fail on legacy browser engines.

'use strict';

var Theme = (function () {
  var KEY = 'stockridge_theme';
  var CHROME = { light: '#06382a', dark: '#0a1a14' };

  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : null;
    } catch (e) {
      return null;
    }
  }

  function systemPrefersDark() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (e) {
      return false;
    }
  }

  function effective() {
    var s = stored();
    if (s) return s;
    return systemPrefersDark() ? 'dark' : 'light';
  }

  function isFollowingSystem() {
    return stored() === null;
  }

  function apply() {
    var mode = effective();
    var root = document.documentElement;
    root.setAttribute('data-theme', mode);
    root.style.colorScheme = mode;
    setChromeColour(mode);
    return mode;
  }

  function setChromeColour(mode) {
    try {
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', CHROME[mode] || CHROME.light);
    } catch (e) {}
  }

  function set(mode) {
    try {
      if (mode === 'light' || mode === 'dark') localStorage.setItem(KEY, mode);
      else localStorage.removeItem(KEY);
    } catch (e) {}
    var applied = apply();
    syncToggles();
    return applied;
  }

  function toggle() {
    return set(effective() === 'dark' ? 'light' : 'dark');
  }

  var SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" width="18" height="18"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M19.07 4.93l-1.41 1.41M6.34 17.66l-1.41 1.41"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="18" height="18"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';

  var toggleIds = [];

  function labelFor(mode) {
    return mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  }

  function syncToggles() {
    var mode = effective();
    for (var i = 0; i < toggleIds.length; i++) {
      var el = document.getElementById(toggleIds[i]);
      if (!el) continue;
      el.innerHTML = mode === 'dark' ? SUN : MOON;
      el.setAttribute('aria-label', labelFor(mode));
      el.setAttribute('title', labelFor(mode));
      el.setAttribute('aria-pressed', mode === 'dark' ? 'true' : 'false');
    }
  }

  function mount(id) {
    if (toggleIds.indexOf(id) === -1) toggleIds.push(id);
    var el = document.getElementById(id);
    if (el && !el.getAttribute('data-theme-bound')) {
      el.setAttribute('data-theme-bound', '1');
      el.addEventListener('click', function () { toggle(); });
    }
    syncToggles();
  }

  try {
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () { if (isFollowingSystem()) { apply(); syncToggles(); } };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  } catch (e) {}

  apply();

  return {
    apply: apply,
    set: set,
    toggle: toggle,
    effective: effective,
    isFollowingSystem: isFollowingSystem,
    mount: mount,
    syncToggles: syncToggles,
  };
})();

window.Theme = Theme;
