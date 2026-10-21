# Creative Insights and shoot planning (Batch 30)

Planning answers: **what should we shoot this week, for which product, with which concept, and why.** Sections: Core, High Stocks, Shoot Plan (top navigation and sidebar).

## Audit: what already existed and what was reused

* **Creative Opportunities V1** (`src/lib/creativeOpportunities.js`, `creativeOpportunitiesConfig.js`, `/api/creative-opportunities`) already had cross-product concept analysis (`analyseConcepts`, `recTestConcepts`). It was not used by Planning and no longer has a UI. Its evidence rules (`CONCEPT`: 3 creatives, $1,000, 10 purchases, products, product spend) are kept as the **single source of the evidence numbers**; Creative Insights reads them. What it could not do, and why a new module was needed: it compares concepts with ONE blended account CPA across TOF / TOM / MOF, counts creatives by Meta creative id only (no "- Copy" rule), ignores the approved benchmarks, and does not ask whether a product is eligible (stock, colourway, size, demand, season). V1 is untouched (no second source of truth is created: Planning only reads Creative Insights).
* **Creative identity** is `productAdPerformance` (`creativeGroupKey`, `newGroup`, `addRowToGroup`, `mergeNameCopies`): an identical Meta creative id, or a "- Copy" of an ad by name. Planning and Creative Insights share it. Different executions are never merged because they share a product, creator, concept or format.
* **Concepts** are the human-confirmed Ad Matching classifications (`meta_ad_classifications.concept_type_id` / `concept_label`). Nothing is inferred from names. A creative with no concept is *unclassified* (reported as coverage, never grouped). A free-text legacy label is used but flagged. If ads of one creative are classified under different concepts, the spend-weighted majority is used and the conflict is shown.
* **Funnels** are the campaign taxonomy as stored (`meta_campaigns.funnel`: `TOF`, `TOM`, `MOF`, plus `multiple` / `unknown`, shown as Mixed / Unknown). No mapping is invented. **Benchmarks** are `metaBenchmarks.getEffective()`: today only the MOF CPA is approved, so TOF / TOM creative is shown with spend, purchases, CPA, ROAS but never called good or bad.
* **Product eligibility** is Planning's own result (demand qualification, available stock, viable colourway, size run, season). Creative Insights never re-implements it.
* **Shoot Plan** records already modelled product, colourways and concepts: `shoot_plan_items` (product + week) with `shoot_plan_item_styles` (colourways) and one `creative_assets` row per concept. Reused as-is.

## Creative age (corrected)

* 0 to 4 days of delivery (`new_creative_days`, default 4, editable): **early testing**, unless the evidence already supports a verdict (a creative with enough spend is judged on day 1).
* From day 5: **assessed**. If it still has too little spend or impressions the assessment says **"Insufficient delivery"**. "Too early to judge" no longer appears anywhere.
* Age is never the only factor: spend, purchases, delivery and the approved benchmarks decide. `test_period_days` remains only for the stock-runway check and for uploads that have no Meta delivery yet.

## Every creative is assessed (one condition never dominates)

* Each unique creative is assessed on its own and **within each funnel it ran in**: a creative in MOF and TOF is one creative, judged in MOF against the approved CPA and shown with its TOF numbers and no verdict. It is never unrated merely because one of its funnels has no benchmark.
* Coverage counts **creatives in play** = performing + unrated (delivering, cannot be benchmarked) + early testing. Enough in play (the existing `min_performing_creatives`, default 3) with nothing clearly failing = **Covered / monitoring**, with a sentence that says what is performing, what cannot be benchmarked and what is new. Too few in play = thin coverage, and a product that depends on a **single** creative is a real gap whatever that creative's age (so a newly launched ad no longer silences a product).
* A new creative only silences a product when enough creatives are in play (or a pending upload / production concept exists and demand is not strong). Concepts already in production are protected exactly as before.
* Needs review is for real evidence problems only: matching uncertainty, unidentified ads, nothing assessable (every creative under-delivers, nothing delivering, no Meta data).

## Live Ads, priority, coverage, weak demand

