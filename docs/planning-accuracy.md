# Planning accuracy (Batch 29)

Goal: the **Needs creative** list holds products WNDRR can realistically shoot and advertise **now**: enough available stock in a colourway that can be shot, demand that justifies a shoot, and a genuine creative opportunity. A gap in Meta creative coverage never qualifies a product on its own.

## What was audited (and what could not be)

The audit traced the code and data paths. The build environment cannot reach production data (ApparelMagic, Meta, Stock Demand Planning), so **no live product could be inspected**. The named live examples (Halo, Offcut, Shodo, Accent Mesh, Booster, Riot, Soho Club, Reaper, Accent Regular, Script, Collective, Starter, Slammed, Blissed Out, Arcade) were not looked up: the rules below are general, were reproduced with fixtures that mirror them, and each product's new status is visible on the page (and its evidence under *View detailed evidence*).

| Finding | Kind | What changed |
|---|---|---|
| A confirmed restock / open PO closed a short stock runway (`short_restock`), so a product with 1 to 3 weeks of available stock could still be recommended | Incorrect business rule | Incoming stock never counts. A short runway is `low_stock`, with the on-order units named as "not available to sell yet". |
| Stock was the sum of **every** colourway, including discontinued ones, and was judged only at family level | Incorrect business rule | Stock is the sellable units of **active** colourways. A colourway is shootable when it is active, has the minimum available units and its size run is not broken. A healthy family total with no shootable colourway is not recommended. |
| The minimum was 30 units | Business rule | 40 available units (WNDRR's rule), applied to the product **and** to the colourway to be shot. |
| Size health was a scoring warning only | Missing rule | A broken size run makes a colourway unshootable (existing size-run judgement; no new numbers). Where ApparelMagic gives no size data no verdict is made. |
| Core qualified at 8+ units in 30 days (`weak` demand passed); launches at the "steady" line (20+) | Incorrect rule | Needs steady selling (existing line, 20+) **or** a Platinum / Rocket classification that is still selling (8+). A launch needs strong demand (50+, normalised per day on sale) or Platinum / Rocket. A creative gap alone never qualifies. |
| "Testing / still gathering data" was measured from the **ad creation date**, and production "uploaded" records were counted as testing even when the Meta ad already existed | Incorrect calculation | A creative is "new" only from its **first stored delivery date**. A creation date is used only when no delivery is stored, and is labelled as a creation date. If the first stored delivery is the day our stored history begins, it is never taken to mean "just started". An upload that a Meta creative already shows is counted once. An active ad with no delivery is "not delivering", not "gathering data". |
| One generic sentence for every unresolved creative picture | Misleading presentation | Six conditions are counted apart (new, performing, over the approved limit, fatigued, no approved benchmark, too little delivery, not delivering) and the sentence names the specific cause, including the funnel with no benchmark. |
| "Sales are holding up since launch, so the creative in place is working" | Unsupported claim | Removed. Product sales are product demand: "That is product demand, not evidence about Meta creative". These products are not shown in the lists. |
| The thumbnail was the first colourway image of the family (could be discontinued) | Incorrect product data | Best-stocked **shootable** colourway, else any active in-stock colourway, else a neutral placeholder. Never a discontinued colourway; discontinued is only what the launch assessment says (override, Shopify ARCHIVED), never inferred from zero stock. |
| Product and creative dates were vague ("recently launched") | Misleading presentation | Real dates, labelled: "launched 14 August 2026 (60 days ago)", "began delivering on 18 September 2026", or "was created on ...; its first delivery date is not available". |

## Stock rules (final)

1. A product needs **40 available sellable units** (`opp_min_stock_units`, editable). On-order, reorders and open POs never count.
2. With `stock_require_viable_colourway` on (default), at least one **active** colourway needs 40+ available units and a size run that is not broken (`stock_block_broken_sizes`, default on).
3. Runway: available units over the current sales pace must reach `stock_min_cover_weeks` (existing, 4). It is not made stricter: no new fixed number was invented. A high-demand product with very little stock is therefore excluded, not marked High.
4. Products failing any of these are **not shown**, but the full assessment is kept and recomputed on every refresh, so a product returns by itself when stock recovers. Nothing is stored to "reactivate".
5. Work already in the Shoot Plan is never removed or changed. If its product becomes restricted the Shoot Plan row shows a **stock warning** (and any selected colourway that is no longer shootable); the team decides.

Size data: ApparelMagic exposes stock by size per SKU, so a colourway's run (and sold-out sizes) is known; the size range is the product's own (no universal S/M/L/XL). It does **not** expose size-level *sales*, so "stock concentrated in unpopular sizes" and "core selling sizes" cannot be judged and are not.

## Demand qualification

Stock Demand Planning's Platinum / Rocket classification is the authoritative strong-demand signal and qualifies a product while it is still selling (`demand_tier_qualifies`, default on). Neither classification guarantees a shoot: stock, season and a genuine creative need still apply. Other (including established Core) products qualify on **steady selling**, using the existing steady line (20 units in 30 days); no new minimum was introduced. **Business decision still open:** whether 20 units in 30 days is the right line for a non-tiered Core product (it is one setting: `demand_steady_units`).

### Stock Demand Planning integration (finding)

Planning does **not** query the Stock Demand Planning app. `lib/reportPipeline.js` ports `getPerfTier` verbatim and computes the tiers from the Shopify sales/inventory CSV exports that WNDRR's Report Pipeline serves (`PIPELINE_BASE_URL`), cached for 3 hours. The classification is **per colourway (ApparelMagic style code)**, using the same style codes as Planning; the family tier is its best-selling colourway's. The read time is shown under Settings > Planning > Data sources. Risk: because it is a port, a future change to the Demand Planning app's tier logic does not flow through automatically, and the freshness of the underlying export is only as fresh as the Report Pipeline's own data. Not changed.

## Creative testing and benchmarks

* `min_spend` (60) is documented in code as "about one approved MOF CPA of spend" but is a separate number; it is **not** tied to the benchmark and was not changed (no test or evidence establishes a correction).
* Only MOF CPA has an approved benchmark. TOF and TOM creatives are **unrated** ("These ads have performance data, but there is no approved TOM benchmark to assess them against"); a creative in several funnels, or none recorded, is unrated and says so. Unrated is never underperforming and never counted as performing. A TOF/TOM creative is never judged against the MOF target. No benchmark value was changed.
* Categories now: **Needs creative**, **Covered / monitoring** (enough effective creative, genuinely new creative, or concepts in production), **Needs review** (a product that passed stock, demand and season but has a *specific* unresolved evidence issue: ads awaiting review, no approved benchmark, too little delivery, ads not delivering, unidentified ads, no Meta data). Weak-demand, stock-restricted, out-of-season, no-decline and launch-unconfirmed products are hidden, not parked in Needs review.

## Settings, navigation

* Settings > Planning is in four parts: Recommendation rules (the existing editable settings, plus the new switches), Data sources (each source, last read, caveats), How recommendations work (plain English, with the current numbers), Launch and data quality (launch checks, launch evidence lookup and the data notes, moved from the Planning pages). Only genuine business thresholds are editable.
* Core | High Stocks | Shoot Plan also sit at the top of the Planning page, kept in step with the sidebar (URL `#planning/<section>`, Back/Forward, selected week preserved).

## Colourways

The expanded product lists each colourway with thumbnail, available units, size availability (or "Size data not available"), whether it can be shot now, and why not. **Plan this colourway** opens the existing Shoot Plan modal with only that colourway ticked; the default action ticks the shootable ones. The modal and server are unchanged: a repeat of the same product / week is merged into one record, never duplicated. Colourways are joined by ApparelMagic style code, the identifier the Shoot Plan already uses.

## Business decisions still required

1. Is 20 units in 30 days the right "steady" line for a Core product that is not Platinum / Rocket?
2. Should the runway minimum (4 weeks) be longer than the existing default for immediate shoots? (Left unchanged: not invented.) `creative_lead_time_days` (off) can add the measured production lead time.
3. Should a colourway need more than the product-level 40 units to be shot? (Today the same 40 applies.)

## Live Ads column (restored, Core and High Stocks)

The Batch 28 table dropped the "Active creatives" column; Batch 29 restores it as **Live ads**, between *Why it needs creative* and *Stock* on both pages.

* **What is counted: unique creatives, never Meta ad ids.** Identity is the existing one (`productAdPerformance.creativeGroupKey`): an identical Meta creative id, or a "- Copy" of an ad by name (Batch 10 rule). One video running in five campaigns is **1** live ad (shown as `1` with a quiet `5 Meta ads` note). Three different videos, or a video and a static image, are separate creatives. A shared concept, creator or product never merges executions (diversity still counts concepts separately).
* **Live = ACTIVE in Meta AND delivered (spend or impressions) on a stored day within `live_delivery_days`** (Settings > Planning > Performance evidence, default 7, range 1-30). Only active, confirmed or auto-matched ads are read (DPAs excluded), so "previously active" means *active in Meta but no longer delivering*.
* **Other states, told apart in the detail table:** *Active, not delivering* (delivered before, not within the window), *Active, no delivery recorded*, *Just launched, no data yet* (created in the last 3 days; listed, not counted), *Delivery unknown*.
* **No invented counts.** If the newest stored Meta delivery day is more than 3 days old, delivery cannot be judged: the column shows a dash with the reason. Ads awaiting review in Ad Matching that may belong to the product are shown as `+N unreviewed` and never added to the count.
* **One identity everywhere.** The Live Ads count, creative coverage, concentration, diversity, the "Creative picture" sentence and Key facts all read the same de-duplicated list (`creativeRecency.summarize`).
* **Expanded details:** a "Live ads" table, one row per distinct creative: name, format, funnel, delivery status (with last delivery date), performance (condition, spend, CPA where available) and the number of Meta ad instances. Column sorting by Live ads is available.
* Tests: `test/planningLiveAds.test.js` (duplicate across campaigns, different creatives, same concept different executions, name copies, video + static, active without recent delivery, stale insights, uncertain matches, window setting, page wiring), run through the real grouping code over a stubbed database.
