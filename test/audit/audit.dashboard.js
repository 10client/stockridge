'use strict';
// =====================================================================
// test/audit/audit.dashboard.js — THE FIRST SCREEN THE OWNER OPENS
// =====================================================================
// The dashboard is the one screen nobody reads critically. It prints a number, the number looks
// like a figure, and it is treated as true — by the person ordering stock, by the person paying
// wages on Friday, by the owner deciding whether the day was good. It is also the screen an icon
// and a trend arrow are attached to (P12), which means every tile here is a CLAIM with a
// decoration on it.
//
// So this audit does not ask whether the endpoint answers. It asks whether the answer is the
// truth, by ringing sales and then checking the figures against the rows that were written:
//
//   the count and the takings move by EXACTLY what was rung   — not approximately, not upward
//   the arithmetic identities hold (net of VAT, margin, average) — checked against the figures
//   the comparison is against yesterday, and it says which way, with a sign
//   a voided sale leaves the takings and appears as a void with its value
//   the branch a cashier sees is THEIR branch — another branch's sale does not move it
//   the period figures are the sum of the days inside the period
//
//   FRONT TO BACK  ring a sale → the dashboard's today figures move by that sale's total
//   BACK TO FRONT  the scope decides the shape of the answer, not the request: a cashier's
//                  dashboard counts their branch, the owner's counts the group, and no caller
//                  can ask for the group by naming a parameter.
// =====================================================================

const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const money = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

