
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

---

## P8a — THE ADMINISTRATOR'S POWERS: WHAT THE SERVER WOULD LET A CLIENT DO TO ITSELF

Analysed in `docs/admin-flows-parity.md` (PharmaRidge's admin model read out of the 49,952-line
reference, this repo read route by route). Two of the findings were defects, not gaps.

**1. A client owner could rewrite their own commercial terms.** `PUT /api/settings` is guarded by
`atLeast(user.role, 'OWNER')`, and the six settings that decide what the client has bought — the
three caps, the plan name, the subscription status, the renewal date — were writable through it like
any other column. An owner could raise their own branch cap, rename their plan, set their status
back to `ACTIVE` after a suspension, or move their renewal date — with a queued offline write if a
plain call was too visible. The screen has always drawn these read-only and said why
(*"commercial: … not by the client"*), so **the UI was stricter than the API**. Hiding a field is not
a permission: the route now refuses any of the six from a non-`ADMIN` caller with
`403 PLATFORM_ADMIN_REQUIRED`, naming the fields and the contact line, and changes nothing.

**2. The vendor's bypass was written and never wired.** `assertSubscriptionActive` returns early for
`ADMIN` — *"the vendor can never be locked out of their own client's instance, including while
helping that client resolve the very suspension in question"* — and **all three call sites passed
only `settings`**, so `user` was undefined and the bypass could never fire. A suspended client could
not even be helped by the person they had just telephoned. The caller now goes in.

**And the meaning of a zero.** `plan.js` has always rendered a cap of 0 as **"Unlimited"**; the
enforcement read `Number(settings.max_* || 0)` and threw on `used >= max`, so 0 blocked everything
and the refusal read *"includes 0 branches"*. The screen's reading wins (`capValue`), because an
accidental lock-out stops a shop trading while an accidental zero costs a support call.

Also in this stage: a cap set **below current usage** is allowed and reported (`warnings[]`, not a
refusal — nothing is removed, but the next person to try a create reads "all 4 are in use" beside a
cap nobody chose); `subscription_status` is validated against the schema's four values (a typo
previously behaved exactly like a deliberate suspension, silently); the renewal date is a date or
null, never `''`; a blank plan name is refused because the name is printed in every cap refusal the
client sees; and a plan change now records **`PLAN_LIMITS_CHANGED`** — an allowed audit action that
nothing had ever recorded — instead of hiding inside `SETTINGS_UPDATED`.

### Verified

`npm run verify` **410/410/0** (395 before — 15 new checks in `test/integration/platform-admin.test.js`)
· `bash test/run-audits.sh` **19 audits green** · the settings contract test now also asserts that
the keys the route reserves for the administrator and the keys the screen refuses to draw are the
same list.

**Still open, in order:** P8b the subscription gate on trading writes (today a suspended shop keeps
ringing sales — the gate only covers creating businesses, branches and staff); P8c the **Platform**
screen and the notifications board (the notification engine writes messages no screen can show or
dismiss); P8d `audit.platformAdmin.js`, two-way, on staging.

---

## P9 — THE DASHBOARD WAS READING TEN NAMES THE SERVER DOES NOT SEND

`/api/dashboard` answers with `debtors.totalOwed`. The dashboard read `debtors.total`.
Neither throws. `undefined` renders as "₦0" through `U.money`, as "—" through a fallback
chain, or as an empty string — so the tile said **"Owed to us ₦0" to every shop, however much
was owed**, and looked exactly like a quiet morning. Ten of these, read out of the two files
side by side:

| the screen read | the server sends | what it showed |
|---|---|---|
| `today.periodGross` | `period.grossRevenue` | **"Sales this period" printed the COUNT of sales with a naira sign** — ₦4 where the shop had taken ₦34,000 — because the fallback was `today.sales` |
| `today.vs_yesterday_pct` | `today.vsYesterday.changePct` | "up 12% on yesterday" had **never once** appeared |
| `debtors.total` | `debtors.totalOwed` | **"Owed to us ₦0" for every shop** |
| `debtors.overdue` | `debtors.likelyBad` / `overdueInvoices` | money genuinely at risk never took the colour that asks for action |
| `cash.till \|\| data.till` | `cash.myTill` / `cash.openTills` | **the drawer card said "No till is open" to a cashier with a till open in front of them** |
| `till.opening_cash`, `till.cash_sales_total` … | `openingCash`, `cashSales`, `expectedCash`, `saleCount` | snake_case against a camelCase payload |
| `b.revenue \|\| b.gross` | `b.period.gross` | **every "By business" and "By branch" bar was zero-length** |
| `a.message`, `a.kind`, `a.path` | `a.label`, `a.severity`, `a.route` | **the whole "Needs attention" card**: blank second line, no severity, every row navigating back to the dashboard |
| `usage.branchesPct`, `plan.maxBranches` | `plan.branches.used / .allowed` | **the "your plan is nearly full" warning never fired** — a client learned they had run out of seats when they tried to hire |
| `stock.stockValue ?? stock.atCost` | `stock.atCost` | worked *because* the first name does not exist. Off by a hidden fallback is still off |

