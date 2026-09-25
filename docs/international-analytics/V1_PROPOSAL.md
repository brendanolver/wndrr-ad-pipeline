# International Performance Dashboard: V1 Proposal

Status: proposal for review. No application code written yet.
Date: 25 September 2026

The question this app answers: for every $1 of Meta spend in a country, what
Shopify revenue comes back from that country, what do those customers buy, and
is it getting better or worse?

---

## 0. What the live data says before we build

Before designing anything I pulled real numbers from Shopify (last 90 days,
net sales in AUD, grouped by shipping country):

| Country | Orders | Net sales (AUD) |
|---|---:|---:|
| Australia | 16,921 | 2,577,353 |
| New Zealand | 671 | 111,631 |
| United States | 224 | 35,651 |
| United Kingdom | 56 | 8,377 |
| Canada | 45 | 7,662 |
| Germany | 23 | 3,167 |
| Next 19 countries combined | ~100 | ~18,000 |

International (everything except AU) is roughly **$184k over 90 days, about
6.7% of net sales**. New Zealand is about 60% of that. Outside NZ and the US,
no single country averages one order a day. The UK is 56 orders in 90 days.

This changes the design in three ways:

1. **Sample size must be visible everywhere.** A UK "top products" table for the
   last 30 days is built from about 19 orders. Daily MER for the US is built
   from two or three orders a day. Without sample sizes on screen the app will
   produce confident-looking numbers from noise. Every ratio shows the order
   count behind it, ratios built from fewer than 10 orders (configurable) are
   greyed and marked "low sample", and small countries roll into "Rest of
   World" with an expand toggle. This is a data-quality flag, not a good/bad
   threshold.
2. **Country charts default to weekly buckets** when the range is 28 days or
   longer, with a daily toggle. Daily lines for low-volume markets are mostly
   zeros and spikes.
3. **Country MER is an average, not a marginal return.** NZ will show a strong
   MER partly because New Zealanders buy WNDRR without ads (proximity, AU brand
   spillover). A high MER does not mean more spend returns the same. The
   spend-vs-revenue chart helps, and I recommend one extra cheap metric:
   **New Customer MER** (first-order revenue / Meta spend). Prospecting spend
   mostly buys new customers, so this isolates the part of revenue Meta is most
   plausibly responsible for. It uses data we are already storing.

A real example the app should make obvious on day one: US weekly orders went
26, 14, 5, 2, 1, 2, then 20, 23, 24 between late July and late September. That
looks like spend paused and restarted. It is a good first validation case.

---

## 1. What already exists in this repo

| Finding | Consequence |
|---|---|
| Node 18 + Express + Postgres on Railway. No-build vanilla JS frontend. `public/app.js` is a single 8,459-line file. | Reuse the stack. Do not add the dashboard into `app.js`. |
| Per-user login with roles (`admin`, `marketing`, `creative`, `viewer`) and a `role_permissions` table (`src/lib/permissions.js`). | Gate the dashboard with a new `analytics.view` permission. |
| `src/lib/metaAds.js` already syncs Meta **ad identity** (IDs, names, statuses, campaign and ad set names) into `meta_ads` every 45 minutes. No spend or performance data. | Extend, do not duplicate. The new insights sync sits beside it. |
| `src/lib/metaAdNameTemplate.js` already parses the 11-field ad naming convention (`#315_26-WK32_03-08_PULSE_HEAVY WEIGHT TEES_...`) into `parsed_product_raw`, `parsed_product_type_raw`, `parsed_concept`, etc. | Ad-to-product mapping is half built. V1 reuses it. |
| `meta_product_mappings` maps (Meta product, product type) to an internal `product_code`. | This is the join from Meta ads to WNDRR products. |
| Style code = first 11 characters of the Shopify SKU, product family = first 8 (`deriveProductCode`). `styles.tier` holds `core_proven` vs `new_drop`. | Gives "core vs non-core" and the SKU-to-ad-mapping key for free. |
| `metaAds.js` pins `GRAPH_API_VERSION = 'v21.0'`. Published summaries of Meta's changelog say v24.0 is now the oldest supported version (v23.0 expired 9 June 2026). I could not open Meta's developer site from this environment to confirm directly. | The existing Meta sync may already be failing or running on an auto-upgraded version. Check production logs. The new code reads the version from `META_API_VERSION` and I will bump the existing module to match. |
| No Shopify API client. `reportPipeline.js` reads a `shopify_sales` CSV (SKU, day, quantity, product type) from an internal service. | Not usable here: no country, customer, order, discount or refund data. |
| Schema is `db/schema.sql` re-run on every boot, with 65 appended `ALTER TABLE` lines. | Fine for small CRUD tables, poor for an analytics schema that will evolve. Analytics gets numbered migrations. |
| No tests in the repo. | Add `node:test` (built into Node, no dependency) for KPI definitions and parsers. |

