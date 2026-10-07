
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

---

## P13 — THE AUDIT TRAIL, AND WHETHER IT CAN BE LIED ABOUT

Every privileged action writes a row to `audit_log`: who, which business and branch, what it was
before and after, the address it came from. Each row carries the hash of the row before it, so an
edited or removed row breaks every link after it — and two routes exist to prove exactly that:
`GET /api/audit/verify` recomputes the whole chain, `POST /api/audit/anchor` returns a short
commitment to the head that an owner can keep somewhere the vendor does not control.

**Nothing had ever exercised them.** The screen called all three routes, the nav offered it to
managers and owners, and the flow has read **0/3** since it was written — the exact shape of "the
feature exists and nobody has seen it work".

### What the audit found — four dead field reads and a button that always fails

The screen is a screen about proof, and it could not show its own proof:

* the **Chain column read `a.hash`**, and the column is `row_hash` — so this column said "—" for
  every row of every deployment, and the entry dialog's "Hash chain" line read `hash: —` too. Neither
  name throws; `undefined` renders as a dash. **The one field whose whole job is to show the row is
  chained was blank, on the screen whose entire argument is that the chain is real.**
* **"Who" read `a.role`** — not a column of `audit_log` — so the second line of every row was blank
  where the address it came from should have been.
* **the entry dialog read `entry.reason` and `entry.device_id`** — neither is a column — so two of
  its seven lines could only ever say "—", while the two facts the trail does carry (`ip_address`,
  `user_agent`) were not shown at all.
* **"Detail" read `a.summary || a.description`**, neither of which exists; it rendered correctly only
  because the third name in the chain does. Off by a hidden fallback is still off — and a deletion
  has only `before_json` to show, so that is now the fallback rather than a second choice.
* **"Verify the chain" was drawn for managers**, while both routes are `atLeast(OWNER)`. A manager
  may read the trail (the read route allows it, and the nav matches); a manager pressing Verify got a
  403 toast. A button that always refuses teaches people to ignore refusals.

### And the audit that pins it

`test/audit/audit.auditTrail.js` — **12 checks, green**:

**front to back** a privileged action is performed and its row appears with the actor, the branch and
the before/after → every filter the screen offers finds it (action, user, entity, free text, and a
range that cannot contain it returns nothing) → the per-action counts are reproduced from the rows
behind them → the chain verifies over every row → anchoring returns a head hash and **the act of
anchoring is itself on the trail** → **the screen only reads fields the rows actually carry**: the
audit walks the screen's own source, strips comments and strings, collects every `a.`/`entry.` read
in the audit section and refuses any the API's live row does not send. That check fails on all four
dead reads above, which is how they were found.

**back to front — the attack the whole feature exists for**: a trail row is **edited directly in the
database**, through a second SQLite connection, the way somebody with a SQL client would. `verify`
must answer 500, name the row, and report `HASH_MISMATCH` — and it does. Then the row is **deleted**,
and the report must turn into `BROKEN_LINK` — and it does. The row is put back through the same
connection in a `finally`, so a failed run cannot leave a deployment with a genuinely broken chain;
and the audit is honest that a deleted row **cannot** be restored byte for byte, so the chain stays
broken afterwards — which is the point of it. Also: the API cannot write, edit or delete a trail row
(four attempts, all refused, row count unchanged); a manager may read the trail but gets `403` for
verify and anchor; a staff member gets `403` for the trail at all; and a manager cannot read another
business's rows.

### Verified

`npm run verify` **469/469/0** · `bash test/run-audits.sh` **22 audits, every check green** ·
`node tools/flow-coverage.js` → **197 routes · 157 audited · 26 screen-only · 14 unreached**, with
**audit 3/3** (was 0/3) · `tools/frontend-roles.js` across all four seats: **no problems, both
directions** — 12/12 critical boundaries checked for the cashier, 10/12 for the manager · and the
live DOM: the owner's trail shows real hashes in the Chain column with both buttons; the manager's
shows real hashes with **neither** button; the cashier has no trail at all.

## P14 — THE DEVICE THAT IS SIGNED IN, AND THE NAMES ON THE TRAIL (2026-10-07)

Two small stages, both about a screen promising something the database was not holding.

### 1. The audit vocabulary, reconciled with the code that writes it

The trail's list of permitted action names was **fiction in both directions**: 50 actions were
written under names the list did not contain (`SESSIONS_REVOKED`, `CUSTOMER_DELETED`, every
compliance action), and 31 names in the list had never been written by anything — an auditor
grepping the trail for them would find nothing and not know why. The numbers also have to be
stated carefully, because the first tool was wrong: the naive `action: 'X'` scan reported 74
written actions and missed every ternary (`PLAN_LIMITS_CHANGED` / `SETTINGS_UPDATED` is chosen at
run time in one expression). `tools/audit-actions.js` walks the source with comments blanked
**length-preservingly** — skipping `*/` without emitting characters drifted every later index by
28 characters in `sales.js` — and reports **96 written · 96 declared · 31 reserved**.

`server/lib/audit.js` now holds both blocks, and `test/unit/audit-actions.test.js` (10 checks)
fails the build if they drift. The reserved block is the point of the exercise: `USER_ROLE_CHANGED`
is not missing from the trail by accident, a role change is recorded *inside* `USER_UPDATED`; the
VAT rate inside `SETTINGS_UPDATED`; an export and a superseded session are not recorded at all.
Deleting those names would erase the record that the difference is known.

