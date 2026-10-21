'use strict';
// The till is online only when the shop itself answered. A browser "offline"
// event, a missing network icon, or one timed-out screen is not that answer.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SRReach = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function shopAnswered(status, text) {
    const code = Number(status);
    const body = String(text || '');
    if (!Number.isFinite(code) || code <= 0 || code >= 500) return false;
    if (/UPSTREAM_UNREACHABLE|shop server could not be reached|did not answer from this window/i.test(body)) return false;
    // The till's own saved-session door answers 200 with offline:true. That is
    // this computer, not the shop. It must not count as a connection.
    if (/"offline"\s*:\s*true/.test(body)) return false;
    if (/<!doctype html|<html[\s>]/i.test(body)) return false;
    return true;
  }

  function callMissed(status, text, code) {
    if (shopAnswered(status, text)) return false;
    const name = String(code || '');
    if (name === 'OFFLINE' || name === 'UPSTREAM_UNREACHABLE') return true;
    if (Number(status) === 0 || Number(status) >= 500) return true;
    return /failed to fetch|did not answer|could not be reached/i.test(String(text || ''));
  }

  // One missed screen, or the browser saying there is no network, must not
  // paint Offline. The shop has to miss a probe twice before the chip moves.
  function shouldMarkOffline(state) {
    const probeAttempted = Boolean(state && state.probeAttempted);
    const probeAnswered = Boolean(state && state.probeAnswered);
    const misses = Number(state && state.consecutiveProbeMisses) || 0;
    if (!probeAttempted || probeAnswered) return false;
    return misses >= 2;
  }

  return { shopAnswered, callMissed, shouldMarkOffline };
});
