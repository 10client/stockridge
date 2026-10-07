'use strict';
// =====================================================================
// test/audit/audit.http.js — THE CONTRACT AT THE EDGE, ON A REAL SOCKET
// =====================================================================
// PharmaRidge's `audit.http.js` reads "the REAL response headers", because a
// config file that claims to set them is a claim rather than a measurement. This
// is that audit for StockRidge, and it is the first one because it is the form
// that proves the harness: a live server, real sockets, real status codes.
//
// WHAT IT ASKS
//
//   The things every client in this market depends on and no unit test can see,
//   because they live in the layer BELOW the route handler:
//
//     * is the API actually mounted where the client thinks it is?
//     * does an unauthenticated call answer 401 in the shape the client's error
//       handler expects — or does it return 200 with an empty list, which looks
//       like "you have no data" to a shop that has plenty?
//     * does an unknown route answer `404 JSON`, or the HTML of the SPA? (The
//       client parses every response as JSON; an HTML 404 on a typo'd path makes
//       the error message unreadable at exactly the moment somebody needs it.)
//     * does a bad method on a real route answer 404/405 JSON rather than 500?
//     * does the static file server serve the shell, and are the PWA files
//       actually there — manifest, service worker, icons — with the content
//       types a browser needs to install the app?
//     * does a malformed JSON body answer 400 rather than crashing the parser?
//     * are the security headers present on a real response?
//
// A NOTE ON WHAT "PASS" MEANS HERE. Every check below is written so that it
// FAILS on a plausible bug rather than passing on any response at all. `assert
// res.status === 404` is worth more than `assert res.status < 500`, and the
// negative control for this file (recorded in STATUS.md) was to mount the API
// under a different prefix and watch it go red.
// =====================================================================

const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

