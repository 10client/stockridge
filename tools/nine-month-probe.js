'use strict';
// Local two-way probe. Three trading quarters, run one after another, across
// every vertical. It does not open a live database. A write is only counted
// when the same fact can be read back.

const fs = require('node:fs');
const path = require('node:path');

const { openDatabase, migrate } = require('../server/lib/db');
const { createHttpApp } = require('../server/app');
const { buildSeedSql } = require('./d1-seed');
const { PROFILE_CODES } = require('../domain/verticals');
const { modulesOf } = require('../domain/modules');
const { watToday, addDays } = require('../domain/time');

const PERIODS = [
  { id: 'Q1', soldAt: '2026-02-16 10:00:00', label: '2026-01-13 to 2026-04-12' },
  { id: 'Q2', soldAt: '2026-05-18 11:00:00', label: '2026-04-13 to 2026-07-12' },
  { id: 'Q3', soldAt: '2026-08-17 12:00:00', label: '2026-07-13 to 2026-10-12' },
];

const REPORT = path.join(__dirname, '..', '.data', 'nine-month-probe.json');

function save(report) {
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
}

async function call(app, token, method, url, body) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await app.fetch(new Request('http://local' + url, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  }));
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = { raw: text.slice(0, 240) }; }
  return { status: res.status, json, text };
}

function codeOf(json) {
  if (!json) return '';
  return json.code || json.error || (json.message ? String(json.message).slice(0, 180) : '');
}

function q(params) {
  return Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');
}

function scope(businessId, branchId) {
  return '?' + q({ business_id: businessId, branch_id: branchId });
}

