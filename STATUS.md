
## P5 — who was at work, and what the shop is licensed to do (2026-10-06)

`test/audit/audit.staff.js` — **26/26** — works a full day of attendance and opens the
compliance register for a branch. Attendance **8/8** and compliance **7/7** are now exercised
by a live audit; coverage overall is **134 of 196 routes** (was 119 after P4, 88 before P2).

### One production defect, in `POST /api/attendance/clock-in`

The route registers a first-seen machine as a PENDING device "so the manager can approve it
once instead of every shift" — and the guard that does it compared
`classification.deviceStatus === 'UNREGISTERED'`. **That value does not exist**: the classifier
answers `REGISTERED` / `UNRECOGNIZED` / `NOT_APPLICABLE` (`domain/geofence.js:67`), and the
string `UNREGISTERED` appears nowhere else in the product. The branch was dead code, so:

* the machine that clocked somebody in every day **never appeared on the device list**;
* no manager could ever approve it, because there was nothing to approve;
* on a branch set to REGISTERED_DEVICE mode — where the till itself is the credential — every
  shift from that machine was flagged **for ever**, which is precisely the outcome the comment
  says the code prevents. A flag nobody can clear is a flag everybody learns to ignore.

Found by the audit looking for the pending device it had just clocked in from and finding an
empty list. Fixed to compare against `DEVICE_STATUS.UNRECOGNIZED`, and the audit now proves
both directions: an unknown machine is flagged and listed as PENDING, approving it makes the
next clock-in clean, and a clock-in kilometres away from an *approved* machine is still caught
by the fence.

### What else the two flows prove

* **Attendance:** a fence that cannot be right is refused and moves nothing (`IMPLAUSIBLE_COORDINATES`);
  a clock-in at the shop is recorded, placed (`ON_SITE`, distance inside the fence) and **not
  flagged**; a second clock-in while on shift is refused; the day's board counts who is in,
  who is still in, who is out and **names who is absent**; a STAFF seat cannot review its own
  shift (`ROLE_REQUIRED`), a rejection with no reason is `MISSING_FIELD` and with a two-letter
  one is `REASON_REQUIRED`; an accepted review records **who** and **when** and leaves the flag
  in place (the flag is "something looked odd", the review is "a person looked"); clocking out
  with no open shift is `NOT_CLOCKED_IN`.
* **Compliance:** the checklist names what the vertical requires (ELECTRONICS: eight types) and
  reports the missing ones — `MISSING` is deliberately not a row in the register; a recorded
  licence reads back `EXPIRING` inside the window with its days-to-expiry, and the alert list
  and its `counts` carry the same fact; renewing it moves the register, clears the alert and
  reduces the checklist's missing count **by one**, together; a manager **cannot** file a
  licence against a branch they do not run (and can file one against their own without naming
  it); backwards dates and a second live record of the same type are refused by name; a
  staff member may read the register and not write to it; a mistake can be removed (soft, and
  once); and the expiry notifier raises each alert **once**, not every time it runs.

---

## P5 — THE LIVE LEG, AND WHAT IT COST TO RUN AN AUDIT ON SOMEBODY ELSE'S DEPLOYMENT

**Staging: `audit.staff` 29/29 in 13.3 s.** Local is 0.9 s, staging is 13 s, and the difference
is a network round trip per call — the same run, the same checks.

The live leg is the reason this stage took three attempts, and every failure was the audit's,
not the product's. They are worth writing down because **they are the class of mistake that
makes a live audit dangerous rather than merely slow**:

### 1. It changed a branch it did not create

Locally the fixture owns its branch. On a live deployment it does not — the harness only
creates the fixture's *business* locally, so `branches[0]` was another audit's fixture branch
(`Roles Second Branch yfo3`). P5 set that branch to `REGISTERED_DEVICE` mode with a 200 m fence
and walked away. **From then on every shift clocked in at that branch would have been flagged
at the door** — a shop's tills turned into an alarm by an audit that had finished.

Fixed in the harness, not the audit: `d.trackRestore(label, undo)` records anything an audit
*changes* (as opposed to creates), and `close()` runs the restores in reverse order and prints
how many succeeded. The staff audit reads the branch's attendance settings before touching
them and puts back mode and radius (the route cannot un-set coordinates — `null` keeps what is
stored and `(0,0)` is refused as an unset GPS — so that limitation is named in a note instead
of being hidden).

**And the restores run *before* the fixtures are retired.** The first version ran them after,
so the licence removal authenticated as a deactivated user and came back refused: the one
restore that mattered failed silently while the run still printed "left the live deployment as
it was found".

