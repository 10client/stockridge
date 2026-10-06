# PharmaRidge → StockRidge: the parity analysis, and what StockRidge must have anyway

**How this was produced.** PharmaRidge's dump (`/home/user/uploads/0.txt`, 49,952 lines) was
read as a *reference implementation*, not as a document: its tables, its API routes and its
screen vocabulary were extracted mechanically and diffed against this tree. Every verdict below
is backed by a grep that either finds the capability in StockRidge or proves it absent — no
verdict is "I think we have that". Where a difference is a **deliberate design choice** rather
than a gap, it says so and says why.

Date: 2026-10-06. Baseline commit at the time of writing: `2d06615`.

---

## 1. Coverage, measured

| Surface | PharmaRidge | StockRidge | Notes |
| --- | --- | --- | --- |
| Tables the schema declares | 45 | **76** | 41 shared; StockRidge's extra 35 are the multi-vertical, offline, sync and compliance machinery |
| API route shapes | 70 | **147** | StockRidge carries roughly twice the surface |
| Audit suites | (several) | 7 (`concurrency http limits money roles sync wht`) | PharmaRidge's audits name-checked as the standard to match |
| CSV export of reports | `Exporter.downloadCSV` on every report screen | **present** — `public/js/export.js`, `reports.js` "Download CSV", `reports.js:664 toCsv` | parity achieved, not a gap |

**StockRidge is not a subset of PharmaRidge.** Of PharmaRidge's 45 tables, 41 exist here; of its
70 route shapes, most have an equivalent under a different name (`/api/gl/profit-loss` here is
`/api/accounting/profit-loss`; `/api/till/open` is `/api/tills/open`; `/api/wht/*` is
`/api/accounting/wht`). The genuinely-missing list is short, and it is below.

---

## 2. PharmaRidge has it, StockRidge does not — with verdicts

### 2.1 Data management — **IMPLEMENT (G1, the user named this one)**

PharmaRidge ships a complete data-management feature; StockRidge has *half* of it and no door to
the other half.

| Piece | PharmaRidge | StockRidge today |
| --- | --- | --- |
| Scheduled retention | `lib/retention.js`: `pruneSyncChangeLog(90d)`, `pruneLoginAttempts(90d)`, `pruneReviewedSyncConflicts(180d, unreviewed kept forever)`; wired into the Worker's `scheduled` cron via `ctx.waitUntil` | `worker/src/housekeeping.js` prunes only sessions + idempotency keys + raises compliance alerts. **`sync_change_log` and reviewed `sync_conflicts` are never pruned — they grow without bound.** |
| Retention visibility | `GET /api/data-management/status` — storage estimate, plan limit, percent used, what a purge would remove, recent history | **absent** |
| Guarded purge | `POST /api/data-management/purge` — 5 modes, each with its own **confirmation phrase**, plus `export_confirmed` + `retention_acknowledged`, OWNER-only, executed as one atomic `db.batch`, summary written to `data_cleanup_log` | **absent** — `data_cleanup_log` exists in the schema and nothing writes to it (it is one of this repo's own baselined capability gaps) |
| Capacity warnings before the wall | plan screen: "**N MB** of **M MB** estimated (**P %**)", with the Owner told before it becomes a problem | `domain/planLimits.js` caps businesses/branches/staff; **no storage estimate** |
| Offline replays after a purge | older queued items are **quarantined for review**, never allowed to recreate deleted records | no purge, so no rule — the rule is part of G1 |

PharmaRidge's purge modes, to be mirrored (phrases are part of the contract — they cannot be
satisfied by accident):

| Mode | Confirmation phrase | Keeps |
| --- | --- | --- |
| `SELECTED_PERIOD` | `DELETE SELECTED PERIOD` | everything outside the dates given |
| `CLEAR_OPERATIONS_KEEP_ACCOUNTING` | `CLEAR OPERATIONS KEEP ACCOUNTING` | the ledger |
| `CLEAR_OPERATIONS_KEEP_ACCOUNTING_AND_STOCK` | `CLEAR OPERATIONS KEEP ACCOUNTING AND STOCK` | the ledger and the shelf |
| `ALL_BUSINESS_DATA` | `CLEAR ALL BUSINESS DATA` | the account, the team, the settings |
| `FULL_SETUP_RESET` | `RESET BUSINESS AND TEAM` | only the account |

### 2.2 Change owed to a customer — **IMPLEMENT (G2)**

