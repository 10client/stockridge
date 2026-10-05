'use strict';
// =====================================================================
// public/js/views/stocktake.js — COUNTING THE SHELF
// =====================================================================
// A stocktake in an appliance shop is not a formality. Between the freezer that
// left on credit without a receipt and the generator a customer returned twice,
// the shelf and the system disagree by real money — and the difference lands on
// whoever is standing at the counter.
//
// THREE THINGS THIS SCREEN DOES THAT A NAIVE ONE DOES NOT
//
//   1. IT COUNTS A FROZEN NUMBER. The system quantity is captured when the count
//      opens and never moves while counting. If the live figure were used, every
//      sale rung up during the count would create a phantom shortage, and the
//      commit would adjust stock that was never missing.
//
//   2. IT WILL NOT COMMIT A HALF-FINISHED SHEET. Committing a part-counted
//      stocktake would write off everything nobody reached. The route refuses it
//      unless the person explicitly says "commit what I have", and this screen
//      asks in those words.
//
//   3. IT SHOWS THE MONEY, not just the units. Ten missing phone cases and one
//      missing freezer are the same number of units and nothing alike: the line
//      shows the variance VALUE at cost, and the header shows the total.
//
// Only a manager or above can open or commit. Anyone can count — the counting
// screen is the one a cashier uses with a clipboard.
// =====================================================================
(function (global) {
  const SR = global.SR;
  const ui = SR.ui;
  const U = SR.util;

  const STATUS_TONES = {
    OPEN: 'badge-info', COUNTING: 'badge-warn', COMMITTED: 'badge-ok', CANCELLED: 'badge-muted',
  };

  async function render(ctx) {
    if (ctx.params.id) return renderSession(ctx, ctx.params.id);
    return renderList(ctx);
  }

  // -------------------------------------------------------------------
  // LIST
  // -------------------------------------------------------------------
  async function renderList(ctx) {
    ctx.setTitle('Stocktake');
    const state = { page: 0, pageSize: 25, status: ctx.query.status || '' };

    const wrap = ui.h('div', { class: 'stack' });
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Stocktake'),
        ui.h('p', { class: 'sub' }, 'Count the shelf against the record. Variances post as adjustments and the books follow.')),
      ui.h('div', { class: 'actions' },
        ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => openNew() }, 'Start a stocktake'))));

    const statusSelect = ui.h('select', {
      onChange: () => { state.status = statusSelect.value; state.page = 0; load(); },
    },
    ui.h('option', { value: '' }, 'Any status'),
    ...[['OPEN', 'Open'], ['COUNTING', 'Being counted'], ['COMMITTED', 'Committed'], ['CANCELLED', 'Cancelled']]
      .map(([v, l]) => ui.h('option', { value: v }, l)));
    statusSelect.value = state.status;

    const host = ui.h('div', {});
    wrap.appendChild(host);

    async function load() {
      host.replaceChildren(ui.skeleton(5));
      let data;
      try {
        data = await SR.api.get('/api/stocktakes', {
          query: SR.state.query({ status: state.status || undefined, limit: state.pageSize, offset: state.page * state.pageSize }),
        });
      } catch (err) {
        host.replaceChildren();
        host.appendChild(ui.errorBlock(err, { retry: { label: 'Try again', run: load } }));
        return;
      }
      const rows = data.data || [];
      const paging = data.paging || {};

      host.replaceChildren();
      host.appendChild(ui.dataCard({
        title: 'Stocktakes',
        toolbar: ui.h('label', { class: 'inline-field' }, ui.h('span', {}, 'Status'), statusSelect),
        table: ui.renderTable({
          columns: [
            { key: 'reference', label: 'Reference', render: (s) => ui.h('strong', {}, s.reference || s.id.slice(0, 8)) },
            { key: 'branch_name', label: 'Branch' },
            { key: 'scope', label: 'Scope', render: (s) => ui.badge(U.humanise(s.scope), 'badge-info') },
            { key: 'status', label: 'Status', render: (s) => ui.badge(U.humanise(s.status), STATUS_TONES[s.status] || 'badge-muted') },
            { key: 'opened_at', label: 'Opened', render: (s) => `${U.dateTime(s.opened_at)}` },
            { key: 'opened_by_name', label: 'By', render: (s) => s.opened_by_name || '—' },
            { key: 'line_count', label: 'Lines', align: 'right', render: (s) => Number(s.line_count || 0).toLocaleString('en-NG') },
            { key: 'variance_count', label: 'With variance', align: 'right', render: (s) => {
              const n = Number(s.variance_count || 0);
              return n ? ui.h('strong', { style: { color: 'var(--amber-700)' } }, String(n)) : '—';
            } },
            { key: 'total_variance_value', label: 'Value adjusted', align: 'right', render: (s) => (s.total_variance_value != null ? U.money(s.total_variance_value) : '—') },
            { key: 'x', label: '', render: (s) => ui.h('button', {
              class: 'btn btn-sm', onClick: (ev) => { ev.stopPropagation(); SR.app.navigate(`/stocktakes/${s.id}`); },
            }, s.status === 'COMMITTED' ? 'Review' : 'Count') },
          ],
          rows,
          onRowClick: (s) => SR.app.navigate(`/stocktakes/${s.id}`),
          emptyTitle: 'No stocktakes yet',
          emptyMessage: 'A stocktake freezes the system quantity for every batch, then compares it with what is actually on the shelf.',
          emptyAction: SR.state.atLeast('MANAGER') ? { label: 'Start a stocktake', run: () => openNew() } : null,
        }),
        pager: ui.pager({
          page: state.page, pageSize: state.pageSize, total: Number(paging.total || rows.length),
          onPage: (p) => { state.page = p; load(); },
        }),
      }));
    }

    // ---------------------------------------------------------------
    // OPEN A COUNT
    // ---------------------------------------------------------------
    function openNew() {
      if (!SR.state.atLeast('MANAGER')) { ui.warn('Only a manager or above can open a stocktake.'); return; }
      const scopeSelect = ui.h('select', {},
        ui.h('option', { value: 'FULL' }, 'Every batch at this branch'),
        ui.h('option', { value: 'CATEGORY' }, 'One category'),
        ui.h('option', { value: 'ZONE' }, 'One warehouse zone'),
        ui.h('option', { value: 'PRODUCT' }, 'A single product'));
      const categoryWrap = ui.h('div', { hidden: true });
      const zoneInput = ui.h('input', { type: 'text', placeholder: 'e.g. A1, showroom, back store' });
      const zoneWrap = ui.h('label', { class: 'field', hidden: true }, ui.h('span', {}, 'Zone'), zoneInput);
      const referenceInput = ui.h('input', { type: 'text', placeholder: 'Automatic if left blank' });
      const notesInput = ui.h('textarea', { rows: 2, placeholder: 'Why this count, and who is counting' });

      // The category picker is loaded lazily and only when it is needed: a full
      // count is the common case and should not wait on a catalogue request.
      let categoriesLoaded = false;
      scopeSelect.addEventListener('change', async () => {
        const v = scopeSelect.value;
        zoneWrap.hidden = v !== 'ZONE';
        categoryWrap.hidden = v !== 'CATEGORY';
        if (v === 'CATEGORY' && !categoriesLoaded) {
          categoriesLoaded = true;
          categoryWrap.replaceChildren(ui.loading('Loading categories…'));
          try {
            const res = await SR.api.get('/api/categories', { query: SR.state.query({ limit: 300 }) });
            const select = ui.h('select', {}, ...[{ id: '', name: 'Choose a category' }].concat(res.data || [])
              .map((c) => ui.h('option', { value: c.id || '' }, c.name || String(c))));
            select.id = 'stocktake-category';
            categoryWrap.replaceChildren(ui.h('label', { class: 'field' }, ui.h('span', {}, 'Category'), select));
          } catch (err) {
            categoryWrap.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: () => { categoriesLoaded = false; scopeSelect.dispatchEvent(new Event('change')); } } }));
          }
        }
      });

      const body = ui.h('div', { class: 'stack' },
        ui.h('label', { class: 'field' }, ui.h('span', {}, 'What are you counting'), scopeSelect),
        categoryWrap,
        zoneWrap,
        ui.h('label', { class: 'field' }, ui.h('span', {}, 'Reference'), referenceInput),
        ui.h('label', { class: 'field' }, ui.h('span', {}, 'Notes'), notesInput),
        ui.h('p', { class: 'hint' }, 'Every line is frozen at its system quantity the moment the count opens. Sales rung up during the count will not move those figures.'));

      const modal = ui.openModal({
        title: 'Start a stocktake',
        body,
        footer: [
          ui.h('button', { class: 'btn', onClick: () => modal.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: (ev) => ui.withBusy(ev.currentTarget, async () => {
              const payload = {
                branch_id: SR.state.activeBranchId,
                scope: scopeSelect.value,
                reference: referenceInput.value.trim() || undefined,
                notes: notesInput.value.trim() || undefined,
              };
              if (scopeSelect.value === 'CATEGORY') {
                const select = document.getElementById('stocktake-category');
                if (!select || !select.value) { ui.warn('Choose the category to count.'); return; }
                payload.category_id = select.value;
              }
              if (scopeSelect.value === 'ZONE') {
                if (!zoneInput.value.trim()) { ui.warn('Type the zone name, e.g. A1.'); return; }
                payload.zone = zoneInput.value.trim();
              }
              try {
                const res = await SR.api.post('/api/stocktakes', payload);
                modal.close();
                ui.ok(res.message || 'Stocktake opened.');
                SR.app.navigate(`/stocktakes/${res.id}`);
              } catch (err) { ui.apiError(err); }
            }),
          }, 'Open the count'),
        ],
      });
    }

    wrap.appendChild(host);
    await load();
    return wrap;
  }

  // -------------------------------------------------------------------
  // ONE STOCKTAKE
  // -------------------------------------------------------------------
  async function renderSession(ctx, id) {
    ctx.setTitle('Stocktake');

    const wrap = ui.h('div', { class: 'stack' });
    const host = ui.h('div', {});
    wrap.appendChild(host);

    async function load() {
      host.replaceChildren(ui.skeleton(6));
      let res;
      try {
        res = await SR.api.get(`/api/stocktakes/${encodeURIComponent(id)}`);
      } catch (err) {
        host.replaceChildren();
        host.appendChild(ui.errorBlock(err, { retry: { label: 'Try again', run: load } }));
        return;
      }
      const session = res.session || {};
      const lines = res.lines || [];
      const summary = res.summary || {};
      ctx.setTitle(session.reference || 'Stocktake');

      const committed = session.status === 'COMMITTED';
      const canManage = SR.state.atLeast('MANAGER');

      // Counts typed but not yet sent. Kept as strings so a half-typed "12." is
      // never turned into a number and posted.
      const pending = new Map();
      const rowsHost = ui.h('div', {});

      const search = ui.h('input', { type: 'search', placeholder: 'Find a line by product, SKU or batch…', style: { minWidth: '220px' } });
      const varianceOnly = ui.h('input', { type: 'checkbox' });
      const filterBar = ui.h('div', { class: 'row-tight' },
        ui.h('label', { class: 'inline-field' }, ui.h('span', {}, 'Only differences'), varianceOnly));

      function visibleLines() {
        const needle = search.value.trim().toLowerCase();
        return lines.filter((l) => {
          if (varianceOnly.checked && !(Number(l.variance) !== 0 || (pending.has(l.id) && Number(pending.get(l.id)) !== Number(l.system_qty)))) return false;
          if (!needle) return true;
          return `${l.product_name || ''} ${l.sku || ''} ${l.batch_no || ''} ${l.variant_name || ''}`.toLowerCase().includes(needle);
        });
      }

      function paintRows() {
        const shown = visibleLines();
        rowsHost.replaceChildren(ui.renderTable({
          columns: [
            { key: 'product_name', label: 'Product', className: 'wrap', render: (l) => {
              const cell = ui.h('div', {});
              cell.appendChild(ui.h('div', { style: { fontWeight: '600' } }, l.product_name || '—'));
              cell.appendChild(ui.h('div', { class: 'hint' }, [l.variant_name, l.sku, l.batch_no ? `batch ${l.batch_no}` : null].filter(Boolean).join(' · ')));
              return cell;
            } },
            { key: 'system_qty', label: 'System says', align: 'right', render: (l) => U.qty(l.system_qty) },
            { key: 'counted', label: 'Counted', align: 'right', render: (l) => {
              if (committed) return l.counted_qty == null ? ui.h('span', { class: 'hint' }, 'not counted') : U.qty(l.counted_qty);
              const input = ui.h('input', {
                type: 'number', step: '0.0001', min: '0', inputmode: 'decimal',
                style: { width: '110px', textAlign: 'right' },
                placeholder: l.counted_qty == null ? '' : String(l.counted_qty),
              });
              input.value = pending.has(l.id) ? pending.get(l.id) : (l.counted_qty == null ? '' : String(l.counted_qty));
              input.addEventListener('input', () => {
                const v = input.value.trim();
                if (v === '') pending.delete(l.id); else pending.set(l.id, v);
                refreshFooter();
                paintVarianceCell(l.id);
              });
              return input;
            } },
            { key: 'variance', label: 'Difference', align: 'right', render: (l) => varianceCell(l) },
            { key: 'variance_value', label: 'Value at cost', align: 'right', render: (l) => (l.variance_value == null || Number(l.variance) === 0 ? '—' : U.money(l.variance_value)) },
          ],
          rows: shown,
          rowKey: (l) => l.id,
          emptyTitle: 'No lines',
          emptyMessage: lines.length ? 'No line matches that search.' : 'This count has no lines.',
        }));
      }

      function varianceCell(line) {
        const el = ui.h('span', {});
        const count = pending.has(line.id) ? pending.get(line.id) : line.counted_qty;
        if (count === '' || count == null) { el.appendChild(ui.h('span', { class: 'hint' }, '—')); return el; }
        const diff = U.round2(Number(count) - Number(line.system_qty));
        if (!diff) { el.appendChild(ui.h('span', { class: 'hint' }, 'no difference')); return el; }
        el.appendChild(ui.h('strong', { style: { color: diff < 0 ? 'var(--red-700)' : 'var(--green-700)' } },
          `${diff > 0 ? '+' : ''}${U.qty(diff)}`));
        return el;
      }

      function paintVarianceCell(lineId) {
        const line = lines.find((l) => String(l.id) === String(lineId));
        if (!line) return;
        const row = rowsHost.querySelector(`[data-row="${lineId}"]`);
        if (!row) return;
        const cells = row.querySelectorAll('td');
        const last = cells[cells.length - 2];
        if (last) last.replaceChildren(varianceCell(line));
      }

      const pendingBadge = ui.h('span', { class: 'hint' });
      const saveBtn = ui.h('button', {
        class: 'btn btn-primary btn-sm',
        onClick: (ev) => ui.withBusy(ev.currentTarget, async () => {
          const counts = [];
          for (const [lineId, value] of pending.entries()) {
            const n = Number(value);
            if (!Number.isFinite(n) || n < 0) { ui.warn(`"${value}" is not a quantity.`); return; }
            counts.push({ line_id: lineId, counted_qty: n });
          }
          if (!counts.length) { ui.warn('Type at least one count.'); return; }
          try {
            const res = await SR.api.post(`/api/stocktakes/${encodeURIComponent(id)}/counts`, { counts });
            ui.ok(res.message || 'Counts saved.');
            pending.clear();
            await load();
          } catch (err) { ui.apiError(err); }
        }),
      }, 'Save counts');
      const commitBtn = ui.h('button', {
        class: 'btn btn-sm',
        onClick: () => commitDialog(),
      }, 'Commit and adjust stock');

      function refreshFooter() {
        const n = pending.size;
        pendingBadge.textContent = n ? `${n} count(s) typed but not saved.` : '';
        saveBtn.disabled = n === 0;
      }

      search.addEventListener('input', U.debounce(() => paintRows(), 250));
      varianceOnly.addEventListener('change', () => paintRows());

      paintRows();
      refreshFooter();

      host.replaceChildren();

      // ---- header
      const head = ui.h('div', { class: 'page-head' },
        ui.h('div', {},
          ui.h('h1', {}, session.reference || 'Stocktake'),
          ui.h('p', { class: 'sub' }, [
            session.branch_name || '',
            `opened ${U.dateTime(session.opened_at)}`,
            session.opened_by_name ? `by ${session.opened_by_name}` : null,
            committed ? `committed ${U.dateTime(session.committed_at)}` : null,
          ].filter(Boolean).join(' · '))),
        ui.h('div', { class: 'actions' },
          ui.badge(U.humanise(session.status), STATUS_TONES[session.status] || 'badge-muted'),
          ui.h('button', { class: 'btn btn-sm', onClick: () => window.print() }, 'Print sheet'),
          committed || !canManage ? null : saveBtn,
          committed || !canManage ? null : commitBtn));
      host.appendChild(head);

      // ---- summary
      host.appendChild(ui.h('div', { class: 'kpi-grid' },
        ui.kpi({ label: 'Lines', value: Number(summary.lines || 0).toLocaleString('en-NG') }),
        ui.kpi({ label: 'Counted', value: Number(summary.counted || 0).toLocaleString('en-NG'), foot: `${Number(summary.outstanding || 0)} still to count` }),
        ui.kpi({ label: 'Lines with a difference', value: Number(summary.withVariance || 0).toLocaleString('en-NG'), tone: Number(summary.withVariance || 0) ? 'warn' : null }),
        ui.kpi({ label: 'Value at stake', value: U.money(summary.varianceValue || 0), foot: 'absolute value of every difference, at cost' })));

      if (committed) {
        host.appendChild(ui.h('div', { class: 'card' },
          ui.h('div', { class: 'card-body' },
            ui.h('p', {}, `This count was committed. ${Number(session.total_variance_value || 0).toLocaleString('en-NG')} naira of stock value was adjusted, and every variance is in the ledger as a COUNT_VARIANCE adjustment.`),
            ui.h('p', { class: 'hint' }, 'The counts below are the record. Nothing here can be edited — open a new count to recount.'))));
      }

      // ---- the sheet
      host.appendChild(ui.dataCard({
        title: 'The sheet',
        toolbar: ui.h('div', { class: 'row-tight' }, search, filterBar),
        table: rowsHost,
        actions: [ui.h('span', { class: 'hint' }, pendingBadge.textContent)],
      }));

      host.appendChild(ui.h('div', { class: 'card' },
        ui.h('div', { class: 'card-body' },
          ui.h('h3', {}, 'Why the system quantity does not move'),
          ui.h('p', {}, 'Each line was frozen at its system quantity when the count opened. A sale rung up while you are counting is a real sale — it must not appear here as a shortage, or committing this sheet would write off the difference a second time.'))));

      function commitDialog() {
        const uncounted = Number(summary.outstanding || 0);
        const accept = ui.h('input', { type: 'checkbox' });
        const body = ui.h('div', { class: 'stack' },
          ui.h('p', {}, `Committing posts every difference as a stock adjustment, corrects the batches, and posts the value to the ledger. This is the point of no return.`),
          uncounted ? ui.h('div', { class: 'alert alert-warn' },
            ui.h('strong', {}, `${uncounted} line(s) have not been counted.`),
            ui.h('p', {}, 'Committing now leaves those lines at their system quantity — which is exactly what you said they were.'),
            ui.h('label', { class: 'inline-field' }, accept, ui.h('span', {}, 'Yes, commit with those lines left as they are'))) : null,
          ui.h('p', { class: 'hint' }, 'Anything typed but not saved above is not included. Save the counts first.'),
          pending.size ? ui.h('div', { class: 'alert alert-warn' }, `${pending.size} typed count(s) are unsaved and will be ignored.`) : null);

        const modal = ui.openModal({
          title: 'Commit this stocktake',
          body,
          footer: [
            ui.h('button', { class: 'btn', onClick: () => modal.close() }, 'Not yet'),
            ui.h('button', {
              class: 'btn btn-danger',
              onClick: (ev) => ui.withBusy(ev.currentTarget, async () => {
                if (uncounted && !accept.checked) { ui.warn('Tick the box to confirm, or count the remaining lines first.'); return; }
                try {
                  const res = await SR.api.post(`/api/stocktakes/${encodeURIComponent(id)}/commit`,
                    uncounted ? { accept_uncounted: true } : {});
                  modal.close();
                  ui.ok(res.message || 'Committed.');
                  await load();
                } catch (err) { ui.apiError(err); }
              }),
            }, 'Commit and adjust'),
          ],
        });
      }
    }

    await load();
    return wrap;
  }

  SR.views.stocktake = { render };
}(window));