### 2. It filed licences on a shared register and left them there

A licence left behind is not inert: the next run's filing was refused as
`DUPLICATE_RECORD_TYPE`, and the check that wanted a *free* licence type had nothing to file.
Every record this audit files is now named `AUD-*`, the run **sweeps its own leftovers at the
start** (so it heals instead of depending on the last run having succeeded), and what it files
is removed when it ends. Five legacy licences from the earlier attempts were swept off staging
by hand; the register now holds none.

### 3. The money and WHT audits flipped the client's VAT switch and never put it back

Same class, found by looking for it after the branch bug. `PUT /api/settings {vat_enabled:1,
vat_rate_percent:7.5}` was left in place on a live deployment — a quiet change to a business's
tax position — and `PUT /api/businesses/:id {vat_registered:true}` likewise. Both now capture
what the shop had and restore it; the VAT-off check restores to the **captured** value rather
than to "on", which is what it used to do.

### 4. Three readers that only break against a deployment other people use

* "Today's board shows who is in": asserted the deployment-wide `completed` count was zero and
  reported a defect because earlier runs had closed their own shifts. It now asserts about
  *this run's* shift being open, and that the board's `clockedIn` agrees with the rows it lists.
* The device id was a fixed name (`audit-staff-phone`), so on staging the "stranger" machine had
  already been approved by the previous run and was correctly not flagged. It is unique per run
  now, like the usernames and phone numbers always were.
* Every clock-in now closes first and ignores the 409, so a failed check earlier in the run
  cannot leave a shift open and turn a later check red for the wrong reason.

### Deployment

The P5 build (the `DEVICE_STATUS.UNRECOGNIZED` fix) is now live on **staging, sample and
production** — sample and production were still running P4. All three report `ready`
(staging) / `awaiting_first_business` (sample, production, the expected handover state).

### Counts at this checkpoint

`npm run verify` **395/395/0** · `bash test/run-audits.sh` **16 audits green** (staff **29**
checks now) · flow coverage **196 routes · 135 audited · 45 screen-only · 16 unreached** ·
staging left with **0 audit-made licences, 0 `AUD-*` leftovers, the branch at GEOLOCATION
150 m, and the `stf-*` seats retired**.

Next: **P6 — warranty-claims (0/3)**, then reports 8, audit 3, notifications 3; parity **G4
dashboard depth** still open.

---

## P6a — THE SERIAL REGISTER HAD NO WRITER, SO NOTHING DOWNSTREAM EXISTED

**The stage set out to audit warranty-claims (0/3) and found that no claim could exist.**

`POST /api/warranty-claims` needs a serial number on file. `serial_numbers` had **no writer
anywhere in the server** — not goods-received, not a purchase-order receipt, not a transfer
receipt. The only INSERTs in the whole repository were in an integration test. Consequences, all
live until this stage:

* **A serial-tracked product could not be sold at all.** The sale engine demands one serial per
  unit and refuses any number "not in this system", so a freezer or a phone flagged
  `requires_serial` could be received as anonymous quantity and then never rung up.
* **`serial_tracking_enabled` — "Capture serial numbers for products that track them" — was
  shown to every administrator and read by nothing.** Switching it off changed nothing, and
  switching it on changed nothing either.
* Everything hanging off a serial was consequently dead: `GET /api/serials/:serialNo`, the
  hash-chained `serial_events` log (whose only writer was the sale, so a unit's history started
  at "SOLD" with no record of arriving), warranty claims, replacement serials, and the
  `stock_transfer_serials` table.

### What was built

* **Serials are captured at goods-received** (`POST /api/stock/receive`), which is the only
  place a unit enters the system: one number per unit, required when the product is flagged and
  the feature is on, with the batch, branch and product filed against it. Refusals name the
  thing that is wrong: `SERIALS_REQUIRED` (with the count expected and given),
  `DUPLICATE_SERIAL_IN_REQUEST`, `SERIAL_ALREADY_RECEIVED` (409, naming where the unit already
  is), `SERIALS_NOT_EXPECTED` (serials on a product that does not track them). A serial already
  on file against a *different* product is a warning, not a refusal — two brands can share a
  number across a counter, and a copied label is worth knowing about either way.
* **An IMEI rides along** — plain strings or `{serial_no, imei}`, because for a phone it is the
  second identity the networks and the police ask for.
* **The first link of each unit's chain is written** (`serial_events` → `RECEIVED`), hashed with
  the same `serialEventFields` shape the sale uses and chained off whatever head the serial
  already has.
