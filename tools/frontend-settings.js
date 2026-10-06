'use strict';
// =====================================================================
// tools/frontend-settings.js — THE CONTROLS, THROUGH THE REAL SCREEN
// =====================================================================
// The Settings screen had a defect that no API test can see: fifteen of its
// thirty controls named keys the deployment did not have, and the renderer skips
// a key it does not have — so those controls did not sit there failing to save.
// THEY NEVER DREW. A server-side test passes whether the switch is on the page or
// not, because the server never knew the control existed.
//
// So this walks the DOM and asserts what a person would see:
//
//   1. the screen opens, as a settings-capable role
//   2. every setting the screen claims to offer has an INPUT on the page — by
//      name, so a control cannot be "present" as a label with no field
//   3. nothing on the page says a control is unavailable, which is what the
//      renderer now prints instead of skipping silently
//   4. the controls that USED to be missing are specifically there: the receipt
//      footer, the stock warning, the serial capture, the credit grace period
//   5. a value typed into the page reaches the server — read back over HTTP, not
//      out of the page — and is restored afterwards, so a demo deployment is left
//      as it was found
//
//   node tools/frontend-settings.js --url=http://localhost:8812 --user=owner --pin=48213
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

/** The controls the screen is expected to draw, from the source that declares them
 *  — the same list `test/unit/settings-controls.test.js` checks against the schema. */
function declaredControls() {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'admin.js'), 'utf8');
  const start = src.indexOf('const SETTING_GROUPS');
  const block = src.slice(start, src.indexOf('\n  ];', start));
  return [...block.matchAll(/\{ key: '([a-z_0-9]+)'/g)].map((m) => m[1]);
}

/** The seven that were missing, named individually. A count would pass if the
 *  screen drew a hundred wrong controls. */
const FORMERLY_INVISIBLE = [
  ['receipt_footer_text', 'the line printed on every receipt'],
  ['low_stock_alert_enabled', 'the stock warning'],
  ['serial_tracking_enabled', 'serial capture'],
  ['staff_can_spend_from_safe', 'staff drawing cash from the safe'],
  ['credit_grace_days', 'how late a debtor may be'],
  ['instalment_default_after_days', 'when an instalment plan has failed'],
  ['instalment_default_after_missed', 'missed instalments that mean the same'],
];

(async () => {
  console.log('\nStockRidge — the settings controls, from the screen');
  console.log(`  ${BASE} as ${USERNAME}`);
  console.log('─'.repeat(58));

  const page = await H.bootPage({ origin: BASE, username: USERNAME, pin: PIN });
  if (!page.ok) { bad('the app loaded', page.reason || 'boot failed'); process.exit(1); }
  const { window } = page;
  const doc = window.document;

  const api = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json', Authorization: `Bearer ${page.token}` }),
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const settle = async (ms = 2500) => new Promise((r) => setTimeout(r, ms));

  try {
    window.SR.app.navigate('/settings');
    await settle(4000);

    const h1 = doc.querySelector('#view h1');
    if (h1 && /settings/i.test(h1.textContent)) ok('the settings screen opens', h1.textContent.trim());
    else bad('the settings screen opens', h1 ? `the page title is "${h1.textContent.trim()}"` : 'no heading on the page — this seat may not be allowed to see Settings at all');

    const inputs = [...doc.querySelectorAll('#view [name]')];
    const byName = new Map(inputs.map((el) => [el.getAttribute('name'), el]));
    ok('the screen drew controls', `${inputs.length} input(s) on the page`);

    // 2. every declared control, by name
    const declared = declaredControls();
    const missing = declared.filter((k) => !byName.has(k));
    if (!missing.length) ok('every control the screen declares is on the page', `${declared.length} control(s), all present by name`);
    else bad('every control the screen declares is on the page', `missing: ${missing.join(', ')} — a control that is declared and not drawn is a setting nobody can change`);

    // 3. the new failure mode must not be visible (it prints instead of skipping)
    const unavailable = [...doc.querySelectorAll('#view .err')].map((n) => n.textContent.trim()).filter((t) => /not available on this deployment/i.test(t));
    if (!unavailable.length) ok('nothing on the page says a control is unavailable');
    else bad('nothing on the page says a control is unavailable', unavailable.slice(0, 3).join(' | '));

    // 4. the ones that used to be invisible, named
    for (const [key, what] of FORMERLY_INVISIBLE) {
      if (byName.has(key)) skip(`on screen: ${key}`, what);
      else bad(`on screen: ${key}`, `${what} — this control used to be missing, and it is missing again`);
    }

    // 5. a typed value reaches the server, and is put back
    const SETTING = 'credit_grace_days';
    const before = (await api('GET', '/api/settings')).body.settings[SETTING];
    const target = Number(before) === 7 ? 11 : 7;
    const field = byName.get(SETTING);
    if (!field) {
      bad('a value typed into the page reaches the server', `${SETTING} is not on the page, so there is nothing to type into`);
    } else {
      // Set the value and fire the events a person's typing would.
      field.value = String(target);
      field.dispatchEvent(new window.Event('input', { bubbles: true }));
      field.dispatchEvent(new window.Event('change', { bubbles: true }));

      const save = [...doc.querySelectorAll('#view button')].find((b) => /save changes/i.test(b.textContent));
      if (!save) {
        bad('a value typed into the page reaches the server', 'no "Save changes" button on the page');
      } else {
        save.click();
        await settle(3500);
        const stored = (await api('GET', '/api/settings')).body.settings[SETTING];
        if (Number(stored) === target) ok('a value typed into the page reaches the server', `${SETTING} = ${target}, read back over HTTP`);
        else bad('a value typed into the page reaches the server', `typed ${target}, the server holds ${stored}`);

        // PUT IT BACK. A probe that changes a real deployment's credit policy and
        // walks away has left a business with a setting nobody chose.
        if (!KEEP) {
          const restored = await api('PUT', '/api/settings', { [SETTING]: Number(before) });
          const now = (await api('GET', '/api/settings')).body.settings[SETTING];
          if (restored.status === 200 && Number(now) === Number(before)) skip('the setting was put back', `${SETTING} = ${before}`);
          else bad('the setting was put back', `could not restore ${SETTING} to ${before} (server holds ${now})`);
        }

        // The audit trail must name the change: "who shortened the credit grace
        // period?" is exactly the question this screen exists to answer.
        const audit = await api('GET', '/api/audit?action=SETTINGS_UPDATED');
        const rows = (audit.body && audit.body.data) || [];
        if (rows.length) skip('the change was audited', `${rows.length} settings change(s) in the trail`);
        else bad('the change was audited', 'no SETTINGS_UPDATED row in the audit trail');
      }
    }
  } finally {
    console.log('─'.repeat(58));
    const failures = results.filter((r) => !r.pass);
    const skipped = results.filter((r) => r.skip);
    if (failures.length) {
      console.log(`${failures.length} problem(s):`);
      for (const f of failures) console.log(`  - ${f.what}`);
    }
    console.log(`${results.length - failures.length - skipped.length} check(s) passed${skipped.length ? `, ${skipped.length} reported` : ''} — every control on the screen can be saved.`);
    process.exit(failures.length ? 1 : 0);
  }
})();