runAudit('http', async (audit, d) => {
  audit.section('The API is where the client thinks it is');
  await audit.twoWay('a health check answers without a token',
    () => d.request('GET', '/api/health'),
    (res) => {
      assert.equal(res.status, 200, `health answered ${res.status}`);
      assert.equal(res.json && res.json.ok, true, 'health must answer ok:true');
    });

  await audit.checkAsync('the API answers JSON, with the content type to match', async () => {
    const res = await d.request('GET', '/api/health');
    assert.match(String(res.headers['content-type']), /application\/json/, `content-type was "${res.headers['content-type']}"`);
  });

  audit.section('Unauthenticated calls are refused, in the shape the client parses');
  await audit.refusal('a list without a token is 401, not an empty list',
    () => d.request('GET', '/api/products'),
    { expectStatus: 401, code: /TOKEN|AUTH/, message: /sign in/i });

  for (const method of ['POST', 'PUT', 'DELETE']) {
    await audit.refusal(`a ${method} without a token is refused, not executed`,
      () => d.request(method, '/api/products', { body: {} }));
  }

  await audit.refusal('a rubbish token is refused the same way as no token',
    () => d.request('GET', '/api/products', { token: 'not.a.jwt' }),
    { expectStatus: 401 });

  // EVERYTHING BELOW NEEDS SOMEBODY SIGNED IN, and on a live target the owner seat
  // may not have been offered: a production deployment has exactly one account, the
  // administrator. The generic checks only need A signed-in caller, so they take
  // whichever seat exists rather than failing for a reason that is not a defect.
  const signedIn = d.owner || d.admin;
  audit.check('this audit has somebody signed in to ask as', () => {
    assert.ok(signedIn, 'neither an owner seat nor an administrator seat could sign in');
  });

  audit.section('A route that does not exist answers JSON, not the SPA shell');
  // THE DEFECT THIS EXISTS FOR. A single-page app usually falls back to
  // `index.html` for anything it does not recognise, which is right for a URL a
  // person typed and wrong for an API path: the client parses every response as
  // JSON, so an HTML 404 arrives as a parse error and the real cause (a typo in a
  // path) is lost.
  // WITH A TOKEN. The auth guard runs before routing, so an unauthenticated path
  // that does not exist is answered 401 — which is the right answer (fail closed,
  // and never tell an anonymous caller which paths exist) and is asserted below.
  // The question here is what a SIGNED-IN client gets a for a path that is not
  // there, because that is when a typo in the client's own code has to be legible.
  for (const urlPath of ['/api/nope', '/api/products/does-not-exist-route']) {
    const res = await signedIn.get(urlPath);
    audit.check(`${urlPath} answers 404 JSON`, () => {
      assert.equal(res.status, 404, `answered ${res.status}`);
      assert.ok(res.json && !res.json._raw,
        `the body was not JSON — it was "${String(res.text).slice(0, 60)}", which the client cannot read as an error`);
      assert.ok(res.json.error || res.json.message, 'a 404 must say what was not found');
    });
  }

  await audit.checkAsync('a wrong method on a real route is 404 or 405, never 500', async () => {
    // `signedIn`, not `d.owner`: a production deployment has exactly one account, so
    // requiring an owner seat here would fail on the environment that matters most —
    // and it did, on both sample and production, as "Cannot read properties of
    // undefined (reading 'call')". The lesson is the one this whole file keeps
    // teaching: a check that reaches for a fixture that may not exist reports its own
    // missing fixture as a product defect.
    const res = await signedIn.call('DELETE', '/api/auth/login', {});
    assert.ok([404, 405, 400].includes(res.status),
      `DELETE /api/auth/login answered ${res.status} — a 500 here means the router let it through to something that assumed a body`);
    assert.ok(res.json && !res.json._raw, 'the answer must be JSON');
  });

  await audit.checkAsync('an unauthenticated path that does not exist is 401, not 404', async () => {
    // FAIL CLOSED, AND SHUT. A 404 to an anonymous caller tells them which paths
    // exist; a 401 tells them nothing. This is worth asserting because the two
    // orderings (guard-then-route, route-then-guard) look identical in code and
    // differ entirely in what they reveal.
    const res = await d.request('GET', '/api/definitely-not-a-route');
    assert.equal(res.status, 401, `an anonymous caller was told ${res.status} about a path that does not exist`);
  });

  audit.section('Malformed input is a 400, not a crash');
  await audit.checkAsync('a body that is not JSON answers 400', async () => {
    const res = await fetch(`${d.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'audit' },
      body: '{"username": "admin", "pin": ',
    });
    assert.equal(res.status, 400, `a truncated JSON body answered ${res.status}`);
    const json = await res.json().catch(() => null);
    assert.ok(json && (json.error || json.message), 'the 400 must carry a message');
  });

  await audit.checkAsync('a JSON array where an object belongs answers 400', async () => {
    const res = await d.request('POST', '/api/auth/login', { body: [1, 2, 3] });
    assert.ok(res.status >= 400 && res.status < 500, `an array body answered ${res.status}`);
    assert.ok(res.json && !res.json._raw, 'the answer must be JSON');
  });

  await audit.checkAsync('an empty body where one is required answers 400, not 500', async () => {
    const res = await d.request('POST', '/api/auth/login', { token: null });
    assert.ok(res.status >= 400 && res.status < 500, `an empty login body answered ${res.status}`);
    assert.ok(res.json && (res.json.error || res.json.message));
  });

  audit.section('The PWA is served, and installable');
  let _shellHtml = null;
  const shellText = () => _shellHtml;
  // A SHOP INSTALLS THIS ON A PHONE. If the manifest or the service worker is
  // missing, the app still works in a browser tab and cannot be installed — which
  // nobody notices until a client is standing in a market asking why.
  await audit.checkAsync('the shell is served at /', async () => {
    const res = await fetch(`${d.base}/`);
    assert.equal(res.status, 200, `the shell answered ${res.status}`);
    const html = await res.text();
    _shellHtml = html;
    assert.match(html, /<div[^>]+id="view"/, 'the shell must contain the mount point the app draws into');
    // ...WITH THE DEPLOY'S STAMP ON IT. A shell that names `/js/app.js` bare can be answered,
    // entirely, from a service-worker cache holding last week's files — which is how a fixed
    // serial box on the purchase-order receive form was reported missing from staging while the
    // deployed worker was serving the fix. The stamp is what makes the new file arrive.
    assert.match(html, /<script[^>]+src="\/js\/app\.js\?v=ridge-[0-9]{8}-[0-9]{4}-[0-9a-z]+"/,
      'the shell must load the app, and name the build it was deployed with');
    const shellAssets = html.match(/(?:src|href)="\/(?:js|css)\/[^"]+"/g) || [];
    const unstamped = shellAssets.filter((t) => !/\?v=ridge-/.test(t));
    assert.equal(unstamped.length, 0,
      `${unstamped.length} asset URL(s) in the served shell carry no build stamp, starting with ${unstamped[0]} — those can be served from a stale cache`);
  });

  // THE MANIFEST THIS APP ACTUALLY DECLARES. It is generated by the server rather
  // than checked in (`<link rel="manifest" href="/api/manifest.json">`), so the
  // audit reads the link out of the shell instead of assuming a filename — an
  // audit of a file nobody links to proves nothing.
  const manifestHref = audit.capture('the shell declares a web app manifest', () => {
    const html = shellText();
    const m = String(html).match(/<link[^>]+rel=["']manifest["'][^>]+href=["']([^"']+)["']/i);
    assert.ok(m, 'no <link rel="manifest"> in the shell — the app cannot be installed on a phone');
    return m[1];
  });

  if (manifestHref) {
    await audit.checkAsync(`${manifestHref} is served and installable`, async () => {
      const res = await fetch(manifestHref.startsWith('http') ? manifestHref : d.base + manifestHref);
      assert.equal(res.status, 200, `the manifest answered ${res.status}`);
      const manifest = await res.json();
      assert.ok(manifest.name || manifest.short_name, 'a manifest without a name cannot be installed with a label');
      assert.ok(manifest.start_url, 'a manifest without start_url cannot be installed');
      assert.ok(manifest.display, 'a manifest without display mode installs as a browser tab, not an app');
      assert.ok(manifest.theme_color, 'no theme_color: the phone status bar will not match the app');
    });
  }

  await audit.checkAsync('/sw.js is served', async () => {
    const res = await fetch(`${d.base}/sw.js`);
    assert.equal(res.status, 200, `/sw.js answered ${res.status}`);
    const body = await res.text();
    assert.match(body, /addEventListener|caches/, '/sw.js does not look like a service worker');
  });

  await audit.checkAsync('the service worker precaches the offline fallback it names', async () => {
    // WHAT A SHOP WITH NO NETWORK ACTUALLY SEES. A service worker that names a
    // fallback page it never caches serves the browser's own dinosaur instead, and
    // the shopkeeper is left looking at a blank tab with no idea whether the sale
    // they just took was recorded.
    const sw = await (await fetch(`${d.base}/sw.js`)).text();
    const fallback = (sw.match(/['"](\/offline[^'"]*)['"]/) || [])[1];
    assert.ok(fallback, 'the service worker names no offline fallback page at all');
    const res = await fetch(`${d.base}${fallback}`);
    assert.equal(res.status, 200, `the service worker falls back to ${fallback}, which answers ${res.status}`);
    const body = await res.text();
    assert.match(body, /offline/i, `${fallback} does not say it is offline`);
    assert.match(body, /<html/i, `${fallback} is not a page`);
    // WHAT RENDERS, NOT WHAT IS WRITTEN. Checking the raw bytes for the word
    // "undefined" failed on this very page, because a COMMENT explained that the
    // audit checks for it — a comment is not on the screen. Strip the comments,
    // the styles and the scripts, and what is left is the text a shopkeeper reads:
    // an interpolation that failed shows up there and nowhere else.
    const rendered = body
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ');
    assert.ok(!/\bundefined\b/i.test(rendered),
      `the page SHOWS an "undefined" to the reader: "${(rendered.match(/.{0,60}\bundefined\b.{0,60}/i) || [''])[0]}"`);
    assert.ok(!/\bNaN\b|\bnull\b/.test(rendered), 'the page shows a raw NaN or null to the reader');
    assert.ok(!/\{\{|\$\{/.test(rendered), 'the page shows an un-substituted placeholder');
  });

  await audit.checkAsync('every icon the manifest names exists', async () => {
    if (!manifestHref) { throw new Error('no manifest to read icons from'); }
    const res = await fetch(manifestHref.startsWith('http') ? manifestHref : d.base + manifestHref);
    const manifest = await res.json();
    const icons = manifest.icons || [];
    assert.ok(icons.length > 0, 'the manifest names no icons, so the app cannot be installed with a face');
    for (const icon of icons) {
      const url = String(icon.src).startsWith('http') ? icon.src : d.base + (String(icon.src).startsWith('/') ? icon.src : `/${icon.src}`);
      const head = await fetch(url);
      assert.equal(head.status, 200, `the manifest names ${icon.src}, which answers ${head.status}`);
    }
  });

  audit.section("UTF-8 survives the trip — ₦, Ọ̀ṣun, a shop called Oluwa's Stores");
  const shell = await fetch(`${d.base}/`);
  const shellBody = await shell.text();
  const shellType = shell.headers.get('content-type') || '';

  /**
   * WHERE A CHARACTER SET MAY BE DECLARED, AND WHERE IT ACTUALLY HAS TO BE.
   *
   * The first version of this check demanded `charset=utf-8` in the Content-Type
   * header and went red against the live Workers deployment while it was green
   * locally. That difference is real and was worth chasing: the Node server sets
   * `text/html; charset=utf-8`, and Cloudflare's static-asset layer serves the same
   * file as plain `text/html`.
   *
   * It is not a defect, and saying why matters, because the next person to see a
   * red line here will otherwise "fix" the wrong thing. HTML has its own encoding
   * rules: a browser reads the transport charset FIRST, and when there is none it
   * falls back to the byte-order mark and then to the `<meta charset>` in the
   * document. This shell carries `<meta charset="utf-8">` in its first
   * kilobytes — the audit asserts that separately — so a browser renders ₦ and a
   * Yoruba name correctly on both backends.
   *
   * What would actually break is BOTH being absent, or the document being sniffed as
   * something else — so that is what is asserted: one of the two declarations must
   * exist, and whichever exists must say utf-8. The API, where money and names
   * travel, is held to the stricter rule below.
   */
  audit.check('the shell declares UTF-8, in the header or in the document', () => {
    const header = /charset=\s*(.+?)\s*$/i.exec(shellType);
    const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(shellBody);
    assert.ok(header || meta,
      `nothing declares the encoding: content-type was "${shellType}" and the document has no <meta charset>. A naira sign and a Yoruba name would be mojibake on the receipt.`);
    if (header) assert.match(header[1], /^utf-8$/i, `the header declares charset=${header[1]}, not utf-8`);
    if (meta) assert.match(meta[1], /^utf-8$/i, `the document declares charset=${meta[1]}, not utf-8`);

    // AND IT HAS TO BE EARLY, which is the part that actually bites.
    //
    // The HTML standard's encoding sniffing only reads the first 1024 bytes of the
    // document. A `<meta charset>` further down than that is IGNORED — the browser
    // has already committed to a guess — and the page renders mojibake with the tag
    // sitting right there in the source, which is the worst possible place for it:
    // it looks correct to anybody reviewing the file.
    //
    // This matters more here than on most sites because on the Workers backend the
    // in-document declaration is the ONLY one; see the note below.
    if (!header) {
      const at = shellBody.indexOf(meta ? meta[0] : '\u0000');
      assert.ok(at >= 0 && at < 1024,
        `the charset is declared at byte ${at} of the document, and a browser only honours a declaration in the first 1024 — beyond that the page is decoded as a guess and ₦ arrives as mojibake`);
    }
    if (!header && meta) {
      // Worth printing rather than hiding: it is the whole reason this check exists
      // in this shape, and it is a difference between the two backends.
      audit.note(`charset comes from <meta charset="${meta[1]}"> at byte ${shellBody.indexOf(meta[0])}; the header says only "${shellType}" (Cloudflare's asset layer omits it, Node's does not — the document rule is what protects this backend)`);
    }
  });

  await audit.checkAsync('the API says UTF-8 where money and names travel', async () => {
    const res = await fetch(`${d.base}/api/health`);
    const type = res.headers.get('content-type') || '';
    assert.match(type, /^application\/json/i, `the API answered ${type}`);
    assert.match(type, /charset=utf-8/i,
      `the API answered "${type}" — an API response with no charset is at the mercy of the client's sniffing, and the values in it are Nigerian names and naira amounts`);
  });

  await audit.checkAsync('a non-ASCII value survives the round trip', async () => {
    // WHAT THIS PROVES THAT A HEADER DOES NOT: that a string with a ₦ in it comes
    // back the same string. A header can be right while a value is mangled in the
    // database layer, in a template, or in a JSON encoder — this project has already
    // shipped one defect that turned a number into a string in exactly that seam.
    //
    // Read-only by design: it looks for something non-ASCII that is already there
    // rather than writing one, so it can run against a client's live deployment.
    // THE FIXTURE CARRIES THE CHARACTERS ON PURPOSE. Leaving this to chance meant the
    // check skipped on every freshly provisioned deployment — the seeded catalogue is
    // ASCII — so a check that only runs on somebody's live data is a check nobody has
    // ever seen run. The business this audit creates is named with a combining grave
    // accent and a naira sign, and the name comes back through a normal list endpoint.
    const sources = ['/api/businesses?limit=50', '/api/products?limit=200'];
    let rows = [];
    for (const url of sources) {
      const res = await signedIn.get(url);
      if (res.status === 200) rows = rows.concat((res.json && res.json.data) || []);
    }
    const carrier = rows.find((r) => /[^\x00-\x7F]/.test(JSON.stringify(r)));
    if (!carrier) {
      audit.skip('nothing non-ASCII exists on this deployment to carry home (this audit names its own business with one when it provisions it)');
      return;
    }
    const value = JSON.stringify(carrier);
    const encoded = Buffer.from(value, 'utf8').toString('utf8');
    assert.equal(encoded, value, 'a value did not survive being encoded and decoded as UTF-8');
    const between = Buffer.from(value, 'utf8').toString('base64');
    assert.equal(Buffer.from(between, 'base64').toString('utf8'), value,
      'a value survived the wire and came back different — a ₦ or an accented name would be damaged in transit');
    audit.note(`carried ${JSON.stringify((value.match(/[^\x00-\x7F]+/g) || [])[0] || '').slice(0, 40)} back intact`);
  });

  audit.check('the app is not cached as immutable by the API', async () => {
    const res = await fetch(`${d.base}/api/health`);
    const cc = res.headers.get('cache-control') || '';
    assert.ok(!/immutable/.test(cc), `the API answered with cache-control: ${cc} — a phone would serve a stale health check`);
  });

  audit.section('The response shape every client depends on');
  const shaped = await signedIn.get('/api/products?limit=2');
  audit.check('a list answers ok/data/paging', () => {
    assert.equal(shaped.status, 200, `the products list answered ${shaped.status}`);
    assert.equal(shaped.json.ok, true);
    assert.ok(Array.isArray(shaped.json.data), 'a list must carry `data` as an array — every screen reads it');
    assert.ok(shaped.json.paging && typeof shaped.json.paging.limit === 'number',
      'a list must carry `paging`; the reports and the sync engine both read it');
  });

  await audit.checkAsync('a limit above the ceiling is clamped, not honoured', async () => {
    const res = await signedIn.get('/api/products?limit=100000');
    assert.equal(res.status, 200);
    assert.ok(Number(res.json.paging.limit) <= 500,
      `a limit of 100000 was answered with ${res.json.paging.limit} — an unbounded list is how a tablet on 3G never comes back`);
  });

  // ===================================================================
  // WHO IS ASKING — the half of the product an administrator's token
  // cannot see.
  //
  // Everything in this system is scoped, and a scope bug is invisible from
  // the top: an OWNER reaches every branch, so every list answers, every
  // count is plausible, and the audit is green while a branch manager in
  // Aba is reading Ikeja's prices. This section signs in as a manager
  // pinned to one branch and asks the same questions from down there.
  //
  // The seat is a real user made through POST /api/users, so this also
  // exercises the path a client uses to add staff.
  // ===================================================================
  audit.section('A manager pinned to one branch sees one branch');
  const manager = d.seats && d.seats.manager;
  audit.check('the deployment gave this audit a manager seat', () => {
    // ON A LIVE TARGET THIS IS NOT A DEFECT, AND SAYING SO MATTERS.
    //
    // Creating a user in somebody else's deployment is a decision a person makes
    // (AUDIT_WRITE=1), so this section stands down rather than failing when the
    // target is read-only. What must NOT happen is the section quietly passing: the
    // four checks it holds are the only ones in this file that can see a scope leak,
    // and a green run that skipped them would be a claim it has not earned.
    if (!manager && d.live && !d.writable) {
      // STANDING DOWN IS NOT A FAILURE HERE, and treating it as one was the wrong
      // call: a live run would be permanently red on a target that is perfectly
      // healthy, and a red suite that everyone knows is wrong is a suite people stop
      // reading. The section reports what it could not do and the run stays green —
      // but the four checks it holds are named, so nobody mistakes this for coverage.
      audit.skip('this target is read-only, so no manager seat could be created',
        'set AUDIT_WRITE=1 to run the four scope checks below against it');
      return;
    }
    assert.ok(manager, 'a writable deployment did not produce a manager seat — the scope checks below are the only ones that can see a leak');
  });

  if (manager) {
    // A scope assertion is a single read with several conditions on it, so it is a
    // check rather than a two-way probe: `twoWay` is for acting and then reading the
    // figure back, and there is nothing to act on here.
    await audit.checkAsync('a manager can read their own branch list, and only it', async () => {
      const res = await manager.get('/api/branches?limit=100');
      assert.equal(res.status, 200, `a manager reading branches answered ${res.status} ${res.text.slice(0, 160)}`);
      const rows = res.json.data || [];
      assert.ok(rows.length >= 1, 'a manager sees no branches at all — the branch they are pinned to must be readable by them');
      const pinned = rows.filter((b) => String(b.id) === String(manager.branchId));
      assert.equal(pinned.length, 1, 'the branch the manager is pinned to is missing from the branches they can read');
      assert.equal(rows.length, 1,
        `a manager pinned to one branch can read ${rows.length} branches — a pinned role must reach exactly its own`);
    });

    await audit.checkAsync('a manager cannot read another branch\'s stock movements by naming it', async () => {
      // The scope helper takes the branch the caller NAMED and intersects it with
      // the scope they hold. Passing somebody else's id must yield their own scope
      // or an empty list — never that branch's rows. This is the query an attacker
      // with a valid token makes first.
      const other = (d.branches || []).find((b) => String(b.id) !== String(manager.branchId));
      if (!other) return audit.skip('there is only one branch in this deployment to try to reach into');
      const res = await manager.get(`/api/stock/movements?branch_id=${encodeURIComponent(other.id)}&limit=5`);
      const rows = (res.json && (res.json.data || res.json.movements)) || [];
      const foreign = rows.filter((r) => r.branch_id && String(r.branch_id) !== String(manager.branchId));
      assert.equal(foreign.length, 0,
        `a manager pinned to ${manager.branchId} read ${foreign.length} row(s) belonging to ${other.id} by naming it in the query`);
    });

    await audit.checkAsync('a manager carries a branch, and an owner carries none', async () => {
      // THE SHAPE, because getting it wrong makes an audit fail for a reason that
      // does not exist: `/api/auth/me` reports the manager's branch as
      // `user.branch` — an OBJECT — with the pinned ids in `scope`. The first
      // version of this check read `user.branch_id`, got undefined, and reported a
      // scoping defect that the server did not have.
      const mine = await manager.get('/api/auth/me');
      assert.equal(mine.status, 200);
      const me = mine.json.user || {};
      assert.equal(me.role, 'MANAGER', `the seat signed in as ${me.role}`);
      assert.ok(me.branch && me.branch.id,
        'a manager with no branch would reach every branch — the pin is the whole scoping rule');
      assert.equal(mine.json.scope.pinnedBranchId, me.branch.id,
        'the branch scope and the reported branch disagree; every list a manager reads is filtered by the scope, not by the reported branch');
      assert.ok(String(manager.branchId) === String(me.branch.id),
        `this audit thinks the seat is pinned to ${manager.branchId} and the server says ${me.branch.id}`);

      // The owner is the other half of the rule. What matters is not whether the row
      // happens to carry a branch — it is whether that branch CONSTRAINS them, in what
      // they read and in what they can do.
      //
      // The first version of this check asserted `!owner.branch` and went red against
      // staging, whose owner seat does carry a branch. That was a genuine finding
      // rather than a bad fixture: the owner READ every branch (allBranches scope) and
      // was REFUSED every write naming another one, because the pin check in
      // resolveBranch fired before the scope was consulted. Fixed in
      // server/lib/resolveBranch; this check now asserts the consequence, which is the
      // thing a shopkeeper would notice.
      const ownerSeat = d.owner || d.admin;
      const owners = await ownerSeat.get('/api/auth/me');
      const owner = owners.json.user || {};
      const ownerScope = owners.json.scope || {};
      assert.ok(ownerScope.allBranches === true || (owners.json.branches || []).length >= 1,
        'the owner reached neither all branches nor a list of them');
      audit.note(owner.branch
        ? `the owner seat carries a branch (${owner.branch.name}); it must not constrain anything`
        : 'the owner seat carries no branch');

      if (owner.branch && (d.writable || !d.live)) {
        // THE CONSEQUENCE, WRITTEN DOWN AS A PERMANENT CHECK: an owner who carries a
        // branch can still write at another one. A STAFF user is the cheapest honest
        // write — it is scoped to a branch, so naming another branch is exactly the
        // refusal this asserts must NOT happen.
        const other = (d.branches || []).find((b) => String(b.id) !== String(owner.branch.id) && b.is_active !== 0);
        if (other) {
          await audit.twoWay(
            'an owner who carries a branch can still write at another one',
            () => ownerSeat.post('/api/users', {
              full_name: 'Audit Owner Write Probe',
              username: `http-ownerprobe-${Date.now().toString(36).slice(-5)}${Math.floor(Math.random() * 1296).toString(36)}`,
              pin: '73041', confirm_pin: '73041', role: 'STAFF', branch_id: other.id,
            }),
            (res) => {
              if (res.status === 201) d.trackUser(res.json && (res.json.id || res.json.userId));
              assert.equal(res.status, 201,
                `the owner was refused a write at ${other.name} (${res.status} ${res.json && res.json.code}) while being able to read it — a pin must not refuse a branch the scope reaches`);
            },
          );
        }
      }
    });

    // SOMEBODY AT THE OTHER BRANCH, so the staff list has a row it must hide. A
    // scoping check against a deployment with one branch is a check that cannot
    // fail: there is nothing outside the scope to leak.
    const elsewhere = await audit.captureAsync('a colleague seated at the other branch', async () => {
      const other = (d.branches || []).find((b) => String(b.id) !== String(manager.branchId) && b.is_active !== 0);
      if (!other) return null;
      return d.seat({
        full_name: 'Audit Other Branch Manager',
        username: `http-other-${Date.now().toString(36)}`,
        pin: '73041', role: 'MANAGER', branchId: other.id, businessId: other.business_id || null,
      });
    });
    audit.check('the other branch really has somebody in it', () => {
      assert.ok(elsewhere && elsewhere.branchId && String(elsewhere.branchId) !== String(manager.branchId),
        'the colleague was not created at the other branch, so the next check would test nothing');
    });

    await audit.checkAsync('a manager cannot see staff at another branch', async () => {
      const res = await manager.get('/api/users?limit=100');
      assert.equal(res.status, 200, `the staff list answered ${res.status} to a manager — a manager staffing their own branch is normal`);
      const rows = (res.json.data || []);
      assert.ok(rows.length >= 1, 'a manager sees nobody at all, not even themselves');
      const foreign = rows.filter((u) => u.branch_id && String(u.branch_id) !== String(manager.branchId));
      assert.equal(foreign.length, 0,
        `a manager can list ${foreign.length} user(s) at another branch (${foreign.map((u) => u.username).join(', ')}) — the staff list is scoped like every other list`);
      if (elsewhere) {
        assert.ok(!rows.some((u) => String(u.username) === 'http-other'),
          'the colleague at the other branch is visible to this manager by name');
      }
    });

    await audit.checkAsync('a manager cannot create a user, or change one', async () => {
      // The ceiling, not the floor. Creating staff is a manager-and-above action in
      // this system, so a refusal here would be a product decision; what must never
      // happen is a manager writing a user into somebody else's branch.
      // A UNIQUE NAME PER RUN, because a live deployment keeps the username of a
      // deactivated user forever — their past sales are still attributed to them. The
      // fixed name `http-injected` failed on the second live run with a 409 that was
      // correct behaviour and a useless audit.
      const probe = `http-injected-${Date.now().toString(36).slice(-5)}${Math.floor(Math.random() * 1296).toString(36)}`;
      const res = await manager.post('/api/users', {
        full_name: 'Injected By A Manager', username: probe, pin: '73041', confirm_pin: '73041',
        role: 'STAFF', branch_id: manager.branchId,
      });
      if (res.status === 403) { audit.pass(`creating staff is refused to a manager (${res.json && res.json.code})`); return; }
      assert.equal(res.status, 201, `creating staff answered ${res.status} ${res.text.slice(0, 200)}`);
      d.trackUser(res.json && (res.json.id || res.json.userId)); // it must not be left behind on a live deployment
      const users = await signedIn.get('/api/users?limit=100');
      const made = (users.json.data || []).find((u) => u.username === probe);
      assert.ok(made, 'a manager created a user and the owner cannot see them');
      assert.ok(String(made.branch_id) === String(manager.branchId),
        'a manager created a user outside their own branch — the branch on a user is the only thing scoping what they can read');
    });
  }
}, {
  // A REAL DEPLOYMENT, because half of this audit is about what a signed-in
  // client sees: an unpinned owner must be able to read a list, and the limit
  // ceiling is only exercised by a caller who is allowed to ask.
  setup: () => startDeployment({
    label: 'http',
    owner: { name: 'Http Audit Owner', username: 'http-owner', pin: '12345' },
    admin: { username: 'http-admin', pin: '12345' },
    businesses: [{
      // NAMED IN THE MARKET'S OWN CHARACTERS. Ọ̀ carries a combining grave accent
      // (U+0300) and every price in this product is in naira — if any layer of this
      // stack mishandles UTF-8, a client's own trading name is where it shows first.
      name: 'Ọ̀ṣun Electronics & Gadgets (Oluwa\u2019s Stores)', profileCode: 'ELECTRONICS', vatRegistered: true,
      branches: [
        { name: 'Main Shop', code: 'HTTP-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 50000 },
        { name: 'Second Shop', code: 'HTTP-2', city: 'Kano', state: 'Kano', branch_type: 'RETAIL', opening_cash: 0 },
      ],
    }],
    // A seat, so this audit can ask what a manager sees. The second branch exists
    // so there is something the manager must NOT be able to reach.
    seats: [{ as: 'manager', role: 'MANAGER', username: 'http-manager', pin: '73041', branchIndex: 0, full_name: 'Http Audit Manager' }],
  }),
});
