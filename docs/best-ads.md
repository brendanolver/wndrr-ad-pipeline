# Best Ads (Meta Performance > Best Ads)

A gallery of the best individual Meta ads for the selected period. It is a **presentation layer over the same stored Meta data** as the Performance page: no new data source, no new attribution, no scoring or "winner" logic.

## Navigation
Sidebar: Meta Performance expands to **Performance / Best Ads / Ad Matching** (the same area, three views; the in-page tabs match). The date range, Previous period, Refresh now and Include DPAs choices are shared (`mpState`), so they carry across pages. Default range: Last 7 Days (Australia/Sydney).

## Ranking (`getBestAds`, `GET /api/meta-performance/best-ads`, admin only)
* Every card is **one Meta ad** (never grouped by creative or product). Ranking runs over the **whole eligible set** in the database; the page loads 24 at a time ("Show more").
* Rank by: Purchase Value (default, highest first), Purchases, CPA (lowest first), Reach, Amount Spent, ROAS. Ties: higher Purchase Value, then higher spend, then Ad ID.
* **Minimum spend** (default $500, editable, 0 allowed) applies to the whole page, including the KPI totals.
* **CPA / ROAS** additionally need at least **5 purchases** (editable "Min. purchases"), so one lucky sale cannot top the list; the rule and how many ads it left out are shown on the page.
* **Reach** only ranks when per-ad Reach exists for the period (single day, or a range already loaded from Meta). Otherwise the page says so and ranks by Purchase Value; it never invents Reach.
* Filters: Funnel (All/TOF/TOM/MOF), Campaign, Status (All/Active/Paused), Search (ad name, product name, exact Meta Ad ID), Include DPAs (existing DPA detection, `src/lib/metaDpa.js`).

## KPI cards
Purchase Value, Purchases, CPA, Amount Spent, ROAS for the **same ad population the filters describe** (not just the cards shown; the page says how many ads that is). With Previous period on, the change is like-for-like (the same ads in the equal-length period before) and only shown when both periods are fully synced; Amount Spent is neutral, the others use the favourable / unfavourable colour. No progress bars or benchmark colouring.

## Covers
Large (600px) covers come from the same Meta read as the table thumbnails, requested only for cards near the screen, in batches, cached separately (`meta_creative_thumbs.large_url`, additive columns) and reusing the full preview cache where it already holds an image. Videos play inline (one at a time) only when a playable file is already cached; otherwise clicking opens the existing **Ad Preview modal** for the same ad and date range. Missing covers show a plain placeholder, never a stock image. With automatic Meta refresh off nothing is fetched.

## Not changed
Meta API auth, the Performance page and its calculations, Ad Matching, funnel classification, the Ad Preview modal, creative media caching, settings and historical data.
