'use strict';
// =====================================================================
// public/js/views/reports.js — THE EVIDENCE
// =====================================================================
// Six reports, one question each. They are collected on one screen because a
// shopkeeper does not think in report names; they think in questions:
//
//   "How much did we sell?"            → Sales
//   "What is sitting on the shelf?"    → Inventory movement
//   "What is not moving?"              → Fast & slow movers
//   "Who are our customers?"           → Top customers
//   "What do we owe the salespeople?"  → Commission
//   "Are we going to hit the target?"  → Targets
//
// Two numbers get explained in words rather than left to be misread:
//
//   * GROSS vs NET revenue. In Nigeria prices are VAT-inclusive, so the gross
//     figure contains tax that was never the business's money. Every revenue
//     figure here is shown net, with the VAT stated separately.
//   * MARGIN, not markup. Margin is measured against the selling price, which is
//     the number that matters when deciding whether a discount is affordable.
// =====================================================================
(function (global) {
  const SR = global.SR;
  const ui = SR.ui;
  const U = SR.util;

  const REPORTS = [
    ['sales', 'Sales', 'What was sold, by day, product, category, cashier or customer'],
    ['inventory-movement', 'Inventory movement', 'Stock in, stock out, and the value of what is left'],
    ['movers', 'Fast & slow movers', 'What sells, what does not, and what has been sitting since last year'],
    ['top-customers', 'Top customers', 'Who buys, how often, and how concentrated the business is'],
    ['commission', 'Commission', 'What each salesperson earned, on net revenue'],
    ['targets', 'Targets', 'Set a target and watch the period against it'],
  ];

  async function render(ctx) {
    ctx.setTitle('Reports');
    const state = {
      report: ctx.query.report || 'sales',
      from: ctx.query.from || U.addDays(U.todayWat(), -30),
      to: ctx.query.to || U.todayWat(),
      groupBy: ctx.query.group_by || 'day',
      kind: ctx.query.kind || 'FAST',
      days: ctx.query.days || 90,
      sort: ctx.query.sort || 'revenue',
      branchScope: ctx.query.branch_scope === '1',
    };

    const wrap = ui.h('div', { class: 'stack' });
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Reports'),
        ui.h('p', { class: 'sub' }, `${SR.state.activeBusinessName()} · figures derived from the ledger and the stock ledger, never typed in`)),
      ui.h('div', { class: 'actions' },
        ui.h('button', { class: 'btn btn-sm', onClick: () => exportCurrent() }, 'Download CSV'),
        ui.h('button', { class: 'btn btn-sm', onClick: () => printCurrent() }, 'Print'))));

    // ------------------------------------------------------------- picker
    const picker = ui.h('div', { class: 'report-picker' });
    for (const [key, label, blurb] of REPORTS) {
      picker.appendChild(ui.h('button', {
        class: `report-chip ${state.report === key ? 'is-active' : ''}`,
        onClick: () => { state.report = key; renderPicker(); load(); },
      }, ui.h('div', { class: 'chip-title' }, label), ui.h('div', { class: 'chip-blurb' }, blurb)));
    }
    wrap.appendChild(picker);
    function renderPicker() {
      [...picker.children].forEach((b, i) => b.classList.toggle('is-active', REPORTS[i][0] === state.report));
    }

    // ------------------------------------------------------------- toolbar
    const toolbar = ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body row' }));
    const fromInput = ui.h('input', { type: 'date', value: state.from });
    const toInput = ui.h('input', { type: 'date', value: state.to });
    fromInput.addEventListener('change', () => { state.from = fromInput.value; load(); });
    toInput.addEventListener('change', () => { state.to = toInput.value; load(); });
    toolbar.firstElementChild.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'From'), fromInput));
    toolbar.firstElementChild.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'To'), toInput));
    for (const [d, label] of [[7, '7 days'], [30, '30 days'], [90, 'Quarter'], [365, 'Year']]) {
      toolbar.firstElementChild.appendChild(ui.h('button', {
        class: 'btn btn-sm',
        onClick: () => {
          state.from = U.addDays(U.todayWat(), -d); state.to = U.todayWat();
          fromInput.value = state.from; toInput.value = state.to; load();
        },
      }, label));
    }
    const scopeToggle = ui.h('button', {
      class: `btn btn-sm ${state.branchScope ? 'btn-primary' : ''}`,
      onClick: (ev) => {
        state.branchScope = !state.branchScope;
        ev.currentTarget.className = `btn btn-sm ${state.branchScope ? 'btn-primary' : ''}`;
        ev.currentTarget.textContent = state.branchScope ? SR.state.activeBranchName() : 'All branches';
        load();
      },
    }, state.branchScope ? SR.state.activeBranchName() : 'All branches');
    toolbar.firstElementChild.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Scope'), scopeToggle));
    wrap.appendChild(toolbar);

    const host = ui.h('div', {});
    wrap.appendChild(host);

    let lastPayload = null;

    function scoped(extra) {
      return SR.state.query(Object.assign({
        from: state.from, to: state.to,
        branch_scope: state.branchScope ? SR.state.activeBranchId : undefined,
      }, extra || {}));
    }

    async function load() {
      host.replaceChildren(ui.skeleton(8));
      try {
        if (state.report === 'sales') {
          const data = await SR.api.get('/api/reports/sales', { query: scoped({ group_by: state.groupBy }) });
          lastPayload = data; renderSales(data);
        } else if (state.report === 'inventory-movement') {
          const data = await SR.api.get('/api/reports/inventory-movement', { query: scoped({ sort: state.sort }) });
          lastPayload = data; renderInventory(data);
        } else if (state.report === 'movers') {
          const data = await SR.api.get('/api/reports/movers', { query: scoped({ kind: state.kind, days: state.days }) });
          lastPayload = data; renderMovers(data);
        } else if (state.report === 'top-customers') {
          const data = await SR.api.get('/api/reports/top-customers', { query: scoped({}) });
          lastPayload = data; renderTopCustomers(data);
        } else if (state.report === 'commission') {
          const data = await SR.api.get('/api/reports/commission', { query: scoped({}) });
          lastPayload = data; renderCommission(data);
        } else {
          const data = await SR.api.get('/api/reports/targets', { query: SR.state.query({}) });
          lastPayload = data; renderTargets(data);
        }
      } catch (err) {
        if (err.isOffline) {
          host.replaceChildren(ui.h('div', { class: 'alert alert-warn' },
            'Reports are computed by the server from the whole period. Offline, this screen has no figures to show — open Sync & offline to see what is waiting to be uploaded, and try again once you are connected.'));
          return;
        }
        host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: load } }));
      }
    }

    // ------------------------------------------------------------- sales
    function renderSales(data) {
      const t = data.totals || {};
      const groupSel = ui.h('select', {
        onchange: (e) => { state.groupBy = e.target.value; load(); },
      });
      for (const g of ['day', 'week', 'month', 'product', 'category', 'user', 'customer', 'branch']) {
        groupSel.appendChild(ui.h('option', { value: g, selected: g === state.groupBy }, `By ${g}`));
      }

      const rows = data.rows || [];
      const columns = [
        { key: 'label', label: U.titleCase(state.groupBy === 'day' || state.groupBy === 'week' || state.groupBy === 'month' ? 'Period' : state.groupBy) },
        { key: 'transactions', label: 'Sales', align: 'right', render: (r) => U.qty(r.transactions || r.count || 0) },
        { key: 'units', label: 'Units', align: 'right', render: (r) => U.qty(r.units) },
        { key: 'gross_revenue', label: 'Gross (with VAT)', align: 'right', render: (r) => U.money(r.gross_revenue || r.revenue) },
        { key: 'vat', label: 'VAT in it', align: 'right', render: (r) => U.money(r.vat) },
        { key: 'net_revenue', label: 'Net revenue', align: 'right', render: (r) => U.money(r.net_revenue) },
        { key: 'cogs', label: 'Cost of sales', align: 'right', render: (r) => U.money(r.cogs) },
        { key: 'discount', label: 'Discounts', align: 'right', render: (r) => U.money(r.discount) },
        {
          key: 'gross_margin',
          label: 'Margin',
          align: 'right',
          render: (r) => {
            const m = Number(r.gross_margin || 0);
            const pct = Number(r.gross_margin_pct || (Number(r.net_revenue) > 0 ? (m / Number(r.net_revenue)) * 100 : 0));
            return ui.h('span', {}, `${U.money(m)} `, ui.badge(`${U.round2(pct)}%`, pct >= 15 ? 'badge-good' : (pct > 0 ? 'badge-warn' : 'badge-bad')));
          },
        },
      ];

      host.replaceChildren(ui.h('div', { class: 'stack' },
        ui.h('div', { class: 'alert alert-info' }, data.note),
        ui.h('div', { class: 'kpis' },
          ui.kpi({ label: 'Net revenue', value: U.money(t.netRevenue), foot: 'what the business earned' }),
          ui.kpi({ label: 'VAT collected', value: U.money(t.vat), foot: 'held for FIRS, not revenue' }),
          ui.kpi({ label: 'Gross profit', value: U.money(t.grossMargin), tone: Number(t.grossMarginPct) >= 15 ? 'good' : 'warn', foot: `${U.round2(t.grossMarginPct || 0)}% margin` }),
          ui.kpi({ label: 'Sales', value: U.qty(t.transactions || 0), foot: `average ${U.money(Number(t.transactions) ? Number(t.netRevenue) / Number(t.transactions) : 0)}` }),
          ui.kpi({ label: 'Discounts given', value: U.money(t.discount), tone: Number(t.discount) > 0 ? 'warn' : null }),
          ui.kpi({ label: 'Voided', value: U.money((data.voided || {}).value), tone: Number((data.voided || {}).value) > 0 ? 'bad' : 'good', foot: `${U.qty((data.voided || {}).count)} sale(s)` })),
        ui.dataCard({
          title: 'Sales by ' + state.groupBy,
          toolbar: groupSel,
          table: ui.renderTable({ columns, rows, emptyTitle: 'Nothing sold in this period', emptyMessage: 'Pick a wider period, or check that sales are being recorded at this branch.' }),
        })));
    }

    // --------------------------------------------------------- inventory
    function renderInventory(data) {
      const t = data.totals || {};
      const sortSel = ui.h('select', { onchange: (e) => { state.sort = e.target.value; load(); } });
      for (const s of ['revenue', 'units_sold', 'stock_value', 'margin', 'name', 'adjustment_value']) {
        sortSel.appendChild(ui.h('option', { value: s, selected: s === state.sort }, `Sort by ${U.humanise(s)}`));
      }
      host.replaceChildren(ui.h('div', { class: 'stack' },
        ui.h('div', { class: 'kpis' },
          ui.kpi({ label: 'Stock at cost', value: U.money(t.stockValue) }),
          ui.kpi({ label: 'Revenue in period', value: U.money(t.revenue) }),
          ui.kpi({ label: 'Gross margin', value: U.money(t.grossMargin), tone: 'good' }),
          ui.kpi({ label: 'Written off / adjusted', value: U.money(t.shrinkageValue), tone: Number(t.shrinkageValue) > 0 ? 'bad' : 'good', foot: 'value lost to damage, theft or counting' }),
          ui.kpi({ label: 'Below reorder level', value: U.qty(t.lowStockCount || 0), tone: Number(t.lowStockCount) > 0 ? 'warn' : 'good' }),
          ui.kpi({ label: 'Out of stock', value: U.qty(t.outOfStockCount || 0), tone: Number(t.outOfStockCount) > 0 ? 'bad' : 'good' })),
        ui.dataCard({
          title: 'Product by product',
          toolbar: sortSel,
          table: ui.renderTable({
            columns: [
              { key: 'name', label: 'Product', render: (r) => ui.h('div', {}, ui.h('div', {}, r.name), ui.h('div', { class: 'hint' }, r.sku || '')) },
              { key: 'on_hand', label: 'On hand', align: 'right', render: (r) => `${U.qty(r.on_hand)} ${r.base_unit_name || ''}` },
              { key: 'reserved', label: 'Held', align: 'right', render: (r) => (Number(r.reserved) ? U.qty(r.reserved) : '—') },
              { key: 'units_sold', label: 'Sold', align: 'right', render: (r) => U.qty(r.units_sold) },
              { key: 'revenue', label: 'Revenue', align: 'right', render: (r) => U.money(r.revenue) },
              { key: 'gross_margin_pct', label: 'Margin', align: 'right', render: (r) => ui.badge(`${U.round2(r.gross_margin_pct)}%`, Number(r.gross_margin_pct) >= 15 ? 'badge-good' : (Number(r.gross_margin_pct) > 0 ? 'badge-warn' : 'badge-bad')) },
              { key: 'stock_value', label: 'Stock value', align: 'right', render: (r) => U.money(r.stock_value) },
              { key: 'net_adjusted', label: 'Adjusted', align: 'right', render: (r) => (Number(r.net_adjusted) ? U.qty(r.net_adjusted) : '—') },
              { key: 'low_stock', label: '', render: (r) => (r.out_of_stock ? ui.badge('out of stock', 'badge-bad') : (r.low_stock ? ui.badge('reorder', 'badge-warn') : null)) },
            ],
            rows: data.data || [],
            emptyTitle: 'No products yet',
            emptyMessage: 'Add products to the catalogue and this report fills itself in.',
          }),
        })));
    }

    // ------------------------------------------------------------- movers
    function renderMovers(data) {
      const rows = data.data || [];
      const tabBar = ui.h('div', { class: 'tabs' });
      for (const [k, label] of [['FAST', 'Fast movers'], ['SLOW', 'Slow movers'], ['DEAD', 'Not sold at all']]) {
        tabBar.appendChild(ui.h('button', {
          class: `tab ${state.kind === k ? 'is-active' : ''}`,
          onClick: (e) => {
            state.kind = k;
            for (const b of e.currentTarget.parentElement.children) b.classList.remove('is-active');
            e.currentTarget.classList.add('is-active');
            load();
          },
        }, label));
      }
      const isDead = state.kind === 'DEAD';
      host.replaceChildren(ui.h('div', { class: 'stack' },
        ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' }, tabBar)),
        ui.h('div', { class: 'alert alert-info' }, isDead
          ? `Nothing here has sold in ${state.days} days. That money is on a shelf, not in the bank — and in a Nigerian shop it is also the stock most likely to walk, spoil or go out of fashion while nobody is watching.`
          : 'Fast and slow are measured over the days you choose, against the stock actually on the shelf. A fast mover that is out of stock is a lost sale, not a strong product.'),
        ui.dataCard({
          title: isDead ? `No sales in ${state.days} days` : (state.kind === 'FAST' ? 'Selling fastest' : 'Selling slowest'),
          table: ui.renderTable({
            columns: [
              { key: 'name', label: 'Product', render: (r) => ui.h('div', {}, ui.h('div', {}, r.name), ui.h('div', { class: 'hint' }, r.sku || '')) },
              { key: 'units_sold', label: 'Units sold', align: 'right', render: (r) => U.qty(r.units_sold) },
              { key: 'revenue', label: 'Revenue', align: 'right', render: (r) => U.money(r.revenue) },
              { key: 'on_hand', label: 'On hand', align: 'right', render: (r) => U.qty(r.on_hand) },
              { key: 'last_sold', label: 'Last sold', render: (r) => (r.last_sold ? U.date(r.last_sold) : ui.badge('never', 'badge-bad')) },
              { key: 'reorder_level', label: 'Reorder at', align: 'right', render: (r) => U.qty(r.reorder_level) },
              {
                key: 'advice',
                label: 'What to do',
                render: (r) => {
                  if (state.kind === 'FAST' && Number(r.on_hand) <= Number(r.reorder_level)) return ui.badge('reorder now', 'badge-warn');
                  if (state.kind === 'DEAD') return ui.badge('discount or bundle', 'badge-info');
                  return '';
                },
              },
            ],
            rows,
            emptyTitle: isDead ? 'Everything on the shelf sells' : 'Not enough history yet',
            emptyMessage: isDead
              ? `Every product has moved in the last ${state.days} days. That is a good problem to have.`
              : 'Run a few weeks of sales and this report will separate the winners from the wallflowers.',
          }),
        })));
    }

    // ------------------------------------------------------ top customers
    function renderTopCustomers(data) {
      const c = data.concentration || {};
      host.replaceChildren(ui.h('div', { class: 'stack' },
        Number(c.top5Pct) >= 50
          ? ui.h('div', { class: 'alert alert-warn' },
            `The top five customers are ${U.round2(c.top5Pct)}% of revenue. Losing one of them would not be a bad month — it would be an event. Worth spreading the risk while things are good.`)
          : ui.h('div', { class: 'alert alert-ok' },
            `The top five customers are ${U.round2(c.top5Pct || 0)}% of revenue, so no single relationship carries the business.`),
        ui.dataCard({
          title: 'Who buys',
          table: ui.renderTable({
            columns: [
              { key: 'name', label: 'Customer', render: (r) => ui.h('div', {}, ui.h('div', {}, r.name || 'Walk-in'), ui.h('div', { class: 'hint' }, r.phone || '')) },
              { key: 'purchases', label: 'Purchases', align: 'right', render: (r) => U.qty(r.purchases) },
              { key: 'revenue', label: 'Revenue', align: 'right', render: (r) => U.money(r.revenue) },
              { key: 'averagePurchase', label: 'Average', align: 'right', render: (r) => U.money(r.averagePurchase) },
              { key: 'outstanding', label: 'Owing', align: 'right', render: (r) => (Number(r.outstanding) > 0 ? ui.badge(U.money(r.outstanding), 'badge-warn') : U.money(0)) },
              { key: 'last_purchase', label: 'Last bought', render: (r) => (r.last_purchase ? U.date(r.last_purchase) : '—') },
            ],
            rows: data.data || [],
            emptyTitle: 'No named customers yet',
            emptyMessage: 'A walk-in sale is fine, but a named customer is a customer you can sell to again — and one whose credit you can control.',
          }),
        })));
    }

    // --------------------------------------------------------- commission
    function renderCommission(data) {
      host.replaceChildren(ui.h('div', { class: 'stack' },
        ui.h('div', { class: 'alert alert-info' },
          'Commission is calculated on NET revenue — the money the business actually earned. Paying a percentage of the gross figure would be paying staff out of VAT that was never the business\'s to keep.'),
        ui.h('div', { class: 'kpis' },
          ui.kpi({ label: 'Commission earned', value: U.money((data.totals || {}).commission) }),
          ui.kpi({ label: 'Net revenue', value: U.money((data.totals || {}).revenue) })),
        ui.dataCard({
          title: 'By salesperson',
          table: ui.renderTable({
            columns: [
              { key: 'full_name', label: 'Salesperson', render: (r) => r.full_name || r.username || '—' },
              { key: 'sales', label: 'Sales', align: 'right', render: (r) => U.qty(r.sales) },
              { key: 'net_revenue', label: 'Net revenue', align: 'right', render: (r) => U.money(r.net_revenue) },
              { key: 'margin_generated', label: 'Margin generated', align: 'right', render: (r) => U.money(r.margin_generated) },
              { key: 'commission_rate_pct', label: 'Rate', align: 'right', render: (r) => `${r.commission_rate_pct || 0}%` },
              { key: 'commission', label: 'Commission', align: 'right', render: (r) => U.money(r.commission) },
              {
                key: 'void_rate_pct',
                label: 'Void rate',
                align: 'right',
                render: (r) => (Number(r.void_rate_pct) > 5
                  ? ui.badge(`${r.void_rate_pct}%`, 'badge-warn')
                  : `${U.round2(r.void_rate_pct)}%`),
              },
            ],
            rows: data.data || [],
            emptyTitle: 'No sales in this period',
            emptyMessage: 'Commission follows the sales recorded against each user.',
          }),
        })));
    }

    // ------------------------------------------------------------ targets
    function renderTargets(data) {
      const rows = data.data || [];
      const stack = ui.h('div', { class: 'stack' });
      if (SR.state.atLeast('OWNER')) {
        stack.appendChild(ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body row' },
          ui.h('div', { class: 'grow' },
            ui.h('h2', {}, 'Set a target'),
            ui.h('p', { class: 'sub' }, 'A target is a commitment. It appears on the dashboard for the branch it applies to, so the people selling can see the gap without asking.')),
          ui.h('button', { class: 'btn btn-primary', onClick: () => openTarget() }, 'Set a target'))));
      }
      stack.appendChild(ui.dataCard({
        title: `Targets as at ${data.asAt || U.todayWat()}`,
        table: ui.renderTable({
          columns: [
            { key: 'period_type', label: 'Period', render: (t) => U.humanise(t.period_type) },
            { key: 'period_start', label: 'From' },
            { key: 'period_end', label: 'To' },
            { key: 'branch_name', label: 'Branch', render: (t) => t.branch_name || 'Whole business' },
            { key: 'target_revenue', label: 'Target', align: 'right', render: (t) => U.money(t.target_revenue) },
            { key: 'actual_revenue', label: 'Achieved', align: 'right', render: (t) => U.money(t.actual_revenue || t.achieved || 0) },
            {
              key: 'pct',
              label: 'Progress',
              render: (t) => {
                const target = Number(t.target_revenue) || 0;
                const actual = Number(t.actual_revenue || t.achieved || 0);
                const pct = target > 0 ? U.round2((actual / target) * 100) : 0;
                const wrapBar = ui.h('div', { class: 'progress' });
                wrapBar.appendChild(ui.h('div', { class: `progress-fill ${pct >= 100 ? 'is-good' : (pct >= 60 ? '' : 'is-warn')}`, style: { width: `${U.clamp(pct, 0, 100)}%` } }));
                return ui.h('div', {}, wrapBar, ui.h('div', { class: 'hint' }, `${pct}% · ${U.money(Math.max(0, target - actual))} to go`));
              },
            },
          ],
          rows,
          emptyTitle: 'No targets set',
          emptyMessage: 'Without a target, the dashboard can only report what happened. A target is what makes it useful before month end.',
        }),
      }));
      host.replaceChildren(stack);
    }

    async function openTarget() {
      const form = ui.h('div', {});
      form.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Period type', name: 'period_type', options: ['DAILY', 'WEEKLY', 'MONTHLY'].map((p) => ({ value: p, label: U.humanise(p) })) }),
        ui.field({ label: 'Starts', name: 'period_start', type: 'date', value: U.todayWat(), required: true }),
        ui.field({ label: 'Ends', name: 'period_end', type: 'date', value: U.todayWat(), required: true }),
        ui.field({ label: 'Branch', name: 'branch_id', options: [{ value: '', label: 'Whole business' }].concat(SR.state.branches().map((b) => ({ value: b.id, label: b.name }))) }),
        ui.field({ label: 'Revenue target (₦)', name: 'target_revenue', type: 'number', step: '0.01', min: '0', required: true }),
        ui.field({ label: 'Unit target', name: 'target_units', type: 'number', step: '1', min: '0', hint: 'Optional. A revenue target met by discounting is not the same business as one met at full price.' }),
        ui.field({ label: 'Note', name: 'note', span: true })));
      const cancel = ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel');
      const go = ui.h('button', { class: 'btn btn-primary' }, 'Set the target');
      const m = ui.openModal({ title: 'Set a sales target', body: form, footer: [cancel, go], size: 'narrow' });
      go.addEventListener('click', async () => {
        const v = ui.readForm(form);
        await ui.withBusy(form, async () => {
          try {
            const res = await SR.api.post('/api/reports/targets', {
              period_type: v.period_type,
              period_start: v.period_start,
              period_end: v.period_end,
              branch_id: v.branch_id || undefined,
              target_revenue: Number(v.target_revenue) || 0,
              target_units: v.target_units === null ? undefined : Number(v.target_units),
              note: v.note || undefined,
            });
            m.close();
            ui.ok(res.message || 'Target set.');
            load();
          } catch (err) { ui.apiError(err); }
        });
      });
    }

    // ------------------------------------------------------- export/print
    async function exportCurrent() {
      try {
        if (state.report === 'sales') {
          await SR.exporter.list({
            filename: 'sales-report', path: '/api/reports/sales',
            query: scoped({ group_by: state.groupBy }),
            columns: [
              { key: 'label', label: 'Period' }, { key: 'transactions', label: 'Sales' },
              { key: 'units', label: 'Units' }, { key: 'gross_revenue', label: 'Gross' },
              { key: 'vat', label: 'VAT' }, { key: 'net_revenue', label: 'Net revenue' },
              { key: 'cogs', label: 'Cost of sales' }, { key: 'discount', label: 'Discount' },
              { key: 'gross_margin', label: 'Gross profit' },
            ],
          });
        } else if (state.report === 'inventory-movement') {
          await SR.exporter.list({
            filename: 'inventory-movement', path: '/api/reports/inventory-movement',
            query: scoped({ sort: state.sort }),
            columns: [
              { key: 'name', label: 'Product' }, { key: 'sku', label: 'SKU' },
              { key: 'on_hand', label: 'On hand' }, { key: 'units_sold', label: 'Sold' },
              { key: 'revenue', label: 'Revenue' }, { key: 'gross_margin', label: 'Margin' },
              { key: 'stock_value', label: 'Stock value' },
            ],
          });
        } else if (state.report === 'movers') {
          await SR.exporter.list({
            filename: `movers-${state.kind.toLowerCase()}`, path: '/api/reports/movers',
            query: scoped({ kind: state.kind, days: state.days }),
            columns: [{ key: 'name', label: 'Product' }, { key: 'units_sold', label: 'Units sold' }, { key: 'revenue', label: 'Revenue' }, { key: 'on_hand', label: 'On hand' }, { key: 'last_sold', label: 'Last sold' }],
          });
        } else if (state.report === 'top-customers') {
          await SR.exporter.list({
            filename: 'top-customers', path: '/api/reports/top-customers', query: scoped({}),
            columns: [{ key: 'name', label: 'Customer' }, { key: 'phone', label: 'Phone' }, { key: 'purchases', label: 'Purchases' }, { key: 'revenue', label: 'Revenue' }, { key: 'outstanding', label: 'Owing' }],
          });
        } else if (state.report === 'commission') {
          await SR.exporter.list({
            filename: 'commission', path: '/api/reports/commission', query: scoped({}),
            columns: [{ key: 'full_name', label: 'Salesperson' }, { key: 'sales', label: 'Sales' }, { key: 'net_revenue', label: 'Net revenue' }, { key: 'commission_rate_pct', label: 'Rate %' }, { key: 'commission', label: 'Commission' }, { key: 'void_rate_pct', label: 'Void %' }],
          });
        } else {
          ui.info('Targets are a working screen rather than a report — there is nothing to export.');
        }
      } catch (err) { ui.apiError(err); }
    }

    function printCurrent() {
      if (!lastPayload) { ui.warn('Nothing loaded yet.'); return; }
      const label = (REPORTS.find((r) => r[0] === state.report) || [])[1] || 'Report';
      const subtitle = `${SR.state.activeBusinessName()}${state.branchScope ? ` · ${SR.state.activeBranchName()}` : ''} · ${state.from} to ${state.to}`;
      try {
        if (state.report === 'sales') {
          const t = lastPayload.totals || {};
          SR.print.printReport({
            title: 'Sales report', subtitle,
            columns: [
              { label: U.titleCase(state.groupBy), key: 'label', width: 16 },
              { label: 'Sales', key: (r) => U.qty(r.transactions || r.count || 0), align: 'right', width: 8 },
              { label: 'Net revenue', key: (r) => U.money(r.net_revenue), align: 'right', width: 14 },
              { label: 'Margin', key: (r) => U.money(r.gross_margin), align: 'right', width: 14 },
            ],
            rows: lastPayload.rows || [],
            foot: [['Total', U.qty(t.transactions || 0), U.money(t.netRevenue), U.money(t.grossMargin)]],
            filename: 'sales-report',
          });
        } else if (state.report === 'inventory-movement') {
          SR.print.printReport({
            title: 'Inventory movement', subtitle,
            columns: [
              { label: 'Product', key: 'name', width: 26 },
              { label: 'On hand', key: (r) => U.qty(r.on_hand), align: 'right', width: 9 },
              { label: 'Sold', key: (r) => U.qty(r.units_sold), align: 'right', width: 9 },
              { label: 'Revenue', key: (r) => U.money(r.revenue), align: 'right', width: 14 },
              { label: 'Stock value', key: (r) => U.money(r.stock_value), align: 'right', width: 14 },
            ],
            rows: lastPayload.data || [],
            foot: [['Totals', '', '', U.money((lastPayload.totals || {}).revenue), U.money((lastPayload.totals || {}).stockValue)]],
            filename: 'inventory-movement',
          });
        } else if (state.report === 'movers') {
          SR.print.printReport({
            title: `Movers — ${state.kind}`, subtitle,
            columns: [
              { label: 'Product', key: 'name', width: 30 },
              { label: 'Units sold', key: (r) => U.qty(r.units_sold), align: 'right', width: 10 },
              { label: 'On hand', key: (r) => U.qty(r.on_hand), align: 'right', width: 9 },
              { label: 'Last sold', key: (r) => (r.last_sold ? U.date(r.last_sold) : 'never'), align: 'right', width: 12 },
            ],
            rows: lastPayload.data || [],
            filename: 'movers',
          });
        } else if (state.report === 'top-customers') {
          SR.print.printReport({
            title: 'Top customers', subtitle,
            columns: [
              { label: 'Customer', key: (r) => r.name || 'Walk-in', width: 26 },
              { label: 'Purchases', key: (r) => U.qty(r.purchases), align: 'right', width: 9 },
              { label: 'Revenue', key: (r) => U.money(r.revenue), align: 'right', width: 14 },
              { label: 'Owing', key: (r) => U.money(r.outstanding), align: 'right', width: 14 },
            ],
            rows: lastPayload.data || [],
            filename: 'top-customers',
          });
        } else if (state.report === 'commission') {
          SR.print.printReport({
            title: 'Commission', subtitle,
            columns: [
              { label: 'Salesperson', key: (r) => r.full_name || r.username || '—', width: 22 },
              { label: 'Net revenue', key: (r) => U.money(r.net_revenue), align: 'right', width: 15 },
              { label: 'Rate', key: (r) => `${r.commission_rate_pct || 0}%`, align: 'right', width: 7 },
              { label: 'Commission', key: (r) => U.money(r.commission), align: 'right', width: 15 },
            ],
            rows: lastPayload.data || [],
            foot: [['Total', U.money((lastPayload.totals || {}).revenue), '', U.money((lastPayload.totals || {}).commission)]],
            filename: 'commission',
          });
        } else {
          ui.info('Targets are read on screen.');
        }
      } catch (err) { ui.apiError(err); }
    }

    await load();
    return wrap;
  }

  SR.views = SR.views || {};
  SR.views.reports = { render };
}(window));
