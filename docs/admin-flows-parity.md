# The platform administrator's powers — PharmaRidge vs StockRidge, and where the screen and the server disagree

Written 2026-10-06. Sources: `/home/user/uploads/0.txt` (PharmaRidge, 49,952 lines) and this repo at
`a73b582`. Every claim below is a line reference or a route in the tree, not an impression.

---

## 1. What PharmaRidge gives its administrator

PharmaRidge is single-tenant-per-client: one deployment, one client, one `client_settings` row, and a
platform `ADMIN` seat the client never sees (`'Platform Administrator'`, line 28888).

**The columns that carry the commercial position** (`client_settings`, lines 381-383):

| column | default | note |
|---|---|---|
| `max_branches` | 5 | hard cap |
| `max_staff` | 25 | hard cap |
| `subscription_status` | `ACTIVE` | `CHECK (status IN ('TRIAL','ACTIVE','SUSPENDED','EXPIRED'))` |
| `subscription_plan` | — | a name, printed in every refusal message |
| `subscription_renewal_date` | null | shown on the client's own screen |

**Three enforcement mechanisms, all server-side** (line 3949, stated as a design rule):

1. **Hard caps** — `assertCanAddBranch` / `assertCanAddStaff`, each throwing a `PLAN_LIMIT_EXCEEDED`
   whose message names the plan, the cap and the number already in use
   (`"Your plan allows a maximum of ${cap} branch(es) (currently using ${used}). To add more
   branches, please contact ${contactLine(settings)}…"`).
2. **Feature toggles** — `assertFeatureEnabled` for modules the plan does or does not include.
3. **A subscription gate** — `SUSPENDED` or `EXPIRED` stops **writes**, while **reads and exports
   keep working**, with the reasoning written down: *"the fastest way to guarantee the invoice is
   never paid"* is locking a shop out of its own books (line 4084).

   And one line that matters more than the rest: **`ADMIN` always bypasses the gate** — *"the vendor
   can never be locked out of their own client's instance, including while helping that client
   resolve the very suspension in question."*

**What the administrator's screen does** (Admin Portal, line 18236): usage cards
(`branches_used / effective_max_branches`, `staff_used / max_staff`, a status badge), the plan inputs
(Max Branches, Max Staff, plan name, status select `TRIAL/ACTIVE/SUSPENDED/EXPIRED`), feature toggles,
client branding (name + logo), and a save that takes effect immediately. The screen states the rule
out loud: *"Changes here take effect immediately and are enforced by the server, not just hidden in
the UI."*

**One plan detail worth copying:** effective branch cap is `multi_branch_enabled ? max_branches : 1`
(line 4011) — a plan can include "one branch", and the cap and the flag agree because one function
decides both.

**PharmaRidge has no self-service password reset at all**, and says why twice: *"There is no email
address or password-reset link. A forgotten PIN is reset by an authorised manager or …"* (line 48167),
and a password-reset capability *"cannot be closed by code alone"* (line 47395) — their test suite
even attempts an impersonation login to prove the vendor cannot sign in as an employee and ring a
sale. The admin's power is **to perform the reset**, not to hand out a link.

---

## 2. What StockRidge already has

`server/routes/admin.js` — 29 routes, `server/routes/index.js` mounting them at `/api` — plus
`domain/planLimits.js`, which is a **richer** model than PharmaRidge's: 53 settings keys, four
capabilities per role, a role ladder `ADMIN(4) > OWNER(3) > MANAGER(2) > STAFF(1)`, and eight
authority functions (`canVoidSale`, `canAdjustStock`, `canSpendFromSafe`, `canDiscount`,
`canSellOnCredit`, `canApproveExpense`, `canEditPrices`, `canOverrideCreditLimit`).

| power | route | rule |
|---|---|---|
| businesses | `GET/POST /api/businesses`, `PUT /api/businesses/:id` | create capped |
| branches | `GET/POST /api/branches`, `PUT /api/branches/:id` | create capped, needs `multi_branch_enabled` |
| staff | `GET/POST /api/users`, `PUT /api/users/:id` | create capped, `STAFF` only |
| **PIN reset** | `POST /api/users/:id/reset-pin` | role superiority, weak-PIN refusal, `pin_changed_at` |
| sessions | `GET /api/sessions`, `POST /api/sessions/:userId/revoke` | **PharmaRidge has no equivalent** |
| business access | `GET/POST /api/users/:id/business-access`, `DELETE …/:businessId` | **PharmaRidge has no equivalent** |
| settings | `GET/PUT /api/settings` | 53 keys, per-field validation, coherence checks, audit-logged |
| plan | `GET /api/plan` | plan, status, renewal, caps, usage, feature labels, live counts |
| audit chain | `GET /api/audit`, `/verify`, `POST /anchor` | hash-chained, **PharmaRidge has no equivalent** |
| notifications | `GET /api/notifications`, `POST /:id/read`, `/read-all` | **PharmaRidge has no equivalent** |

**StockRidge is ahead of PharmaRidge on:** PIN reset with role rules, remote session revocation,
per-user business-access grants, a verifiable hash-chained audit log with anchoring, a notification
engine, four verticals, serials/warranty, delivery/instalments/deposits/change-owed, and the Nigerian
WHT/VAT work. **And its deliberate non-port is right**: no self-service password reset, for exactly
the reason PharmaRidge documents.

---

## 3. The gaps — highlighted

### GAP 1 — *A client owner can rewrite their own commercial terms.* **This is the serious one.**

`PUT /api/settings` is guarded by `atLeast(user.role, 'OWNER')` (admin.js:1035), and `ROLE_RANK` puts
`OWNER` at 3 with `ADMIN` at 4 — so **an owner passes**. And the six commercial keys are writable
through that route, because `allowed = Object.keys(DEFAULT_SETTINGS)` and `DEFAULT_SETTINGS` contains
`max_businesses`, `max_branches`, `max_staff`, `subscription_status`, `subscription_plan` and
`subscription_renewal_date` (verified by evaluating the module, not by grepping it).

