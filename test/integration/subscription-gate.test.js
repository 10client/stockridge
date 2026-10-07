'use strict';
// =====================================================================
// test/integration/subscription-gate.test.js — WHAT A SUSPENSION ACTUALLY STOPS
// =====================================================================
// `assertSubscriptionActive` has always read well: "blocks every mutating request when
// the subscription is SUSPENDED or EXPIRED. READ access is deliberately preserved: a
// client who has not paid must still be able to export their own data." And it was
// wired to THREE routes — create business, create branch, create staff.
//
// So a client who stopped paying kept ringing sales, receiving stock, paying suppliers,
// posting journals and approving expenses. The only thing a suspension cost them was
// the ability to add a fourth branch. The vendor's one real commercial lever did
// nothing to the thing the invoice is for, and it looked like it worked: the status
// changed on the Subscription screen, the caps kept binding, and everything that trades
// carried on.
//
// The gate now runs in the request pipeline (server/routes/index.js), so a route is
// covered the day it is written. This file is the two directions of that:
//
//   FRONT TO BACK  a sale rings while the account is active; the administrator
//                  suspends it; the next sale is refused with a code the device can
//                  act on, and the books show nothing was written.
//   BACK TO FRONT  the reads still answer, the queue on a tablet still reports, the
//                  register still takes licences, a cashier can still be sacked, and
//                  the vendor can still work on the instance they are trying to fix.
//
// and the one thing it must never become: a way for the client to lift their own
// suspension (they cannot — those six fields are ADMIN-only at every status).
// =====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const { tradingDeployment, ADMIN_PIN } = require('../helpers/deployment');
// WAT, not UTC: the schema stores the shop's local time, and a sale stamped in UTC by a
// test is a sale in yesterday's books for every hour between midnight and 01:00.
const { watNow, watToday, addDays } = require('../../domain/time');

const STAFF_PIN = '70701';

