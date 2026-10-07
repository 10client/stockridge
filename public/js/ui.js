'use strict';
// =====================================================================
// public/js/ui.js — SMALL, DEPENDENCY-FREE UI PRIMITIVES
// =====================================================================
// No framework. There is a reason beyond taste: a shop's back office laptop is
// often a five-year-old Windows machine on a shared connection, and the app has
// to render a 200-line sale and a 78-product catalogue on it without a build
// step, a bundle download or a hydration pass. Template strings plus delegated
// events are enough, and they are readable by whoever inherits this code.
//
// The one discipline enforced here: EVERY value interpolated into markup goes
// through `esc()`. A customer named `<img onerror=...>` is a real customer.
// =====================================================================
(function (global) {
  const SR = global.SR = global.SR || {};
  const U = SR.util;

  // -------------------------------------------------------------------
  // markup
  // -------------------------------------------------------------------
  const e = U.esc;

  /** Build an element from a tag, attributes and children. */
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), (ev) => v(keepCurrentTarget(ev, el)));
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
    for (const child of children.flat(4)) {
      if (child === null || child === undefined || child === false) continue;
      el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  /**
   * An event whose `currentTarget` stays valid for the whole of a handler's work.
   *
   * WHY THIS EXISTS — found by receiving stock through the real screen, on the
   * failure path where nobody looks:
   *
   *     const btn = ui.h('button', { onClick: async (ev) => {
   *       ev.currentTarget.disabled = true;          // fine: still dispatching
   *       ev.currentTarget.textContent = 'Recording…';
   *       try { await SR.api.post(...); }
   *       catch (err) {
   *         ui.apiError(err);
   *         ev.currentTarget.disabled = false;       // TypeError: null
   *         ev.currentTarget.textContent = 'Receive';
   *       }
   *     }}, 'Receive');
   *
   * The DOM sets `currentTarget` to null as soon as the dispatch finishes, and
   * `await` finishes it. So the catch block itself threw, and the button stayed on
   * "Recording…" and disabled for ever — the cashier could not retry without
   * reopening the form. Across this codebase that pattern appears in a dozen
   * handlers: every one of them broke precisely when something else had already
   * gone wrong, which is the worst possible moment to lose the recovery path.
   *
   * The element a listener is attached to is the currentTarget for the whole of
   * that listener's work, so this keeps saying so. Synchronous handlers are
   * unaffected; a runtime without Proxy gets the raw event and the old behaviour.
   */
  function keepCurrentTarget(ev, el) {
    try {
      return new Proxy(ev, {
        get(target, prop) {
          if (prop === 'currentTarget') return el;
          const value = target[prop];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    } catch (err) {
      return ev;
    }
  }

  function html(markup) {
    const t = document.createElement('template');
    t.innerHTML = String(markup).trim();
    return t.content.firstElementChild;
  }

  const frag = (markup) => { const t = document.createElement('template'); t.innerHTML = markup; return t.content; };

  function mount(target, node) {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return null;
    el.replaceChildren(node instanceof Node ? node : frag(String(node)));
    return el.firstElementChild;
  }

  // -------------------------------------------------------------------
  // toasts
  // -------------------------------------------------------------------
  function toast(message, { type = 'ok', ms = 4200, action = null } = {}) {
    const root = document.getElementById('toasts');
    if (!root) return null;
    const node = h('div', { class: `toast t-${type}`, role: type === 'err' ? 'alert' : 'status' });
    node.appendChild(h('div', { class: 'grow' }, message));
    if (action) {
      node.appendChild(h('button', { class: 'link-btn', onClick: () => { action.run(); node.remove(); } }, action.label));
    }
    node.appendChild(h('button', { class: 'toast-x', 'aria-label': 'Dismiss', onClick: () => node.remove() }, '×'));
    root.appendChild(node);
    if (ms) setTimeout(() => node.remove(), ms);
    return node;
  }
  const ok = (m, o) => toast(m, Object.assign({ type: 'ok' }, o));
  const warn = (m, o) => toast(m, Object.assign({ type: 'warn' }, o));
  const error = (m, o) => toast(m, Object.assign({ type: 'err', ms: 9000 }, o));
  const info = (m, o) => toast(m, Object.assign({ type: 'info' }, o));

  /** Report an ApiError consistently: problems listed, code visible. */
  function apiError(err, fallback = 'That did not work.') {
    const lines = [];
    lines.push(err && err.message ? err.message : fallback);
    if (err && Array.isArray(err.problems) && err.problems.length) {
      for (const p of err.problems.slice(0, 6)) {
        lines.push(typeof p === 'string' ? p : (p.message || p.error || JSON.stringify(p)));
      }
    }
    const node = toast(lines.join(' '), { type: 'err', ms: 11000 });
    if (err && err.code) node.dataset.code = err.code;
    return node;
  }

  // -------------------------------------------------------------------
  // modal
  // -------------------------------------------------------------------
  let modalStack = 0;

  /**
   * Open a modal.
   *
   *   openModal({ title, body, footer, onOpen }) -> { close }
   *
   * `body` is a Node or an HTML string. `footer` is a Node or an array of
   * buttons; the primary action is returned by `close(value)` rather than by
   * reaching into the DOM, so a caller can `await` the answer.
   */
  function openModal({ title, body, footer = null, size = '', onOpen = null, onClose = null, dismissable = true } = {}) {
    const root = document.getElementById('modal-root');
    const previous = document.activeElement;

    const dialog = h('div', { class: `modal ${size}`.trim(), role: 'dialog', 'aria-modal': 'true' });
    const head = h('div', { class: 'modal-head' });
    head.appendChild(h('h2', {}, title || ''));
    head.appendChild(h('div', { class: 'spacer' }));
    const closeBtn = h('button', { class: 'icon-btn', 'aria-label': 'Close', onClick: () => close(null) }, '×');
    head.appendChild(closeBtn);
    dialog.appendChild(head);

    const bodyEl = h('div', { class: 'modal-body' });
    if (body instanceof Node) bodyEl.appendChild(body);
    else if (typeof body === 'string') bodyEl.appendChild(frag(body));
    dialog.appendChild(bodyEl);

    if (footer) {
      const foot = h('div', { class: 'modal-foot' });
      const items = Array.isArray(footer) ? footer : [footer];
      for (const item of items) foot.appendChild(item instanceof Node ? item : frag(String(item)));
      dialog.appendChild(foot);
    }

    const layer = h('div', { class: 'modal-layer' });
    root.replaceChildren(dialog);
    root.hidden = false;
    modalStack += 1;
    void layer;

    if (dismissable) {
      root.onclick = (ev) => { if (ev.target === root) close(null); };
    }
    const onKey = (ev) => {
      if (ev.key === 'Escape' && dismissable) { ev.preventDefault(); close(null); }
      // A focus trap light enough to be honest: keep Tab inside the dialog.
      if (ev.key === 'Tab') {
        const focusable = dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (!focusable.length) return;
        const first = focusable[0]; const last = focusable[focusable.length - 1];
        if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
        else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);

    const firstField = dialog.querySelector('input, select, textarea');
    (firstField || closeBtn).focus();

    function close(value) {
      document.removeEventListener('keydown', onKey);
      root.onclick = null;
      root.replaceChildren();
      root.hidden = true;
      modalStack = Math.max(0, modalStack - 1);
      if (previous && previous.focus) { try { previous.focus(); } catch (err) { /* gone */ } }
      if (onClose) { try { onClose(value); } catch (err) { /* fine */ } }
    }

    if (onOpen) { try { onOpen({ dialog, body: bodyEl, close }); } catch (err) { error(err.message || 'The dialog failed to open.'); } }
    return { close, dialog, body: bodyEl };
  }

  /** A yes/no with a real consequence. Resolves true only on the affirmative. */
  function confirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, detail = null }) {
    return new Promise((resolve) => {
      let settled = false;
      const body = h('div', {});
      body.appendChild(h('p', {}, message));
      if (detail) body.appendChild(h('div', { class: 'alert alert-warn' }, detail));
      const cancel = h('button', { class: 'btn', onClick: () => finish(false) }, cancelLabel);
      const go = h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onClick: () => finish(true) }, confirmLabel);
      const m = openModal({ title, body, footer: [cancel, go], size: 'narrow', onClose: () => finish(false) });
      function finish(v) { if (settled) return; settled = true; resolve(v); m.close(v); }
    });
  }

  /** A single-field prompt. Resolves the trimmed string, or null if cancelled. */
  function promptDialog({ title, label, value = '', placeholder = '', type = 'text', required = false, hint = null, multiline = false }) {
    return new Promise((resolve) => {
      let settled = false;
      const wrap = h('div', {});
      wrap.appendChild(h('label', { class: 'ctl' }, label));
      const input = multiline
        ? h('textarea', { placeholder, rows: 3 })
        : h('input', { type, placeholder, value });
      if (!multiline) input.value = value;
      else input.value = value;
      wrap.appendChild(input);
      if (hint) wrap.appendChild(h('div', { class: 'hint' }, hint));
      const errLine = h('div', { class: 'err', hidden: true });
      wrap.appendChild(errLine);

      const cancel = h('button', { class: 'btn', onClick: () => finish(null) }, 'Cancel');
      const go = h('button', { class: 'btn btn-primary', onClick: submit }, 'Save');
      const m = openModal({ title, body: wrap, footer: [cancel, go], size: 'narrow', onClose: () => finish(null) });

      function submit() {
        const v = String(input.value || '').trim();
        if (required && !v) { errLine.textContent = 'This cannot be empty.'; errLine.hidden = false; input.focus(); return; }
        finish(v);
      }
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !multiline) { ev.preventDefault(); submit(); } });
      function finish(v) { if (settled) return; settled = true; resolve(v); m.close(v); }
      setTimeout(() => input.focus(), 30);
    });
  }

  // -------------------------------------------------------------------
  // loading / empty / error blocks
  // -------------------------------------------------------------------
  const loading = (label = 'Loading…') => h('div', { class: 'loading-line' }, h('span', { class: 'spinner' }), h('span', {}, label));

  function skeleton(lines = 4) {
    const wrap = h('div', { class: 'card-body stack' });
    for (let i = 0; i < lines; i += 1) {
      wrap.appendChild(h('div', { class: 'skeleton', style: { width: `${60 + ((i * 13) % 40)}%`, height: i === 0 ? '22px' : '15px' } }));
    }
    return h('div', { class: 'card' }, wrap);
  }

  function empty({ title = 'Nothing here yet', message = '', action = null, mark = 'box' } = {}) {
    const marks = {
      box: 'M3 7l9-4 9 4-9 4-9-4zm0 5l9 4 9-4M3 17l9 4 9-4',
      search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4',
      cart: 'M4 5h2l2.5 11h10L21 8H7M10 20a1 1 0 100-2 1 1 0 000 2zm8 0a1 1 0 100-2 1 1 0 000 2z',
      chart: 'M4 19V9m5 10V5m5 14v-7m5 7V8',
      // The drawer is a cash drawer, not a locked door: 'lock' is what a screen says
      // when the way in is shut, and "no till is open" is not that.
      cash: 'M2 7h20v10H2zM12 15a3 3 0 100-6 3 3 0 000 6z',
      lock: 'M7 11V8a5 5 0 0110 0v3M5 11h14v10H5z',
    };
    const node = h('div', { class: 'empty' });
    node.appendChild(h('div', {
      class: 'empty-mark',
      html: `<svg viewBox="0 0 24 24" width="46" height="46" aria-hidden="true"><path d="${marks[mark] || marks.box}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    }));
    node.appendChild(h('h3', {}, title));
    if (message) node.appendChild(h('p', {}, message));
    if (action) {
      const btn = h('button', { class: 'btn btn-primary', onClick: action.run }, action.label);
      node.appendChild(btn);
    }
    return node;
  }

  function errorBlock(err, { retry = null } = {}) {
    const node = h('div', { class: 'card' }, h('div', { class: 'card-body' },
      h('div', { class: 'alert alert-danger' },
        h('strong', {}, err && err.code === 'OFFLINE' ? 'You are offline. ' : 'That failed. '),
        err && err.message ? err.message : 'Unknown error.'),
      retry ? h('button', { class: 'btn', onClick: retry.run }, retry.label || 'Try again') : null));
    return node;
  }

  // -------------------------------------------------------------------
  // tables
  // -------------------------------------------------------------------
  /**
   * Render a table.
   *
   *   renderTable({ columns, rows, rowKey, onRowClick, empty, foot })
   *
   * A column is `{ key, label, align, render(row), width, className, sortable }`.
   * `render` returns a Node or a string, and strings are escaped here — so a
   * column that forgets `esc()` cannot become an injection.
   */
  function renderTable({ columns, rows, rowKey = (r, i) => i, onRowClick = null, emptyMessage = 'No rows.', emptyTitle = undefined, emptyAction = null, foot = null, rowClass = null }) {
    if (!rows || !rows.length) {
      return empty({ title: emptyTitle || 'Nothing to show', message: emptyMessage, action: emptyAction });
    }
    const wrap = h('div', { class: 'table-wrap' });
    const table = h('table', { class: 'data' });
    const thead = h('thead');
    const tr = h('tr');
    for (const col of columns) {
      tr.appendChild(h('th', { class: [col.align === 'right' ? 'num' : '', col.className || ''].join(' ').trim(), style: col.width ? { width: col.width } : null }, col.label));
    }
    thead.appendChild(tr);
    table.appendChild(thead);

    const tbody = h('tbody');
    rows.forEach((row, i) => {
      const trr = h('tr', { class: [onRowClick ? 'is-clickable' : '', rowClass ? rowClass(row, i) : ''].join(' ').trim() });
      if (onRowClick) {
        trr.tabIndex = 0;
        trr.addEventListener('click', () => onRowClick(row, i));
        trr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onRowClick(row, i); } });
      }
      // The row's key becomes a data attribute so a row can be found and
      // updated without repainting the table. Repainting on every keystroke of a
      // count input would steal focus from the box being typed into, which is
      // exactly what a stocktake sheet must not do.
      trr.dataset.row = String(rowKey(row, i));
      for (const col of columns) {
        const value = col.render ? col.render(row, i) : row[col.key];
        const td = h('td', { class: [col.align === 'right' ? 'num' : '', col.className || ''].join(' ').trim() });
        if (value instanceof Node) td.appendChild(value);
        else if (value === null || value === undefined) td.textContent = '—';
        else td.textContent = String(value);
        trr.appendChild(td);
      }
      tbody.appendChild(trr);
    });
    table.appendChild(tbody);

    if (foot) {
      const tfoot = h('tfoot');
      const ftr = h('tr');
      foot.forEach((cell, i) => {
        const col = columns[i] || {};
        const td = h('td', { class: col.align === 'right' ? 'num' : '' });
        if (cell instanceof Node) td.appendChild(cell);
        else td.textContent = cell === null || cell === undefined ? '' : String(cell);
        ftr.appendChild(td);
      });
      tfoot.appendChild(ftr);
      table.appendChild(tfoot);
    }

    wrap.appendChild(table);
    return wrap;
  }

  /** A card that holds a table and its pager. */
  function dataCard({ title = null, actions = [], table, pager = null, toolbar = null }) {
    const card = h('div', { class: 'card' });
    if (title || actions.length || toolbar) {
      const head = h('div', { class: 'card-head' });
      if (title) head.appendChild(h('h2', {}, title));
      if (toolbar) head.appendChild(toolbar);
      head.appendChild(h('div', { class: 'spacer' }));
      for (const a of actions) head.appendChild(a instanceof Node ? a : frag(String(a)));
      card.appendChild(head);
    }
    card.appendChild(h('div', { class: 'card-body tight' }, table));
    if (pager) card.appendChild(pager);
    return card;
  }

  /** A pagination bar. `page` is 0-based. */
  function pager({ page, pageSize, total, onPage, onSize = null }) {
    const from = total === 0 ? 0 : page * pageSize + 1;
    const to = Math.min(total, (page + 1) * pageSize);
    const bar = h('div', { class: 'pager' });
    bar.appendChild(h('span', {}, `${from}–${to} of ${total}`));
    bar.appendChild(h('span', { class: 'spacer' }));
    if (onSize) {
      const sel = h('select', { style: { width: '86px', minHeight: '32px', padding: '3px 26px 3px 8px' } });
      for (const n of [25, 50, 100, 250]) sel.appendChild(h('option', { value: n, selected: n === pageSize }, `${n}`));
      sel.addEventListener('change', () => onSize(Number(sel.value)));
      bar.appendChild(sel);
    }
    const prev = h('button', { class: 'btn btn-sm', disabled: page <= 0, onClick: () => onPage(page - 1) }, 'Prev');
    const next = h('button', { class: 'btn btn-sm', disabled: to >= total, onClick: () => onPage(page + 1) }, 'Next');
    bar.appendChild(prev); bar.appendChild(next);
    return bar;
  }

  // -------------------------------------------------------------------
  // badges and small pieces
  // -------------------------------------------------------------------
  const TONES = {
    COMPLETED: 'badge-good', RECEIVED: 'badge-good', ACTIVE: 'badge-good', APPROVED: 'badge-good',
    PAID: 'badge-good', CLEARED: 'badge-good', DELIVERED: 'badge-good', COMPLETE: 'badge-good',
    RESOLVED: 'badge-good', OPEN: 'badge-info', PENDING: 'badge-warn', PENDING_APPROVAL: 'badge-warn',
    PARTIALLY_RECEIVED: 'badge-warn', PARTIAL: 'badge-warn', SCHEDULED: 'badge-info', IN_PROGRESS: 'badge-info',
    SENT: 'badge-info', COUNTING: 'badge-info', RETRY: 'badge-warn', RETRYING: 'badge-warn',
    VOIDED: 'badge-bad', CANCELLED: 'badge-bad', REJECTED: 'badge-bad', FAILED: 'badge-bad',
    OVERDUE: 'badge-bad', EXPIRED: 'badge-bad', OUT_OF_STOCK: 'badge-bad', QUARANTINED: 'badge-bad',
    DRAFT: 'badge-mute', CLOSED: 'badge-mute', SYNCED: 'badge-mute', INACTIVE: 'badge-mute',
    FLAGGED: 'badge-violet', REVIEW: 'badge-violet', CONFLICT: 'badge-violet', PENDING_DELIVERY: 'badge-violet',
  };
  function badge(label, tone = null) {
    const key = String(label || '').toUpperCase().replace(/\s+/g, '_');
    const cls = tone || TONES[key] || 'badge-mute';
    return h('span', { class: `badge ${cls}` }, U.humanise(label));
  }
  const statusBadge = (status) => badge(status);

  /**
   * A KPI TILE, WITH THE ICON THAT SAYS WHAT IT COUNTS.
   *
   * The fourth argument is a name from the navigation's icon set (`SR.app.iconPath`),
   * not markup, so a tile cannot invent its own glyph and the vocabulary stays the
   * one the sidebar already teaches. It is optional: a tile whose meaning is in the
   * label needs no decoration, and an icon that does not help the reader find the
   * number is one more thing to look past.
   */
  /**
   * WHICH ICON BELONGS TO A FIGURE — DERIVED FROM THE FIGURE ITSELF.
   *
   * Every tile that shows money is about money, and a tile that counts debtors is about
   * people; an icon that says otherwise is worse than no icon, because it is read at a
   * glance and believed. Two were wrong on the dashboard when this was written: "Owed to
   * us ₦34,579,273.97" carried the PEOPLE icon (the tile is a naira figure, and the people
   * are counted in the line underneath it), and "Expected in drawer" carried the STOCK
   * box. A tile with no icon at all was the state of 188 of them across the app.
   *
   * The rule is small, ordered and written down, and it never overrides an icon a caller
   * passed: an explicit choice always wins. The first matching line decides.
   *
   * It also never falls back to a generic square. `iconPath` answers `grid` for a name it
   * does not know, so a typo in a caller's `icon:` renders a grid square and looks like a
   * considered choice — this function returns null instead, and the tile simply has no
   * icon, which is honest.
   */
  const MONEY = /(?:\u20a6|NGN)/i;
  // A MONEY TILE GETS A MONEY ICON. The rules are deliberately different from the ones
  // below: a naira figure cannot be a percentage or a date, so a label that merely MENTIONS
  // margin ("Margin if all sold" is money) must not send the tile to the chart icon.
  const MONEY_ICON_RULES = [
    [/owed|owe\b|debt|outstanding|payable|receivable|balance due|credit limit|credit given/i, 'ledger'],
    [/held|float|drawer|safe\b|purse|deposit|advance|petty/i, 'wallet'],
    [/stock|inventory|units?\b|on hand|reorder|\bat cost\b|\bat retail\b|value of/i, 'box'],
    [/sales?\b|receipts?\b|takings?|revenue|invoices?\b|cash in/i, 'receipt'],
  ];
  const FIGURE_RULES = [
    // people — before money, because "Owed to us · 11 debtors" is a sentence about people
    // only when the FIGURE is a count, which is checked first.
    [/staff|people|\busers?\b|debtor|customer|supplier|cashier|driver|\bseats?\b|employee/i, 'users'],
    [/%|margin|rate|pct|ratio|share\b/i, 'chart'],
    [/expir|deadline|due\b|renew|valid (?:to|until)|date\b|next\b/i, 'calendar'],
    [/hours?|minutes?|late\b|since\b|duration|shift/i, 'clock'],
    [/stock|units?|on hand|\blines?\b|product|inventory|reorder|quantity\b/i, 'box'],
    [/sales?\b|receipts?\b|takings?|revenue|invoices?\b/i, 'receipt'],
  ];

  /** True when the figure is money — a formatted amount, never a count or a word. */
  function isMoney(value) {
    const v = String(value == null ? '' : value);
    return /\u20a6/.test(v) || MONEY.test(v);
  }

  function iconForFigure({ label = '', value = null } = {}) {
    const text = String(label);
    const v = String(value == null ? '' : value);
    const money = isMoney(v);
    if (money) {
      for (const [re, name] of MONEY_ICON_RULES) if (re.test(text)) return name;
      return 'cash';
    }
    // A DATE IS NOT A COUNT. A value that reads as a date gets the calendar whatever the
    // label says; "-" and "" get nothing at all.
    if (/^\d{4}-\d{2}-\d{2}/.test(v) || /^\d{1,2} [A-Z][a-z]{2}/.test(v)) return 'calendar';
    if (!/^[\d.,\s%+-]+$/.test(v) || !/\d/.test(v)) return null;   // words, statuses, "—"
    for (const [re, name] of FIGURE_RULES) if (re.test(text)) return name;
    return 'hash';   // a plain count with no unit on the tile
  }

  /**
   * A trend chip: the figure moved, and the arrow points the way it moved.
   *
   * `trend` is `{ pct, change, goodWhen, vs }`. `pct` wins when the server sent one;
   * otherwise the naira delta is shown instead, and when the server sent NEITHER (there
   * was no yesterday to compare with) the tile gets NO chip — an arrow is a statement
   * about a comparison, and there is no comparison to make. `goodWhen` says which
   * direction is good for this figure: more takings is good, more debt is not.
   */
  function trendChip(trend) {
    if (!trend) return null;
    const pct = trend.pct == null ? null : Number(trend.pct);
    const change = trend.change == null ? null : Number(trend.change);
    const hasPct = pct !== null && Number.isFinite(pct);
    // A DELTA OF ZERO IS NOT A COMPARISON. The server sends `changePct: null` when there is
    // no baseline to divide by, and a `change` of exactly 0 beside it — a chip reading
    // "flat ₦0" tells nobody anything, and on a quiet morning it is the only thing on the
    // tile. No percentage and no movement means no chip.
    const hasChange = change !== null && Number.isFinite(change) && change !== 0;
    if (!hasPct && !hasChange) return null;
    const direction = hasPct ? (pct > 0 ? 'up' : (pct < 0 ? 'down' : 'flat')) : (change > 0 ? 'up' : 'down');
    const good = direction === 'flat' ? 'flat' : (direction === (trend.goodWhen || 'up') ? 'good' : 'bad');
    const icon = direction === 'up' ? 'trendUp' : (direction === 'down' ? 'trendDown' : 'trendFlat');
    const path = (global.SR && SR.app && SR.app.iconPath) ? SR.app.iconPath(icon) : null;
    const shown = pct !== null && Number.isFinite(pct)
      ? `${Math.abs(Math.round(pct * 10) / 10)}%`
      : ((global.SR && SR.util && SR.util.money) ? SR.util.money(Math.abs(change)) : String(Math.abs(change)));
    const word = direction === 'up' ? 'up' : (direction === 'down' ? 'down' : 'unchanged');
    const vs = trend.vs ? ` on ${trend.vs}` : '';
    const chip = h('span', {
      class: `kpi-trend is-${good}`,
      title: `${word} ${shown}${vs}`,
      'aria-label': `${word} ${shown}${vs}`,
    });
    if (path) {
      chip.appendChild(h('span', {
        class: 'kpi-trend-icon',
        html: `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
      }));
    }
    chip.appendChild(h('span', {}, shown));
    return chip;
  }

  function kpi({ label, value, foot = null, tone = null, small = false, icon = null, trend = null }) {
    const node = h('div', { class: `kpi ${tone ? `tone-${tone}` : ''}`.trim() });
    const labelRow = h('div', { class: 'kpi-label' });
    // AN EXPLICIT ICON WINS; otherwise the figure picks its own.
    const chosen = icon || iconForFigure({ label, value });
    if (chosen) {
      const path = (global.SR && SR.app && SR.app.iconPath) ? SR.app.iconPath(chosen) : null;
      if (path) {
        labelRow.appendChild(h('span', {
          class: 'kpi-icon',
          html: `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
        }));
      } else if (icon) {
        // A NAME WE DO NOT KNOW IS A BUG IN THE CALLER, not a design decision — and it used
        // to render a generic square, which looks exactly like a considered choice.
        console.warn(`[ui.kpi] no such icon: "${icon}"`);
      }
    }
    labelRow.appendChild(h('span', { class: 'kpi-label-text' }, label));
    const chip = trendChip(trend);
    if (chip) labelRow.appendChild(chip);
    node.appendChild(labelRow);
    node.appendChild(h('div', { class: `kpi-value ${small ? 'sm' : ''}`.trim() }, value));
    if (foot) node.appendChild(h('div', { class: 'kpi-foot' }, foot));
    return node;
  }

  function kv(pairs) {
    const dl = h('dl', { class: 'kv' });
    for (const [k, v] of pairs) {
      if (v === null || v === undefined || v === '') continue;
      dl.appendChild(h('dt', {}, k));
      dl.appendChild(h('dd', {}, v instanceof Node ? v : String(v)));
    }
    return dl;
  }

  /** Horizontal bars, no charting library. */
  function bars(items, { max = null, format = (v) => String(v), tone = '' } = {}) {
    const list = (items || []).filter(Boolean);
    if (!list.length) return empty({ title: 'No data for this period', message: 'Nothing to chart yet.' });
    const ceiling = max || Math.max(...list.map((i) => Number(i.value) || 0), 1);
    const wrap = h('div', { class: 'bars' });
    for (const item of list) {
      const val = Number(item.value) || 0;
      const row = h('div', { class: 'bar-row' });
      row.appendChild(h('span', { title: item.label }, item.label));
      const track = h('div', { class: 'bar-track' });
      track.appendChild(h('div', { class: `bar-fill ${tone}`, style: { width: `${U.clamp((val / ceiling) * 100, val > 0 ? 2 : 0, 100)}%` } }));
      row.appendChild(track);
      row.appendChild(h('span', { class: 'bar-val' }, format(val)));
      wrap.appendChild(row);
    }
    return wrap;
  }

  function sparkline(values, { height = 42 } = {}) {
    const list = (values || []).map(Number);
    if (!list.length) return h('div', { class: 'hint' }, 'No trend yet.');
    const max = Math.max(...list, 1);
    const wrap = h('div', { class: 'spark', style: { height: `${height}px` } });
    for (const v of list) wrap.appendChild(h('i', { style: { height: `${U.clamp((v / max) * 100, 2, 100)}%` }, title: String(v) }));
    return wrap;
  }

  // -------------------------------------------------------------------
  // form helpers
  // -------------------------------------------------------------------
  /** The values of every named control inside a container, coerced. */
  function readForm(container) {
    const out = {};
    for (const el of container.querySelectorAll('[name]')) {
      const name = el.getAttribute('name');
      if (el.type === 'checkbox') out[name] = el.checked ? 1 : 0;
      else if (el.type === 'number') out[name] = el.value === '' ? null : Number(el.value);
      else out[name] = el.value === '' ? null : el.value;
    }
    return out;
  }

  function readFormStrings(container) {
    const out = {};
    for (const el of container.querySelectorAll('[name]')) {
      out[el.getAttribute('name')] = el.value === '' ? null : el.value;
    }
    return out;
  }

  function field({ label, name, value = '', type = 'text', options = null, hint = null, required = false, placeholder = '', step = null, min = null, max = null, span = false, disabled = false, rows = null }) {
    const wrap = h('div', { class: span ? 'span-2' : '' });
    wrap.appendChild(h('label', { class: 'ctl' }, label + (required ? ' *' : '')));
    let input;
    if (options) {
      input = h('select', { name, required, disabled });
      for (const opt of options) {
        const o = typeof opt === 'string' ? { value: opt, label: U.humanise(opt) } : opt;
        input.appendChild(h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label));
      }
    } else if (type === 'textarea') {
      input = h('textarea', { name, placeholder, required, disabled, rows: rows || 3 });
      input.value = value === null || value === undefined ? '' : String(value);
    } else if (type === 'checkbox') {
      input = h('input', { type: 'checkbox', name, disabled, checked: Boolean(Number(value)) });
    } else {
      input = h('input', { type, name, placeholder, required, disabled, step, min, max });
      input.value = value === null || value === undefined ? '' : String(value);
    }
    wrap.appendChild(input);
    if (hint) wrap.appendChild(h('div', { class: 'hint' }, hint));
    return wrap;
  }

  /** Disable a form's controls while an action is in flight, so a double-tap on
   *  a slow connection cannot post the same sale twice. */
  async function withBusy(container, fn) {
    const controls = Array.from(container.querySelectorAll('button, input, select, textarea'));
    const before = controls.map((c) => c.disabled);
    controls.forEach((c) => { c.disabled = true; });
    try { return await fn(); } finally {
      controls.forEach((c, i) => { c.disabled = before[i]; });
    }
  }

  // -------------------------------------------------------------------
  // misc
  // -------------------------------------------------------------------
  function copyToClipboard(text, label = 'Copied.') {
    const value = String(text);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(() => ok(label)).catch(() => fallback());
    } else fallback();
    function fallback() {
      const ta = h('textarea', { style: { position: 'fixed', left: '-999px' } });
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); ok(label); } catch (e) { warn('Copy failed — select the text manually.'); }
      ta.remove();
    }
  }

  /** Turn a list of objects into a CSV download. The Nigerian accounting world
   *  is Excel, so this is the export format that actually gets used. */
  function tableToCsv(columns, rows) {
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = columns.map((c) => esc(c.label || c.key)).join(',');
    const body = (rows || []).map((r) => columns.map((c) => {
      const v = c.value ? c.value(r) : r[c.key];
      return esc(v instanceof Node ? v.textContent : v);
    }).join(','));
    // The BOM is what makes Excel read UTF-8 instead of guessing a legacy
    // codepage, which is the difference between ₦45,000 and Â¦45,000.
    return `\uFEFF${[head, ...body].join('\r\n')}\r\n`;
  }

  function debounceInput(input, fn, ms = 300) {
    const run = U.debounce(fn, ms);
    input.addEventListener('input', () => run(input.value));
    return input;
  }

  SR.ui = {
    h, html, frag, mount, e,
    toast, ok, warn, error, info, apiError,
    openModal, confirmDialog, promptDialog,
    loading, skeleton, empty, errorBlock,
    renderTable, dataCard, pager,
    badge, statusBadge, TONES, kpi, kv, bars, sparkline, iconForFigure, trendChip,
    field, readForm, readFormStrings, withBusy,
    copyToClipboard, tableToCsv, debounceInput,
  };
}(window));
