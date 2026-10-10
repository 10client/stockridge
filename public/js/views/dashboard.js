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
//
// ---------------------------------------------------------------------
// EVERY FIELD BELOW IS THE FIELD THE SERVER ACTUALLY SENDS.
//
// This screen had been reading a different set of names from the ones
// `/api/dashboard` answers with — ten mismatches, and not one of them threw. A
// screen that reads `undefined` renders ₦0, or "—", or a blank row, and looks
// exactly like a quiet morning:
//
//   read                          server sends                    what it showed
//   today.periodGross             period.grossRevenue             ** ₦4 ** — the tile
//                                                                 "Sales this period" printed
//                                                                 the COUNT of sales with a naira
//                                                                 sign, because the fallback was
//                                                                 `today.sales`, a number of sales
//   today.vs_yesterday_pct        today.vsYesterday.changePct     "up 12% on yesterday" never once
//                                                                 appeared
//   debtors.total                 debtors.totalOwed               "Owed to us ₦0" for every shop,
//                                                                 however much was owed
//   debtors.overdue               debtors.likelyBad / overdueInvoices   the overdue figure never took
//                                                                 the colour that asks for action
//   cash.till || data.till        cash.myTill / cash.openTills    ** the drawer card said "No till
//                                                                 is open" while a till was open **
//   till.opening_cash,            openingCash, cashSales,
//   till.cash_sales_total …       expectedCash, saleCount
//   b.revenue || b.gross          b.period.gross, b.today.gross   every "By business" and "By
//                                                                 branch" bar was zero-length
//   a.message, a.kind, a.path     a.label, a.severity, a.route    the whole "Needs attention" card:
//                                                                 blank second line, no severity,
//                                                                 and every row navigated back to
//                                                                 the dashboard
//   usage.branchesPct,            plan.branches.used / .allowed   ** the "your plan is nearly full"
//   plan.maxBranches                                              warning never fired **
//
// OFF BY A HIDDEN FALLBACK IS STILL OFF. `stock.stockValue ?? stock.atCost` worked
// because `stockValue` does not exist — the same shape as the two above, one word
// away from a wrong number. The dead names are gone; what is left is what the
// endpoint sends, and `test/unit/frontend-wire.test.js` fails the build if the two
// lists drift again.
// =====================================================================
(function (global) {
  const SR = global.SR;
  const ui = SR.ui;
  const U = SR.util;

  /** Which icon belongs to each thing the server can ask somebody to look at. */
  const ACTION_ICONS = {
    low_stock: 'box',
    expiring: 'calendar',
    overdue: 'receipt',
    till_review: 'cash',
    expenses: 'wallet',
    deliveries: 'truck',
    devices: 'idcard',
    attendance: 'clock',
  };

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
      let changeOwed = null;
      try {
        data = await SR.api.get('/api/dashboard', { query: SR.state.query() });
        // CHANGE OWED IS FETCHED SEPARATELY AND MAY FAIL WITHOUT TAKING THE DASHBOARD
        // WITH IT. It is the one figure here that is a promise with a date on it, and
        // its own endpoint keeps the dashboard query — which every seat runs on every
        // load — from growing a subquery it does not need.
        try { changeOwed = await SR.api.get('/api/change-owed/summary'); } catch (e) { changeOwed = null; }
      } catch (err) {
        error = err;
        if (err.isOffline) { offline = true; data = await fromMirror(); }
        else throw err;
      }
      if (!data) { body.replaceChildren(ui.errorBlock(error || new Error('No data.'), { retry: { label: 'Try again', run: refresh } })); return; }
      paint(body, data, { offline, changeOwed });
    }

    async function fromMirror() {
      // Rebuild the essentials from the device mirror. Deliberately NOT a full
      // replica of the server's dashboard: everything here is something a till
      // can know on its own, and anything that needs the ledger is left out
      // rather than approximated.
      //
      // It returns the SERVER'S SHAPE, not a convenient one. A mirror that
      // answers with its own key names is the same defect as the ten above,
      // waiting for the day the device goes offline.
      const branchId = SR.state.activeBranchId;
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
      let lowStockCount = 0; let atCost = 0;
      for (const p of products) {
        const s = byProduct.get(String(p.id)) || { qty: 0, value: 0 };
        if (Number(p.reorder_level) > 0 && s.qty <= Number(p.reorder_level)) lowStockCount += 1;
        atCost += s.value;
      }
      const outbox = await SR.sync.queueStats();
      return {
        offline: true,
        view: 'STAFF',
        today: { sales: 0, count: 0, gross: 0, queued: outbox.pending, vsYesterday: null },
        period: null,
        stock: { products: products.length, lowStockCount, atCost },
        debtors: { count: 0, totalOwed: 0, likelyBad: 0, overdueInvoices: 0 },
        cash: { safeBalance: null, myTill: null, openTills: [] },
        topProducts: [],
        actions: [],
        plan: null,
      };
    }

    function paint(host, data, { offline, changeOwed = null }) {
      host.replaceChildren();
      if (offline) {
        host.appendChild(ui.h('div', { class: 'alert alert-warn' },
          ui.h('strong', {}, 'Offline — '),
          'these figures are computed from this device\'s last sync, not from the office. Sales made here are counted in the queue below.'));
      }
      const sub = document.getElementById('dash-sub');
      if (sub) {
        const period = data.period ? `${U.date(data.period.from)} → ${U.date(data.period.to)}` : U.date(U.nowIso());
        // The server's scope is the truth. The chip can say a branch while the figures
        // are still the group — that is the bug this subtitle used to repeat.
        const scopeBranch = data.scope && data.scope.branch;
        sub.textContent = `${scopeBranch || SR.state.activeBranchName()} · ${period}`;
      }
      if (SR.state.canSeeAllBranches()) {
        const scopeBranch = data.scope && data.scope.branch;
        const onABranch = scopeBranch && scopeBranch !== 'All branches';
        host.appendChild(ui.h('p', { class: 'hint' }, onABranch
          ? `These figures are ${scopeBranch} only.`
          : 'These figures are every branch together. Switch to a branch to see that shop\'s totals.'));
      }

      const today = data.today || {};
      const period = data.period || {};
      const stock = data.stock || {};
      const debtors = data.debtors || {};
      const cash = data.cash || {};

      // ---- the four numbers every owner looks at first
      const until = today.vsYesterday || null;
      // "up 12% on yesterday" — the number the server sends is `changePct`, inside
      // `vsYesterday`. It sends null rather than 0 when there is no yesterday to
      // compare with, which is not the same statement as "no change" — and that is why
      // the comparison is now an ARROW rather than a sentence: the arrow is drawn from
      // the sign of the figure the server sent, and when the server sent neither a
      // percentage nor a delta there is no arrow at all, because there is nothing to
      // compare against.
      const trend = until ? { pct: until.changePct, change: until.change, goodWhen: 'up', vs: 'yesterday' } : null;
      host.appendChild(ui.h('div', { class: 'grid grid-4' },
        ui.kpi({
          label: 'Takings today',
          value: U.money(today.gross),
          foot: `${U.plural(today.count || 0, 'sale')}${until ? ' · vs yesterday' : ''}`,
          tone: 'good',
          icon: 'cash',
          trend,
        }),
        ui.kpi({
          // THE DATE RANGE IS THE TITLE, because "Sales this period" beside "Takings
          // today" asks the reader to hold two periods in their head. This tile used
          // to fall back to `today.sales` — a COUNT — and print it with a naira sign.
          label: period.from ? `Sales ${U.date(period.from)} → ${U.date(period.to)}` : 'Sales this period',
          value: U.money(period.grossRevenue),
          foot: period.sales != null ? `${U.plural(period.sales, 'sale')} · ${U.money(period.netRevenue)} after VAT` : null,
          // MONEY IN ACROSS A WINDOW IS A SUM OF RECEIPTS, not a bar chart. The tile is read
          // for the figure; the icon has to name the thing the figure is.
          icon: 'receipt',
        }),
        ui.kpi({
          label: 'Stock at cost',
          value: U.money(stock.atCost),
          // `lowStockCount` counts PRODUCT × BRANCH lines — the same product short at
          // two shops is two lines — so it can legitimately exceed the product count and
          // the tile read "78 products · 106 need reordering", which looks impossible.
          foot: `${U.plural(stock.products || 0, 'product')} · ${Number(stock.lowStockCount || 0)} line${Number(stock.lowStockCount) === 1 ? '' : 's'} to reorder`
            + (Array.isArray(stock.expiringSoon) && stock.expiringSoon.length ? ` · ${stock.expiringSoon.length} expiring` : ''),
          tone: Number(stock.lowStockCount || 0) > 0 ? 'warn' : null,
          icon: 'box',
        }),
        ui.kpi({
          // ONE NAIRA SIGN IN THIS TILE, ON THE VALUE. The foot counts the invoices
          // that are actually past their date — a second money figure in 11px type
          // under a money figure is noise, and "3 invoices past due" is what tells
          // somebody to go and ring three people.
          label: 'Owed to us',
          value: U.money(debtors.totalOwed),
          foot: `${U.plural(debtors.count || 0, 'debtor')}`
            + (Number(debtors.overdueInvoices) ? ` · ${U.plural(debtors.overdueInvoices, 'invoice')} past due` : '')
            + (Number(debtors.likelyBad) ? ` · ${U.money(debtors.likelyBad)} over 90 days` : ''),
          tone: Number(debtors.likelyBad) > 0 ? 'bad' : (Number(debtors.overdueInvoices) > 0 ? 'warn' : null),
          small: true,
          // THE FIGURE IS NAIRA, NOT PEOPLE. This carried the users icon — "Owed to us
          // ₦34,579,273.97" is a receivable, and the people are the 11 debtors counted on the
          // line beneath it. The debtor LEDGER is what the money is.
          icon: 'ledger',
        })));

      // ---- change the shop is holding for customers
      //
      // A CARD RATHER THAN A SCREEN, because it changes what somebody does: ₦18,400
      // owed with ₦7,300 expiring this week is a reason to call four customers, and a
      // number that only exists on the change-owed screen is a number nobody sees
      // until a customer is standing at the counter asking for their money.
      if (changeOwed && Number(changeOwed.outstanding_claims) > 0) {
        const owedCard = ui.h('div', { class: 'card' });
        owedCard.appendChild(ui.h('div', { class: 'card-head' }, ui.h('h2', {}, 'Change owed to customers')));
        owedCard.appendChild(ui.h('div', { class: 'card-body' },
          ui.h('div', { class: 'grid grid-3' },
            ui.kpi({ label: 'Held for customers', value: U.money(changeOwed.outstanding_amount), foot: U.plural(changeOwed.outstanding_claims, 'claim'), small: true, icon: 'wallet' }),
            ui.kpi({
              label: 'Expiring this week',
              value: U.money(changeOwed.expiring_soon_amount),
              tone: Number(changeOwed.expiring_soon_amount) > 0 ? 'warn' : null,
              small: true,
              icon: 'clock',
            }),
            ui.kpi({
              label: 'Past its window',
              value: U.money(changeOwed.expired_amount),
              foot: changeOwed.next_expiry ? `next expiry ${U.date(changeOwed.next_expiry)}` : null,
              tone: Number(changeOwed.expired_amount) > 0 ? 'bad' : null,
              small: true,
              icon: 'calendar',
            })),
          ui.h('div', { class: 'btn-row', style: { marginTop: '10px' } },
            ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate('/change-owed') }, 'Open change owed'))));
        host.appendChild(owedCard);
      }

      // ---- the till, because a cashier needs this more than the owner does
      const tillCard = ui.h('div', { class: 'card' });
      tillCard.appendChild(ui.h('div', { class: 'card-head' }, ui.h('h2', {}, 'The drawer')));
      const tillBody = ui.h('div', { class: 'card-body' });
      // THE DRAWER IS `cash.myTill`. It was read as `cash.till || data.till`, neither
      // of which the server has ever sent, so this card said "No till is open" to a
      // cashier with a till open in front of them.
      const myTill = cash.myTill || null;
      const otherTills = Array.isArray(cash.openTills) ? cash.openTills : [];
      if (myTill) {
        tillBody.appendChild(ui.h('div', { class: 'grid grid-4' },
          ui.kpi({ label: 'Opening float', value: U.money(myTill.openingCash), small: true, icon: 'wallet' }),
          ui.kpi({ label: 'Cash sales', value: U.money(myTill.cashSales), small: true, icon: 'cash' }),
          // CASH IN THE DRAWER, not stock. This carried the box.
          ui.kpi({ label: 'Expected in drawer', value: U.money(myTill.expectedCash), tone: 'info', small: true, icon: 'cash' }),
          ui.kpi({ label: 'Transactions', value: String(myTill.saleCount || 0), foot: `since ${U.time(myTill.openedAt)}`, small: true, icon: 'receipt' })));
        if (cash.safeBalance != null) {
          tillBody.appendChild(ui.h('p', { class: 'hint', style: { marginTop: '10px' } }, `Branch safe: ${U.money(cash.safeBalance)}`));
        }
        tillBody.appendChild(ui.h('div', { class: 'btn-row', style: { marginTop: '10px' } },
          ui.h('button', { class: 'btn btn-primary btn-sm', onClick: () => SR.app.navigate('/till') }, 'Open till & safe'),
          ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate('/pos') }, 'Go to the counter')));
      } else if (otherTills.length) {
        // A manager with no till of their own, on a shift where somebody else has one.
        // "No till is open" would be wrong, and the count of open drawers is what they
        // came here to check.
        const list = ui.h('div', { class: 'list' });
        for (const t of otherTills.slice(0, 5)) {
          list.appendChild(ui.h('div', { class: 'row' },
            ui.h('div', { class: 'grow' },
              ui.h('div', { class: 'row-title' }, t.cashier || 'Unassigned'),
              ui.h('div', { class: 'row-meta' }, `${t.branch || ''}${t.openedAt ? ` · opened ${U.date(t.openedAt)}` : ''}`)),
            ui.h('div', { class: 'row-value' }, U.money(t.grandTotal))));
        }
        tillBody.appendChild(ui.h('p', { class: 'hint' }, `You have no till of your own open. ${U.plural(otherTills.length, 'till')} open at this branch:`));
        tillBody.appendChild(list);
        tillBody.appendChild(ui.h('div', { class: 'btn-row', style: { marginTop: '10px' } },
          ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate('/till') }, 'Open a till')));
      } else {
        tillBody.appendChild(ui.empty({
          title: 'No till is open',
          message: 'Open a till before taking cash, so the drawer has an opening float to count against at the end of the shift.',
          action: { label: 'Open a till', run: () => SR.app.navigate('/till') },
          mark: 'cash',
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
            value: p.revenue != null ? p.revenue : p.units,
          })), { format: (v) => (data.topProducts[0] && data.topProducts[0].revenue != null ? U.money(v) : U.qty(v)) })));
        cols.appendChild(card);
      }

      // BY BUSINESS AND BY BRANCH: the money is under `today`/`period`, not at the top
      // level — the bars were reading `b.revenue || b.gross`, so every bar was zero.
      const groupRows = (rows) => rows.map((b) => ({ label: b.name, value: (b.period && b.period.gross) || (b.today && b.today.gross) || 0 }));
      if (Array.isArray(data.byBusiness) && data.byBusiness.length > 1) {
        const card = ui.h('div', { class: 'card' });
        card.appendChild(ui.h('div', { class: 'card-head' }, ui.h('h2', {}, 'By business')));
        card.appendChild(ui.h('div', { class: 'card-body' }, ui.bars(groupRows(data.byBusiness), { format: U.money, tone: 'b2' })));
        cols.appendChild(card);
      }
      // No "By branch" card. Those totals are the tiles above, and only after the
      // owner has switched to a branch. Listing every shop here showed branch totals
      // on the group screen, which is the view that must not carry them.
      if (cols.childElementCount) host.appendChild(cols);

      // ---- what needs somebody to do something
      //
      // THE SERVER'S LIST IS THE LIST. This screen used to build its own low-stock and
      // overdue rows from the figures above AND append the server's `actions`, so a
      // shop with two problems was shown three rows — two of them about the same
      // shelf. The server knows about expiring batches, unreviewed till variances,
      // expenses, deliveries, devices and flagged clock-ins; the screen knows about
      // two of those. One source, one row each.
      const actions = Array.isArray(data.actions) ? data.actions.slice() : [];
      if (offline) {
        actions.push({ key: 'sync', severity: 'INFO', label: 'Queued work', route: '/sync' });
      }
      if (actions.length) {
        const card = ui.h('div', { class: 'card' });
        card.appendChild(ui.h('div', { class: 'card-head' }, ui.h('h2', {}, 'Needs attention')));
        const list = ui.h('div', { class: 'card-body tight' });
        for (const a of actions) list.appendChild(actionRow(a));
        card.appendChild(list);
        host.appendChild(card);
      }

      // ---- the plan, only when it is nearly full
      //
      // Every cap is `{ used, allowed, unlimited, remaining }` and a cap of zero means
      // UNLIMITED, which is why this no longer prints "0 of 0". `branchesPct` was never
      // a field the server sent, so this warning had never once appeared: a client
      // learned they had run out of staff seats at the moment they tried to hire.
      const plan = data.plan || null;
      const pressure = plan ? [
        ['branches', plan.branches],
        ['staff', plan.staff],
        ['businesses', plan.businesses],
      ].filter(([, cap]) => cap && !cap.unlimited && cap.allowed > 0 && (cap.used / cap.allowed) >= 0.8) : [];
      if (plan && pressure.length) {
        // A client can legitimately be OVER a cap — a plan is lowered while the rows it
        // governs already exist, because lowering a cap never deletes anything. "6 of 5
        // branches" reads as arithmetic gone wrong; over the line says which way round it
        // is and what follows, which is that the next create will be refused.
        const over = pressure.filter(([, cap]) => cap.used > cap.allowed);
        const nearly = pressure.filter(([, cap]) => cap.used <= cap.allowed);
        host.appendChild(ui.h('div', { class: `alert ${over.length ? 'alert-danger' : 'alert-warn'}` },
          ui.h('strong', {}, over.length ? 'You are over your plan. ' : 'Your plan is nearly full. '),
          [
            ...over.map(([noun, cap]) => `${cap.used} ${noun} in use against a plan limit of ${cap.allowed}`),
            ...nearly.map(([noun, cap]) => `${cap.used} of ${cap.allowed} ${noun}`),
          ].join(' and '),
          ` on the ${plan.plan} plan${plan.renewalDate ? `, renewing ${U.date(plan.renewalDate)}` : ''}. `,
          over.length ? 'Nothing has been removed, but the next one will be refused until one is deactivated or the plan is raised. ' : '',
          ui.h('button', { class: 'link-btn', onClick: () => SR.app.navigate('/plan') }, 'See the plan')));
      }
    }

    /**
     * One row per thing that needs somebody. The field names are the server's:
     * `label`, `severity`, `route` — this read `message`, `kind` and `path`.
     */
    function actionRow(a) {
      const tone = String(a.severity || 'INFO').toUpperCase();
      const row = ui.h('button', {
        class: 'pos-hit',
        style: { width: '100%' },
        onClick: () => SR.app.navigate(a.route || '/dashboard'),
      });
      row.appendChild(ui.h('span', { class: 'row-icon', html: SR.app.icon(ACTION_ICONS[a.key] || 'shield', 18) }));
      row.appendChild(ui.h('div', { class: 'grow' },
        ui.h('div', { class: 'ph-name' }, a.label || 'Action needed'),
        ui.h('div', { class: 'ph-meta' }, a.count != null ? U.plural(a.count, 'item') : '')));
      if (tone && tone !== 'INFO') row.appendChild(ui.badge(tone === 'CRITICAL' ? 'Urgent' : 'Review', tone === 'CRITICAL' ? 'badge-bad' : 'badge-warn'));
      row.appendChild(ui.h('span', { class: 'ph-price' }, '›'));
      return row;
    }

    void render; // initial paint happens here
    await refresh();
    return wrap;
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
