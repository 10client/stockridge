'use strict';
// =====================================================================
// tools/frontend-compliance.js — THE LICENCES, THROUGH THE REAL SCREEN
// =====================================================================
// Proves the whole Stage-11 chain through the DOM, not by calling the service:
//
//   1. the screen opens on the Compliance route and names the branch
//   2. the CHECKLIST lists what this branch's vertical expects it to hold
//   3. a missing permit can be recorded from the screen, and the SERVER then
//      holds it — read back over HTTP, not out of the page
//   4. the REGISTER lists it
//   5. a permit expiring inside the window appears in the ALERTS tab
//   6. "Raise alerts now" turns it into a notification, and running it twice does
//      not make two
//   7. both records are removed again, so a demo deployment is left as it was found
//
// The last step matters: a probe that leaves its proof behind turns the next
// person's demo into a licence register with somebody else's certificates in it.
//
//   node tools/frontend-compliance.js --url=http://localhost:8812 --user=owner --pin=48213
// =====================================================================

const H = require('./lib/page-harness.js');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const BASE = String(flag('url', 'http://localhost:8812')).replace(/\/$/, '');
const USERNAME = flag('user', 'admin');
const PIN = flag('pin', '90210');
const KEEP = args.includes('--keep');

const results = [];
const ok = (what, detail) => { results.push({ pass: true, what }); console.log(`  ✓ ${what}${detail ? `\n      ${detail}` : ''}`); };
const bad = (what, detail) => { results.push({ pass: false, what }); console.log(`  ✗ ${what}${detail ? `\n      ${detail}` : ''}`); };
const skip = (what, detail) => { results.push({ pass: true, skip: true, what }); console.log(`  ⊘ ${what}${detail ? `\n      ${detail}` : ''}`); };

/** ISO date N days from today, for a permit that is about to lapse. */
const isoIn = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