Also on this screen: the "Needs attention" list was built **twice** — the screen's own low-stock and
overdue rows plus the server's `actions` — so two problems appeared as three rows, two about the same
shelf. The server's list owns it now (it knows about expiring batches, till variances, expenses,
deliveries, devices and flagged clock-ins; the screen knew about two of those).

### The wrong number that was worst, and was not on the dashboard

`U.soldAt()`/`U.soldDate()` rendered a sale's WAT stamp by converting it to a true instant first, so
**every sale time in the app — the sales list, the warranty date, and the time on every printed
receipt — read an hour early** while the column header said "Date (WAT)". Fixed at the three display
sites. The arithmetic use is deliberately left alone and now documented: `minutesSince()` compares a
wall clock against `Date.now()` to decide what falls inside the **staff void window**, and removing
the shift there would silently stretch the window by an hour.

### The guard, so this cannot come back

`test/unit/frontend-wire.test.js` extracts every `<alias>.<field>` read out of a view, boots a real
deployment, calls the real route, and fails the build for any read the response does not answer —
proved by mutating `debtors.totalOwed` back to `debtors.total` and watching it fail with
`server has no "debtors.total"`. It also pins the money helpers (no ₦NaN, `amount()` carries no
symbol) and the display-versus-arithmetic split for sale times.

### `npm run db:reset` was broken, and nothing ran it

The documented first command for a new developer, and the source of the sample deployment's data,
**aborted part-way with a CHECK constraint failure**:

```
Error: CHECK constraint failed: resolution IS NULL OR resolution IN
  ('REPAIRED','REPLACED','REFUNDED','SUPPLIER_RETURN','PAID_REPAIR','REJECTED')
```

Migration 0007 rebuilt `warranty_claims` around the six outcomes the resolve route accepts and
converted the rows that existed — **and left the seeder writing the four old nouns**
(`REPAIR`/`REPLACE`/`REFUND`/`REJECT`). Not one of them is in the new set. The seeder now speaks the
schema's vocabulary and pairs outcome with status the way `POST /:id/resolve` does (resolved ⇒
`CLOSED` + outcome, rejected ⇒ with the written reason the route insists on). `test/integration/demo-seed.test.js`
now runs the real seeder into a temporary database and holds it to the product's own arithmetic
(`total = subtotal − discounts + delivery`, VAT-inclusive) — the check that first reported 83
mismatches in a database that was entirely correct, because my first assertion was a guess at the
arithmetic rather than the product's.

The demo also **shipped over its own plan**: four businesses and six branches against a settings row
allowing three and five, so every demo deployment opened on "your plan is nearly full — 6 of 5
branches". The seed now sets caps that fit what it creates. When a real client *is* over a cap the
banner says so properly — "6 branches in use against a plan limit of 5 … the next one will be
refused" — instead of the "6 of 5" that reads as arithmetic gone wrong.

### Icons and naira

KPI tiles carry an icon now (`ui.kpi({ icon })`), drawn from the same vocabulary as the sidebar so a
row about expiring stock carries the calendar the Stock screen uses; the action rows pick their
glyph per action key, and the empty drawer uses the cash mark rather than a padlock. On the naira
question: the sweep found **no doubled symbol anywhere**, and every `(₦)` label is a bare number
input where the unit belongs — the one place the symbol appeared where it was not meant to be was
exactly the "Sales this period" tile printing a **count** as money.

### Verified

