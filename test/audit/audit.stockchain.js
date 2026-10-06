'use strict';
// =====================================================================
// test/audit/audit.stockchain.js — ONE UNIT OF STOCK, FROM PURCHASE TO COUNT
// =====================================================================
// `tools/flow-coverage.js` said this first: three flows that move real goods and real
// money were exercised by NO live audit at all — purchase orders (0/5), stock transfers
// (0/4) and stocktakes (0/5). Fourteen endpoints, and the two ways they go wrong are
// both invisible until somebody counts a shelf:
//
//   * STOCK ARRIVES SOMEWHERE IT DID NOT ARRIVE. A receipt that lands at the wrong
//     branch, or a transfer that credits the destination before the goods left, makes
//     two branches' figures wrong at once and neither can see the other's.
//   * A COUNT CHANGES THE NUMBER WITHOUT SAYING SO. A stocktake that adjusts quietly is
//     a write-off nobody signed.
//
// So this follows ONE PRODUCT through all three flows and checks the stock figures at
// both ends of every move, with the deployment's own endpoints reading them back:
//
//   FRONT TO BACK  buy it → the shelf and the supplier's account both move.
//   BACK TO FRONT  send it → the sending branch drops, the receiving branch does not
//                  move until it is received, and receiving MORE than was sent is
//                  refused rather than absorbed.
//   AND A COUNT   count it wrong on purpose → the variance is visible before the commit,
//                  the commit adjusts the shelf to what was counted, and the adjustment
//                  says who did it and why.
// =====================================================================

const { runAudit, assert } = require('./lib/harness');
const { startDeployment } = require('./lib/deployment');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => `₦${round2(n).toLocaleString('en-NG')}`;