---

## 2. Architecture

### Recommendation: same repo and database, separate module, separate worker

Build it inside `wndrr-ad-pipeline`, not as a new app. The ad-name parser, the
Meta product mapping, style codes, core/drop tiers, user accounts and Meta
credentials already live here. A separate app would fork the ad-to-product
mapping, which is the thing you most need to stay single-source.

Keep it structurally separate so it does not tangle with the creative pipeline:

- Code under `src/analytics/`.
- Tables in a Postgres schema called `analytics`.
- Numbered migrations in `db/analytics/NNN_*.sql`, tracked in
  `analytics.schema_migrations`.
- Its own frontend entry at `public/analytics/` (own HTML, native ES modules,
  still no build step), linked from the existing sidebar.
- **Syncing runs in a separate Railway service** from the same repo
  (`npm run worker`). The web service only reads Postgres. No page load ever
  calls Shopify or Meta. A deploy or crash of the web service never interrupts
  a backfill, and a stuck sync never slows the dashboard.

### Data flow

```
Shopify Admin GraphQL ──> connectors/shopify ──┐
Meta Marketing API    ──> connectors/meta    ──┤  idempotent upserts,
(later) Google Ads, Klaviyo, COGS, 3PL costs ──┘  checkpointed per job
                                               │
                                               v
                         analytics.* source tables (Postgres)
                                               │
                  materialised daily rollups (refreshed after each sync)
                                               │
                  metrics/definitions.js  (every KPI formula, in one place)
                                               │
                        /api/analytics/*  (read-only JSON)
                                               │
                        public/analytics/  (dashboard)
```

### Folder layout

```
src/analytics/
  connectors/
    shopify/  client.js   auth, GraphQL, cost-based throttling, bulk operations
              orders.js   order + line + refund mapping
              products.js products, variants, collections
    meta/     client.js   version, rate-limit headers, async report runs
              insights.js account- and ad-level insights by country by day
              entities.js campaigns, ad sets, ads
  sync/       runner.js   job registry, advisory locks, sync_runs logging, retries
              schedule.js cadence per job
  rollups/    refresh.js
  metrics/    definitions.js, periods.js
  routes/     overview.js, country.js, products.js, metaAds.js, sync.js
  worker.js
public/analytics/
  index.html, app.js, views/*.js, components/table.js, components/chart.js
db/analytics/
  001_init.sql, ...
test/analytics/
  metrics.test.js, shopifyOrderMapping.test.js, ...
```

### Connector contract (how Google Ads, Klaviyo, COGS plug in later)

Every source implements the same four things: `backfill(from, to)`,
`incremental(since)`, writes only to its own source tables, and records a
`sync_runs` row. Its checkpoint in `sync_state` only advances after the write
commits, so a crash resumes from the last good point. Ad platforms write into
the shared `ad_*` tables with a `platform` column (`meta`, later `google`).
Cost sources write into the cost ledger (section 4.5). Adding a source means
adding a connector, never changing the dashboard's data model.

### Access

New permission `analytics.view`, granted to `admin` and `marketing`. The
creative team does not see revenue unless you want them to (question 4 at the
end).

---

## 3. Credentials and access required

### Shopify (store: `thewndrr.myshopify.com`, Shopify Plus, AUD)

- **An app with Admin API access.** Since 1 January 2026 Shopify no longer lets
  you create new "legacy custom apps" in the Shopify admin. New apps are created
  in the Dev Dashboard and give you a client ID and secret, which are exchanged
  for an access token that expires every 24 hours (client credentials grant). A
  legacy custom app created before 2026 keeps its permanent `shpat_` token. The
  client will support both, so if the Report Pipeline already uses a legacy
  custom app, adding scopes to it may be the fastest route.
- **Scopes:**
  - `read_orders`
  - `read_all_orders`: without it the API only returns the last 60 days of
    orders. We need full history back to 2016 to know whether a customer is
    genuinely new.
  - `read_products`
  - `read_customers`
  - `read_reports`: for the nightly ShopifyQL reconciliation check (4.3).
- **Protected customer data:** shipping and billing country are address fields,
  which Shopify gates behind protected customer data access. It must be enabled
  on the app or addresses come back empty. We read the country code only. We
  never store names, street addresses, emails or phone numbers.
- **Env vars:** `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_API_VERSION` (pin `2026-07`),
  and either `SHOPIFY_ADMIN_ACCESS_TOKEN` or `SHOPIFY_CLIENT_ID` +
  `SHOPIFY_CLIENT_SECRET`.