`npm run verify` **421/421/0** (416 before) · `bash test/run-audits.sh` **19 audits green** · the
whole frontend rendered in jsdom against a live local server: **27 destinations, every screen draws,
no faults** — Dashboard / Sell / Till / Sales / Catalogue / Stock / Stocktake / Transfers / Purchase
orders / Suppliers / Expenses / Customers / Change owed / Instalments / Deliveries / Returns /
Attendance / Staff / Accounting / Reports / Branches / Businesses / Subscription / Settings /
Audit trail / Compliance / Sync.

### Two screen/branch misalignments the walk found, carried forward

The owner holds six branches, so **Till & safe** and **Stock** render "That failed. Choose which
branch this applies to" as an error block under an "All branches" heading. The server is right to
refuse a branch-less read (`400 BRANCH_REQUIRED`); the screens are wrong to offer the scope and then
report a failure — they should ask for the branch the way the rest of the app does. That is the next
UI/UX alignment item, with the Platform screen (the administrator's own controls, which still have
no UI) and the notifications board.

---

## P10 — THE ADMINISTRATOR'S POWERS REACH THE SCREEN (P8c, first half)

P8a made the six commercial settings `ADMIN`-only at the API. That closed the hole and left a
stranger one beside it: **there was no way to set a client's plan from the product at all.** The
client's own screen hid the fields on purpose, no other view drew them, and the vendor's only route
to them was a hand-made HTTP call. A power that needs `curl` is not a power anybody uses.

The Subscription screen now draws a **Platform controls** card for the `ADMIN` role — the three caps
(each reading "0 means unlimited"), the plan name, the status select and the renewal date — saving
through `PUT /api/settings`. It sends **only what changed**, because the server audits every field it
receives and a plan change recorded as six fields when one moved is a trail that hides the one that
mattered. What comes back is kept on screen rather than flashed in a toast: the server's
`warnings[]` when a cap lands **below the usage already on the books** (nothing is removed, but the
next create will be refused, and the person who set the cap should be the one who knows why), and on
refusal the fields it named.

For everyone else the screen says where the plan comes from — *"These limits are set for you. Nobody
at the shop can change them — not even the owner — because a limit its own subject can raise is not a
limit."* That line sits in **What is in use** rather than the "Who to call" card, because that card
is only drawn when contact details have been filled in, and an explanation that disappears is worse
than none. (The tool caught exactly that: the sentence was invisible on a deployment with no contact
configured, which is how the sample ships.)

The usage bars now follow the server's own reading of a cap — `usage.branches.unlimited` — rather
than re-deriving it from `maxBranches === 0`. Two places deciding what a zero means is how the screen
and the enforcement drift apart; asking the server is how they cannot.

### Driven from both sides, in a real DOM

`tools/frontend-platform.js` — **19 checks, green** — boots the real frontend against a running
server as both seats:

* **ADMIN**: the Platform controls card is drawn; every commercial setting has a control; changing a
  cap moves **what the server enforces** (verified by asking the server, not by reading the screen);
  the usage block agrees; the cap is put back as it was found.
* **OWNER**: **no plan inputs are drawn at all**; the owner is told where the plan comes from; and —
  the direction that actually matters — the same write issued **straight at the API** answers
  `403 PLATFORM_ADMIN_REQUIRED`, names the fields it refused, and nothing lands.

### The guard now covers this screen too

`test/unit/frontend-wire.test.js` grew a second screen: every `s.`/`usage.`/`counts.`/`features.`
read in `plan.js` is checked against a live `/api/plan`, and the capacity card's `dm.` reads against
`/api/data-management/status` — the blocks a screen merges onto one object are checked against the
route that serves them, which is stricter than skipping them. It also skips **members of a DOM node**
(`counts.replaceChildren`) after one false positive: the same file uses `counts` for a DOM container
in its cleanup modal and for the response's usage block in `render`.

### Verified

`npm run verify` **422/422/0** · `bash test/run-audits.sh` **19 audits green** · frontend rendered in
jsdom against a live server: **the owner's 27 destinations and the administrator's 8, every screen
draws, no faults**.

**Still open:** the notification engine's messages have no screen (list / read / read-all — the
engine raises low stock, debt ageing, expiry and plan warnings that nobody can see); and the
branch-scope misalignment P9's walk found — the owner holds several branches, so **Till & safe** and
**Stock** render "Choose which branch this applies to" as an error block under an "All branches"
heading, where the screen should be asking for the branch instead of reporting a failure.

---

## P11 — THE BELL: THE ALERTS THE SYSTEM RAISED AND NOBODY COULD SEE

