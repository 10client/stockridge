'use strict';
// =====================================================================
// public/js/export.js — GETTING DATA OUT, WITHOUT A NETWORK
// =====================================================================
// Two honest reasons this exists:
//
//   1. A Nigerian business owner who cannot open their own data in Excel will
//      not trust the system. Every list screen therefore exports CSV, and the
//      same columns and rows can be saved as a PDF beside that CSV.
//   2. When the accountant asks for "the sales for September" on the 3rd of
//      October, the answer must not depend on whether the internet is working.
//
// The PDF is built on the device. There is no library and no CDN, so an
// offline till can still save the file. Helvetica has no naira glyph, so the
// PDF writes N where the CSV keeps ₦.
// =====================================================================
(function (global) {
  const SR = global.SR = global.SR || {};
  const U = SR.util;

  /**
   * Export rows to CSV and download them.
   *
   * `columns` is `[{ key, label, value? }]` — the same shape the tables use, so
   * a screen can export itself without a second definition of its columns.
   */
  function csv(filename, columns, rows, { source = null } = {}) {
    const text = SR.ui.tableToCsv(columns, rows);
    const stamp = U.todayWat();
    const name = `${filename}-${stamp}.csv`;
    U.download(name, text);
    SR.ui.ok(`Exported ${rows.length} row${rows.length === 1 ? '' : 's'} to ${name}${source ? ` (${source})` : ''}.`);
    return name;
  }

  function json(filename, data) {
    const stamp = U.todayWat();
    const name = `${filename}-${stamp}.json`;
    U.download(name, JSON.stringify(data, null, 2), 'application/json;charset=utf-8');
    SR.ui.ok(`Exported ${name}.`);
    return name;
  }

  /**
   * Fetch a server-side report, preferring the server and falling back to the
   * mirror. Reports that post to the ledger do not exist here — this is read-only.
   */
  async function serverReport(report, { from = null, to = null, branchId = null } = {}) {
    const params = new URLSearchParams({ report });
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (branchId) params.set('branch_id', branchId);
    const res = await fetch(`/api/reports/export?${params.toString()}`, {
      headers: { Authorization: `Bearer ${SR.api.loadToken()}` },
      cache: 'no-store',
    });
    if (!res.ok) {
      let message = `The report could not be generated (HTTP ${res.status}).`;
      try {
        const body = await res.json();
        if (body && body.error) message = body.error;
      } catch (e) { /* not JSON */ }
      throw new Error(message);
    }
    const blob = await res.blob();
    const name = `stockridge-${report.toLowerCase()}-${from || 'start'}-to-${to || U.todayWat()}.csv`;
    U.download(name, blob, 'text/csv;charset=utf-8');
    SR.ui.ok(`Downloaded ${name}.`);
    return name;
  }

  const SERVER_REPORTS = [
    { key: 'SALES', label: 'Sales — one row per receipt' },
    { key: 'SALES_DETAIL', label: 'Sales detail — one row per line item' },
    { key: 'STOCK', label: 'Stock on hand, with cost and value' },
    { key: 'DEBTORS', label: 'Debtors — who owes what' },
    { key: 'CREDITORS', label: 'Creditors — who we owe' },
    { key: 'EXPENSES', label: 'Expenses, with VAT and WHT' },
    { key: 'ADJUSTMENTS', label: 'Stock adjustments and write-offs' },
    { key: 'AUDIT', label: 'Audit trail (last 5000 entries)' },
  ];

  function plainCell(col, row) {
    const v = col && col.value ? col.value(row) : row[col.key];
    if (typeof Node !== 'undefined' && v instanceof Node) return v.textContent || '';
    if (v === null || v === undefined) return '';
    return String(v);
  }

  function shopBusiness() {
    try {
      const name = SR.state && SR.state.activeBusinessName && SR.state.activeBusinessName();
      if (name && name !== 'No business yet') return name;
    } catch (e) { /* signed out */ }
    return 'StockRidge';
  }

  function shopBranch() {
    try {
      return (SR.state && SR.state.activeBranchName && SR.state.activeBranchName()) || '';
    } catch (e) { return ''; }
  }

  /** Save the same columns and rows the CSV uses, as a real PDF file. */
  function pdf(filename, columns, rows, opts = {}) {
    const title = opts.title || U.titleCase(String(filename || 'export').replace(/-/g, ' '));
    const bits = [];
    if (opts.subtitle) bits.push(opts.subtitle);
    else if (shopBranch()) bits.push(shopBranch());
    if (opts.source) bits.push(`Source: ${opts.source}`);
    const file = buildTablePdf({
      title,
      business: opts.business || shopBusiness(),
      subtitle: bits.join('  ·  '),
      generatedAt: U.watClock(U.nowIso()),
      columns,
      rows,
      foot: opts.foot || null,
    });
    const stem = String(opts.downloadName || `${filename || 'stockridge-export'}-${U.todayWat()}`).replace(/\.pdf$/i, '');
    const name = `${stem}.pdf`;
    U.download(name, new Blob([file], { type: 'application/pdf' }), 'application/pdf');
    SR.ui.ok(`Saved ${rows.length} row${rows.length === 1 ? '' : 's'} to ${name}${opts.source ? ` (${opts.source})` : ''}.`);
    return name;
  }

  /** Export CSV and Save as PDF, as a pair, for a page head or a card. */
  function buttons(run, { csvLabel = 'Export CSV', pdfLabel = 'Save as PDF', className = 'btn btn-sm' } = {}) {
    return [
      SR.ui.h('button', { class: className, type: 'button', onClick: () => run('csv') }, csvLabel),
      SR.ui.h('button', { class: className, type: 'button', onClick: () => run('pdf') }, pdfLabel),
    ];
  }

  function cellPlain(el) {
    if (!el) return '';
    const fields = [...el.querySelectorAll('input, textarea, select')];
    const clone = el.cloneNode(true);
    clone.querySelectorAll('button, .btn, svg, input, textarea, select').forEach((n) => n.remove());
    const text = (clone.textContent || '').replace(/\s+/g, ' ').trim();
    if (!fields.length) return text;
    const values = fields.map((f) => {
      if (f.tagName === 'SELECT') {
        const opt = f.options && f.options[f.selectedIndex];
        return opt ? String(opt.textContent || '').trim() : String(f.value || '').trim();
      }
      if (f.type === 'checkbox' || f.type === 'radio') return f.checked ? (f.value || 'yes') : '';
      return String(f.value || '').trim();
    }).filter(Boolean);
    return [text, ...values].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  function tableHeading(table) {
    const card = table.closest && table.closest('.card');
    const head = card && card.querySelector('.card-head');
    const heading = head && head.querySelector('h2, h3');
    if (heading && heading.textContent.trim()) return heading.textContent.trim();
    const page = document.querySelector('.page-head h1');
    return (page && page.textContent.trim()) || 'Table';
  }

  function readRenderedTable(table) {
    const headers = [...table.querySelectorAll('thead th')].map(cellPlain);
    const body = [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map(cellPlain));
    const feet = [...table.querySelectorAll('tfoot tr')].map((tr) => [...tr.children].map(cellPlain));
    const keep = headers.map((label, i) => {
      const values = body.map((r) => (r[i] || '').trim());
      const head = String(label || '').trim();
      if (!head && values.every((v) => !v)) return false;
      if (/^actions?$/i.test(head) && values.every((v) => !v)) return false;
      return true;
    });
    const indexes = [];
    const columns = [];
    headers.forEach((label, i) => {
      if (!keep[i]) return;
      indexes.push(i);
      columns.push({ key: `c${columns.length}`, label: String(label || '').trim() });
    });
    const toRow = (cells) => {
      const row = {};
      indexes.forEach((src, i) => { row[`c${i}`] = cells[src] || ''; });
      return row;
    };
    const rows = body.map(toRow).filter((row) => columns.some((c) => String(row[c.key] || '').trim()));
    let foot = null;
    for (const cells of feet) {
      if (indexes.some((src) => String(cells[src] || '').trim())) foot = toRow(cells);
    }
    return { title: tableHeading(table), columns, rows, foot };
  }

  /** Save the table on screen — the same cells a person can read. */
  function saveTable(table, format) {
    const read = readRenderedTable(table);
    if (!read.columns.length || !read.rows.length) {
      SR.ui.info('There is nothing to export in this table.');
      return null;
    }
    const filename = String(read.title || 'table').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'table';
    if (format === 'pdf') {
      return pdf(filename, read.columns, read.rows, {
        title: read.title,
        source: 'this table',
        foot: read.foot,
      });
    }
    const rows = read.foot ? read.rows.concat([read.foot]) : read.rows;
    return csv(filename, read.columns, rows, { source: 'this table' });
  }

  /** A modal that offers the eight built-in reports plus a date range. */
  function reportDialog() {
    const wrap = SR.ui.h('div', {});
    const from = U.todayWat(-30);
    const to = U.todayWat();
    wrap.appendChild(SR.ui.h('div', { class: 'form-grid' },
      SR.ui.field({ label: 'Report', name: 'report', value: 'SALES', options: SERVER_REPORTS.map((r) => ({ value: r.key, label: r.label })) }),
      SR.ui.field({ label: 'From', name: 'from', type: 'date', value: from }),
      SR.ui.field({ label: 'To', name: 'to', type: 'date', value: to }),
      SR.ui.field({
        label: 'Scope',
        name: 'branch_scope',
        value: 'branch',
        options: [
          { value: 'branch', label: `Current branch (${SR.state.activeBranchName()})` },
          { value: 'all', label: 'Every branch I can see' },
        ],
        disabled: !SR.state.canSeeAllBranches(),
      })));
    const status = SR.ui.h('div', { class: 'hint' }, 'CSV keeps the ₦ sign for Excel. Save as PDF uses the same columns and rows; the naira sign is written as N so any viewer can open it.');
    wrap.appendChild(status);

    const csvBtn = SR.ui.h('button', { class: 'btn btn-primary', type: 'button', onClick: (ev) => download('csv', ev.currentTarget) }, 'Download CSV');
    const pdfBtn = SR.ui.h('button', { class: 'btn', type: 'button', onClick: (ev) => download('pdf', ev.currentTarget) }, 'Save as PDF');
    async function download(format, button) {
      const values = SR.ui.readFormStrings(wrap);
      csvBtn.disabled = true;
      pdfBtn.disabled = true;
      const previous = button.textContent;
      button.textContent = 'Generating…';
      try {
        const params = new URLSearchParams({ report: values.report, from: values.from, to: values.to });
        if (values.branch_scope === 'branch' && SR.state.activeBranchId) params.set('branch_id', SR.state.activeBranchId);
        const res = await fetch(`/api/reports/export?${params.toString()}`, {
          headers: { Authorization: `Bearer ${SR.api.loadToken()}` },
          cache: 'no-store',
        });
        if (!res.ok) {
          let message = `HTTP ${res.status}`;
          try { const b = await res.json(); if (b && b.error) message = b.error; } catch (e) { /* not json */ }
          throw new Error(message);
        }
        const text = await res.text();
        const stem = `stockridge-${String(values.report).toLowerCase()}-${values.from}-to-${values.to}`;
        if (format === 'pdf') {
          const parsed = parseCsv(text);
          const header = parsed[0] || [];
          const body = parsed.slice(1);
          const columns = header.map((label, i) => ({ key: `c${i}`, label }));
          const rows = body.map((r) => {
            const row = {};
            columns.forEach((c, i) => { row[c.key] = r[i] == null ? '' : r[i]; });
            return row;
          }).filter((row) => columns.some((c) => String(row[c.key] || '').trim()));
          if (!rows.length) {
            SR.ui.info('There is nothing to export with those filters.');
            return;
          }
          const label = (SERVER_REPORTS.find((r) => r.key === values.report) || {}).label || values.report;
          pdf(stem, columns, rows, {
            title: label,
            subtitle: `${values.from} to ${values.to}`,
            source: 'live server',
            downloadName: `${stem}.pdf`,
          });
        } else {
          U.download(`${stem}.csv`, new Blob([text], { type: 'text/csv;charset=utf-8' }), 'text/csv;charset=utf-8');
          SR.ui.ok('Report downloaded.');
        }
      } catch (err) {
        SR.ui.error(`Could not generate that report: ${err.message}. You can still export what is on the screen.`);
      } finally {
        csvBtn.disabled = false;
        pdfBtn.disabled = false;
        button.textContent = previous;
      }
    }
    SR.ui.openModal({
      title: 'Export a report',
      body: wrap,
      footer: [
        SR.ui.h('button', { class: 'btn', type: 'button', onClick: () => { const m = document.getElementById('modal-root'); if (m) m.hidden = true; } }, 'Close'),
        pdfBtn,
        csvBtn,
      ],
    });
  }

  /**
   * Export a list screen. Uses the live server when it can, and the device
   * mirror when it cannot — SAYING WHICH, because an export silently built from
   * a mirror that has not synced since Tuesday is a spreadsheet somebody will
   * make a decision on.
   *
   * `format` is `csv` or `pdf`. Both use the same columns and the same rows.
   */
  async function list({ filename, columns, path, query = {}, mirrorTable = null, where = null, title = null, subtitle = null, format = 'csv' }) {
    let rows = null; let source = 'live server'; let error = null;
    try {
      const data = await SR.api.get(path, { query: Object.assign({ limit: 500 }, query) });
      rows = (data && (data.data || data.rows)) || [];
    } catch (err) {
      error = err;
      if (!mirrorTable) throw err;
      rows = await SR.store.all(mirrorTable, { where });
      source = 'this device (offline mirror)';
    }
    if (!rows.length) {
      SR.ui.info('There is nothing to export with those filters.');
      return null;
    }
    const name = format === 'pdf'
      ? pdf(filename || 'stockridge-export', columns, rows, { source, title, subtitle })
      : csv(filename || 'stockridge-export', columns, rows, { source });
    return { name, rows, source, error };
  }

  // -------------------------------------------------------------------
  // A small PDF table. Type1 Helvetica, WinAnsi, no embedded font.
  // -------------------------------------------------------------------
  const HELVETICA = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
  ];

  function pdfText(value) {
    let usedNaira = false;
    let s = value == null ? '' : String(value);
    if (s.indexOf('₦') !== -1 || s.indexOf('\u20a6') !== -1) usedNaira = true;
    s = s
      .replace(/\u20a6/g, 'N')
      .replace(/\u2212/g, '-')
      .replace(/[\u2010-\u2015]/g, '-')
      .replace(/[\u2018\u2019\u2032]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/\u2026/g, '...')
      .replace(/\u00a0/g, ' ')
      .replace(/\u2022/g, '*')
      .replace(/\s+/g, ' ')
      .trim();
    let out = '';
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (c <= 126) out += ch;
      else if (c >= 160 && c <= 255) out += ch;
      else out += '?';
    }
    return { text: out, usedNaira };
  }

  function charWidth(ch) {
    const c = ch.codePointAt(0);
    if (c >= 32 && c <= 126) return HELVETICA[c - 32] || 500;
    return 600;
  }

  function textWidth(text, size, bold) {
    let w = 0;
    for (const ch of String(text || '')) w += charWidth(ch);
    return (w * size / 1000) * (bold ? 1.08 : 1);
  }

  function pdfLiteral(text) {
    let out = '(';
    for (const ch of String(text || '')) {
      const c = ch.codePointAt(0);
      if (c === 40 || c === 41 || c === 92) out += `\\${ch}`;
      else if (c >= 32 && c <= 126) out += ch;
      else if (c >= 160 && c <= 255) out += `\\${c.toString(8).padStart(3, '0')}`;
      else out += '?';
    }
    return `${out})`;
  }

  function n(v) { return (Math.round(Number(v) * 100) / 100).toFixed(2); }

  function wrapText(text, maxWidth, size, bold) {
    const raw = String(text || '').replace(/\s+/g, ' ').trim();
    if (!raw) return [''];
    // A figure must stay on one line. Splitting ₦45,749.50 after the 5 is a
    // different number, and a saved PDF must not do that.
    if (isNumericText(raw)) return [raw];
    const lines = [];
    let rest = raw;
    let guard = 0;
    while (rest && guard < 40) {
      guard += 1;
      if (textWidth(rest, size, bold) <= maxWidth) {
        lines.push(rest);
        rest = '';
        break;
      }
      let lo = 1;
      let hi = rest.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (textWidth(rest.slice(0, mid), size, bold) <= maxWidth) lo = mid;
        else hi = mid - 1;
      }
      let take = Math.max(1, lo);
      const space = rest.lastIndexOf(' ', take);
      if (space >= 8) take = space;
      lines.push(rest.slice(0, take).trim());
      rest = rest.slice(take).trim();
      if (lines.length === 8 && rest) {
        let last = lines[7];
        while (last.length > 1 && textWidth(`${last}...`, size, bold) > maxWidth) last = last.slice(0, -1);
        lines[7] = `${last}...`;
        rest = '';
      }
    }
    return lines.length ? lines : [''];
  }

  function isNumericText(s) {
    const t = String(s || '').trim();
    if (!t || t === '-' || t === '—') return false;
    return /^(?:[+-])?N?\d{1,3}(?:,\d{3})*(?:\.\d+)?%?$/.test(t)
      || /^(?:[+-])?\d+(?:\.\d+)?%?$/.test(t)
      || /^\d+d$/.test(t);
  }

  function headerLayout(pageH, continued, hasNote) {
    const lines = [];
    let fromTop = 24;
    if (!continued) {
      lines.push({ kind: 'business', fromTop });
      fromTop += 16;
      lines.push({ kind: 'title', fromTop });
      fromTop += 13;
      lines.push({ kind: 'meta', fromTop });
      if (hasNote) {
        fromTop += 11;
        lines.push({ kind: 'note', fromTop });
      }
    } else {
      lines.push({ kind: 'title', fromTop });
      fromTop += 12;
      lines.push({ kind: 'meta', fromTop });
    }
    fromTop += 8;
    return { lines, tableTop: pageH - fromTop };
  }

  function buildTablePdf({ title, business, subtitle, generatedAt, columns, rows, foot }) {
    const cols = (columns && columns.length) ? columns : [{ key: 'c0', label: '' }];
    const body = rows || [];
    let usedNaira = false;
    const matrix = body.map((row) => cols.map((col) => {
      const cell = pdfText(plainCell(col, row));
      if (cell.usedNaira) usedNaira = true;
      return cell.text;
    }));
    let footCells = null;
    if (foot) {
      footCells = cols.map((col) => {
        const cell = pdfText(plainCell(col, foot));
        if (cell.usedNaira) usedNaira = true;
        return cell.text;
      });
    }
    const labels = cols.map((col) => {
      const cell = pdfText(col.label || '');
      if (cell.usedNaira) usedNaira = true;
      return cell.text;
    });
    const note = usedNaira ? 'N stands for the naira sign. The CSV keeps the naira sign for Excel.' : '';
    const numeric = cols.map((col, i) => {
      const values = matrix.map((r) => r[i]).filter((v) => v && v !== '-');
      if (!values.length) return false;
      const hits = values.filter(isNumericText).length;
      return hits / values.length >= 0.6;
    });
    const wide = cols.length > 5;
    const pageW = wide ? 841.89 : 595.28;
    const pageH = wide ? 595.28 : 841.89;
    const margin = 36;
    const contentW = pageW - margin * 2;
    const fontSize = cols.length > 11 ? 7 : 8;
    const lineH = fontSize + 3;
    const measureRows = footCells ? matrix.concat([footCells]) : matrix;
    const preferred = labels.map((label, i) => {
      let widest = textWidth(label, 8, true) + 12;
      for (const row of measureRows) {
        const cell = row[i] || '';
        const full = textWidth(cell, fontSize, false) + 12;
        // Numbers are not wrapped, so the column has to be wide enough for the
        // whole figure. Prose can wrap, so a long note does not steal the page.
        widest = Math.max(widest, isNumericText(cell) ? full : Math.min(full, 180));
      }
      return Math.max(36, widest);
    });
    let sum = preferred.reduce((a, b) => a + b, 0);
    if (sum < contentW) {
      let extraIndex = 0;
      let best = -1;
      preferred.forEach((w, i) => {
        if (!numeric[i] && w > best) { best = w; extraIndex = i; }
      });
      preferred[extraIndex] += contentW - sum;
    } else if (sum > contentW) {
      const scale = contentW / sum;
      for (let i = 0; i < preferred.length; i += 1) preferred[i] = Math.max(24, preferred[i] * scale);
      sum = preferred.reduce((a, b) => a + b, 0);
      if (sum > contentW) {
        const fix = contentW / sum;
        for (let i = 0; i < preferred.length; i += 1) preferred[i] *= fix;
      }
    }
    sum = preferred.reduce((a, b) => a + b, 0);
    preferred[preferred.length - 1] += contentW - sum;

    const headerLines = labels.map((label, i) => wrapText(label, Math.max(12, preferred[i] - 8), 8, true));
    const headerRowH = Math.max(18, Math.max(...headerLines.map((l) => l.length)) * 11 + 8);
    const pack = matrix.map((row, index) => {
      const lines = row.map((cell, i) => wrapText(cell, Math.max(12, preferred[i] - 8), fontSize, false));
      const height = Math.max(16, Math.max(...lines.map((l) => l.length)) * lineH + 6);
      return { lines, height, index, foot: false };
    });
    if (footCells) {
      const lines = footCells.map((cell, i) => wrapText(cell, Math.max(12, preferred[i] - 8), fontSize, true));
      pack.push({
        lines,
        height: Math.max(16, Math.max(...lines.map((l) => l.length)) * lineH + 6),
        index: pack.length,
        foot: true,
      });
    }

    const pages = [];
    let cursor = 0;
    let first = true;
    const footerReserve = 32;
    if (!pack.length) {
      pages.push({ rows: [], first: true });
    }
    while (cursor < pack.length) {
      const top = headerLayout(pageH, !first, Boolean(note)).tableTop;
      const available = top - headerRowH - footerReserve;
      const slice = [];
      let used = 0;
      while (cursor < pack.length) {
        const row = pack[cursor];
        if (slice.length && used + row.height > available) break;
        slice.push(row);
        used += row.height;
        cursor += 1;
        if (row.height > available) break;
      }
      pages.push({ rows: slice, first });
      first = false;
    }

    const safeTitle = pdfText(title || 'Export').text || 'Export';
    const safeBusiness = pdfText(business || 'StockRidge').text || 'StockRidge';
    const safeSub = pdfText(subtitle || '').text;
    const safeWhen = pdfText(generatedAt || '').text;
    const ink = [0.06, 0.10, 0.13];
    const green = [0.05, 0.35, 0.13];
    const muted = [0.35, 0.42, 0.47];
    const line = [0.75, 0.80, 0.78];
    const zebra = [0.93, 0.97, 0.95];

    function clip(text, max, size, bold) {
      if (textWidth(text, size, bold) <= max) return text;
      let s = text;
      while (s.length > 1 && textWidth(`${s}...`, size, bold) > max) s = s.slice(0, -1);
      return `${s}...`;
    }
    function fill(x, y, w, h, rgb) {
      return `${n(rgb[0])} ${n(rgb[1])} ${n(rgb[2])} rg\n${n(x)} ${n(y)} ${n(w)} ${n(h)} re\nf`;
    }
    function textAt(font, size, x, y, value, rgb) {
      if (y < 8) return '';
      return `${n(rgb[0])} ${n(rgb[1])} ${n(rgb[2])} rg\nBT\n/${font} ${n(size)} Tf\n1 0 0 1 ${n(x)} ${n(y)} Tm\n${pdfLiteral(value)} Tj\nET`;
    }
    function drawLines(lines, x, top, width, size, bold, rgb, align) {
      const pad = 4;
      let baseline = top - pad - size * 0.78;
      const out = [];
      for (const lineText of lines) {
        const shown = clip(lineText, Math.max(8, width - pad * 2), size, bold);
        const tw = textWidth(shown, size, bold);
        const tx = align === 'right' ? x + width - pad - tw : x + pad;
        const op = textAt(bold ? 'F2' : 'F1', size, tx, baseline, shown, rgb);
        if (op) out.push(op);
        baseline -= (size + 3);
      }
      return out.join('\n');
    }

    const streams = pages.map((page, pageIndex) => {
      const ops = [];
      ops.push(fill(0, pageH - 6, pageW, 6, green));
      const head = headerLayout(pageH, !page.first, Boolean(note));
      for (const item of head.lines) {
        const y = pageH - item.fromTop;
        if (item.kind === 'business') ops.push(textAt('F2', 10, margin, y, clip(safeBusiness, contentW, 10, true), green));
        else if (item.kind === 'title') {
          const shown = page.first ? safeTitle : `${safeTitle} (continued)`;
          ops.push(textAt('F2', 13, margin, y, clip(shown, contentW, 13, true), ink));
        } else if (item.kind === 'meta') {
          const meta = [safeSub, safeWhen, `${body.length} row${body.length === 1 ? '' : 's'}`].filter(Boolean).join('   ·   ');
          ops.push(textAt('F1', 8, margin, y, clip(meta, contentW, 8, false), muted));
        } else if (item.kind === 'note') {
          ops.push(textAt('F1', 8, margin, y, clip(note, contentW, 8, false), muted));
        }
      }
      const tableTop = head.tableTop;
      ops.push(fill(margin, tableTop - headerRowH, contentW, headerRowH, green));
      let x = margin;
      headerLines.forEach((lines, i) => {
        ops.push(drawLines(lines, x, tableTop, preferred[i], 8, true, [1, 1, 1], numeric[i] ? 'right' : 'left'));
        x += preferred[i];
      });
      let y = tableTop - headerRowH;
      for (const row of page.rows) {
        const bottom = y - row.height;
        if (row.foot) ops.push(fill(margin, bottom, contentW, row.height, [0.90, 0.94, 0.91]));
        else if (row.index % 2 === 1) ops.push(fill(margin, bottom, contentW, row.height, zebra));
        x = margin;
        row.lines.forEach((lines, i) => {
          ops.push(drawLines(lines, x, y, preferred[i], fontSize, row.foot, ink, numeric[i] ? 'right' : 'left'));
          x += preferred[i];
        });
        ops.push(`${n(line[0])} ${n(line[1])} ${n(line[2])} RG\n0.4 w\n${n(margin)} ${n(bottom)} m ${n(margin + contentW)} ${n(bottom)} l S`);
        y = bottom;
      }
      const tableBottom = y;
      ops.push(`${n(green[0])} ${n(green[1])} ${n(green[2])} RG\n0.8 w\n${n(margin)} ${n(tableBottom)} ${n(contentW)} ${n(tableTop - tableBottom)} re S`);
      ops.push(`${n(line[0])} ${n(line[1])} ${n(line[2])} RG\n0.4 w\n${n(margin)} 24 m ${n(margin + contentW)} 24 l S`);
      ops.push(textAt('F1', 8, margin, 12, 'StockRidge', muted));
      const pageLabel = `Page ${pageIndex + 1} of ${pages.length}`;
      ops.push(textAt('F1', 8, margin + contentW - textWidth(pageLabel, 8, false), 12, pageLabel, muted));
      return ops.filter(Boolean).join('\n');
    });

    return assemblePdf(streams, pageW, pageH, safeTitle);
  }

  function assemblePdf(streams, pageW, pageH, title) {
    const pageCount = streams.length;
    const objects = new Array(5 + pageCount * 2);
    objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
    const kids = [];
    for (let i = 0; i < pageCount; i += 1) kids.push(`${6 + i * 2} 0 R`);
    objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`;
    objects[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
    objects[4] = `<< /Title ${pdfLiteral(title)} /Creator (StockRidge) /Producer (StockRidge) >>`;
    streams.forEach((body, i) => {
      const pageId = 6 + i * 2;
      const contentId = pageId + 1;
      objects[pageId - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(pageW)} ${n(pageH)}] /Contents ${contentId} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>`;
      objects[contentId - 1] = `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
    });
    let out = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((body, i) => {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = out.length;
    const size = objects.length + 1;
    out += `xref\n0 ${size}\n`;
    out += '0000000000 65535 f \n';
    for (let i = 1; i < size; i += 1) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${size} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return out;
  }

  function parseCsv(text) {
    const src = String(text || '').replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < src.length; i += 1) {
      const c = src[i];
      if (quoted) {
        if (c === '"') {
          if (src[i + 1] === '"') { field += '"'; i += 1; }
          else quoted = false;
        } else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && src[i + 1] === '\n') i += 1;
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else field += c;
    }
    if (field.length || row.length) {
      row.push(field);
      rows.push(row);
    }
    while (rows.length && rows[rows.length - 1].every((cell) => cell === '')) rows.pop();
    return rows;
  }

  SR.exporter = {
    csv, json, serverReport, reportDialog, list, buttons, pdf, saveTable, buildTablePdf, parseCsv, SERVER_REPORTS,
  };
}(window));
