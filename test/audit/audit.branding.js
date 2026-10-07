'use strict';
// =====================================================================
// test/audit/audit.branding.js — WHOSE NAME IS ON THE FRONT DOOR
// =====================================================================
// This is a white-label product: a client's cashier should see their own shop's name on the
// sign-in screen, their own logo, their own receipt footer — and the vendor's name nowhere
// except the quiet "Powered by StockRidge" mark. `server/routes/branding.js` has been written
// to that design since the beginning and states it in its own header comment.
//
// WHEN THIS AUDIT WAS WRITTEN, NONE OF IT WAS TRUE IN THE PRODUCT:
//
//   * all five branding routes read "not reached by any screen" in the coverage report — a
//     complete, carefully-gated backend that no screen called. There was no branding screen;
//   * the sign-in screen showed the literal string "StockRidge" — the VENDOR'S name — because
//     nothing ever called the public endpoint that exists to prevent exactly that;
//   * and the public endpoint's own fallback was dead: it selected three columns and read a
//     fourth (`primary_business_id`), so a deployment that had not yet typed a trading name
//     fell through to the vendor's name while its first business had a perfectly good one.
//
//   FRONT TO BACK  an owner opens Settings, renames the shop, sets a footer and contact
//                  details, uploads a logo — and the PUBLIC endpoint (no token, the one the
//                  sign-in screen reads) answers with the new name and logo, the sign-in screen
//                  paints them, and each change is on the trail with its previous value.
//   BACK TO FRONT  a manager may read the full record but cannot write any of it; a staff
//                  member cannot even read it; the public endpoint leaks nothing (no contact
//                  details, no plan, no settings); the logo is validated by its BYTES, so an
//                  SVG carrying a script is refused whatever the request claims it is; and the
//                  audit row does not carry the image itself.
// =====================================================================

const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

// A 1x1 PNG, and an SVG that would run script if it were ever injected into an <img> src.
const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SVG_SCRIPT = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');

