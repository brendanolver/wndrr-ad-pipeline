# Seasonal demand: which sales history should Creative Planning read?

Compared on 2026-10-12 (code and the Demand Planning repository's own validation records; no production system was queried).

| | ApparelMagic online sales (Batch 11 original) | Shopify online orders (Demand Planning feed logic, re-implemented here) |
|---|---|---|
| What it is | AM sales orders for the customers `ONLINE SALES` and `ICONIC ONLINE SALES`, one request per day per customer | Shopify orders and their line items |
| History | 365 days. Each extra year costs another ~730 requests, so more history is impractical | 365 days in the Demand app; one bulk export can read two or more years (this app defaults to 730) |
| Product matching | AM `style_number` (exact style code) | SKU, attached to a style by longest known style code (size or colour letters never guessed) |
| Completeness | A day/customer request that fails is skipped; before this follow-up that was silent. It is now counted and reported | One bulk export; an export that cannot be matched to its orders is refused; unmapped SKUs are counted and reported |
| Channel mix | Includes The Iconic (a marketplace, with its own promotions) | Online store only, which is the demand Meta ads drive |
| Returns | Order-line cancellations are netted (`qty - qty_cxl`); later returns are not | Units are `currentQuantity`: net of refunded and removed units |
| Cancelled and test orders | Only `credit_status = Approved` orders counted | Cancelled and test orders excluded explicitly |
| Day boundary | UTC calendar days | The shop's own time zone (Melbourne, daylight-saving aware) |
| Freshness | Crawl cached 12 h | Cached 12 h here; the Demand app refreshes every 4 minutes to 24 hours |
| Promotions | Not in the feed | Not in the feed (discount data is deliberately not requested) |
| Stock-outs | Not in the feed | Not in the feed |
| Evidence of accuracy | The Demand app found AM matched Shopify exactly on the Mystery Box peak days it checked (one product type, not the whole catalogue) | The Demand app validated its feed against Shopify's own reports: within 0.75% overall, nine product types exact |

Neither source knows about promotions or stock-outs. Seasonality handles that downstream: a month that looks like a stock-out is left out rather than read as weak demand, and a store-wide promotion surge is divided out by the store-wide median.

## Recommendation

Use **Shopify online orders** for seasonality, with ApparelMagic as the fallback. It is the demand the ads drive, net of returns and cancellations, in store-local days, cheap to refresh, and the only one of the two that can realistically provide a second season (which is what turns "one observed cycle" into evidence that a pattern repeats). ApparelMagic remains the source for stock, catalogue, launch dates and purchase orders.

## How it is wired (and how it is kept secure)

- `src/lib/shopifySales.js` reads Shopify directly from this server with `SHOPIFY_ADMIN_TOKEN` (environment only). The query asks only for order dates, cancelled/test flags and line SKU/quantity: no customer, address, price or discount field is requested.
- It does **not** call the Demand Planning app. That app's `sales-data` endpoint has no authentication, so Planning must not depend on it.
- There is no route that exposes the sales data, and the token never reaches the browser. The bulk result is downloaded only from Shopify's Google Cloud Storage hosts.
- `src/lib/seasonalSales.js` chooses the source (`SEASONAL_SALES_SOURCE`: `auto`, `shopify`, `apparelmagic`). The Shopify load takes minutes, so it never blocks a Planning request: until it lands, ApparelMagic is used (or seasonality is "unavailable" in `shopify` mode), and the page says which. A failed load is retried no more than every 15 minutes.
- The Planning "About this data" note names the source, the months and observed cycles, and anything incomplete (failed AM days, Shopify units that matched no known style, a token that cannot see older orders).
- `scripts/compare-seasonal-sources.js --i-approve-production-read` prints the two histories month by month. It reads production, so it has not been run.

## Setup (not done in this change)

Set `SHOPIFY_SHOP_DOMAIN` and `SHOPIFY_ADMIN_TOKEN` in Railway. Use a token of its own rather than the Demand app's: Shopify allows one bulk export at a time per app, and sharing a token can make the two apps collide (this app then falls back to ApparelMagic and says so).

## Does the Demand Planning `sales-data` function expose sensitive information?

Assessed from the code on the `V2` branch of `brendanolver/demandplanning` (read-only). I did **not** call the live endpoints, so whether Netlify itself puts a login in front of them is unverified.

- **`sales-data` itself: moderate.** It requires no authentication, allows any origin (`Access-Control-Allow-Origin: *`), and returns a year of units sold per SKU per day plus sync metadata (totals, dropped-line counts, the last error text). There is no revenue, price, cost, customer or order identifier in it. That is still commercially sensitive (best-sellers, sell-through, launch timing), and `lastError` can leak internal error text. Anyone who finds the URL can read it. A public GitHub repository makes the URL easy to find.
- **`sales-sync-background`:** unauthenticated `POST`. It is rate-limited by its own guards, but anyone can trigger Shopify bulk exports and background invocations.
- **More serious, in the same project:**
  - `am-proxy` is unauthenticated and, using the server's ApparelMagic token, serves `orders`, `order_items`, `products`, `inventory`, `warehouses` and `sku_warehouse` to anyone, and accepts `POST`/`PUT` to `orders`, so an anonymous caller could create sales orders in ApparelMagic.
  - `shopify-proxy` is unauthenticated and forwards any non-mutation GraphQL query with the Shopify admin token (the only block is on mutations). With a `read_orders` token that can include customer names, emails and addresses on orders.
  - `netlify/edge-functions/pipeline-proxy.js` contains a bearer token and a server IP address **in plain text in a public repository**. That token should be treated as exposed and rotated.
- **Recommendation (not done; the Demand Planning project must not be changed without approval):** put every function behind authentication (a shared secret header or Netlify Identity / site password), restrict CORS to the app's own origin, remove the committed token and rotate it, restrict `shopify-proxy` to the specific queries the app needs, and restrict `am-proxy` writes to the one place that needs them.