async function main() {
  const file = path.join(__dirname, '..', '.data', 'nine-month-probe.db');
  for (const suffix of ['', '-wal', '-shm']) {
    const target = file + suffix;
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
  }
  const db = openDatabase({ file });
  const report = {
    started: new Date().toISOString(),
    database: file,
    periods: PERIODS,
    verticals: [],
    dataManagement: [],
    closing: [],
    failures: [],
  };
  const fail = (where, detail) => {
    report.failures.push({ where, detail: String(detail).slice(0, 300) });
  };

  try {
    await migrate(db);
    const seed = await buildSeedSql({ username: 'admin', pin: '1234', businessName: null, adminName: 'Probe Administrator' });
    await db.exec(seed.sql);
    const app = createHttpApp({ db, jwtSecret: 'nine-month-probe-secret-long-enough', settings: {} });

    const login = await call(app, null, 'POST', '/api/auth/login', { username: 'admin', pin: '1234', deviceId: 'nine-month' });
    if (login.status !== 200) throw new Error('admin login ' + login.status + ' ' + codeOf(login.json));
    const admin = login.json.token;

    const cap = await call(app, admin, 'PUT', '/api/settings', { max_businesses: 20, max_branches: 40, max_staff: 200 });
    if (cap.status !== 200) throw new Error('plan cap ' + cap.status + ' ' + codeOf(cap.json));
    const plan = await call(app, admin, 'GET', '/api/plan');
    report.plan = { status: plan.status, maxBusinesses: plan.json && plan.json.businesses && plan.json.businesses.allowed };

    const shops = [];
    for (let i = 0; i < PROFILE_CODES.length; i += 1) {
      const code = PROFILE_CODES[i];
      const n = String(i + 1).padStart(2, '0');
      const row = { code, modules: modulesOf(code), staff: {}, sales: {}, gates: {}, modulesExercised: {} };
      report.verticals.push(row);
      const created = await call(app, admin, 'POST', '/api/businesses', {
        name: 'Probe ' + code.replace(/_/g, ' '),
        profile_code: code,
        seed_catalogue: true,
        vat_registered: false,
        branch: { name: 'Main', code: 'P' + n + 'A', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL' },
      });
      if (created.status !== 201) {
        fail(code + ' create', created.status + ' ' + codeOf(created.json));
        save(report);
        continue;
      }
      row.businessId = created.json.id;
      row.branchA = created.json.branchId || created.json.branch_id;
      const readBiz = await call(app, admin, 'GET', '/api/businesses');
      const found = ((readBiz.json && readBiz.json.data) || []).find((b) => b.id === row.businessId);
      row.readBack = readBiz.status === 200 && found && found.profile_code === code;
      if (!row.readBack) fail(code + ' read', readBiz.status + ' ' + (found ? found.profile_code : 'missing'));

      const second = await call(app, admin, 'POST', '/api/branches' + scope(row.businessId), {
        name: 'Warehouse', code: 'P' + n + 'B', city: 'Lagos', state: 'Lagos', branch_type: 'WAREHOUSE', business_id: row.businessId,
      });
      if (second.status !== 201) fail(code + ' branch', second.status + ' ' + codeOf(second.json));
      row.branchB = second.json && second.json.id;
      const branches = await call(app, admin, 'GET', '/api/branches' + scope(row.businessId));
      const branchRows = (branches.json && (branches.json.data || branches.json.branches)) || [];
      row.branchCount = Array.isArray(branchRows) ? branchRows.length : 0;
      if (row.branchCount < 2) fail(code + ' branches-read', branches.status + ' count ' + row.branchCount);

      const people = [
        ['owner', 'OWNER', null, 'p' + n + '-owner', 'Proprietor'],
        ['managerA', 'MANAGER', row.branchA, 'p' + n + '-mgr-a', 'Branch manager'],
        ['managerB', 'MANAGER', row.branchB, 'p' + n + '-mgr-b', 'Branch manager'],
        ['cashierA', 'STAFF', row.branchA, 'p' + n + '-cash-a', 'Cashier'],
        ['cashierB', 'STAFF', row.branchB, 'p' + n + '-cash-b', 'Cashier'],
      ];
      for (const [key, role, branchId, username, title] of people) {
        const body = {
          role, full_name: title + ' ' + code, username, pin: '2468', confirm_pin: '2468',
          business_id: row.businessId, job_title: title,
        };
        if (branchId) body.branch_id = branchId;
        const made = await call(app, admin, 'POST', '/api/users' + scope(row.businessId, branchId), body);
        row.staff[key] = { status: made.status, id: made.json && made.json.id, username };
        if (made.status !== 201) fail(code + ' ' + key, made.status + ' ' + codeOf(made.json));
      }
      const ownerLogin = await call(app, null, 'POST', '/api/auth/login', { username: 'p' + n + '-owner', pin: '2468', deviceId: 'probe-' + n });
      const cashierLogin = await call(app, null, 'POST', '/api/auth/login', { username: 'p' + n + '-cash-a', pin: '2468', deviceId: 'probe-c-' + n });
      row.staff.ownerToken = ownerLogin.status === 200;
      row.staff.cashierToken = cashierLogin.status === 200;
      if (!row.staff.ownerToken) fail(code + ' owner-login', ownerLogin.status + ' ' + codeOf(ownerLogin.json));
      if (!row.staff.cashierToken) fail(code + ' cashier-login', cashierLogin.status + ' ' + codeOf(cashierLogin.json));
      row.tokens = {
        owner: ownerLogin.json && ownerLogin.json.token,
        cashier: cashierLogin.json && cashierLogin.json.token,
        manager: null,
      };
      const mgrLogin = await call(app, null, 'POST', '/api/auth/login', { username: 'p' + n + '-mgr-a', pin: '2468', deviceId: 'probe-m-' + n });
      row.staff.managerToken = mgrLogin.status === 200;
      row.tokens.manager = mgrLogin.json && mgrLogin.json.token;
      if (!row.staff.managerToken) fail(code + ' manager-login', mgrLogin.status + ' ' + codeOf(mgrLogin.json));

      const me = await call(app, row.tokens.owner, 'GET', '/api/auth/me');
      const mine = ((me.json && me.json.businesses) || []).find((b) => b.id === row.businessId) || (me.json && me.json.business);
      row.modulesFromMe = mine && mine.modules ? mine.modules : null;

      const nafdac = await call(app, row.tokens.owner, 'GET', '/api/nafdac' + scope(row.businessId) + '&q=para&limit=2');
      const book = await call(app, row.tokens.owner, 'GET', '/api/agreements' + scope(row.businessId));
      const register = await call(app, row.tokens.owner, 'GET', '/api/pharmacy/register' + scope(row.businessId));
      row.gates = {
        nafdac: nafdac.status,
        agreements: book.status,
        register: register.status,
      };
      const expect = (name, status, on) => {
        const wanted = on ? 200 : 403;
        if (status !== wanted) fail(code + ' gate ' + name, 'got ' + status + ', wanted ' + wanted);
      };
      expect('nafdac', nafdac.status, row.modules.nafdac);
      expect('agreements', book.status, row.modules.hireBook);
      expect('register', register.status, row.modules.dispensing);

      const products = await call(app, row.tokens.manager, 'GET', '/api/products' + scope(row.businessId) + '&limit=40');
      const list = ((products.json && (products.json.data || products.json.products)) || []).filter((p) => p.business_id === row.businessId);
      const plain = (p) => !Number(p.requires_serial) && !Number(p.tracks_variants);
      const sellable = list.find((p) => plain(p) && Number(p.offers_sale) !== 0)
        || list.find((p) => plain(p))
        || list.find((p) => Number(p.offers_sale) !== 0 || Number(p.offers_lease) || Number(p.offers_hire))
        || list[0];
      row.product = sellable ? {
        id: sellable.id, name: sellable.name, price: sellable.selling_price,
        unit: sellable.base_unit_code || sellable.unit_code || null,
        offersSale: Number(sellable.offers_sale) !== 0,
      } : null;
      if (!row.product) {
        const made = await call(app, row.tokens.owner, 'POST', '/api/products' + scope(row.businessId), {
          name: 'Probe piece', sku: 'PR-' + n, selling_price: 1500, cost_price: 800,
          offers_sale: true, business_id: row.businessId,
        });
        if (made.status === 201) {
          row.product = { id: made.json.id, name: 'Probe piece', price: 1500, unit: 'PIECE', offersSale: true };
        } else fail(code + ' catalogue', products.status + ' create ' + made.status + ' ' + codeOf(made.json));
      }

      if (row.product && row.tokens.manager) {
        const received = await call(app, row.tokens.manager, 'POST', '/api/stock/receive' + scope(row.businessId, row.branchA), {
          product_id: row.product.id,
          quantity: 40,
          unit_code: row.product.unit || undefined,
          cost_price: 500,
          selling_price: Number(row.product.price) > 0 ? Number(row.product.price) : 1500,
          expiry_date: row.modules.expiry ? '2027-12-31' : undefined,
          business_id: row.businessId,
          branch_id: row.branchA,
        });
        row.received = received.status;
        if (received.status !== 201 && received.status !== 200) fail(code + ' receive', received.status + ' ' + codeOf(received.json));
        const stock = await call(app, row.tokens.manager, 'GET', '/api/stock' + scope(row.businessId, row.branchA) + '&q=' + encodeURIComponent(row.product.name || ''));
        row.stockRead = stock.status;
        if (row.branchB && (received.status === 201 || received.status === 200)) {
          const moved = await call(app, row.tokens.manager, 'POST', '/api/transfers' + scope(row.businessId, row.branchA) + '&from_branch_id=' + encodeURIComponent(row.branchA), {
            to_branch_id: row.branchB,
            from_branch_id: row.branchA,
            business_id: row.businessId,
            items: [{ product_id: row.product.id, quantity: 2, unit_code: row.product.unit || undefined }],
          });
          row.transfer = moved.status;
          if (moved.status !== 201) fail(code + ' transfer', moved.status + ' ' + codeOf(moved.json));
          const mgrB = await call(app, null, 'POST', '/api/auth/login', { username: 'p' + n + '-mgr-b', pin: '2468', deviceId: 'probe-mb-' + n });
          row.tokens.managerB = mgrB.json && mgrB.json.token;
          if (moved.json && moved.json.id && row.tokens.managerB) {
            const booked = await call(app, row.tokens.managerB, 'POST', '/api/transfers/' + moved.json.id + '/receive' + scope(row.businessId, row.branchB), {});
            row.transferReceived = booked.status;
            if (booked.status !== 200 && booked.status !== 201) fail(code + ' transfer-receive', booked.status + ' ' + codeOf(booked.json));
          }
        }
      }

      const customer = await call(app, row.tokens.owner, 'POST', '/api/customers' + scope(row.businessId, row.branchA), {
        name: 'Ada ' + code, phone: '0803' + String(1000000 + i).slice(0, 7), business_id: row.businessId, branch_id: row.branchA,
      });
      row.customer = customer.status === 201 ? customer.json.id : null;
      if (customer.status !== 201) fail(code + ' customer', customer.status + ' ' + codeOf(customer.json));

      shops.push(row);
      save(report);
      console.log('SET_UP', code, row.branchCount, row.received || '-', row.gates.nafdac + '/' + row.gates.agreements);
    }

    async function postSale(row, draft, actor) {
      const token = row.tokens[actor];
      const preview = await call(app, token, 'POST', '/api/sales/preview' + scope(row.businessId, row.branchA), draft);
      const problems = preview.json && (preview.json.problems || preview.json.message || preview.json.code);
      const total = preview.json && preview.json.totals ? Number(preview.json.totals.total) : 0;
      const lineDeposit = (draft.lines || []).reduce((sum, line) => sum + (Number(line.deposit) || 0) * (Number(line.quantity) || 1), 0);
      const depositDue = preview.json && preview.json.depositDue != null ? Number(preview.json.depositDue) : lineDeposit;
      const pay = total + depositDue;
      if (!(pay > 0)) {
        return { status: preview.status, detail: typeof problems === 'string' ? problems : JSON.stringify(problems).slice(0, 240), channel: draft.lines[0].channel || draft.sale_type };
      }
      draft.payments = [{ method: 'CASH', amount: pay }];
      const posted = await call(app, token, 'POST', '/api/sales' + scope(row.businessId, row.branchA), draft);
      const saleId = posted.json && (posted.json.saleId || posted.json.id);
      const read = saleId ? await call(app, token, 'GET', '/api/sales/' + saleId + scope(row.businessId)) : null;
      const journal = await call(app, row.tokens.owner, 'GET', '/api/accounting/journal' + scope(row.businessId) + '&from=2026-01-01&to=2026-10-13');
      const entries = (journal.json && (journal.json.data || journal.json.entries)) || [];
      return {
        status: posted.status,
        receipt: posted.json && posted.json.receiptNo,
        read: read ? read.status : 0,
        journal: journal.status,
        journalCount: Array.isArray(entries) ? entries.length : 0,
        detail: posted.status >= 400 ? (codeOf(posted.json) + ' ' + JSON.stringify(posted.json && posted.json.problems || '').slice(0, 180)) : '',
        channel: (draft.lines[0] && draft.lines[0].channel) || draft.sale_type,
      };
    }

    function lineFor(row, channel, startOn) {
      const line = { product_id: row.product.id, quantity: 1 };
      if (row.product.unit) line.unit_code = row.product.unit;
      if (channel === 'WHOLESALE') line.channel = 'WHOLESALE';
      if (channel === 'LEASE') {
        line.channel = 'LEASE';
        line.starts_on = startOn;
        line.months = 9;
        line.rate = 20000;
        line.deposit = 5000;
      }
      if (channel === 'HIRE') {
        line.channel = 'HIRE';
        line.starts_on = startOn;
        line.ends_on = addDays(startOn, 2);
        line.periods = 2;
        line.rate = 4000;
        line.deposit = 1000;
      }
      return line;
    }

    async function sell(row, { actor, soldAt, channel, startOn }) {
      if (!row.product || !row.tokens[actor]) return { status: 0, detail: 'missing product or actor' };
      if ((channel === 'RETAIL' || channel === 'WHOLESALE') && row.product.offersSale === false) {
        const turned = await call(app, row.tokens.owner, 'PUT', '/api/products/' + row.product.id + scope(row.businessId), {
          offers_sale: true, selling_price: Number(row.product.price) > 0 ? Number(row.product.price) : 1500,
        });
        if (turned.status !== 200) return { status: turned.status, detail: codeOf(turned.json) };
        row.product.offersSale = true;
      }
      if (channel === 'LEASE') {
        await call(app, row.tokens.owner, 'PUT', '/api/products/' + row.product.id + scope(row.businessId), {
          offers_lease: true, lease_price_per_month: 20000, lease_deposit: 5000,
        });
      }
      const draft = {
        sale_type: channel === 'WHOLESALE' ? 'WHOLESALE' : 'RETAIL',
        lines: [lineFor(row, channel, startOn || watToday())],
        walk_in_name: 'Walk-in ' + (soldAt || 'today'),
        walk_in_phone: '08020001122',
        customer_id: row.customer,
        business_id: row.businessId,
        branch_id: row.branchA,
        notes: channel + ' probe sale',
      };
      if (soldAt) draft.sold_at = soldAt;
      return postSale(row, draft, actor);
    }

    for (const period of PERIODS) {
      for (const row of shops) {
        if (row.code === 'LEASING') {
          const posted = await call(app, row.tokens.owner, 'POST', '/api/accounting/journal' + scope(row.businessId, row.branchA), {
            description: period.id + ' lease income recognised for the quarter',
            entry_date: period.soldAt.slice(0, 10),
            business_id: row.businessId,
            branch_id: row.branchA,
            lines: [
              { account_code: '1200', debit: 20000, credit: 0, description: 'Rent receivable' },
              { account_code: '4030', debit: 0, credit: 20000, description: 'Lease income' },
            ],
          });
          const read = await call(app, row.tokens.owner, 'GET', '/api/accounting/journal' + scope(row.businessId) + '&from=' + period.soldAt.slice(0, 10) + '&to=' + period.soldAt.slice(0, 10));
          const entries = (read.json && (read.json.data || read.json.entries)) || [];
          row.sales[period.id] = {
            status: posted.status, channel: 'JOURNAL', receipt: posted.json && posted.json.entryNo,
            read: entries.length ? 200 : read.status, journal: read.status, journalCount: entries.length,
            detail: posted.status === 201 ? 'A lease cannot start in the past, so the quarter is a general entry.' : codeOf(posted.json),
          };
          if (posted.status !== 201 || !entries.length) fail(row.code + ' ' + period.id, posted.status + ' ' + codeOf(posted.json));
          continue;
        }
        const channel = period.id === 'Q2' && row.modules.wholesale ? 'WHOLESALE' : 'RETAIL';
        const result = await sell(row, { actor: 'owner', soldAt: period.soldAt, channel });
        row.sales[period.id] = result;
        if (result.status !== 201) fail(row.code + ' ' + period.id, result.status + ' ' + result.detail);
        else if (result.read !== 200) fail(row.code + ' ' + period.id + ' read', String(result.read));
        else if (result.journal !== 200 || !result.journalCount) fail(row.code + ' ' + period.id + ' journal', result.journal + ' count ' + result.journalCount);
      }
      save(report);
      console.log('PERIOD', period.id, 'failures', report.failures.length);
    }

    for (const row of shops) {
      if (row.code === 'LEASING') {
        const live = await sell(row, { actor: 'owner', channel: 'LEASE', startOn: watToday() });
        row.sales.LIVE = live;
        if (live.status !== 201) fail(row.code + ' live-lease', live.status + ' ' + live.detail);
        const cashierLease = await sell(row, { actor: 'cashier', channel: 'LEASE', startOn: watToday() });
        row.sales.CASHIER = cashierLease;
        if (cashierLease.status !== 201) fail(row.code + ' cashier-lease', cashierLease.status + ' ' + cashierLease.detail);
        continue;
      }
      const till = await call(app, row.tokens.cashier, 'POST', '/api/tills/open' + scope(row.businessId, row.branchA), { opening_cash: 0 });
      row.till = till.status;
      const today = await sell(row, { actor: 'cashier', channel: 'RETAIL' });
      row.sales.CASHIER = today;
      if (today.status !== 201) fail(row.code + ' cashier', today.status + ' ' + today.detail);
      else if (today.read !== 200) fail(row.code + ' cashier-read', String(today.read));
    }

    async function cleanup(row, mode, phrase, dates) {
      const exported = await call(app, row.tokens.owner, 'GET', '/api/reports/export' + scope(row.businessId) + '&report=SALES&from=2026-01-01&to=2026-10-12');
      const body = {
        mode, phrase, export_confirmed: true, retention_acknowledged: true, business_id: row.businessId,
        start_date: dates && dates.start, end_date: dates && dates.end,
      };
      const preview = await call(app, row.tokens.owner, 'POST', '/api/data-management/purge/preview' + scope(row.businessId), body);
      const run = await call(app, row.tokens.owner, 'POST', '/api/data-management/purge' + scope(row.businessId), body);
      const history = await call(app, row.tokens.owner, 'GET', '/api/data-management/history' + scope(row.businessId));
      const runs = (history.json && (history.json.data || history.json.runs)) || [];
      const item = {
        business: row.code,
        mode,
        export: exported.status,
        preview: preview.status,
        run: run.status,
        ok: run.json && run.json.ok,
        removed: run.json && run.json.total,
        history: history.status,
        historyCount: Array.isArray(runs) ? runs.length : 0,
        detail: run.status >= 400 ? codeOf(run.json) : '',
      };
      report.dataManagement.push(item);
      if (exported.status !== 200) fail(row.code + ' export', exported.status + ' ' + codeOf(exported.json));
      if (run.status !== 200 || !item.ok) fail(row.code + ' purge ' + mode, run.status + ' ' + item.detail);
      if (!item.historyCount) fail(row.code + ' purge-history', history.status + ' count ' + item.historyCount);
      return item;
    }

    const electronics = shops.find((s) => s.code === 'ELECTRONICS');
    const furniture = shops.find((s) => s.code === 'FURNITURE');
    const wholesale = shops.find((s) => s.code === 'WHOLESALE_RETAIL');
    for (const row of shops) {
      if (!row.product || !row.tokens) continue;
      if (row.modules.nafdac) {
        const search = await call(app, row.tokens.owner, 'GET', '/api/nafdac' + scope(row.businessId) + '&q=amoxicillin&limit=5');
        const fresh = ((search.json && search.json.data) || []).find((r) => !r.adopted_id);
        let adopted = null;
        if (fresh) {
          adopted = await call(app, row.tokens.owner, 'POST', '/api/nafdac/' + encodeURIComponent(fresh.id) + '/adopt', {
            business_id: row.businessId, selling_price: 900, cost_price: 400, name: fresh.product_name,
          });
        }
        row.modulesExercised.nafdac = { search: search.status, adopt: adopted ? adopted.status : 0 };
        if (search.status !== 200 || !fresh || !adopted || (adopted.status !== 201 && adopted.status !== 200)) {
          fail(row.code + ' greenbook', search.status + ' adopt ' + (adopted ? adopted.status + ' ' + codeOf(adopted.json) : 'none'));
        }
      }
      if (row.modules.hire && row.code !== 'LEASING') {
        await call(app, row.tokens.owner, 'PUT', '/api/products/' + row.product.id + scope(row.businessId), {
          offers_hire: true, hire_price_per_day: 4000, hire_deposit: 1000,
        });
        const draft = {
          sale_type: 'RETAIL',
          lines: [{ product_id: row.product.id, quantity: 1, channel: 'HIRE', starts_on: watToday(), ends_on: addDays(watToday(), 2), periods: 2, rate: 4000, deposit: 1000 }],
          walk_in_name: 'Hire Customer', walk_in_phone: '08031112233',
          business_id: row.businessId, branch_id: row.branchA,
        };
        const preview = await call(app, row.tokens.owner, 'POST', '/api/sales/preview' + scope(row.businessId, row.branchA), draft);
        const hireDeposit = 1000;
        const pay = Number(preview.json && preview.json.totals && preview.json.totals.total) + Number(preview.json && preview.json.depositDue != null ? preview.json.depositDue : hireDeposit);
        draft.payments = [{ method: 'CASH', amount: pay || 1 }];
        const posted = pay > 0 ? await call(app, row.tokens.owner, 'POST', '/api/sales' + scope(row.businessId, row.branchA), draft) : preview;
        const again = await call(app, row.tokens.owner, 'GET', '/api/agreements' + scope(row.businessId));
        const rows = (again.json && again.json.data) || [];
        row.modulesExercised.hire = { status: posted.status, book: Array.isArray(rows) ? rows.length : 0 };
        if (posted.status !== 201 || !rows.length) fail(row.code + ' hire', posted.status + ' ' + codeOf(posted.json) + ' book ' + rows.length);
      }
      if (row.modules.lease && row.code !== 'LEASING') {
        const leased = await sell(row, { actor: 'owner', channel: 'LEASE', startOn: watToday() });
        row.modulesExercised.lease = leased.status;
        if (leased.status !== 201) fail(row.code + ' lease', leased.status + ' ' + leased.detail);
      }
      if (row.modules.instalments && row.customer) {
        const plan = await call(app, row.tokens.manager, 'POST', '/api/instalments' + scope(row.businessId, row.branchA), {
          customer_id: row.customer, principal: 10000, deposit_amount: 3000, tenure_months: 3,
          interest_percent: 5, schedule_start: '2026-08-01', business_id: row.businessId, branch_id: row.branchA,
        });
        row.modulesExercised.instalments = plan.status;
        if (plan.status !== 201) fail(row.code + ' instalment', plan.status + ' ' + codeOf(plan.json));
      }
      if (row.modules.deliveries && row.code !== 'LEASING') {
        const draft = {
          sale_type: 'RETAIL',
          lines: [{ product_id: row.product.id, quantity: 1, unit_code: row.product.unit || undefined }],
          delivery_required: true, delivery_fee: 1500, delivery_address: '12 Adeola Odeku, Victoria Island, Lagos',
          walk_in_name: 'Delivery Customer',
          business_id: row.businessId, branch_id: row.branchA,
        };
        const preview = await call(app, row.tokens.owner, 'POST', '/api/sales/preview' + scope(row.businessId, row.branchA), draft);
        const total = Number(preview.json && preview.json.totals && preview.json.totals.total) || 0;
        draft.payments = [{ method: 'CASH', amount: total || 1 }];
        const posted = total > 0 ? await call(app, row.tokens.owner, 'POST', '/api/sales' + scope(row.businessId, row.branchA), draft) : preview;
        row.modulesExercised.delivery = posted.status;
        if (posted.status !== 201) fail(row.code + ' delivery', posted.status + ' ' + codeOf(posted.json));
      }
    }


    if (electronics) await cleanup(electronics, 'PERIOD', 'DELETE SELECTED PERIOD', { start: '2026-02-01', end: '2026-02-28' });
    if (furniture) await cleanup(furniture, 'CLEAR_OPERATIONAL_KEEP_ACCOUNTING', 'CLEAR OPERATIONS KEEP ACCOUNTING');
    if (wholesale) await cleanup(wholesale, 'CLEAR_OPERATIONS_KEEP_ACCOUNTING_AND_STOCK', 'CLEAR OPERATIONS KEEP ACCOUNTING AND STOCK');
    save(report);
    console.log('DATA_MANAGEMENT', report.dataManagement.map((d) => d.mode + ':' + d.run).join(' '));

    for (const row of shops) {
      if (!row.tokens || !row.tokens.owner) continue;
      const posted = await call(app, row.tokens.owner, 'POST', '/api/accounting/journal' + scope(row.businessId, row.branchA), {
        description: 'Nine-month close, proprietor drawing recorded',
        entry_date: '2026-10-12',
        business_id: row.businessId,
        branch_id: row.branchA,
        lines: [
          { account_code: '3200', debit: 1000, credit: 0, description: 'Drawings' },
          { account_code: '1000', debit: 0, credit: 1000, description: 'Cash' },
        ],
      });
      const trial = await call(app, row.tokens.owner, 'GET', '/api/accounting/trial-balance' + scope(row.businessId) + '&as_at=2026-10-12');
      const found = await call(app, row.tokens.owner, 'GET', '/api/accounting/journal' + scope(row.businessId) + '&from=2026-10-01&to=2026-10-12');
      const entries = (found.json && (found.json.data || found.json.entries)) || [];
      const hit = Array.isArray(entries) && entries.some((e) => String(e.entry_no || e.entryNo || '') === String(posted.json && posted.json.entryNo) || /proprietor drawing/i.test(String(e.description || '')));
      const item = {
        code: row.code,
        status: posted.status,
        entryNo: posted.json && posted.json.entryNo,
        read: hit,
        trial: trial.status,
        balances: trial.json && (trial.json.balances === true || trial.json.balanced === true || (trial.json.totals && trial.json.totals.balanced)),
        detail: posted.status >= 400 ? codeOf(posted.json) : '',
      };
      report.closing.push(item);
      if (posted.status !== 201) fail(row.code + ' close', posted.status + ' ' + item.detail);
      else if (!hit) fail(row.code + ' close-read', 'entry not in the journal');
    }

    for (const row of report.verticals) {
      if (row.tokens) delete row.tokens;
      if (row.staff) {
        delete row.staff.ownerToken;
      }
    }
    report.finished = new Date().toISOString();
    report.ok = report.failures.length === 0;
    save(report);
    console.log('DONE', report.ok ? 'ok' : 'failed', report.failures.length);
    console.log(report.failures.slice(0, 40).map((f) => f.where + ' — ' + f.detail).join('\n'));
    process.exit(report.ok ? 0 : 1);
  } finally {
    try { db.close(); } catch (e) { /* closed */ }
  }
}

main().catch((err) => {
  console.error('PROBE', err && err.stack ? err.stack : err);
  process.exit(1);
});