### Meta

- Reuse `META_ACCESS_TOKEN` (System User token with `ads_read`) and
  `META_AD_ACCOUNT_ID`.
- **Confirm the account.** The Meta connector I can see lists four accounts.
  "New Generation" and "Brendan Olver" had zero spend in the last 90 days. The
  account named "WNDRR" (`act_2336887073101033`) is almost certainly the right
  one, but the connector is not enabled for it, so I could not verify its spend,
  currency or timezone. All four accounts report AUD.
- New env var: `META_API_VERSION` (`v25.0`).

### App config

`ANALYTICS_HOME_COUNTRY=AU`, `ANALYTICS_LOW_SAMPLE_ORDERS=10`. Reporting
timezone is read from Shopify's `ianaTimezone`, not configured by hand.

---

## 4. Data model

### 4.1 Principles

- **Two layers:** source tables mirror what the APIs returned (plus the raw
  payload as `jsonb` for audit and reprocessing), and rollups are derived and
  disposable. If a KPI definition changes, we rebuild rollups; we never re-pull
  from the APIs.
- **Every money column has an explicit currency.** Shopify returns each amount
  in shop currency (AUD, converted by Shopify at order time) and presentment
  currency (what the customer paid in). We store both. The Meta account is AUD.
  So **V1 needs no FX conversion of its own**. An `fx_rates_daily` table exists
  for future sources in other currencies, and conversion happens in one
  function only.
- **Only additive components are stored.** CPM, CTR, CPC, ROAS, MER and AOV are
  never stored. They are computed from summed spend, clicks, impressions and
  revenue, so they are always correct for any date range.