The notification engine has exactly one producer — the daily compliance sweep, which turns
every permit or licence about to lapse into a notification. Those rows are the difference between a
licence being renewed and a shop being closed for trading without one, and **until this stage nothing
in the product could show one**: `GET /api/notifications`, `POST /:id/read` and `POST /read-all`
existed, worked, and were reached by no screen at all. The table had a writer and no reader.

### The defect underneath

Both halves of the audience had been scoped by the caller's **own** `branch_id`, with the literal
string `'__none__'` standing in for "this user has no branch" — which is every OWNER and every
ADMIN:

* the **list** had already been fixed (scope-based) in an earlier stage, which is why the comment
  there records the history;
* **"Mark all read" still had the old predicate.** So the two seats most likely to press it marked
  **nothing at all**, while the list beside the button showed them a screenful — and a multi-branch
  manager marked their own branch and left the rest unread forever. `read-all` now builds its
  audience from the same `scopeFilter` as the list, and answers with what it marked and what is
  left, because the only thing worse than a button that misses rows is one that disagrees with the
  screen it sits on.

### The bell

A bell in the top-bar with an unread badge, opening a panel that lists what the caller can see: a
severity dot, the title, the body, **which branch it is about**, and — for a branch alert — that it
is *shared with the branch*. Clicking one marks it read and takes the person to the screen that fixes
it (`COMPLIANCE_EXPIRY → Compliance`, low stock → Stock, overdue credit → Customers, and so on). It
refreshes on sign-in, on tab focus, every five minutes, and after any read. Nothing is mirrored for
offline use: an alert list that has been stale for a week is worse than saying "you are offline",
and reads are never queued in this app.

**The semantics are written down rather than discovered.** A notification *addressed to a person* is
theirs alone. A **branch alert is one shared work item** — there is one `is_read` column, so whoever
deals with the licence clears it for the shop, and the panel says so out loud. What makes that safe
is the producer, not the flag: **the sweep only skips a record that still has an UNREAD alert**, so
clearing the bell without renewing the licence raises it again the next morning. Both halves are now
pinned by tests, because "mark read" silently discharging an obligation is exactly the kind of
assumption that turns into a closed shop.

### Verified

`npm run verify` **435/435/0** · `bash test/run-audits.sh` **20 audits, every check green** ·
`test/integration/notifications.test.js` **13 checks** · `test/audit/audit.notifications.js`
**12 checks** · `tools/frontend-alerts.js` **20 checks in a real DOM against a live server** — it
records a licence, runs the real sweep, watches the badge count it, opens the panel, clicks the alert
(taking the person to Compliance, which renders), clears the board, then **puts the fixture licence
back as it was found**.

`node tools/flow-coverage.js` → **197 routes · 151 audited · 32 screen-only · 14 unreached**, with
**notifications 3/3** (was 1/3, and the two routes had been *reached by no screen at all*).

### Reconfirmed on the way

The owner seat has **no active branch**, which is exactly the misalignment P9's walk found: the app
offers "All branches" and then a branch-needing action answers *"Choose which branch this applies
to"* as a failure. `tools/frontend-alerts.js` works around it by picking the first branch the way the
branch picker would, and the screens still need the same treatment — that is the next UI/UX item,
with the administrator's audit-trail/anchor screen and the remaining 0% flows (branding 0/5,
audit 0/3, sessions 0/2, profiles 0/2, catalogue/categories/customer-classes/settings/dashboard).

---

## P8b — WHAT A SUSPENSION ACTUALLY STOPS

`assertSubscriptionActive` has always read well — *"blocks every mutating request when the
subscription is SUSPENDED or EXPIRED. READ access is deliberately preserved: a client who has not
paid must still be able to export their own data"* — and it was wired to **three routes**: create
business, create branch, create staff.

So a client who stopped paying kept ringing sales, receiving stock, paying suppliers, posting
journals and approving expenses. The only thing a suspension cost them was the ability to add a
**fourth branch**. The vendor's one commercial lever did nothing to the thing the invoice is for, and
it looked like it worked: the status changed on the Subscription screen, the caps kept binding, and
everything that trades carried on regardless.

### Where the line is drawn

The gate moved into the request pipeline (`server/routes/index.js`), immediately after the auth guard
and the settings load, for the same reason the auth guard is there: **a rule enforced at 97 call
sites is a rule that will be missing from the 98th.** Being reachable while suspended now requires an
explicit entry, and every entry has to say why — the same shape as the public-path list.

