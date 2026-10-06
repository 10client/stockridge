
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