- **Reach is not additive.** Summing daily reach overstates it. See 4.4.
- **Dates are local.** Every fact carries a `date` in the reporting timezone
  (Shopify's store timezone). Meta insights arrive already bucketed in the ad
  account's timezone. On every sync we compare the two; if they differ, the
  dashboard shows a banner, because day boundaries will not line up.

### 4.2 Tables

Types abbreviated. `money` = `numeric(14,2)`. All tables live in the
`analytics` schema.

**Sync and data quality**

```
sync_runs            id, source, job, started_at, finished_at, status,
                     rows_written, error, params jsonb
sync_state           source, job, checkpoint (timestamptz or cursor), updated_at
sync_requests        id, source, job, requested_by, requested_at, picked_up_at
reconciliation_checks id, check_date, source, dimension, period,
                     our_value, reference_value, diff_pct, status
schema_migrations    version, applied_at
```

**Reference**

```
countries            code (PK, ISO alpha-2, plus 'ZZ' = unknown), name, region
category_map         product_type (PK), category   -- Shopify productType -> WNDRR category
non_merch_skus       sku_pattern, reason           -- Redo coverage, shipping protection, etc.
fx_rates_daily       date, base, quote, rate, source
```

**Shopify**

```
shopify_products     product_id (PK), gid, title, handle, product_type, vendor,
                     status, tags text[], image_url, product_code (derived),
                     created_at, updated_at, synced_at
shopify_variants     variant_id (PK), product_id, sku, title, style_code, synced_at
shopify_collections  collection_id (PK), title, handle
shopify_product_collections  product_id, collection_id

shopify_orders
  order_id (PK, bigint)          gid, name
  created_at, processed_at       updated_at, cancelled_at
  order_date (date, local tz)    from processed_at
  test (bool)                    source_name, app_name
  customer_id (nullable)         null = guest checkout
  shopify_customer_order_index   Shopify's own count, used as a cross-check
  is_first_order (bool, nullable) computed by us from full history; null for guests
  ship_country, bill_country     country (resolved), country_source ('shipping'|'billing'|'unknown')
  shop_currency, presentment_currency, taxes_included
  -- shop-currency (AUD) money, product lines only unless noted
  gross_sales, discounts, tax, refunds_to_date, net_sales
  shipping, shipping_refunded, duties, order_total (all lines incl. tax/shipping)
  -- presentment-currency equivalents for the "local currency" view
  gross_sales_local, net_sales_local, order_total_local
  excluded (bool), exclusion_reason   'test' | 'cancelled' | 'exchange_app' | ...
  raw jsonb, synced_at

shopify_order_lines
  line_id (PK), order_id, product_id, variant_id, sku, style_code, product_code
  title, variant_title, quantity, refunded_quantity
  is_merch (bool)                 false for gift cards and non_merch_skus
  gross, discount, tax, net, refunded   (AUD)
  net_local                             (presentment)

shopify_refunds      refund_id (PK), order_id, created_at, processed_at,
                     refund_date (local), total_refunded, lines_subtotal,
                     lines_tax, shipping_subtotal, duties
shopify_refund_lines refund_line_id (PK), refund_id, line_id, quantity,
                     subtotal, tax

shopify_customers    customer_id (PK), first_order_id, first_order_at,
                     first_order_country, order_count   -- derived from our own orders
```

Refunds keep their own date. V1 reports refunds against the order date (see
5.1), but storing the refund date means a refund-date view is a query change
later, not a re-sync.

**Ads (platform-agnostic)**

```
ad_accounts          platform, account_id (PK together), name, currency, timezone
ad_campaigns         platform, campaign_id (PK), account_id, name, objective,
                     effective_status, created_time, updated_time
ad_sets              platform, adset_id (PK), campaign_id, name, effective_status,
                     targeted_countries text[]
ads                  platform, ad_id (PK), adset_id, campaign_id, name,
                     effective_status, creative_id, thumbnail_url, created_time

ad_account_insights_daily      -- source of truth for country spend totals
  platform, account_id, date, country (PK together)
  spend, impressions, link_clicks, outbound_clicks, add_to_cart,
  purchases, purchase_value, currency, attribution_setting, fetched_at

ad_insights_daily              -- ad-level drill-down
  platform, date, ad_id, country (PK together)
  campaign_id, adset_id
  spend, impressions, reach (nullable, see 4.4), clicks, link_clicks,
  outbound_clicks, add_to_cart, purchases, purchase_value,
  actions jsonb, action_values jsonb,   -- raw arrays, so we can re-derive
  currency, attribution_setting, fetched_at
```

Why two insights tables: country totals come from account-level insights, so
spend from ads that were later deleted, or anything the ad-level pull misses,
still lands in the country total. A nightly check compares the ad-level sum to
the account-level total per country per day and flags any gap.

**Ad to product mapping (structure now, populate progressively)**

```
ad_product_links
  platform, ad_id, product_code (PK together; product_code may be 'UNMAPPED')
  product_group, category, creative_concept
  allocation_share numeric default 1.0   -- lets one ad split across products later
  source ('name_parse' | 'meta_product_mappings' | 'manual')
  updated_at, updated_by
```

V1 fills this from the existing `meta_ads.parsed_*` columns and
`meta_product_mappings`. Where no mapping exists the ad stays unmapped and the
dashboard says "not mapped". Nothing is guessed.

### 4.3 Rollups

Postgres materialised views, refreshed after each successful sync for the
affected date range:

```
mv_daily_country_commerce   date, country, orders, new_customer_orders,
                            returning_customer_orders, guest_orders, units,
                            gross_sales, discounts, refunds, net_sales,
                            new_customer_net_sales, returning_customer_net_sales,
                            shipping, tax, duties
mv_daily_country_ads        date, country, platform, spend, impressions,
                            link_clicks, add_to_cart, purchases, purchase_value
mv_daily_product_country    date, country, product_id, units, net_sales, orders,
                            new_customer_orders, returning_customer_orders
```

Distinct-customer counts cannot be summed across days, so "Customers", "New
Customers" and "Returning Customers" for a range are counted directly from
`shopify_orders` (indexed on `(order_date, country)`). At about 150k orders
that is a millisecond-range query.

**Reconciliation (nightly):** compare our gross sales and order counts by
country by month against Shopify's own ShopifyQL
(`FROM sales ... GROUP BY shipping_country`) for the last three months. Any gap
over 1% shows on the sync status panel. Net sales will differ slightly by
design, because Shopify dates refunds on the refund date and we date them on
the order date. The check therefore runs on gross sales and orders, which
should match.

### 4.4 Reach

Reach is deduplicated people, so it cannot be summed across days, countries or
ads. On top of that, since January 2026 Meta only keeps unique metrics such as
reach with breakdowns for 13 months. V1 approach: the Meta Ads page fetches
reach for the exact selected range on demand and caches it for six hours. It
is the one place the dashboard calls an API live, and it is labelled as such.
Everywhere else shows impressions, which are additive.

### 4.5 Future profitability layer

Revenue is stored per order and per line, so profit is added by attaching
costs, not by reshaping revenue:

```
cost_inputs    cost_type ('cogs' | 'shipping_cost' | 'duties_paid' | 'payment_fees' | 'fulfilment')
               scope ('sku' | 'style' | 'country' | 'order' | 'global'), scope_key
               basis ('per_unit' | 'per_order' | 'pct_revenue' | 'fixed')
               amount, currency, effective_from, effective_to, source

order_costs    order_id, line_id (nullable), cost_type, amount, source, computed_at
```

`order_costs` is a ledger computed from `cost_inputs` (or loaded directly from a
3PL invoice or payment report). Contribution profit is then:

```
Net Sales + Shipping Revenue
  - COGS - Shipping Cost - Duties Paid by WNDRR - Payment Fees
  - Ad Spend
= Contribution Profit
```

COGS is the natural first cost to add, since this app already has an
ApparelMagic integration and AM holds unit costs.

---

## 5. KPI definitions

These live in `src/analytics/metrics/definitions.js` and nowhere else. Every
figure is AUD unless the local currency view is on.

### 5.1 Which orders count

An order is **included** unless it is:
- a test order (`test = true`),
- cancelled (`cancelledAt` is set),
- an exchange or replacement order created by a returns app. 632 of the last
  90 days' orders came through the **Redo** channel with $1,559 total net sales
  (about $2.50 each), which looks like exchanges rather than purchases.
  Counting them would inflate order and customer counts by about 3.5%.
  To be confirmed (question 6).

Every exclusion is stored with a reason and counted on the data quality panel.

**Order date** = `processedAt` converted to the store's timezone.
**Country** = shipping address country, then billing address country, then
`ZZ` (unknown).
**Refunds are attributed to the order's date** (cohort view). This answers
"what did this period's orders end up being worth". The trade-off: the last two
or three weeks drift down as returns arrive. The dashboard labels recent
periods "refunds still landing".

### 5.2 Shopify actuals

| Metric | Definition |
|---|---|
| Gross Sales | Sum of `originalTotalSet.shopMoney` on merchandise lines, minus line tax where `taxesIncluded` is true. Excludes gift cards and `non_merch_skus`. |
| Discounts | Sum of `discountAllocations.allocatedAmountSet.shopMoney` on merchandise lines (covers line-level and order-level discounts). |
| Refunds | Sum of `refundLineItems.subtotalSet.shopMoney` on merchandise lines, net of refunded tax. |
| **Net Sales** (Shopify Revenue) | Gross Sales - Discounts - Refunds. Excludes tax, shipping and duties. **This is the MER numerator.** |
| Total Sales | Net Sales + Shipping + Tax + Duties. Shown for reference only. |
| Orders | Count of included orders. |
| Customers | Distinct `customer_id` on included orders. Guest orders are shown as a separate "unidentified" count, not guessed. |
| First order | The customer's earliest included order across **full Shopify history**, computed by us. Shopify's `customerOrderIndex` is stored as a cross-check. |
| New Customers | Distinct customers whose first order falls inside the period, in that country. |
| Returning Customers | Distinct customers with an order in the period whose first order was before it. New + Returning + Unidentified = all buyers. |
| New Customer Orders / Revenue | First orders only, and their net sales. |
| Returning Customer Orders / Revenue | All other included orders with a known customer, and their net sales. |
| AOV | Net Sales / Orders. (Shopify's own AOV uses sales before refunds, so ours will be slightly lower.) |
| Units | Sum of quantity on merchandise lines, minus refunded quantity. |

The tax-inclusive detail matters for the Australia benchmark row (GST is
inside the price) and barely at all for international orders (taxes were $0 for
most markets in the last 90 days). Both are handled by the same rule.

### 5.3 Meta attribution

| Metric | Definition |
|---|---|
| Meta Spend | Sum of `spend` in the country. Country = where the person was when Meta served the ad, per Meta's `country` breakdown. |
| Meta Purchases | `omni_purchase` from `actions`. Falls back to `offsite_conversion.fb_pixel_purchase` only when `omni_purchase` is absent. Never both, or purchases double count. |
| Meta Attributed Revenue | Same action type from `action_values`. |
| Meta ROAS | Meta Attributed Revenue / Meta Spend, from sums. Never an average of daily ROAS. |
| Add to Carts | `omni_add_to_cart`, same fallback rule. |
| Link Clicks | `inline_link_clicks`. |
| Outbound Clicks | `outbound_clicks` (action type `outbound_click`). |
| CPM | Spend / Impressions x 1,000. |
| CTR (link) | Link Clicks / Impressions. |
| CPC (link) | Spend / Link Clicks. |

Insights are requested with `use_unified_attribution_setting=true`, so numbers
match what Ads Manager shows under each ad set's own attribution setting. The
setting is stored per row. Note that Meta removed the 7-day view and 28-day
view windows from the API on 12 January 2026, so anything older you compare
against may have used a wider window.

### 5.4 Blended metrics (Shopify actuals / Meta spend)

| Metric | Definition | Notes |
|---|---|---|
| **Country MER** | Net Sales (country) / Meta Spend (country) | Commercial efficiency, not attribution. Spend of 0 shows "no spend", never infinity. |
| New Customer CPA | Meta Spend / New Customers | Blended: assumes all Meta spend is buying new customers. Labelled that way. |
| New Customer MER (proposed) | New Customer Revenue / Meta Spend | Isolates the revenue Meta most plausibly drives. |

### 5.5 Periods and changes

- Presets exclude today, matching Meta's own presets: Last 30 Days = the 30
  complete days ending yesterday. **Today** is a separate preset, marked
  "partial day".
- Previous period = the same number of days immediately before.
- % change = (current - previous) / previous. If previous is 0, it shows "new".
  For Today, % change is hidden because both days are partial.
- Arrows show direction only (spend, revenue, orders, MER, new customers). No
  good/bad colouring in V1.

### 5.6 Product and share metrics

| Metric | Definition |
|---|---|
| % of Country Revenue | Product net sales in country / country net sales |
| International % of Product Revenue | Product net sales outside AU / product net sales everywhere |
| Product's country share | Product net sales in country / product international net sales |
| Country's overall share | Country net sales / total international net sales |
| Index (later) | Product's country share / Country's overall share |

Product Detail shows the two share columns side by side, which makes the
over-index case visible without the Index metric.

---

## 6. Shopify API: exact fields

Admin GraphQL API, pinned to `2026-07`. Every field below was checked against
the live schema on 25 September 2026. One example of why that matters:
`Product.featuredImage` no longer exists; product images come from
`featuredMedia`.

**Backfill:** one `bulkOperationRunQuery` over all orders (about 149,000 since
2016), streamed from the JSONL result into upserts. Products the same way.

**Incremental (every 15 minutes):** `orders(first: 100, sortKey: UPDATED_AT,
query: "updated_at:>='<checkpoint minus 10 minutes>'")`. `updatedAt` changes on
refunds, edits and cancellations, so one incremental query catches all of them.
Throttling uses the query cost returned in `extensions.cost.throttleStatus`.

```graphql
query Orders($cursor: String, $q: String) {
  orders(first: 100, after: $cursor, sortKey: UPDATED_AT, query: $q) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id legacyResourceId name
      createdAt processedAt updatedAt cancelledAt test
      sourceName app { name }
      currencyCode presentmentCurrencyCode taxesIncluded
      customer { id }
      customerJourneySummary { customerOrderIndex }
      shippingAddress { countryCodeV2 }
      billingAddress { countryCodeV2 }
      subtotalPriceSet      { shopMoney { amount } presentmentMoney { amount } }
      totalDiscountsSet     { shopMoney { amount } presentmentMoney { amount } }
      totalShippingPriceSet { shopMoney { amount } presentmentMoney { amount } }
      totalTaxSet           { shopMoney { amount } presentmentMoney { amount } }
      originalTotalDutiesSet{ shopMoney { amount } presentmentMoney { amount } }
      totalPriceSet         { shopMoney { amount } presentmentMoney { amount } }
      totalRefundedSet      { shopMoney { amount } presentmentMoney { amount } }
      lineItems(first: 100) {
        nodes {
          id sku name title variantTitle quantity currentQuantity isGiftCard
          product { id } variant { id }
          originalTotalSet { shopMoney { amount } presentmentMoney { amount } }
          discountAllocations { allocatedAmountSet { shopMoney { amount } presentmentMoney { amount } } }
          taxLines { priceSet { shopMoney { amount } presentmentMoney { amount } } }
        }
      }
      refunds {
        id createdAt processedAt
        totalRefundedSet { shopMoney { amount } presentmentMoney { amount } }
        refundLineItems(first: 100) {
          nodes {
            quantity lineItem { id }
            subtotalSet { shopMoney { amount } presentmentMoney { amount } }
            totalTaxSet { shopMoney { amount } presentmentMoney { amount } }
          }
        }
        refundShippingLines(first: 10) {
          nodes { subtotalAmountSet { shopMoney { amount } } }
        }
      }
    }
  }
}
```

**Products (every 6 hours):** `products` with `id title handle productType
vendor status tags updatedAt featuredMedia { preview { image { url } } }
collections(first: 20) { nodes { id title handle } } variants(first: 100) {
nodes { id sku title } }`.

**Shop (daily):** `shop { ianaTimezone currencyCode }`.

**Reconciliation (nightly):** `shopifyqlQuery` (needs `read_reports`).

**First task in the build:** pull a handful of real orders (a tax-inclusive AU
order, a partially refunded international order, a discounted order, a Redo
exchange) and check the mapping against the Shopify admin by hand. In
particular, confirm whether `RefundLineItem.subtotalSet` includes tax on
tax-inclusive orders. The schema description does not say, and the answer
changes the refund formula.

---

## 7. Meta Marketing API: exact fields

Graph API `v25.0`, endpoint `GET /act_{id}/insights`.

**Country totals** (`ad_account_insights_daily`):
```
level=account
breakdowns=country
time_increment=1
time_range={"since":"YYYY-MM-DD","until":"YYYY-MM-DD"}
use_unified_attribution_setting=true
fields=account_currency,date_start,date_stop,spend,impressions,
       inline_link_clicks,outbound_clicks,actions,action_values
```

**Ad drill-down** (`ad_insights_daily`): same parameters with `level=ad` and
extra fields `campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,
reach,clicks`.

**Entities (hourly):** `/act_{id}/campaigns` (`id,name,objective,
effective_status,created_time,updated_time`), `/act_{id}/adsets` (`id,name,
campaign_id,effective_status,targeting{geo_locations}`), `/act_{id}/ads` (the
existing `fetchAllAdRecords` fields plus `created_time` and
`creative{id,thumbnail_url}`).

**Cadence:**
- Hourly: re-pull the last 3 days (today's spend keeps moving).
- Nightly: re-pull the trailing 28 days. Meta keeps attributing conversions
  back to earlier days within the attribution window, so older rows change.
  Each pull replaces the whole (date, ad, country) row.
- Backfill: 25 months of spend (enough for year-on-year). Reach only exists
  for the last 13 months with breakdowns.
- Large ranges use async report runs (`POST /act_{id}/insights`, poll the
  report run, then read its `/insights`), chunked by week.

**Resilience:** read `X-Business-Use-Case-Usage` and `X-Ad-Account-Usage`
headers and slow down before hitting limits. On throttle errors, back off
exponentially and resume from the checkpoint. On the first run, validate the
field list with a one-day request, so any field Meta rejects fails loudly
before a 25-month backfill starts.

**View in Meta:** Ads Manager deep links, e.g.
`https://adsmanager.facebook.com/adsmanager/manage/ads?act={account}&selected_ad_ids={id}`
(and the `campaigns` / `adsets` equivalents). These are Ads Manager web URLs,
not a documented API. If Meta changes them, only the button breaks.

**Known mismatches, shown as notes, not "fixed":**
- Meta's country is where the ad was served. Shopify's is where the parcel
  goes. Gifts and travellers land in different countries.
- Meta's purchase value comes from the pixel and CAPI and may include tax and
  shipping. Shopify Net Sales does not. Meta ROAS and Country MER are not
  like-for-like even before attribution differences.

---

## 8. Pages

Shared header on every page: date preset selector (Today, Yesterday, 7, 14,
30, 90, Custom; default Last 30 Days), AUD / Local currency toggle (local only
on single-country pages, since summing mixed currencies is meaningless), and
sync status: "Shopify synced 10:42 (3 min ago), Meta synced 10:05". Status
turns red if the last success is more than twice the expected interval. Plus a
manual refresh button.

Visual separation used everywhere: **Shopify actuals** columns in one group
and **Meta attribution** columns in another, with a group header over each.
Meta Attributed Revenue is never placed next to Shopify Revenue without that
header.

### 8.1 International Overview (landing page)

- KPI cards: International Meta Spend, International Shopify Revenue, Orders,
  Customers, New Customers, Country MER, AOV, New Customer CPA. Each shows the
  previous-period value and a direction arrow.
- Country table with the columns from the brief, plus an Orders count that
  drives the low-sample greying. Australia is a pinned, visually separate
  benchmark row, excluded from the International totals. Countries below the
  sample threshold with no spend roll into "Rest of World" (expandable).
  Sortable on every column. A row click opens Country Detail.

### 8.2 Country Detail

- Header: flag, country name, period.
- KPI strip as in the brief, plus a comparison line: "Spend +42%, Revenue +9%,
  Country MER -23%".
- Time series: Shopify Revenue and Meta Spend on one chart. Toggle Revenue,
  Spend, Orders, MER, New Customers, CPA. Weekly by default for 28+ day ranges.
- Top Products in this country: columns from the brief, product thumbnail,
  sortable, clickable.
- Category performance: the same columns grouped by WNDRR category.
- **Meta activity in this country** (added): top campaigns and ads by spend in
  this country for the period, with Meta ROAS and a View in Meta link. This is
  what answers "what creative are we spending behind in the USA, and what are
  Americans buying" on one screen, and it is cheap once ad-level insights are
  synced.

### 8.3 Product Performance

Table: Product, International Revenue, International Units, Top Country,
Countries Purchasing, International % of Product Revenue. Search box. Filters:
category, collection, core vs non-core (from `styles.tier`), date. Row click
opens Product Detail.

### 8.4 Product Detail

Overall product KPIs, then a by-country table: Country, Revenue, Units, Orders,
Customers, New Customers, % of Product Revenue, **Country's overall share**
(for the over-index comparison), AOV, Mapped Meta Spend, Product MER. The last
two show "not mapped" until the ad-to-product mapping covers this product.

### 8.5 Meta Ads

Campaign > Ad Set > Ad expandable table. Filters: country, date, campaign, ad
set, product, category. Columns from the brief plus Mapped Product. View in
Meta button per row.

---

## 9. Build order

Each step ends with something verifiable. Nothing moves forward on unverified
numbers.

| Step | Delivers | Verified by |
|---|---|---|
| 0 | Credentials, account confirmation, answers to section 10 | You |
| 1 | `analytics` schema and migrations, sync runner (locks, retries, `sync_runs`), worker service, Meta API version bump | Worker runs a no-op job on Railway; sync status endpoint returns it |
| 2 | Shopify products and orders: bulk backfill, 15-minute incremental, first-order computation, exclusions | Hand check of sample orders; monthly gross sales and orders by country within 1% of ShopifyQL |
| 3 | Meta entities and insights: account- and ad-level, by country, by day; 25-month backfill; hourly and nightly re-pulls | Three sample days match Ads Manager spend by country; ad-level sum equals account level |
| 4 | Metrics module, rollups, `/api/analytics/*` | `node:test` fixtures: tax-inclusive, refund, cancelled, exchange, guest, multi-currency, zero spend |
| 5 | International Overview and Country Detail (including Meta activity in country) | You use it against numbers you already know |
| 6 | Product Performance and Product Detail | Top products per country checked against Shopify reports |
| 7 | Meta Ads page and `ad_product_links` populated from the existing parser and mapping | Unmapped count shown; spot-check mappings |
| Later | Cost ledger (COGS from ApparelMagic first), contribution profit, Google Ads, Klaviyo | |

---

## 10. Decisions needed before step 1

1. **What counts as "International"?** Recommendation: everything except
   Australia, with Australia shown as a pinned benchmark row. NZ is 60% of
   international revenue and behaves like a home market, so consider a toggle
   to exclude NZ from the International KPI cards. Otherwise NZ will mask what
   the US is doing.
2. **Revenue definition for MER.** Recommendation: Net Sales (after discounts
   and refunds, excluding tax, shipping and duties). The alternative, Total
   Sales, flatters markets with high shipping charges.
3. **Refund timing.** Recommendation: attribute refunds to the order date
   (cohort), with recent periods labelled as still settling. The alternative
   matches Shopify's own reports but charges this month's spend for last
   month's returns.
4. **Who can see it?** Recommendation: admin and marketing roles only.
5. **Category source.** Recommendation: Shopify `productType` mapped to the
   seven WNDRR categories through an editable table. Is `productType` kept
   clean in Shopify?
6. **Sales channels.** Last 90 days by channel: Online Store, Shop, Facebook &
   Instagram, IDA Connect (169 orders, $14k), Redo (632 exchange orders).
   What is IDA Connect? If it is wholesale or a marketplace, it should be
   excluded from DTC MER.
7. **Shopify app.** Is there an existing legacy custom app (permanent token)
   we can add scopes to, or do we create a Dev Dashboard app?
8. **Meta account.** Confirm `act_2336887073101033` ("WNDRR") is the one
   running international spend, and whether any spend runs through a second
   account.

---

## Sources (external facts cited above)

- Shopify Admin GraphQL schema: fields checked live on 25 September 2026
  through the Shopify connector.
- Shopify, new legacy custom apps blocked from 1 January 2026:
  https://community.shopify.dev/t/starting-january-1-2026-you-will-not-be-able-to-create-new-legacy-custom-apps-this-will-not-impact-any-existing-apps/26798
- Shopify client credentials grant and 24-hour tokens:
  https://community.shopify.dev/t/how-to-get-admin-api-tokens-using-apps-in-dev-dashboard/29472
- Meta API v25.0 current, v24.0 oldest supported, v23.0 expired 9 June 2026:
  https://web.swipeinsight.app/posts/facebook-launches-graph-api-v25-and-marketing-api-v25-updates-22544
  and https://www.kitchn.io/blog/meta-marketing-api-q2-2026-update
- Meta removed 7-day and 28-day view attribution windows on 12 January 2026:
  https://www.dataslayer.ai/blog/meta-ads-attribution-window-removed-january-2026
- Meta 13-month retention for unique metrics with breakdowns:
  https://ppc.land/meta-restricts-attribution-windows-and-data-retention-in-ads-insights-api/
