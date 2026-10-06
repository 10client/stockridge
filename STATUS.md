
### P4 live leg (2026-10-06)

`AUDIT_WRITE=1 AUDIT_BASE=https://stockridge-staging.stockridge.workers.dev node
test/audit/audit.fulfilment.js` → **18/18 in 11.9 s**, on a deployment holding two real
businesses and a shelf stacked from earlier runs, and every fixture retired itself (the plan,
the deliveries, the installation and the settled customer).

Deployed after the two instalment fixes: staging `readiness: ready`, sample and production
`awaiting the first business — this is the expected handover state`. Before this stage the
instalment flow was unreachable on all three environments: a manager opening a plan was told
the record "refers to something which does not exist".

**Six reader/fixture mistakes on my side, all caught by the rule the P2 leg produced** (a
reader that cannot find its field must fail loudly rather than answer zero or undefined):
the plan detail answers under `progress` (the list answers under `summary`); the delivery
detail answers under `job`; an absent note is `MISSING_FIELD` and a too-short one is
`NOTE_REQUIRED`; a delivered sale reads `COMPLETED` by design (it is `PENDING_DELIVERY` while
the goods are on the road); a fixture's name must be built once rather than read back from a
route that replies with a message; and the business's minimum deposit is a requirement of the
instalment flow, not an obstacle to testing it. None of these was a product defect and all
six were reported as one until read.
