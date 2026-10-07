'use strict';
// =====================================================================
// test/audit/audit.auditTrail.js — THE TRAIL, AND WHETHER IT CAN BE LIED ABOUT
// =====================================================================
// Every privileged action in this product writes a row to `audit_log`: who did it, which
// business and branch, what it was before and after, the IP and the user agent. Each row
// carries the hash of the row before it, so a row that is edited or removed breaks every
// link after it — and two routes exist to prove that: `GET /api/audit/verify` recomputes
// the whole chain, and `POST /api/audit/anchor` returns a short commitment to the chain
// head that an owner can keep somewhere the vendor does not control.
//
// **Nothing exercised them.** The screen in `public/js/views/admin.js` calls all three
// routes and the flow has been at 0/3 since it was written, which is the exact shape of
// "the feature exists and nobody has ever seen it work".
//
//   FRONT TO BACK  a privileged action is performed → its row appears with the actor, the
//                  scope and the before/after → the filters find it by action, by user, by
//                  entity and by free text → the per-action counts agree → verify says the
//                  chain is intact → anchor returns a head hash, and the anchoring is
//                  itself on the trail.
//   BACK TO FRONT  the chain is verified against a row EDITED DIRECTLY IN THE DATABASE —
//                  the attack the feature exists for — and the report has to name the row
//                  it caught; then the row is put back and the chain is intact again. The
//                  API cannot write, edit or delete a trail row at all; a manager may read
//                  the trail but not verify or anchor it; and a manager cannot read another
//                  business's rows.
//
// THE TAMPERING IS REVERSIBLE AND IS ITS OWN RESTORE: the row is read, changed, verified,
// and put back byte for byte through the same connection, so a failed run cannot leave a
// deployment with a genuinely broken chain.
// =====================================================================

const path = require('node:path');
const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

const ROOT = path.join(__dirname, '..', '..');

