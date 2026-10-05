'use strict';
// =====================================================================
// public/js/views/till.js — THE DRAWER, THE SAFE, AND THE COUNT
// =====================================================================
// The number this screen exists to produce is a VARIANCE, and a variance is only
// believable if the person who counted cash cannot change the expectation.
//
// So the screen is built backwards from that: the expected cash is shown as a
// sum of things that were already recorded (float + cash sales − refunds), the
// counted cash is the only figure anyone types, and the difference between them
// is printed in the largest type on the page before anybody can save.
//
// Three further rules are enforced by the server and surfaced here so nobody is
// surprised by them:
//
//   * A closed till is never mutated. A sale posted after the count appears as a
//     LATE POSTING — it hits the books, not the signed-off session.
//   * Closing needs a count. "Close" with no number records no variance, which
//     is the same as not having opened the till at all.
//   * Only a manager reviews a variance, and a rejection needs a reason.
// =====================================================================
(function (global) {
  const SR = global.SR;
  const ui = SR.ui;
  const U = SR.util;

  const SAFE_ENTRY_TYPES = [
    { value: 'DEPOSIT', label: 'Deposit into the safe' },
    { value: 'WITHDRAWAL', label: 'Take money out of the safe' },
    { value: 'BANKING', label: 'Bank it (deposit slip)' },
    { value: 'EXPENSE', label: 'Pay an expense from the safe' },
    { value: 'ADJUSTMENT', label: 'Correct the balance (audited)' },
  ];
  const PAYOUT_REASONS = [
    'TRANSPORT', 'FEEDING', 'FUEL', 'CLEANING', 'REPAIRS', 'CASUAL_WORKER',
    'BANK_CHARGES', 'SUPPLIES', 'OTHER',
  ];

  async function render(ctx) {
    if (ctx.params.id) return renderDetail(ctx);
    ctx.setTitle('Till & safe');
    const state = { page: 0, pageSize: 25, status: '', days: 14 };

    const wrap = ui.h('div', { class: 'stack' });
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Till & safe'),
        ui.h('p', { class: 'sub' }, `${SR.state.activeBranchName()} · the drawer, and what happened to the cash in it`)),
      ui.h('div', { class: 'actions' },
        SR.state.atLeast('MANAGER') ? ui.h('button', { class: 'btn btn-sm', onClick: () => openSafeEntry() }, 'Safe entry') : null,
        ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => openTill() }, 'Open a till'))));

    const banner = ui.h('div', {});
    wrap.appendChild(banner);

    const currentHost = ui.h('div', {});
    wrap.appendChild(currentHost);

    const summaryHost = ui.h('div', {});
    wrap.appendChild(summaryHost);

    const toolbar = ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body row' }));
    const statusSel = ui.h('select', { onchange: (e) => { state.status = e.target.value; state.page = 0; load(); } });
    for (const [v, l] of [['', 'Any status'], ['OPEN', 'Open now'], ['CLOSED', 'Closed']]) {
      statusSel.appendChild(ui.h('option', { value: v, selected: v === state.status }, l));
    }
    const daysSel = ui.h('select', { onchange: (e) => { state.days = Number(e.target.value); state.page = 0; load(); } });
    for (const [v, l] of [[1, 'Today'], [7, 'Last 7 days'], [14, 'Last 14 days'], [30, 'Last 30 days']]) {
      daysSel.appendChild(ui.h('option', { value: v, selected: v === state.days }, l));
    }
    toolbar.firstElementChild.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Status'), statusSel));
    toolbar.firstElementChild.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Period'), daysSel));
    wrap.appendChild(toolbar);

    const host = ui.h('div', {});
    wrap.appendChild(host);

    // ---------------------------------------------------------------- load
    async function load() {
      currentHost.replaceChildren(ui.skeleton(2));
      host.replaceChildren(ui.skeleton(7));
      let data; let offline = false;

      // The open till first: if there is one, it is the most important thing on
      // the screen and everything else is context.
      try {
        const current = await SR.api.get('/api/tills/current', { query: SR.state.query({}) });
        if (current && current.till) renderCurrent(current, false);
        else renderNoOpenTill();
      } catch (err) {
        if (!err.isOffline) renderNoOpenTill(String(err.message || 'Could not read the current till.'));
        else {
          offline = true;
          const open = await SR.store.all('till_sessions', { where: (t) => String(t.status) === 'OPEN' && !Number(t.is_deleted) });
          if (open.length) renderCurrent({ till: open[0] }, true); else renderNoOpenTill();
        }
      }

      try {
        data = await SR.api.get('/api/tills', {
          query: SR.state.query({ status: state.status || undefined, from: U.addDays(U.todayWat(), -state.days), limit: state.pageSize, offset: state.page * state.pageSize }),
        });
      } catch (err) {
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: load } })); return; }
        offline = true;
        const all = await SR.store.all('till_sessions', { where: (t) => !Number(t.is_deleted) });
        const from = U.addDays(U.todayWat(), -state.days);
        let rows = all.filter((t) => String(t.opened_at).slice(0, 10) >= from);
        if (state.status) rows = rows.filter((t) => String(t.status).toUpperCase() === state.status);
        rows.sort((a, b) => String(b.opened_at).localeCompare(String(a.opened_at)));
        data = {
          data: rows.slice(state.page * state.pageSize, (state.page + 1) * state.pageSize),
          paging: { total: rows.length, limit: state.pageSize, offset: state.page * state.pageSize },
          summary: {
            sessions: rows.length,
            takings: U.sum(rows, (t) => t.total_sales) || U.sum(rows, (t) => t.cash_sales_total),
            netVariance: U.sum(rows, (t) => t.variance),
            openNow: rows.filter((t) => String(t.status) === 'OPEN').length,
          },
        };
      }

      banner.replaceChildren(offline ? offlineBanner() : []);
      renderSummary(data.summary || {});
      renderList(data);
    }

    function offlineBanner() {
      return ui.h('div', { class: 'alert alert-warn' },
        'Offline — showing the till sessions mirrored on this device. Opening and closing a till needs the server, because the count must be recorded once, by one device, against one expectation.');
    }

    // ------------------------------------------------------------- current
    function renderNoOpenTill(message) {
      currentHost.replaceChildren(ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' },
        ui.h('div', { class: 'row' },
          ui.h('div', { class: 'grow' },
            ui.h('h2', {}, 'No till is open'),
            ui.h('p', { class: 'sub' }, message || 'Open a till with the float you are starting the day with. Every cash sale until it closes is counted against that float — which is what makes the variance mean something.')),
          ui.h('button', { class: 'btn btn-primary', onClick: () => openTill() }, 'Open a till')))));
    }

    function renderCurrent(payload, offline) {
      const t = payload.till || {};
      const expected = U.amount(Number(t.opening_cash || 0) + Number(t.cash_sales_total || 0) - Number(t.refund_total || 0));
      const next = ui.h('div', { class: 'stack' });
      next.appendChild(ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' },
        ui.h('div', { class: 'row' },
          ui.h('div', { class: 'grow' },
            ui.h('h2', {}, `Till open — ${t.cashier_name || SR.state.user.fullName}`),
            ui.h('p', { class: 'sub' }, `Opened ${U.dateTime(t.opened_at)}${t.device_id ? ` · ${t.device_id}` : ''}`)),
          ui.h('div', { class: 'actions' },
            ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate(`/tills/${encodeURIComponent(t.id)}`) }, 'Open the sheet'),
            ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => closeTill(t) }, 'Close & count'))),
        ui.h('div', { class: 'kpis' },
          ui.kpi({ label: 'Opening float', value: U.money(t.opening_cash) }),
          ui.kpi({ label: 'Cash sales', value: U.money(t.cash_sales_total) }),
          ui.kpi({ label: 'Refunds', value: U.money(t.refund_total), tone: Number(t.refund_total) > 0 ? 'warn' : null }),
          ui.kpi({ label: 'Expected in the drawer', value: U.money(expected), tone: 'info', foot: 'float + cash sales − refunds' })))));
      currentHost.replaceChildren(next);
      if (offline) banner.replaceChildren(offlineBanner());
    }

    // ------------------------------------------------------------- summary
    function renderSummary(s) {
      const netVariance = Number(s.netVariance || 0);
      summaryHost.replaceChildren(ui.h('div', { class: 'kpis' },
        ui.kpi({ label: 'Sessions', value: U.qty(s.sessions || 0), foot: `last ${state.days} day(s)` }),
        ui.kpi({ label: 'Takings in the period', value: U.money(s.takings || 0) }),
        ui.kpi({
          label: 'Net variance',
          value: U.money(netVariance),
          tone: Math.abs(netVariance) < 1 ? 'good' : (netVariance < 0 ? 'bad' : 'warn'),
          foot: Math.abs(netVariance) < 1 ? 'every count matched' : 'money that cannot be accounted for',
        }),
        ui.kpi({ label: 'Open now', value: U.qty(s.openNow || 0), tone: Number(s.openNow) > 0 ? 'info' : null })));
    }

    // ---------------------------------------------------------------- list
    function renderList(data) {
      const rows = data.data || data.records || [];
      const total = (data.paging && data.paging.total != null) ? data.paging.total : rows.length;
      host.replaceChildren(ui.dataCard({
        title: 'Till sessions',
        actions: [ui.h('button', { class: 'btn btn-sm', onClick: () => exportList() }, 'Export')],
        table: ui.renderTable({
          columns: [
            { key: 'opened_at', label: 'Opened', render: (t) => U.dateTime(t.opened_at) },
            { key: 'cashier_name', label: 'Cashier', render: (t) => t.cashier_name || '—' },
            { key: 'branch_name', label: 'Branch', render: (t) => t.branch_name || branchLabel(t) },
            { key: 'sales_count', label: 'Sales', align: 'right', render: (t) => U.qty(t.sales_count || 0) },
            { key: 'cash_sales_total', label: 'Cash', align: 'right', render: (t) => U.money(t.cash_sales_total) },
            { key: 'expected_cash', label: 'Expected', align: 'right', render: (t) => U.money(t.expected_cash) },
            { key: 'counted_cash', label: 'Counted', align: 'right', render: (t) => (t.counted_cash == null ? '—' : U.money(t.counted_cash)) },
            {
              key: 'variance',
              label: 'Variance',
              align: 'right',
              render: (t) => {
                if (t.variance == null) return ui.badge('not counted', 'badge-mute');
                const v = Number(t.variance);
                if (Math.abs(v) < 0.5) return ui.badge('matched', 'badge-good');
                return ui.h('span', {}, ui.badge(v < 0 ? `short ${U.money(Math.abs(v))}` : `over ${U.money(v)}`, v < 0 ? 'badge-bad' : 'badge-warn'),
                  t.reviewed_by ? ui.h('span', { class: 'hint' }, ' reviewed') : null);
              },
            },
            { key: 'status', label: 'Status', render: (t) => ui.statusBadge(t.status) },
          ],
          rows,
          onRowClick: (t) => SR.app.navigate(`/tills/${encodeURIComponent(t.id)}`),
          emptyTitle: 'No till sessions in this period',
          emptyMessage: 'A till session starts when somebody opens the drawer with a float and ends with a physical cash count. Without it, a cash shortage has nowhere to show up.',
        }),
        pager: total > state.pageSize ? ui.pager({
          page: state.page, pageSize: state.pageSize, total,
          onPage: (p) => { state.page = p; load(); },
          onSize: (s) => { state.pageSize = s; state.page = 0; load(); },
        }) : null,
      }));
    }

    function branchLabel(t) {
      const b = SR.state.branches().find((x) => String(x.id) === String(t.branch_id));
      return b ? b.name : '—';
    }

    async function exportList() {
      try {
        await SR.exporter.list({
          filename: 'till-sessions',
          path: '/api/tills',
          query: SR.state.query({ from: U.addDays(U.todayWat(), -state.days), status: state.status || undefined }),
          mirrorTable: 'till_sessions',
          columns: [
            { key: 'opened_at', label: 'Opened' }, { key: 'closed_at', label: 'Closed' },
            { key: 'cashier_name', label: 'Cashier' }, { key: 'branch_name', label: 'Branch' },
            { key: 'opening_cash', label: 'Float' }, { key: 'cash_sales_total', label: 'Cash sales' },
            { key: 'refund_total', label: 'Refunds' }, { key: 'expected_cash', label: 'Expected' },
            { key: 'counted_cash', label: 'Counted' }, { key: 'variance', label: 'Variance' },
            { key: 'variance_reason', label: 'Reason' }, { key: 'status', label: 'Status' },
          ],
        });
      } catch (err) { ui.apiError(err); }
    }

    // ----------------------------------------------------------- open/close
    function openTill() {
      const form = ui.h('div', {});
      form.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Opening float (₦)', name: 'opening_cash', type: 'number', step: '0.01', min: '0', required: true, hint: 'The cash you are starting with — change money, not today\'s takings.' }),
        ui.field({ label: 'Take the float from the safe', name: 'from_safe', type: 'checkbox', value: 0, hint: 'Records a matching payout from the branch safe so the two balances agree.' }),
        ui.field({ label: 'Note', name: 'notes', span: true, placeholder: 'e.g. second drawer for the showroom' })));

      const cancel = ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel');
      const go = ui.h('button', { class: 'btn btn-primary' }, 'Open the till');
      const m = ui.openModal({ title: 'Open a till', body: form, footer: [cancel, go], size: 'narrow' });

      go.addEventListener('click', async () => {
        const v = ui.readForm(form);
        if (v.opening_cash === null) { ui.warn('Enter the float you are starting with.'); return; }
        await ui.withBusy(form, async () => {
          try {
            const res = await SR.api.post('/api/tills/open', {
              body: {
                opening_cash: Number(v.opening_cash) || 0,
                from_safe: Number(v.from_safe) ? true : undefined,
                notes: v.notes || undefined,
                branch_id: SR.state.activeBranchId,
              },
              idempotencyKey: SR.util.localId('till-open'),
            });
            m.close();
            ui.ok(res.message || 'Till opened.');
            load();
          } catch (err) { ui.apiError(err); }
        });
      });
    }

    function closeTill(t) {
      const expected = U.round2(Number(t.opening_cash || 0) + Number(t.cash_sales_total || 0) - Number(t.refund_total || 0));
      const form = ui.h('div', {});
      const varianceLine = ui.h('div', { class: 'alert alert-info' }, 'Count the drawer and type what is actually there. The variance appears here before you save.');
      form.appendChild(ui.h('div', { class: 'kpis' },
        ui.kpi({ label: 'Expected', value: U.money(expected) }),
        ui.kpi({ label: 'Cash sales', value: U.money(t.cash_sales_total) }),
        ui.kpi({ label: 'Refunds', value: U.money(t.refund_total) })));
      const counted = ui.field({ label: 'Cash counted (₦)', name: 'counted_cash', type: 'number', step: '0.01', min: '0', required: true });
      form.appendChild(ui.h('div', { class: 'form-grid' },
        counted,
        ui.field({ label: 'Bank part of it now (₦)', name: 'bank_amount', type: 'number', step: '0.01', min: '0', hint: 'Records a banking entry and the deposit-slip reference.' }),
        ui.field({ label: 'Bank reference', name: 'bank_reference', placeholder: 'slip / teller number' }),
        ui.field({ label: 'Leave in the safe (₦)', name: 'to_safe', type: 'number', step: '0.01', min: '0', hint: 'Moves cash from the drawer into the branch safe without going to the bank.' }),
        ui.field({ label: 'Explain any difference', name: 'variance_reason', span: true, type: 'textarea', hint: 'Required when the count does not match — a shortage nobody explains is a shortage nobody can fix.' })));
      form.appendChild(varianceLine);

      const input = counted.querySelector('input');
      function recompute() {
        const v = input.value === '' ? null : Number(input.value);
        if (v === null || Number.isNaN(v)) { varianceLine.className = 'alert alert-info'; varianceLine.textContent = 'Count the drawer and type what is actually there.'; return; }
        const diff = U.round2(v - expected);
        if (Math.abs(diff) < 0.5) { varianceLine.className = 'alert alert-ok'; varianceLine.textContent = `The count matches the books exactly (${U.money(v)}).`; return; }
        varianceLine.className = diff < 0 ? 'alert alert-danger' : 'alert alert-warn';
        varianceLine.textContent = diff < 0
          ? `Short by ${U.money(Math.abs(diff))}. The reason above is required, and a manager will see this.`
          : `Over by ${U.money(diff)}. Overages are investigated too — a drawer that is over usually means a sale was not recorded.`;
      }
      input.addEventListener('input', recompute);

      const cancel = ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel');
      const go = ui.h('button', { class: 'btn btn-primary' }, 'Close the till');
      const m = ui.openModal({ title: 'Close and count the till', body: form, footer: [cancel, go], size: 'wide' });

      go.addEventListener('click', async () => {
        const v = ui.readForm(form);
        if (v.counted_cash === null) { ui.warn('Enter the cash you counted. Closing without a count records no variance.'); return; }
        const diff = U.round2(Number(v.counted_cash) - expected);
        if (Math.abs(diff) >= 0.5 && !String(v.variance_reason || '').trim()) {
          ui.warn('Explain the difference before closing — one sentence is enough.');
          form.querySelector('[name="variance_reason"]').focus();
          return;
        }
        await ui.withBusy(form, async () => {
          try {
            const res = await SR.api.post(`/api/tills/${encodeURIComponent(t.id)}/close`, {
              body: {
                counted_cash: Number(v.counted_cash),
                variance_reason: v.variance_reason || undefined,
                bank_amount: v.bank_amount === null ? undefined : Number(v.bank_amount),
                bank_reference: v.bank_reference || undefined,
                to_safe: v.to_safe === null ? undefined : Number(v.to_safe),
              },
            });
            m.close();
            const payload = res && (res.message || res);
            ui.ok(typeof payload === 'string' ? payload : 'Till closed and counted.');
            SR.app.navigate(`/tills/${encodeURIComponent(t.id)}`);
          } catch (err) { ui.apiError(err); }
        });
      });
    }

    // ----------------------------------------------------------- safe entry
    function openSafeEntry() {
      const form = ui.h('div', {});
      form.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'What happened', name: 'entry_type', options: SAFE_ENTRY_TYPES, required: true }),
        ui.field({ label: 'Amount (₦)', name: 'amount', type: 'number', step: '0.01', min: '0.01', required: true }),
        ui.field({ label: 'Reason', name: 'reason', options: PAYOUT_REASONS.map((r) => ({ value: r, label: U.humanise(r) })) }),
        ui.field({ label: 'Reference', name: 'reference', placeholder: 'slip / teller / voucher number' }),
        ui.field({
          label: 'Note',
          name: 'note',
          span: true,
          type: 'textarea',
          hint: 'Required when money leaves the safe. The safe is an append-only ledger — the note is what the next person reading it will rely on.',
        })));
      form.appendChild(ui.h('div', { class: 'hint' }, 'The safe balance is a running derivation from its rows, so a mistake is corrected with an ADJUSTMENT entry rather than by editing history.'));

      const cancel = ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel');
      const go = ui.h('button', { class: 'btn btn-primary' }, 'Post the entry');
      const m = ui.openModal({ title: 'Branch safe', body: form, footer: [cancel, go], size: 'narrow' });

      go.addEventListener('click', async () => {
        const v = ui.readForm(form);
        if (!v.amount) { ui.warn('Enter the amount.'); return; }
        const outgoing = ['WITHDRAWAL', 'EXPENSE', 'BANKING'].includes(String(v.entry_type));
        await ui.withBusy(form, async () => {
          try {
            const res = await SR.api.post('/api/safe/entries', {
              body: {
                entry_type: v.entry_type,
                amount: Number(v.amount),
                outgoing,
                reason: v.reason || undefined,
                reference: v.reference || undefined,
                note: v.note || undefined,
                branch_id: SR.state.activeBranchId,
              },
              idempotencyKey: SR.util.localId('safe'),
            });
            m.close();
            ui.ok(res.message || `Safe balance is now ${U.money(res.balanceAfter)}.`);
            load();
          } catch (err) { ui.apiError(err); }
        });
      });
    }

    wrap.appendChild(ui.html('<style>' +
      '.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}' +
      '.grow{flex:1;min-width:0}' +
      '.kpi-label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;opacity:.65;margin-bottom:2px}' +
      '.kpi-value{font-size:19px;font-weight:650}' +
      '.kpi-foot{font-size:11px;opacity:.62;margin-top:2px}' +
      '.kpi.tone-good .kpi-value{color:#1a7f37}.kpi.tone-warn .kpi-value{color:#a15c00}' +
      '.kpi.tone-bad .kpi-value{color:#b42318}.kpi.tone-info .kpi-value{color:#0b5cad}' +
      '</style>'));

    await load();
    ctx.onCleanup(() => {});
    return wrap;
  }

  // =====================================================================
  // One till: the sheet a manager signs off
  // =====================================================================
  async function renderDetail(ctx) {
    ctx.setTitle('Till');
    const id = ctx.params.id;
    const wrap = ui.h('div', { class: 'stack' });
    const host = ui.h('div', {});
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {}, ui.h('h1', {}, 'Till sheet')),
      ui.h('div', { class: 'actions' }, ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate('/till') }, 'All tills'))));
    wrap.appendChild(host);

    async function load() {
      host.replaceChildren(ui.skeleton(8));
      let data;
      try {
        data = await SR.api.get(`/api/tills/${encodeURIComponent(id)}`, { query: SR.state.query({}) });
      } catch (err) {
        if (err.isOffline) {
          const t = await SR.store.get('till_sessions', id);
          if (!t) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: load } })); return; }
          renderReadOnly(t);
          return;
        }
        host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: load } }));
        return;
      }
      render(data);
    }

    function renderReadOnly(t) {
      host.replaceChildren(ui.h('div', { class: 'stack' },
        ui.h('div', { class: 'alert alert-warn' }, 'Offline — showing the session as this device last mirrored it. The reconciliation below is not recomputed.'),
        ui.dataCard({
          title: `Till ${String(t.id).slice(0, 8)}`,
          table: ui.kv([
            ['Status', ui.statusBadge(t.status)],
            ['Opened', U.dateTime(t.opened_at)],
            ['Float', U.money(t.opening_cash)],
            ['Cash sales', U.money(t.cash_sales_total)],
            ['Counted', t.counted_cash == null ? '—' : U.money(t.counted_cash)],
            ['Variance', t.variance == null ? '—' : U.money(t.variance)],
          ]),
        })));
    }

    function render(data) {
      const t = data.till || {};
      const r = data.reconciliation || {};
      const closed = String(t.status) === 'CLOSED';
      const variance = Number(r.variance || 0);

      const head = ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' },
        ui.h('div', { class: 'row' },
          ui.h('div', { class: 'grow' },
            ui.h('h2', {}, `${t.cashier_name || 'Till'} · ${t.branch_name || ''}`),
            ui.h('p', { class: 'sub' }, `Opened ${U.dateTime(t.opened_at)}${t.closed_at ? ` · closed ${U.dateTime(t.closed_at)}` : ''}${t.device_id ? ` · ${t.device_id}` : ''}`)),
          ui.h('div', { class: 'actions' },
            ui.statusBadge(t.status),
            r.reviewed ? ui.badge('reviewed', 'badge-good') : null,
            !closed && String(t.user_id) === String(SR.state.user.id) ? ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => SR.app.navigate('/till') }, 'Close it from the list') : null,
            closed && SR.state.atLeast('MANAGER') && !r.reviewed ? ui.h('button', { class: 'btn btn-sm', onClick: () => review(t, r) }, 'Review the variance') : null)),
        ui.h('div', { class: 'kpis' },
          ui.kpi({ label: 'Expected in the drawer', value: U.money(r.expectedCash), foot: `${U.money(r.openingCash)} float + ${U.money(r.cashSales)} cash − ${U.money(r.refunds)} refunds` }),
          ui.kpi({ label: 'Counted by the cashier', value: closed ? U.money(r.countedCash) : 'Not closed yet' }),
          ui.kpi({
            label: closed ? 'Variance' : 'Variance so far',
            value: U.money(variance),
            tone: Math.abs(variance) < 0.5 ? 'good' : (variance < 0 ? 'bad' : 'warn'),
            foot: Math.abs(variance) < 0.5 ? 'the count matched the books' : (variance < 0 ? 'short — money is missing' : 'over — a sale may be unrecorded'),
          }),
          ui.kpi({ label: 'Sales on this sheet', value: U.qty((data.sales || []).length), foot: t.bank_amount ? `banked ${U.money(t.bank_amount)}` : null }))));

      const stack = ui.h('div', { class: 'stack' }, head);

      if (r.varianceReason) {
        stack.appendChild(ui.h('div', { class: 'alert alert-warn' }, `Difference explained as: ${r.varianceReason}`));
      }

      stack.appendChild(ui.dataCard({
        title: 'Where the money came from',
        table: ui.renderTable({
          columns: [
            { key: 'method', label: 'Method', render: (m) => U.humanise(m.payment_method || m.method || m.paymentMethod) },
            { key: 'txns', label: 'Transactions', align: 'right', render: (m) => U.qty(m.count || m.txns || 0) },
            { key: 'amount', label: 'Amount', align: 'right', render: (m) => U.money(m.total || m.amount) },
          ],
          rows: data.byMethod || [],
          emptyTitle: 'No takings yet',
          emptyMessage: 'Payments appear here as sales are rung up.',
        }),
      }));

      if ((data.sales || []).length) {
        stack.appendChild(ui.dataCard({
          title: 'Sales on this sheet',
          table: ui.renderTable({
            columns: [
              { key: 'receipt_no', label: 'Receipt' },
              { key: 'sold_at', label: 'Time', render: (s) => U.time(s.sold_at) },
              { key: 'customer_name', label: 'Customer', render: (s) => s.customer_name || 'Walk-in' },
              { key: 'total', label: 'Total', align: 'right', render: (s) => U.money(s.total) },
              { key: 'payment_method', label: 'Paid by', render: (s) => U.humanise(s.payment_method || '—') },
              { key: 'status', label: 'Status', render: (s) => ui.statusBadge(s.status) },
            ],
            rows: data.sales.slice(0, 60),
            onRowClick: (s) => SR.app.navigate(`/sales/${encodeURIComponent(s.id)}`),
          }),
        }));
      }

      if ((data.latePostings || []).length) {
        stack.appendChild(ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' },
          ui.h('h2', {}, 'Posted after the count'),
          ui.h('p', { class: 'sub' }, 'These sales were recorded on another device after this drawer was counted. They are in the books — they are deliberately NOT in this session\'s totals, because the cash count that was signed off was of the drawer as it stood.'),
          ui.renderTable({
            columns: [
              { key: 'receipt_no', label: 'Receipt' },
              { key: 'sold_at', label: 'Sold', render: (s) => U.dateTime(s.sold_at) },
              { key: 'total', label: 'Total', align: 'right', render: (s) => U.money(s.total) },
            ],
            rows: data.latePostings,
          }))));
      }

      if ((data.voids || []).length) {
        stack.appendChild(ui.dataCard({
          title: 'Voids on this sheet',
          table: ui.renderTable({
            columns: [
              { key: 'receipt_no', label: 'Receipt' },
              { key: 'voided_at', label: 'Voided', render: (s) => U.dateTime(s.voided_at || s.updated_at) },
              { key: 'total', label: 'Value', align: 'right', render: (s) => U.money(s.total) },
              { key: 'void_reason', label: 'Reason', render: (s) => s.void_reason || '—' },
            ],
            rows: data.voids,
          }),
        }));
      }

      host.replaceChildren(stack);
    }

    async function review(t, r) {
      const form = ui.h('div', {});
      form.appendChild(ui.h('div', { class: 'kpis' },
        ui.kpi({ label: 'Expected', value: U.money(r.expectedCash) }),
        ui.kpi({ label: 'Counted', value: U.money(r.countedCash) }),
        ui.kpi({ label: 'Variance', value: U.money(r.variance), tone: Number(r.variance) < 0 ? 'bad' : 'warn' })));
      form.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Note', name: 'note', span: true, type: 'textarea', hint: 'Required if you reject the count. Say what you found, what you were told, and what happens next.' })));

      const reject = ui.h('button', { class: 'btn btn-danger' }, 'Reject');
      const accept = ui.h('button', { class: 'btn btn-primary' }, 'Accept the count');
      const m = ui.openModal({ title: 'Review the variance', body: form, footer: [reject, accept], size: 'narrow' });

      async function send(accepted) {
        const v = ui.readFormStrings(form);
        if (!accepted && !(v.note || '').trim()) { ui.warn('Say why the count is being rejected.'); return; }
        await ui.withBusy(form, async () => {
          try {
            const res = await SR.api.post(`/api/tills/${encodeURIComponent(t.id)}/review`, { body: { accepted, note: v.note || undefined } });
            m.close();
            ui.ok(res.message || 'Recorded.');
            load();
          } catch (err) { ui.apiError(err); }
        });
      }
      reject.addEventListener('click', () => send(false));
      accept.addEventListener('click', () => send(true));
    }

    await load();
    return wrap;
  }

  SR.views = SR.views || {};
  SR.views.till = { render };
}(window));