PharmaRidge: `GET /api/change-owed` (scoped list), `GET /api/change-owed/code/:code` (a customer
claims by code), `POST /api/change-owed/:id/settle {method}`, `POST /api/change-owed/:id/write-off
{reason}`, plus a dashboard card.

StockRidge: the `change_owed` table is **written** (every sale that leaves change outstanding) and
**read** (on the sale detail), and the `change_owed_expiry_days` setting exists — but there is **no
route to hand the money over**. A customer's change can be recorded as owed and then never
recorded as paid: the shop's liability only ever grows, and the counter has no way to clear it.

### 2.3 A staff transfer the receiving manager must accept — **IMPLEMENT (G3)**

PharmaRidge: `GET /api/users/transfers/pending`, `/pending/mine`, and the accept flow, backed by
`pending_user_transfers`. StockRidge: the **table exists and nothing creates a row** (one of this
repo's own baselined gaps). Today a user can be moved between branches without the branch that
receives them ever agreeing to it — which is how a cashier ends up able to see a shop they have
never worked in.

### 2.4 Dashboard depth — **IMPLEMENT (G4, in part)**

PharmaRidge widgets with no StockRidge equivalent: `void-audit` (what was voided, by whom, why),
`unreconciled-cash` (money taken but not yet reconciled), `branches-breakdown`,
`license-expiry-alerts`, and the plan/storage card. StockRidge's dashboard exposes only
`/api/dashboard` and `/api/dashboard/summary`. Each of these is an *answer to a question a
proprietor asks*, and each is cheap: the data is already in the schema.

### 2.5 Deliberate, documented differences — **NOT defects**

| PharmaRidge | StockRidge | Why this is correct here |
| --- | --- | --- |
| `_pharmaridge_admin_preserve` keeps the administrator across a data wipe | `tools/reseed.js` → `provisionPlatform(db, {adminUsername, adminPin})` creates **exactly one administrator** and nothing else | The user's requirement is "a fresh client deployment has only one admin, every other row created through the app's own flows". StockRidge satisfies it by construction rather than by preservation. |
| `pruneLoginAttempts(90d)` | `NEVER_PRUNED` includes `login_attempts`, with a written rationale (forensic value; growth is a few rows per staff per day) | **Revised in G1**: an unbounded auth log is still unbounded. G1 adopts a window (90 days, matching PharmaRidge) and keeps the reasoning in the comment, so the trade-off is a decision on record rather than a gap. |
| `prescriptions`, `nafdac_catalog`, `controlled_substance_register` | absent | Pharmacy-specific. StockRidge's verticals make the **analogs** the requirement: `serials` (a phone's IMEI is PharmaRidge's batch number), `stock_batches` + `has_expiry`, `warranty_claims`. Nothing to port; see §4 for the one *safety* idea worth borrowing — recalls. |
| `PUT /api/settings/manager-permissions` | `FLAG_SETTINGS` in `domain/planLimits.js` — 19 owner-editable switches including `managers_can_void_sales`, `staff_can_adjust_stock`, `staff_can_spend_from_safe` | Already covered, and broader: the switches live in settings and the API already honours them. |

---

## 3. Capabilities the schema declares that nothing uses yet (StockRidge's own list)

`npm run verify`'s capability audit records 7 real gaps (plus one rebuild artefact). Each is a
table with a purpose and no code path that creates a row — i.e. a capability that exists on paper.
This list is the "fully utilise the schema" work, and it overlaps the parity list above.

| Table | What it is for | Stage |
| --- | --- | --- |
| `data_cleanup_log` | a record of housekeeping runs | **G1** |
| `pending_user_transfers` | a transfer the receiving manager must accept | **G3** |
| `user_assignment_history` | "who could see the Minna till on 14 March?" | **G3** |
| `branch_compliance_records` | permits per branch (SON/SONCAP, fire, weights & measures) with expiry | **G5** |
| `delivery_zones` | delivery fee and minimum order by area | **G6** |
| `delivery_vehicles` | vehicles and riders, so a job can be assigned and its cost traced | **G6** |
| `stock_transfer_serials` | the serials that moved with a transfer, so a warranty claim is traceable | **G6** |
| `product_recalls` | which products, which batches, what came back | **G7** |

---

## 4. Not in PharmaRidge, and it must be in StockRidge

These are capabilities with **no PharmaRidge counterpart** that a Nigerian multi-vertical retail
business needs. Each is listed with its justification, and those already built are marked so the
list is also a record of what is done.

**Already built (PharmaRidge has no equivalent):**
* **Four verticals** — electronics/appliances, furniture, and their unit ladders, variant and
  serial rules; PharmaRidge is single-vertical by design.
* **Offline-first PWA with a real sync engine** — outbox, per-device status, conflict resolution
  with a server-wins default, idempotency on 22 money endpoints. PharmaRidge's offline support is
  narrower (a buy/queue path), and it has no `sync_conflicts` resolution UI.
* **Serial/IMEI tracking, warranty claims, installation jobs** — the service side of durable goods.
* **Multi-business, per-branch price overrides, branch-scoped device registration.**
* **Nigeria-specific compliance** — VAT 7.5%, WHT with 2024 Withholding Regulations rates, FIRS/TIN/CAC identity, cash-over-and-short, MOBILE_MONEY/POS/transfer till methods.
* **Audit discipline as a product feature** — 7 audits, negative controls, live runs against the
  deployments a client uses.

**Must be built (no PharmaRidge equivalent, schema or requirement backing it):**
* **Bulk import for onboarding (G8).** Every export exists; there is no import. A shop moving from
  a paper book has 200–2,000 SKUs; typing them in is the single most likely reason a deployment
  stalls. Products (with unit ladders), customers and opening stock, as CSV, with a dry-run that
  reports what each row would do and what it would reject.
* **A recall/withdrawal flow (G7).** PharmaRidge's `controlled_substance_register` is a *safety*
  pattern, and its equivalent for durable goods is a recall: which product, which batch or serial
  range, which branches hold it, what came back. `product_recalls` is already in the schema.
* **Delivery zones and vehicles (G6).** `delivery_jobs` exists and takes a fee the operator types;
  zones with a fee and a minimum make the fee a rule instead of a habit, and vehicles make "who is
  delivering, at what cost" answerable.
* **Permits with expiry (G5).** `v_compliance_expiry_alerts` already exists and the cron already
  raises alerts from it — but `branch_compliance_records` has no write path, so the alerts have
  nothing to fire on.

---

## 5. The staged plan (one checkpoint each, pushed as it lands)

Ordered so that each stage is independently useful and independently provable, and so that the
user-named feature (data management) is first.

| Stage | Scope | Acceptance |
| --- | --- | --- |
| **G1a** | Retention: `server/lib/retention.js` (sync log 90d, reviewed conflicts 180d, login attempts 90d, unreviewed conflicts never), wired into the cron; `housekeeping` reports each count | an integration test proves an aged row is pruned and a fresh one is not, for every statement |
| **G1b** | `GET /api/data-management/status` (capacity estimate, plan limit, what a purge would remove, recent runs) + `POST /api/data-management/purge` (5 modes, per-mode phrase, `export_confirmed`, `retention_acknowledged`, OWNER/ADMIN only, atomic batch, `data_cleanup_log` row, offline-replay quarantine) | `test/audit/audit.data.js`: status readable by owner, purge refused without the phrase / without both acknowledgements / for a manager; purge executes with them, logs one row, and the log is readable afterwards |
| **G1c** | The screen: capacity and retention on the Plan screen, owner-only guarded purge behind the phrase, wired to the endpoints | front-to-back probe: every new endpoint is called by a screen; back-to-front: every call the screen makes is asserted |
| **G2** | Change owed: list, claim by code, settle, write off, expiry surfacing; dashboard card | audit: a sale's change is settled once, a second settle is refused, write-off needs a reason |
| **G3** | Staff transfers pending acceptance + assignment history | audit: a transfer is invisible until accepted, the receiving branch decides, history answers "who could see what, when" |
| **G4** | Dashboard: void audit, unreconciled cash, branch breakdown | audit: each widget's numbers reconcile with the underlying tables |
| **G5** | Branch permits CRUD, feeding the expiry alerts that already exist | audit: an expiring permit raises an alert, a renewed one clears it |
| **G6** | Delivery zones, vehicles, transfer serials | audit: a delivery fee comes from the zone, not from typing |
| **G7** | Recalls: open a recall, list affected stock by branch/serial, record returns | audit: a recalled serial cannot be sold |
| **G8** | Bulk import (products, customers, opening stock) with a dry run | audit: a bad row is named with its line number and nothing is written until the run is confirmed |

Each stage ends with: the audit green locally **and** on staging, `npm run verify` green, the
deployments carrying it, a `STATUS.md` checkpoint, and a push. Nothing is marked done in this
table until all five of those are true.
