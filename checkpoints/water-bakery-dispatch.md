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
3. **Credit until paid, the drop, and plant stock — this checkpoint, then sample.** A shop supplied on credit does not collect the next batch until that supply is paid. Cash is not held. The drop records what that transaction was. Customer GPS is optional. Manufacturing inputs and machinery service are counted. An owner can turn both rules on for any vertical. No fifth stored role. No leather seed. No Greenbook. No production deploy.

## Stage 1 status

On sample as `ridge-20261017-1419-1c58091`. Water packing and bakery can be created. The vertical card shows the suggested mix. The owner could not yet save a different mix, and a drop could not yet name a vehicle.

## Stage 2 status

On sample as `ridge-20261017-1426-722d373`. An owner saves one or two modes. A manager adds a vehicle that matches a saved mode. Marking a drop delivered calculates a partner’s share of the goods, excluding the delivery fee, and records that payout once as a transport expense. An owned driver is not paid from the drop. Production was not deployed.

## Stage 3 status

On sample as `ridge-20261017-1454-31072cf`. Not production.

A Nigerian plant often supplies a shop on credit and does not release the next batch until that supply is paid. A hawker who pays cash the same day is not held. This is trade credit, not consignment: the books already keep the debt on the customer. There is no second ledger.

What this stage does:

- The administrator can message every owner. The message names the business. An owner is not hidden because their home business is a different plant.
- A credit sale, when the vertical holds the next batch, stays at the plant while that customer still owes. An owner can release one batch. The reason is kept on the sale. Staff cannot release it. Cash is never held.
- Each drop stores the terms, the goods value, what was paid, what is still owed, the customer name and phone, and a note of what happened on that drop. Marking it delivered refreshes that snapshot. Older drops still show the sale.
- A customer pin is optional. Both coordinates, or neither. Blank clears it.
- Manufacturing inputs are stock and are not offered at the till unless the plant also sells them. Film, flour and sugar already in a catalogue are marked as inputs once. Treatment chemical and yeast are starter inputs. Leather is not invented: the plant adds what it uses.
- Machinery service, packer wages, treatment and bakery gas are expense categories, and the service cost is counted on the deliveries board.
- Either rule can be turned on for another vertical, or off for a plant that only sells cash. They are not pharmacy switches.

Still not in this plan: a fifth stored role, editing migrations 0001–0017, the pharmaceutical Greenbook, a bill of materials, and a production deploy.

## Selling terms

On sample as `ridge-20261017-1517-8befc9e`. Not production.

A cashier or a dispatch rider can sell on the spot or on credit, where the vertical allows both. A bakery and a water plant allow both. Other verticals follow whether a customer class is allowed credit, and an owner can turn either way on or off. The choice is stored on the sale and on the drop. Paid on the spot prints a receipt. A credit supply prints an invoice, and that paper stays an invoice even after the balance is later zero. Money taken later prints its own receipt, not a second invoice.


## Who attaches the load

On sample as `ridge-20261017-1643-30ee24d`. Not production.

A manager, an owner, or the administrator attaches the staff, the vehicle, and the amount of each product. The phone, the plate, and whether the person is on a wage or a share follow those records. A cashier or a driver can still record what happened on the drop — status, who received it, the pin, and whether it was credit or paid on the spot — but cannot change who was sent, which vehicle, or how much went out. A confirmed dispatch mix cannot leave until that attachment is saved. A smaller amount than the sale does not put the rest back on the shelf.

## Machines, tools, and production stock

On sample as `ridge-20261017-1759-4161f46`. Not production.

A plant that manufactures keeps two records, and they are not the same thing.

A machine or a tool is gotten once. The register stores the day, the price paid, who it was bought from, and the serial if it has one. Each repair is an expense on the books the plant already uses, pointed at that machine, so the maintenance it has taken is a sum. When it stops working, the date and the reason stay. It is not deleted. Putting it back in use keeps the earlier stop in the notes. The purchase price is the record of what was paid when it was gotten. It is not posted again as if it were bought today.

Production stock is film rolls, flour, sugar, yeast, alum, chlorine, filter cartridges, and whatever else that plant uses. Each delivery records the day, the price, and the amount on the same stock batches as any other goods received. It is not a second inventory, and it is not a recipe. Leather is not invented. A price is not guessed: a new input starts at zero until the plant records what it paid. Other businesses turn manufacturing on and add the machines and inputs they actually have.