**`record()` still validates nothing, and that is now a written decision** (the docstring says so):
refusing a write because a caller invented a name would drop the row — trading the record of a
privileged action for the tidiness of a list, which inverts what a trail is for. Drift is caught
where it is cheap instead. The tool reports reserved names as reserved, exits 0 when they are the
only unwritten ones, and a second `--write` changes nothing.

### 2. Sessions — who is signed in, and cutting them off

`test/audit/audit.sessions.js` — **8/8**, and the flow moved **0/2 → 2/2**.

**front to back**: a seat signs in carrying a device id → the list shows it once, with the branch,
the device, the address it last came from, when it signed in, when it last did anything and when
the session ends on its own → a manager revokes a cashier (`sessionsEnded: 1`) → the cashier's
token is refused **immediately** as `SESSION_REVOKED` → they can sign in again, because a
revocation is not a deactivation → the act is on the trail with the count and `"self": false`.

**back to front**: a manager cannot revoke an owner or the vendor (`403 ROLE_REQUIRED`); a cashier
can revoke nobody but themselves; a second sign-in **supersedes** the first rather than leaving two
live tokens, and the two refusals are asserted as different: `SESSION_SUPERSEDED` carries the
message that tells the person their PIN may be known to somebody else.

Five defects, all found by reading the screen against the query rather than against the idea of it:

* **Four dead field reads on two screens.** The manager's session table and the "where you are
  signed in" card both asked for `device_id`, `ip_address`, `created_at` and `expires_at`. The
  route sends `last_ip`, `issued_at`, computes no expiry, and `user_sessions` had **no device
  column at all** — four of six columns drew an em dash at every row, and nothing noticed, because
  a missing name renders as a dash instead of an error. Both tables now read the fields the route
  sends, and the audit **scans the two screens' source against the route's own SELECT** so the
  contract cannot rot again. Each scan is anchored to its table: the first version scanned all of
  `account.js` and failed on a *different* table's columns (`person`, `asked`, `act`).
* **The vendor was in the client's lists.** A client manager could see the deployment
  administrator's session — a username, a device, an address, when they last acted — and the
  vendor's account sat in the middle of the staff list, where every action on it answers 403. The
  plan's own wording settles it ("the ADMIN vendor seat is NOT counted — it is not part of the
  client's team"), so the rule is now written in both routes as one line, and the audit checks both
  lists for both client seats **and** that the vendor can still see their own row.
* **The screen offered the button to the wrong people.** "Sign out" was shown to owners only, while
  the route allows any manager to end a lower-ranked person's session — a manager holding a
  cashier's lost phone had the power and not the button. `SR.state.canManageUser` now mirrors the
  server's `canManageUser`, documented as a mirror with the server authoritative.
* **Migration 0008** adds `user_sessions.device_id` and `user_agent`. The sign-in route has always
  received a device id (the app sends `X-Device-Id` on every request) and dropped it; now it is
  stored from the body **or** the header, so the Device column names the phone a session belongs
  to. `expires_at` is computed from `TOKEN_TTL_SECONDS` **bound as a parameter**, not typed into
  the SQL: a screen that says "ends in four hours" and a token that lives twelve is worse than no
  column at all. Both columns are nullable on purpose — "no device reported" and "written before
  this migration" are different facts.
* **The fixture now signs in the way the app does**, with a device id. A fixture that omits it
  leaves the column null everywhere and quietly proves nothing about the column a manager relies on.

### Verified

`npm run verify` **479/479/0** (up 10: the vocabulary test) · `bash test/run-audits.sh` **23 audits,
every check green** · `node tools/flow-coverage.js` → **197 routes · 159 audited · 24 screen-only ·
14 unreached**, **sessions 2/2** · live on the demo deployment: the manager's list carries
`device_id` and an `expires_at` exactly twelve hours after `issued_at`; the vendor sees all 4
sessions and all 16 accounts including their own; the manager's and the cashier's lists carry no
vendor row; the manager revokes the cashier (`sessionsEnded: 1`), the dead token answers
`401 SESSION_REVOKED`, the cashier signs straight back in; the vendor signing themselves out gets
the "signed out of every device" variant and their own token dies with it.

**Note for the next stage:** the local demo's vendor PIN is the dev seed's `90210`;
`1234` is the staging/sample/production PIN the Stage-6 directive set, so a probe against the demo
must use the former. Staging was down on the free-tier D1 daily row-read limit and is still
awaiting its re-probe.

## P15 — THE SHOP'S OWN NAME ON THE FRONT DOOR (2026-10-07)

Branding. Five routes in `server/routes/branding.js`, a careful design written in its own header
comment — *"a cashier at Ridge Furniture Palace should see their shop's name, not the vendor's"* —
and **all five read "not reached by any screen"** in the coverage report. A complete backend with
no way to use it, which is what the standing admin-flows directive calls a feature that does not
exist. Branding is now **5/5 audited**, unreached **14 → 9**, and `test/audit/audit.branding.js`
holds it at **7/7 — 8 checks**, both directions.

### What was actually broken