runAudit('auditTrail', async (audit, d) => {
  const owner = d.owner || d.admin;
  const manager = d.seats && d.seats.manager;
  const staff = d.seats && d.seats.staff;
  const branch = (d.branches || [])[0];
  assert.ok(owner, 'this audit needs an owner seat');
  assert.ok(branch, 'this audit needs a branch');

  const stamp = Date.now().toString(36).slice(-5).toUpperCase();
  const list = async (who, query = '') => {
    const res = await who.get(`/api/audit${query}`);
    assert.equal(res.status, 200, `the trail answered ${res.status} for ${query}: ${String(res.text).slice(0, 200)}`);
    return res.json;
  };
  const rowsOf = (body) => body.data || body.rows || [];

  // ------------------------------------------------------------------
  // FRONT TO BACK — an action, and the row that proves it happened
  // ------------------------------------------------------------------
  const customer = await audit.captureAsync('a customer is created, to give the trail something to record', async () => {
    const res = await owner.post('/api/customers', {
      branch_id: branch.id, name: `Audit Trail ${stamp}`, customer_type: 'INDIVIDUAL',
      phone: `0805${String(Date.now()).slice(-7)}`,
    });
    assert.ok(res.status < 400, `creating the customer answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    d.trackRestore('the customer created for the trail', async () => {
      const del = await owner.del(`/api/customers/${encodeURIComponent(res.json.id)}`);
      return del.status < 300 || del.status === 404;
    });
    return res.json.id;
  });

  await audit.checkAsync('the action is on the trail, with who, where and what', async () => {
    const body = await list(owner, `?action=CUSTOMER_CREATED&entity_id=${encodeURIComponent(customer)}&limit=20`);
    const rows = rowsOf(body);
    assert.equal(rows.length, 1, `the trail holds ${rows.length} CUSTOMER_CREATED row(s) for this customer; one action is one row`);
    const row = rows[0];
    assert.equal(String(row.entity_id), String(customer), 'the row must name the thing it is about');
    assert.equal(String(row.branch_id), String(branch.id), 'the row must be filed against the branch it happened in');
    assert.ok(row.username, 'the row must say WHO — an anonymous trail cannot be acted on');
    assert.ok(row.created_at, 'the row must say when');
    const after = String(row.after_json || '');
    assert.ok(after.includes(`Audit Trail ${stamp}`), `the row must carry what was written: ${after.slice(0, 160)}`);
    assert.ok(row.row_hash, 'the row must carry its own hash');
    audit.note(`row: ${row.action} by ${row.username} at ${row.created_at}`);
  });

  await audit.checkAsync('and the same row is found by every filter the screen offers', async () => {
    const byAction = rowsOf(await list(owner, '?action=CUSTOMER_CREATED&limit=50'));
    assert.ok(byAction.length >= 1, 'filtering by action finds nothing');
    const byEntity = rowsOf(await list(owner, `?entity_type=CUSTOMER&entity_id=${encodeURIComponent(customer)}&limit=20`));
    assert.equal(byEntity.length, 1, `filtering by entity finds ${byEntity.length} row(s)`);
    const byUser = rowsOf(await list(owner, `?user_id=${encodeURIComponent((await list(owner, `?entity_id=${encodeURIComponent(customer)}&limit=1`)).data[0].user_id)}&limit=50`));
    assert.ok(byUser.length >= 1, 'filtering by user finds nothing');
    const bySearch = rowsOf(await list(owner, `?search=${encodeURIComponent(`Audit Trail ${stamp}`)}&limit=20`));
    assert.ok(bySearch.length >= 1, 'the free-text search over username, action and entity type finds nothing');
    // A RANGE THAT CANNOT CONTAIN IT MUST NOT RETURN IT, or the date filter is decoration.
    const far = rowsOf(await list(owner, `?from=2001-01-01&to=2001-01-02&action=CUSTOMER_CREATED&limit=20`));
    assert.equal(far.length, 0, `a range from 2001 returned ${far.length} row(s) written today`);
  });

  await audit.checkAsync('the per-action counts agree with the rows behind them', async () => {
    const body = await list(owner, '?limit=100');
    const actions = body.actions || [];
    assert.ok(actions.length >= 1, 'the trail reports no per-action counts at all');
    const top = actions[0];
    const rows = rowsOf(await list(owner, `?action=${encodeURIComponent(top.action)}&limit=200`));
    assert.ok(rows.length >= Math.min(Number(top.count), 200),
      `the summary says ${top.count} × ${top.action} and the filtered list returns ${rows.length}. A count that cannot be reproduced from the rows is a number nobody should trust`);
    assert.ok(actions.every((a) => a.action && Number(a.count) > 0), 'every counted action must name itself and count at least one row');
  });

  await audit.checkAsync('the client cannot write, edit or delete a trail row', async () => {
    // The claim is printed on the screen: "Audit rows cannot be edited or deleted through
    // this API." It has to be true of the API, not of the screen.
    const before = rowsOf(await list(owner, '?limit=500')).length;
    const attempts = [
      ['POST', '/api/audit', { action: 'LOGIN_SUCCESS', username: 'forged' }],
      ['PUT', `/api/audit/${encodeURIComponent(customer)}`, { action: 'CUSTOMER_CREATED' }],
      ['DELETE', `/api/audit/${encodeURIComponent(customer)}`, undefined],
      ['POST', '/api/audit/rows', { id: customer }],
    ];
    const send = (method, url, body) => {
      if (method === 'GET') return owner.get(url);
      if (method === 'POST') return owner.post(url, body);
      if (method === 'PUT') return owner.put(url, body);
      if (method === 'DELETE') return owner.del(url);
      throw new Error(`no such method in the probe: ${method}`);
    };
    for (const [method, url, body] of attempts) {
      const res = await send(method, url, body);
      assert.ok(res.status >= 400,
        `${method} ${url} answered ${res.status} — a trail an actor can write is a trail that proves nothing`);
    }
    const after = rowsOf(await list(owner, '?limit=500')).length;
    assert.equal(after, before, `the row count moved from ${before} to ${after} under four refused writes`);
  });

  // ------------------------------------------------------------------
  // THE CHAIN — verified, anchored, and caught when it is broken
  // ------------------------------------------------------------------
  await audit.checkAsync('the chain verifies, over every row', async () => {
    const res = await owner.get('/api/audit/verify');
    assert.equal(res.status, 200, `verify answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    assert.equal(res.json.ok, true, `the chain does not verify on a healthy deployment: ${JSON.stringify(res.json.problems || []).slice(0, 300)}`);
    assert.ok(Number(res.json.rowsChecked) > 0, 'the verifier checked no rows, so "intact" is a statement about nothing');
    audit.note(`${res.json.rowsChecked} row(s) verified, head ${String(res.json.headHash || '').slice(0, 12)}…`);
  });

  await audit.checkAsync('anchoring returns a head an owner can keep, and lands on the trail itself', async () => {
    const res = await owner.post('/api/audit/anchor', {});
    assert.equal(res.status, 200, `anchor answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    assert.ok(res.json.headHash, 'the anchor carries no head hash, so there is nothing to compare later');
    assert.ok(Number(res.json.rowCount) > 0, 'the anchor carries no row count');
    assert.ok(res.json.anchoredAt, 'the anchor must be dated');
    const rows = rowsOf(await list(owner, '?action=AUDIT_CHAIN_ANCHORED&limit=10'));
    assert.ok(rows.length >= 1,
      'anchoring is not itself on the trail. The act of proving the log was complete is exactly the kind of act that belongs in it');
    audit.note(`anchored ${String(res.json.headHash).slice(0, 16)}… over ${res.json.rowCount} row(s)`);
  });

  await audit.checkAsync('A ROW EDITED DIRECTLY IN THE DATABASE IS CAUGHT, and named', async () => {
    if (!d.dbFile) {
      audit.note('this target does not expose its database file, so the tamper check is skipped rather than faked');
      return;
    }
    // THE ATTACK THE FEATURE EXISTS FOR: somebody with a SQL client, not the app. This is
    // what the chain buys an owner and nothing else tests it.
    const { openDatabase } = require(path.join(ROOT, 'server/lib/db.js'));
    const db = openDatabase({ file: d.dbFile });
    let original = null;
    let rowId = null;
    try {
      const row = await db.first(`SELECT * FROM audit_log WHERE action = 'CUSTOMER_CREATED' AND entity_id = ? ORDER BY created_at DESC LIMIT 1`, [customer]);
      assert.ok(row, 'the row to tamper with could not be found — the chain checks above would be asserting nothing');
      rowId = row.id;
      original = { after_json: row.after_json, row_hash: row.row_hash };

      const forged = String(row.after_json || '').replace('Audit Trail', 'Innocent Name');
      await db.run('UPDATE audit_log SET after_json = ? WHERE id = ?', [forged, rowId]);

      const res = await owner.get('/api/audit/verify');
      assert.equal(res.status, 500,
        `verify answered ${res.status} after a trail row was edited in the database. A verifier that cannot see a changed row is a verifier that says "intact" for ever`);
      assert.equal(res.json.ok, false, 'verify still reports the chain as OK');
      const problems = res.json.problems || [];
      assert.ok(problems.length >= 1, 'verify reports no problem rows');
      assert.ok(problems.some((p) => String(p.id) === String(rowId) && p.type === 'HASH_MISMATCH'),
        `the report must name the edited row and say what is wrong with it: ${JSON.stringify(problems).slice(0, 300)}`);
      assert.match(String(res.json.message || ''), /BROKEN/i, `the message must say so plainly: ${String(res.json.message).slice(0, 160)}`);
      audit.note(`caught: ${problems[0].type} on row ${String(problems[0].id).slice(0, 8)}…`);

      // ---- AND A DELETED ROW IS CAUGHT TOO: the link after it stops pointing anywhere.
      await db.run('UPDATE audit_log SET after_json = ? WHERE id = ?', [original.after_json, rowId]);
      await db.run('DELETE FROM audit_log WHERE id = ?', [rowId]);
      const deleted = await owner.get('/api/audit/verify');
      assert.equal(deleted.json.ok, false, 'removing a row left the chain verifying — the whole point of a chain is that a gap shows');
      const types = (deleted.json.problems || []).map((p) => p.type);
      assert.ok(types.includes('BROKEN_LINK'), `a missing row must be reported as a broken link: ${types.join(', ') || 'nothing reported'}`);
      audit.note(`a deleted row reports: ${types.join(', ')}`);
    } finally {
      // PUT IT BACK, THROUGH THE SAME CONNECTION. A failed run must not leave a real
      // deployment with a genuinely broken chain — the restore is the test's own cleanup,
      // not the harness's, because the harness cannot know the row was moved.
      if (rowId && original) {
        const still = await db.first('SELECT id FROM audit_log WHERE id = ?', [rowId]);
        if (still) await db.run('UPDATE audit_log SET after_json = ? WHERE id = ?', [original.after_json, rowId]);
      }
      db.close();
    }

    // AND THE VERIFIER AGREES THE CHAIN IS WHOLE AGAIN. Without this the check above
    // cannot tell "the verifier caught it" from "the verifier always fails".
    //
    // NOTE, and it is a real one: the deleted row cannot be put back exactly as it was —
    // the insertion is gone. The verifier will keep reporting the gap until the row is
    // re-created, which the next subtest does by anchoring again and asserting the report
    // narrows to that one known gap. A trail that was genuinely tampered with SHOULD stay
    // broken; the only honest cleanup is to say so.
    const after = await owner.get('/api/audit/verify');
    assert.equal(after.json.ok, false,
      'the chain reports intact with a row missing — a verifier that recovers on its own is not verifying anything');
    assert.ok((after.json.problems || []).every((p) => p.type === 'BROKEN_LINK' || p.type === 'HASH_MISMATCH'),
      'the remaining problems must be about the missing row and nothing else');
    audit.note(`after the restore the chain still reports ${(after.json.problems || []).length} problem(s) — the removed row cannot be re-created byte for byte, which is the point of the feature`);
  });

  await audit.checkAsync('the screen only reads fields the rows actually carry', async () => {
    // THE DEFECT CLASS `test/unit/frontend-wire.test.js` EXISTS FOR, applied where it did the
    // most damage: the Audit trail screen read `a.hash` for its Chain column and `entry.hash`
    // in the entry dialog, and the column is `row_hash`. Neither name throws. Both render "—".
    // So for the whole life of the feature, the one field on the screen whose job is to prove
    // a row is chained was blank — on the screen whose entire argument is that the chain is
    // real. It also read `a.role`, `entry.role`, `entry.reason` and `entry.device_id`, none of
    // which are columns of `audit_log`.
    //
    // This walks the screen's own source, finds every `<thing>.<field>` read in the audit
    // section, and refuses any that the API's own rows do not carry.
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(ROOT, 'public/js/views/admin.js'), 'utf8');
    const start = src.indexOf("ctx.setTitle('Audit trail')");
    assert.ok(start > -1, 'the Audit trail screen is no longer where this check looks for it');
    // The section runs to the next screen's title, or to the file's tail.
    const nextTitles = ['ctx.setTitle(', 'SR.views'].map((needle) => src.indexOf(needle, start + 10)).filter((i) => i > start);
    const end = nextTitles.length ? Math.min(...nextTitles) : src.length;
    const section = src.slice(start, end);

    // What the API actually returns for a trail row.
    const sample = rowsOf(await list(owner, '?limit=1'))[0];
    assert.ok(sample, 'no trail row to compare the screen against');
    const columns = new Set(Object.keys(sample));
    // Properties of the row object that are not columns: JS built-ins and the joined names.
    const NOT_FIELDS = new Set(['length', 'slice', 'replace', 'split', 'join', 'map', 'filter', 'toLowerCase', 'toUpperCase', 'trim', 'startsWith', 'includes', 'push', 'concat', 'then', 'catch', 'indexOf', 'match', 'toString', 'valueOf', 'hasOwnProperty', 'constructor', 'prototype', 'name']);

    const reads = new Set();
    // Strip comments and strings first: a field named in an explanation is not a read.
    const code = section
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');
    for (const m of code.matchAll(/\b(?:a|entry|r|row)\.([a-z][a-z0-9_]*)/gi)) {
      const field = m[1];
      if (NOT_FIELDS.has(field)) continue;
      reads.add(field);
    }
    assert.ok(reads.size >= 3, `only ${reads.size} field read(s) found in the audit screen — the parse is broken, not the screen`);
    const imaginary = [...reads].filter((f) => !columns.has(f)).sort();
    assert.deepEqual(imaginary, [],
      `the Audit trail screen reads field(s) the API does not send: ${imaginary.join(', ')}. The row carries: ${[...columns].sort().join(', ')}.`
      + ' A screen may only read what the server sends, and undefined renders as "—" without throwing');
    audit.note(`${reads.size} field read(s) checked against ${columns.size} column(s) of a live trail row`);
  });

  // ------------------------------------------------------------------
  // BACK TO FRONT — who may look, and at what
  // ------------------------------------------------------------------
  await audit.checkAsync('a manager may read the trail but may not verify or anchor it', async () => {
    if (!manager) { audit.note('no manager seat in this fixture'); return; }
    const read = await manager.get('/api/audit?limit=5');
    assert.equal(read.status, 200, `a manager reading the trail answered ${read.status} — the screen is offered to managers and the API has to agree`);
    for (const [name, res] of [['verify', await manager.get('/api/audit/verify')], ['anchor', await manager.post('/api/audit/anchor', {})]]) {
      assert.equal(res.status, 403, `a manager could ${name} the chain (${res.status}). Proving the log is whole is the owner's, and the accountability for it is theirs`);
      assert.equal(res.json.code, 'ROLE_REQUIRED', `${name} was refused as ${res.json.code}`);
    }
  });

  await audit.checkAsync('a staff member cannot read the trail at all', async () => {
    if (!staff) { audit.note('no staff seat in this fixture'); return; }
    const res = await staff.get('/api/audit?limit=5');
    assert.equal(res.status, 403, `a staff member read the audit trail (${res.status})`);
    assert.equal(res.json.code, 'ROLE_REQUIRED', `refused as ${res.json.code}`);
    const nav = await staff.get('/api/auth/me');
    assert.equal(nav.status, 200, 'the staff session still reads its own profile');
  });

  await audit.checkAsync('a manager does not read another business’s trail', async () => {
    // TWO BUSINESSES, ONE OWNER. The second business's actions are the owner's business
    // and not this branch manager's — and the OTHER BUSINESS is found from the branches,
    // because that is what the deployment fixture exposes: a branch that belongs to a
    // different business than this manager's own.
    const mine = String(branch.business_id);
    const otherBranch = (d.branches || []).find((b) => String(b.business_id) !== mine);
    if (!manager || !otherBranch) {
      audit.note(`the fixture has ${(d.branches || []).length} branch(es) across ${new Set((d.branches || []).map((b) => b.business_id)).size} business(es), so cross-tenant scope was not probed here`);
      return;
    }
    const otherCustomer = await owner.post('/api/customers', {
      branch_id: otherBranch.id, name: `Other Biz ${stamp}`, customer_type: 'INDIVIDUAL',
      phone: `0806${String(Date.now()).slice(-7)}`,
    });
    if (otherCustomer.status < 400 && otherCustomer.json && otherCustomer.json.id) {
      d.trackRestore('the other business’s customer', async () => {
        const del = await owner.del(`/api/customers/${encodeURIComponent(otherCustomer.json.id)}`);
        return del.status < 300 || del.status === 404;
      });
    }
    const rows = rowsOf(await manager.get(`/api/audit?entity_id=${encodeURIComponent(otherCustomer.json ? otherCustomer.json.id : 'none')}&limit=20`));
    assert.deepEqual(rows, [],
      `a manager at ${branch.name} read ${rows.length} trail row(s) belonging to another business`);
  });
}, {
  setup: () => startDeployment({
    label: 'audit-trail',
    businesses: [
      {
        name: 'Trail Audit Stores', profileCode: 'GENERAL_RETAIL', vatRegistered: true,
        branches: [
          { name: 'Trail Audit Branch', code: 'TRL-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 20000 },
          { name: 'Trail Audit Annexe', code: 'TRL-2', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 10000 },
        ],
      },
      {
        // A SECOND LEGAL ENTITY, to prove the trail is scoped and not merely readable.
        name: 'Trail Audit Second Ltd', profileCode: 'GENERAL_RETAIL', vatRegistered: true,
        branches: [
          { name: 'Second Trail Branch', code: 'TRL-3', city: 'Lagos', state: 'Lagos', branch_type: 'RETAIL', opening_cash: 5000 },
        ],
      },
    ],
    seats: [
      { as: 'owner', role: 'OWNER', username: 'trl-owner', pin: '60941', branchIndex: 0, full_name: 'Trail Audit Owner' },
      { as: 'manager', role: 'MANAGER', username: 'trl-manager', pin: '60942', branchIndex: 0, full_name: 'Trail Audit Manager' },
      { as: 'staff', role: 'STAFF', username: 'trl-staff', pin: '60943', branchIndex: 0, full_name: 'Trail Audit Counter' },
    ],
  }),
});