test('a suspended subscription stops the books, and nothing else', async (t) => {
  const w = await tradingDeployment({ label: 'susp' });
  try {
    const admin = w.adminToken;
    const owner = w.ownerToken;
    const { branchId, businessId, product, baseUnit, variantId, price } = w;
    const scope = w.scope;

    let counter = 0;
    const saleBody = () => ({
      branch_id: branchId,
      business_id: businessId,
      sale_type: 'RETAIL',
      sold_at: watNow(),
      device_id: 'susp-device',
      payments: [{ method: 'CASH', amount: price }],
      lines: [{ product_id: product.id, variant_id: variantId || undefined, quantity: 1, unit_code: baseUnit, unit_price: price }],
    });
    const ring = () => {
      counter += 1;
      return w.call('POST', '/api/sales', { token: owner, idempotencyKey: `susp-sale-${counter}`, body: saleBody() });
    };
    const salesCount = async () => Number(await w.db.scalar('SELECT COUNT(*) FROM sales'));
    // A sync batch answers `{results:{operations:[…]}}`, and one that refused some of
    // its operations answers 207 rather than 200. The device reads it per operation.
    const opsOf = (r) => (((r.json || {}).results && r.json.results.operations) || (r.json || {}).operations || []);
    const setStatus = (token, status) => w.call('PUT', '/api/settings', { token, body: { subscription_status: status } });

    // A seat to sack later. Sacking a cashier is security, not trading, and the gate
    // must not stand between an owner and a stolen PIN.
    const staffCreated = await w.call('POST', '/api/users', {
      token: owner,
      body: { full_name: 'Susp Staff', username: 'susp-staff', role: 'STAFF', pin: STAFF_PIN, confirm_pin: STAFF_PIN, branch_id: branchId },
    });
    assert.equal(staffCreated.status, 201, `the fixture could not create a staff seat: ${staffCreated.text.slice(0, 200)}`);
    const staffId = staffCreated.json.id;

    // ------------------------------------------------------------------
    // FRONT TO BACK
    // ------------------------------------------------------------------
    await t.test('with the account active, the shop rings a sale', async () => {
      const res = await ring();
      assert.equal(res.status, 201, `a sale was refused on an ACTIVE subscription: ${res.status} ${res.text.slice(0, 200)}`);
      assert.ok(res.json.saleId, 'the sale must come back with an id');
    });

    await t.test('the administrator suspends the account', async () => {
      const res = await setStatus(admin, 'SUSPENDED');
      assert.equal(res.status, 200, `the administrator could not suspend the account: ${res.text.slice(0, 200)}`);
      const settings = await w.call('GET', '/api/settings', { token: owner });
      assert.equal(settings.json.settings.subscription_status, 'SUSPENDED');
    });

    await t.test('the next sale is refused, with a code the device can act on', async () => {
      const before = await salesCount();
      const res = await ring();
      assert.equal(res.status, 402,
        `a suspended shop rang a sale (${res.status}). This is the defect the gate exists for: the account status changed and nothing that trades noticed`);
      assert.equal(res.json.code, 'SUBSCRIPTION_NOT_ACTIVE', `the refusal came back as ${res.json.code}`);
      const said = String(res.json.error || res.json.message || '');
      assert.match(said, /SUSPENDED/i, `the refusal must name the status, not just fail: ${said}`);
      assert.match(said, /reading|export/i, 'and it must say what still works, or the shop assumes the whole app is dead');
      assert.equal(await salesCount(), before,
        'the refusal left a row behind. A refused sale that half-writes is worse than one that was accepted');
    });

    await t.test('and so is everything else that moves money or stock', async () => {
      const refused = [
        ['stock receive', 'POST', '/api/stock/receive', { branch_id: branchId, product_id: product.id, unit_code: baseUnit, quantity: 1, cost_price: 100, selling_price: price }],
        ['stock adjust', 'POST', '/api/stock/adjust', { branch_id: branchId, product_id: product.id, variant_id: variantId || undefined, quantity_delta: -1, reason: 'probe' }],
        ['expense', 'POST', '/api/expenses', { branch_id: branchId, category: 'OTHER', description: 'susp probe', amount: 100, expense_date: watToday() }],
        ['journal', 'POST', '/api/accounting/journal', { branch_id: branchId, entry_date: watToday(), narration: 'susp probe', lines: [{ account_code: '1000', debit: 100 }, { account_code: '4000', credit: 100 }] }],
        ['customer payment', 'POST', '/api/customers', { branch_id: branchId, name: 'Susp Probe Customer', customer_type: 'RETAIL' }],
        ['purchase order', 'POST', '/api/purchase-orders', { branch_id: branchId, supplier_name: 'Susp Probe Supplies', lines: [{ product_id: product.id, quantity: 1, unit_cost: 100, unit_code: baseUnit }] }],
        ['supplier', 'POST', '/api/suppliers', { business_id: businessId, name: 'Susp Probe Supplier' }],
        ['till', 'POST', '/api/tills/open', { branch_id: branchId, opening_float: 1000 }],
        ['product', 'POST', '/api/products', { branch_id: branchId, name: 'Susp Probe Product', cost_price: 100, selling_price: 200 }],
        ['compliance sweep', 'POST', '/api/compliance/notify', {}],
      ];
      // `compliance/notify` is the one EXEMPT entry in this list — see the next subtest.
      const expectedOpen = new Set(['compliance sweep']);
      for (const [name, method, path, body] of refused) {
        const res = await w.call(method, path, { token: owner, idempotencyKey: `susp-${name.replace(/\W+/g, '-')}`, body });
        if (expectedOpen.has(name)) {
          assert.ok(res.status < 400, `${name} must stay open while suspended (a statutory register is not a sale): ${res.status} ${res.text.slice(0, 200)}`);
          continue;
        }
        assert.equal(res.status, 402,
          `${name} answered ${res.status} on a suspended account — it should have been refused (${res.text.slice(0, 200)})`);
        assert.equal(res.json.code, 'SUBSCRIPTION_NOT_ACTIVE', `${name} was refused for the wrong reason: ${res.json.code}`);
      }
      const rows = await w.db.first('SELECT COUNT(*) AS c FROM expenses');
      assert.equal(Number(rows.c), 0, 'a refused expense reached the table');
    });

    // ------------------------------------------------------------------
    // BACK TO FRONT — what a suspension must NOT stop
    // ------------------------------------------------------------------
    await t.test('reading the books still works — an unpaid client can still see and export their own data', async () => {
      const reads = [
        ['sales', `/api/sales?${scope}&limit=5`],
        ['products', `/api/products?${scope}&limit=5`],
        ['dashboard', `/api/dashboard?${scope}`],
        ['reports', `/api/reports/sales?${scope}&limit=5`],
        ['settings', '/api/settings'],
        ['plan', '/api/plan'],
        ['compliance', `/api/compliance/records?${scope}`],
        ['expenses', `/api/expenses?${scope}&limit=5`],
      ];
      for (const [name, path] of reads) {
        const res = await w.call('GET', path, { token: owner });
        assert.equal(res.status, 200, `reading ${name} answered ${res.status} on a suspended account: ${res.text.slice(0, 180)}`);
      }
    });

    await t.test('the statutory register still takes a licence', async () => {
      const res = await w.call('POST', '/api/compliance/records', {
        token: owner,
        body: {
          branch_id: branchId, record_type: 'FIRE_SAFETY', record_number: 'SUSP-FIRE-1',
          issued_date: watToday(), expiry_date: addDays(watToday(), 300),
        },
      });
      assert.ok(res.status < 400, `recording a statutory licence answered ${res.status} while suspended: ${res.text.slice(0, 200)}. A licence is not a sale, and it has a legal deadline of its own`);
    });

    await t.test('a sacked cashier can still be sacked', async () => {
      const res = await w.call('PUT', `/api/users/${staffId}`, { token: owner, body: { is_active: false } });
      assert.ok(res.status < 400, `deactivating a staff seat answered ${res.status} while suspended: ${res.text.slice(0, 200)}. The vendor's invoice must never keep a sacked cashier signed in`);
      const row = await w.db.first('SELECT is_active FROM users WHERE id = ?', [staffId]);
      assert.equal(Number(row.is_active), 0, 'the deactivation did not land');
    });

    await t.test('the door still works: someone can sign in and change their own PIN', async () => {
      const staffCreated2 = await w.call('POST', '/api/users', {
        token: owner,
        body: { full_name: 'Susp Door', username: 'susp-door', role: 'STAFF', pin: '70702', confirm_pin: '70702', branch_id: branchId },
      });
      assert.ok(staffCreated2.status < 400, `creating a seat answered ${staffCreated2.status} while suspended: ${staffCreated2.text.slice(0, 200)}`);
      const token = await w.login('susp-door', '70702');
      const rotated = await w.call('POST', '/api/auth/change-pin', { token, body: { currentPin: '70702', newPin: '70703' } });
      assert.ok(rotated.status < 400, `changing a PIN answered ${rotated.status} while suspended: ${rotated.text.slice(0, 200)}`);
      const back = await w.call('POST', '/api/auth/login', { body: { username: 'susp-door', pin: '70703' } });
      assert.equal(back.status, 200, 'the new PIN does not work, so the change did not land');
    });

    await t.test('the alert board can still be cleared', async () => {
      const res = await w.call('POST', '/api/notifications/read-all', { token: owner });
      assert.equal(res.status, 200, `clearing alerts answered ${res.status} while suspended: ${res.text.slice(0, 200)}`);
    });

    await t.test('the client’s own configuration is still theirs — but not the commercial terms', async () => {
      const footer = await w.call('PUT', '/api/settings', { token: owner, body: { receipt_footer_text: 'Suspension probe' } });
      assert.equal(footer.status, 200, `an owner could not correct their own settings while suspended: ${footer.text.slice(0, 200)}`);

      // THE ALLOWANCE MUST NOT BE AN ESCAPE HATCH. `PUT /api/settings` is reachable
      // while suspended on purpose; the six fields that decide what was bought are not
      // writable by a client at ANY status.
      const escape = await w.call('PUT', '/api/settings', { token: owner, body: { subscription_status: 'ACTIVE' } });
      assert.equal(escape.status, 403, `an owner lifted their own suspension: ${escape.status} ${escape.text.slice(0, 200)}`);
      assert.equal(escape.json.code, 'PLATFORM_ADMIN_REQUIRED');
      const settings = await w.call('GET', '/api/settings', { token: owner });
      assert.equal(settings.json.settings.subscription_status, 'SUSPENDED', 'the status changed anyway');
      const stillRefused = await ring();
      assert.equal(stillRefused.status, 402, 'and the shop is still suspended — a refused settings write did not sneak the account back to ACTIVE');
    });

    await t.test('the vendor is never locked out of the instance they are fixing', async () => {
      const customer = await w.call('POST', '/api/customers', {
        token: admin, idempotencyKey: 'susp-admin-customer',
        body: { branch_id: branchId, name: 'Vendor Help Customer', customer_type: 'INDIVIDUAL' },
      });
      assert.ok(customer.status < 400, `the administrator was refused a write on the suspended instance: ${customer.status} ${customer.text.slice(0, 200)}. The bypass exists so the person the client telephoned can work`);
      const restore = await setStatus(admin, 'ACTIVE');
      assert.equal(restore.status, 200, 'the administrator could not restore the account');
      await setStatus(admin, 'SUSPENDED');
    });

    await t.test('a tablet that was offline reports its queued sale and is told, per operation, why', async () => {
      // THE QUEUE IS THE PART THAT HAS TO BE RIGHT. A device that has been selling
      // offline holds sales that were made before the suspension; refusing the whole
      // PUSH would leave its outbox jammed with no explanation, and quietly applying
      // them would put trade on a suspended account. The push is allowed through and
      // each replayed sale is refused on its own way through the pipeline.
      const beforePush = await salesCount();
      const push = await w.call('POST', '/api/sync/push', {
        token: owner,
        body: {
          device_id: 'susp-offline-tablet',
          client_time: new Date().toISOString(),
          operations: [{
            type: 'SALE',
            idempotency_key: `susp-queued-${Date.now()}`,
            client_id: 'susp-queued-1',
            occurred_at: new Date(Date.now() - 3600000).toISOString(),
            payload: saleBody(),
          }],
        },
      });
      assert.ok(push.status === 200 || push.status === 207,
        `the sync push answered ${push.status}: ${push.text.slice(0, 240)}. A device has to be able to report what it did; the individual operations are what get refused, and a batch that refused some is a 207`);
      const op = opsOf(push)[0];
      assert.ok(op, `the push returned no operation results: ${push.text.slice(0, 240)}`);
      assert.equal(op.status, 'REJECTED', `the queued sale was reported as ${op.status}`);
      assert.equal(op.code, 'SUBSCRIPTION_NOT_ACTIVE', `the queued sale was refused for the wrong reason: ${op.code} — ${op.message}`);
      assert.equal(op.retryable, false,
        'a 4xx decision must not be marked retryable: a device that retries a suspension forever fills its queue and hides the item a human has to look at');
      assert.equal(await salesCount(), beforePush, 'the queued sale reached the books anyway');
    });

    await t.test('and when the account is restored, the same queue drains', async () => {
      const restore = await setStatus(admin, 'ACTIVE');
      assert.equal(restore.status, 200, `the administrator could not restore the account: ${restore.text.slice(0, 200)}`);

      const beforeDrain = await salesCount();
      const key = `susp-drain-${Date.now()}`;
      const body = {
        device_id: 'susp-offline-tablet',
        operations: [{ type: 'SALE', idempotency_key: key, client_id: 'susp-drain-1', occurred_at: new Date().toISOString(), payload: saleBody() }],
      };
      const push = await w.call('POST', '/api/sync/push', { token: owner, body });
      const op = opsOf(push)[0] || {};
      assert.equal(op.status, 'APPLIED', `the queued sale came back as ${op.status}: ${op.message || push.text.slice(0, 200)}`);

      // And the SAME key pushed again is reported as already applied, not applied twice.
      const again = await w.call('POST', '/api/sync/push', { token: owner, body });
      const twice = opsOf(again)[0] || {};
      assert.equal(twice.status, 'ALREADY_APPLIED', `the replayed sale came back as ${twice.status} — an offline sale must be safe to retry`);
      const landed = (await salesCount()) - beforeDrain;
      assert.equal(landed, 1, `the same queued sale landed ${landed} time(s)`);
    });

    await t.test('an administrator is not gated by a client’s suspension', async () => {
      await setStatus(admin, 'SUSPENDED');
      const business = await w.call('POST', '/api/businesses', {
        token: admin,
        body: { name: 'Vendor Restoration Stores', profile_code: 'GENERAL_RETAIL', branch: { name: 'Restoration Branch', city: 'Abuja', state: 'FCT', opening_cash: 0 } },
      });
      assert.equal(business.status, 201, `the administrator was refused by the suspension gate: ${business.status} ${business.text.slice(0, 220)}`);
      assert.equal(await w.db.scalar('SELECT subscription_status FROM client_settings WHERE id = 1'), 'SUSPENDED',
        'the vendor creating a business must not have changed the client’s status');
    });

    await t.test('the administrator’s own seat still signs in while a client is suspended', async () => {
      const token = await w.login('admin', ADMIN_PIN);
      assert.ok(token, 'the vendor could not sign in');
    });
  } finally {
    w.cleanup();
  }
});
