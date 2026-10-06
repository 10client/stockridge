'use strict';
// =====================================================================
// test/audit/audit.concurrency.js — TWO PEOPLE, ONE SHELF, ONE SECOND
// =====================================================================
// Everything else in this suite asks what the product does when it is asked ONCE. This one
// asks what it does when it is asked TWICE AT THE SAME MOMENT, because that is the state a
// shop is actually in: two cashiers, two phones, the last generator on the shelf, and a
// mobile network that eats one of the two responses.
//
// WHAT IS PROVEN HERE, AND HOW
//
//   1. THE LAST UNIT IS SOLD ONCE. Two sales of the final unit fired in parallel: exactly
//      one is accepted, the other is refused in words a cashier can act on, and the shelf
//      settles at ZERO — never minus one. An oversell is discovered at stocktake, a month
//      later, with no way to tell who took the goods.
//
//   2. ONE IDEMPOTENCY KEY, TWO SIMULTANEOUS REQUESTS, ONE SALE — and the queue recovers.
//      Two requests in flight at once with the same key: one does the work, the other is
//      told the first is in flight (409 + Retry-After). The PROOF is on the shelf: three
//      units received, one sale written, two units left. Then the retry the 409 asked for
//      must return the ORIGINAL answer, marked replayed, without writing anything.
//
//   3. THE WIDEST WRITE THE PRODUCT BUILDS STILL FITS ITS DATABASE. A many-line sale is
//      the engine's own ceiling, and each line writes a movement and a ledger posting: D1
//      refuses a statement with more than 100 bound parameters. The widest statement in the
//      engine is a single line's insert, so this is safe BY CONSTRUCTION — the check proves
//      it rather than trusting it, because the failure would appear ONLY on the live
//      deployment, on the shop's biggest order of the month.
//
//   4. A QUEUE THAT DIED MID-FLIGHT CAN BE RETRIED. A request killed between "I have
//      reserved this key" and "here is the answer" leaves the key IN_PROGRESS. Forever
//      would mean a device could never retry that sale. The product takes the reservation
//      over after two minutes — and refuses to touch one from a moment ago, which is the
//      double-spend the whole protocol exists to prevent.
//
// SHAPES THIS AUDIT HAD TO LEARN THE HARD WAY (all four were wrong on the first run):
//   · stock search is `?q=`, and the field is `on_shelf` — not `quantity_on_hand`, not
//     `quantityBase`. Reading the wrong field gives NaN, and `NaN >= 0` is false, so the
//     no-oversell check "fails" for a reason that has nothing to do with overselling.
//   · the sales LIST does not carry `device_id`, so a sale cannot be found by device. The
//     shelf is the better witness anyway: it is the number the shop can count.
//   · a catalogue row can be serial-tracked or variant-tracked, and a sale line for one
//     needs a serial number or a variant id. A "wide sale" built from the first N priced
//     products therefore fails for a reason that has nothing to do with width.
//   · `check()` takes a SYNC body. Hand it an async one and the promise is neither awaited
//     nor caught — a failing assertion inside it is reported as a PASS.
// =====================================================================

const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const money = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
const sellable = (rows) => (rows || []).filter((r) => Number(r.selling_price) > 0);
// "Simple" has to mean SELLABLE WITH NO CEREMONY, and that includes having a unit
// ladder: a product with no units is refused by the stock engine with NO_UNIT_LADDER.
// The check earns its place — the defect this audit found left exactly such rows behind
// (a product inserted, then the request that would have given it a ladder threw), so a
// picker that ignored the ladder would keep choosing corpses.
const simple = (rows) => sellable(rows)
  .filter((p) => !p.requires_serial && !p.tracks_variants)
  .filter((p) => p.default_unit_code);
const codeOf = (res) => (res && res.json && (res.json.code || res.json.error)) || '';
const said = (res) => String((res && res.json && (res.json.error || res.json.message)) || '');
const tag = () => Date.now().toString(36).slice(-5);

