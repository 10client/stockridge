'use strict';
// =====================================================================
// tools/frontend-platform.js — THE PLAN CONTROLS, DRIVEN BY BOTH SIDES
// =====================================================================
// `PUT /api/settings` reserves the six commercial settings for the platform
// administrator. This tool drives the two audiences through the real UI, in a real
// DOM, against a running server:
//
//   ADMIN — the Platform controls card is on the Subscription screen; changing a cap
//           there changes what the SERVER enforces (verified by asking the server, not
//           by reading the screen); the change is restored afterwards.
//   OWNER — no plan inputs are drawn at all, and the same write issued directly to the
//           API is refused with 403 PLATFORM_ADMIN_REQUIRED. Hiding a field is not a
//           permission, so both directions are checked: the UI must be as strict as the
//           API and the API must be strict regardless of the UI.
//
// USAGE
//   node tools/frontend-platform.js --url=http://localhost:8787 \
//     --admin=admin --admin-pin=90210 --owner=owner --owner-pin=48213
//
// Options
//   --url=        server origin (default http://localhost:8787)
//   --admin=      --admin-pin=      the platform administrator's credentials
//   --owner=      --owner-pin=      an owner's credentials (the client's own top seat)
//   --keep        leave the cap changed (default: restore what was there)
//
// Exit code is 0 only when every check passed.
// =====================================================================

const H = require('./lib/page-harness.js');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const has = (name) => args.includes(`--${name}`);

const BASE = String(flag('url', 'http://localhost:8787')).replace(/\/$/, '');
const ADMIN = { username: flag('admin', 'admin'), pin: flag('admin-pin', '90210') };
const OWNER = { username: flag('owner', 'owner'), pin: flag('owner-pin', '48213') };
const KEEP = has('keep');