* **The sign-in screen showed the VENDOR'S name.** `#login-brand-name` was the literal string
  "StockRidge" and nothing ever called the public endpoint that exists to prevent exactly that.
  On a white-label product the front door is the one place the client's brand has to be, and it
  was the one place it was not. `SR.app.paintLoginBrand()` now reads `GET /api/branding` — cached
  first so a cold start on a dead line still shows the client's name, which matters in a product
  that runs offline — and the screen carries the client's logo when there is one, falling back to
  the wordmark.
* **The public endpoint's own fallback was dead code.** `publicBranding` selected three columns
  and read a fourth: `row.primary_business_id`, which the query never selected, so it was always
  `undefined`, the primary-business lookup never ran, and a deployment that had not yet typed a
  trading name fell through to the vendor's name — **while its first business had a perfectly
  good one**. That is the state a fresh handover is in, the one where it matters most. Proven by
  blanking `business_name` on a copy of the database and reading the endpoint: `StockRidge` before,
  `Ridge Electronics Ltd` after. Four dead field reads were fixed in P13/P14 on three screens; this
  is the fifth, and the first one the *server* was doing.
* **`business_name: null` used to become the word "null".** `String(null)` is truthy, so a JSON
  body saying "no name" renamed the shop to `null` on every receipt and on the sign-in screen. An
  absent name is refused like a blank one now, and the audit asserts both.
* **Two writable controls for one fact.** The Settings screen's "Business identity" group already
  carried `business_name`, `receipt_footer_text` and the three contact keys — real settings columns
  that `PUT /api/settings` will write — and the new branding card writes the same five through
  `PUT /api/branding`. Two controls, one fact, one screen: the later save silently undoes the
  earlier one. The branding card owns them (it also carries the logo and records `BRANDING_UPDATED`),
  the five moved out of the switches, and `test/unit/settings-controls.test.js` grew the reasons
  while `audit.branding.js` refuses to let the two lists overlap again.

### What the audit proves, both ways

**Front to back** the owner renames the shop, sets a footer and contact details and uploads a logo
→ the **public** endpoint (no token — the one the sign-in screen reads) answers the new name and
the new logo → each change is on the trail **as `BRANDING_UPDATED` with the previous value**, and
the logo is recorded as a byte count rather than stored inside the audit row.
**Back to front** a manager may read the full record but cannot write it; a staff member cannot even
read it; the unauthenticated endpoint answers exactly `{ok, name, logoDataUrl, receiptFooter,
poweredBy}` and leaks no contact details; an **SVG carrying a script is refused by its magic bytes**
whatever the request claims it is (this value is injected into an `<img src>` on the sign-in screen);
and the two field lists — the route's `allow` object and the screen's `BRANDING_FIELDS` — are
compared in both directions.

### Verified

`npm run verify` **479/479/0** · `bash test/run-audits.sh` **24 audits, every check green** ·
`node tools/flow-coverage.js` → **197 routes · 164 audited · 24 screen-only · 9 unreached**,
**branding 5/5** (was 0/5) · live in the browser harness: the Settings screen renders the card with
exactly one control per fact, the logo row and no console errors; **typing a new name and clicking
`Save branding` moves the public endpoint and the sign-in screen of a device that has never been
here**, and the same screen puts it back — which is how the demo was left, name restored.

## P16 — THE SIGN-IN FURNITURE (2026-10-07)

Six auth routes nobody had exercised — sign out, change your own PIN, the lockout state, the
owner's override, the attempts log, and the token check the service worker calls on resume.
**auth 2/8 → 8/8**, unreached **9 → 5**, audited **164 → 170**.

### Changing your own PIN signed you out of the device in your hand

`POST /api/auth/change-pin` retired "every other session" with
`DELETE FROM user_sessions WHERE user_id = ? AND session_id <> ?` — and bound `ctx.get('token')`,
which is the **bearer token**, against a `session_id`. It never matches, so the condition deleted
every row *including the caller's own*, while the response said "Sign in again on any other device
you were using". The single-row design cannot express "other sessions" anyway: there is one session
per user, and another device's sign-in has already superseded it. So a PIN change now **ends the
session and starts a fresh one for the person who just proved the new PIN**, returning a token for
it; every token that existed before the change is dead (refused as `SESSION_SUPERSEDED`, with the
message that says *if that was not you, your PIN may be known to somebody else*). The account
screen keeps the new token, and its own wording now matches what the route does — it used to
promise something the code did not do, in both directions.

One implementation of "a session begins" now exists: `startSession()` in the auth middleware, used
by the sign-in route and by the PIN change. The old code had two ideas about it and one of them was
a string that never matched.

### The account screen threw away two-thirds of itself

Found by driving it in the browser, not by reading it: `[view:account] ReferenceError: transfers is
not defined`. `transfers` was a `let` inside `load()` read inside `render()` — one function away, so
the screen threw at that line and rendered the person's access, then nothing. Everything after it —
**the PIN form**, the device card, the print test, the build tag — was unreachable on the only
screen where a person can change their own PIN. Passed in properly now.

### Three routes the owner could not reach