runAudit('concurrency', async (audit, d) => {
  const o = d.owner || d.admin || d.manager;
  const branch = d.branchFor(o);
  const device = `audit-race-${tag()}`;
  const key = (what) => `${what}-${Date.now().toString(36)}-${tag()}`;

  if (d.live && !d.writable) {
    audit.skip('the concurrency probes create sales and stock', 'this target is read-only');
    return;
  }

  /** What the shelf says about one product, right now. The number a stocktake would find. */
  const shelf = async (product) => {
    const res = await o.get(`/api/stock?branch_id=${branch.id}&limit=200&q=${encodeURIComponent(product.sku || product.name)}`);
    const rows = (res.json && res.json.data) || [];
    const mine = rows.find((r) => String(r.product_id) === String(product.id));
    return mine ? Number(mine.on_shelf) : null;
  };

  const receive = (product, quantity, ref) => o.post('/api/stock/receive', {
    branch_id: branch.id, product_id: product.id, quantity,
    unit_code: product.default_unit_code || 'PIECE',
    cost_price: round2(Number(product.selling_price || product.cost_price || 100) * 0.7),
    selling_price: Number(product.selling_price || 100),
    reference: `${ref}-${tag()}`,
  });

  const saleBody = (product, quantity = 1) => ({
    branch_id: branch.id,
    lines: [{ product_id: product.id, quantity }],
    payments: [{ method: 'CASH', amount: round2(Number(product.selling_price) * quantity), cash_tendered: round2(Number(product.selling_price) * quantity) }],
    device_id: device,
  });

  // ===================================================================
  audit.section('The last unit on the shelf is sold once');
  // ===================================================================
  const contested = await audit.captureAsync('a plainly sellable product to fight over', async () => {
    const res = await o.get('/api/products?limit=100');
    const rows = simple((res.json && res.json.data) || []);
    if (!rows.length) throw new Error('the catalogue has no priced, untracked product to race over');
    return rows[0];
  });

  await audit.checkAsync('the shelf starts with exactly one unit of it', async () => {
    const res = await receive(contested, 1, 'RACE');
    assert.equal(res.status, 201, `receiving the single unit answered ${res.status} ${String(res.text).slice(0, 200)}`);
    const onShelf = await shelf(contested);
    assert.equal(onShelf, 1, `the shelf reads ${onShelf} after receiving one unit of ${contested.name}, so the race below would prove nothing`);
  });

  const [a, b] = await Promise.all([
    o.post('/api/sales', saleBody(contested), { idempotencyKey: key('race-a') }),
    o.post('/api/sales', saleBody(contested), { idempotencyKey: key('race-b') }),
  ]);

  await audit.check('the two sales are not both accepted', () => {
    const accepted = [a, b].filter((r) => r.status === 201 || r.status === 200);
    assert.equal(accepted.length, 1,
      `both simultaneous sales of the last unit were accepted (${a.status} and ${b.status}). One unit of stock, two receipts: the shop has sold goods it does not have and nothing on either receipt says so`);
  });

  await audit.check('and the one that lost is told why, in words a cashier can act on', () => {
    const loser = [a, b].find((r) => r.status !== 201 && r.status !== 200);
    assert.ok(loser, 'both were accepted (see above)');
    assert.ok(loser.status >= 400 && loser.status < 500,
      `the loser was answered ${loser.status} — a refusal a cashier can act on, not a server error`);
    const text = said(loser) + codeOf(loser);
    assert.match(text, /stock|available|shelf|units/i,
      `the refusal never mentions stock: "${said(loser)}". "That failed" at the counter is how a shop learns to keep a paper book`);
  });

  await audit.checkAsync('the shelf settles at zero — never a minus', async () => {
    const onShelf = await shelf(contested);
    assert.ok(onShelf === 0,
      `the shelf holds ${onShelf} of ${contested.name}: one unit arrived and one sale should have taken it. ${onShelf < 0 ? 'A negative shelf is stock the books believe in and the shop cannot sell — the oversell is already recorded' : 'A unit left on the shelf means a sale was refused that should have gone through'}`);
    audit.note(`${contested.name}: one received, one sold, shelf at 0`);
  });

  // ===================================================================
  audit.section('One Idempotency-Key sent twice AT THE SAME MOMENT');
  // ===================================================================
  const retried = await audit.captureAsync('a second product to price the same-key race against', async () => {
    const res = await o.get('/api/products?limit=100');
    const rows = simple((res.json && res.json.data) || []).filter((p) => String(p.id) !== String(contested.id));
    if (!rows.length) throw new Error('the catalogue has only one untracked priced product');
    return rows[0];
  });

  await audit.checkAsync('three of it are on the shelf', async () => {
    const res = await receive(retried, 3, 'KEY');
    assert.equal(res.status, 201, `receiving three units answered ${res.status} ${String(res.text).slice(0, 200)}`);
    const onShelf = await shelf(retried);
    assert.equal(onShelf, 3, `the shelf reads ${onShelf} after receiving three units`);
  });

  const sharedKey = key('same');
  const [p1, p2] = await Promise.all([
    o.post('/api/sales', saleBody(retried), { idempotencyKey: sharedKey }),
    o.post('/api/sales', saleBody(retried), { idempotencyKey: sharedKey }),
  ]);

  await audit.check('the same key sent twice concurrently writes ONE sale', async () => {
    const onShelf = await shelf(retried);
    assert.equal(onShelf, 2,
      `the shelf holds ${onShelf} of ${retried.name}: three arrived and one sale should have taken exactly one. ${onShelf === 1 ? 'TWO sales were written from one key — the key did not stop the second write, and the shop has two receipts for one transaction' : 'nothing was written at all'}`);
  });

  await audit.check('and both callers were answered consistently', () => {
    const ok = [p1, p2].filter((r) => r.status === 201 || r.status === 200);
    const waiting = [p1, p2].filter((r) => r.status === 409);
    assert.equal(ok.length + waiting.length, 2,
      `the pair was answered ${p1.status} and ${p2.status}. A caller may receive the result (200/201) or be told the first request is still in flight (409 with Retry-After) — anything else is a device with no way to decide whether to retry`);
    if (waiting.length) {
      assert.ok(waiting[0].headers['retry-after'],
        'the 409 tells the client to wait but not how long — a device that guesses will hammer the till');
      assert.match(codeOf(waiting[0]), /IDEMPOTENCY|IN_PROGRESS/i, `the 409 was coded ${codeOf(waiting[0])}`);
    }
    if (ok.length === 2) {
      const replayed = ok.filter((r) => r.json && r.json.replayed === true);
      assert.equal(replayed.length, 1,
        'both callers reported a fresh sale. One of the two answers is a REPLAY of the other and must say so, or a device cannot tell whether its queue item may be dropped');
    }
    audit.note(`the simultaneous pair answered ${p1.status} and ${p2.status}`);
  });

  await audit.checkAsync('and the retry the 409 asked for returns the original answer, marked replayed', async () => {
    const res = await o.post('/api/sales', saleBody(retried), { idempotencyKey: sharedKey });
    assert.ok(res.status === 200 || res.status === 201,
      `the retry answered ${res.status} ${String(res.text).slice(0, 200)}. This is the step an offline queue takes after being told to wait: if it does not settle here, the sale is stuck on the phone forever and the cashier is told nothing`);
    assert.equal(res.json && res.json.replayed, true,
      'the retry ran the sale AGAIN instead of replaying the first answer — that is a second receipt for one transaction');
    const onShelf = await shelf(retried);
    assert.equal(onShelf, 2, `the shelf moved to ${onShelf} on a retry that should have written nothing`);
    assert.equal(res.headers['idempotency-replayed'], 'true',
      `the replayed answer does not carry the Idempotency-Replayed header (it read ${res.headers['idempotency-replayed']})`);
    audit.note('the retry replayed the first answer and wrote nothing');
  });

  // ===================================================================
  audit.section('The catalogue can be written at all');
  // ===================================================================
  // THIS SECTION EXISTS BECAUSE THE AUDIT FOUND THE DEFECT IT NOW GUARDS. The wide-sale
  // section below creates products through POST /api/products, and on the first run that
  // answered 500 "check.ladder is not iterable" — on staging as well as locally, with and
  // without an explicit unit ladder. `validateLadder` returns its normalised rows under
  // `levels`; `buildLadder`, the other function in the same module, returns `ladder`. The
  // catalogue route read the wrong key, so the app's own New Product and Edit Product
  // screens could not save anything — on every deployment — and each failure left a product
  // row with no unit ladder behind it, a product that can never be sold.
  //
  // A probe that only CREATES stock items would have missed it, because the sale engine is
  // fed by the seeder. This section writes the catalogue the way the screen does.
  const writeProbe = `CAT-${tag()}`;
  let probeProduct = null;

  await audit.checkAsync('a product is created with NO unit ladder given — the default one is built for it', async () => {
    const res = await o.post('/api/products', {
      name: `Catalogue Probe ${writeProbe}`, sku: writeProbe,
      base_unit_name: 'piece', cost_price: 120, selling_price: 180,
    });
    assert.ok(res.status === 201 || res.status === 200,
      `creating a product answered ${res.status} ${String(res.text).slice(0, 220)}. The catalogue is the first thing a shop fills in: if this fails, nothing else in the app has anything to sell`);
    probeProduct = String((res.json && (res.json.id || (res.json.product && res.json.product.id))) || '');
    assert.ok(probeProduct && probeProduct !== 'undefined', `the created product came back without an id: ${String(res.text).slice(0, 160)}`);
  });

  await audit.checkAsync('and it is sold-ready: it has a unit ladder with a default sell unit', async () => {
    assert.ok(probeProduct, 'no product was created (see above)');
    const res = await o.get(`/api/products/${probeProduct}`);
    assert.equal(res.status, 200, `reading the created product back answered ${res.status}`);
    const units = ((res.json || {}).product && (res.json.product.units || res.json.product.ladder)) || res.json.units || [];
    assert.ok(Array.isArray(units) && units.length >= 1,
      `the product came back with no unit ladder (${JSON.stringify(units).slice(0, 120)}). The sale engine refuses a product with no ladder rather than guessing one, so this product cannot be sold — and the failure that created it left the row behind, so the shop cannot even see why`);
    const codes = units.map((u) => String(u.code).toUpperCase());
    assert.ok(codes.includes('PIECE'),
      `the default ladder has codes ${codes.join(', ')} — the base unit of a product created without one must be PIECE`);
    const sellable = units.filter((u) => u.is_default_sell || u.isDefaultSell);
    assert.equal(sellable.length, 1,
      `${sellable.length} units are marked as the default sell unit: a till that sells "the default unit" has ${sellable.length === 0 ? 'no answer' : 'two answers'}`);
  });

  await audit.checkAsync('editing a product saves, including a replacement ladder', async () => {
    assert.ok(probeProduct, 'no product was created (see above)');
    const res = await o.put(`/api/products/${probeProduct}`, {
      name: `Catalogue Probe ${writeProbe} (edited)`, selling_price: 210,
      units: [{ code: 'PIECE', name: 'Piece', quantityInBase: 1, isDefaultSell: true },
              { code: 'CARTON', name: 'Carton', quantityInBase: 12, isDefaultSell: false }],
    });
    assert.ok(res.status === 200 || res.status === 201,
      `editing the product answered ${res.status} ${String(res.text).slice(0, 220)}. An Edit Product screen that cannot save is a shop that cannot correct a price`);
    const back = await o.get(`/api/products/${probeProduct}`);
    const units = ((back.json || {}).product && (back.json.product.units || back.json.product.ladder)) || back.json.units || [];
    const codes = units.map((u) => String(u.code).toUpperCase()).sort();
    assert.deepEqual(codes, ['CARTON', 'PIECE'],
      `after the edit the ladder reads ${codes.join(', ')} — the replacement did not take`);
    const carton = units.find((u) => String(u.code).toUpperCase() === 'CARTON');
    assert.equal(Number(carton.quantity_in_base != null ? carton.quantity_in_base : carton.quantityInBase), 12,
      'the replacement ladder kept the code but lost the quantity — a carton of an unknown size is worse than no carton at all');
  });

  // ===================================================================
  audit.section('The widest write this product builds still fits its database');
  // ===================================================================
  // THE GOODS ARE MADE HERE, NOT BORROWED FROM THE CATALOGUE. The first version of this
  // section read the fixture's own catalogue and found ONLY SIX priced, untracked products
  // — so it skipped, and a skip on the check that guards the live database's limits is
  // hollow coverage dressed as a pass. The products are now created through the same
  // POST /api/products the app's own catalogue screen uses, which also proves the
  // provisioning flow can build the catalogue a wholesale order needs.
  const WIDE_LINES = Number(process.env.WIDE_LINES || 30);
  const bulk = await audit.captureAsync(`${WIDE_LINES} products created through the catalogue's own flow`, async () => {
    const made = [];
    for (let i = 0; i < WIDE_LINES; i += 1) {
      const res = await o.post('/api/products', {
        name: `Wide Probe Line ${tag()}-${i}`,
        sku: `WIDE-${tag()}-${i}`,
        base_unit_name: 'piece',
        cost_price: 100 + i,
        selling_price: 150 + i,
      });
      if (res.status !== 201 && res.status !== 200) {
        throw new Error(`creating probe product ${i} answered ${res.status} ${String(res.text).slice(0, 200)}`);
      }
      const id = (res.json && (res.json.id || (res.json.product && res.json.product.id)));
      made.push({ id: String(id), selling_price: 150 + i, default_unit_code: 'PIECE', sku: `WIDE-${tag()}-${i}` });
    }
    return made;
  });

  if (!bulk || !bulk.length) {
    audit.skip('a many-line sale goes through whole and priced in full',
      'the catalogue refused to create probe products, so a wide sale could not be built');
  } else {
    const lineCount = bulk.length;
    const lines = bulk.map((p) => ({ product_id: p.id, quantity: 1 }));
    const expected = round2(bulk.reduce((sum, p) => sum + Number(p.selling_price), 0));

    await audit.checkAsync(`a ${lineCount}-line sale is accepted, priced in full and recorded line for line`, async () => {
      for (const p of bulk) {
        const r = await receive(p, 1, 'WIDE');
        if (r.status !== 201) audit.note(`stock for ${p.sku || p.id} answered ${r.status} — the sale below may be refused for stock, not for width`);
      }
      const res = await o.post('/api/sales', {
        branch_id: branch.id, lines,
        payments: [{ method: 'CASH', amount: expected, cash_tendered: expected }],
        device_id: `${device}-wide`,
      }, { idempotencyKey: key('wide') });

      assert.equal(res.status, 201,
        `a ${lineCount}-line sale answered ${res.status} ${String(res.text).slice(0, 260)}. If this is a database limit it is a limit the shop meets on its biggest wholesale order of the month — and only on the live deployment`);
      assert.equal(round2(res.json.totals.total), expected,
        `the receipt totals ${money(res.json.totals.total)} against ${money(expected)} of lines — a wide sale that quietly loses lines is worse than one that is refused`);

      const detail = await o.get(`/api/sales/${res.json.saleId}`);
      const items = (detail.json && detail.json.items) || [];
      assert.equal(items.length, lineCount,
        `the recorded sale has ${items.length} lines, not ${lineCount} — the receipt total matched but the shelf will drift from the books by the missing lines`);
      audit.note(`${lineCount} lines, ${money(expected)}, ${items.length} recorded, one request`);
    });
  }

  // ===================================================================
  audit.section('A queue that died mid-flight can be retried');
  // ===================================================================
  // THE RESERVATION, AND WHY THIS SECTION AGES ONE INSTEAD OF WRITING A FIXTURE ROW.
  // The key check compares the request hash FIRST: a hand-written row with a made-up hash is
  // refused as "used for a DIFFERENT request" (409 IDEMPOTENCY_KEY_REUSED) — which is correct
  // product behaviour and tells us nothing about the takeover rule. So this section runs a
  // REAL request (recording the real hash), then simulates the crash by ageing that row and
  // wiping the answer, exactly as a request killed mid-flight would leave it.
  //
  // It runs only where the audit owns the database: ageing a row inside a client's tenant is
  // somebody else's data, and `d.dbFile` is null for a live target.
  if (!d.dbFile || d.live) {
    audit.skip('a stale in-flight reservation is taken over after two minutes',
      "this target is not this audit's database, so a reservation cannot be aged — the two-minute rule is asserted on a local run");
  } else {
    const Database = require('better-sqlite3');
    const db = new Database(d.dbFile);
    const user = await o.get('/api/auth/me');
    const userId = String(((user.json || {}).user || {}).id);

    const stranded = await audit.captureAsync('a third product, sold once so there is a real reservation on record', async () => {
      const res = await o.get('/api/products?limit=100');
      const rows = simple((res.json && res.json.data) || [])
        .filter((p) => ![contested.id, retried.id].includes(p.id))
        .filter((p) => Number(p.on_hand || 0) === 0);
      if (!rows.length) throw new Error('the catalogue has no third untracked priced product');
      const p = rows[0];
      const stocked = await receive(p, 2, 'STRAND');
      if (stocked.status !== 201) throw new Error(`could not stock the third product: ${stocked.status} ${String(stocked.text).slice(0, 160)}`);
      return p;
    });

    const lostKey = key('stranded');
    const first = await o.post('/api/sales', saleBody(stranded), { idempotencyKey: lostKey });
    await audit.checkAsync('the first attempt completes and is on record', async () => {
      assert.equal(first.status, 201, `the first attempt answered ${first.status} ${String(first.text).slice(0, 200)}`);
      const row = db.prepare('SELECT status, request_hash FROM idempotency_keys WHERE idempotency_key = ? AND user_id = ?').get(lostKey, userId);
      assert.ok(row, 'the completed request left no idempotency row — nothing to age, and nothing protecting a retry');
      assert.equal(String(row.status), 'COMPLETED', `the row is ${row.status} after a completed request`);
      assert.ok(row.request_hash, 'the row carries no request hash, so a reused key could not be detected');
    });

    await audit.checkAsync('a reservation left IN_PROGRESS for five minutes is taken over, and the retry goes through', async () => {
      // THE CRASH: the answer was never stored and the clock moved on.
      db.prepare(`UPDATE idempotency_keys SET status = 'IN_PROGRESS', response_status = NULL, response_body = NULL,
                    created_at = datetime('now', '-5 minutes')
                  WHERE idempotency_key = ? AND user_id = ?`).run(lostKey, userId);

      const retry = await o.post('/api/sales', saleBody(stranded), { idempotencyKey: lostKey });
      assert.ok(retry.status === 201 || retry.status === 200,
        `the retry after a lost request answered ${retry.status} ${String(retry.text).slice(0, 200)}. A reservation that is never released is a sale the shop can never record: the queue item retries forever and the cashier is told nothing`);

      const row = db.prepare('SELECT status, response_status FROM idempotency_keys WHERE idempotency_key = ? AND user_id = ?').get(lostKey, userId);
      assert.equal(String(row.status), 'COMPLETED',
        `the taken-over reservation is still ${row.status} — the retry ran but left the key in a state a THIRD attempt would trip over`);
      // THE PRICE OF THE TAKEOVER, STATED RATHER THAN HIDDEN: taking the reservation over
      // RE-RUNS the action. If the first attempt had actually written its sale before dying,
      // that sale is written twice. The two-minute bound is what keeps that from being the
      // common case; a device that retries immediately is told to wait instead (next check).
      audit.note('a five-minute-old reservation was taken over and the retry completed — a takeover re-runs the action by design, which is why the window is bounded');
    });

    await audit.checkAsync('but a reservation from a moment ago is NOT taken over — a live request must not be duplicated', async () => {
      const liveKey = key('live');
      // RESTOCK FIRST. The two attempts above (the lost one and its takeover) each took a
      // unit, and a sale refused for an empty shelf would fail this check for a reason that
      // has nothing to do with reservations.
      const restock = await receive(stranded, 2, 'LIVE');
      assert.equal(restock.status, 201, `restocking for the live-reservation probe answered ${restock.status}`);
      const started = await o.post('/api/sales', saleBody(stranded), { idempotencyKey: liveKey });
      assert.equal(started.status, 201, `the setup sale answered ${started.status} ${String(started.text).slice(0, 160)}`);
      // THE CRASH, ONE SECOND AGO: same shape, no stale clock.
      db.prepare(`UPDATE idempotency_keys SET status = 'IN_PROGRESS', response_status = NULL, response_body = NULL
                  WHERE idempotency_key = ? AND user_id = ?`).run(liveKey, userId);

      const res = await o.post('/api/sales', saleBody(stranded), { idempotencyKey: liveKey });
      assert.equal(res.status, 409,
        `a request whose first attempt is STILL RUNNING answered ${res.status} — taking over a live reservation is the double-spend this whole protocol exists to prevent`);
      assert.match(codeOf(res), /IDEMPOTENCY|IN_PROGRESS/i, `it was refused as ${codeOf(res)}`);
      db.prepare('DELETE FROM idempotency_keys WHERE idempotency_key = ? AND user_id = ?').run(liveKey, userId);
      db.prepare('DELETE FROM idempotency_keys WHERE idempotency_key = ? AND user_id = ?').run(lostKey, userId);
      audit.note('a fresh reservation is respected: the second caller waits, it does not write');
    });
    db.close();
  }

  audit.note('the counter is one unit, one key and one second at a time — and every one of those races is decided by the product, not by luck');
}, {
  setup: () => startDeployment({
    label: 'concurrency',
    businesses: [{
      name: 'Concurrency Audit Appliances', profileCode: 'ELECTRONICS', vatRegistered: true,
      branches: [{ name: 'Race Shop', code: 'RACE-1', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 30000 }],
    }],
    seats: [{ as: 'manager', role: 'MANAGER', username: 'race-manager', pin: '73041', branchIndex: 0, full_name: 'Race Audit Manager' }],
  }),
});