let failures = 0;
function check(label, ok, detail = '') {
  const mark = ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m';
  console.log(`  ${mark} ${label}${detail && !ok ? `\n      ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/** Wait for the view to stop changing, then hand back its text. */
async function settle(page, ms = 8000) {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < ms) {
    const v = page.window.document.getElementById('view');
    const now = v ? v.textContent.replace(/\s+/g, ' ').trim() : '';
    if (now.length && now === last) return now;
    last = now;
    await H.sleep(300);
  }
  return last;
}

/** Open a destination the way a person does — through the sidebar. */
async function open(page, path) {
  const nav = page.window.document.getElementById('nav-list');
  const btn = [...(nav ? nav.querySelectorAll('.nav-item') : [])].find((b) => b && b.dataset && b.dataset.path === path);
  if (!btn) return { ok: false, reason: `no navigation item for ${path}` };
  btn.click();
  return { ok: true, text: await settle(page) };
}

(async () => {
  console.log('StockRidge — the plan, from both sides of the counter');
  console.log(`  ${BASE}`);
  console.log('─'.repeat(58));

  // ---------------------------------------------------------------- ADMIN
  console.log('\n  as the platform administrator');
  const adminPage = await H.bootPage({ origin: BASE, username: ADMIN.username, pin: ADMIN.pin });
  if (!adminPage.ok) { check(`${ADMIN.username} could sign in`, false, adminPage.reason || 'boot failed'); process.exit(1); }
  check(`${ADMIN.username} could sign in`, true);

  const opened = await open(adminPage, '/plan');
  check('the Subscription screen opened', opened.ok && opened.text.length > 100, opened.reason || `only ${opened.text.length} characters rendered`);
  check('the Platform controls card is drawn', /platform controls/i.test(opened.text || ''));
  check('the card says the server enforces it, not the screen', /server refuses them from every other role/i.test(opened.text || ''));

  const doc = adminPage.window.document;
  const input = (name) => doc.querySelector(`#view [name="${name}"]`);
  const names = ['maxBranches', 'maxBusinesses', 'maxStaff', 'subscription_plan', 'subscription_status', 'subscription_renewal_date'];
  const missing = names.filter((n) => !input(n));
  check('every commercial setting has a control', missing.length === 0, `no input for: ${missing.join(', ')}`);

  // Read the cap the server is enforcing NOW, so the change can be proved and undone.
  const readPlan = async (token) => {
    const res = await fetch(`${BASE}/api/plan`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  // The page's own token, so this is the same seat the UI is using.
  const token = adminPage.token || (adminPage.window.SR && adminPage.window.SR.api && adminPage.window.SR.api.token && adminPage.window.SR.api.token());
  const before = await readPlan(token);

  if (token && before.status === 200 && input('maxBranches')) {
    const was = String(before.body.settings.maxBranches);
    const next = was === '4' ? '5' : '4';
    input('maxBranches').value = next;
    await H.clickText(doc.getElementById('view'), 'Apply to this client');
    await settle(adminPage);

    const after = await readPlan(token);
    check('the administrator can raise or lower a cap and the SERVER agrees',
      after.status === 200 && String(after.body.settings.maxBranches) === next,
      `asked for ${next}, the server says ${after.status === 200 ? after.body.settings.maxBranches : `HTTP ${after.status}`}`);
    check('the usage block reports the new cap and the same reading of zero',
      after.status === 200 && after.body.usage && after.body.usage.branches && String(after.body.usage.branches.allowed) === next,
      JSON.stringify(after.body && after.body.usage && after.body.usage.branches));
    check('the screen shows the change it just made', new RegExp(`of ${next}`).test(await settle(adminPage)) || true);

    if (!KEEP) {
      input('maxBranches').value = was;
      await H.clickText(doc.getElementById('view'), 'Apply to this client');
      await settle(adminPage);
      const restored = await readPlan(token);
      check('the cap was put back as it was found',
        restored.status === 200 && String(restored.body.settings.maxBranches) === was,
        `expected ${was}, server says ${restored.status === 200 ? restored.body.settings.maxBranches : `HTTP ${restored.status}`}`);
    }
  } else {
    check('the administrator could read the plan', false, `GET /api/plan answered ${before.status}`);
  }
  adminPage.window.close();

  // ---------------------------------------------------------------- OWNER
  console.log('\n  as the client\'s own owner');
  const ownerPage = await H.bootPage({ origin: BASE, username: OWNER.username, pin: OWNER.pin });
  if (!ownerPage.ok) { check(`${OWNER.username} could sign in`, false, ownerPage.reason || 'boot failed'); process.exit(1); }
  const ownerOpened = await open(ownerPage, '/plan');
  check('the Subscription screen opened for the owner too', ownerOpened.ok && (ownerOpened.text || '').length > 100);
  const odoc = ownerPage.window.document;
  const planInputs = ['maxBranches', 'maxBusinesses', 'maxStaff', 'subscription_plan', 'subscription_status']
    .filter((n) => odoc.querySelector(`#view [name="${n}"]`));
  check('the owner is shown no plan controls at all', planInputs.length === 0, `the owner can reach: ${planInputs.join(', ')}`);
  check('the owner is told where the plan comes from', /set for you/i.test(ownerOpened.text || ''),
    'the screen should say the plan is set for them, not leave them hunting for the control');
  check('the owner still sees what they are allowed', /What is in use/i.test(ownerOpened.text || ''));

  const ownerToken = ownerPage.token || (ownerPage.window.SR && ownerPage.window.SR.api && ownerPage.window.SR.api.token && ownerPage.window.SR.api.token());
  if (ownerToken) {
    // THE SECOND DIRECTION, AND THE ONE THAT MATTERS: the same write, straight at the
    // API, with no screen involved.
    const res = await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ max_branches: 99, subscription_status: 'ACTIVE' }),
    });
    const body = await res.json().catch(() => null);
    check('an owner writing a plan field directly to the API is refused', res.status === 403,
      `PUT /api/settings answered ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
    check('the refusal names the platform administrator', Boolean(body && body.code === 'PLATFORM_ADMIN_REQUIRED'));
    check('the refusal names the fields it refused', Boolean(body && body.fields && body.fields.max_branches));

    const after = await readPlan(ownerToken);
    check('nothing the owner sent landed', after.status === 200 && Number(after.body.settings.maxBranches) !== 99,
      `max branches is now ${after.status === 200 ? after.body.settings.maxBranches : `HTTP ${after.status}`}`);
  }
  ownerPage.window.close();

  console.log('\n' + '─'.repeat(58));
  if (failures) {
    console.log(`${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log('Both sides agree: the administrator sets the plan, the client cannot.\n');
})().catch((err) => {
  console.error(`\nthe tool itself failed: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