`GET /api/auth/lock-state`, `GET /api/auth/attempts` and `POST /api/auth/unlock` are complete,
carefully-gated routes — manager-and-owner for the lock state, owner-only for the override, with a
required reason and the state it overrode on the trail — and **nothing in the app called any of
them**. A cashier who mistyped their PIN eight times on a busy morning was locked out, the manager
could not see who was locked out, and the owner had no way to clear it from the product. The staff
screen's person detail now carries a **Signing in** card: the failure count, whether the account is
locked, an owner-only **Clear the lockout** button that asks for the reason the route demands, and
the last ten attempts with the address and device they came from. The gates are the routes': a
manager may look, only an owner may clear.

### What the audit proves, both ways

**Front to back**: signing out kills the token on the next request and lands on the trail → the PIN
change's four refusals and its success (old PIN out, new PIN in, one session row, and it is the
session the route issued) → **eight wrong PINs lock the username, and the CORRECT PIN is refused
while it is locked** (a lockout that lets a good guess through is a delay, not a lockout) → the
lockout state, then the attempts log read *before* the unlock deletes the failure rows that feed the
throttle → the owner clears it with a reason and the correct PIN works again.
**Back to front**: the lock state is manager-and-owner reading only; clearing is owner-only *with* a
reason of four characters or more, and a refused unlock clears nothing; a reused PIN is refused
(`PIN_UNCHANGED`) because it spends the change without changing anything; and
**`/api/auth/verify` cannot be a way around revocation** — the service worker asks it whether to
flush the offline queue, so the owner revokes the session behind a token and the answer must turn
from 200 to `401 SESSION_REVOKED`. The attempts table's four columns are checked against the route's
own `SELECT`, because three of them were guesses when the screen was written.

### Verified

`npm run verify` **479/479/0** · `bash test/run-audits.sh` **25 audits, every check green** ·
`node tools/flow-coverage.js` → **197 routes · 170 audited · 22 screen-only · 5 unreached**, **auth
8/8** (was 2/8) · live: the account screen renders its PIN form again and **changing the PIN leaves
the person signed in** (old PIN 401, new PIN 200, the reissued token works, the screen's wording
matches), the staff detail shows **Signing in** and **Recent sign-in attempts** with the fields the
routes send, and the demo was left with its seed PINs (`segun` back to `26480`).

## P17 — THE FIRST SCREEN THE OWNER OPENS (2026-10-07)

The dashboard: two routes, no audit, and the numbers an owner actually decides with. **dashboard
2/2**, audited **170 → 172**, `test/audit/audit.dashboard.js` **13/13**.

It does not ask whether the endpoint answers. It rings sales and then checks the figures against the
rows that were written, because a wrong number here does not look wrong — it looks like a quiet
morning, and somebody orders stock against it:

* **a sale moves the takings by exactly its total** (₦68,000.00 in, +₦68,000.00 shown), and the
  count by one — not approximately, not upward;
* **the figures agree with each other**: `netRevenue = grossRevenue − vat`,
  `grossMargin = netRevenue − cogs`, the margin percentage is the ratio of its own two figures, the
  average sale is the takings over the count, and the cost of goods is not zero after a stocked
  sale (a zero COGS overstates every margin on the screen by the whole cost);
* **a void is not a sale**: voiding moves the takings *down* by exactly that sale, the count down
  one, and adds it to the voided count and value;
* **the comparison is against yesterday and carries its direction** — including the P12 rule that
  a day with nothing to compare against answers **null**, not a made-up +100%, so the tile draws no
  arrow rather than an arrow pointing at nothing (this audit asserted +100% first and was wrong
  about the product);
* **the period includes its own day** (`period.grossRevenue ≥ today.gross`), and `today` answers
  `gross` and `grossRevenue` with the same number, because the screen reads both names;
* **the scope decides the shape of the answer, not the request**: the cashier's dashboard is their
  branch, the owner's is the group, and a cashier naming another branch by parameter cannot widen
  it;
* the summary and the full dashboard **agree about the same day**.

### Two things the audit found in itself, which are worth recording