* **The register has a face**: `GET /api/serials` lists units with their batch, expiry, sale,
  customer, claim and warranty clock, filterable by product, batch, status, sold/unsold,
  in-warranty and a search of serial, IMEI, product or customer — with the counts a shop asks
  for after its first receipt with serials (total, unsold, sold, in warranty).
* **The switch controls both halves.** With `serial_tracking_enabled` off a flagged product is
  received *and sold* as ordinary stock; with it on, both demand the numbers. Off in one place
  and on in the other is the trap this was before.
* **The receiving form grew a serials box** that appears only for a serial-tracked product and
  says how many numbers the receipt will be refused without.

### Two more real defects, found on the way

* **`GET /api/serials/:serialNo` could only fail.** It joined `businesses biz ON biz.id =
  sn.business_id`, and `serial_numbers` has no `business_id` column: `500 no such column`, every
  time, for every serial. Fixed to reach the business through the branch.
* **An unknown serial was a 500, not a 404.** The route then read `.warranty_ends_at` off
  `undefined`, so "we have never seen this unit" — the answer a counter most needs, for a
  parallel import or a mis-typed label — came back as an internal error. It is a 404 with a
  sentence now.

### Also fixed so the audit can be read

* `tools/capability-audit.js` no longer reports a SQLite table rebuild's scratch name as "a
  capability that exists on paper only" — a name the same file drops or renames is scaffolding.
  `branch_sync_status_v2`'s baseline entry is gone with it, so the baseline is a to-do again
  instead of a place to bury noise.
* `AUDIT_SERVER_LOG=1` prints the audit child's server log, which is where a failing statement
  is named; without it a 400 on a constraint says only "a required value is missing".

**Counts:** `npm run verify` **395/395/0** · `bash test/run-audits.sh` **17 audits green**
(new: `audit.serials`, **24 checks**) · coverage **197 routes · 138 audited · 43 screen-only ·
16 unreached**, serials 2/2.

Next: the other two intakes (purchase-order receipt, transfer receipt) so a shop that buys on a
PO is not half-covered, then **the warranty-claims audit** — the flow this stage cleared the way
for, and the one that will exercise migration `0007` (the resolutions the schema refused).

### P6a (continued) — the second intake, and the drift that would have followed

Appliances are bought **on a purchase order**; the direct goods-received route is for a load
that arrives with no paperwork. Serial capture went into the direct route first, which left the
ordinary path still unable to register a unit — the same dead end, one route over. Rather than
copy the rules, they now live in **`server/services/serialsService.js`** (`parseSerials`,
`acceptSerials`, `planSerialRows`, `serialStatements`) and both intakes call in, so the two
cannot drift apart again. The PO receipt also answers with `serialCount` and the numbers filed,
and warns when a serial-tracked line arrives with the switch off.

`audit.serials` now proves both intakes: **27 checks**, including a PO receipt with no serials
(400 `SERIALS_REQUIRED`), the same order received with them (both units in the register, at the
right branch, each with one link in its chain).

**Counts:** `npm run verify` **395/395/0** · **17 audits green** · serials **27 checks**.

### P6b — WARRANTY CLAIMS, 0/3 → 3/3, AND THE SECOND DEFECT BEHIND THEM

The flow the stage set out to audit. With a writer in the register it is reachable at last, and
`audit.warranty` (**26 checks**) works it end to end: three appliances sold, one repaired, one
replaced, one refunded, one with no cover at all.

**FRONT TO BACK** open a claim → it is on the board with the unit, the customer and the receipt;
the unit's own record carries the claim reference and its status. Repair it → closed with the
cost and the recovery **kept apart** (`netCost` zero for a claim that costs what it recovers),
and both posted to the books (5200 up ₦40,000, 1200 up ₦40,000, trial balance still balanced).
Replace one → the returned unit goes `TRANSFERRED` and the replacement **inherits the remaining
cover** rather than restarting it. Refund one → the original sale carries the annotation.

**BACK TO FRONT** the closed board, the in-warranty filter, search by claim number and by serial,
the unit's lookup, the trial balance, the sale.

**AND THE REFUSALS** a serial nobody has seen (`404 SERIAL_NOT_FOUND`, offering a paid repair),
a fault a supplier cannot act on, an unrecognised resolution, a rejection with no reason, a
recovery larger than the cost, a recovery with no supplier reference, and a second resolution
(`409 ALREADY_RESOLVED`).

#### The defect this found

