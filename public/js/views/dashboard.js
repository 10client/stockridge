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

    function shopMiss(err) {
      return Boolean(err && (err.isOffline || err.code === 'UPSTREAM_UNREACHABLE' || err.code === 'OFFLINE'
        || /did not answer from this window|shop server could not be reached|failed to fetch/i.test(String(err.message || ''))));
    }

    async function readDashboard() {
      const data = await SR.api.get('/api/dashboard', { query: SR.state.query(), timeoutMs: 25000 });
      let changeOwed = null;
      try { changeOwed = await SR.api.get('/api/change-owed/summary', { timeoutMs: 12000 }); } catch (e) { changeOwed = null; }
      if (SR.api.noteReachable) SR.api.noteReachable(true);
      return { data, changeOwed, offline: false };
    }

    async function refresh() {
      body.replaceChildren(ui.loading('Reading the position…'));
      let data = null; let offline = false; let error = null;
      let changeOwed = null;
      try {
        const live = await readDashboard();
        data = live.data;
        changeOwed = live.changeOwed;
      } catch (err) {
        error = err;
        const knownUp = Boolean(SR.api.shopConfirmed && SR.api.shopConfirmed());
        // "The shop is up" is only true after a probe answered. An offline
        // sign-in used to land here while the chip still said online, and the
        // page was replaced by Try again.
        if (knownUp && err && err.code === 'SHOP_READ_FAILED') {
          body.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: refresh } }));
          return;
        }
        if (knownUp && !shopMiss(err)) {
          body.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: refresh } }));
          return;
        }
        if (knownUp) {
          try {
            const again = await readDashboard();
            data = again.data;
            changeOwed = again.changeOwed;
            offline = false;
          } catch (againErr) {
            if (againErr && againErr.code === 'SHOP_READ_FAILED') {
              body.replaceChildren(ui.errorBlock(againErr, { retry: { label: 'Try again', run: refresh } }));
              return;
            }
            if (!shopMiss(againErr)) throw againErr;
            offline = true;
            data = await fromMirror();
          }
        } else {
          offline = true;
          data = await fromMirror();
        }
      }
      if (!data) {
        const missed = !(SR.api.shopConfirmed && SR.api.shopConfirmed());
        const fallback = new Error(missed
          ? 'The shop did not answer, and this device has no saved figures yet. Connect once so this page can load.'
          : ((error && error.message) || 'This screen did not load. Try again.'));
        body.replaceChildren(ui.errorBlock(missed ? fallback : (error || fallback), { retry: { label: 'Try again', run: refresh } }));
        return;
      }
      // Saved figures are not an offline banner while the shop has answered.
      if (offline && SR.api.shopConfirmed && SR.api.shopConfirmed()) {
        body.replaceChildren(ui.errorBlock(error || new Error('The shop is up, but this screen did not load. Try again.'), { retry: { label: 'Try again', run: refresh } }));
        return;
      }
      paint(body, data, { offline, changeOwed });
    }

    function localSales(items) {
      const today = (SR.util && SR.util.nowWatSql ? String(SR.util.nowWatSql()) : new Date().toISOString()).slice(0, 10);
      let gross = 0;
      let count = 0;
      for (const item of items || []) {
        if (!item || String(item.type || '').toUpperCase() !== 'SALE') continue;
        if (item.status && !['PENDING', 'RETRY'].includes(String(item.status))) continue;
        const when = String(item.occurred_at || item.at || '');
        if (when && when.slice(0, 10) !== today) continue;
        const payload = item.payload || {};
        const payments = Array.isArray(payload.payments) ? payload.payments : [];
        const paid = payments.reduce((sum, payment) => sum + (payment && payment.method === 'CREDIT' ? 0 : Number(payment && payment.amount) || 0), 0);
        gross += paid;
        count += 1;
      }
      return { count, gross };
    }

    // The safe ledger, for this shop only. A pinned cashier's mirror is already
    // limited to their shop. Summing every row here would show another branch's
    // cash on a device that had once stood in that shop.
    async function mirroredSafe(branchId) {
      try {
        const rows = await SR.store.all('branch_safe_ledger', {
          where: (row) => !Number(row.is_deleted) && (!branchId || String(row.branch_id) === String(branchId)),
        });
        if (!rows.length) return null;
        return rows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
      } catch (e) {
        return null;
      }
    }

    function openSafeScreen() {
      try { sessionStorage.setItem('sr.tillTab', 'safe'); } catch (e) { /* private mode */ }
      SR.app.navigate('/till');
    }

    function paintSafe(body, cash) {
      if (!cash || cash.safeBalance == null || cash.safeBalance === '') return;
      body.appendChild(ui.h('div', { class: 'kpis', style: { marginTop: '12px' } },
        ui.kpi({
          label: 'Branch safe',
          value: U.money(cash.safeBalance),
          small: true,
          icon: 'wallet',
          foot: 'Cash held outside the drawer. Not the till float.',
        })));
      body.appendChild(ui.h('div', { class: 'btn-row', style: { marginTop: '8px' } },
        ui.h('button', { class: 'btn btn-sm', onClick: openSafeScreen }, 'Open the safe')));
    }

    function drawerCard(row) {
      if (!row) return null;
      const opening = Number(row.opening_cash) || 0;
      const cashSales = Number(row.cash_sales_total) || 0;
      const refunds = Number(row.refund_total) || 0;
      return {
        openingCash: opening,
        cashSales,
        expectedCash: opening + cashSales - refunds,
        saleCount: Number(row.sale_count) || 0,
        openedAt: row.opened_at || null,
      };
    }

    async function mirroredDrawer(branchId) {
      const rows = await SR.store.all('till_sessions').catch(() => []);
      const open = (rows || []).filter((row) => row && String(row.status).toUpperCase() === 'OPEN' && !Number(row.is_deleted));
      const mineId = SR.state.user && SR.state.user.id;
      const mine = open.find((row) => String(row.user_id) === String(mineId) && (!branchId || String(row.branch_id) === String(branchId)))
        || open.find((row) => String(row.user_id) === String(mineId))
        || null;
      const others = open.filter((row) => row !== mine).slice(0, 5).map((row) => ({
        cashier: row.cashier_name || row.full_name || 'Unassigned',
        branch: row.branch_name || '',
        openedAt: row.opened_at || null,
        grandTotal: Number(row.grand_total) || 0,
      }));
      return { myTill: drawerCard(mine), openTills: others };
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
      const sqlHand = SR.store.stockOnHand ? await SR.store.stockOnHand(branchId).catch(() => null) : null;
      if (Array.isArray(sqlHand)) {
        const products = await SR.store.all('products', { where: (p) => !Number(p.is_deleted) });
        let lowStockCount = 0;
        let atCost = 0;
        const byId = new Map(sqlHand.map((row) => [String(row.product_id), row]));
        for (const p of products) {
          const s = byId.get(String(p.id)) || { available: 0, stock_value: 0 };
          if (Number(p.reorder_level) > 0 && Number(s.available) <= Number(p.reorder_level)) lowStockCount += 1;
          atCost += Number(s.stock_value) || 0;
        }
        const outbox = await SR.sync.queueStats();
        const saved = localSales(outbox.items || []);
        return {
          offline: true,
          view: 'STAFF',
          today: { sales: saved.count, count: saved.count, gross: saved.gross, queued: outbox.pending, vsYesterday: null },
          period: null,
          stock: { products: products.length, lowStockCount, atCost },
          debtors: { count: 0, totalOwed: 0, likelyBad: 0, overdueInvoices: 0 },
          cash: Object.assign({ safeBalance: await mirroredSafe(branchId) }, await mirroredDrawer(branchId)),
          topProducts: [],
          actions: [],
          plan: null,
        };
      }
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
      const saved = localSales(outbox.items || []);
      return {
        offline: true,
        view: 'STAFF',
        today: { sales: saved.count, count: saved.count, gross: saved.gross, queued: outbox.pending, vsYesterday: null },
        period: null,
        stock: { products: products.length, lowStockCount, atCost },
        debtors: { count: 0, totalOwed: 0, likelyBad: 0, overdueInvoices: 0 },
        cash: Object.assign({ safeBalance: await mirroredSafe(branchId) }, await mirroredDrawer(branchId)),
        topProducts: [],
        actions: [],
        plan: null,
      };
    }

    function paint(host, data, { offline, changeOwed = null }) {
      const todayNodes = [];
      const tradingNodes = [];
      const attentionNodes = [];
      host.replaceChildren();
      if (SR.state.moduleOn && SR.state.moduleOn('manufacturing')) {
        const water = (SR.state.activeBusiness() || {}).profile_code === 'WATER_PACKING';
        todayNodes.push(ui.h('div', { class: 'card' },
          ui.h('div', { class: 'card-body' },
            ui.h('h2', {}, water ? 'Packing plant' : 'Plant'),
            ui.h('p', { class: 'hint' }, water
              ? 'Sell bags and bottles on the plant floor, or from the vehicle assigned to the person at the counter. Open a vehicle for its sales, fuel, repairs, customers and driver.'
              : 'Sell at the plant, or from the vehicle assigned to the person at the counter. Open a vehicle for its sales, fuel, repairs, customers and driver.'),
            ui.h('div', { class: 'actions' },
              ui.h('button', { class: 'btn btn-primary btn-sm', type: 'button', onClick: () => SR.app.navigate('/pos') }, 'Sell'),
              SR.state.moduleOn('dispatch') ? ui.h('button', { class: 'btn btn-sm', type: 'button', onClick: () => SR.app.navigate('/fleet') }, 'Vehicles') : null))));
      }
      const sub = document.getElementById('dash-sub');
      if (sub) {
        const period = data.period ? `${U.date(data.period.from)} → ${U.date(data.period.to)}` : U.date(U.nowIso());
        // The server's scope is the truth. The chip can say a branch while the figures
        // are still the group — that is the bug this subtitle used to repeat.
        const scopeBranch = data.scope && data.scope.branch;
        const scopeBusiness = data.scope && data.scope.business;
        sub.textContent = [scopeBusiness, scopeBranch || SR.state.activeBranchName(), period].filter(Boolean).join(' · ');
      }
      if (SR.state.canSeeAllBranches()) {
        const scopeBranch = data.scope && data.scope.branch;
        const scopeBusiness = data.scope && data.scope.business;
        const onABranch = scopeBranch && scopeBranch !== 'All branches';
        const onABusiness = scopeBusiness && scopeBusiness !== 'All businesses';
        let hint = 'These figures are every business together. Switch business to work in one.';
        if (onABranch) hint = `These figures are ${scopeBranch} only.`;
        else if (onABusiness) hint = `These figures are ${scopeBusiness}, every shop together. Switch business for another, or pick a shop for that shop's totals.`;
        todayNodes.push(ui.h('p', { class: 'hint' }, hint));
      } else if (!SR.state.activeBranchId && SR.state.branches().length > 1) {
        todayNodes.push(ui.h('p', { class: 'hint' }, 'These figures are every shop you reach, not every shop on this deployment. Pick a shop in the top bar for that shop’s totals.'));
      }

      const today = data.today || {};
      const period = data.period || {};
      if (offline) {
        const sales = Number(today.count) || 0;
        const queued = Number(today.queued) || 0;
        const savedHere = Number(today.gross) || 0;
        let savedText = 'the shop did not answer. These figures are from the stock saved on this till. A sale made now is saved here and uploads when the line returns.';
        if (sales) savedText = `the shop did not answer. ${sales === 1 ? '1 sale is' : sales + ' sales are'} saved on this till (${U.money(savedHere)}). They upload when the line returns.`;
        else if (queued) savedText = `the shop did not answer. ${queued === 1 ? '1 item is' : queued + ' items are'} saved on this till and will upload when the line returns.`;
        todayNodes.push(ui.h('div', { class: 'alert alert-warn' },
          ui.h('strong', {}, 'Offline — '),
          savedText));
      }
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
      todayNodes.push(ui.h('div', { class: 'grid grid-4' },
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
        todayNodes.push(owedCard);
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
        tillBody.appendChild(ui.h('div', { class: 'btn-row', style: { marginTop: '10px' } },
          ui.h('button', { class: 'btn btn-primary btn-sm', onClick: () => SR.app.navigate('/till') }, 'Close & count'),
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
      // THE SAFE IS NOT THE DRAWER. It used to be painted only inside the branch
      // where this person had their own till open. A general manager opens the
      // till and funds the safe. Staff then see that till, and the safe figure
      // was dropped. A pinned cashier still only receives their own shop's sum.
      paintSafe(tillBody, cash);
      tillCard.appendChild(tillBody);
      todayNodes.push(tillCard);

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
      if (Array.isArray(data.categorySales) && data.categorySales.length) {
        const card = ui.h('div', { class: 'card' });
        card.appendChild(ui.h('div', { class: 'card-head' }, ui.h('h2', {}, 'Category sales this period')));
        card.appendChild(ui.h('div', { class: 'card-body' },
          ui.bars(data.categorySales.slice(0, 8).map((c) => ({
            label: String(c.category || 'Uncategorised').slice(0, 34),
            value: c.revenue,
          })), { format: U.money, tone: 'b2' })));
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
      if (cols.childElementCount) tradingNodes.push(cols);

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
        attentionNodes.push(card);
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
        todayNodes.push(ui.h('div', { class: `alert ${over.length ? 'alert-danger' : 'alert-warn'}` },
          ui.h('strong', {}, over.length ? 'You are over your plan. ' : 'Your plan is nearly full. '),
          [
            ...over.map(([noun, cap]) => `${cap.used} ${noun} in use against a plan limit of ${cap.allowed}`),
            ...nearly.map(([noun, cap]) => `${cap.used} of ${cap.allowed} ${noun}`),
          ].join(' and '),
          ` on the ${plan.plan} plan${plan.renewalDate ? `, renewing ${U.date(plan.renewalDate)}` : ''}. `,
          over.length ? 'Nothing has been removed, but the next one will be refused until one is deactivated or the plan is raised. ' : '',
          ui.h('button', { class: 'link-btn', onClick: () => SR.app.navigate('/plan') }, 'See the plan')));
      }
      if (!tradingNodes.length) {
        tradingNodes.push(ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' },
          ui.h('h2', {}, 'Nothing sold in this window'),
          ui.h('p', { class: 'sub' }, 'Best sellers and category totals appear here once this period has receipts.'))));
      }
      if (!attentionNodes.length) {
        attentionNodes.push(ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' },
          ui.h('h2', {}, 'Nothing needs you'),
          ui.h('p', { class: 'sub' }, 'No expiry, till variance, expense or delivery is waiting on this screen.'))));
      }
      host.replaceChildren(ui.sectionTabs({
        remember: 'sr.dashTab',
        sections: [
          { id: 'today', label: 'Today', nodes: todayNodes },
          { id: 'trading', label: 'Trading', nodes: tradingNodes },
          { id: 'attention', label: 'Attention', nodes: attentionNodes },
        ],
      }));
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