> Everything that moves **money or stock** stops. Everything about running the business **as an
> organisation** stays open.

Open while suspended: **the door** (sign in, sign out, change your own PIN), **sync** (a device has to
report what it did — and each replayed sale is refused on its own way back through this same
pipeline), **the alert board**, **people and permissions** (a sacked cashier has to be sackable and a
PIN has to be resettable whether or not the invoice is paid — it is also the only way the vendor can
help), **revoking a stolen device**, **attendance** (shifts are people, not money), **statutory
registers** (a licence renewal is not a sale), **the client's own configuration** (including the
contact line the vendor is about to ring), and **previews**, which create nothing.

The three per-route calls were removed. Leaving them would have made the exemption list a lie: a call
parked inside a route fires whatever the pipeline decides, and `POST /api/users` was doing exactly
that — refusing the client a PIN reset on a suspended account while the pipeline exempted the family
on purpose. One rule, one place.

### The client is told, not just refused

The refusal was correct and unreachable: it names the status, says that reading and exporting still
work, and gives the contact line — and the only person who ever read it was the one who happened to
press Save. Everyone else met a toast in the middle of a queue of customers, and it expired in nine
seconds.

A **bar in the shell** now says it before a cashier scans a basket. It is drawn from the status the
app already carries (`publicSettings`, mirrored for offline), so it costs no request; it repaints the
moment the server refuses a write (`SR.api` emits `plan` on `SUBSCRIPTION_NOT_ACTIVE`), because a
cached ACTIVE can be days old; the owner gets a way through to the Subscription screen; and the
**vendor's own session is marked differently** rather than shown a wall — an administrator working on
a suspended client's instance is not gated by it, and a red "your service is paused" bar in front of
the person fixing it would be a lie.

### Verified

