// =====================================================================
// StockRidge — DOMAIN CORE (public surface)
// =====================================================================
// ONE import for both backends. server/app.js (Node + better-sqlite3) and
// worker/src/index.js (Cloudflare Workers + D1) require this same module
// and therefore share ONE definition of what a price is, what a valid
// payment is, who may void a sale, and how a schedule balances.
//
// This file is the seam that makes "two backends, one behaviour" auditable:
// if a rule exists in only one backend, it is not in here, and a diff
// against this file is how you find it.
//
// NOTHING in domain/ may:
//   * touch the database,
//   * read an environment variable (except the PBKDF2 iteration count,
//     which is a documented strength setting),
//   * import a Node built-in that Workers lacks,
//   * hold mutable module-level state.
// Every function is pure or takes its inputs explicitly. That is what makes
// the domain testable without a database and portable without a shim.
// =====================================================================

const money = require('./money');
const verticals = require('./verticals');
const uom = require('./uom');
const tax = require('./tax');
const pricing = require('./pricing');
const payments = require('./payments');
const creditPlans = require('./creditPlans');
const warranty = require('./warranty');
const fulfilment = require('./fulfilment');
const stockMovement = require('./stockMovement');
const identity = require('./identity');
const compliance = require('./compliance');
const audit = require('./audit');

module.exports = {
  money,
  verticals,
  uom,
  tax,
  pricing,
  payments,
  creditPlans,
  warranty,
  fulfilment,
  stockMovement,
  identity,
  compliance,
  audit,
};
