# Client handover

What to do in the first hour, in order, with a real business watching.

## Before the client arrives

```bash
node tools/deploy-cloudflare.js
```

Confirm the summary says `readiness : awaiting_first_business` and write down the
PIN. Then open two things in a browser and leave them there:

- `https://stockridge.stockridge.workers.dev/api/diagnose` — every check must pass
- `https://stockridge.stockridge.workers.dev` — the app itself

## The handover state, and why it looks empty

A fresh deployment contains exactly three things:

| | Count |
|---|---|
| Administrators | **1** — no business, no branch |
| Withholding rates | 10 (the 2024 Regulations, as editable data) |
| Client settings | 1 row (defaults) |

**No businesses. No branches. No products. No staff. No sales.** That is not an
unfinished deployment; it is the whole point. The client's first act is to
describe *their* business, and the platform builds the rest from that answer —
chart of accounts, product categories, units of measure, customer classes, price
lists, warranty rules and a starter catalogue, all specific to their vertical.

Anybody signing in as the administrator sees an empty Businesses screen and one
obvious button. That is the intended first impression.

## The first hour, in order

### 1. Create the business (2 minutes)

Sign in as the administrator → **Businesses** → **Create a business**.

| Field | What it decides |
|---|---|
| Name | Appears on receipts, reports and the installed app's name |
| **Vertical** | The whole provisioning result. Choose carefully; it is the one field whose consequences are hard to redo. |
| VAT registered | Whether a 7.5% VAT line is extracted from inclusive prices |
| First branch | Name, city, state, opening cash — the opening cash becomes a TILL_FUND entry in the branch safe ledger |

| Vertical | For |
|---|---|
| Electronics, Appliances & Gadgets | Phone, TV, generator, inverter, small appliance dealers. Serial and warranty behaviour is strongest here. |
| Furniture & Home Furnishings | Showroom and made-to-order. Bulk units, delivery and installation jobs. |
| Wholesale & Retail General Merchandise | Cartons, price tiers by customer class, credit sales |
| Building Materials & Hardware | Cement, tiles, rods, plumbing. Both bulk and unit sale of the same product. |
| General Retail | A configurable starting point when none of the above fits |

Wait for provisioning to finish — it writes the chart of accounts, categories,
customer classes, price lists and starter products in one transaction. The screen
reports what it built.

### 2. Create the owner (2 minutes)

**Users** → **Create user** → role **OWNER**, attached to the business.

The owner is the client's account, not the vendor's. Set their PIN, give it to
them, and have them **sign in and change it** before you leave the room
(Account → Change PIN). An owner is scoped to their own business and can do
anything inside it; the platform administrator is scoped to *nothing* and exists
only to create businesses.

**Do not leave the client using the administrator account.** If they do, every
sale in their database is attributable to a vendor account, and the audit trail
nobody looks at until a dispute is worthless.

### 3. Branches and staff (10 minutes)

Each additional branch, then the managers and cashiers for each. A manager is a
single stored role with `branch_id` as the only scoping truth: a manager
transferred from one branch to another stops seeing the first branch's takings on
their very next request, without waiting for their token to expire.

For each staff member: full name, username, **branch**, role, PIN. The job title
is display-only and free text — "Head of Sales", "Store Keeper", whatever they
call it.

### 4. Bring in stock (with the client, not for them)

**Stock → Receive.** Choose supplier, add lines, enter quantity and cost price,
save.

This is the step worth doing *with* the client rather than for them, because it is
the one they will do every week, and it teaches the two numbers that matter:
**cost price per unit** and the batch that gets created. Batches are why landed
cost is real here — a second delivery at a higher price does not silently revalue
the stock already on the shelf.

### 5. Open a till, make the first sale (5 minutes)

**Till → Open till** with the counted opening cash. Then a real sale, on a real
product, to confirm:

- the receipt prints or saves
- the price is right, and VAT is inside it rather than added on top
- the stock figure went down

Then **Till → Close till**, and have them count the cash. A variance requires a
reason, which is the point: the safe ledger explains every naira.

## Things to say out loud, once

| | |
|---|---|
| **The PIN is a signature** | Every sale is attributed to a PIN. Sharing one is sharing a signature — and the system reports on who rang up what. |
| **Sign out on a shared device** | One active session per user: signing in somewhere else retires the first, and the retired device is told why. |
| **It works offline** | If the network drops, keep selling. Sales queue on the device and post when it returns. Nothing needs to be remembered or written down. |
| **Do not clear the site data** | The offline queue lives in the browser's storage. "Clear browsing data" on a till with unsynced sales deletes them. |
| **Nothing is ever really deleted** | Deleted rows are kept for audit. This is a feature in a dispute and a surprise otherwise. |
| **VAT is extracted, not added** | A ₦10,750 price with VAT registered is ₦10,000 plus ₦750. The setting is per business. |

## What is NOT included, stated plainly

- **No automated SMS.** Debtor reminders are generated in-app and printed,
  exported or sent by hand. An SMS gateway is a per-client commercial decision.
- **No card or transfer integration.** Payment methods are recorded, not processed.
  The till reconciles what was taken, by method.
- **No file uploads.** Product images are URLs; proof of delivery is a signature
  captured on the device. See [storage-and-r2.md](storage-and-r2.md) for what it
  takes to add real photo storage.
- **No automatic backups.** D1 keeps a recovery window, and an export is one
  command — but the command is a human's job, and it should be scheduled from day
  one. See [d1-operations.md](d1-operations.md).

## The first week

| When | Who | What |
|---|---|---|
| Day 1 end | Client | Close the till, count the cash, note the variance and why |
| Day 2 | Client | Open till, first stock receive by their own hand |
| Day 3 | Vendor | Read `/api/diagnose` and the Reports screens with them |
| Day 7 | Vendor | Review stock figures against a physical count of ten products. This is where a data-entry mistake from week one surfaces while it is still cheap. |
| Day 30 | Vendor | First monthly report; agree the backup schedule in writing |

## If the client asks for something that is not there

Write it down, deploy nothing, and say when it will be considered. The failure
mode this avoids is a weekend change deployed to production because an owner
asked at the counter — after which the shop's data is on a version nobody tested,
and the person who made the change is on a call at 9pm.