The field scan — the screen's reads against the route's live payload — reported **eleven dead reads
on its first run and every one of them was wrong**: five came out of the file's own header comment,
which lists the ten names that were fixed in an earlier pass (`today.periodGross`,
`today.vs_yesterday_pct`, `cash.till`), and six were reads of **other sources** the screen
legitimately uses — the offline mirror (`SR.store.all('stock_batches')`, whose rows carry the local
store's field names) and the drawer card, which is empty when nobody has opened a till. The scan now
strips comments length-preservingly, walks arrays for nested keys, unions the owner's payload with
the cashier's, and excuses the mirror's five names **by name and with a guard that fails if that
store read ever leaves the screen**. It ends up checking 37 reads in the screen.

And the audit read `period.gross` where the period block says `grossRevenue`: it got `undefined`,
reported a ₦0 period totalling less than its own day, and so accused the product of a defect that
was its own dead field read. The field is asserted by name now, so a rename fails loudly instead of
reading as zero.

### Verified

`npm run verify` **479/479/0** · `bash test/run-audits.sh` **26 audits, every check green** ·
`node tools/flow-coverage.js` → **197 routes · 172 audited · 20 screen-only · 5 unreached**,
**dashboard 2/2**.

## P18 — THE LISTS A SHOP IS SET UP FROM (2026-10-07)

Nine routes that decide what the product can even talk about — the verticals, the category tree,
the customer classes, the barcode scan at the counter, the adjustment ledger — every one of them at
**0%** in the coverage report. Now **audit.reference.js 6/6**; audited **172 → 181**, screen-only
**20 → 13**, unreached **5 → 3**.

### Two real defects, both found by exercising the route rather than reading it

**THE BARCODE SCAN WAS DEAD FOR EVERY CODE IT RECOGNISED.** `productPayload()` destructured its
parallel query array as `measure` and then returned `measures` twenty lines further down, so every
call threw `ReferenceError: measures is not defined` and the counter's gun answered **500**. The
only path that worked was an UNKNOWN code, which 404s from a branch *above* the crash — the scan
that should not work was the only one that did. Both callers of the helper are the scan route, and
`public/js/views/pos.js:198` uses it, so this was the cashier's barcode path in the POS. Renamed to
`measures` and probed live after a server restart (the demo was serving the pre-fix code): a real
SKU answers `200 matchedBy=SKU` with the product, its units and its batches; an unknown code answers
`404 SCAN_NOT_FOUND`; no code answers `400 MISSING_FIELD`; and a cashier scanning the same code with
no branch parameter answers 200 on their own branch.

**A GUARD THAT COULD NEVER FIRE, AND SILENCE WHERE A REFUSAL BELONGED.** `POST /api/customer-classes`
refuses a class that cannot buy on credit but carries a credit limit — except it parsed the limit
only when credit was allowed, so `default_credit_limit: 50000` with `credit_allowed: false` was read
as `0`, refused by nothing, **stored as 0, and answered 201**. The shop was told it had created a
class with a ₦50,000 limit and half of it had been quietly dropped. Both the limit and the payment
terms are now read whether or not credit is allowed, so the contradiction is refused
(`400 CONTRADICTORY_CLASS`) instead of discarded. Silently ignoring an instruction is worse than
refusing it: the person believes the instruction is on the record.

### What the audit now proves, in both directions

Front to back: a manager adds a category and it appears in the list with a product count of 0; a
duplicate code is a 409 `DUPLICATE_CATEGORY`; an owner creates a class with a 7.5% discount, a
₦250,000 limit and 30-day terms and all four come back **as sent**; an adjustment appears in the
ledger carrying its product, branch, author and type, and the type filter finds it.
Back to front: a cashier cannot create a category (403 `ROLE_REQUIRED`); a manager cannot create a
customer class, because a class sets the terms for everybody in it; an unknown vertical is a
**404, not a silent fallback** (`getProfile` returning the default made that 404 dead code once);
and two routes that list the same four verticals (`/api/profiles` and `/api/catalogue/profiles`) now
answer a **human name in both shapes** — one nested it under `profile.label`, the other answered
`label`, and a chooser had to know which route it had called. `describeProfile` carries `name`, and
a synthetic row in the admin list takes the profile's label as its name.

### Verified

`npm run verify` **479/479/0** · `bash test/run-audits.sh` **27 audits, every check green** ·
`node tools/flow-coverage.js` → **197 routes · 181 audited · 13 screen-only · 3 unreached** ·
live probe on the restarted demo: `200 matchedBy=SKU` / `404 SCAN_NOT_FOUND` / `400 MISSING_FIELD` /
cashier 200. Next: suppliers (2/5) and stock (4/7), then the last three unreached routes.

## P19 — THE NUMBER ON THE LABEL, AND THE SCREEN THAT ASKS FOR IT (2026-10-07)

Reported: receiving a serial-tracked product was refused with `"Haier Thermocool 300L Double Door
Fridge" is serial-tracked, so each unit needs its own serial number: 1 expected for 1 unit(s), 0
given` — and the same for a console (`10 expected for 10 unit(s), 0 given`) — **with nowhere on the
form to type a number**. Plus: "when owner clicks account … That failed. transfers is not defined".

### The demand was right. The form was the dead end.

Three faults, all on the screen, none in the rule the server enforces:

1. **The box only opened on a CLICK.** The receive form's Product field is free text with a
   suggestion list, and the serials box was revealed only by clicking a suggestion. An operator who
   typed the product name and pressed Receive sent a receipt the server could only refuse — and the
   refusal told them to scan or type numbers into a field that was not on the form. There was no
   path from that message to compliance.
2. **The count was counted in the wrong thing.** The form asked for `Math.ceil(quantity typed)`;
   the server counts BASE UNITS. Receiving **one carton of four units** was told "1 expected" while
   the server wanted 4 — two numbers for one fact, and the form had no way to be right.
3. **A refusal shut the box.** Even the operator who wanted to comply was left holding labels and a
   form with no field.

Now: a typed name is resolved on submit (exact SKU, exact name, or a single unambiguous match) and
the box opens with the focus in it; the hint counts the product's own ladder (`unitsExpected()` over
`unitFactors`) so a carton asks for one number per unit inside it; the client refuses before the
server does, in the same sentence the server uses; and any `SERIALS_REQUIRED` from the server opens
and focuses the box whatever the client believed about the product.

### Proven on the screen, not only in the route

