// =====================================================================
// public/js/ui.js — DOM helpers, toasts, modal, tables, forms
// =====================================================================
// No framework, no virtual DOM. A shop's till laptop is often a five-year-old
// machine, and the whole UI is a few hundred elements at a time — the cost of a
// framework here is download size and a build step, neither of which buys
// anything.
//
// THE ONE RULE: text goes in through textContent, never innerHTML.
// Product names, customer names, delivery addresses and stock notes are all free
// text that somebody typed. Rendering any of them as HTML is a stored XSS, and
// the payoff is a session token that can void sales and read every debtor in the
// business. `el()` and `html()` below make the safe path the easy path.

'use strict';

/** Create an element. Children may be strings (text), nodes, or null. */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'html') throw new Error('ui.el refuses `html`. Use textContent — free-text fields are user input and rendering them as HTML is a stored XSS.');
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') node.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected') node[k] = !!v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

export function icon(name) {
  // Inline SVG rather than an icon font: a font is another asset to download and
  // another thing the CSP has to allow.
  const paths = {
    dashboard: 'M3 13h8V3H3v10zm10 8h8V11h-8v10zM3 21h8v-6H3v6zm10-12h8V3h-8v6z',
    pos: 'M7 18c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zM1 2v2h2l3.6 7.6L5.2 14c-.1.3-.2.6-.2 1 0 1.1.9 2 2 2h12v-2H7.4l.6-1h7.5c.7 0 1.4-.4 1.7-1l3.6-6.5c.2-.3-.1-.5-.4-.5H5.2L4.3 4H1zm16 16c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
    box: 'M21 8l-9-5-9 5v8l9 5 9-5V8zm-9 11.2L5 15.4V9.8l7 3.9 7-3.9v5.6l-7 3.8z',
    users: 'M16 11c1.7 0 3-1.3 3-3s-1.3-3-3-3-3 1.3-3 3 1.3 3 3 3zm-8 0c1.7 0 3-1.3 3-3S9.7 5 8 5 5 6.3 5 8s1.3 3 3 3zm0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5c0-2.3-4.7-3.5-7-3.5zm8 0c-.3 0-.6 0-1 .1 1.2.8 2 2 2 3.4V19h6v-2.5c0-2.3-4.7-3.5-7-3.5z',
    receipt: 'M18 17H6v-2h12v2zm0-4H6v-2h12v2zm0-4H6V7h12v2zM3 22l1.5-1.5L6 22l1.5-1.5L9 22l1.5-1.5L12 22l1.5-1.5L15 22l1.5-1.5L18 22l1.5-1.5L21 22V2l-1.5 1.5L18 2l-1.5 1.5L15 2l-1.5 1.5L12 2l-1.5 1.5L9 2 7.5 3.5 6 2 4.5 3.5 3 2v20z',
    truck: 'M20 8h-3V4H3c-1.1 0-2 .9-2 2v11h2c0 1.7 1.3 3 3 3s3-1.3 3-3h6c0 1.7 1.3 3 3 3s3-1.3 3-3h2v-5l-3-4zM6 18.5c-.8 0-1.5-.7-1.5-1.5s.7-1.5 1.5-1.5 1.5.7 1.5 1.5-.7 1.5-1.5 1.5zm13.5-9l1.9 2.5h-4.4V9.5H19.5zm-1.5 9c-.8 0-1.5-.7-1.5-1.5s.7-1.5 1.5-1.5 1.5.7 1.5 1.5-.7 1.5-1.5 1.5z',
    shield: 'M12 1L3 5v6c0 5.5 3.8 10.7 9 12 5.2-1.3 9-6.5 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z',
    ledger: 'M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-1 9h-4v4h-2v-4H9V9h4V5h2v4h4v2z',
    chart: 'M5 9.2h3V19H5V9.2zM10.6 5h2.8v14h-2.8V5zm5.6 8H19v6h-2.8v-6z',
    cog: 'M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.61 3.61 0 018.4 12 3.61 3.61 0 0112 8.4a3.61 3.61 0 013.6 3.6 3.61 3.61 0 01-3.6 3.6z',
    clock: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z',
    warn: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
    check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
    search: 'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
    barcode: 'M2 4h2v16H2V4zm4 0h1v16H6V4zm3 0h2v16H9V4zm4 0h1v16h-1V4zm3 0h2v16h-2V4zm4 0h2v16h-2V4z',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', paths[name] || paths.box);
  svg.appendChild(p);
  return svg;
}

// ---------------------------------------------------------------------
// toasts
// ---------------------------------------------------------------------
export function toast(message, { kind = 'info', duration = 4500, action = null } = {}) {
  const host = document.getElementById('toast-host');
  if (!host) return null;
  const node = el('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    el('span', { class: 'toast-msg', text: String(message) }),
    action ? el('button', { class: 'btn btn-sm btn-ghost', onclick: () => { action.onClick(); dismiss(); } }, action.label) : null,
    el('button', { class: 'toast-close', 'aria-label': 'Dismiss', onclick: () => dismiss() }, '×'),
  );
  host.appendChild(node);
  const timer = duration > 0 ? setTimeout(dismiss, duration) : null;
  function dismiss() {
    if (timer) clearTimeout(timer);
    node.classList.add('toast-out');
    setTimeout(() => node.remove(), 220);
  }
  return { dismiss };
}

/** Say something useful about an error instead of "an error occurred". */
export function reportError(err, { context = 'That did not work' } = {}) {
  const e = err || {};
  if (e.status === 0 || e.code === 'OFFLINE') {
    return toast(e.message || 'You are offline.', { kind: 'warn', duration: 6000 });
  }
  if (e.status === 402) return toast(e.message, { kind: 'warn', duration: 9000 });
  if (e.status === 429) {
    const mins = e.retryAfterSeconds ? Math.ceil(e.retryAfterSeconds / 60) : null;
    return toast(mins ? `${e.message} (about ${mins} minute${mins === 1 ? '' : 's'})` : e.message, { kind: 'warn', duration: 9000 });
  }
  if (e.status >= 500 || !e.message) {
    // Quote the request id: it is in the server log, so support can find the
    // actual cause. Without it "it errored" is unactionable.
    return toast(`${context}. If this keeps happening, quote reference ${e.requestId || 'n/a'} to support.`, { kind: 'error', duration: 9000 });
  }
  return toast(e.message, { kind: 'error', duration: 7000 });
}

// ---------------------------------------------------------------------
// modal
// ---------------------------------------------------------------------
export function modal({ title, body, footer, size = 'md', onClose } = {}) {
  const host = document.getElementById('modal-host');
  if (!host) return { close() {} };
  clear(host);
  const panel = el('div', { class: `modal modal-${size}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    el('header', { class: 'modal-head' },
      el('h2', { text: title }),
      el('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => close() }, '×')),
    el('div', { class: 'modal-body' }, body),
    footer ? el('footer', { class: 'modal-foot' }, footer) : null,
  );
  const backdrop = el('div', { class: 'modal-backdrop', onclick: (ev) => { if (ev.target === backdrop) close(); } }, panel);
  host.appendChild(backdrop);
  host.hidden = false;
  const first = panel.querySelector('input, select, textarea, button');
  if (first) first.focus();
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  function close() {
    document.removeEventListener('keydown', onKey);
    host.hidden = true;
    clear(host);
    if (typeof onClose === 'function') onClose();
  }
  return { close, panel };
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, details = null }) {
  return new Promise((resolve) => {
    let settled = false;
    const m = modal({
      title,
      size: 'sm',
      body: el('div', {},
        el('p', { class: 'modal-message', text: message }),
        details ? el('pre', { class: 'modal-details', text: details }) : null),
      footer: el('div', { class: 'row-end' },
        el('button', { class: 'btn btn-ghost', onclick: () => { settled = true; m.close(); resolve(false); } }, 'Cancel'),
        el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => { settled = true; m.close(); resolve(true); } }, confirmLabel)),
      onClose: () => { if (!settled) resolve(false); },
    });
  });
}

/** Ask for a reason. Used for voids and adjustments, where an unexplained action
 *  is the one an auditor asks about first. */
export function promptReason({ title, message, label = 'Reason', minLength = 4, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const input = el('textarea', { rows: 3, maxlength: 500, placeholder: `At least ${minLength} characters`, required: true });
    const err = el('p', { class: 'form-error', hidden: true });
    const submit = () => {
      const v = String(input.value || '').trim();
      if (v.length < minLength) {
        err.textContent = `Please give a reason of at least ${minLength} characters. An unexplained ${title.toLowerCase()} is the first thing an audit asks about.`;
        err.hidden = false;
        input.focus();
        return;
      }
      settled = true; m.close(); resolve(v);
    };
    const m = modal({
      title, size: 'sm',
      body: el('div', {}, el('p', { class: 'modal-message', text: message }),
        el('label', { for: 'reason', text: label }), input, err),
      footer: el('div', { class: 'row-end' },
        el('button', { class: 'btn btn-ghost', onclick: () => { settled = true; m.close(); resolve(null); } }, 'Cancel'),
        el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: submit }, confirmLabel)),
      onClose: () => { if (!settled) resolve(null); },
    });
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) submit(); });
  });
}

// ---------------------------------------------------------------------
// tables
// ---------------------------------------------------------------------
/**
 * A data table.
 * @param {Array<{key,label,align,render,width}>} columns
 * @param {Array} rows
 */
export function table(columns, rows, { empty = 'Nothing to show yet.', rowKey = null, onRow = null, dense = false } = {}) {
  if (!rows || !rows.length) return el('div', { class: 'empty', text: empty });
  const thead = el('thead', {}, el('tr', {}, columns.map((c) => el('th', {
    class: `th-${c.align || 'left'}`, style: c.width ? { width: c.width } : undefined, text: c.label,
  }))));
  const tbody = el('tbody', {}, rows.map((row, i) => el('tr', {
    class: onRow ? 'clickable' : undefined,
    dataset: rowKey ? { id: row[rowKey] } : undefined,
    onclick: onRow ? () => onRow(row, i) : undefined,
  }, columns.map((c) => el('td', { class: `td-${c.align || 'left'}` },
    c.render ? c.render(row, i) : String(row[c.key] == null ? '—' : row[c.key]))))));
  return el('div', { class: `table-wrap${dense ? ' dense' : ''}` }, el('table', { class: 'data' }, thead, tbody));
}

export function statCard({ label, value, sub = null, tone = null, icon: iconName = null }) {
  return el('div', { class: `stat${tone ? ` stat-${tone}` : ''}` },
    iconName ? el('span', { class: 'stat-icon' }, icon(iconName)) : null,
    el('div', {},
      el('span', { class: 'stat-label', text: label }),
      el('strong', { class: 'stat-value', text: String(value) }),
      sub ? el('span', { class: 'stat-sub', text: String(sub) }) : null));
}

export function badge(text, tone = 'neutral') {
  return el('span', { class: `badge badge-${tone}`, text: String(text) });
}

export function toneForStatus(status) {
  const s = String(status || '').toUpperCase();
  if (['COMPLETED', 'PAID', 'ACTIVE', 'VALID', 'BALANCED', 'ON_SITE', 'DELIVERED', 'IN_STOCK', 'SOLD', 'OK', 'SUCCESS', 'HEALTHY', 'IN_WARRANTY'].includes(s)) return 'good';
  if (['VOIDED', 'EXPIRED', 'DEFAULTED', 'STOLEN', 'LOST', 'FAILED', 'REJECTED', 'OFF_SITE', 'SHORT', 'OUT_OF_STOCK', 'CRITICAL', 'BLOCKED', 'SUSPENDED', 'OUT_OF_WARRANTY', 'BROKEN'].includes(s)) return 'bad';
  if (['PENDING', 'OPEN', 'SCHEDULED', 'PART_PAID', 'IN_TRANSIT', 'DISPATCHED', 'WITHIN_7', 'WITHIN_30', 'LOW', 'WATCH', 'EXPIRING_SOON', 'MISSED', 'FLAGGED', 'NO_LOCATION', 'STALE'].includes(s)) return 'warn';
  return 'neutral';
}

export function money(value, { signed = false } = {}) {
  const n = Number(value) || 0;
  const s = Math.abs(n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (signed && n > 0) return `+₦${s}`;
  return `${n < 0 ? '-' : ''}₦${s}`;
}

// ---------------------------------------------------------------------
// forms
// ---------------------------------------------------------------------
export function field({ label, name, type = 'text', value = '', required = false, hint = null, options = {}, placeholder = '', min = null, max = null, step = null, rows = null, disabled = false }) {
  const id = `f-${name}`;
  let input;
  if (type === 'select') {
    input = el('select', { id, name, required, disabled },
      options.placeholder !== false ? el('option', { value: '', text: options.placeholder || '— choose —' }) : null,
      (options.choices || []).map((c) => el('option', { value: c.value != null ? c.value : c, text: c.label != null ? c.label : String(c.value != null ? c.value : c), selected: String(c.value != null ? c.value : c) === String(value) })));
  } else if (type === 'textarea') {
    input = el('textarea', { id, name, required, disabled, rows: rows || 3, placeholder, maxlength: options.maxlength || 1000 }, String(value == null ? '' : value));
  } else if (type === 'checkbox') {
    input = el('input', { id, name, type: 'checkbox', checked: !!value, disabled });
  } else {
    input = el('input', {
      id, name, type, required, disabled, placeholder,
      value: value == null ? '' : String(value),
      min, max, step,
      inputmode: type === 'number' || type === 'tel' ? 'decimal' : undefined,
      autocomplete: options.autocomplete,
    });
  }
  return el('div', { class: `field field-${type}` },
    label ? el('label', { for: id, text: label }) : null,
    input,
    hint ? el('small', { class: 'hint', text: hint }) : null);
}

/** Read a form into a plain object, dropping untouched optional fields so a PATCH
 *  cannot null out a column the operator never saw. */
export function readForm(form) {
  const out = {};
  for (const node of form.elements) {
    if (!node.name) continue;
    if (node.type === 'checkbox') { out[node.name] = node.checked ? 1 : 0; continue; }
    const v = node.value;
    if (v === '' || v == null) continue;   // absent, not empty — see validate.pick
    out[node.name] = v;
  }
  return out;
}

export function spinner(label = 'Loading…') {
  return el('div', { class: 'loading' }, el('span', { class: 'spin' }), el('span', { text: label }));
}

export function emptyState(title, message, actionLabel, onAction) {
  return el('div', { class: 'empty-state' },
    el('h3', { text: title }),
    el('p', { text: message }),
    actionLabel && onAction ? el('button', { class: 'btn btn-primary', onclick: onAction }, actionLabel) : null);
}
{
  "name": "StockRidge — Stock, Sales & Accounts",
  "short_name": "StockRidge",
  "description": "Multi-branch, multi-business stock, point-of-sale and accounting for Nigerian retail and wholesale. Works offline.",
  "id": "/",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "display_override": ["standalone", "minimal-ui"],
  "orientation": "any",
  "background_color": "#0f1720",
  "theme_color": "#0b6b4f",
  "lang": "en-NG",
  "dir": "ltr",
  "categories": ["business", "finance", "productivity"],
  "icons": [
    { "src": "/icons/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" },
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icons/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "shortcuts": [
    {
      "name": "New sale",
      "short_name": "POS",
      "description": "Open the till and start a sale",
      "url": "/pos",
      "icons": [{ "src": "/icons/icon.svg", "sizes": "any" }]
    },
    {
      "name": "Stock",
      "short_name": "Stock",
      "description": "Check what is on the shelf",
      "url": "/stock"
    }
  ]
}