So the client can, with a devtools call or a queued offline write:

* raise their own `max_branches` / `max_staff` / `max_businesses`,
* set `subscription_status` back to `ACTIVE` after a suspension,
* rename their plan and move their own renewal date.

The product already knows this is wrong — the screen's own contract test says
*"commercial: set by the deploy tool and by renewal, **not by the client**"*
(`test/unit/settings-controls.test.js:149-154`) — and the screen honours it by not drawing the
controls. **The UI is stricter than the API.** Hiding a field is not a permission. Today the only
thing standing between a client and their own plan is that nobody told them the key names.

### GAP 2 — *The admin's bypass has been written and never wired.*

`assertSubscriptionActive(settings, user, { allowRead })` returns early for `ADMIN` — the vendor
cannot be locked out. It is called in exactly three places, and **every one of them passes only
`settings`** (admin.js:88, 261, 445). With `user` undefined the bypass can never fire, so on a
suspended account the vendor cannot create the very branch or business they are on the phone to fix.

### GAP 3 — *Suspending an account achieves almost nothing.*

The gate is called on those same three creates. It is **not** called on ringing a sale, taking a
payment, spending from the safe, adjusting stock, or receiving goods. A shop that stops paying keeps
trading indefinitely. PharmaRidge's whole commercial lever — writes pause, reads and exports carry
on — is not enforced here at all.

### GAP 4 — *The administrator has no screen for the powers that are his alone.* — **CLOSED in P10**

`SETTING_GROUPS` (`public/js/views/admin.js:65`) deliberately omits the six commercial keys, and no
other view draws them. The plan screen (`public/js/views/plan.js`) reads them. So the *only* way to
change a client's plan, caps, status or renewal date in the shipped product is a hand-made HTTP call.
PharmaRidge's admin portal is the exact opposite: those four inputs are the first card on the page.

**Closed:** the Subscription screen now draws a **Platform controls** card for the `ADMIN` role —
the three caps (with "0 means unlimited"), the plan name, the status select and the renewal date —
saving through `PUT /api/settings` and reporting the server's `warnings[]` (a cap set below the
usage already on the books) and its refusals. An owner sees the same numbers with no inputs and a
line saying the limits are set for them. Driven from both sides by `tools/frontend-platform.js`.

### GAP 5 — *"Unlimited" is displayed and enforced as "none".*

`plan.js:274` renders `maxBranches === 0` as **"Unlimited"**; `limitBar('Branches', used, max)` draws
a 0-cap bar the same way. But `assertCanCreateBranch` computes `const max = Number(settings.max_branches || 0)`
and throws when `used >= max` — so **0 blocks everything**. An operator who reads the plan screen,
decides a client should have unlimited branches, and sets 0 has locked them out of ever opening
another one, and the refusal will read *"includes 0 branches"*.

### GAP 6 — *The notification engine writes messages nothing can read.*

`GET /api/notifications` is reachable from no screen; `POST /api/notifications/:id/read` and
`POST /api/notifications/read-all` are reachable from no screen either (`tools/flow-coverage.js`
verdicts: `None` / *not reached by any screen*). The product raises notifications — low stock, debt
ageing, expiry, plan warnings — and the client has no way to see or dismiss one.

### GAP 7 — *The commercial surface has no audit.*

| flow | routes audited |
|---|---|
| plan | 0 / 1 |
| audit trail (list, verify, anchor) | 0 / 3 |
| sessions (list, revoke) | 0 / 2 |
| notifications (list, read, read-all) | 1 / 3 |
| business-access writes | 0 / 2 |

`PLAN_LIMITS_CHANGED` is an allowed audit action (`server/lib/audit.js:51`) that **nothing ever
records** — the write path it was named for was never built. When a vendor changes a client's plan,
the change is currently logged under the generic `SETTINGS_UPDATED`, so "who lowered this client's
staff cap" is not a question the audit trail answers quickly.

---

## 4. The plan to close them, in stages

| stage | what | why in this order |
|---|---|---|
| **P8a** | Plan fields become **ADMIN-only**; `PLAN_LIMITS_CHANGED` recorded; a cap set below current usage warns rather than traps; **0 = unlimited** in all three caps so the screen stops lying; the ADMIN bypass wired into every gate call | the authority and the meaning have to be right before anything is built on them |
| **P8b** | The subscription gate as a **route-level rule** on every trading write, with an explicit allowlist (login, change-pin, logout, reads, exports, sync pull, notifications read) and the ADMIN bypass — suspending an account finally means something, and a suspended shop can still read and export its books | the vendor's largest lever; it is also the fastest way to break a live shop, so it goes in alone, with its own audit, and the app shell must say *why* writes are refused |
| **P8c** | The **Platform** screen (for `ADMIN`, and read-only for the owner): caps with usage bars, plan name, status, renewal date, contact line — plus the **notifications board** with read / read-all | the powers exist but are unreachable; the UI must be as strict as the API and no stricter |
| **P8d** | `audit.platformAdmin.js` — two-way, on staging: cap set below usage → the client's create is refused with the code and the number; raised → allowed; suspended → trading refused, **reads and exports still work**, ADMIN still works; plan renamed → the refusal message quotes the new name; owner attempts a plan change → 403; a notification is raised, read, and disappears from the unread count; a session is revoked and the token is dead on the next call | each of these is a claim in this document, and none of them is worth anything unproven |

**P8a is implemented with this document.** P8b, P8c and P8d follow as separate checkpoints, each
pushed to GitHub on its own.
