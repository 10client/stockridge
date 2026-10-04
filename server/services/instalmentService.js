// =====================================================================
// StockRidge — INSTALMENT PLANS  ("Ajo" / work-and-pay / lay-by credit)
// =====================================================================
// The most important consumer-credit flow in Nigerian retail, and the one
// most often run on a notebook. A customer takes a generator, fridge or sofa
// home and pays weekly or monthly over 3-12 months. On paper it is
// unenforceable and unauditable; in the system it produces a schedule, a
// balance, an aging report and a guarantor record.
//
// FOUR THINGS THIS MODULE GETS RIGHT THAT A NOTEBOOK CANNOT:
//
//  1. THE SCHEDULE IS GENERATED UP FRONT and sums EXACTLY to the plan total.
//     ₦100,000 over 3 months is not 3 x ₦33,333.33 — three rounded
//     instalments would leave one kobo uncollected per plan, which across
//     thousands of plans is real money and an unreconcilable book.
//     money.allocateKobo() does largest-remainder allocation in integer kobo
//     so the schedule always sums to the principal plus interest exactly.
//
//  2. POSSESSION AND TITLE ARE SEPARATE FIELDS. This is the single most
//     consequential setting on a plan and the one a notebook never records:
//       POSSESSION_WITH_TITLE_HELD — customer has the goods, the shop keeps
//                                    title until the final payment. The normal
//                                    work-and-pay arrangement, and the one
//                                    that makes repossession legally
//                                    arguable rather than theft.
//       GOODS_HELD_UNTIL_PAID      — lay-by: goods stay in the shop.
//       POSSESSION_AND_TITLE       — the customer owns it now and simply owes
//                                    money. Highest risk; requires the
//                                    strongest KYC and a guarantor.
//
//  3. INTEREST IS DECLARED AS FLAT OR REDUCING, and the effective total is
//     shown to the customer BEFORE they sign. The difference is large and it
//     is the difference a customer feels: a "5% plan" on ₦600,000 over 12
//     months is ₦30,000 flat but roughly ₦16,250 on a reducing balance.
//     Quoting one and charging the other is how a shop acquires a reputation.
//
//  4. AN OVERDUE INSTALMENT IS A QUERY, NOT A CALCULATION. The due view
//     classifies each instalment SETTLED / OVERDUE / DUE_SOON / UPCOMING so a
//     branch manager opens one screen each morning and knows who to call. An
//     instalment book nobody chases on the day it falls due becomes a
//     bad-debt book within a quarter.
//
// STOCK: where possession passes, the goods leave stock immediately and the
// receivable is what remains. Where goods are held (lay-by), stock is
// RESERVED, not decremented — see layawayService and stock_reservations.
// =====================================================================

const { newId, watNowIso, watDate, addDays, addMonths, daysBetween } = require('../../shared/ids');
const { round2, fromKobo, toKobo, allocateKobo, sumMoney } = require('../../shared/money');
const { HttpError } = require('../lib/http');
const stockService = require('./stockService');
const { PREFIXES, nextReference } = require('../lib/references');
const { writeAudit } = require('../lib/audit');
const { assertBranchAccess } = require('../lib/roles');
const { assertCapability, capabilitiesOf } = require('../lib/capabilities');
const { getUnitSettings, assertSubscribed, staffAllowance } = require('../lib/planLimits');

const PLAN_TYPES = ['INSTALMENT', 'WORK_AND_PAY', 'ESUSU_AJO', 'LAYBY_CREDIT', 'STAFF_LOAN'];
const FREQUENCIES = ['DAILY', 'WEEKLY', 'FORTNIGHTLY', 'MONTHLY', 'QUARTERLY', 'LUMP_SUM'];
const POSSESSION_MODES = ['POSSESSION_WITH_TITLE_HELD', 'GOODS_HELD_UNTIL_PAID', 'POSSESSION_AND_TITLE'];
const PLAN_STATUSES = ['DRAFT', 'ACTIVE', 'COMPLETED', 'DEFAULTED', 'CANCELLED', 'RESTRUCTURED', 'WRITTEN_OFF'];

const FREQUENCY_DAYS = Object.freeze({ DAILY: 1, WEEKLY: 7, FORTNIGHTLY: 14, MONTHLY: null, QUARTERLY: null, LUMP_SUM: null });

function nextDueDate(fromDate, frequency, index) {
  const f = String(frequency).toUpperCase();
  if (f === 'DAILY') return addDays(fromDate, index);
  if (f === 'WEEKLY') return addDays(fromDate, index * 7);
  if (f === 'FORTNIGHTLY') return addDays(fromDate, index * 14);
  if (f === 'MONTHLY') return addMonths(fromDate, index);
  if (f === 'QUARTERLY') return addMonths(fromDate, index * 3);
  return fromDate;                                            // LUMP_SUM
}

