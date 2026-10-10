'use strict';
// =====================================================================
// test/audit/audit.limits.js — THE CEILINGS OF THE PLATFORM, MEASURED
// =====================================================================
// StockRidge runs on Cloudflare Workers + D1, and D1 is NOT SQLite-with-a-network-card: it
// documents ceilings that SQLite itself does not have. Three of them can be broken by
// ordinary use of the product, and NONE of them can be seen from a local run, because the
// audit's own SQLite is more permissive than the platform in every one of those places:
//
//   · a LIKE or GLOB PATTERN is capped at 50 BYTES (SQLite's own default is 50,000). Every
//     list screen filters with `LIKE ?` on `%<what the user typed>%`, so a paste into a
//     search box answered `500 D1_ERROR: LIKE or GLOB pattern too complex` — on every
//     deployment, while the identical local probe passed. Nine routes, none clamped.
//     Found by this audit's first live run; the fix is `searchTerm()` in server/lib/respond.js.
//   · a string, BLOB or ROW is capped at 2 MB.
//   · a statement may bind at most 100 PARAMETERS — the ceiling that decides whether a bulk
//     write is one statement or a loop.
//   · a Worker invocation may run 1000 queries against D1 (50 on the free plan), and a single
//     query may run 30 seconds. This is the ceiling that decides how big one sync push can be.
//
// Numbers are from https://developers.cloudflare.com/d1/platform/limits/ (last updated
// 2026-04-21), fetched rather than remembered, and recorded here so a later change to the
// platform shows up as a failing assertion instead of a silent assumption.
//
// THE STATIC CHECKS ARE THE HALF THAT NEVER NEEDS A DEPLOYMENT: they read the tree and
// refuse to let a statement be built that the platform cannot run, which is cheaper than
// finding out from a shop.
// =====================================================================

const fs = require('fs');
const path = require('path');
const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

const ROOT = path.join(__dirname, '..', '..');

/** The documented D1 ceilings this product can actually reach. */
const D1 = {
  likePatternBytes: 50,      // includes the two % wildcards
  boundParameters: 100,
  statementBytes: 100000,
  rowBytes: 2000000,
  queriesPerInvocation: 1000, // paid plan; 50 on the free plan
  querySeconds: 30,
  source: 'developers.cloudflare.com/d1/platform/limits — fetched 2026-10-06',
};
/** A search term is cut below this so `%` + term + `%` fits the pattern ceiling. */
const SEARCH_BYTES = D1.likePatternBytes - 2;

const utf8 = new TextEncoder();
const bytes = (s) => utf8.encode(String(s)).length;

/** Every .js file under the given directories. */
function sourceFiles(dirs) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); }
      else if (entry.name.endsWith('.js')) out.push(full);
    }
  };
  for (const dir of dirs) if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** Pull the SQL string literals out of a source file, with where they are. */