`test/audit/audit.serials.js` **7/7**: no numbers is `400 SERIALS_REQUIRED` naming the product and
counting the gap (`1 expected for 1 unit(s), 0 given`) and writes nothing; two numbers in, two
serials on file `IN_STOCK` and reachable by their own number; **one number for a carton of four is
refused with `4 expected for 4 unit(s), 1 given`** and the same carton with four is accepted;
a serial on a product with no serial identity is `SERIALS_NOT_EXPECTED`; the same number twice is
`DUPLICATE_SERIAL_IN_REQUEST`; a number already on file is `409 SERIAL_ALREADY_RECEIVED`; and the
screen scan asserts the box, the reveal, the recovery and the base-unit count, and FAILS if the form
goes back to comparing serials against the quantity typed.

A live walk of the reported path: box hidden → type `Binatone Standing Fan 18"` → press Receive →
**box open, hint "2 unit(s) — 2 serial number(s) expected", focus on the textarea** → type two
numbers → press Receive → both on the register as `IN_STOCK`.

### "That failed. transfers is not defined" — the code was fixed; the browser was never told

The `ReferenceError` was fixed in P16 (`f24f6c6`); the account screen now renders for owner, admin
and cashier with no toast and no console error. **Note for the record:** the first check of this
reported it as STILL BROKEN because `document.body.textContent` includes the source of every
`<script>` in the page — the scan matched the fix's own explanatory comment. Element-level checks
(with script/style stripped) are the honest way to read a screen.

What was genuinely broken is how a browser learns the fix exists: `public/sw.js` names its cache
after `BUILD = 'ridge-2'` and `public/js/app.js` carried `SR.BUILD = 'ridge-1'`, both hand-typed and
never bumped, while the service worker serves `/js` and `/css` **cache-first**. Every browser that
had already visited kept being handed the old bundle — the fixed file on the server, the broken
screen on the desk, indefinitely.

`tools/stamp-build.js` now derives ONE stamp (commit + minute) and writes it into both files;
`npm run deploy` stamps before it uploads, so a deploy can no longer ship the previous cache key;
`node tools/stamp-build.js --check` fails if the two files ever disagree. This deploy carries
`ridge-20261007-1235-dd90aa3`.

### Verified

`npm run verify` **479/479/0** · `bash test/run-audits.sh` **27 audits, every check green** ·
`node tools/flow-coverage.js` → **197 routes · 181 audited · 13 screen-only · 3 unreached** ·
live jsdom walk of the reported path, end to end.

### P19 — live state at this checkpoint

* **Staging deployed and verified:** `https://stockridge-staging.stockridge.workers.dev` — readiness
  **ready**, three businesses trading, service worker served, cache key
  `ridge-20261007-1239-02d96a9` in **both** `sw.js` and `app.js` on the live URL (so every browser
  that has already visited throws the old bundle away on its next load).
* **The account screen was walked on the live URL as `admin`:** renders, no `That failed.`, no
  `transfers is not defined`, session row present — the reported error is gone from the deployment,
  not only from the working tree.
* **The serial flow was proven locally, on the same bytes staging serves** (`/js/views/stock.js` is
  byte-identical: 47,063 bytes, `openSerialsFor` present): a typed serial-tracked product opens the
  box with focus in it, counts its units, and two numbers land on the register as `IN_STOCK`.
* **A note for the next stage:** the platform administrator's navigation has no **Stock** screen at
  all (Dashboard, Staff, Branches, Businesses, Subscription), so a serial walk cannot be driven from
  the platform admin seat on a live deployment. That is a real front-end/back-end alignment question
  for the admin-flows directive and is recorded here rather than worked around.

## DEPLOYMENT — ALL THREE NAMED ENVIRONMENTS LIVE ON `d1fbfdf` (2026-10-07)

Pushed and deployed as asked: staging, sample and production, all three carrying the P19 fixes, and
**all three verified live** rather than reported from the deploy's own console.

| environment | URL | database | state |
|---|---|---|---|
| production | https://stockridge.stockridge.workers.dev | `stockridge` (32aa519c…) | **awaiting_first_business** |
| staging | https://stockridge-staging.stockridge.workers.dev | `stockridge-staging` (abf164d9…) | ready, 3 businesses trading |
| sample | https://sample.stockridge.workers.dev | `stockridge-sample` (fd72e95b…) | awaiting_first_business |

**Checked on each live URL, by request rather than by summary:**

* `admin` / `1234` signs in — **200 on all three** (the Stage-6 PIN directive holds across staging,
  sample and production; no reset was needed, so no PIN was changed to prove it).
* the service worker and `app.js` carry **one matching cache key per deploy**
  (`ridge-20261007-1255-d1fbfdf` staging/production, `1256-…` sample) — the stale-bundle failure
  mode that hid P16 from a browser cannot repeat without a deploy failing
  `node tools/stamp-build.js --check`.
* both P19 fixes are **in the deployed bundles**, not only in the repository: `openSerialsFor` in
  `stock.js` (3 references) and the passed-in `transfers` in `account.js` (2).
* the **account screen walked as the administrator** on production and staging: renders, no
  `That failed.`, no `transfers is not defined` — element-level, script/style stripped.
* **production is in the handover state the reseed directive asks for:** exactly **one user**
  (`admin`/ADMIN), **zero businesses** — every other row is to be created through the app's own
  provisioning flows, and the dashboard answers for that administrator without a business.

The deploy stamps both files as it runs, so the stamp the live workers carry is committed
(`c41759b`) — repository, working tree and all three deployments agree on the build.

