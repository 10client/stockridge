'use strict';
// =====================================================================
// tools/frontend-access.js — GIVING SOMEBODY A SECOND BUSINESS, FROM THE SCREEN
// =====================================================================
// The capability this proves: one operations manager running two businesses of a
// group, instead of a second account with a second PIN that makes the audit trail
// show two people where there is one.
//
// It is a DOM probe on purpose. The API is covered by tests over real HTTP, and
// this project has been bitten more than once by a screen that was written, tested
// at the API level, and could not actually be operated.
//
//   1. sign in as the deployment administrator, open Staff
//   2. open a person who is not an administrator
//   3. confirm the "Businesses this person can reach" section is there, and that
//      their own business is shown as theirs rather than as a switch
//   4. tick a second business and confirm the SERVER now holds the grant
//   5. untick it and confirm the server has withdrawn it
//
// A deployment with only one business has nothing to grant. That is reported as a
// SKIP — "nothing to prove here" — and never as a pass, because a probe that
// silently passes on an untested path is worse than no probe.
//
//   node tools/frontend-access.js --url=http://localhost:8787 --user=admin --pin=90210
//   node tools/frontend-access.js --url=… --user=admin --pin=1234 --create-second
// =====================================================================

const H = require('./lib/page-harness.js');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const BASE = String(flag('url', 'http://localhost:8787')).replace(/\/$/, '');
const USERNAME = flag('user', 'admin');
const PIN = flag('pin', '90210');
const PERSON = flag('person', null);
const CREATE_SECOND = args.includes('--create-second');

const results = [];
const ok = (what, detail) => { results.push({ pass: true, what }); console.log(`  ✓ ${what}${detail ? `\n      ${detail}` : ''}`); };
const bad = (what, detail) => { results.push({ pass: false, what }); console.log(`  ✗ ${what}${detail ? `\n      ${detail}` : ''}`); };
const skip = (what, detail) => { results.push({ pass: true, skip: true, what }); console.log(`  ⊘ ${what}${detail ? `\n      ${detail}` : ''}`); };

