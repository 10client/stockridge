'use strict';
// =====================================================================
// public/js/export.js — GETTING DATA OUT, WITHOUT A NETWORK
// =====================================================================
// Two honest reasons this exists:
//
//   1. A Nigerian business owner who cannot open their own data in Excel will
//      not trust the system. Every list screen therefore exports CSV.
//   2. When the accountant asks for "the sales for September" on the 3rd of
//      October, the answer must not depend on whether the internet is working.
//
// The server already offers /api/reports/export for the eight built-in reports.
// This module is the DEVICE-side equivalent: it exports whatever is on screen,
// from the mirror if the server cannot be reached, and says which one it used.
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
    const status = SR.ui.h('div', { class: 'hint' }, 'The file downloads with a UTF-8 BOM, so Excel reads the ₦ sign correctly.');
    wrap.appendChild(status);

    const run = SR.ui.h('button', { class: 'btn btn-primary' }, 'Download CSV');
    run.addEventListener('click', async () => {
      const values = SR.ui.readFormStrings(wrap);
      run.disabled = true;
      run.textContent = 'Generating…';
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
        const blob = await res.blob();
        U.download(`stockridge-${String(values.report).toLowerCase()}-${values.from}-to-${values.to}.csv`, blob, 'text/csv;charset=utf-8');
        SR.ui.ok('Report downloaded.');
      } catch (err) {
        SR.ui.error(`Could not generate that report: ${err.message}. You can still export what is on the screen.`);
      } finally {
        run.disabled = false;
        run.textContent = 'Download CSV';
      }
    });

    SR.ui.openModal({
      title: 'Export a report',
      body: wrap,
      footer: [
        SR.ui.h('button', { class: 'btn', onClick: () => { const m = document.getElementById('modal-root'); if (m) m.hidden = true; } }, 'Close'),
        run,
      ],
    });
  }

  /**
   * Export a list screen. Uses the live server when it can, and the device
   * mirror when it cannot — SAYING WHICH, because an export silently built from
   * a mirror that has not synced since Tuesday is a spreadsheet somebody will
   * make a decision on.
   */
  async function list({ filename, columns, path, query = {}, mirrorTable = null, where = null, title = null }) {
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
    const name = csv(filename || 'stockridge-export', columns, rows, { source });
    void title;
    return { name, rows, source, error };
  }

  SR.exporter = { csv, json, serverReport, reportDialog, list, SERVER_REPORTS };
}(window));