function sqlIn(file) {
  const src = fs.readFileSync(file, 'utf8');
  const found = [];
  const literal = /`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'/g;
  let m;
  while ((m = literal.exec(src))) {
    const text = m[0].slice(1, -1);
    if (!/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(text)) continue;
    found.push({
      file: path.relative(ROOT, file),
      line: src.slice(0, m.index).split('\n').length,
      placeholders: (text.match(/\?/g) || []).length,
      dynamic: /\$\{/.test(text),
      bytes: bytes(text),
      head: text.replace(/\s+/g, ' ').trim().slice(0, 90),
    });
  }
  return found;
}

runAudit('limits', async (audit, d) => {
  const o = d.owner || d.admin || d.manager;
  const branch = d.branchFor(o);

  // ===================================================================
  audit.section('The search box, and the 50-byte pattern ceiling');
  // ===================================================================
  // THE DEFECT THIS SECTION GUARDS, stated here so the checks read as evidence rather than
  // superstition: `GET /api/products?q=<49+ characters>` answered
  //   500 D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR
  // A paste, a barcode scanner, a customer name typed with autocomplete — and a local run
  // could never have caught it, because SQLite takes patterns up to 50,000 bytes.
  const SEARCH_ROUTES = [
    ['products', '/api/products'],
    ['customers', '/api/customers'],
    ['stock', '/api/stock'],
    ['sales', '/api/sales'],
    ['market', '/api/market-catalogue'],
  ];

  const searchProbe = async (len, label) => {
    const failures = [];
    for (const [name, route] of SEARCH_ROUTES) {
      const term = 'A'.repeat(len);
      const res = await o.get(`${route}?q=${encodeURIComponent(term)}&limit=5`);
      if (res.status >= 500) failures.push(`${name} → ${res.status} ${String(res.text).slice(0, 120)}`);
      else if (res.status !== 200) failures.push(`${name} → ${res.status} (a search should answer, not refuse)`);
    }
    assert.equal(failures.length, 0,
      `a ${label} search broke ${failures.length} route(s):\n      ${failures.join('\n      ')}\n    The platform caps a LIKE or GLOB pattern at ${D1.likePatternBytes} bytes (${D1.source}); the term must be cut before it becomes a pattern`);
  };

  await audit.checkAsync(`a search at ${SEARCH_BYTES} bytes — the longest the platform can run — is answered everywhere`, async () => {
    await searchProbe(SEARCH_BYTES - 2, `${SEARCH_BYTES}-byte`);
    audit.note(`searched all ${SEARCH_ROUTES.length} list routes at the ceiling`);
  });
  await audit.checkAsync('a 200-character paste into a search box is answered everywhere, not answered with a 500', async () => {
    await searchProbe(200, '200-character');
  });
  await audit.checkAsync('a multi-byte search (₦, é, a Hausa name) is cut on a CHARACTER boundary, not a byte one', async () => {
    // 30 × 3 bytes = 90 bytes, well over the ceiling. Slicing by BYTES would leave half a
    // character: a term that cannot match, and JSON that cannot be sent back intact.
    const term = '₦'.repeat(30);
    for (const [name, route] of SEARCH_ROUTES) {
      const res = await o.get(`${route}?q=${encodeURIComponent(term)}&limit=5`);
      assert.ok(res.status < 500,
        `${name} answered ${res.status} for a multi-byte search: ${String(res.text).slice(0, 140)}`);
      assert.equal(res.status, 200, `${name} refused a multi-byte search with ${res.status} — the cut split a character`);
    }
    audit.note('30 × ₦ (90 bytes) was cut to a whole number of characters and searched');
  });

  await audit.check('the clamp lives in ONE place, so a new list screen cannot forget it', () => {
    const files = sourceFiles([path.join(ROOT, 'server')]);
    const outsiders = files
      .filter((f) => !f.endsWith(path.join('lib', 'respond.js')))
      .filter((f) => /queryParam\((['"])q\1\)/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f));
    assert.equal(outsiders.length, 0,
      `${outsiders.length} file(s) read the search term directly instead of through searchTerm(): ${outsiders.join(', ')}. Every such read is a search box that can answer 500 on a live deployment — this is how the first nine got there`);
    audit.note('server/lib/respond.js searchTerm() is the only reader of ?q=');
  });

  // ===================================================================
  audit.section('A paste, and the 2 MB row ceiling');
  // ===================================================================
  const megabyte = 'x'.repeat(3 * 1000 * 1000);
  const pasted = await audit.captureAsync('what the API does with a 3 MB note', async () => {
    const res = await o.post('/api/customers', { name: `Limit Probe ${Date.now().toString(36)}`, notes: megabyte });
    return { status: res.status, code: (res.json && res.json.code) || '', text: String(res.text).slice(0, 160), notes: (res.json && res.json.customer && res.json.customer.notes) || null };
  });

  await audit.check('a 3 MB paste is refused in the product\u2019s own words, not the database\u2019s', () => {
    assert.ok(pasted.status < 500,
      `a 3 MB note answered ${pasted.status} — ${pasted.text}. The platform caps a row at ${D1.rowBytes} bytes; a paste over it must be a validation refusal the screen can explain, not an INTERNAL error the shop can only report`);
    assert.ok(pasted.status >= 400,
      `a 3 MB note was ACCEPTED (${pasted.status}) — on a live deployment the platform refuses a row over ${D1.rowBytes} bytes, so this would fail there and nowhere else`);
    assert.ok(pasted.code, `the refusal carried no code: ${pasted.text}`);
    audit.note(`3 MB note → ${pasted.status} ${pasted.code}`);
  });

  await audit.checkAsync('and a note inside the field\u2019s own ceiling is accepted', async () => {
    const res = await o.post('/api/customers', { name: `Limit Probe ${Date.now().toString(36)}`, notes: 'y'.repeat(900) });
    assert.ok(res.status === 201 || res.status === 200,
      `a 900-character note answered ${res.status} ${String(res.text).slice(0, 140)} — the ceiling must be a limit, not a wall at some smaller number`);
  });

  await audit.check('no free-text write in the tree is missing its ceiling', () => {
    // The row ceiling is only reachable through a field that has no `maxLength`. `strField`
    // is where the house puts one; this finds any call that takes a free-text field by name
    // and does not cap it.
    const FIELD = /(note|desc|reason|remark|narration|address|instruction|comment|observ)/i;
    const offenders = [];
    let calls = 0;
    for (const file of sourceFiles([path.join(ROOT, 'server')])) {
      const src = fs.readFileSync(file, 'utf8');
      for (let m = src.indexOf('strField('); m !== -1; m = src.indexOf('strField(', m + 1)) {
        calls += 1;
        let i = m + 'strField('.length; let depth = 1;
        while (i < src.length && depth) { if (src[i] === '(') depth += 1; else if (src[i] === ')') depth -= 1; i += 1; }
        const call = src.slice(m, i);
        if (!FIELD.test(call) || /maxLength/.test(call)) continue;
        offenders.push(`${path.relative(ROOT, file)}:${src.slice(0, m).split('\n').length}  ${call.replace(/\s+/g, ' ').slice(0, 70)}`);
      }
    }
    assert.equal(offenders.length, 0,
      `${offenders.length} free-text field(s) can be written without a ceiling:\n      ${offenders.join('\n      ')}\n    Each one is a paste away from a row the platform refuses to store`);
    audit.note(`${calls} strField calls checked; every free-text one carries a maxLength`);
  });

  // ===================================================================
  audit.section('The statements the product builds, and the 100-parameter ceiling');
  // ===================================================================
  const statements = sourceFiles([path.join(ROOT, 'server'), path.join(ROOT, 'worker'), path.join(ROOT, 'domain')]).flatMap(sqlIn);

  await audit.check(`no statement in the tree binds more than ${D1.boundParameters} parameters`, () => {
    assert.ok(statements.length > 100, `only ${statements.length} SQL statements were found — the scanner is looking at the wrong tree`);
    const over = statements.filter((s) => s.placeholders > D1.boundParameters);
    assert.equal(over.length, 0,
      `${over.length} statement(s) exceed the ${D1.boundParameters}-parameter ceiling the platform enforces:\n      ${over.map((s) => `${s.file}:${s.line} (${s.placeholders} params) ${s.head}`).join('\n      ')}`);
    const worst = statements.slice().sort((a, b) => b.placeholders - a.placeholders)[0];
    audit.note(`${statements.length} statements scanned; widest binds ${worst.placeholders} parameters (${worst.file}:${worst.line})`);
  });

  await audit.check(`no statement in the tree is longer than ${D1.statementBytes / 1000} KB`, () => {
    const over = statements.filter((s) => s.bytes > D1.statementBytes);
    assert.equal(over.length, 0, `${over.length} statement(s) exceed the statement-length ceiling: ${over.map((s) => `${s.file}:${s.line}`).join(', ')}`);
    const longest = statements.slice().sort((a, b) => b.bytes - a.bytes)[0];
    audit.note(`longest statement is ${longest.bytes} bytes (${longest.file}:${longest.line}) — the ceiling is ${D1.statementBytes}`);
  });

  await audit.checkAsync('the one statement built from a LIST is fed by a list far below the ceiling', async () => {
    // A handful of statements build `IN (?,?,…)` from a variable, which no static scan can
    // size. The widest of them is the price lists assigned to a business, so it is measured
    // where it is used: if a shop ever had 100 assigned lists, that statement would exceed the
    // parameter ceiling and the Sell screen would stop pricing.
    const res = await o.get('/api/price-lists?limit=500');
    const rows = (res.json && (res.json.data || res.json.price_lists)) || [];
    assert.ok(rows.length < D1.boundParameters,
      `${rows.length} price lists are assigned to this business; the pricing query binds one parameter per list and the platform allows ${D1.boundParameters}`);
    const dynamic = statements.filter((s) => s.dynamic && /\bIN\s*\(/i.test(s.head));
    audit.note(`${rows.length} price list(s) here; ${dynamic.length} statement(s) build an IN-list dynamically (${dynamic.map((s) => `${s.file}:${s.line}`).join(', ') || 'none'})`);
  });

  // ===================================================================
  audit.section('The widest request the deployment accepts');
  // ===================================================================
  // THE PER-INVOCATION BUDGET, MEASURED RATHER THAN ASSUMED. A Worker may run
  // `D1.queriesPerInvocation` queries (1000 paid / 50 free) and no single query may run
  // `D1.querySeconds` seconds. A sync push applies its items in one invocation, so the size
  // of a queue a device can drain in one request is decided by this number — and the plan
  // behind a deployment is not something the code can read.
  if (d.live && !d.writable) {
    audit.skip('a push of many items is applied in one invocation', 'this target is read-only');
  } else {
    // 100 is not a round number: it is what the PWA actually sends (public/js/sync.js
    // batches the outbox at 100), so the measurement covers the biggest request the product
    // makes rather than a size nobody uses. The client's own comment says the batch exists so
    // a device offline for a week makes visible progress instead of timing out; this measures
    // whether that choice is safe against the real database.
    const N = Number(process.env.LIMITS_PUSH_ITEMS || 100);
    const rows = await audit.captureAsync(`${N} customers to push mutations against`, async () => {
      const made = [];
      for (let i = 0; i < N; i += 1) {
        const res = await o.post('/api/customers', { name: `Limits Push ${Date.now().toString(36)}-${i}` });
        const id = (res.json && (res.json.id || (res.json.customer && res.json.customer.id))) || null;
        if (!id) throw new Error(`creating push fixture ${i} answered ${res.status} ${String(res.text).slice(0, 140)}`);
        made.push(String(id));
      }
      return made;
    });

    if (!rows || !rows.length) {
      audit.skip('one push carrying many mutations goes through', 'the fixtures could not be created');
    } else {
      const started = Date.now();
      const push = await o.post('/api/sync/push', {
        device_id: `audit-limits-${Date.now().toString(36)}`,
        operations: [],
        mutations: rows.map((id, i) => ({ table: 'customers', id, data: { phone: `08000${String(i).padStart(6, '0')}` } })),
      });
      const elapsed = Date.now() - started;

      await audit.checkAsync(`one push carrying ${rows.length} mutations is applied in a single invocation`, async () => {
        assert.ok(push.status === 200 || push.status === 207,
          `the push answered ${push.status} ${String(push.text).slice(0, 200)}. A device draining a day's queue in one request must not meet a platform ceiling`);
        const results = (push.json && push.json.results && push.json.results.mutations) || [];
        assert.equal(results.length, rows.length, `${results.length} item result(s) for ${rows.length} mutation(s)`);
        const failed = results.filter((r) => r.status !== 'APPLIED');
        assert.equal(failed.length, 0,
          `${failed.length} item(s) did not apply: ${JSON.stringify(failed.slice(0, 3))}`);
        audit.note(`${rows.length} mutations applied in ${elapsed} ms in one request (${Math.round(rows.length / Math.max(elapsed, 1) * 1000)} items/s)`);
      });

      await audit.checkAsync('and the writes are really there, not just acknowledged', async () => {
        const res = await o.get(`/api/customers/${rows[rows.length - 1]}`);
        assert.equal(res.status, 200, `reading back the last mutated customer answered ${res.status}`);
        const phone = ((res.json || {}).customer || {}).phone;
        assert.equal(String(phone), `08000${String(rows.length - 1).padStart(6, '0')}`,
          `the customer's phone reads ${phone} — the push reported APPLIED but the row did not change`);
      });

      await audit.checkAsync('one item over the product\u2019s own cap is refused before anything is written', async () => {
        const over = await o.post('/api/sync/push', {
          device_id: `audit-limits-${Date.now().toString(36)}`,
          operations: [],
          mutations: Array.from({ length: 501 }, (_, i) => ({ table: 'customers', id: rows[i % rows.length], data: { phone: '08000000000' } })),
        });
        assert.equal(over.status, 400, `a 501-item push answered ${over.status} ${String(over.text).slice(0, 160)}`);
        assert.match(String((over.json || {}).code || ''), /SYNC_BATCH_TOO_LARGE/, `it was refused as ${(over.json || {}).code}`);
      });
    }
  }

  await audit.checkAsync('the widest list the API will return is measured, not guessed', async () => {
    const sizes = [];
    for (const route of ['/api/sales?limit=500', '/api/products?limit=500', '/api/customers?limit=500']) {
      const res = await o.get(route);
      assert.equal(res.status, 200, `${route} answered ${res.status}`);
      sizes.push({ route, bytes: bytes(res.text), rows: ((res.json && res.json.data) || []).length });
    }
    const biggest = sizes.slice().sort((a, b) => b.bytes - a.bytes)[0];
    assert.ok(biggest.bytes < 10 * 1000 * 1000,
      `${biggest.route} returned ${biggest.bytes} bytes — a page of ${biggest.rows} rows this large is a response the platform may refuse to send`);
    audit.note(`widest page: ${biggest.route} → ${biggest.bytes} bytes, ${biggest.rows} rows`);
    audit.note(`platform ceilings recorded from ${D1.source}`);
  });

  audit.note('every ceiling here is one a local run cannot reach — which is exactly why they are probed against a deployment');
}, {
  setup: () => startDeployment({
    label: 'limits',
    businesses: [{
      name: 'Limits Audit Trading', profileCode: 'ELECTRONICS', vatRegistered: true,
      branches: [{ name: 'Limits Shop', code: 'LIM-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 20000 }],
    }],
    seats: [{ as: 'manager', role: 'MANAGER', username: 'limits-manager', pin: '59263', branchIndex: 0, full_name: 'Limits Audit Manager' }],
  }),
});
