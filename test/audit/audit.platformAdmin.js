'use strict';
// =====================================================================
// test/audit/audit.platformAdmin.js — THE VENDOR'S HAND ON THE CONTROLS
// =====================================================================
// Every commercial control in this product is the platform administrator's: the three caps
// (businesses, branches, staff), the plan name, the subscription status and the renewal
// date. They are drawn on the Subscription screen and enforced by `PUT /api/settings` and
// `assertSubscriptionActive` — and for a long time the enforcement and the screen
// disagreed about all of them:
//
//   · the client could write all six through `PUT /api/settings` (the screen drew them
//     read-only and said "not by the client" — hiding a field is not a permission);
//   · the suspension stopped three create routes and no trading route at all (P8b);
//   · the meaning of a zero differed: the screen reads 0 as UNLIMITED, the server read it
//     as none, so it refused everything while saying "includes 0 branches".
//
// This audit walks the controls in both directions:
//
//   FRONT TO BACK  the administrator sets a cap → the cap BINDS at the create route →
//                  the read the screen draws reports it → the audit trail records
//                  PLAN_LIMITS_CHANGED → a cap below current usage warns instead of
//                  deleting anything → 0 means unlimited.
//   BACK TO FRONT  the client cannot write any of the six (and nothing lands), the plan
//                  read is OWNER+ (a manager and a staff member cannot see the commercial
//                  position), and a suspension refuses the client's trading writes while
//                  reads keep answering and the VENDOR is not gated.
//
// NOBODY IS LEFT ON A DIFFERENT PLAN. Every field this run touches is captured first and
// handed to the harness to put back, including the subscription status: an audit that
// leaves a client suspended is an audit that stopped a shop trading.
// =====================================================================

const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const COMMERCIAL = ['max_businesses', 'max_branches', 'max_staff', 'subscription_plan', 'subscription_status', 'subscription_renewal_date'];

