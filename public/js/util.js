'use strict';
// =====================================================================
// public/js/util.js — FORMATTING AND SMALL PURE HELPERS
// =====================================================================
// Everything here is pure and offline. The money and time rules in particular
// are the SAME rules the server applies, restated for the browser:
//
//   * Money is stored in naira and formatted with the kobo only when there is a
//     kobo to show. "₦45,000" reads like a price; "₦45,000.00" reads like an
//     invoice and wastes a column on every shelf label.
//   * `sold_at` is WEST AFRICA TIME, while every audit timestamp is UTC. A
//     browser in Lagos and a browser in London must render the same sale at the
//     same wall-clock time, so the offset is applied explicitly rather than
//     trusted to the device's locale.
// =====================================================================
(function (global) {
  const SR = global.SR = global.SR || {};

  const WAT_OFFSET_MINUTES = 60; // UTC+1, no daylight saving, ever.

  const NGN = new Intl.NumberFormat('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const NGN2 = new Intl.NumberFormat('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /** ₦45,000 · −₦1,250.50 · ₦0 */
  function money(value, { kobo = false, sign = false, dash = '—' } = {}) {
    if (value === null || value === undefined || value === '') return dash;
    const n = Number(value);
    if (!Number.isFinite(n)) return dash;
    const abs = Math.abs(n);
    const body = kobo || Math.round(abs * 100) % 100 !== 0
      ? NGN2.format(abs)
      : NGN.format(abs);
    const neg = n < 0;
    const prefix = neg ? '−' : (sign ? '+' : '');
    return `${prefix}₦${body}`;
  }

  /** `money` without the symbol — for a column that already has ₦ in the header. */
  function amount(value, opts) {
    const s = money(value, opts);
    return s.replace(/^([−+]?)₦/, '$1');
  }

  /** Plain digits for an input field: 45000.5 -> "45000.5" */
  function numInput(value) {
    if (value === null || value === undefined || value === '') return '';
    const n = Number(value);
    return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '';
  }

  /** 1234 -> "1,234"; 0.5 -> "0.5" (quantities, not money). */
  function qty(value, places = 3) {
    if (value === null || value === undefined || value === '') return '—';
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    const rounded = Math.round(n * 10 ** places) / 10 ** places;
    return rounded.toLocaleString('en-NG', { maximumFractionDigits: places });
  }

  function pct(value, places = 1) {
    if (value === null || value === undefined || value === '') return '—';
    const n = Number(value);
    return Number.isFinite(n) ? `${n.toFixed(places)}%` : '—';
  }

  /**
   * Parse a timestamp the server sent.
   *
   * The server writes two kinds of timestamp and they are NOT interchangeable:
   *   * `sold_at` — WAT, already formatted "YYYY-MM-DD HH:MM:SS"
   *   * everything else — UTC from `datetime('now')`
   *
   * Both are ISO-shaped but neither carries a zone suffix, and
   * `new Date('2026-10-05 14:10:05')` is treated as LOCAL time by Safari and
   * UTC-then-shifted by Chrome. So both are parsed by hand and an explicit
   * zone is applied.
   */
  function parseStamp(value, { zone = 'utc' } = {}) {
    if (!value) return null;
    const text = String(value).trim();
    // Already zoned or in ISO-with-T form.
    if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)) {
      const d = new Date(text);
      return Number.isFinite(d.getTime()) ? d : null;
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(text);
    if (!m) {
      const d = new Date(text);
      return Number.isFinite(d.getTime()) ? d : null;
    }
    const [, y, mo, d, hh = '0', mm = '0', ss = '0'] = m;
    const utcMs = Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss);
    const shift = zone === 'wat' ? -WAT_OFFSET_MINUTES * 60000 : 0;
    return new Date(utcMs + shift);
  }

  const dateFmt = new Intl.DateTimeFormat('en-NG', { year: 'numeric', month: 'short', day: '2-digit', timeZone: 'UTC' });
  const timeFmt = new Intl.DateTimeFormat('en-NG', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });

  /** A date rendered in the zone it was WRITTEN in, which is what the till saw. */
  function date(value, { zone = 'utc' } = {}) {
    const d = parseStamp(value, { zone });
    return d ? dateFmt.format(d) : '—';
  }
  function time(value, { zone = 'utc' } = {}) {
    const d = parseStamp(value, { zone });
    return d ? timeFmt.format(d) : '—';
  }
  function dateTime(value, { zone = 'utc' } = {}) {
    const d = parseStamp(value, { zone });
    return d ? `${dateFmt.format(d)} ${timeFmt.format(d)}` : '—';
  }
  /** Sales timestamps are WAT. Spelling it once here stops the wrong zone being
   *  passed at 30 call sites. */
  function soldAt(value) { return value ? dateTime(value, { zone: 'wat' }) : '—'; }
  function soldDate(value) { return value ? date(value, { zone: 'wat' }) : '—'; }

  /**
   * The calendar day a stamp falls on, as `YYYY-MM-DD`, in WAT — or null.
   *
   * For ARITHMETIC and machine-readable fields. `date()` is for people: it returns
   * "05 Oct 2026", and interpolating that into `new Date()` produces an Invalid
   * Date whose `toISOString()` throws `RangeError: Invalid time value`. That is
   * exactly how every warranty receipt died — the warranty expiry was computed
   * from the display string.
   */
  function isoDate(value, { zone = 'wat' } = {}) {
    const d = parseStamp(value, { zone });
    return d && Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
  }

  function relTime(value, { zone = 'utc' } = {}) {
    const d = parseStamp(value, { zone });
    if (!d) return '—';
    const mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'} ago`;
    const days = Math.round(hrs / 24);
    if (days < 31) return `${days} day${days === 1 ? '' : 's'} ago`;
    return date(value, { zone });
  }

  /** "2026-10-05" for today, in WAT — the trading day, not the UTC day. */
  function todayWat(offsetDays = 0) {
    const d = new Date(Date.now() + WAT_OFFSET_MINUTES * 60000 + offsetDays * 86400000);
    return d.toISOString().slice(0, 10);
  }
  function nowWatSql() {
    const d = new Date(Date.now() + WAT_OFFSET_MINUTES * 60000);
    return d.toISOString().slice(0, 19).replace('T', ' ');
  }
  function nowIso() { return new Date().toISOString(); }

  function addDays(isoDate, days) {
    const d = new Date(`${String(isoDate).slice(0, 10)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  function daysBetween(a, b) {
    const x = Date.parse(`${String(a).slice(0, 10)}T00:00:00Z`);
    const y = Date.parse(`${String(b).slice(0, 10)}T00:00:00Z`);
    return Number.isFinite(x) && Number.isFinite(y) ? Math.round((y - x) / 86400000) : 0;
  }

  /** Escape for embedding in HTML. Every interpolation in this app goes through
   *  it — a customer called `<script>` is a real customer. */
  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** `attr` for a value used inside a double-quoted attribute. */
  const attr = esc;

  function titleCase(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** SCREAMING_SNAKE -> "Screaming snake", for badges and headings. */
  function humanise(code) {
    if (!code) return '';
    return titleCase(String(code));
  }

  /** A sentence read by a person: "3 item(s)". */
  function plural(n, one, many) {
    return Number(n) === 1 ? `${n} ${one}` : `${n} ${many || `${one}s`}`;
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }

  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function sum(list, pick) { return (list || []).reduce((a, x) => a + Number(pick ? pick(x) : x || 0), 0); }

  function uniq(list) { return Array.from(new Set(list || [])); }

  function groupBy(list, pick) {
    const out = new Map();
    for (const item of list || []) {
      const k = pick(item);
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(item);
    }
    return out;
  }

  /** Compare for sorting, tolerating nulls and numeric strings. */
  function by(key, dir = 1) {
    return (a, b) => {
      const x = a[key]; const y = b[key];
      if (x === y) return 0;
      if (x === null || x === undefined || x === '') return 1;
      if (y === null || y === undefined || y === '') return -1;
      const nx = Number(x); const ny = Number(y);
      if (Number.isFinite(nx) && Number.isFinite(ny)) return (nx - ny) * dir;
      return String(x).localeCompare(String(y), 'en-NG') * dir;
    };
  }

  function slug(text) { return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

  /** Naira-and-kobo words for a receipt total, so a disputed amount is
   *  unambiguous on paper. */
  function amountInWords(value) {
    const n = Math.round(Math.abs(Number(value) || 0) * 100) / 100;
    const naira = Math.floor(n);
    const kobo = Math.round((n - naira) * 100);
    const words = (v) => {
      const ones = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
        'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
      const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
      const chunk = (x) => {
        if (x < 20) return ones[x];
        if (x < 100) return `${tens[Math.floor(x / 10)]}${x % 10 ? `-${ones[x % 10]}` : ''}`;
        if (x < 1000) return `${ones[Math.floor(x / 100)]} hundred${x % 100 ? ` and ${chunk(x % 100)}` : ''}`;
        for (const [div, name] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']]) {
          if (x >= div) return `${chunk(Math.floor(x / div))} ${name}${x % div ? ` ${chunk(x % div)}` : ''}`;
        }
        return '';
      };
      return chunk(v);
    };
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    let out = `${cap(words(naira))} naira`;
    if (kobo) out += `, ${words(kobo)} kobo`;
    return `${out} only`;
  }

  /** Download a Blob/string from the browser without a server round-trip. */
  function download(filename, content, type = 'text/csv;charset=utf-8') {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('The file could not be read.'));
      reader.readAsText(file);
    });
  }

  function debounce(fn, ms = 280) {
    let t = null;
    return function debounced(...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /** A stable, sortable, human-ish unique id for locally created rows. */
  function localId(prefix = 'loc') {
    const rand = Math.random().toString(16).slice(2, 10);
    return `${prefix}_${Date.now().toString(36)}${rand}`;
  }

  /** Nigerian phone in the shape the server stores: 0XXXXXXXXXX. Advisory — a
   *  wrong number is a warning, never a blocked sale. */
  function normalisePhone(input) {
    if (!input) return null;
    let d = String(input).replace(/[^\d+]/g, '');
    if (d.startsWith('+234')) d = `0${d.slice(4)}`;
    else if (d.startsWith('234') && d.length > 11) d = `0${d.slice(3)}`;
    return d || null;
  }

  function isPhone(input) {
    const d = normalisePhone(input);
    return /^0\d{10}$/.test(d || '');
  }

  /** Cheap, dependency-free hash for cache-busting a mirror row. */
  function hashCode(text) {
    let h = 2166136261;
    const s = String(text);
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  function bytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`;
    return `${(v / 1048576).toFixed(1)} MB`;
  }

  SR.util = {
    WAT_OFFSET_MINUTES,
    money, amount, numInput, qty, pct,
    parseStamp, date, time, dateTime, soldAt, soldDate, isoDate, relTime,
    todayWat, nowWatSql, nowIso, addDays, daysBetween,
    esc, attr, titleCase, humanise, plural, initials,
    clamp, round2, sum, uniq, groupBy, by, slug,
    amountInWords, download, readFileAsText, debounce, sleep, localId,
    normalisePhone, isPhone, hashCode, bytes,
  };
}(window));
