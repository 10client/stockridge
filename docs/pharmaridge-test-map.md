# PharmaRidge tests, mapped onto StockRidge

Date: 2026-10-13. Source: `/home/user/uploads/0.txt` (the PharmaRidge dump). The dump lists the test files. It does not include their bodies, so this stage replicates the pharmacy and supermarket rules the dump implements, and records where each named file already lives in StockRidge.

The Greenbook (`nfdc.txt`, 6,801 rows) is a reference catalogue in `0013_nafdac_catalog.sql`. It is not part of the shared Nigerian-market list, and it is not priced.

## Replicated this stage

| PharmaRidge behaviour | StockRidge proof |
| --- | --- |
| POM sale without `prescriber_name` is refused (`PRESCRIPTION_REQUIRED`) | `test/unit/pharmacy.test.js`, `test/integration/pharmacy-supermarket.test.js` |
| An empty `controlled_kyc` object is not an identity (`CONTROLLED_KYC_REQUIRED`) | same |
| A controlled dispense writes a hash-chained register row | same |
| A void appends a `VOID` row and does not delete the dispense | same |
| OTC sells with no prescription | same |
| Expired dated stock cannot be sold | `selectBatchesFifo(..., { asOf })` and the supermarket integration test |
| NAFDAC search and adopt into the shop's own catalogue | `GET /api/nafdac`, `POST /api/nafdac/:id/adopt` |
| Supermarket aisles file alphabetically and post as separate category sales | supermarket integration test |
| Pharmaceutical and supermarket profiles provision a starter catalogue | `domain/verticals.js`, same integration test |

## Already in StockRidge under another name

These PharmaRidge files are not copied again. The behaviour they name is already covered here.

| PharmaRidge file | StockRidge home |
| --- | --- |
| `test/audit.money.js` | `test/audit/audit.money.js`, `test/integration/sales.test.js` |
| `test/audit.wht.js` | `test/audit/audit.wht.js` |
| `test/audit.sync.js` | `test/audit/audit.sync.js` |
| `test/audit.http.js` | `test/audit/audit.http.js` |
| `test/audit.roles.js` | `test/audit/audit.roles.js` |
| `test/audit.concurrency.js` | `test/audit/audit.concurrency.js` |
| `test/audit.staff.js` | `test/audit/audit.staff.js` |
| `test/audit.manager.js` | `test/audit/pairs/` and `test/audit/audit.roles.js` |
| `test/audit.owner.js` | `test/audit/audit.roles.js` |
| `test/audit.inventory.js` | `test/integration/stock-receive.test.js`, `test/audit/audit.stockTransfers.js` |
| `test/audit.catalog.js` | `test/audit/probe-catalog-write.js` |
| `test/audit.expiry.js` | expired-stock refusal in `test/integration/pharmacy-supermarket.test.js` |
| `test/audit.retail-categories.js` | category sales in `test/integration/sales.test.js` and the supermarket test |
| `test/audit.customers.js` | `server/routes/customers.js` plus sales credit tests |
| `test/audit.returns.js` | `test/audit/audit.returns.js` |
| `test/audit.data-management.js` | `test/audit/audit.data.js`, `test/integration/data-management-purge.test.js` |
| `test/audit.single-session.js` | `test/audit/audit.sessions.js` |
| `test/integration.test.js` | `test/integration/sales.test.js` and the rest of `test/integration/` |

## Named in the dump, not re-run as browser probes this stage

The dump's browser probes (splash, theme, responsive, soak, three-month simulation, role UI probes) need a live browser and are not pharmaceutical rules. They stay listed so the next stage can port any that StockRidge does not already cover. They are not claimed as done here.

Also named in the dump and not re-run as new files this stage: `test/audit.adminowner.js`, `test/audit.barcode-flow.js`, `test/audit.branchscope.js`, `test/audit.concurrent-pos-sales.js`, `test/audit.d1limits.js`, `test/audit.docs.js`, `test/audit.exports.js`, `test/audit.harness.js`, `test/audit.managerstaff.js`, `test/audit.ownermanager.js`, `test/audit.plan-downgrade.js`, `test/audit.promotionauthority.js`, `test/audit.rolelabels.js`, `test/audit.rolelifecycle.js`, `test/audit.staffstaff.js`, `test/audit.vendorseat.js`, `test/audit.workflows.js`.

`test/tools/probe-admin.js`, `probe-admin-ui.js`, `probe-admin-adversarial.js`, `probe-owner.js`, `probe-manager.js`, `probe-staff.js`, `probe-lifecycle.js`, `probe-login-lifecycle.js`, `probe-responsive.js`, `probe-theme.js`, `probe-cors.js`, `probe-cron.js`, `probe-soak.js`, `probe-offline-durability.js`, `probe-stale-replay.js`, `probe-transient.js`, `probe-toast-recovery.js`, `probe-overlap.js`, `probe-ux-sweep.js`, `probe-formbaseline.js`, `probe-topbar.js`, `probe-input-guidance.js`, `probe-barcode-ui.js`, `probe-retail-category-ui.js`, `probe-pos-checkout-lifecycle.js`, `probe-pos-mobile-payment-input.js`, `probe-password-reveal.js`, `probe-promotion-dropdown.js`, `probe-role-triggers.js`, `probe-data-management-ui.js`, `probe-change-owed.js`, `probe-cashfloor.js`, `probe-safe.js`, `probe-safe-till.js`, `probe-split-cash.js`, `probe-payment-retry.js`, `probe-reversals.js`, `probe-quantity.js`, `probe-receiving.js`, `probe-unit-alignment.js`, `probe-wht-sale.js`, `probe-crossdomain.js`, `probe-sync-gaps.js`, `probe-icon.js`, `probe-splash-transparency.js`, `probe-manual.js`, `test/audit.frontend.js`, `test/audit.responsive.js`, `test/audit.pwa.js`, `test/audit.live.js`, `test/audit.e2e.js`, `test/audit.golive.js`, `test/audit.three-month-simulation.js`, `test/tools/simulate-three-months.js`.