`npm run verify` **451/451/0** (435 before: 16 new checks in
`test/integration/subscription-gate.test.js`) · `bash test/run-audits.sh` **20 audits green** ·
`tools/frontend-suspension.js` **28 checks, every one green**, against a live server through the real
UI: the administrator suspends the client **on the Subscription screen**, the client's own signed-in
session is refused a trade through the app's own API layer, the bar appears naming the status and the
contact line, reading still works, the vendor's line differs, the status is restored through the same
screen, the bar goes and the shop trades again — and **the deployment is left on the status it
started with** (TRIAL stays TRIAL: a fixture that "restores" everything to ACTIVE has quietly
promoted somebody's trial).

Also caught by the project's own guard on the way: the new test stamped a sale with
`new Date().toISOString()`, and `test/unit/test-hygiene.test.js` refused it — UTC where the schema
stores WAT. It uses `watNow()` now, which is exactly what that test is for.

### Reconfirmed

The third time this run of stages has hit it: an **owner with several branches has no active one**,
so any branch-scoped write must name a branch. Both new probes resolve one the way the branch picker
would and say so; the screens still owe the same treatment.

---

## P8d — THE VENDOR'S HAND ON THE CONTROLS, AUDITED BOTH WAYS

Every commercial control in the product belongs to the platform administrator: the three caps, the
plan name, the subscription status, the renewal date. P8a made them the vendor's at the API, P8b
made a suspension actually stop trade, P9/P10 put them on the Subscription screen. What was missing
was a run that measures the whole control surface **from both ends at once** — and it found the last
two places where the screen and the server disagreed about what a control means:

* **`GET /api/plan` is camelCase and carries the counts separately.** The screen draws
  `maxBusinesses` / `maxBranches` / `maxStaff` / `plan` / `status` / `renewalDate` beside a live
  `counts` object — and an audit that assumed `usage.<key>` had nothing to assert against, which is
  how a screen and an API drift apart in the first place. The keys are now pinned by a check that
  fails if one is renamed.
* **the caps refuse in the client's own terms.** *"Your Standard plan includes 1 branch and all 1 are
  in use. Contact your StockRidge account manager to add another."* — the number, the plan and the
  contact line, asserted rather than admired.

`test/audit/audit.platformAdmin.js` — **10 checks, green** — walks:

**front to back** the six controls are drawn with the live usage → a cap the administrator sets
**binds** at the create route → a cap **below** current usage warns and takes nothing away (nothing
is ever deleted to fit a ceiling) → the change lands on the audit trail as **`PLAN_LIMITS_CHANGED`**,
naming the field that moved → **0 means unlimited**, which is how the screen has always read it and
how the server now behaves (a cap of 0 lets a create through that a cap of 1 refused);

**back to front** the client cannot write **any** of the six — three probes per field asserting
`403 PLATFORM_ADMIN_REQUIRED`, the field named, and the value unchanged afterwards (a refusal that
writes is worse than no rule) — a manager and a staff member cannot even **read** the commercial
position (`403 ROLE_REQUIRED`), a suspension refuses the client's trading write `402` while the
client's reads keep answering `200`, and **the vendor is never gated** on the instance they have been
telephoned about.

**And it leaves nobody on a different plan.** Every field it touches is captured first and handed back
to the harness — including the subscription status, because an audit that ends with a client suspended
has stopped a shop trading.

### Verified

`npm run verify` **451/451/0** · `bash test/run-audits.sh` **21 audits, every check green** ·
`node tools/flow-coverage.js` → **197 routes · 155 audited · 28 screen-only · 14 unreached**, with
**plan 1/1** (was 0/1) and **settings 2/2**.

---

## P12 — THE ICON AND THE FIGURE IT STANDS ON

A tile is read at a glance: the icon says what the number is before the number is read, which
makes a wrong icon worse than a missing one. The dashboard had three, and the app had 188 tiles
with no icon at all.

### What was wrong on the dashboard

* **"Owed to us ₦34,579,273.97" carried the people icon.** The figure is a receivable; the people
  ("11 debtors") are counted on the line underneath it. It is the **ledger** now.
* **"Expected in drawer" carried the stock box.** Cash in the drawer is cash.
* **"down 100% on yesterday" was words.** The one number a person checks first — did today beat
  yesterday — had no mark on the tile saying so. It has an **arrow** now, drawn from the sign of
  the figure the server sent, coloured by what that direction *means* (`goodWhen`): a rise in
  takings is green, a rise in debt is red, and the arrow points the way the figure went in both
  cases.
* "Sales 07 Sept → 07 Oct" was drawn with a bar chart; it is money in over a window — a sum of
  **receipts**.

### The rule, written down

`ui.iconForFigure({ label, value })` in `public/js/ui.js` picks the icon from the figure itself:
money first, through its own chain (owed → **ledger**, held/float/drawer → **wallet**,
stock/inventory → **box**, sales/revenue → **receipt**, else **cash**), then dates → calendar,
percentages/margins → chart, time → clock, people → users, stock → box, and a bare count → a new
**hash**. Anything that is not a figure — a status word, a dash, "No till is open" — gets **no icon
at all**, and a caller's explicit icon always wins.

Two things it must never do, both now pinned: it never returns `'grid'` (the silent fallback
`iconPath` uses for a name it does not know, which renders as a grey square that looks like a
considered choice — an unknown name passed by a caller now warns in the console instead), and a
money figure can never be drawn as people, a chart or a calendar.

### And the arrow is only drawn when there is something to compare against

`trendChip` draws nothing when the server sent neither a percentage nor a delta — and **nothing for
a delta of exactly zero either**. That last one came out of running the probe against a cashier's
seat, whose dashboard legitimately sends `{changePct: null, change: 0}` on a quiet morning: the chip
would have read "flat ₦0", stating nothing, on the only tile that had anything to say. An explicit
`0%` from the server *is* a comparison ("the same as yesterday") and keeps its flat mark.

### Verified

`npm run verify` **469/469/0** (451 before: 18 new checks in `test/unit/kpi-figures.test.js`, which
is source-level and refuses the four ways a later change could undo the rule) ·
`bash test/run-audits.sh` **21 audits green** · the smoke walk and the bell probe still clean ·
`tools/frontend-figures.js`, a new two-way probe in a real DOM against a live server,
**23 checks green as the owner, 23 as the administrator, 21 as a cashier**:

**front to back** the dashboard's four figures are asserted **equal to the server's own numbers**,
every money tile carries a money icon, no tile renders the fallback square, and the trend arrow,
its percentage and its colour are checked against `today.vsYesterday` as the API actually sent it —
then the synthetic boundaries (`+12%` up/green, `−12%` down/red, `0%` flat, a delta with no
percentage, a zero delta, nothing at all) are driven through the same component;

**back to front** every screen in the sidebar is swept: **every money figure on every screen
carries a money icon and nothing renders the fallback square** (74 tiles over 26 screens as the
owner, 35 over 12 as a cashier).