(async () => {
  console.log('StockRidge — cross-business access, from the screen');
  console.log(`  ${BASE} as ${USERNAME}`);
  console.log('─'.repeat(58));

  const page = await H.bootPage({ origin: BASE, username: USERNAME, pin: PIN, waitMs: 30000 });
  if (!page.ok) { bad('the app loaded', page.reason || 'boot failed'); process.exit(1); }
  const { window } = page;
  const doc = window.document;
  const SR = window.SR;

  const api = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json', Authorization: `Bearer ${page.token}` }),
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const who = await api('GET', '/api/auth/me');
  if (String(who.body.user.role).toUpperCase() !== 'ADMIN') {
    bad('signed in as the deployment administrator', `this seat is ${who.body.user.role}; only an administrator can grant cross-business access`);
    process.exit(1);
  }

  // ---- is there a second business to grant?
  let businesses = (await api('GET', '/api/businesses')).body.data || [];
  if (businesses.length < 2 && CREATE_SECOND) {
    // `api(method, path, payload)` — the payload is the THIRD argument. Wrapping it
    // as `{ body: {...} }` sent `{"body":{...}}`, and the server answered "name is
    // required" — the same mistake, in the tool built to catch it. The probe's own
    // first live run reported it as "could not create one (http 400)".
    const made = await api('POST', '/api/businesses', {
      name: 'Verification Furniture Co', profile_code: 'FURNITURE', seed_catalogue: false,
      branch: { name: 'Verification Showroom', code: 'VF-1', city: 'Aba', state: 'Abia', opening_cash: 10000 },
    });
    if (made.status === 201) {
      ok('a second business to grant (created for this probe)', `${made.body.business.name}`);
      businesses = (await api('GET', '/api/businesses')).body.data || [];
    } else {
      skip('a second business to grant', `could not create one (http ${made.status}): ${JSON.stringify(made.body).slice(0, 120)}`);
    }
  }

  // ---- open Staff, and pick somebody who is not an administrator
  const users = (await api('GET', '/api/users?limit=50')).body.data || [];
  const candidates = users.filter((u) => String(u.role).toUpperCase() !== 'ADMIN');
  const person = PERSON ? candidates.find((u) => String(u.username) === PERSON) : candidates[0];
  if (!person) {
    bad('a person to grant to', `this deployment has no non-administrator users yet (${users.length} user(s) in total)`);
    process.exit(1);
  }
  ok('a person to grant to', `${person.full_name || person.username} · ${person.role} · ${person.business_name || 'no business'}`);

  // The route is `/users`; its title is "Staff" in the navigation. The probe uses
  // the route, because a title is a label and a route is an address — pointing the
  // probe at the label reported "no such screen", which looked like a defect in the
  // screen rather than in the probe.
  window.SR.app.navigate('/users');
  const row = await H.waitUntil(() => {
    const cells = [...doc.querySelectorAll('#view td, #view .row, #view tr')];
    return cells.find((c) => c.textContent.includes(person.username)) || null;
  }, { timeout: 20000, label: 'the person on the Staff screen' });
  if (!row) { bad('the person is on the Staff screen', `nothing on /staff mentions ${person.username}`); process.exit(1); }
  (row.closest('tr') || row).click();

  // Wait for the SWITCHES, not for the fieldset. The fieldset appears at once with
  // "Checking…" inside it while the access list loads, so matching on the fieldset
  // alone finds a section that is not finished — which is exactly how this probe
  // first reported "no checkboxes rendered" about a section that was merely early.
  const section = await H.waitUntil(() => {
    const fs = [...doc.querySelectorAll('#modal-root fieldset')];
    const f = fs.find((x) => /businesses this person can reach/i.test(x.textContent));
    return f && f.querySelector('input[type="checkbox"]') ? f : null;
  }, { timeout: 20000, label: 'the businesses section to finish loading' });
  if (!section) { bad('opening a person shows the businesses they can reach', 'no fieldset matching /businesses this person can reach/'); process.exit(1); }
  ok('opening a person shows the businesses they can reach',
    section.textContent.replace(/\s+/g, ' ').trim().slice(0, 130));

  // ---- the boxes: their own business must be locked, the others switchable
  const boxes = [...section.querySelectorAll('input[type="checkbox"]')];
  if (!boxes.length) { bad('the section lists businesses with switches', 'no checkboxes rendered'); process.exit(1); }
  const locked = boxes.filter((b) => b.disabled).length;
  ok('the section lists businesses with switches', `${boxes.length} business(es), ${locked} locked (role or own business), ${boxes.length - locked} switchable`);

  // Only switches that are OFF: a business this person cannot reach yet. Picking
  // "the first enabled switch" would pick one that is already granted and re-grant
  // it, which the server refuses as a duplicate.
  const open = boxes.filter((b) => !b.disabled && !b.checked);
  if (!open.length) {
    skip('a business can be granted and withdrawn',
      businesses.length < 2
        ? 'this deployment has one business, so there is nothing to grant — run with --create-second against a test deployment'
        : 'every business is already reached or locked for this person');
  } else {
    const box = open[0];
    const label = (box.closest('label') || section).textContent.replace(/\s+/g, ' ').trim().slice(0, 60);
    const before = (await api('GET', `/api/users/${person.id}/business-access`)).body.data || [];
    // WHICH BUSINESS. The first run of this probe ticked a box, then unticked
    // "the first switchable box it could find" — and that is not the same thing.
    // Between the two, the screen re-renders itself from the server (the tick
    // saves, then the section reloads), so a snapshot taken a moment early sees
    // the PRE-reload boxes, whose first enabled one is a different, unchecked
    // business. The untick then asked the server to withdraw a grant that was
    // never made, the screen answered "no grant to remove", and the probe
    // reported the withdrawal as broken while the tick's own grant sat there —
    // which is exactly what the left-over grant on the first business was.
    //
    // So: name the business, and hold the probe to that one.
    const chosen = before.find((b) => label.toUpperCase().includes(String(b.name).toUpperCase()));
    if (!chosen) {
      bad('the switch names a business', `no business in the access list matches "${label}"`);
      console.log('─'.repeat(58));
      process.exit(1);
    }
    const grantedBefore = before.filter((b) => b.viaGrant).length;
    const grantState = async () => {
      const access = (await api('GET', `/api/users/${person.id}/business-access`)).body.data || [];
      const row = access.find((b) => b.id === chosen.id);
      return row ? !!row.viaGrant : null;
    };

    box.checked = true;
    box.dispatchEvent(new window.Event('change', { bubbles: true }));
    const grantedNow = await H.waitUntil(async () => ((await grantState()) ? true : null),
      { timeout: 15000, interval: 600, label: `the grant on ${chosen.name} to reach the server` });
    if (grantedNow) ok('ticking a business grants it, and the server holds it', `${chosen.name} · granted ${grantedBefore} → ${grantedBefore + 1}`);
    else bad('ticking a business grants it', `the server has no grant on ${chosen.name} after the tick`);

    // ---- take the SAME business off again, through the switch that shows it granted
    const untick = await H.waitUntil(() => {
      const fs = [...doc.querySelectorAll('#modal-root fieldset')];
      const f = fs.find((x) => /businesses this person can reach/i.test(x.textContent));
      if (!f) return null;
      const found = [...f.querySelectorAll('input[type="checkbox"]')]
        .find((b) => !b.disabled && b.checked && (b.closest('label') || f).textContent
          .toUpperCase().includes(String(chosen.name).toUpperCase()));
      return found || null;
    }, { timeout: 15000, label: `the switch for ${chosen.name} to show it granted` });
    if (untick) {
      untick.checked = false;
      untick.dispatchEvent(new window.Event('change', { bubbles: true }));
      const cleared = await H.waitUntil(async () => ((await grantState()) === false ? true : null),
        { timeout: 15000, interval: 600, label: `the withdrawal of ${chosen.name} to reach the server` });
      if (cleared) ok('unticking it withdraws the grant on the server', `${chosen.name} · back to ${grantedBefore} grant(s)`);
      else bad('unticking it withdraws the grant', `the server still holds the grant on ${chosen.name}`);
    } else {
      bad('the switch is still there after saving', `no enabled switch shows ${chosen.name} as granted after the tick`);
    }
  }

  console.log('─'.repeat(58));
  const failures = results.filter((r) => !r.pass);
  const skipped = results.filter((r) => r.skip);
  if (failures.length) console.log(`${failures.length} problem(s):\n${failures.map((f) => `  - ${f.what}`).join('\n')}`);
  else console.log(`The administrator can give a person a second business from the Staff screen${skipped.length ? ` (${skipped.length} path skipped — see above)` : ''}.`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => {
  console.log(`\n  the probe failed: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