* **Live ads** shows only the number of unique live creatives (active in Meta and delivered within `live_delivery_days`, default 7). Duplicate counts stay internal (`facts.live_instances`) and are never displayed.
* **Priority** exists only in Needs creative (sortable). The tooltip lists the score parts and every cap. Stock cover beyond `stock_overstock_weeks` (26) caps priority at Medium ("slow mover"), so a High badge can no longer sit beside "slow mover".
* **Stock coverage** has one calculation: available units / weekly pace (the higher of the 30-day-equivalent and 14-day rates), stated with its pace ("25.6 weeks at 16.8 units a week"). Root cause of 35.9 vs 25.6: the High Stocks revival check computed weeks from a different pace (the last 28 days / 4) than the stock row. Both now use the same figure.
* **Weak demand** (Accent Mesh Short shape: 202 units, 16 units in about 21 days on sale): the 16 units were scaled to a 30-day estimate (about 23) which passed the 20-unit "steady" line. A part-period of sales now qualifies like a launch does (strong demand or Platinum / Rocket), controlled by the existing `launch_requires_strong_demand` setting. No product is excluded by name.

## Creative Insights page

> **Removed from the app (v1.8.6):** the Creative Insights page (Planning tab, sidebar entry, `#planning/creative-insights`) no longer exists. Planning is Core, High Stocks and Shoot Plan. The engine (`src/lib/creativeInsights.js`) and `GET /api/opportunities/insights` are left in place, unused by the UI, so nothing is lost if the page returns. The description below is kept as a record of how the page worked.

Table: Concept | Products tested | Unique creatives | Performance | Opportunity. Expanded: why this rating (evidence and requirements met / not met), by funnel (never averaged), products tested, the unique creatives, and suitable products to test with a **+ Add** button.

| Rating | Meaning |
|---|---|
| Established winner | In a benchmarked funnel: 3+ unique creatives performing, on 2+ products (each with $100+ allocated spend), $1,000+ spent, 10+ purchases, more performing than underperforming, and no single product carrying 80% or more of the performing purchases |
| Promising test | At least one performing and more performing than underperforming, below those requirements (suggested only for same-category products) |
| Mixed performance | Performing and underperforming both present, underperforming as many or more |
| Underperforming | No creative performing, at least two over the approved CPA limit |
| Insufficient evidence | Nothing rated: too little delivery, or the funnel has no approved benchmark |

The numbers are the Creative Opportunities V1 `CONCEPT` rules (provisional starting points) plus the existing 80% concentration share; they are shown on the page. One product cannot make a winner. Spend on a creative featuring several products is split equally between them; presence counts for each.

**Suggested products** pass Planning's own eligibility (not stock-restricted, demand qualified, in season, not blocked by matching doubt), have not tested the concept (Meta creative, classified creative or history) and do not have it planned or in production (non-killed Shoot Plan concepts of the last `pipeline_lookback_weeks` weeks). The reason text is built from the real numbers; if the product has unclassified creative the page says a similar creative may exist. Nothing is suggested for an insufficient, mixed or underperforming concept.

## Shoot Plan: product, concept, colourways

* **One concept covers every colourway you tick** (not a concept per colourway). `creative_assets.planned_style_ids` (additive nullable column, nothing rewritten) records which colourways a concept covers; `shoot_plan_item_styles` still holds the product's colourways for the pull list.
* **Quick add:** a compact **+ Add** after Priority on each Needs creative row (no expanding needed) opens the existing Shoot Plan modal with every shootable colourway ticked, restricted colourways listed unticked with the reason, and a concept chooser (the concept vocabulary). From Creative Insights the concept arrives preselected with the reason.
* A product already in this week's plan gets the new concept **added** to its record (`additional: true`): no duplicate product, no duplicate concept, existing concepts untouched. Promotions, carried-over concepts and the weekly counting (concepts, not colourways) are unchanged.

## Limits

* Live data is not reachable from the build environment, so the six live examples (Soho Club Tee, Accent Regular Fit Tee, Soho 1/4 Zip Sweat, Reaper Carpenter Short, Booster Denim Short, Slammed Box Fit Tee) could not be re-run. Each pattern they show (new creatives silencing established ones, a missing TOF/TOM benchmark parking a product, one new ad covering a product) is covered by tests with the same shapes; the page's evidence tables show each creative's start, last delivery, funnel and spend for checking live.
* Concept quality depends on Ad Matching: only confirmed classifications are used.