## P20 — THE TRANSFER NOBODY COULD RECEIVE, AND THE PURCHASE ORDER THAT WAS NEVER CANCELLED (2026-10-07)

Reported: *"fix the transfer full flow … no way to handle the way to receive transfer no receive
button … and also check full purchase order flow from the back end to front end make all fully
aligned."*

### The bug: two halves of the product disagreeing about five words

The receiving branch's screen had **no Book-in button anywhere** — not on the list, not on the
transfer itself. It was not a missing feature. The table's vocabulary and the screen's had drifted
apart:

| | |
|---|---|
| the table (`CHECK (status IN …)`) | `INITIATED · IN_TRANSIT · PARTIALLY_RECEIVED · RECEIVED · CANCELLED` |
| the screen | `DRAFT · SENT · RECEIVED · CANCELLED` — **`SENT` has never existed** |

Every comparison on that screen was against `'SENT'`: the "waiting to be booked in" card was
therefore always empty, the status filter's "In transit" option matched nothing (the route matched
it literally, so it answered an empty list), and `canReceive` was false for **everyone**. Reproduced
live before changing anything: an `IN_TRANSIT` transfer addressed to the manager's own branch, page
showing "In Transit", buttons `["Print"]`.

**The fix removes the second copy of the vocabulary rather than correcting it.** The route now
declares `TRANSFER_STATUSES` (quoting the table's own CHECK), *answers it* in both the list and the
detail (`statuses`, `receivable`), refuses an unknown filter with `400 UNKNOWN_STATUS` naming the
real ones instead of returning an empty list, and the screen **learns it from the answer** — so a
deep link, a bookmarked transfer and a stale cache all speak the same five words as the database.

### What the flow could not do before

* **A delivery that arrived short could never close.** The route wrote `RECEIVED` even when lines
  were short, and only `IN_TRANSIT` was bookable — so a two-load delivery was unclosable. Now the
  first booking leaves `PARTIALLY_RECEIVED` and the balance can be booked when it turns up; the
  status only becomes `RECEIVED` when every line is closed.
* **Booking in counted against the manifest, not the balance.** A second booking defaulted to the
  whole sent quantity, which would have booked the first load in again and invented stock. Both
  sides now count the **outstanding** balance, and the route refuses more than is outstanding
  (`OVER_RECEIPT`, naming what was already booked in). The screen shows the line as
  **Sent · Already in · Arrived now**.
* **`CANCELLED` existed in the schema and nothing could write it.** The list offered it as a filter
  and a transfer that never arrived sat `IN_TRANSIT` for ever, its stock deducted from the sending
  branch and countable nowhere. `POST /api/transfers/:id/cancel` now returns the outstanding
  quantity to the sending branch as its own batch (sellable again), refuses the receiving branch
  (`BRANCH_SCOPE_VIOLATION`, naming whose transfer it is), refuses a fully received one, and writes
  `TRANSFER_CANCELLED` — a name that was sitting in the audit vocabulary's *reserved* list, i.e.
  recorded as "an event this product does not distinguish yet". It is written now: **97 actions
  written, 30 reserved**.
* The list rows carry **how much has arrived** (`units_sent`/`units_received` + the same progress
  bar the purchase-order list draws), so a 12-of-20 does not need a click.

### Purchase orders — the flow was sound; the last unreached route in the product was not

`POST /api/purchase-orders/*/cancel` was the **only route left with no audit anywhere** (coverage
had been reporting it for weeks): the path that *undoes a commitment* was the one path nobody had
walked. `audit.purchaseOrders.js` (6/6) now covers the whole order life — created and on the
supplier's page → part delivery `PARTIALLY_RECEIVED` with the stock on the shelf → the balance
closes it, two receipts on its history → over-receipt refused → **an order that has taken delivery
cannot be cancelled** (`PO_PARTLY_RECEIVED`: the goods exist and the debt is real) → a cancellation
needs a reason a supplier could be shown (absent → `MISSING_FIELD`, two letters →
`REASON_REQUIRED`) → a cashier has no standing → the cancelled order leaves the supplier's open
list, comes off the ledger balance, cannot be received against, and records `PO_CANCELLED`.

**One real front-end/back-end misalignment found and fixed there:** the detail screen offered
**Cancel order** on a partly-received order, which the route always refuses — a person confirmed a
dialog and typed a reason only to be refused. The button is now gated on *nothing received*, which
is the route's actual rule. Verified on screen: *nothing received* → `["Receive goods","Cancel
order"]`; *part received* → `["Receive goods"]`; and cancelling through the dialog + reason leaves
the order `CANCELLED`.

### Verified

`npm run verify` **479/479/0** · `bash test/run-audits.sh` **29 audits, every check green** (two
new) · `node tools/flow-coverage.js` → **198 routes · 185 audited · 10 screen-only · 3 unreached** ·
**`transfers` 5/5 and `purchase-orders` 5/5** (both were 4/5) · live jsdom walk of the reported
path: "Book in" on the list, "Book in what arrived" on the transfer, booking 1 of 2 leaves
`Partially Received` with "Book in the rest", the second booking defaults to **1** (the balance),
and the transfer closes `RECEIVED` with the two units on the receiving branch's shelf.

Both new audits caught their own errors first — worth recording, because each was a wrong
assumption that looked exactly like a working product: **the wrong id** (booking a receipt against
the *transfer* id instead of the *line* id silently matched no line, fell back to the full sent
quantity, and reported a "one of three" delivery as `RECEIVED` with all three on the shelf), **the
wrong actor** (a *staff* was refused `ROLE_REQUIRED` before the branch rule could be tested — it
takes a manager at the receiving branch to reach `BRANCH_SCOPE_VIOLATION`), and **guessed response
shapes** (the create route answers `id` and no status; the received value lives in
`totals.receivedValue`; the supplier's open orders are `purchaseOrders`, its ledger is
`balance_owed`).

## P21 — the PO serial box, and the three doors that make a deployment (2026-10-07)

**What the user reported.** "On receiving a purchase order for a product this popped and there is no
input for serial number, so fix — and also while creating staffs and branch and business it is
either name required or something; cross check the flow and fully align it from the front to the
back end."

**What was actually wrong — four separate things, all of them real.**

1. **The receive form had no serial box at all.** `POST /api/purchase-orders/:id/receive` has always
   demanded one number per unit on a serial-tracked line (`SERIALS_REQUIRED`), and
   `public/js/views/purchase-orders.js` never sent any — so a fridge, a phone or a generator bought
   on a purchase order could not be received anywhere in the product. Same dead end that P19 fixed
   on the direct goods-received screen, one route over.
2. **The business-create message lied about a working database.** The route read `result.summary`,
   which does not exist: `provisionBusiness` ends `return summary` — the counts ARE the return value
   (`categories`, `accounts`, `customerClasses`, `products`, `skipped`). The `{… provisioned, seededBy}`
   wrapper belongs to `provisionDeployment`. So an administrator was told
   "provisioned: 0 categories, 0 ledger accounts, 0 customer classes, 0 starter products" while the
   rows were all there — the worst kind of wrong, because the next thing they do is hunt for what
   went missing. Now `(result.provisioned || result.summary) || result`, and the audit compares every
   number in the sentence to the rows that exist.
3. **The create-person form offered what the route refuses.** The role chooser listed all four roles
   to everyone, so an owner picking "Owner" filled in the whole form and was refused
   "You are a Owner and cannot create a Owner." The branch select was labelled "No branch (owner or
   admin only)" while the route requires a branch of every role but the administrator — so a STAFF
   create with the blank left in was refused `BRANCH_REQUIRED`. `SR.state.canCreateRole` /
   `roleNeedsBranch` now mirror the route: an owner is offered Staff and Manager only, the branch
   field follows the role as it is chosen, defaults to the branch the creator works at, and the blank
   option appears only for ADMIN.
