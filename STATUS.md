
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