// ---------------------------------------------------------------------
// SCHEDULE CONSTRUCTION
// ---------------------------------------------------------------------
// Pure function, exhaustively testable. Given a principal, a deposit, an
// interest basis and a frequency, produce instalments that sum EXACTLY to
// total_payable.
function buildSchedule({ principal, depositAmount, interestPercent, interestType, instalmentCount, firstDueDate, frequency }) {
  const p = round2(Math.max(0, Number(principal) || 0));
  const deposit = round2(Math.max(0, Number(depositAmount) || 0));
  if (deposit > p) {
    throw new HttpError(400, `A deposit of ₦${deposit.toLocaleString('en-NG')} is more than the ₦${p.toLocaleString('en-NG')} price of the goods.`, 'PLAN_DEPOSIT_EXCEEDS_PRINCIPAL');
  }
  const financed = round2(p - deposit);
  const rate = round2(Math.max(0, Number(interestPercent) || 0));
  const type = String(interestType || 'NONE').toUpperCase();
  const n = Math.max(1, Math.trunc(Number(instalmentCount) || 1));

  let interestTotal = 0;
  const perInstalment = [];

  if (type === 'FLAT' && rate > 0) {
    // FLAT: interest on the ORIGINAL financed amount for the whole term,
    // divided across instalments. Higher total cost to the customer, simpler
    // to explain, and what most Nigerian work-and-pay arrangements actually
    // are.
    interestTotal = round2((financed * rate) / 100);
    const shares = allocateKobo(interestTotal, new Array(n).fill(1));
    for (let i = 0; i < n; i += 1) perInstalment.push(fromKobo(shares[i]));
  } else if (type === 'REDUCING' && rate > 0) {
    // REDUCING BALANCE: interest each period on what is still outstanding.
    // Cheaper for the customer and the honest way to quote a rate, but it
    // produces unequal instalments unless they are levelled — and a level
    // instalment is what a customer can budget for, so the schedule computes
    // the annuity and then allocates any rounding residual.
    const r = rate / 100;
    const periods = n;
    const annuity = r === 0 ? financed / periods : (financed * r) / (1 - Math.pow(1 + r, -periods));
    let outstanding = financed;
    let interestSum = 0;
    for (let i = 0; i < periods; i += 1) {
      const interest = round2(outstanding * r);
      const principalPart = round2(Math.min(outstanding, annuity - interest));
      interestSum = round2(interestSum + interest);
      outstanding = round2(outstanding - principalPart);
      perInstalment.push(round2(principalPart + interest));
    }
    interestTotal = interestSum;
    // The final instalment absorbs any drift so the schedule closes exactly.
    const drift = round2(financed + interestTotal - sumMoney(perInstalment));
    if (Math.abs(drift) > 0) perInstalment[perInstalment.length - 1] = round2(perInstalment[perInstalment.length - 1] + drift);
  } else {
    // NONE: interest-free plan. Divide the financed amount exactly.
    interestTotal = 0;
    const shares = allocateKobo(financed, new Array(n).fill(1));
    for (let i = 0; i < n; i += 1) perInstalment.push(fromKobo(shares[i]));
  }

  const totalPayable = round2(financed + interestTotal);
  const scheduled = sumMoney(perInstalment);
  // This assertion is the entire reason the schedule is built in kobo. If it
  // ever fails, the plan would quietly under- or over-collect.
  if (toKobo(scheduled) !== toKobo(totalPayable)) {
    const residual = round2(totalPayable - scheduled);
    perInstalment[perInstalment.length - 1] = round2(perInstalment[perInstalment.length - 1] + residual);
  }

  const items = perInstalment.map((amount, i) => ({
    seq: i + 1,
    due_date: nextDueDate(String(firstDueDate).slice(0, 10), frequency, i + 1),
    amount_due: round2(amount),
    interest_portion: type === 'FLAT' ? round2(interestTotal / n) : (type === 'REDUCING' ? round2(Math.max(0, amount - (financed / n))) : 0),
    principal_portion: 0,                                    // refined below
    amount_paid: 0,
    status: 'SCHEDULED',
  }));
  // Split each instalment into principal and interest by proportion of the
  // totals, in kobo, so the two columns each sum exactly to their total.
  const principalShares = allocateKobo(financed, items.map((it) => it.amount_due));
  const interestShares = allocateKobo(interestTotal, items.map((it) => it.amount_due));
  items.forEach((it, i) => {
    it.principal_portion = fromKobo(principalShares[i]);
    it.interest_portion = fromKobo(interestShares[i]);
  });

  return {
    principal: p,
    deposit_amount: deposit,
    financed_amount: financed,
    interest_percent: rate,
    interest_type: type === 'NONE' || rate === 0 ? 'NONE' : type,
    interest_total: interestTotal,
    total_payable: totalPayable,
    instalment_count: n,
    instalment_amount: round2(totalPayable / n),
    items,
    // Shown to the customer before they sign. Quoting a rate and letting them
    // discover the total is how a shop acquires a reputation.
    effective_cost_of_credit: interestTotal,
    effective_annual_percent: financed > 0 && n > 0
      ? round2((interestTotal / financed) * (365 / Math.max(1, (daysBetween(String(firstDueDate).slice(0, 10), items[items.length - 1].due_date) || n * 30))))
      : 0,
  };
}