4. **`GET /api/serials` was a 500 for every manager and staff member.** `serial_numbers` has no
   `business_id` column, so the default scope filter produced `no such column: sn.business_id` — an
   owner (whose scope spans every business) never added the clause and saw the register perfectly.
   The detail route beside it had already met this and joined `branches` for the business; the list
   had not. `scopeFilter` now takes the business **through the branch** (`businessViaBranches`), and
   `GET /api/attendance/devices` had the same fault on `branch_devices` and is fixed with it.

**Front end.** `openReceive` gained a per-line serial textarea (shown only where the product is
tracked, hidden otherwise), a live hint counting units against numbers entered, a refusal in the
route's own sentence that OPENS AND FOCUSES the box, `serials` sent only for tracked lines, and a
receipt that names how many numbers went on file. Two element-lookup bugs were fixed on the way:
`ui.field` returns the WRAPPER div and appends the control to it, so `wrapper.querySelector('textarea')`
found nothing — the focus silently failed and the "N entered" counter read 0 however many labels had
been scanned.

**Verification.**
- `test/audit/audit.createFlows.js` — NEW, 15 checks. Business create whose message is compared
  count-by-count to the rows (`categories` / `accounting/accounts` / `customer-classes` / `products`),
  branch create (name-only, code derived, active), person create who then **signs in** and is read
  back at the role and branch that were asked for, the refusals (`ROLE_REQUIRED` for an owner
  creating an owner, `BRANCH_REQUIRED` for staff with no branch, the administrator allowed neither),
  the serial receipt in both directions (`SERIALS_REQUIRED` "2 expected" → numbers → every number on
  the register `IN_STOCK` at the branch, tied to a batch, order RECEIVED, `totals.receivedValue`
  ₦3,000), `SERIALS_NOT_EXPECTED` for numbers on an untracked line, and the plan cap refusing a
  branch over `max_branches` with `MAX_BRANCHES_REACHED` (then restored).
- `bash test/run-audits.sh` → **30 audits, every check green** (was 29).
- `npm run verify` → **479 pass / 0 fail**.
- `tools/flow-coverage.js` → **198 routes · 187 audited · 8 screen-only · 3 unreached** (was
  185 / 10 / 3). suppliers now 4/5, purchase-orders 5/5, businesses 3/3, users 12/14.
- Live walk on the demo: PO for a serial-tracked "Angle Grinder 4.5\"" → "Record the delivery" with
  nothing typed → the route's sentence, cursor in the serial box → two numbers → "Received in full. …
  2 serial number(s) are on file against the units."; serial `CF-…` on the register `IN_STOCK` at the
  branch; branch / business / staff creates all green, staff create with the branch left at its
  default (the misalignment).
