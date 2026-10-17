# Checkpoint — water packing, bakery, and dispatch

Saved so each sample deploy has a named stage. Production is not in this plan.

## What the market does

A Nigerian packaged-water plant usually packs both forms in one factory: sachet (“pure water”) in bags of 20, and PET bottles. NAFDAC registers the premises and the product. Packaged water follows NIS 306, not the pharmacy Greenbook, and not NIS 554 (that standard excludes packaged water). The trade unit at the gate is the bag. A single sachet is still sold. Bottles move by the piece and by the pack of 12. Last-mile is a motorcycle, a keke, a car boot, a pickup or a van. Freight, not the bag price, decides whether a route pays.

A Nigerian bakery that both bakes and sells does two trades in one day: a walk-in buying one loaf, and a depot, kiosk, school or hotel taking a nylon of loaves before dawn. Bread, pies and snacks are short-life. Stale returns are ordinary. The load leaves on a van for wholesale and on a bike or keke for the neighbourhood.

Two ways the vehicle is paid for, and a business picks per vehicle type:

- The business owns the vehicle and pays the driver a wage. The drop is not a commission.
- The driver owns the vehicle and is paid a share of the sales they actually deliver.

A setup uses one vehicle type, or a mix of two. The common water mix is an owned pickup and partner kekes. The common bakery mix is an owned van and partner bikes. The owner confirms the mix; the software does not invent plates.

Drivers stay Staff. A bike is not a fifth stored role. The job title says Driver or Partner rider. Authority stays the four stored roles.

Both trades bill, then take payment, then release the goods onto the vehicle. A bill is not a receipt. The owner can turn that off.

Starter prices are samples. A bag is 20 times the sachet price because stock is counted in sachets. A depot price is the wholesale customer class, not a second hidden price.

## Stages

1. **Verticals — this checkpoint, then sample.** Water packing and bakery profiles: units, categories, starter catalogue, NAFDAC food/water compliance, retail and wholesale classes, bill before receipt. Dispatch rules exist and the vertical card shows the suggested mix. No plates, no migration.
2. **Dispatch — next checkpoint, then sample.** The owner confirms one or two modes. Fleet rows record class and arrangement. A delivery names the vehicle. A partner’s share is calculated when the drop is delivered, and recorded as a transport expense once, on purpose. An owned driver’s wage is not calculated per drop.
3. **Not in this plan.** A fifth stored role. Editing migrations 0001–0016. The pharmaceutical catalogue. Production deploy.

## Stage 1 status

Profiles and dispatch rules are in the tree and checked. Water packing and bakery bill before receipt, stay off the pharmacy catalogue, and show a suggested mix of two: an owned vehicle with a wage driver, and a partner vehicle paid on sales. Sample deploy follows this commit. Stage 2 (confirm the mix, fleet, and partner pay on a delivered drop) is not deployed yet.
