'use strict';
// =====================================================================
// public/js/views/dashboard.js — WHAT THE SHOP LOOKS LIKE RIGHT NOW
// =====================================================================
// The dashboard is not a vanity screen. Each tile answers a question somebody
// asks out loud at 9 a.m.:
//
//   "How much have we taken today?"        -> takings, and against yesterday
//   "Is anything about to run out?"        -> low stock, with a reorder button
//   "Who owes us money?"                   -> debtors, and how much is overdue
//   "Is the drawer where it should be?"    -> the open till's expected cash
//   "Did everybody clock in?"              -> attendance
//
// It renders the SAME way offline as online. Online it reads the server's
// dashboard endpoint; offline it computes the same figures from the device
// mirror, and labels them "as at the last sync" so nobody mistakes a stale
// number for a live one.
// =====================================================================
(function (global) {
  const SR = global.SR;
  const ui = SR.ui;
  const U = SR.util;

  async function render(ctx) {
    ctx.setTitle('Dashboard');
    const wrap = ui.h('div', { class: 'stack' });
    const head = ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, `Good ${greeting()}, ${firstName()}`),
        ui.h('p', { class: 'sub', id: 'dash-sub' }, 'Loading the position…')),
      ui.h('div', { class: 'actions' },
        ui.h('button', { class: 'btn btn-sm', onClick: () => SR.exporter.reportDialog() }, 'Export'),
        ui.h('button', { class: 'btn btn-sm', onClick: () => refresh() }, 'Refresh')));
    wrap.appendChild(head);

    const body = ui.h('div', { class: 'stack' });
    wrap.appendChild(body);

    async function refresh() {
      body.replaceChildren(ui.loading('Reading the position…'));
      let data = null; let offline = false; let error = null;
      try {
        data = await SR.api.get('/api/dashboard', { query: SR.state.query() });
      } catch (err) {
        error = err;
        if (err.isOffline) { offline = true; data = await fromMirror(); }
        else throw err;
      }
      if (!data) { body.replaceChildren(ui.errorBlock(error || new Error('No data.'), { retry: { label: 'Try again', run: refresh } })); return; }
      paint(body, data, { offline });
    }

    async function fromMirror() {
      // Rebuild the essentials from the device mirror. Deliberately NOT a full
      // replica of the server's dashboard: everything here is something a till
      // can know on its own, and anything that needs the ledger is left out
      // rather than approximated.
      const branchId = SR.state.activeBranchId;
      const today = U.todayWat();
      const batches = await SR.store.all('stock_batches', { where: (b) => !Number(b.is_deleted) && (!branchId || String(b.branch_id) === String(branchId)) });
      const products = await SR.store.all('products', { where: (p) => !Number(p.is_deleted) });
      const byProduct = new Map();
      for (const b of batches) {
        if (['QUARANTINED', 'EXPIRED'].includes(String(b.status))) continue;
        const key = String(b.product_id);
        const cur = byProduct.get(key) || { qty: 0, value: 0 };
        cur.qty += Number(b.quantity || 0) - Number(b.quantity_reserved || 0);
        cur.value += Number(b.quantity || 0) * Number(b.cost_price_per_unit || 0);
        byProduct.set(key, cur);
      }
      let lowStock = 0; let stockValue = 0;
      for (const p of products) {
        const s = byProduct.get(String(p.id)) || { qty: 0, value: 0 };
        if (Number(p.reorder_level) > 0 && s.qty <= Number(p.reorder_level)) lowStock += 1;
        stockValue += s.value;
      }
      const outbox = await SR.sync.queueStats();
      return {
        offline: true,
        today: { sales: 0, gross: 0, count: 0, queued: outbox.pending },
        stock: { products: products.length, lowStock, stockValue },
        debtors: { total: 0, count: 0 },
        cash: null,
        attendance: null,
        topProducts: [],
        view: 'staff',
      };
    }

    function paint(host, data, { offline }) {
      host.replaceChildren();
      if (offline) {
        host.appendChild(ui.h('div', { class: 'alert alert-warn' },
          ui.h('strong', {}, 'Offline — '),
          'these figures are computed from this device\'s last sync, not from the office. Sales made here are counted in the queue below.'));
      }
      const sub = document.getElementById('dash-sub');
      if (sub) {
        const period = data.period ? `${U.date(data.period.from)} → ${U.date(data.period.to)}` : U.date(U.nowIso());
        sub.textContent = `${SR.state.activeBranchName()} · ${period}`;
      }

      const today = data.today || {};
      const stock = data.stock || {};
      const debtors = data.debtors || {};
      const cash = data.cash || {};
      const plan = data.plan || {};

      // ---- the four numbers every owner looks at first
      host.appendChild(ui.h('div', { class: 'grid grid-4' },
        ui.kpi({
          label: 'Takings today',
          value: U.money(today.gross != null ? today.gross : today.sales),
          foot: `${U.plural(today.count || today.saleCount || 0, 'sale')}${today.vs_yesterday_pct != null ? ` · ${today.vs_yesterday_pct >= 0 ? 'up' : 'down'} ${Math.abs(today.vs_yesterday_pct)}% on yesterday` : ''}`,
          tone: 'good',
        }),
        ui.kpi({
          label: 'Sales this period',
          value: U.money(today.periodGross != null ? today.periodGross : (today.sales != null ? today.sales : 0)),
          foot: data.period ? `${U.date(data.period.from)} → ${U.date(data.period.to)}` : null,
        }),
        ui.kpi({
          label: 'Stock at cost',
          value: U.money(stock.stockValue != null ? stock.stockValue : stock.atCost),
          foot: `${U.plural(stock.products || stock.productCount || 0, 'product')} · ${Number(stock.lowStock || stock.lowStockCount || 0)} need reordering`,
          tone: Number(stock.lowStock || stock.lowStockCount || 0) > 0 ? 'warn' : null,
        }),
        ui.kpi({
          label: 'Owed to us',
          value: U.money(debtors.total),
          foot: `${U.plural(debtors.count || 0, 'debtor')}${Number(debtors.overdue) ? ` · ${U.money(debtors.overdue)} overdue` : ''}`,
          tone: Number(debtors.overdue) > 0 ? 'bad' : null,
          small: true,
        })));

      // ---- the till, because a cashier needs this more than the owner does
      const tillCard = ui.h('div', { class: 'card' });
      tillCard.appendChild(ui.h('div', { class: 'card-head' }, ui.h('h2', {}, 'The drawer')));
      const tillBody = ui.h('div', { class: 'card-body' });
      if (cash.till || data.till) {
        const till = cash.till || data.till;
        tillBody.appendChild(ui.h('div', { class: 'grid grid-4' },
          ui.kpi({ label: 'Opening float', value: U.money(till.opening_cash), small: true }),
          ui.kpi({ label: 'Cash sales', value: U.money(till.cash_sales_total), small: true }),
          ui.kpi({ label: 'Expected in drawer', value: U.money(till.expected_cash), tone: 'info', small: true }),
          ui.kpi({ label: 'Transactions', value: String(till.sale_count || 0), foot: `${till.void_count || 0} voided`, small: true })));
        if (cash.safeBalance != null) {
          tillBody.appendChild(ui.h('p', { class: 'hint', style: { marginTop: '10px' } }, `Branch safe: ${U.money(cash.safeBalance)}`));
        }
        tillBody.appendChild(ui.h('div', { class: 'btn-row', style: { marginTop: '10px' } },
          ui.h('button', { class: 'btn btn-primary btn-sm', onClick: () => SR.app.navigate('/till') }, 'Open till & safe'),
          ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate('/pos') }, 'Go to the counter')));
      } else {
        tillBody.appendChild(ui.empty({
          title: 'No till is open',
          message: 'Open a till before taking cash, so the drawer has an opening float to count against at the end of the shift.',
          action: { label: 'Open a till', run: () => SR.app.navigate('/till') },
          mark: 'lock',
        }));
      }
      tillCard.appendChild(tillBody);
      host.appendChild(tillCard);

      // ---- two columns: what moved, and what needs attention
      const cols = ui.h('div', { class: 'grid grid-2' });

      if (Array.isArray(data.topProducts) && data.topProducts.length) {
        const card = ui.h('div', { class: 'card' });
        card.appendChild(ui.h('div', { class: 'card-head' }, ui.h('h2', {}, 'Best sellers this period')));
        card.appendChild(ui.h('div', { class: 'card-body' },
          ui.bars(data.topProducts.slice(0, 8).map((p) => ({
            label: String(p.product_name || p.name || '').slice(0, 34),
            value: p.revenue != null ? p.revenue : p.units_sold,
          })), { format: (v) => (data.topProducts[0] && data.topProducts[0].revenue != null ? U.money(v) : U.qty(v)) })));
        cols.appendChild(card);
      }

      if (Array.isArray(data.byBusiness) && data.byBusiness.length > 1) {
        const card = ui.h('div', { class: 'card' });
        card.appendChild(ui.h('div', { class: 'card-head' }, ui.h('h2', {}, 'By business')));
        card.appendChild(ui.h('div', { class: 'card-body' },
          ui.bars(data.byBusiness.map((b) => ({ label: b.name, value: b.revenue || b.gross || 0 })), { format: U.money, tone: 'b2' })));
        cols.appendChild(card);
      } else if (Array.isArray(data.byBranch) && data.byBranch.length > 1) {
        const card = ui.h('div', { class: 'card' });
        card.appendChild(ui.h('div', { class: 'card-head' }, ui.h('h2', {}, 'By branch')));
        card.appendChild(ui.h('div', { class: 'card-body' },
          ui.bars(data.byBranch.map((b) => ({ label: b.name, value: b.revenue || b.gross || 0 })), { format: U.money, tone: 'b2' })));
        cols.appendChild(card);
      }
      if (cols.childElementCount) host.appendChild(cols);

      // ---- what needs somebody to do something
      const actions = [];
      if (Number(stock.lowStock || stock.lowStockCount || 0) > 0) {
        actions.push(actionRow('Reorder ' + U.plural(stock.lowStock || stock.lowStockCount, 'line'), 'Products at or below their reorder level.', 'Products', () => SR.app.navigate('/stock?filter=low')));
      }
      if (Number(debtors.overdue || 0) > 0) {
        actions.push(actionRow(`${U.money(debtors.overdue)} overdue`, 'Debtor balances past their terms.', 'Money', () => SR.app.navigate('/customers?tab=debtors')));
      }
      if (Array.isArray(data.actions)) {
        for (const a of data.actions) {
          actions.push(actionRow(a.title || a.label || 'Action needed', a.message || a.detail || '', a.kind || '', () => SR.app.navigate(a.path || a.href || '/dashboard')));
        }
      }
      if (offline) {
        actions.push(actionRow('Queued work', 'Sales and other records made on this device and not yet sent.', 'Sync', () => SR.app.navigate('/sync')));
      }
      if (actions.length) {
        const card = ui.h('div', { class: 'card' });
        card.appendChild(ui.h('div', { class: 'card-head' }, ui.h('h2', {}, 'Needs attention')));
        const list = ui.h('div', { class: 'card-body tight' });
        for (const row of actions) list.appendChild(row);
        card.appendChild(list);
        host.appendChild(card);
      }

      // ---- the plan, only when it is nearly full
      const usage = plan.usage || data.planUsage;
      if (usage && (usage.branchesPct >= 80 || usage.staffPct >= 80 || usage.businessesPct >= 80)) {
        host.appendChild(ui.h('div', { class: 'alert alert-warn' },
          ui.h('strong', {}, 'Your plan is nearly full. '),
          `${usage.branches || 0} of ${plan.maxBranches || '—'} branches and ${usage.staff || 0} of ${plan.maxStaff || '—'} staff in use. `,
          ui.h('button', { class: 'link-btn', onClick: () => SR.app.navigate('/plan') }, 'See the plan')));
      }
    }

    void render; // initial paint happens here
    await refresh();
    return wrap;
  }

  function actionRow(title, detail, kind, run) {
    const row = ui.h('button', {
      class: 'pos-hit',
      style: { width: '100%' },
      onClick: run,
    });
    row.appendChild(ui.h('div', { class: 'grow' },
      ui.h('div', { class: 'ph-name' }, title),
      ui.h('div', { class: 'ph-meta' }, detail || '')));
    if (kind) row.appendChild(ui.badge(kind, 'badge-warn'));
    row.appendChild(ui.h('span', { class: 'ph-price' }, '›'));
    return row;
  }

  function greeting() {
    const hour = Number(U.nowWatSql().slice(11, 13));
    if (hour < 12) return 'morning';
    if (hour < 17) return 'afternoon';
    return 'evening';
  }
  function firstName() {
    const name = (SR.state.user && SR.state.user.fullName) || '';
    return String(name).split(/\s+/)[0] || 'there';
  }

  SR.views = SR.views || {};
  SR.views.dashboard = { render };
}(window));