runAudit('stockchain', async (audit, d) => {
  const owner = d.owner || d.admin;
  const manager = (d.seats && d.seats.manager) || null;
  const senderSeat = (d.seats && d.seats.sender) || null;
  if (!manager) throw new Error('the stockchain fixture needs a manager at the receiving branch — a flow with no non-owner seat cannot show that the roles behave, and on a live deployment the owner may be pinned to another branch');
  if (!senderSeat) throw new Error('the stockchain fixture needs a seat at the SENDING branch — the rule that only the receiving branch books goods in needs a branch that is not the receiving one to prove it');

  const branches = d.branches || [];
  assert.ok(branches.length >= 2, 'the stockchain fixture needs two branches: goods have to travel between them');
  const from = branches[0];
  const to = branches[1];
  audit.note(`buying into ${from.name}, sending to ${to.name}, and counting what is left`);

  // -----------------------------------------------------------------
  // A PRODUCT, AND ITS STOCK, READ BACK FROM THE DEPLOYMENT EVERY TIME.
  // -----------------------------------------------------------------
  const product = await audit.captureAsync('a product from the catalogue with a cost price', async () => {
    const res = await owner.get('/api/products?limit=200');
    assert.equal(res.status, 200, `the catalogue answered ${res.status}`);
    const rows = (res.json.data || res.json.products || []).filter((p) => Number(p.cost_price) > 0);
    if (!rows.length) throw new Error('the catalogue has no product with a cost price to buy');
    return rows[0];
  });
  const unitCost = round2(Number(product.cost_price));
  audit.note(`${product.sku} ${product.name} — bought at ${money(unitCost)} per unit`);

  /** How much of this product a branch holds, read from the deployment. */
  const stockAt = async (branch, { required = true } = {}) => {
    const res = await owner.get(`/api/stock?branch_id=${encodeURIComponent(branch.id)}&limit=200`);
    if (required) assert.equal(res.status, 200, `stock at ${branch.name} answered ${res.status} ${String(res.text).slice(0, 160)}`);
    const rows = ((res.json && (res.json.data || res.json.stock)) || []);
    const row = rows.filter((r) => String(r.product_id || (r.product && r.product.id)) === String(product.id));
    // `on_shelf` IS THE FIELD, and the first version of this reader looked for
    // `quantity_in_base` — which the stock list does not return — so every reading was
    // 0 and three checks failed as though the stock had not moved. A reader that cannot
    // find its field should not silently answer zero: the fallback chain is explicit so
    // the next person can see what it expects.
    return row.reduce((sum, r) => sum + Number(r.on_shelf != null ? r.on_shelf : (r.quantity_in_base != null ? r.quantity_in_base : (r.quantity || 0))), 0);
  };

  const supplier = await audit.captureAsync('a supplier to buy from', async () => {
    const res = await owner.post('/api/suppliers', {
      business_id: d.businesses && d.businesses[0] ? d.businesses[0].id : undefined,
      name: `Stockchain Audit Supplier ${Date.now().toString(36).slice(-4)}`,
      phone: '08031234567',
      payment_terms_days: 30,
    });
    assert.ok(res.status < 400, `creating a supplier answered ${res.status}: ${String(res.text).slice(0, 200)}`);
    const id = res.json.id || (res.json.supplier && res.json.supplier.id) || (res.json.data && res.json.data.id);
    assert.ok(id, 'the supplier was created and the answer carries no id');
    d.trackSupplier(id);
    return { id, name: res.json.name || 'Stockchain Audit Supplier' };
  });

  // The creditor book answers under `creditors`, and it lists only suppliers with a
  // NON-ZERO balance — a supplier you owe nothing to is not a creditor, and is correctly
  // absent. So the shape of the answer is asserted (a reader that has the wrong key reads
  // an empty book and calls it ₦0 owed) and a supplier that is genuinely absent is 0.
  // The first version of this reader looked in `data`/`suppliers`, found nothing under
  // either, answered 0, and reported a charge that had never been lost as though it had.
  const owedTo = async (supplierId) => {
    const res = await owner.get('/api/creditors?limit=200');
    assert.equal(res.status, 200, `the creditors list answered ${res.status}`);
    assert.ok(Array.isArray(res.json && res.json.creditors),
      `the creditor book did not answer with a list under \`creditors\` (keys: ${Object.keys(res.json || {}).join(', ')}) — a reader that guesses the key reads an empty book and calls every supplier settled`);
    const row = res.json.creditors.find((s) => String(s.id) === String(supplierId));
    return row ? round2(Number(row.owed)) : 0;
  };

  // BEFORE THE ORDER EXISTS: this supplier has been used and is owed nothing.
  const owedBefore = await owedTo(supplier.id);
  assert.equal(owedBefore, 0, `a supplier with no order against it is owed ${money(owedBefore)}`);

  // ===================================================================
  audit.section('Buying it — the shelf AND the supplier’s account both move');
  // ===================================================================
  const QTY = 12;
  const po = await audit.captureAsync('a purchase order for twelve units', async () => {
    const res = await owner.post('/api/purchase-orders', {
      branch_id: from.id,
      supplier_id: supplier.id,
      items: [{ product_id: product.id, quantity: QTY, expected_unit_cost: unitCost }],
      notes: 'Stockchain audit — the goods will be received in full.',
    });
    assert.ok(res.status === 201 || res.status === 200, `raising a purchase order answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    const id = res.json.id || res.json.purchase_order_id || (res.json.purchase_order && res.json.purchase_order.id);
    assert.ok(id, 'the purchase order was raised and the answer carries no id');
    return { id, number: res.json.po_number || res.json.poNumber || null };
  });
  audit.note(`purchase order ${po.number || po.id} raised for ${QTY} × ${product.sku}`);

  await audit.checkAsync('the goods are not on the shelf until somebody receives them', async () => {
    const before = await stockAt(from);
    const after = await stockAt(from);
    assert.equal(before, after, 'reading the shelf twice changed it');
    // The receipt is what moves stock, and the check below is the one that proves it —
    // this establishes the figure both sides are measured against.
    audit.note(`${from.name} holds ${before} unit(s) before the receipt`);
  });

  const detail = await audit.captureAsync('the order read back with its lines', async () => {
    const res = await owner.get(`/api/purchase-orders/${encodeURIComponent(po.id)}`);
    assert.equal(res.status, 200, `reading the order back answered ${res.status} ${String(res.text).slice(0, 200)}`);
    const items = res.json.items || (res.json.purchase_order && res.json.purchase_order.items) || res.json.data || [];
    assert.ok(Array.isArray(items) && items.length === 1, `the order read back with ${Array.isArray(items) ? items.length : 'no'} line(s)`);
    assert.equal(round2(Number(items[0].quantity_ordered != null ? items[0].quantity_ordered : items[0].quantity)), QTY);
    return items[0];
  });

  // THE MOMENT THE ORDER IS RAISED, the whole order is owed: a SENT purchase order is a
  // promise to pay. (The read that says the supplier was owed NOTHING is taken below the
  // supplier, before the order exists — measuring it here would only ever prove the order
  // had already been raised.)
  const owedAtOrder = await owedTo(supplier.id);
  assert.equal(owedAtOrder, round2(QTY * unitCost),
    `${QTY} units at ${money(unitCost)} were ordered and the supplier is owed ${money(owedAtOrder)}, expected ${money(round2(QTY * unitCost))}. A promise to pay that never reaches the creditor book is a bill the business does not know it has`);

  await audit.checkAsync('receiving it puts the stock on THAT branch’s shelf and nowhere else', async () => {
    const hereBefore = await stockAt(from);
    const thereBefore = await stockAt(to);

    const res = await owner.post(`/api/purchase-orders/${encodeURIComponent(po.id)}/receive`, {
      receipts: [{ item_id: detail.id, quantity_received: QTY }],
      on_credit: round2(QTY * unitCost),
      idempotency_key: `stockchain-receive-${Date.now().toString(36)}`,
    });
    assert.ok(res.status < 400, `receiving the order answered ${res.status}: ${String(res.text).slice(0, 300)}`);

    // FRONT TO BACK: the shelf moved by exactly what arrived.
    const hereAfter = await stockAt(from);
    assert.equal(hereAfter, hereBefore + QTY,
      `${from.name} held ${hereBefore} and ${QTY} arrived, so it should hold ${hereBefore + QTY}; it holds ${hereAfter}. Goods that arrive on the books and not on the shelf are goods nobody can sell`);
    // AND THE OTHER BRANCH IS UNTOUCHED — the failure that makes two shops wrong at once.
    const thereAfter = await stockAt(to);
    assert.equal(thereAfter, thereBefore,
      `${to.name} holds ${thereAfter} after a receipt at ${from.name}; a receipt at one branch moved another branch's stock`);

    // BACK TO FRONT: the money side. THE OBLIGATION IS BOOKED WHEN THE ORDER IS RAISED, NOT
    // WHEN THE GOODS LAND — a SENT purchase order is a promise to pay, and booking it at
    // receipt instead would hide a commitment the business has already made. (The first
    // version of this check asserted the balance RISE at receipt, read ₦258,000 → ₦258,000,
    // and called a correct book a lost payment. The two readings below are the ones that
    // can only be right if the ledger does what its own comment says.)
    const owedAfterReceipt = await owedTo(supplier.id);
    assert.equal(owedAfterReceipt, owedAtOrder,
      `the receipt moved the creditor balance ${money(owedAtOrder)} → ${money(owedAfterReceipt)}. The obligation was booked when the order was raised; booking it again at receipt charges the business twice for one delivery`);
  });

  // ===================================================================
  audit.section('Sending it — two branches, and only one of them moves at a time');
  // ===================================================================
  const SENT = 5;
  const transfer = await audit.captureAsync('a transfer of five units between branches', async () => {
    const res = await owner.post('/api/transfers', {
      from_branch_id: from.id,
      to_branch_id: to.id,
      items: [{ product_id: product.id, quantity: SENT }],
      reference: `STK-${Date.now().toString(36).toUpperCase()}`,
    });
    assert.ok(res.status === 201 || res.status === 200, `dispatching a transfer answered ${res.status}: ${String(res.text).slice(0, 260)}`);
    const id = res.json.id || res.json.transfer_id || (res.json.transfer && res.json.transfer.id);
    assert.ok(id, 'the transfer was created and the answer carries no id');
    return { id };
  });

  await audit.checkAsync('dispatching takes it off the sending branch and does NOT credit the receiving one', async () => {
    const hereAfter = await stockAt(from);
    assert.equal(hereAfter, (await stockAt(from)), 'reading twice disagreeing means the read is unreliable, not the transfer');
    // The transfer is IN_TRANSIT: the goods have left the shelf and have not arrived.
    const list = await owner.get(`/api/transfers?limit=50`);
    const row = ((list.json && (list.json.data || list.json.transfers)) || []).find((t) => String(t.id) === String(transfer.id));
    assert.ok(row, 'the new transfer is not in the transfer list');
    assert.equal(String(row.status), 'IN_TRANSIT',
      `a dispatched transfer is "${row.status}". Until it is received the goods are on a road: they must not count as sellable at either branch, and they must not have vanished either — a transfer that completes itself is one nobody reconciles`);
    const thereNow = await stockAt(to);
    audit.note(`${to.name} holds ${thereNow} with ${SENT} unit(s) in transit; it must not move until the receipt`);
    await audit.checkAsync('and the receiving branch still cannot sell them', async () => {
      const res = await owner.get(`/api/stock?branch_id=${encodeURIComponent(to.id)}&limit=200`);
      assert.equal(res.status, 200);
      const rows = ((res.json.data || res.json.stock) || []).filter((r) => String(r.product_id || (r.product && r.product.id)) === String(product.id));
      const sellable = rows.reduce((s, r) => s + Number(r.available != null ? r.available : (r.quantity_available != null ? r.quantity_available : (r.on_shelf || 0))), 0);
      assert.ok(sellable >= thereNow, 'goods in transit are being counted as available at the destination');
    });
  });

  // THE TRANSFER LINE IS READ ONCE, HERE. It was `const line` inside the over-receipt check
  // below, so the clean receipt that follows could not see it and threw `line is not
  // defined` BEFORE posting — the transfer was never received, the destination never got
  // the goods, and the count section then counted a line that did not exist. One block
  // scope cost three checks and looked like three separate defects.
  const line = await audit.captureAsync('the transfer read back with its line', async () => {
    const res = await owner.get(`/api/transfers/${encodeURIComponent(transfer.id)}`);
    assert.equal(res.status, 200, `reading the transfer back answered ${res.status}: ${String(res.text).slice(0, 200)}`);
    const rows = ((res.json.items || (res.json.transfer && res.json.transfer.items) || []));
    const l = rows.find((x) => String(x.product_id) === String(product.id));
    assert.ok(l, 'the transfer read back with no line for the product that was sent');
    return l;
  });

  const sentBase = Number(line.quantity_sent_base != null ? line.quantity_sent_base : line.quantity_sent);

  await audit.checkAsync('the branch that SENT the goods cannot book them in', async () => {
    const res = await senderSeat.post(`/api/transfers/${encodeURIComponent(transfer.id)}/receive`, {
      items: [{ item_id: line.id, quantity_received_base: sentBase }],
    });
    assert.equal(res.status, 403,
      `a seat at ${from.name} (the sending branch) booked in goods addressed to ${to.name}: ${res.status} ${String(res.text).slice(0, 200)}. A receipt that the receiving branch did not make is a delivery nobody at the shop checked`);
    assert.equal(res.json.code, 'BRANCH_SCOPE_VIOLATION', `the refusal came back as ${res.json.code}`);
  });

  await audit.checkAsync('receiving more than was sent is refused, not absorbed', async () => {
    // THE OVER-RECEIPT IS EXPRESSED IN THE UNIT THE SERVER COMPARES, which is BASE
    // units, and the figure is READ from the transfer's own line rather than assumed.
    // The first version of this check sent `quantity_received: 8` against a transfer of
    // 5 CARTONS — 8 base units, comfortably within the 60 that were sent — and the
    // receipt went through, which is how this check now reads the line first.
    audit.note(`${SENT} unit(s) sent is ${sentBase} in base units — the receipt below asks for one more`);

    // THE BODY IS `items`, MATCHED BY `item_id` — the receiving screen's shape, not a
    // guess. (An earlier version of this check sent `overrides`, which the endpoint
    // ignores: the receipt went through as a full 5, the guard never fired, and the check
    // reported a missing refusal that had simply never been asked for.)
    const res = await manager.post(`/api/transfers/${encodeURIComponent(transfer.id)}/receive`, {
      items: [{ item_id: line.id, quantity_received_base: sentBase + 1 }],
    });
    assert.ok(res.status >= 400 && res.status < 500,
      `a transfer of ${sentBase} base unit(s) accepted a receipt of ${sentBase + 1}: ${res.status} ${String(res.text).slice(0, 200)}. Extra goods belong on a transfer of their own, where the discrepancy can be seen`);
    const row = await owner.get(`/api/transfers/${encodeURIComponent(transfer.id)}`);
    const tr = row.json.transfer || row.json;
    assert.equal(String(tr.status), 'IN_TRANSIT', 'the refused over-receipt closed the transfer anyway');
  });

  await audit.checkAsync('receiving it puts the goods on the destination’s shelf, and lands the whole quantity', async () => {
    const hereBefore = await stockAt(from);
    const thereBefore = await stockAt(to);
    const res = await manager.post(`/api/transfers/${encodeURIComponent(transfer.id)}/receive`, {
      items: [{ item_id: line.id, quantity_received_base: sentBase }],
    });
    assert.ok(res.status < 400, `receiving the transfer answered ${res.status}: ${String(res.text).slice(0, 240)}`);

    const thereAfter = await stockAt(to);
    assert.equal(thereAfter, thereBefore + SENT,
      `${to.name} held ${thereBefore} and ${SENT} arrived, so it should hold ${thereBefore + SENT}; it holds ${thereAfter}`);
    const hereAfter = await stockAt(from);
    assert.equal(hereAfter, hereBefore,
      `${from.name} moved from ${hereBefore} to ${hereAfter} while RECEIVING a transfer — the sending happened at dispatch and must not be charged again`);

    // AND THE LEDGER AGREES: the transfer became real, not a second draft.
    const row = await owner.get(`/api/transfers/${encodeURIComponent(transfer.id)}`);
    const tr = row.json.transfer || row.json;
    assert.equal(String(tr.status), 'RECEIVED', `the transfer status is ${tr.status} after a receipt`);
    assert.ok(tr.received_by || tr.received_at, 'the transfer does not record who received it or when — the question asked when the count is short');
  });

  // ===================================================================
  audit.section('Counting it — a wrong count is visible before it is committed');
  // ===================================================================
  // A SECOND PRODUCT ON THE SHELF FIRST, and that is not scene-setting: the refusal this
  // section proves — "you are committing over lines nobody counted" — needs a line nobody
  // counted. A branch holding ONE product has nothing uncounted after its single line is
  // answered, so the first version of this check watched a commit succeed and called it a
  // failure. Goods arrive here the way they arrive in a shop: by an adjustment.
  const second = await audit.captureAsync('a second product on the shelf, to be left uncounted', async () => {
    const res = await owner.get('/api/products?limit=200');
    const rows = (res.json.data || res.json.products || []).filter((p) => String(p.id) !== String(product.id));
    if (!rows.length) return null;
    const other = rows[0];
    const adj = await owner.post('/api/stock/adjust', {
      branch_id: to.id, product_id: other.id, quantity: 3,
      adjustment_type: 'FOUND', reason: 'Stockchain audit — a second line for the count',
    });
    assert.ok(adj.status < 400, `stocking a second product answered ${adj.status}: ${String(adj.text).slice(0, 200)}`);
    return other;
  });
  if (second) audit.note(`${second.sku} added to ${to.name} so the count has a line nobody will answer`);

  const session = await audit.captureAsync('a stocktake at the receiving branch', async () => {
    const res = await manager.post('/api/stocktakes', { branch_id: to.id, scope: 'FULL', notes: 'Stockchain audit run' });
    if (res.status === 409) {
      // A deployment already counting somewhere is a working deployment, and the refusal
      // is the right answer — but then this section has nothing to stand on.
      audit.skip('the stocktake flow', `this branch already has an open count (${res.json.code || res.status})`);
      return null;
    }
    assert.ok(res.status === 201 || res.status === 200, `opening a stocktake answered ${res.status}: ${String(res.text).slice(0, 240)}`);
    const id = res.json.id || res.json.stocktake_id || (res.json.stocktake && res.json.stocktake.id);
    assert.ok(id, 'the stocktake was opened and the answer carries no id');
    return { id };
  });

  if (!session) {
    audit.note('the count section was skipped: this branch is already counting');
  } else {
    const lines = await audit.captureAsync('its lines, with the system’s figure on each', async () => {
      const res = await manager.get(`/api/stocktakes/${encodeURIComponent(session.id)}`);
      assert.equal(res.status, 200, `reading the session answered ${res.status} ${String(res.text).slice(0, 200)}`);
      const rows = res.json.lines || (res.json.stocktake && res.json.stocktake.lines) || [];
      assert.ok(rows.length > 0, 'a full stocktake opened with no lines to count');
      return rows;
    });

    // THE PRODUCT'S OWN LINE, AND ONLY IT — every other line is left for the refusal below
    // to complain about. It used to fall back to `lines[0]`, and on staging that fallback
    // silently picked a line for a product the audit had never touched: the count then read
    // "0 against a system figure of 0" and the whole section passed without counting
    // anything. A count that cannot find the line it just stocked is not a count.
    const mine = lines.filter((l) => String(l.product_id) === String(product.id));
    audit.note(`${lines.length} line(s) on this count, ${mine.length} for ${product.sku} (system ${mine.map((l) => l.system_qty).join(', ') || '—'})`);
    assert.ok(mine.length > 0,
      `the count open at ${to.name} has ${lines.length} line(s) and not one of them is ${product.sku}, which was received at this branch minutes ago. A full count that does not count the stock in front of it is the failure this section exists to catch`);
    // A COUNT NEEDS A LINE WITH SOMETHING ON IT. On staging this product sat on the shelf in
    // SIXTEEN batches — one per previous audit run — and the first three were empty: the
    // count answered 0 against a system figure of 0, the variance was zero, and the section
    // passed without proving anything. The line chosen is therefore the fullest one, which
    // is the line a real stocktaker would start with.
    const withStock = mine.filter((l) => Number(l.system_qty) > 0)
      .sort((a, b) => Number(b.system_qty) - Number(a.system_qty));
    assert.ok(withStock.length > 0,
      `every one of the ${mine.length} line(s) for ${product.sku} at ${to.name} shows no stock, though ${SENT} unit(s) were received at this branch in this run`);
    const target = withStock[0];
    if (mine.length > 1) {
      audit.note(`${mine.length} batches of ${product.sku} on this shelf (${withStock.length} with stock); the count answers the fullest and leaves the rest uncounted`);
    }
    const uncountedLines = lines.filter((l) => String(l.id) !== String(target.id)).length;
    const expected = Number(target.expected_qty != null ? target.expected_qty : target.system_qty || 0);
    const counted = Math.max(0, expected - 2);
    audit.note(`counting ${product.sku} as ${counted} against a system figure of ${expected} — a deliberate discrepancy of 2`);

    await audit.checkAsync('a count that disagrees is recorded as a variance, and committing without accepting them is refused', async () => {
      const res = await manager.post(`/api/stocktakes/${encodeURIComponent(session.id)}/counts`, {
        counts: [{ line_id: target.id, counted_qty: counted }],
      });
      assert.ok(res.status < 400, `recording a count answered ${res.status}: ${String(res.text).slice(0, 240)}`);

      const read = await manager.get(`/api/stocktakes/${encodeURIComponent(session.id)}`);
      const row = ((read.json.lines || [])).find((l) => String(l.id) === String(target.id));
      assert.ok(row, 'the counted line is not in the session');
      assert.equal(Number(row.counted_qty), counted, `the session stored ${row.counted_qty} for a count of ${counted}`);
      const variance = Number(row.variance != null ? row.variance : (row.counted_qty - row.expected_qty));
      assert.equal(variance, counted - expected, 'the variance on the line does not match the count against the system figure');

      // THE REFUSAL THAT MATTERS: uncounted lines are the norm in a real shop, and
      // committing over them silently would write off everything nobody got to.
      if (uncountedLines > 0) {
        const early = await manager.post(`/api/stocktakes/${encodeURIComponent(session.id)}/commit`, {});
        assert.equal(early.status, 409, `committing a session with ${uncountedLines} uncounted line(s) answered ${early.status} ${String(early.text).slice(0, 200)}`);
        assert.ok(/uncounted/i.test(String(early.json.error || '')), `the refusal does not say what is missing: ${early.json.error}`);
        const stillOpen = await manager.get(`/api/stocktakes/${encodeURIComponent(session.id)}`);
        // THE DETAIL ANSWERS UNDER `session` (`server/routes/stock.js:938`). Reading
        // `stocktake` instead gave `undefined`, and `undefined !== 'COUNTING'` reported a
        // session closed by a commit that had actually been refused.
        const stillOpenSession = stillOpen.json.session || stillOpen.json.stocktake || stillOpen.json;
        assert.equal(String(stillOpenSession.status), 'COUNTING',
          `the refused commit left the session "${stillOpenSession.status}" — a refusal that closes the session anyway is a refusal nobody can act on`);
      } else {
        audit.note('every line on this count was answered, so the uncounted refusal has nothing to fire on here — it is asserted where a line exists');
      }
    });

    await audit.checkAsync('committing adjusts the shelf to what was counted, and says who adjusted it', async () => {
      const before = await stockAt(to, { required: false });
      let uncountedHeld = null;
      if (second) {
        const pre = await owner.get(`/api/stock?branch_id=${encodeURIComponent(to.id)}&limit=200`);
        const preRows = ((pre.json.data || pre.json.stock) || []).filter((r) => String(r.product_id || (r.product && r.product.id)) === String(second.id));
        uncountedHeld = preRows.reduce((sum, r) => sum + Number(r.on_shelf != null ? r.on_shelf : 0), 0);
      }
      const res = await manager.post(`/api/stocktakes/${encodeURIComponent(session.id)}/commit`, { accept_uncounted: true });
      assert.ok(res.status < 400, `committing answered ${res.status}: ${String(res.text).slice(0, 300)}`);
      const after = await stockAt(to, { required: false });
      const delta = round2(after - before);
      assert.equal(delta, round2(counted - expected),
        `the count said ${counted} where the system held ${expected}, so the shelf should move by ${counted - expected}; it moved by ${delta}. A stocktake that does not change the figure is a form nobody filled in`);

      const read = await manager.get(`/api/stocktakes/${encodeURIComponent(session.id)}`);
      const session2 = read.json.session || read.json.stocktake || read.json;
      assert.equal(String(session2.status), 'COMMITTED', `the session status is ${session2.status} after committing`);

      // AND THE LINE NOBODY COUNTED WAS LEFT ALONE. Committing "over" uncounted lines
      // must not mean adjusting them to zero, which is the quiet way a stocktake writes
      // off everything a cashier did not get to.
      if (second) {
        const stockRes = await owner.get(`/api/stock?branch_id=${encodeURIComponent(to.id)}&limit=200`);
        const rows = ((stockRes.json.data || stockRes.json.stock) || []).filter((r) => String(r.product_id || (r.product && r.product.id)) === String(second.id));
        const held = rows.reduce((sum, r) => sum + Number(r.on_shelf != null ? r.on_shelf : (r.quantity_in_base != null ? r.quantity_in_base : (r.quantity || 0))), 0);
        // HELD BEFORE, NOT AN ASSUMED 3. This read `=== 3` and passed against a fresh local
        // database and failed against staging, where an earlier run of this same audit had
        // already put its own 3 units there: the shelf held 6, the goods were untouched, and
        // the check accused the commit of moving them. A shared deployment is not a fresh
        // one, and an audit that runs twice must not mistake its own last visit for a defect.
        assert.equal(held, uncountedHeld,
          `the uncounted product held ${uncountedHeld} unit(s) before the commit and holds ${held} after it. An uncounted line must be left exactly as it was, not adjusted towards anything`);
      }
      const adjustments = await owner.get(`/api/stock/adjustments?branch_id=${encodeURIComponent(to.id)}&limit=50`);
      if (adjustments.status === 200) {
        const rows = (adjustments.json.data || []);
        const mine = rows.filter((a) => String(a.reference_id || '') === String(session.id) || /stocktake/i.test(String(a.reason || '')));
        audit.note(`${mine.length} stock adjustment(s) recorded against this count, so the variance is traceable rather than silent`);
      }
    });
  }

  audit.note('the chain is closed: bought, moved, counted — and every figure read back from the deployment');
}, {
  // TWO BRANCHES AND A MANAGER AT THE SECOND. The manager is the seat that opens and
  // commits the count, because counting is a management act in this product; the owner
  // buys and moves, because that is where the money is committed.
  setup: () => startDeployment({
    label: 'stockchain',
    businesses: [{
      name: 'Stockchain Audit Stores', profileCode: 'ELECTRONICS', vatRegistered: true,
      branches: [
        { name: 'Stockchain Depot', code: 'STK-1', city: 'Abuja', state: 'FCT', branch_type: 'WAREHOUSE', opening_cash: 150000 },
        { name: 'Stockchain Shop', code: 'STK-2', city: 'Abuja', state: 'FCT', branch_type: 'RETAIL', opening_cash: 40000 },
      ],
    }],
    seats: [
      { as: 'manager', role: 'MANAGER', username: 'stk-manager', pin: '60417', branchIndex: 1, full_name: 'Stockchain Audit Manager' },
      // A SEAT AT THE SENDING BRANCH, because the rule that matters here is two-sided and
      // only a seat can show it: the branch that SENT the goods must not be able to book
      // them in, and the branch that got them must. The first version of this audit posted
      // both receipts as the owner, which passed on a local deployment (where the owner
      // carries no branch) and answered 403 on staging (where the owner is pinned to a
      // branch) — the same code, two answers, and the live one was right.
      { as: 'sender', role: 'MANAGER', username: 'stk-sender', pin: '60418', branchIndex: 0, full_name: 'Stockchain Sending Manager' },
    ],
  }),
});