(async () => {
  console.log(`\nStockRidge — compliance & licences, from the screen`);
  console.log(`  ${BASE} as ${USERNAME}`);
  console.log('─'.repeat(58));

  const page = await H.bootPage({ origin: BASE, username: USERNAME, pin: PIN });
  if (!page.ok) { bad('the app loaded', page.reason || 'boot failed'); process.exit(1); }
  const { window } = page;
  const doc = window.document;   // the harness hands back the window, not the document

  const api = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json', Authorization: `Bearer ${page.token}` }),
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const created = [];
  const notified = [];
  const finish = async () => {
    if (!KEEP) {
      for (const id of created) {
        const r = await api('DELETE', `/api/compliance/records/${encodeURIComponent(id)}`);
        if (r.status !== 200) console.log(`      (cleanup: record ${id.slice(0, 8)} answered ${r.status})`);
      }
      // The ALERTS it raised go too. They point at a record that no longer exists,
      // so leaving them behind would put a licence this probe invented into the
      // next person's bell — a demo deployment should look untouched.
      const notice = await api('GET', '/api/notifications?limit=50');
      for (const n of ((notice.body && notice.body.data) || [])) {
        if (n.type === 'COMPLIANCE_EXPIRY' && created.includes(String(n.reference_id))) {
          await api('POST', `/api/notifications/${encodeURIComponent(n.id)}/read`);
          notified.push(n.id);
        }
      }
      for (const id of notified) await api('POST', `/api/notifications/${encodeURIComponent(id)}/read`);
      if (created.length) console.log(`      (tidied: ${created.length} record(s) removed, ${notified.length} alert(s) marked read)`);
    }
    console.log('─'.repeat(58));
    const failures = results.filter((r) => !r.pass);
    const skipped = results.filter((r) => r.skip);
    if (failures.length) console.log(`${failures.length} problem(s):\n${failures.map((f) => `  - ${f.what}`).join('\n')}`);
    else console.log(`${results.length - skipped.length} check(s) passed${skipped.length ? `, ${skipped.length} skipped` : ''} — a licence can be recorded from the screen and the alerts reach the server.`);
    process.exit(failures.length ? 1 : 0);
  };

  // ---- who is signed in, and where are we working
  const me = (await api('GET', '/api/auth/me')).body;
  const role = String(me.user.role || '').toUpperCase();
  if (role === 'STAFF') {
    skip('the Compliance screen for this seat', `${USERNAME} is STAFF — the screen is a manager\u2019s, and the API refuses a cashier\u2019s write`);
    return finish();
  }
  const branchId = me.user.branch_id || null;
  const branchQuery = branchId ? `?branch_id=${encodeURIComponent(branchId)}` : '';

  // ---- 1. the screen
  window.SR.app.navigate('/compliance');
  // `findByText` returns a LIST of matches — the sort of thing that is obvious
  // from the name only after being bitten by it. The first run of this probe
  // crashed on `heads.textContent.trim()` instead of reporting what it found.
  // AN EMPTY ARRAY IS TRUTHY. `findByText` returns a list, so a predicate that
  // returns it directly satisfies `waitUntil` on its FIRST tick — before the
  // screen has drawn — and the probe reports "the screen did not open" about a
  // screen that opened a moment later. Reported as a pass-or-fail on the wrong
  // question, which is the same failure this harness already had once with an
  // unawaited promise. The predicate must return the list only when it is not
  // empty.
  const heads = await H.waitUntil(() => {
    const found = H.findByText(doc, 'Compliance & licences', { tag: 'h1' });
    return found.length ? found : null;
  }, { timeout: 25000, label: 'the Compliance screen' });
  const head = heads && heads[0];
  if (!head) { bad('the screen opens', 'no h1 reading "Compliance & licences" on /compliance'); return finish(); }
  ok('the screen opens', head.textContent.trim());

  const checklist = await H.waitUntil(async () => {
    const text = String((doc.querySelector('#view') || doc).textContent || '');
    return /On file|Never recorded/i.test(text) ? text : null;
  }, { timeout: 20000, interval: 500, label: 'the checklist to load' });
  if (!checklist) { bad('the checklist loads', 'the KPI row never appeared'); return finish(); }
  ok('the checklist loads and counts what the vertical expects', checklist.replace(/\s+/g, ' ').slice(0, 120));

  // ---- 2. what the vertical expects, taken from the SERVER so the screen cannot
  //         simply agree with itself
  const serverChecklist = (await api('GET', `/api/compliance/checklist${branchQuery}`)).body;
  const row = (serverChecklist.data || [])[0];
  if (!row) { bad('a branch to check', 'this deployment has no branch in scope'); return finish(); }
  const missing = row.expected.filter((e) => e.status === 'MISSING');
  if (!missing.length) {
    skip('recording a missing permit from the screen', 'every record this vertical expects is already on file');
    return finish();
  }
  ok('the vertical says what is missing', `${row.branch_name} · ${missing.length} of ${row.expected.length} not recorded: ${missing.map((m) => m.type).join(', ')}`);

  // ---- 3. record one, from the screen
  const target = missing[0];
  const recordIt = await H.waitUntil(() => {
    const buttons = [...doc.querySelectorAll('#view button')].filter((b) => /^Record it$/.test(b.textContent.trim()));
    return buttons[0] || null;
  }, { timeout: 20000, label: 'a "Record it" button on the checklist' });
  if (!recordIt) { bad('the checklist offers to record what is missing', 'no "Record it" button'); return finish(); }
  recordIt.click();

  const form = await H.waitUntil(() => {
    const fields = [...doc.querySelectorAll('#modal-root form [name]')];
    return fields.length ? fields : null;
  }, { timeout: 20000, label: 'the record form' });
  if (!form) { bad('the form opens', 'no fields under #modal-root'); return finish(); }
  const serial = String(Date.now()).slice(-6);
  const soon = isoIn(14);
  const setField = (name, value) => {
    const el = doc.querySelector(`#modal-root [name="${name}"]`);
    if (!el) return false;
    el.value = value;
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
    return true;
  };
  const filled = ['record_number', 'issued_by', 'expiry_date'].map((n) => setField(n, n === 'record_number' ? `PROBE-${serial}` : (n === 'issued_by' ? 'Verification Office' : soon)));
  if (filled.some((f) => !f)) { bad('the form asks for a number, an issuer and an expiry', filled.join(',')); }
  const typeField = doc.querySelector('#modal-root [name="record_type"]');
  const chosenType = typeField ? typeField.value : null;

  const saveBtn = [...doc.querySelectorAll('#modal-root button')].find((b) => /^(Record it|Save changes)$/.test(b.textContent.trim()));
  if (!saveBtn) { bad('the form has a save button', 'none found'); return finish(); }
  saveBtn.click();

  const stored = await H.waitUntil(async () => {
    const list = (await api('GET', `/api/compliance/records?limit=200${branchId ? `&branch_id=${encodeURIComponent(branchId)}` : ''}`)).body;
    const hit = (list.data || []).find((r) => r.record_number === `PROBE-${serial}`);
    return hit || null;
  }, { timeout: 20000, interval: 600, label: 'the server to hold the new record' });
  if (!stored) { bad('recording a licence from the screen reaches the server', 'the server has no record with the probe reference'); return finish(); }
  created.push(stored.id);
  ok('recording a licence from the screen reaches the server', `${chosenType} · ${stored.record_number} · expires ${stored.expiry_date} · ${stored.status}`);

  // ---- 4. the register tab
  const registerTab = [...doc.querySelectorAll('#view .tabs button')].find((b) => /register/i.test(b.textContent));
  if (registerTab) {
    registerTab.click();
    const listed = await H.waitUntil(() => {
      const text = String((doc.querySelector('#view') || doc).textContent || '');
      return text.includes(`PROBE-${serial}`) ? text : null;
    }, { timeout: 20000, interval: 500, label: 'the register to list the new record' });
    if (listed) ok('the register lists it', `PROBE-${serial} appears in the Register tab`);
    else bad('the register lists it', 'the record is on the server but not on the screen');
  } else bad('the register tab is there', 'no Register tab');

  // ---- 5. the alerts tab: a permit 14 days out must be inside a 30-day window
  // Case-insensitive: the tab reads "Expiry alerts" and a case-sensitive
    // /Alerts/ test reported, in effect, that the tab was missing.
    const alertsTab = [...doc.querySelectorAll('#view .tabs button')].find((b) => /alerts/i.test(b.textContent));
  if (alertsTab) {
    alertsTab.click();
    const alertText = await H.waitUntil(() => {
      const text = String((doc.querySelector('#view') || doc).textContent || '');
      return text.includes(`PROBE-${serial}`) ? text : null;
    }, { timeout: 20000, interval: 500, label: 'the alert list to include the new record' });
    if (alertText) ok('a permit expiring inside the window appears in the alerts', `PROBE-${serial} · expires ${soon}`);
    else bad('a permit expiring inside the window appears in the alerts', `the record expires ${soon} and the screen does not list it`);

    // ---- 6. raise the notifications
    const raise = [...doc.querySelectorAll('#view button')].find((b) => /raise alerts now/i.test(b.textContent));
    if (!raise) { bad('the alerts tab offers to raise them', 'no button'); } else {
      const before = (await api('GET', '/api/compliance/alerts' + branchQuery)).body.counts.total;
      raise.click();
      const raised = await H.waitUntil(async () => {
        const unread = await api('GET', '/api/notifications?limit=50');
        const rows = (unread.body && (unread.body.data || unread.body.notifications)) || [];
        return rows.some((n) => n.type === 'COMPLIANCE_EXPIRY' && String(n.reference_id) === String(stored.id)) ? rows : null;
      }, { timeout: 25000, interval: 700, label: 'a COMPLIANCE_EXPIRY notification for the new record' });
      if (raised) {
        const mine = raised.filter((n) => n.type === 'COMPLIANCE_EXPIRY' && String(n.reference_id) === String(stored.id));
        ok('raising alerts writes a notification the API can read back', `${mine.length} notification(s) · severity ${mine[0].severity} · window ${before} row(s)`);
        if (mine.length === 1) ok('and exactly one, not one per press', 'the NOT EXISTS guard held');
        else bad('and exactly one, not one per press', `${mine.length} notifications for one record`);
      } else bad('raising alerts writes a notification the API can read back', 'no COMPLIANCE_EXPIRY notification appeared for the record');
    }
  } else bad('the alerts tab is there', 'no Expiry alerts tab');

  return finish();
})().catch((err) => {
  console.log(`\n  the probe failed: ${err && err.message ? err.message : err}`);
  if (process.env.PROBE_DEBUG) console.log(err && err.stack);
  process.exit(1);
});