**Migration `0007`** rebuilds `warranty_claims` because the API and the schema spoke *different
vocabularies*: the route validates `REPAIRED/REPLACED/REFUNDED/REJECTED/SUPPLIER_RETURN/
PAID_REPAIR` (and the screen offers exactly those), while the table's CHECK permitted
`REPAIR/REPLACE/REFUND/REJECT/OUT_OF_WARRANTY`. **Not one value was in common**, so every
resolution the route accepted died inside its own transaction on `CHECK constraint failed` and
reached the manager as `400 CHECK_FAILED`. The resolution half of warranty — the repair, the
replacement, the refund, and the supplier recovery that pays for it — had never once run. SQLite
cannot alter a CHECK, so the table is rebuilt in place, with the old words mapped onto the new
ones so a row that somehow exists arrives intact rather than aborting the migration.

That is now **three** values-that-exist-nowhere defects in this product (P5's `UNREGISTERED`, the
claim vocabulary, and the settlement below). Each was a string compared or written in one place
and recognised in none.

#### And a guard that contradicted its own message

`POST /api/warranty-claims` refused a fault description under **8 characters** — while the
message beside it said "in at least a sentence. **'Not working' cannot be assessed by a
supplier**". "Not working" is eleven characters, so the one example the message names as
unusable passed. The screen was worse (4 characters) and said the same thing. Both now require
what a supplier actually needs to act: **three words and twelve characters** — what the unit
does, and when it started.

#### Counts

`npm run verify` **395/395/0** · `bash test/run-audits.sh` **18 audits green** (serials 27,
warranty 26) · coverage **197 routes · 141 audited · 40 screen-only · 16 unreached**, with
**warranty-claims 3/3** and **serials 2/2**.

### P6a/P6b — THE LIVE LEGS

Both new audits run against **staging** in write mode and pass:

| audit | local | staging | left behind |
| --- | --- | --- | --- |
| `audit.serials` | 27 checks, 0.9 s | **27 checks, 14.4 s** | 2 seats retired, 3 settings put back (both products retired, the serial-capture switch restored) |
| `audit.warranty` | 26 checks, 0.9 s | **26 checks, 13.9 s** | 2 seats retired, 2 settings put back (both products retired) |

**Migration `0007` was applied to all three environments** by the deploy itself — staging, sample
and production all report `ready` / `awaiting_first_business` and all three now carry it.

*One flaw fixed before the live run, and it was the live run's fault that I saw it:* the register's
`counts` were computed **without** the filters on the list, so `GET /api/serials?product_id=X`
would have answered three rows of one product beside a deployment-wide count. On a fresh database
the two agree by accident; on staging (nine serials from other runs) the audit would have read
"the register disagrees with itself". The counts now follow the same `WHERE` as the list.

**What the live runs left on staging, said plainly:** 9 serial numbers in the register, 4 closed
warranty claims, and the stock/sales behind them. This is *history the product deliberately does
not delete* — a serial is evidence, and a claim that was resolved is a fact about a customer — so
the audit retires what it can (both products, both customers, all four seats, every setting it
touched) and reports the rest instead of pretending. Sample and production have no such debris:
nothing was written there.

**The sweep item is now larger and is worth doing properly:** staging carries `http-*`, `audit-*`,
`rtn-*`, `dep-*`, `ful-*`, `stf-*`, `ser-*`, `war-*` fixtures across users, businesses, customers,
products, serials and claims. A `--clean` pass that retires fixture ROWS (never history) belongs
in the deploy tooling.

### Where the coverage stands now

**197 routes · 141 audited · 40 screen-only · 16 unreached.** Every flow at 100%: **warranty-claims
3/3**, **serials 2/2**, attendance 8/8, compliance 7/7, returns, deposits, instalments, deliveries,
products. Next by size: **reports 8**, then audit 3, notifications 3, suppliers 2/5, stock 4/7,
transfers (including `stock_transfer_serials`, which the capability baseline still lists as
WIRE UP — a serialised unit moved between branches is not yet traceable), and parity **G4
dashboard depth**.

---

## P7 — REPORTS, 0/8 → 8/8, AND TWO DEFECTS THAT WERE PRODUCING WRONG NUMBERS

Eight routes, the largest flow with no audit, and the one where being wrong is quietest: a report
does not throw and does not look broken when it is wrong. It answers 200 with a figure and somebody
orders stock on it. So `audit.reports` (**31 checks**) does not test that the routes answer — it
tests that they **agree**, with the trade the run can see and with each other.