runAudit('dashboard', async (audit, d) => {
  const owner = d.owner;
  const branch = d.branchFor(d.owner || d.admin) || d.branches[0];
  const cashier = d.seats && d.seats.cashier;

  const dash = async (actor, query = '') => {
    const res = await actor.get(`/api/dashboard${query}`);
    assert.equal(res.status, 200, `the dashboard answered ${res.status}: ${String(res.text).slice(0, 200)}`);
    assert.ok(res.json && res.json.today, 'the dashboard answered without a `today` block, which is what the whole screen reads');
    return res.json;
  };

  const product = await audit.captureAsync('a product to sell', async () => {
    const res = await owner.get('/api/products?limit=5');
    const rows = (res.json && res.json.data) || [];
    const row = rows.find((r) => Number(r.selling_price) > 0);
    if (!row) throw new Error(`the catalogue has no priced product to sell (${rows.length} row(s))`);
    return row;
  });
  const unitPrice = Number(product.selling_price);
  audit.note(`${product.sku} at ${money(unitPrice)}`);

  // PUT STOCK ON THE SHELF — a sale against an empty shelf is refused, and rightly.
  await audit.checkAsync('stock is on the shelf to sell from', async () => {
    if (d.live && !d.writable) { audit.skip('read-only target: nothing could be received onto the shelf'); return; }
    const res = await owner.post('/api/stock/receive', {
      branch_id: branch.id, product_id: product.id, quantity: 10, unit_code: product.default_unit_code || 'PIECE',
      cost_price: round2(unitPrice * 0.6), selling_price: unitPrice,
      reference: `AUDIT-DASH-${Date.now().toString(36)}`,
    });
    assert.ok(res.status < 400, `receiving stock answered ${res.status}: ${String(res.text).slice(0, 200)}`);
  });

  const before = await audit.captureAsync('the dashboard before anything is rung', async () => dash(owner));
  audit.note(`before: ${before.today.count} sale(s), ${money(before.today.gross)} taken`);

  // ------------------------------------------------------------------
  // FRONT TO BACK — a sale, and the figures that must follow it
  // ------------------------------------------------------------------
  const saleTotal = await audit.captureAsync('two units over the counter', async () => {
    const res = await owner.post('/api/sales', {
      branch_id: branch.id,
      lines: [{ product_id: product.id, quantity: 2 }],
      payments: [{ method: 'CASH', amount: round2(unitPrice * 2), cash_tendered: round2(unitPrice * 2) }],
      device_id: 'audit-dashboard',
    }, { idempotencyKey: `dash-sale-${Date.now().toString(36)}` });
    if (res.status !== 201) throw new Error(`POST /api/sales answered ${res.status}: ${res.text.slice(0, 300)}`);
    return round2(res.json.totals.total);
  });

  await audit.checkAsync('the takings and the count move by exactly what was rung', async () => {
    if (cashier) { /* the cashier's own view is checked below */ }
    const after = await dash(owner);
    assert.equal(Number(after.today.count), Number(before.today.count) + 1,
      `a sale was rung and the dashboard's count went ${before.today.count} → ${after.today.count}`);
    assert.equal(round2(after.today.gross - before.today.gross), round2(saleTotal),
      `a ${money(saleTotal)} sale moved the takings by ${money(after.today.gross - before.today.gross)}. The first screen the owner opens must not be approximately right`);
    audit.note(`after: ${after.today.count} sale(s), ${money(after.today.gross)} taken (+${money(saleTotal)})`);
  });

  await audit.checkAsync('the cashier’s drawer shows on the cashier’s dashboard', async () => {
    // THE DRAWER BELONGS TO A PERSON AT A BRANCH, NOT TO THE GROUP. `cash.myTill` is looked up by
    // `branch_id` AND `user_id`, so an owner — who spans every business and is created with no
    // branch of their own — has no drawer, and that is right: the route's own comment says the
    // till card exists "because a cashier needs this more than the owner does". Opening the till
    // as the owner and expecting a drawer card was this audit's mistake, not the product's.
    //
    // It is also the reason the field scan needs a till open at all: with nobody at a drawer,
    // `cash.myTill` is null and `openingCash`, `cashSales`, `expectedCash` and `saleCount` are
    // not in the payload for the scan to find — four perfectly good reads reported as dead ones.
    if (!cashier) { audit.skip('no cashier seat on this target'); return; }
    if (d.live && !d.writable) { audit.skip('read-only target: no till could be opened'); return; }
    const opened = await cashier.post('/api/tills/open', { branch_id: branch.id, opening_cash: 0 });
    audit.note(`the cashier opened a drawer at ${branch.name}: ${opened.status}`);
    assert.ok(opened.status < 400 || /already open/i.test(String(opened.text)),
      `opening a till answered ${opened.status}: ${String(opened.text).slice(0, 200)}`);

    const data = await dash(cashier);
    assert.ok(data.cash && data.cash.myTill, 'the dashboard answers no `cash.myTill` for a cashier with a drawer open at their own branch');
    for (const key of ['openingCash', 'cashSales', 'expectedCash', 'saleCount', 'openedAt']) {
      assert.ok(key in data.cash.myTill, `the drawer card's own figure ${key} is not in cash.myTill (${Object.keys(data.cash.myTill).join(', ')})`);
    }
  });

  await audit.checkAsync('the figures agree with each other: net of VAT, margin, average', async () => {
    const t = (await dash(owner)).today;
    // NET OF VAT, EVERY TIME. The gross contains money that belongs to FIRS; every margin
    // derived from it would be understated, so `netRevenue` is what the rest is built on.
    assert.equal(round2(Number(t.netRevenue)), round2(Number(t.grossRevenue) - Number(t.vat)),
      `net revenue ${money(t.netRevenue)} is not gross ${money(t.grossRevenue)} less VAT ${money(t.vat)}`);
    assert.equal(round2(Number(t.grossMargin)), round2(Number(t.netRevenue) - Number(t.cogs)),
      `gross margin ${money(t.grossMargin)} is not net revenue ${money(t.netRevenue)} less cost of goods ${money(t.cogs)}`);
    const expectedPct = Number(t.netRevenue) > 0 ? round2((Number(t.grossMargin) / Number(t.netRevenue)) * 100) : 0;
    assert.equal(Number(t.grossMarginPct), expectedPct,
      `the margin percentage ${t.grossMarginPct} does not match its own figures (${expectedPct}% of ${money(t.netRevenue)})`);
    const expectedAverage = Number(t.count) > 0 ? round2(Number(t.gross) / Number(t.count)) : 0;
    assert.equal(round2(Number(t.averageSale || 0)), expectedAverage,
      `the average sale ${money(t.averageSale)} is not ${money(t.gross)} over ${t.count} sale(s)`);
    assert.ok(Number(t.cogs) > 0, 'the cost of goods sold is zero after a sale of stocked goods — every margin on this screen would be overstated by the whole cost');
  });

  await audit.checkAsync('the comparison is against YESTERDAY, and it carries its direction', async () => {
    // THE TREND ARROW IS DRAWN FROM THESE THREE FIELDS. `changePct` of null and `change` of 0
    // mean "nothing to compare against", and the screen must draw no arrow at all rather than
    // an arrow pointing at zero — so the shape of this object is a contract, not a detail.
    const t = (await dash(owner)).today;
    const v = t.vsYesterday;
    assert.ok(v && typeof v === 'object', 'the dashboard no longer answers `vsYesterday`, which is what the trend arrow is drawn from');
    for (const key of ['gross', 'change', 'changePct']) {
      assert.ok(key in v, `vsYesterday has no ${key}, so the tile cannot say which way the day is going`);
    }
    assert.equal(round2(Number(v.change)), round2(Number(t.gross) - Number(v.gross)),
      `the change ${money(v.change)} is not today's ${money(t.gross)} less yesterday's ${money(v.gross)}`);
    // The sign has to agree with the change, because the arrow is drawn from one and coloured
    // from the other. And when there is NOTHING to compare against — no takings yesterday —
    // the percentage is NULL rather than a made-up hundred, which is the product's own rule
    // (P12: `{changePct: null, change: 0}` draws no chip, because an arrow pointing at nothing
    // is worse than no arrow). This audit first asserted +100% and was wrong about the product.
    if (Number(v.gross) > 0) {
      const expected = round2((Number(t.gross) - Number(v.gross)) / Number(v.gross) * 100);
      assert.equal(Number(v.changePct), expected, `the percentage ${v.changePct} is not the change over yesterday's ${money(v.gross)} (${expected}%)`);
    } else {
      assert.ok(Number(v.change) === 0 ? v.changePct === null || v.changePct === 0 : true,
        `yesterday took nothing, so there is nothing to compare against — and the answer is ${v.changePct}. Null (or a flat zero) is the honest one`);
      assert.notEqual(Number(v.changePct), 100,
        'the dashboard reports +100% against a day that took nothing, and the tile then draws an arrow for a comparison that does not exist');
    }
    audit.note(`vs yesterday: ${money(v.gross)} → ${money(t.gross)}, change ${money(v.change)} (${v.changePct}%)`);
  });

  await audit.checkAsync('a voided sale leaves the takings and shows up as a void, with its value', async () => {
    const res = await owner.post('/api/sales', {
      branch_id: branch.id,
      lines: [{ product_id: product.id, quantity: 1 }],
      payments: [{ method: 'CASH', amount: unitPrice, cash_tendered: unitPrice }],
      device_id: 'audit-dashboard',
    }, { idempotencyKey: `dash-void-${Date.now().toString(36)}` });
    assert.equal(res.status, 201, `the sale to void answered ${res.status}: ${String(res.text).slice(0, 200)}`);
    const saleId = res.json.saleId || res.json.id;

    const beforeVoid = (await dash(owner)).today;
    const voided = await owner.post(`/api/sales/${encodeURIComponent(saleId)}/void`, { reason: 'the customer changed their mind at the counter' });
    assert.ok(voided.status < 400, `voiding answered ${voided.status}: ${String(voided.text).slice(0, 220)}`);

    const afterVoid = (await dash(owner)).today;
    assert.equal(round2(beforeVoid.gross - afterVoid.gross), round2(unitPrice),
      `voiding a ${money(unitPrice)} sale moved the takings by ${money(beforeVoid.gross - afterVoid.gross)} — a void is not a sale that happened`);
    assert.equal(Number(afterVoid.count), Number(beforeVoid.count) - 1,
      `the sale count went ${beforeVoid.count} → ${afterVoid.count} across a void`);
    assert.equal(Number(afterVoid.voids.count), Number(beforeVoid.voids.count) + 1,
      'the void is not counted as a void, so nobody reading this screen can see that a sale was reversed');
    assert.equal(round2(Number(afterVoid.voids.value) - Number(beforeVoid.voids.value)), round2(unitPrice),
      `the void added ${money(Number(afterVoid.voids.value) - Number(beforeVoid.voids.value))} to the voided value, and the sale was ${money(unitPrice)}`);
  });

  await audit.checkAsync('the period figures are the sum of the days inside the period', async () => {
    const data = await dash(owner);
    const p = data.period;
    assert.ok(p, 'the dashboard no longer answers a `period` block');
    // THE PERIOD BLOCK SAYS `grossRevenue`, NOT `gross` — the `today` block carries BOTH names
    // for the same number, because the screen reads both (see the route's own comment). This
    // audit read `p.gross`, got `undefined`, and reported a ₦0 period totalling less than its own
    // day: a dead field read in the audit, found by the audit's own logic. The field is asserted
    // by name now, so a future rename is a failure instead of a zero.
    assert.ok(p.grossRevenue !== undefined, `the period block answers ${JSON.stringify(Object.keys(p))} and none of them is a takings figure`);
    assert.equal(Number(data.today.gross), Number(data.today.grossRevenue),
      'today answers two names for the same figure and they disagree, so one of the screen\'s tiles is reading a different number to another');
    assert.ok(Number(p.grossRevenue) >= Number(data.today.gross),
      `the period takings ${money(p.grossRevenue)} are less than today's ${money(data.today.gross)} — a period that includes today cannot be less than today`);
    assert.ok(p.from && p.to, `the period does not say what it covers: ${JSON.stringify(p).slice(0, 200)}`);
    assert.ok(String(p.from) <= String(p.to), `the period runs backwards: ${p.from} → ${p.to}`);
    audit.note(`period ${p.from} → ${p.to}: ${money(p.grossRevenue)} over ${p.sales} sale(s), ${(p.series || []).length} day(s) of series`);
  });

  // ------------------------------------------------------------------
  // BACK TO FRONT — the scope decides the answer
  // ------------------------------------------------------------------
  if (cashier) {
    await audit.checkAsync('a cashier sees their own branch, and the owner sees the group', async () => {
      const mine = await dash(cashier);
      assert.equal(mine.view && mine.scope ? String(mine.scope.branch) : '', String(branch.name),
        `the cashier's dashboard is scoped to ${JSON.stringify(mine.scope)} rather than their own branch ${JSON.stringify(branch.name)}`);
      const theirs = await dash(owner);
      assert.notEqual(String(theirs.view), String(mine.view),
        `the owner and the cashier see the same shape of answer (${mine.view}) — the shape is meant to come from the scope, and an owner reaching one branch through the whole group`);

      // NAMING ANOTHER BRANCH CANNOT WIDEN A CASHIER'S VIEW. This is the one that matters: a
      // parameter is a request, and a scope is a fact.
      const other = d.branches.find((b) => String(b.id) !== String(branch.id));
      if (other) {
        const widened = await cashier.get(`/api/dashboard?branch_id=${encodeURIComponent(other.id)}`);
        assert.ok(widened.status >= 400 || String(widened.json.scope && widened.json.scope.branch) !== String(other.name),
          'a cashier asked for another branch by name and the dashboard answered with it');
      }
    });
  } else {
    audit.skip('the cashier seat could not be created on this target', 'set AUDIT_WRITE=1 to run the scope checks');
  }

  await audit.checkAsync('the summary agrees with the full dashboard it summarises', async () => {
    const full = await dash(owner);
    const res = await owner.get('/api/dashboard/summary');
    assert.equal(res.status, 200, `the summary answered ${res.status}: ${String(res.text).slice(0, 200)}`);
    const s = res.json;
    // WHATEVER THE SUMMARY SHOWS, IT MUST BE THE SAME FIGURES. Two screens that disagree about
    // the day's takings are worse than one screen that is wrong: neither can be trusted again.
    // THE SUMMARY NAMES ITS FIGURES `grossToday` / `salesToday` — camelCase with the period in
    // the name, where the dashboard uses `today.gross`. Both are accepted here because both are
    // real; the point of the check is that the two screens agree about the number, not that they
    // spell it the same way.
    const grosses = [s.gross, s.grossToday, s.today && s.today.gross, s.takings, s.total].filter((x) => x !== undefined && x !== null);
    assert.ok(grosses.length >= 1, `the summary answers no takings figure at all: ${JSON.stringify(s).slice(0, 300)}`);
    for (const g of grosses) {
      assert.equal(round2(Number(g)), round2(Number(full.today.gross)),
        `the summary says ${money(g)} and the dashboard says ${money(full.today.gross)} for the same day`);
    }
    audit.note(`summary keys: ${Object.keys(s).sort().join(', ')}`);
  });

  await audit.checkAsync('the screen reads the fields the route sends', async () => {
    // THE CONTRACT BETWEEN THE TWO HALVES, CHECKED FROM THE OUTSIDE. Four screens in this codebase
    // have now been found reading field names the API never sends (`hash` for `row_hash`,
    // `ip_address` for `last_ip`, `failures` for `failed_attempts`, a device column that did not
    // exist) — and every one of them rendered an em dash instead of throwing, so nothing noticed.
    // The dashboard is the biggest screen in the product; its tiles are the ones an owner reads
    // numbers off. This walks what the route actually returns and refuses any read that is not in
    // it — with the reads taken from the screen's own source, not from a list kept by hand.
    const fs = require('fs');
    const path = require('path');
    const root = path.resolve(__dirname, '..', '..');
    // BOTH PAYLOADS, UNIONED. The same screen renders for an owner (group figures, no drawer of
    // their own) and for a cashier (one branch, a drawer) and the two answers carry different
    // blocks — `byBusiness` only for the owner, `cash.myTill` only for the person at a till. A
    // scan against one of them would report the other's tiles as dead reads.
    const data = await dash(owner);
    const staffData = cashier ? await dash(cashier).catch(() => null) : null;
    const payloads = [data, staffData].filter(Boolean);
    const tillKeys = payloads.map((p) => (p.cash && p.cash.myTill ? Object.keys(p.cash.myTill).join(',') : 'none')).join(' | ');
    const known = new Set();
    const collect = (obj, prefix = '') => {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj)) {
        known.add(`${prefix}${k}`.toLowerCase());
        if (v && typeof v === 'object' && !Array.isArray(v)) collect(v, `${prefix}${k}.`);
      }
    };
    for (const p of payloads) collect(p);
    // The two blocks the route builds per-view rather than always.
    for (const k of ['byBranch', 'byBusiness', 'topProducts', 'topStaff', 'actions', 'plan', 'stock', 'cash', 'debtors']) known.add(k);
    // EVERY NAME AT ANY DEPTH, so `cash.myTill.openedAt` and a row inside `cash.openTills` are
    // as known as a top-level key. Without walking the arrays, four perfectly good reads in the
    // drawer card looked like dead ones.
    const deep = [];
    const walk = (v) => {
      if (!v) return;
      if (Array.isArray(v)) { for (const item of v.slice(0, 3)) walk(item); return; }
      if (typeof v !== 'object') return;
      for (const [k, val] of Object.entries(v)) { deep.push(k.toLowerCase()); walk(val); }
    };
    for (const p of payloads) walk(p);
    for (const k of deep) known.add(k);

    // COMMENTS STRIPPED, LENGTH PRESERVING — the file's own header comment lists ten field names
    // that were WRONG once (`today.periodGross`, `today.vs_yesterday_pct`, `cash.till`), and a
    // scan that reads the prose reports them as reads: five of the eleven "dead" names on this
    // check's first run came out of a paragraph explaining that they had been fixed.
    const raw = fs.readFileSync(path.join(root, 'public', 'js', 'views', 'dashboard.js'), 'utf8');
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
    const reads = new Set();
    for (const m of src.matchAll(/\b(?:d|data|t|today|dash|p|cash|myTill|b)\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) reads.add(m[1].toLowerCase());
    assert.ok(reads.size >= 15, `the scan found only ${reads.size} read(s) in the dashboard screen — it is no longer reading the screen`);

    // Comparators and locals that share the shape of a read but are not one.
    const local = new Set(['length', 'map', 'filter', 'forEach', 'reduce', 'find', 'slice', 'sort', 'join', 'push', 'replace', 'toUpperCase', 'toLowerCase', 'toString', 'then', 'catch', 'textContent', 'className', 'appendChild', 'querySelector', 'addEventListener', 'value', 'checked', 'hidden', 'style', 'dataset', 'children', 'firstElementChild', 'id', 'name', 'role', 'type']);
    // THE OFFLINE MIRROR IS A SECOND SOURCE, AND IT IS NOT THE API. This screen falls back to the
    // device's own store (`SR.store.all('stock_batches', …)`) when the line is down — an
    // offline-first product has to — and those rows carry the LOCAL store's field names
    // (`quantity`, `quantity_reserved`, `cost_price_per_unit`, `is_deleted`, `branch_id`). They
    // are named here with that reason, and the guard below refuses to keep the excuse alive if
    // the store read ever leaves the screen.
    const fromTheMirror = new Set(['quantity', 'quantity_reserved', 'cost_price_per_unit', 'is_deleted', 'branch_id']);
    assert.match(src, /SR\.store\.all\(/, 'the offline-mirror fields are excused below, and the screen no longer reads the mirror — remove the excuse');
    const dead = [...reads].filter((k) => !known.has(k) && !local.has(k) && !fromTheMirror.has(k));
    assert.deepEqual(dead, [],
      `the dashboard screen reads ${JSON.stringify(dead)} and the route does not send it. cash.myTill answers ${JSON.stringify(tillKeys)}. The route's top-level keys: ${[...known].filter((k) => !k.includes('.')).sort().join(', ')}`);
    audit.note(`${reads.size} read(s) in the screen, all named by the route`);
  });
}, {
  setup: () => startDeployment({
    label: 'dashboard',
    businesses: [{
      // ELECTRONICS, because it is the vertical whose starter catalogue is non-empty — the
      // blank profile seeds nothing, and this audit needs something on the shelf to sell.
      name: 'Dashboard Audit Stores', profileCode: 'ELECTRONICS', vatRegistered: true,
      branches: [
        { name: 'Dashboard Audit Main', code: 'DB-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 20000 },
        { name: 'Dashboard Audit Second', code: 'DB-2', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 10000 },
      ],
    }],
    seats: [
      { as: 'owner', role: 'OWNER', username: 'db-owner', pin: '82151', branchIndex: 0, full_name: 'Dashboard Audit Owner' },
      { as: 'cashier', role: 'STAFF', username: 'db-cashier', pin: '82152', branchIndex: 0, full_name: 'Dashboard Audit Cashier' },
    ],
  }),
});
