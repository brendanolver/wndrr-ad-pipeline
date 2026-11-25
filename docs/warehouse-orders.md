# Shoot Plan > Send to Warehouse (v1.9.5)

The samples a week's Shoot Plan needs from the warehouse can be sent straight to the warehouse as an ApparelMagic order. Before this, someone downloaded the CSV and raised the order by hand.

## What staff see

Planning > Shoot Plan has a **Send to Warehouse** panel under the summary bar.

* It lists every selected colourway that is **not** marked "already in the office", one piece each. These are the same rows as the Warehouse Pick List CSV.
* Staff pick a **needed by** date. It defaults to the next working day, and it can't be in the past.
* The panel shows the **Customer PO** the order will carry, e.g. `AD SHOOT 28/11/26`, and a fresh stock look for each sample.
* **Send N samples to warehouse** asks once more ("Send 6 samples to the warehouse, needed by Fri 28 Nov?"). Then it creates ONE ApparelMagic order under the **WNDRR SHOOT STOCK** customer.
* Once sent, the panel shows the ApparelMagic order number, PO, sample count, date and who sent it.
* Samples added to the plan after an order are offered as the week's next order, with `#2`, `#3` and so on on the PO. Samples taken off the plan after ordering are not un-ordered: cancel or change those in ApparelMagic.
* Anything that stops an order is listed in plain words: a missing size, no stock, or ordering switched off.
* A refused order says why, and nothing was created.
* If ApparelMagic's answer was unclear, the week is held. **Check ApparelMagic** records the order if it exists. If none exists after a 30-minute wait, **Clear it so it can be sent again** frees the week.
* Past weeks show their orders but can't be ordered for.
* **Export CSV** still works as the manual fallback.

## How it works

This app **never writes to ApparelMagic**. Its ApparelMagic client stays GET-only (`test/noWritesGuard.test.js`).

1. The page asks `GET /api/warehouse-orders?week_start=…&due_date=…` (signed-in Planning users only).
2. The server reads the week's samples from **this app's database** (`src/lib/warehouseOrders.js`, `weekItems`). The browser never sends the list.
3. The server sends them to **Tuesday**: `POST {TUESDAY_URL}/api/creative-pipeline/shoot-orders` with a shared key. Tuesday works out what is still to order, then places the order through the same checks as its own shoot orders:
   * a live stock check;
   * a Customer PO search, so nothing is ordered twice;
   * a read-back of ApparelMagic's own copy before the order counts as placed.

   Tuesday keeps the record.
4. To place, the page sends back the fingerprint of what it showed. Tuesday refuses if anything changed in between, so what is ordered is exactly what was reviewed.

If Tuesday doesn't answer while placing, the page says the order **may** have gone through and not to send it again. Reloading shows what Tuesday recorded.

## Settings (Railway variables, never in the repository)

| Variable | Value |
|---|---|
| `TUESDAY_URL` | Tuesday's address, e.g. `https://wndrrtuesday-production.up.railway.app` |
| `TUESDAY_ORDERS_KEY` | The same value as Tuesday's `CREATIVE_PIPELINE_API_KEY` (at least 32 characters) |

If either is missing, the panel says ordering isn't switched on, and Export CSV works as before.

**Off switch:** remove `CREATIVE_PIPELINE_API_KEY` from Tuesday, or `TUESDAY_ORDERS_KEY` from this app. Ordering also stops if Tuesday's shoot ordering is switched off.