runAudit('branding', async (audit, d) => {
  const owner = d.owner;
  const manager = d.seats.manager;
  const staff = d.seats.staff;
  const admin = d.admin;

  const publicBranding = async () => {
    // NO TOKEN, DELIBERATELY: this is the call the sign-in screen makes before anybody exists.
    const res = await d.request('GET', '/api/branding');
    assert.equal(res.status, 200, `the public branding endpoint answered ${res.status}`);
    return res.json;
  };

  // ------------------------------------------------------------------
  // FRONT TO BACK — an owner renames the shop and the front door changes
  // ------------------------------------------------------------------
  await audit.checkAsync('the owner’s changes reach the public endpoint the sign-in screen reads', async () => {
    const before = await publicBranding();
    audit.note(`before: ${before.name}`);

    const put = await owner.put('/api/branding', {
      business_name: 'Branding Audit Stores',
      receipt_footer_text: 'Thank you. Returns within 7 days with this receipt.',
      admin_contact_name: 'Mrs Audit',
      admin_contact_phone: '0803 000 0000',
      admin_contact_email: 'owner@branding-audit.test',
    });
    assert.ok(put.status < 400, `the owner could not update the branding: ${put.status} ${String(put.text).slice(0, 200)}`);

    const after = await publicBranding();
    assert.equal(after.name, 'Branding Audit Stores',
      'the sign-in screen still shows the old name. `GET /api/branding` is public so the front door can carry the client\'s brand BEFORE anybody signs in — if it does not follow the owner\'s change, the front door is carrying somebody else\'s');
    assert.match(String(after.receiptFooter || ''), /Returns within 7 days/,
      'the receipt footer did not reach the public endpoint');
    assert.equal(after.poweredBy, 'StockRidge', 'the vendor mark should stay a separate, quiet field');
  });

  await audit.checkAsync('the public endpoint hands out a name, a logo and nothing else', async () => {
    // The router says what it is for: "No plan limits, no contact details, no feature toggles".
    const pub = await publicBranding();
    const keys = Object.keys(pub).sort();
    assert.deepEqual(keys, ['logoDataUrl', 'name', 'ok', 'poweredBy', 'receiptFooter'],
      `the unauthenticated endpoint now answers ${JSON.stringify(keys)}. Every field added here is published to the internet without a token`);
    const text = JSON.stringify(pub);
    for (const secret of ['0803 000 0000', 'owner@branding-audit.test', 'Mrs Audit']) {
      assert.ok(!text.includes(secret),
        `the public endpoint leaks "${secret}" — contact details belong behind the guard, not on the front door`);
    }
  });

  await audit.checkAsync('the full record is readable by a manager and writable by nobody below owner', async () => {
    const full = await manager.get('/api/branding/full');
    assert.equal(full.status, 200, `a manager could not read the branding record (${full.status})`);
    assert.equal((full.json.admin || {}).contactName, 'Mrs Audit', 'the full record should carry the contact details the public one hides');

    const put = await manager.put('/api/branding', { business_name: 'Manager Renamed This' });
    assert.equal(put.status, 403, `a manager renamed the deployment for every branch (${put.status})`);
    assert.equal(put.json.code, 'ROLE_REQUIRED', `refused as ${put.json.code}`);

    const notStaff = await staff.get('/api/branding/full');
    assert.equal(notStaff.status, 403, `a staff member read the branding record (${notStaff.status})`);

    const unchanged = await publicBranding();
    assert.equal(unchanged.name, 'Branding Audit Stores', 'a refused write changed the name anyway');
  });

  await audit.checkAsync('a logo is accepted by its bytes, and an SVG carrying script is refused', async () => {
    const bad = await owner.post('/api/branding/logo', { logoDataUrl: SVG_SCRIPT });
    assert.equal(bad.status, 400,
      `an SVG carrying a script was accepted (${bad.status}). This value is injected into an <img src> on the settings page and the sign-in screen`);
    assert.ok(!JSON.stringify(bad.json).includes('alert(1)'), 'the refusal echoed the payload back');

    const good = await owner.post('/api/branding/logo', { logoDataUrl: PNG_1X1 });
    assert.ok(good.status < 400, `a PNG was refused: ${good.status} ${String(good.text).slice(0, 200)}`);

    const pub = await publicBranding();
    assert.equal(pub.logoDataUrl, PNG_1X1, 'the uploaded logo did not reach the public endpoint the sign-in screen reads');

    // And it can be taken back off, leaving the wordmark.
    const removed = await owner.del('/api/branding/logo');
    assert.ok(removed.status < 400, `the logo could not be removed (${removed.status})`);
    assert.equal((await publicBranding()).logoDataUrl, null, 'the logo survived its own removal');
  });

  await audit.checkAsync('every branding change is on the trail with its previous value — and without the image', async () => {
    const res = await owner.get('/api/audit?action=BRANDING_UPDATED&limit=20');
    assert.equal(res.status, 200, `the trail answered ${res.status}`);
    const rows = res.json.data || [];
    assert.ok(rows.length >= 1, 'renaming the shop is not on the trail');

    const rename = rows.find((r) => String(r.after_json || '').includes('Branding Audit Stores'));
    assert.ok(rename, `no BRANDING_UPDATED row carries the new name: ${rows.map((r) => String(r.after_json).slice(0, 60)).join(' | ')}`);
    assert.match(String(rename.before_json || ''), /"business_name"/,
      'the row must record what the name WAS — "who changed it" without "from what" cannot be undone');
    assert.ok(!String(rename.before_json).includes('data:image'), 'the trail is carrying the logo image itself');
    assert.ok(!String(rename.after_json).includes('data:image'), 'the trail is carrying the logo image itself');

    const logoRow = rows.find((r) => String(r.after_json || '').includes('logoBytes'));
    assert.ok(logoRow, 'the logo change is not on the trail as a size, which is how it stays out of the table');
    audit.note(`trail: ${rows.length} BRANDING_UPDATED row(s), the logo recorded as bytes`);
  });

  // ------------------------------------------------------------------
  // BACK TO FRONT —
  // ------------------------------------------------------------------
  await audit.checkAsync('a deployment with no trading name shows the CLIENT’S name, not the vendor’s', async () => {
    // THE BUG THIS AUDIT WAS WRITTEN AROUND. `publicBranding` selected three columns and read
    // a fourth (`primary_business_id`), so the fallback to the deployment's own business never
    // ran: a fresh deployment — the day it is handed over, before anybody types a name — showed
    // the VENDOR'S name at the front door, and the state where a white-label product most needs
    // to carry the client's name is exactly that one.
    //
    // The state cannot be reached through the API, and that is correct: a blank or absent
    // trading name is refused (a shop has to have a name). It IS reached by a deployment that
    // has just created its first business, so the row is set straight in the database — the
    // same way the trail audit edits a row to prove the chain notices — and put back in a
    // `finally` so a failed run cannot leave a shop called "null" on every receipt.
    const path = require('path');
    const { openDatabase } = require(path.join(__dirname, '..', '..', 'server/lib/db.js'));
    const db = openDatabase({ file: d.dbFile });
    const original = (await db.first('SELECT business_name FROM client_settings WHERE id = 1')).business_name;
    try {
      await db.run('UPDATE client_settings SET business_name = NULL WHERE id = 1');

      const pub = await publicBranding();
      assert.notEqual(pub.name, 'StockRidge',
        'with no trading name typed the front door shows the VENDOR’S name while the deployment has its own business: `primary_business_id` is read from a row the query never selected');
      assert.equal(pub.name, 'Branding Audit Business',
        `the fallback must be the deployment's own business, and it answered ${JSON.stringify(pub.name)}`);
      audit.note(`with no trading name typed, the front door reads ${JSON.stringify(pub.name)}`);

      // AN ABSENT NAME AND A BLANK NAME ARE BOTH REFUSED, and neither may become a name. A JSON
      // body saying `null` used to become the literal word "null" — `String(null)` is truthy —
      // so the shop was renamed to "null" on every receipt and on the sign-in screen.
      for (const [what, body] of [['null', { business_name: null }], ['blank', { business_name: '   ' }]]) {
        const refused = await owner.put('/api/branding', body);
        assert.equal(refused.status, 400, `a ${what} trading name was accepted (${refused.status})`);
        const after = await publicBranding();
        assert.ok(!String(after.name).toLowerCase().includes('null'),
          `a ${what} name was stored as ${JSON.stringify(after.name)}`);
      }
    } finally {
      await db.run('UPDATE client_settings SET business_name = ? WHERE id = 1', [original]);
      const restored = await publicBranding();
      assert.equal(restored.name, original, 'the branding was not restored after the fallback test — later checks would run against a renamed shop');
    }
  });

  await audit.checkAsync('the two lists agree: the form sends what the route accepts, and the route accepts what the form sends', async () => {
    // THE STANDING DIRECTIVE, AS A CHECK. "Every admin control the FE shows must have a BE rule
    // behind it, and every admin rule the BE enforces must be reachable from the FE." Here that
    // is two literal lists of field names: the `allow` object in `server/routes/branding.js` and
    // `BRANDING_FIELDS` in `public/js/views/admin.js`. Neither may drift from the other, and
    // neither may drift from the API — every name must be one the PUT route really honours.
    const fs = require('fs');
    const path = require('path');
    const root = path.resolve(__dirname, '..', '..');
    const routeSrc = fs.readFileSync(path.join(root, 'server', 'routes', 'branding.js'), 'utf8');
    const viewSrc = fs.readFileSync(path.join(root, 'public', 'js', 'views', 'admin.js'), 'utf8');

    const allowBlock = routeSrc.match(/const allow = \{([\s\S]*?)\n    \};/);
    assert.ok(allowBlock, 'the `allow` list could not be found in the branding route — this scan needs updating, not deleting');
    const accepts = new Set([...allowBlock[1].matchAll(/^\s{6}([a-z_]+):/gm)].map((m) => m[1]));

    const fieldsBlock = viewSrc.match(/const BRANDING_FIELDS = \[([^\]]*)\]/);
    assert.ok(fieldsBlock, 'BRANDING_FIELDS could not be found in the settings screen — this scan needs updating, not deleting');
    const offered = new Set([...fieldsBlock[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));

    assert.ok(accepts.size >= 5, `only ${accepts.size} field(s) parsed out of the route`);
    assert.deepEqual([...offered].filter((f) => !accepts.has(f)), [],
      'the screen offers fields the route ignores — filling them in would silently do nothing');
    assert.deepEqual([...accepts].filter((f) => !offered.has(f)), [],
      'the route accepts fields no screen sends — a control nobody can reach is a feature that does not exist');
    audit.note(`both lists: ${[...accepts].sort().join(', ')}`);

    // ONE CONTROL PER FACT. The feature switches are described in `SETTING_GROUPS`, and five of
    // those keys — the trading name, the receipt footer and the three contact details — are
    // ALSO real `client_settings` columns that `PUT /api/settings` will happily write. A screen
    // offering both controls would let the second save silently undo the first, and the audit
    // trail would carry two different action names for one field. The branding card owns them;
    // this refuses to let them reappear in the switches.
    const groupBlock = viewSrc.match(/const SETTING_GROUPS = \[([\s\S]*?)\n  \];/);
    assert.ok(groupBlock, 'SETTING_GROUPS could not be found in the settings screen — this scan needs updating, not deleting');
    const switchKeys = new Set([...groupBlock[1].matchAll(/key:\s*'([a-z_]+)'/g)].map((m) => m[1]));
    assert.ok(switchKeys.size >= 20, `only ${switchKeys.size} switch key(s) parsed out of the screen`);
    const doubled = [...switchKeys].filter((k) => accepts.has(k));
    assert.deepEqual(doubled, [],
      `${JSON.stringify(doubled)} can be edited from two cards on one screen: the switches write them through PUT /api/settings and the branding card writes them through PUT /api/branding, so the second save silently undoes the first`);
    audit.note(`${switchKeys.size} feature switches, none of them branding fields`);

    // And the fetch of the record the card reads is guarded, not public.
    const fullAnonymous = await d.request('GET', '/api/branding/full');
    assert.equal(fullAnonymous.status, 401, `the full branding record answered ${fullAnonymous.status} without a token`);
    void admin;
  });
}, {
  setup: () => startDeployment({
    label: 'branding',
    businesses: [{
      name: 'Branding Audit Business', profileCode: 'GENERAL_RETAIL', vatRegistered: true,
      branches: [
        { name: 'Branding Audit Branch', code: 'BR-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 10000 },
      ],
    }],
    seats: [
      { as: 'owner', role: 'OWNER', username: 'br-owner', pin: '61831', branchIndex: 0, full_name: 'Branding Audit Owner' },
      { as: 'manager', role: 'MANAGER', username: 'br-manager', pin: '61832', branchIndex: 0, full_name: 'Branding Audit Manager' },
      { as: 'staff', role: 'STAFF', username: 'br-staff', pin: '61833', branchIndex: 0, full_name: 'Branding Audit Counter' },
    ],
  }),
});