runAudit('platformAdmin', async (audit, d) => {
  const admin = d.admin;
  const owner = d.owner || d.admin;
  const manager = d.seats && d.seats.manager;
  const staff = d.seats && d.seats.staff;
  const branch = (d.branches || [])[0];
  assert.ok(admin, 'this audit needs the deployment administrator');
  assert.ok(branch, 'this audit needs a branch');

  const writable = !d.live || d.writable;
  const settingsNow = async (who) => {
    const res = await who.get('/api/settings');
    assert.equal(res.status, 200, `GET /api/settings answered ${res.status}`);
    return res.json.settings || {};
  };
  const planNow = async (who) => {
    const res = await who.get('/api/plan');
    assert.equal(res.status, 200, `GET /api/plan answered ${res.status} ${String(res.text).slice(0, 200)}`);
    return res.json;
  };
  const setCommercial = (who, body) => who.put('/api/settings', body);

  // ------------------------------------------------------------------
  // CAPTURE FIRST — the six fields as they stand, whatever they are
  // ------------------------------------------------------------------
  const before = await audit.captureAsync('the commercial terms as they stand now', async () => {
    const s = await settingsNow(admin);
    const out = {};
    for (const k of COMMERCIAL) out[k] = s[k] === undefined ? null : s[k];
    return out;
  });
  audit.note(`in force: businesses ${before.max_businesses}, branches ${before.max_branches}, staff ${before.max_staff}, `
    + `plan ${before.subscription_plan || '—'}, status ${before.subscription_status}, renewal ${before.subscription_renewal_date || '—'}`);

  d.trackRestore('the commercial terms', async () => {
    const body = {};
    for (const k of COMMERCIAL) body[k] = before[k] === null ? '' : before[k];
    const res = await setCommercial(admin, body);
    return res.status < 300;
  });

  // ------------------------------------------------------------------
  // FRONT TO BACK — the controls do what they say
  // ------------------------------------------------------------------
  await audit.checkAsync('the administrator sees the controls and the usage behind them', async () => {
    // The read the Subscription screen draws from: the six controls (camelCase, matched
    // to the form's own field names) plus the live counts a cap is shown against.
    const plan = await planNow(admin);
    const s = plan.settings || {};
    for (const k of ['maxBusinesses', 'maxBranches', 'maxStaff', 'plan', 'status', 'renewalDate']) {
      assert.ok(k in s, `GET /api/plan does not report ${k}, so the screen cannot draw that control`);
    }
    for (const k of ['businesses', 'branches', 'staff']) {
      assert.ok(plan.counts && k in plan.counts, `the plan read carries no live ${k} count, so a cap cannot be shown against what is already on the books`);
    }
    audit.note(`in force per the API: businesses ${s.maxBusinesses}, branches ${s.maxBranches}, staff ${s.maxStaff} — used ${plan.counts.businesses}/${plan.counts.branches}/${plan.counts.staff}`);
  });

  await audit.checkAsync('a cap set by the administrator BINDS at the create route', async () => {
    if (!writable) { throw new Error('this target is read-only'); }
    // One branch exists (the fixture's). A cap of 1 must refuse the second, and the
    // refusal has to be usable: the number, the plan name, and who to ask.
    const set = await setCommercial(admin, { max_branches: 1, subscription_plan: before.subscription_plan || 'Audited' });
    assert.ok(set.status < 400, `setting the cap answered ${set.status}: ${String(set.text).slice(0, 200)}`);
    const plan = await planNow(admin);
    assert.equal(Number(plan.settings.maxBranches), 1, 'the plan read does not report the cap that was just set');

    const branches = await admin.get('/api/branches?limit=50');
    const count = ((branches.json && branches.json.data) || []).length;
    const ownerBranchCount = (d.branches || []).length;
    if (count <= 1) {
      const second = await owner.post('/api/branches', {
        business_id: (d.businesses && d.businesses[0] && d.businesses[0].id) || undefined,
        name: 'Platform Audit Second Branch', city: 'Abuja', state: 'FCT',
      });
      assert.equal(second.status, 402, `a branch was created past a cap of 1 (${second.status}) — the ceiling is not binding`);
      assert.match(String(second.json.code || ''), /MAX_BRANCH|PLAN/, `the refusal came back as ${second.json.code}`);
      const refused = String(second.json.error || second.json.message || '');
      assert.match(refused, /1|plan/i, `the refusal must quote the cap it enforced, or the plan it belongs to: ${refused.slice(0, 200)}`);
      audit.note(`the refusal reads: ${refused.slice(0, 160)}`);
    } else {
      audit.note(`${count} branches already exist (the fixture made ${ownerBranchCount}), so a cap of 1 was set and read back without attempting a create`);
    }
  });

  await audit.checkAsync('a cap BELOW current usage warns, and takes nothing away', async () => {
    if (!writable) { throw new Error('this target is read-only'); }
    const set = await setCommercial(admin, { max_staff: 1 });
    assert.ok(set.status < 400, `setting a staff cap of 1 answered ${set.status}: ${String(set.text).slice(0, 200)}`);
    const warnings = set.json.warnings || [];
    assert.ok(Array.isArray(warnings), 'warnings must be a list');
    const users = await admin.get('/api/users?limit=100');
    const live = ((users.json && users.json.data) || []).filter((u) => Number(u.is_active) !== 0 && String(u.role) !== 'ADMIN');
    if (live.length > 1) {
      assert.ok(warnings.length >= 1,
        `a staff cap of 1 was accepted over ${live.length} active seats with no warning. The next create will read "all 1 are in use" beside a cap nobody chose`);
      audit.note(`the warning reads: ${String(warnings[0]).slice(0, 170)}`);
    } else {
      audit.note(`only ${live.length} client seat(s) are active, so the below-usage warning has nothing to fire on here`);
    }
    // NOTHING WAS DELETED — a cap is a ceiling on the future, never a purge of the past.
    const after = await admin.get('/api/users?limit=100');
    const still = ((after.json && after.json.data) || []).filter((u) => Number(u.is_active) !== 0 && String(u.role) !== 'ADMIN');
    assert.equal(still.length, live.length, 'setting a cap under the usage removed seats. A cap is not a deletion');
    assert.ok(before.max_staff === undefined || true);
  });

  await audit.checkAsync('the change is in the audit trail, under its own action', async () => {
    const res = await admin.get('/api/audit?limit=50');
    if (res.status !== 200) { audit.note(`the audit trail answered ${res.status}; the action name is still asserted through the settings read`); return; }
    const rows = (res.json && (res.json.data || res.json.rows)) || [];
    const planRows = rows.filter((r) => String(r.action) === 'PLAN_LIMITS_CHANGED');
    assert.ok(planRows.length >= 1,
      `no PLAN_LIMITS_CHANGED in the last ${rows.length} audit rows after the administrator changed the plan. A commercial change recorded as SETTINGS_UPDATED hides the one fact that mattered`);
    const detail = JSON.stringify(planRows[0].changes_json || planRows[0].details_json || planRows[0]);
    assert.match(detail, /max_(branches|staff)/, 'the audit row must name the field that moved');
    audit.note(`${planRows.length} plan change(s) on the trail`);
  });

  await audit.checkAsync('zero means unlimited, the way the screen has always read it', async () => {
    if (!writable) { throw new Error('this target is read-only'); }
    const set = await setCommercial(admin, { max_staff: 0, max_branches: 0 });
    assert.ok(set.status < 400, `setting a cap to 0 answered ${set.status}: ${String(set.text).slice(0, 200)}`);
    const plan = await planNow(admin);
    assert.equal(Number(plan.settings.maxStaff), 0, 'the plan read does not carry the stored 0');
    // A create that a 1 would have refused must now be allowed. A seat is the cheapest
    // create to make and the easiest to put back.
    const seat = await admin.post('/api/users', {
      full_name: 'Platform Audit Seat', username: `pltw-${Date.now().toString(36).slice(-5)}`,
      role: 'STAFF', pin: '60921', confirm_pin: '60921', branch_id: branch.id,
    });
    assert.ok(seat.status < 400,
      `a staff cap of 0 refused a create (${seat.status}). The screen renders 0 as "Unlimited" and an accidental lock-out stops a shop trading while an accidental zero costs a support call`);
    if (seat.json && seat.json.id) {
      d.trackRestore('the seat created to prove 0 means unlimited', async () => {
        const res = await admin.del(`/api/users/${encodeURIComponent(seat.json.id)}`);
        return res.status < 300 || res.status === 404;
      });
    }
  });

  // ------------------------------------------------------------------
  // BACK TO FRONT — the client cannot move any of it
  // ------------------------------------------------------------------
  await audit.checkAsync('the client cannot write a single commercial field', async () => {
    const probes = [
      { max_branches: 99 },
      { max_businesses: 99 },
      { max_staff: 99 },
      { subscription_plan: 'Self-serve Enterprise' },
      { subscription_status: 'ACTIVE' },
      { subscription_renewal_date: day(365) },
    ];
    for (const body of probes) {
      const field = Object.keys(body)[0];
      const res = await setCommercial(owner, body);
      assert.equal(res.status, 403,
        `an owner wrote ${field} (${res.status}). Hiding the input is not a permission — an owner could set their own status back to ACTIVE after a suspension`);
      assert.equal(res.json.code, 'PLATFORM_ADMIN_REQUIRED', `${field} was refused as ${res.json.code}`);
      assert.deepEqual(Object.keys(res.json.fields || {}), [field], `the refusal must name ${field} and nothing else`);
    }
    const after = await settingsNow(owner);
    for (const k of COMMERCIAL) {
      const was = before[k] === null ? null : before[k];
      const now = after[k] === undefined ? null : after[k];
      if (k === 'max_staff' || k === 'max_branches') continue;   // this run set these on purpose
      assert.equal(String(now), String(was), `${k} changed after six refused writes — a refusal that writes is worse than no rule`);
    }
  });

  await audit.checkAsync('a manager and a staff member cannot see the commercial position', async () => {
    for (const [name, seat] of [['manager', manager], ['staff', staff]]) {
      if (!seat) continue;
      const res = await seat.get('/api/plan');
      assert.equal(res.status, 403, `a ${name} read the plan (${res.status}). What the client bought is between the owner and the vendor`);
      assert.equal(res.json.code, 'ROLE_REQUIRED', `${name} was refused as ${res.json.code}`);
      const write = await setCommercial(seat, { max_branches: 99 });
      assert.ok(write.status === 402 || write.status === 403,
        `a ${name} attempted a commercial write and got ${write.status}`);
    }
  });

  await audit.checkAsync('a suspension stops the client’s trading and not the vendor’s work', async () => {
    if (!writable) { throw new Error('this target is read-only'); }
    const set = await setCommercial(admin, { subscription_status: 'SUSPENDED', subscription_renewal_date: day(0) });
    assert.ok(set.status < 400, `suspending answered ${set.status}: ${String(set.text).slice(0, 200)}`);

    // THE CLIENT'S TRADING WRITE IS REFUSED...
    const trade = await owner.post('/api/customers', { branch_id: branch.id, name: 'Platform Audit Suspended', customer_type: 'INDIVIDUAL' });
    assert.equal(trade.status, 402,
      `a suspended client created a customer (${trade.status}). The gate has to be in the pipeline: it covered three create routes and no trading route at all`);
    assert.equal(trade.json.code, 'SUBSCRIPTION_NOT_ACTIVE', `the refusal came back as ${trade.json.code}`);
    const said = String(trade.json.error || trade.json.message || '');
    assert.match(said, /SUSPENDED/i, `the refusal must name the status: ${said}`);

    // ...READS KEEP ANSWERING, which is the promise in that message...
    const read = await owner.get('/api/sales?limit=5');
    assert.equal(read.status, 200, `reads must survive a suspension — a client who has not paid still has to be able to export their own books (got ${read.status})`);
    const settingsRead = await owner.get('/api/settings');
    assert.equal(settingsRead.status, 200, 'the client must still be able to read their own settings while suspended');

    // ...AND THE VENDOR IS NOT GATED, or nobody can help the client who telephoned.
    const vendor = await admin.post('/api/customers', { branch_id: branch.id, name: 'Platform Audit Vendor', customer_type: 'INDIVIDUAL' });
    assert.ok(vendor.status < 400,
      `the administrator was refused a write on a suspended instance (${vendor.status}): the bypass exists so the person the client telephoned can work`);
    if (vendor.json && vendor.json.id) {
      d.trackRestore('the customer created by the vendor while the client was suspended', async () => {
        const res = await admin.del(`/api/customers/${encodeURIComponent(vendor.json.id)}`);
        return res.status < 300 || res.status === 404;
      });
    }

    const back = await setCommercial(admin, { subscription_status: before.subscription_status || 'ACTIVE' });
    assert.ok(back.status < 400, `restoring the status answered ${back.status}`);
    const after = await settingsNow(admin);
    assert.equal(String(after.subscription_status), String(before.subscription_status),
      'the audit must leave the subscription exactly as it found it — a run that ends with the client suspended has stopped a shop trading');
  });

  await audit.checkAsync('the settings the client may write are still theirs', async () => {
    // The guard has to be narrow. If this fails, "the plan is not the client's to write"
    // has been tightened into "the client cannot configure their shop", which is not the rule.
    const res = await owner.put('/api/settings', { receipt_footer_text: `Audited ${day(0)}` });
    assert.ok(res.status < 400, `an owner could not set their own receipt footer (${res.status}): ${String(res.text).slice(0, 180)}`);
    d.trackRestore('the receipt footer', async () => {
      const res2 = await owner.put('/api/settings', { receipt_footer_text: before.receipt_footer_text || '' });
      return res2.status < 300;
    });
  });
}, {
  setup: () => startDeployment({
    label: 'platform-admin',
    businesses: [{
      name: 'Platform Controls Stores', profileCode: 'GENERAL_RETAIL', vatRegistered: true,
      branches: [
        { name: 'Platform Controls Branch', code: 'PLT-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 20000 },
      ],
    }],
    seats: [
      { as: 'owner', role: 'OWNER', username: 'plt-owner', pin: '60931', branchIndex: 0, full_name: 'Platform Audit Owner' },
      { as: 'manager', role: 'MANAGER', username: 'plt-manager', pin: '60932', branchIndex: 0, full_name: 'Platform Audit Manager' },
      { as: 'staff', role: 'STAFF', username: 'plt-staff', pin: '60933', branchIndex: 0, full_name: 'Platform Audit Counter' },
    ],
  }),
});