**FRONT TO BACK** three sales rung (one voided), a damage write-off, an expense, a target set.
**BACK TO FRONT** every report held against that trade: revenue, cost and margin per product; the
void excluded from the takings *and* counted separately; units in, units out and units left on the
shelf reconciling; the write-off on the shrinkage report with its value; the product absent from
dead stock; the debtor's balance; commission on **net** revenue; the target's attainment against
what that seat actually sold. **AND EACH OTHER** the download must equal the screen, and the
commission report's revenue must agree with the sales report's for the same period.
**AND THE REFUSALS** unknown group-by, mover kind and export name; a staff member setting a target;
a target that measures nothing; a period ending before it starts. **AND THE SCOPE** a cashier at
another branch sees none of this branch's takings — in the reports *or in the CSV*.

### Two defects, both of which produced wrong figures for real users

**1. The movers report counted sales that never happened.** Its sale *lines* were joined to the
product before the sale was, and both joins were `LEFT` — so the filters (not voided, inside the
period) applied only to the `sales` side, and a voided sale's line stayed in the result with a NULL
sale beside it. `audit.reports` rang three sales, voided one, and the fast-mover report said **6
units against 5**. A product whose only sale was voided would have appeared as a *fast mover*, and
every figure in that report — revenue, cost, margin, days of cover — was inflated by voided sales
and by sales outside the requested period. Fixed by joining the sale first and its lines second.

**2. Every CSV export could shift its columns.** Rows were written with `Object.values(row)` — and
a result row is an object, so **two columns with the same name collapse into one key**, dropping a
column and shifting every heading after it left by one. Two exports did exactly that:

* `SALES_DETAIL` selected `b.name` (branch) and `v.name` (variant): **15 headings, 14 values** —
  "Base qty" showing the unit price, "Cost" showing the line total, "Margin" showing nothing.
* `DEBTORS` selected `c.name` (customer) and `cc.name` (class): the **customer's name came out
  empty** and the credit limit printed under "Balance".

An accountant opening either file reads the wrong numbers out of it, and this is the export that
gets filed with FIRS. The exports now declare their columns by name, aliases make every name
unique, and a heading with no value behind it **fails the download** instead of writing a quietly
wrong file.

Also fixed: the audit harness now returns the response **bytes** as well as the decoded text, so a
byte-order-mark check tests the file rather than the text decoder (which strips a BOM by standard).

### Counts

`npm run verify` **395/395/0** · `bash test/run-audits.sh` **19 audits green** · coverage
**197 routes · 149 audited · 32 screen-only · 16 unreached**, with **reports 8/8**, warranty-claims
3/3 and serials 2/2.

### P7 — THE LIVE LEG, AND THE ONE DEFECT THAT WAS THE AUDIT'S OWN FAULT

`audit.reports` **31/31 on staging in 13.3 s** (local 0.9 s), leaving 2 seats retired and 3
settings put back. **All three environments now run the P7 build.**

The first live run failed seven checks, and **not one of them was the product's fault**:

* **The reports resolve the branch from the caller when the request names none.** Correct for a
  cashier, wrong for the audit: on staging the administrator's resolved branch is `Verify Branch`,
  but the fixture trades at `branches[0]` — another audit's branch. So every read reported on a shop
  this run never traded in. Locally the two coincide, which is exactly how a live-only false failure
  is born. Every read now names the branch it traded at.
* **A receipt number is not an identity.** Receipts are numbered per branch, so `000003` at
  `Verify Branch` is somebody else's sale — which made the export look like it carried a
  still-COMPLETED version of the voided sale, and made the cross-branch leak check report a leak
  that was not there. Rows are now identified by the customer and the SKU, which this run owns.
* **The leak check names no branch on purpose.** Pinning it would make the product refuse a scope
  violation and the check would pass without proving anything — it asks what a cashier at another
  shop sees *by default*.

### What the live run left behind, and the sweep this makes necessary

The staging runs have now written: a product, stock, sales, a void, an expense, a target, a
customer, 9 serials with their claims, and stock/sales behind all of it — **across branches that
belong to other audit fixtures**, because a live deployment has no branch that is "the audit's own".
Everything the audits can retire, they do (products, customers, seats, targets, every setting). The
rest is history the product deliberately keeps, and the expense rows sit on another fixture's branch.

That makes the `--clean` pass a **real** item rather than a tidy-up: it needs to retire fixture
ROWS by the marker the fixtures already carry (`audit-*`, `AUD-*`, `rtn-*`, `dep-*`, `ful-*`,
`stf-*`, `ser-*`, `war-*`, `rpt-*`, `PROBE-`, `AUDIT-`), never touching history a shop created.