// ---------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------
async function createPlan(db, ctx, input) {
  const businessUnitId = ctx.businessUnitId;
  const settings = ctx.businessUnit || await getUnitSettings(db, businessUnitId);
  assertSubscribed(settings, ctx.user, { action: 'open an instalment plan' });
  assertCapability(settings, 'instalment_plans', { action: 'open an instalment plan' });

  const branchId = input.branch_id || ctx.user.branch_id;
  if (!branchId) throw new HttpError(400, 'Choose which branch this plan belongs to.', 'BRANCH_REQUIRED');
  assertBranchAccess(ctx.user, branchId);

  const allowance = await staffAllowance(db, businessUnitId, ctx.user);
  if (String(ctx.user.role).toUpperCase() === 'STAFF' && !allowance.can_take_credit_sale) {
    throw new HttpError(403,
      'Only a manager can open an instalment plan in this business. It is a credit decision, and the owner controls who may make one under My Plan.',
      'PLAN_STAFF_NOT_PERMITTED');
  }

  if (!input.customer_id) throw new HttpError(400, 'An instalment plan must be against a named customer.', 'PLAN_CUSTOMER_REQUIRED');
  const customer = await db.prepare('SELECT * FROM customers WHERE id = ? AND is_deleted = 0').bind(input.customer_id).first();
  if (!customer) throw new HttpError(404, 'That customer was not found.', 'CUSTOMER_NOT_FOUND');

  // KYC. A plan is an unsecured or lightly-secured credit exposure to a
  // person who will have the goods. Requiring identity here — and only here —
  // is proportionate: requiring it of every walk-in buyer would kill the
  // counter.
  if (customer.kyc_status !== 'VERIFIED') {
    if (!input.id_type || !input.id_number) {
      throw new HttpError(400,
        'An instalment plan needs the customer\u2019s identity verified first. Record an ID type and number (NIN, BVN, driver\u2019s licence, passport or voter\u2019s card) on the customer, then open the plan.',
        'PLAN_KYC_REQUIRED');
    }
  }

  const possession = String(input.possession || 'POSSESSION_WITH_TITLE_HELD').toUpperCase();
  if (!POSSESSION_MODES.includes(possession)) throw new HttpError(400, `Possession must be one of: ${POSSESSION_MODES.join(', ')}.`, 'PLAN_POSSESSION_INVALID');
  if (possession === 'POSSESSION_AND_TITLE' && !input.guarantor_name) {
    throw new HttpError(400,
      'Passing both possession AND title before the plan is paid is the highest-risk arrangement available. It requires a named guarantor with a phone number.',
      'PLAN_GUARANTOR_REQUIRED');
  }
  if (!input.guarantor_name || !input.guarantor_phone) {
    throw new HttpError(400,
      'A guarantor name and phone number are required. Without one there is nobody to contact when the customer stops answering, which is the entire point of asking.',
      'PLAN_GUARANTOR_REQUIRED');
  }

  const planType = String(input.plan_type || 'INSTALMENT').toUpperCase();
  if (!PLAN_TYPES.includes(planType)) throw new HttpError(400, `Plan type must be one of: ${PLAN_TYPES.join(', ')}.`, 'PLAN_TYPE_INVALID');
  const frequency = String(input.frequency || 'MONTHLY').toUpperCase();
  if (!FREQUENCIES.includes(frequency)) throw new HttpError(400, `Frequency must be one of: ${FREQUENCIES.join(', ')}.`, 'PLAN_FREQUENCY_INVALID');
  const count = Number(input.instalment_count);
  if (!Number.isFinite(count) || count < 1 || count > 120) {
    throw new HttpError(400, 'Instalment count must be between 1 and 120.', 'PLAN_COUNT_INVALID');
  }

  const items = Array.isArray(input.items) ? input.items : [];
  if (!items.length) throw new HttpError(400, 'An instalment plan needs at least one item.', 'PLAN_EMPTY');

  const firstDue = String(input.first_due_date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(firstDue)) throw new HttpError(400, 'First due date must be YYYY-MM-DD.', 'PLAN_FIRST_DUE_INVALID');
  if (daysBetween(watDate(), firstDue) < 0) {
    throw new HttpError(400, 'The first due date cannot be in the past — a plan that starts overdue starts in default.', 'PLAN_FIRST_DUE_PAST');
  }

  // Value the goods. Prices come from the pricing service, not from the
  // client: a plan is a credit exposure and letting the device state the
  // principal would let a cashier understate it.
  const pricedItems = [];
  let principal = 0;
  for (let i = 0; i < items.length; i += 1) {
    const raw = items[i];
    if (!raw.product_id) throw new HttpError(400, `Line ${i + 1}: choose a product.`, 'PRODUCT_REQUIRED');
    const product = await db.prepare('SELECT * FROM products WHERE id = ? AND is_deleted = 0').bind(raw.product_id).first();
    if (!product) throw new HttpError(404, `Line ${i + 1}: that product was not found.`, 'PRODUCT_NOT_FOUND');
    const qty = Number(raw.quantity) || 1;
    if (qty <= 0) throw new HttpError(400, `Line ${i + 1}: quantity must be more than zero.`, 'PLAN_QUANTITY_INVALID');

    const priced = await pricing(db, ctx, { businessUnitId, branchId, product, quantity: qty, customerId: customer.id, unitType: raw.unit_type });
    const lineTotal = round2(priced.unit_price * qty);
    principal = round2(principal + lineTotal);
    pricedItems.push({
      product_id: product.id, product_name: product.name, quantity: qty,
      unit_price: priced.unit_price, line_total: lineTotal, serial_id: raw.serial_id || null,
    });
  }

  const deposit = round2(Math.max(0, Number(input.deposit_amount) || 0));
  const depositPercent = round2(Math.max(0, Number(input.deposit_percent) || 0));
  const effectiveDeposit = deposit > 0 ? deposit : round2((principal * depositPercent) / 100);
  const MIN_DEPOSIT_PERCENT = 10;
  if (principal > 0 && (effectiveDeposit / principal) * 100 < MIN_DEPOSIT_PERCENT && possession !== 'GOODS_HELD_UNTIL_PAID') {
    throw new HttpError(400,
      `A deposit of at least ${MIN_DEPOSIT_PERCENT}% (₦${round2((principal * MIN_DEPOSIT_PERCENT) / 100).toLocaleString('en-NG')}) is required before goods leave the shop. `
      + 'The owner can change this threshold; until then, take a larger deposit or hold the goods until paid.',
      'PLAN_DEPOSIT_TOO_SMALL');
  }

  const schedule = buildSchedule({
    principal,
    depositAmount: effectiveDeposit,
    interestPercent: input.interest_percent != null ? Number(input.interest_percent) : 0,
    interestType: input.interest_type || 'NONE',
    instalmentCount: count,
    firstDueDate: firstDue,
    frequency,
  });

  const ts = watNowIso();
  const planId = newId();
  const branch = await db.prepare('SELECT code FROM branches WHERE id = ?').bind(branchId).first();
  const planNo = input.plan_no
    || (await nextReference(db, { businessUnitId, prefix: PREFIXES.PAYMENT_PLAN, branchCode: branch.code || '*', scope: 'YEAR' })).reference;

  const statements = [
    db.prepare(`
      INSERT INTO payment_plans (
        id, business_unit_id, branch_id, plan_no, customer_id, sale_id, plan_type, status,
        principal, deposit_amount, interest_percent, interest_type, total_payable, amount_paid, balance_due,
        frequency, instalment_count, instalment_amount, first_due_date, next_due_date,
        possession, guarantor_name, guarantor_phone, guarantor_address, guarantor_id_type, guarantor_id_no,
        collateral_description, contract_note, signed_at, approved_by, created_by, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?, ?,?,?,?, ?,?, ?,?,?,?,?,?, ?,?,?,?,?)
    `).bind(
      planId, businessUnitId, branchId, planNo, customer.id, input.sale_id || null, planType, 'DRAFT',
      schedule.principal, schedule.deposit_amount, schedule.interest_percent, schedule.interest_type,
      schedule.total_payable, 0, schedule.total_payable,
      frequency, count, schedule.instalment_amount, firstDue, schedule.items[0].due_date,
      possession, String(input.guarantor_name).slice(0, 160), String(input.guarantor_phone).slice(0, 20),
      input.guarantor_address ? String(input.guarantor_address).slice(0, 400) : null,
      input.guarantor_id_type ? String(input.guarantor_id_type).toUpperCase() : null,
      input.guarantor_id_no ? String(input.guarantor_id_no).slice(0, 60) : null,
      input.collateral_description ? String(input.collateral_description).slice(0, 500) : null,
      input.contract_note ? String(input.contract_note).slice(0, 2000) : null,
      input.signed_at ? watNowIso() : null, ctx.user.id, ctx.user.id, ts, ts
    ),
  ];

  for (const it of schedule.items) {
    statements.push(db.prepare(`
      INSERT INTO payment_plan_items (
        id, business_unit_id, payment_plan_id, seq, due_date, amount_due, principal_portion,
        interest_portion, amount_paid, status, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?, 0, 'SCHEDULED',?,?)
    `).bind(newId(), businessUnitId, planId, it.seq, it.due_date, it.amount_due, it.principal_portion, it.interest_portion, ts, ts));
  }
  for (const pi of pricedItems) {
    // Item lines are stored against seq 1 as the goods manifest; the schedule
    // rows above carry the money. Keeping them separate means the goods list
    // can be reprinted on a receipt without recomputing the schedule.
    statements.push(db.prepare(`
      INSERT INTO payment_plan_items (
        id, business_unit_id, payment_plan_id, seq, product_id, serial_id, quantity, unit_price,
        line_total, due_date, amount_due, status, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?, ?, 0, 'SCHEDULED',?,?)
    `).bind(newId(), businessUnitId, planId, 0, pi.product_id, pi.serial_id, pi.quantity, pi.unit_price,
      pi.line_total, firstDue, ts, ts));
  }

  // Stock handling depends on POSSESSION, and this is where the distinction
  // actually bites.
  if (possession === 'GOODS_HELD_UNTIL_PAID') {
    for (const pi of pricedItems) {
      await stockService.reserve(db, {
        businessUnitId, branchId, productId: pi.product_id, quantity: pi.quantity,
        sourceType: 'PAYMENT_PLAN', sourceId: planId, serialId: pi.serial_id || null,
        customerId: customer.id, reservedBy: ctx.user.id,
      });
    }
  } else {
    // Goods leave now. Decrement stock and, for a serialised item, mark it
    // SOLD against the plan — because a phone that walked out on work-and-pay
    // must not be sellable again, and its warranty must run from today.
    for (const pi of pricedItems) {
      const consumed = await stockService.buildConsumeStatements(db, {
        businessUnitId, branchId, productId: pi.product_id, quantityBase: pi.quantity,
        movementType: 'SALE', sourceType: 'PAYMENT_PLAN', sourceId: planId, reference: planNo,
        reason: `Released on instalment plan ${planNo} (${possession.replace(/_/g, ' ').toLowerCase()})`,
        performedBy: ctx.user.id, deviceId: ctx.deviceId || null, now: ts,
      });
      for (const s of consumed.statements) statements.push(s);
      if (pi.serial_id) {
        statements.push(db.prepare(`
          UPDATE product_serials SET status = 'SOLD', sold_at = ?, notes = COALESCE(notes || ' | ','') || ?, updated_at = ?
          WHERE id = ? AND status IN ('IN_STOCK','RESERVED')
        `).bind(ts, `Instalment plan ${planNo}`, ts, pi.serial_id));
      }
    }
  }

  await db.batch(statements);

  await writeAudit(db, {
    businessUnitId, branchId, userId: ctx.user.id, actorRole: ctx.user.role,
    action: 'PLAN_CREATED', entityType: 'PAYMENT_PLAN', entityId: planId, amount: schedule.total_payable,
    after: { plan_no: planNo, principal: schedule.principal, deposit: schedule.deposit_amount, interest_type: schedule.interest_type, instalments: count, possession },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  return {
    ok: true, id: planId, plan_no: planNo, status: 'DRAFT',
    customer: { id: customer.id, full_name: customer.full_name, phone: customer.phone },
    items: pricedItems,
    schedule,
    possession,
    advisory: possession === 'POSSESSION_WITH_TITLE_HELD'
      ? 'The customer has the goods but the business retains title until the final instalment. That must be stated on the signed agreement — it is what makes recovery a contractual remedy rather than a dispute about ownership.'
      : (possession === 'GOODS_HELD_UNTIL_PAID' ? 'The goods are reserved and will not be sold to anyone else. They are released when the plan completes.' : null),
  };
}

async function pricing(db, ctx, { businessUnitId, branchId, product, quantity, customerId, unitType }) {
  const pricingService = require('./pricingService');
  return pricingService.resolveUnitPrice(db, ctx, {
    businessUnitId, branchId, productId: product.id,
    unitType: unitType || 'BASE_UNIT', quantity, customerId,
  });
}

// ACTIVATE: the customer has signed and the deposit has been taken.
async function activate(db, ctx, { planId, depositPayment = null }) {
  const plan = await load(db, planId, ctx.businessUnitId);
  if (!plan) throw new HttpError(404, 'That plan was not found.', 'PLAN_NOT_FOUND');
  assertBranchAccess(ctx.user, plan.branch_id);
  if (plan.status !== 'DRAFT') throw new HttpError(409, `Only a DRAFT plan can be activated — this one is ${plan.status}.`, 'PLAN_NOT_DRAFT');

  if (Number(plan.deposit_amount) > 0 && !depositPayment) {
    throw new HttpError(400,
      `This plan has a ₦${Number(plan.deposit_amount).toLocaleString('en-NG')} deposit. Record the deposit payment to activate it — a plan activated without its deposit collected is a plan whose first instalment is already overdue.`,
      'PLAN_DEPOSIT_NOT_PAID');
  }
  if (!plan.signed_at) {
    throw new HttpError(400,
      'Record the customer\u2019s signature/acknowledgement before activating. An instalment agreement nobody signed is an instalment agreement nobody can enforce.',
      'PLAN_NOT_SIGNED');
  }

  const ts = watNowIso();
  const statements = [
    db.prepare(`
      UPDATE payment_plans SET status = 'ACTIVE', updated_at = ? WHERE id = ? AND status = 'DRAFT'
    `).bind(ts, planId),
  ];
  await db.batch(statements);

  let depositRecorded = null;
  if (depositPayment) {
    depositRecorded = await recordPayment(db, ctx, {
      planId, amount: Number(plan.deposit_amount), method: depositPayment.method || 'CASH',
      reference: depositPayment.reference || null, note: 'Deposit on activation', appliedToSeq: null,
    });
  }
  await writeAudit(db, {
    businessUnitId: plan.business_unit_id, branchId: plan.branch_id, userId: ctx.user.id,
    actorRole: ctx.user.role, action: 'PLAN_ACTIVATED', entityType: 'PAYMENT_PLAN', entityId: planId,
    amount: Number(plan.total_payable), after: { status: 'ACTIVE' }, ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });
  return { ok: true, id: planId, status: 'ACTIVE', deposit: depositRecorded };
}

// RECORD A PAYMENT against a plan. Applies to the OLDEST outstanding
// instalment first unless told otherwise — applying to the newest would let a
// customer look current while the arrears aged invisibly.
async function recordPayment(db, ctx, { planId, amount, method = 'CASH', reference = null, note = null, appliedToSeq = null, penaltyAmount = 0 }) {
  const plan = await load(db, planId, ctx.businessUnitId);
  if (!plan) throw new HttpError(404, 'That plan was not found.', 'PLAN_NOT_FOUND');
  assertBranchAccess(ctx.user, plan.branch_id);
  if (!['ACTIVE', 'DEFAULTED'].includes(plan.status)) {
    throw new HttpError(409, `A ${plan.status} plan cannot take a payment. Reactivate or restructure it first.`, 'PLAN_NOT_PAYABLE');
  }
  const value = round2(Number(amount));
  if (!Number.isFinite(value) || value <= 0) throw new HttpError(400, 'The payment must be more than zero.', 'PLAN_PAYMENT_INVALID');

  const m = String(method).toUpperCase();
  if (!['CASH', 'POS_TERMINAL', 'BANK_TRANSFER', 'USSD', 'MOBILE_MONEY', 'CHEQUE', 'OTHER'].includes(m)) {
    throw new HttpError(400, 'Payment method must be CASH, POS_TERMINAL, BANK_TRANSFER, USSD, MOBILE_MONEY, CHEQUE or OTHER.', 'PLAN_PAYMENT_METHOD_INVALID');
  }
  if (['BANK_TRANSFER', 'POS_TERMINAL', 'CHEQUE', 'USSD'].includes(m) && !reference) {
    throw new HttpError(400,
      `A ${m.replace(/_/g, ' ').toLowerCase()} instalment payment needs a reference. Without it the payment cannot be matched to a bank statement, and an unmatched instalment is indistinguishable from an unpaid one.`,
      'PLAN_PAYMENT_REFERENCE_REQUIRED');
  }

  const balance = round2(Number(plan.balance_due));
  if (value > balance + 0.005) {
    throw new HttpError(400,
      `That payment of ₦${value.toLocaleString('en-NG')} is more than the ₦${balance.toLocaleString('en-NG')} outstanding on this plan. Overpaying would create a credit the customer can only recover by arguing for it.`,
      'PLAN_OVERPAYMENT');
  }

  const branchId = ctx.user.branch_id || plan.branch_id;
  const ts = watNowIso();
  const items = await db.prepare(`
    SELECT * FROM payment_plan_items
    WHERE payment_plan_id = ? AND seq > 0 AND is_deleted = 0 AND status <> 'PAID'
    ORDER BY ${appliedToSeq ? 'CASE WHEN seq = ? THEN 0 ELSE 1 END, ' : ''}due_date ASC, seq ASC
  `).bind(planId, ...(appliedToSeq ? [Number(appliedToSeq)] : [])).all();
  if (!items.results.length) throw new HttpError(409, 'Every instalment on this plan is already settled.', 'PLAN_NOTHING_OUTSTANDING');

  // Allocate across instalments oldest-first, splitting principal and
  // interest proportionally so neither column drifts.
  let remaining = value;
  const allocations = [];
  for (const it of items.results) {
    if (remaining <= 0.004) break;
    const outstanding = round2(Number(it.amount_due) - Number(it.amount_paid));
    if (outstanding <= 0) continue;
    const apply = round2(Math.min(outstanding, remaining));
    const interestShare = Number(it.amount_due) > 0 ? round2((apply * Number(it.interest_portion)) / Number(it.amount_due)) : 0;
    allocations.push({
      item: it, apply,
      principal: round2(apply - interestShare),
      interest: interestShare,
      newPaid: round2(Number(it.amount_paid) + apply),
      newStatus: round2(Number(it.amount_paid) + apply) >= round2(Number(it.amount_due)) - 0.004 ? 'PAID' : 'PART_PAID',
    });
    remaining = round2(remaining - apply);
  }
  if (remaining > 0.004 && !allocations.length) {
    throw new HttpError(409, 'That payment could not be applied to any instalment.', 'PLAN_PAYMENT_UNAPPLIED');
  }

  const receiptNo = (await nextReference(db, { businessUnitId: plan.business_unit_id, prefix: PREFIXES.PLAN_RECEIPT, branchCode: '*', scope: 'YEAR' })).reference;
  const paymentId = newId();
  const statements = [];

  for (const a of allocations) {
    statements.push(db.prepare(`
      UPDATE payment_plan_items SET amount_paid = ?, status = ?, paid_at = CASE WHEN ? = 'PAID' THEN ? ELSE paid_at END, updated_at = ?
      WHERE id = ?
    `).bind(a.newPaid, a.newStatus, a.newStatus, ts, ts, a.item.id));
  }

  const principalApplied = round2(allocations.reduce((s, a) => s + a.principal, 0));
  const interestApplied = round2(allocations.reduce((s, a) => s + a.interest, 0));
  statements.push(db.prepare(`
    INSERT INTO payment_plan_payments (
      id, business_unit_id, payment_plan_id, plan_item_id, branch_id, till_session_id, receipt_no,
      amount, principal_applied, interest_applied, penalty_applied, method, reference, collected_by,
      device_id, received_at, notes, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    paymentId, plan.business_unit_id, planId, allocations[0] ? allocations[0].item.id : null, branchId,
    input0(ctx), receiptNo, value, principalApplied, interestApplied, round2(Number(penaltyAmount) || 0),
    m, reference ? String(reference).slice(0, 120) : null, ctx.user.id, ctx.deviceId || null, ts,
    note ? String(note).slice(0, 500) : null, ts, ts
  ));

  const newPaid = round2(Number(plan.amount_paid) + value);
  const newBalance = round2(Number(plan.total_payable) - newPaid);
  const nextItem = await db.prepare(`
    SELECT due_date FROM payment_plan_items
    WHERE payment_plan_id = ? AND seq > 0 AND is_deleted = 0 AND status <> 'PAID'
    ORDER BY due_date ASC LIMIT 1
  `).bind(planId).first();
  const isComplete = toKobo(newBalance) <= 0;

  statements.push(db.prepare(`
    UPDATE payment_plans SET
      amount_paid = ?, balance_due = ?, last_paid_at = ?,
      next_due_date = ?,
      status = CASE WHEN ? THEN 'COMPLETED' WHEN status = 'DEFAULTED' THEN 'ACTIVE' ELSE status END,
      completed_at = CASE WHEN ? THEN ? ELSE completed_at END,
      updated_at = ?
    WHERE id = ?
  `).bind(newPaid, Math.max(0, newBalance), ts, nextItem ? nextItem.due_date : null, isComplete ? 1 : 0, isComplete ? 1 : 0, isComplete ? ts : null, ts, planId));

  // Cash actually received goes into the till that is open, so the plan book
  // and the drawer agree. An instalment collected in cash and not counted in
  // a till is a shortage that will be blamed on a cashier.
  const till = await db.prepare(`SELECT * FROM till_sessions WHERE branch_id = ? AND status = 'OPEN' AND is_deleted = 0`).bind(branchId).first();
  if (till && m === 'CASH') {
    statements.push(db.prepare(`
      UPDATE till_sessions SET expected_cash = expected_cash + ?, expected_total = expected_total + ?, updated_at = ? WHERE id = ?
    `).bind(value, value, ts, till.id));
  }

  await db.batch(statements);

  // GL: an instalment receipt moves cash and reduces the receivable. The
  // interest portion is income, and recognising it on RECEIPT rather than on
  // accrual is the conservative choice for a business whose plans default.
  if (capabilitiesOf(ctx.businessUnit || await getUnitSettings(db, plan.business_unit_id)).general_ledger) {
    try {
      const glService = require('./glService');
      const account = { CASH: '1000', POS_TERMINAL: '1030', BANK_TRANSFER: '1020', USSD: '1040', MOBILE_MONEY: '1040', CHEQUE: '1050', OTHER: '1020' }[m] || '1020';
      const lines = [{ account_code: account, debit: value, credit: 0, description: `Instalment ${receiptNo}` }];
      if (interestApplied > 0.004) lines.push({ account_code: '4300', debit: 0, credit: interestApplied, description: `Interest on ${plan.plan_no}` });
      lines.push({ account_code: '1210', debit: 0, credit: round2(value - interestApplied), description: `Instalment plan ${plan.plan_no}` });
      await glService.postEntry(db, {
        businessUnitId: plan.business_unit_id, branchId, entryDate: watDate(),
        sourceType: 'PAYMENT_PLAN', sourceId: planId, reference: receiptNo,
        description: `Instalment receipt ${receiptNo} — ${plan.plan_no}`, lines, userId: ctx.user.id,
      });
    } catch (e) { console.error('[instalmentService] GL posting failed for', receiptNo, e && e.message); }
  }

  await writeAudit(db, {
    businessUnitId: plan.business_unit_id, branchId, userId: ctx.user.id, actorRole: ctx.user.role,
    action: 'PLAN_PAYMENT', entityType: 'PAYMENT_PLAN', entityId: planId, amount: value,
    after: { receipt_no: receiptNo, balance_due: Math.max(0, newBalance), status: isComplete ? 'COMPLETED' : plan.status },
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });

  return {
    ok: true, payment_id: paymentId, receipt_no: receiptNo, amount: value,
    principal_applied: principalApplied, interest_applied: interestApplied,
    applied_to: allocations.map((a) => ({ seq: a.item.seq, due_date: a.item.due_date, applied: a.apply, status: a.newStatus })),
    plan_balance_due: Math.max(0, newBalance), plan_status: isComplete ? 'COMPLETED' : plan.status,
    next_due_date: nextItem ? nextItem.due_date : null,
    advisory: isComplete
      ? 'That settles the plan. Title passes to the customer and any reserved stock should be released.'
      : null,
  };
}

// ctx.tillSessionId is set by the POS route when a payment lands in an open
// till; absent for a plan payment taken at the back office.
function input0(ctx) { return ctx.tillSessionId || null; }

async function markDefault(db, ctx, { planId, reason }) {
  const plan = await load(db, planId, ctx.businessUnitId);
  if (!plan) throw new HttpError(404, 'That plan was not found.', 'PLAN_NOT_FOUND');
  assertBranchAccess(ctx.user, plan.branch_id);
  if (plan.status !== 'ACTIVE') throw new HttpError(409, `Only an ACTIVE plan can be marked in default — this one is ${plan.status}.`, 'PLAN_NOT_ACTIVE');
  if (!reason || String(reason).trim().length < 5) {
    throw new HttpError(400, 'Marking a customer in default needs a written reason of at least 5 characters. It is the record you will need if you ever have to recover the goods.', 'PLAN_DEFAULT_REASON_REQUIRED');
  }
  if (String(ctx.user.role).toUpperCase() === 'STAFF') {
    throw new HttpError(403, 'Only a manager can mark a plan in default. It is a decision with consequences for the customer and for the books.', 'PLAN_DEFAULT_FORBIDDEN');
  }
  const ts = watNowIso();
  const statements = [
    db.prepare(`UPDATE payment_plans SET status = 'DEFAULTED', defaulted_at = ?, default_reason = ?, updated_at = ? WHERE id = ?`)
      .bind(ts, String(reason).slice(0, 500), ts, planId),
    db.prepare(`UPDATE payment_plan_items SET status = 'OVERDUE', updated_at = ? WHERE payment_plan_id = ? AND status IN ('SCHEDULED','PART_PAID') AND due_date < date('now','+1 hour')`)
      .bind(ts, planId),
  ];
  await db.batch(statements);
  await writeAudit(db, {
    businessUnitId: plan.business_unit_id, branchId: plan.branch_id, userId: ctx.user.id,
    actorRole: ctx.user.role, action: 'PLAN_DEFAULTED', entityType: 'PAYMENT_PLAN', entityId: planId,
    amount: Number(plan.balance_due), reason: String(reason).slice(0, 500),
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });
  return { ok: true, id: planId, status: 'DEFAULTED' };
}

// WRITE OFF. The last resort, and the one that must be hardest to reach: a
// plan written off is revenue recognised and never collected, and it removes
// the incentive to chase. OWNER only, with a reason, and the receivable stays
// visible in a written-off report forever.
async function writeOff(db, ctx, { planId, reason }) {
  const plan = await load(db, planId, ctx.businessUnitId);
  if (!plan) throw new HttpError(404, 'That plan was not found.', 'PLAN_NOT_FOUND');
  const role = String(ctx.user.role).toUpperCase();
  if (role !== 'OWNER' && role !== 'ADMIN') {
    throw new HttpError(403, 'Only the owner can write off an instalment plan. It removes a receivable from the books and ends the right to recover the goods.', 'PLAN_WRITEOFF_FORBIDDEN');
  }
  if (!reason || String(reason).trim().length < 10) {
    throw new HttpError(400, 'A write-off needs a written reason of at least 10 characters. It will be read by an auditor and by you in a year\u2019s time.', 'PLAN_WRITEOFF_REASON_REQUIRED');
  }
  if (['COMPLETED', 'WRITTEN_OFF', 'CANCELLED'].includes(plan.status)) {
    throw new HttpError(409, `A ${plan.status} plan cannot be written off.`, 'PLAN_NOT_WRITABLE');
  }
  const ts = watNowIso();
  await db.batch([
    db.prepare(`UPDATE payment_plans SET status = 'WRITTEN_OFF', written_off_at = ?, written_off_by = ?, default_reason = ?, updated_at = ? WHERE id = ?`)
      .bind(ts, ctx.user.id, String(reason).slice(0, 500), ts, planId),
    db.prepare(`UPDATE payment_plan_items SET status = 'WAIVED', updated_at = ? WHERE payment_plan_id = ? AND status <> 'PAID'`)
      .bind(ts, planId),
  ]);

  // Release any reservation and, if title never passed, put the goods back.
  if (plan.possession === 'GOODS_HELD_UNTIL_PAID') {
    const reservations = await db.prepare(`SELECT id FROM stock_reservations WHERE source_type = 'PAYMENT_PLAN' AND source_id = ? AND status = 'ACTIVE'`).bind(planId).all();
    for (const r of reservations.results) {
      try { await stockService.releaseReservation(db, r.id, { status: 'CANCELLED' }); } catch (e) { console.error('[instalmentService] reservation release failed:', e && e.message); }
    }
  }

  if (capabilitiesOf(ctx.businessUnit || await getUnitSettings(db, plan.business_unit_id)).general_ledger) {
    try {
      const glService = require('./glService');
      const value = round2(Number(plan.balance_due));
      if (value > 0.004) {
        await glService.postEntry(db, {
          businessUnitId: plan.business_unit_id, branchId: plan.branch_id, entryDate: watDate(),
          sourceType: 'PAYMENT_PLAN', sourceId: planId, reference: plan.plan_no,
          description: `Bad debt written off — plan ${plan.plan_no}`,
          lines: [
            { account_code: '6990', debit: value, credit: 0, description: `Bad debt ${plan.plan_no}` },
            { account_code: '1210', debit: 0, credit: value, description: `Instalment receivable ${plan.plan_no}` },
          ],
          userId: ctx.user.id,
        });
      }
    } catch (e) { console.error('[instalmentService] GL write-off posting failed:', e && e.message); }
  }

  await writeAudit(db, {
    businessUnitId: plan.business_unit_id, branchId: plan.branch_id, userId: ctx.user.id,
    actorRole: role, action: 'PLAN_WRITTEN_OFF', entityType: 'PAYMENT_PLAN', entityId: planId,
    amount: Number(plan.balance_due), reason: String(reason).slice(0, 500),
    ipAddress: ctx.ipAddress, deviceId: ctx.deviceId,
  });
  return { ok: true, id: planId, status: 'WRITTEN_OFF', written_off_value: round2(Number(plan.balance_due)) };
}

async function load(db, planId, businessUnitId = null) {
  return db.prepare(`
    SELECT pp.*, c.full_name AS customer_name, c.phone AS customer_phone, c.address AS customer_address,
           c.id_type AS customer_id_type, c.id_number AS customer_id_number,
           b.name AS branch_name, u.full_name AS created_by_name
    FROM payment_plans pp
    JOIN customers c ON c.id = pp.customer_id
    JOIN branches b ON b.id = pp.branch_id
    LEFT JOIN users u ON u.id = pp.created_by
    WHERE pp.id = ? AND pp.is_deleted = 0 ${businessUnitId ? 'AND pp.business_unit_id = ?' : ''}
  `).bind(planId, ...(businessUnitId ? [businessUnitId] : [])).first();
}

async function getWithSchedule(db, planId, businessUnitId) {
  const plan = await load(db, planId, businessUnitId);
  if (!plan) return null;
  const [items, payments, goods] = await Promise.all([
    db.prepare('SELECT * FROM payment_plan_items WHERE payment_plan_id = ? AND seq > 0 AND is_deleted = 0 ORDER BY seq').bind(planId).all(),
    db.prepare(`SELECT pp.*, u.full_name AS collected_by_name FROM payment_plan_payments pp LEFT JOIN users u ON u.id = pp.collected_by WHERE pp.payment_plan_id = ? AND pp.is_deleted = 0 ORDER BY pp.received_at`).bind(planId).all(),
    db.prepare(`
      SELECT pi.*, p.name AS product_name, p.sku, ps.serial_no
      FROM payment_plan_items pi
      JOIN products p ON p.id = pi.product_id
      LEFT JOIN product_serials ps ON ps.id = pi.serial_id
      WHERE pi.payment_plan_id = ? AND pi.seq = 0 AND pi.is_deleted = 0
    `).bind(planId).all(),
  ]);
  const today = watDate();
  return {
    ...plan,
    schedule: items.results.map((it) => ({
      ...it,
      outstanding: round2(Number(it.amount_due) - Number(it.amount_paid)),
      is_overdue: it.status !== 'PAID' && it.due_date < today,
      days_overdue: it.status !== 'PAID' && it.due_date < today ? daysBetween(it.due_date, today) : 0,
    })),
    payments: payments.results,
    goods: goods.results,
  };
}

async function list(db, { businessUnitId, branchId = null, customerId = null, status = null, overdueOnly = false, limit = 50, offset = 0 }) {
  const where = ['pp.is_deleted = 0', 'pp.business_unit_id = ?'];
  const params = [businessUnitId];
  if (branchId) { where.push('pp.branch_id = ?'); params.push(branchId); }
  if (customerId) { where.push('pp.customer_id = ?'); params.push(customerId); }
  if (status) { where.push('pp.status = ?'); params.push(String(status).toUpperCase()); }
  if (overdueOnly) { where.push(`EXISTS (SELECT 1 FROM payment_plan_items pi WHERE pi.payment_plan_id = pp.id AND pi.is_deleted = 0 AND pi.status <> 'PAID' AND pi.due_date < date('now','+1 hour'))`); }

  const rows = await db.prepare(`
    SELECT pp.*, c.full_name AS customer_name, c.phone AS customer_phone, b.name AS branch_name,
      (SELECT COUNT(*) FROM payment_plan_items pi WHERE pi.payment_plan_id = pp.id AND pi.is_deleted = 0 AND pi.status <> 'PAID' AND pi.due_date < date('now','+1 hour')) AS overdue_instalments,
      (SELECT COALESCE(SUM(pi.amount_due - pi.amount_paid),0) FROM payment_plan_items pi WHERE pi.payment_plan_id = pp.id AND pi.is_deleted = 0 AND pi.status <> 'PAID' AND pi.due_date < date('now','+1 hour')) AS overdue_amount,
      (SELECT MAX(pi.due_date) FROM payment_plan_items pi WHERE pi.payment_plan_id = pp.id AND pi.is_deleted = 0 AND pi.status <> 'PAID') AS next_due_date_computed
    FROM payment_plans pp
    JOIN customers c ON c.id = pp.customer_id
    JOIN branches b ON b.id = pp.branch_id
    WHERE ${where.join(' AND ')}
    ORDER BY CASE WHEN pp.status = 'DEFAULTED' THEN 0 WHEN pp.status = 'ACTIVE' THEN 1 ELSE 2 END, pp.next_due_date ASC
    LIMIT ? OFFSET ?
  `).bind(...params, Math.min(500, Number(limit) || 50), Number(offset) || 0).all();
  return rows.results;
}

// The morning screen: who to call today. Ordered by days overdue then amount,
// because a ₦2,000 instalment 60 days late is a worse signal than a
// ₦50,000 instalment due tomorrow.
async function collectionsQueue(db, { businessUnitId, branchId = null, daysAhead = 7, limit = 100 }) {
  const rows = await db.prepare(`
    SELECT * FROM v_plan_installments_due
    WHERE business_unit_id = ? ${branchId ? 'AND branch_id = ?' : ''}
      AND ageing IN ('OVERDUE','DUE_SOON')
      AND julianday(due_date) - julianday('now','+1 hour') <= ?
    ORDER BY CASE ageing WHEN 'OVERDUE' THEN 0 ELSE 1 END, days_overdue DESC, outstanding DESC
    LIMIT ?
  `).bind(businessUnitId, ...(branchId ? [branchId] : []), Number(daysAhead) || 7, Math.min(500, Number(limit) || 100)).all();

  const results = rows.results.map((r) => ({ ...r, amount_due: round2(r.amount_due), amount_paid: round2(r.amount_paid), outstanding: round2(r.outstanding) }));
  return {
    results,
    overdue_count: results.filter((r) => r.ageing === 'OVERDUE').length,
    overdue_value: round2(results.filter((r) => r.ageing === 'OVERDUE').reduce((a, r) => a + r.outstanding, 0)),
    due_soon_count: results.filter((r) => r.ageing === 'DUE_SOON').length,
    due_soon_value: round2(results.filter((r) => r.ageing === 'DUE_SOON').reduce((a, r) => a + r.outstanding, 0)),
  };
}

module.exports = {
  PLAN_TYPES, FREQUENCIES, POSSESSION_MODES, PLAN_STATUSES,
  nextDueDate, buildSchedule, createPlan, activate, recordPayment,
  markDefault, writeOff, load, getWithSchedule, list, collectionsQueue,
};
'use strict';
