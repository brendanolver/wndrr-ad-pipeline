# Planning intelligence (Batch 27)

How Core, High Stocks and Protect momentum recommendations are produced. Every threshold named here is a **provisional starting point**, editable in
Settings (`creativePlanningConfig.js`), and none is a Meta performance benchmark (those stay in Meta Performance settings). The engine is pure
(`planningOpportunities.js`, `planningDemand.js`, `creativeEvidence.js`, `planningSales.js`, `planningPrimary.js`, `seasonRelevance.js`); the loader
(`planningOpportunitiesLoader.js`) gathers inputs. No product name appears in any of them (a test enforces it).

## Definitions that are never inferred

| Thing | Source |
|---|---|
| Official Core | ApparelMagic group `AA CORE STYLES` |
| Platinum / Rocket | Shopify export through Demand Planning (`reportPipeline.getStyleTiers`); Planning reads, never recreates, never changes them |
| Official launch date and product age | ApparelMagic `mid_code` |
| First 28 / latest 28 day launch pace | Shopify export (Demand Planning). Needs 56+ days of history, otherwise "too new to compare" |
| 7 / 14 / 30 day and since-launch sales | ApparelMagic online sales (ONLINE SALES + ICONIC ONLINE SALES, approved, net of cancellations) |
| Ad performance | Meta-reported CPA with the funnel-specific benchmarks in Meta Performance settings. Triple Whale is not substituted. DPAs excluded |

The two sales sources are labelled, never blended. If their latest-28-day figures differ by `sales_discrepancy_pct` (35%) and `sales_discrepancy_min_units` (10), the item
says so and is held at Medium.

## Opportunity types

One primary recommendation per product (`planningPrimary.js`); other types it qualifies for are listed as "also qualifies".

* **Core**: an official Core product with real current demand, enough stock, a relevant season, and a creative need.
* **Revive momentum (High Stocks)**: a Platinum or Rocket product, 56+ days of history, last 28 days below `revival_decline_pct` (50%) of its first 28, **and still selling**:
  at least `revival_min_recent_units` (20) in 30 days and at least `revival_min_pace_pct` (10%) of its own launch pace. A High Stocks result never replaces a Core result.
* **Protect momentum**: a genuine recent launch (within `momentum_window_days`, 60, of its official launch date) with real demand. No decline, tier or 56 days of history is required.
  An official Core product keeps its Core identity; a non-Core one appears in its own view labelled "Not Core: recent launch". Sales are normalised per day on sale, never compared with a full month;
  fewer than `momentum_min_days_live` (5) days of selling is "too early".

## Demand and stock

Demand is judged on **absolute units in 30 days**: very weak below 8, weak below 20, steady below 50, strong from 50. Trend compares the last 7 days with the weekly pace before them and
needs a change of at least 25% **and** 2 units a week, so 2 to 1 is noise while 100 to 70 is a real weakening. Weak demand can never be High.

Stock: cover = sellable units / the faster of the 30 day and 14 day weekly pace.

| Cover | Result |
|---|---|
| under 30 units | never recommended |
| under 4 weeks | not recommended unless a confirmed restock closes the gap |
| 4 to 26 weeks | full points |
| 26 to 52 weeks | half points (slow mover) |
| over 52 weeks | no points, and not recommended on weak demand |

Deeper decline is never rewarded: revival recoverability points are non-increasing as the product falls further from its launch pace.

## Season (Australian)

Category prior from the product name and category: summer items (S/S shirts, tees, shorts) in season October to March; winter items (sweats, hoods, trackpants, fleece) May to August;
1/4 zips are transitional and **never excluded**; jeans and pants are neutral. A one-year sales pattern may overrule the prior only with a strong index (`season_pattern_index`, 125%).
November and December peaks are Black Friday / Christmas promotion months, not seasons. An out-of-season product qualifies on an exception only with `season_override_units` (60) in 30 days,
demand that is not weakening, and creative evidence; it is then held at Medium and says why.

## Creative assessment

Verdicts per creative come from `productAdPerformance.js`; distribution comes from `creativeEvidence.js`.

* Confirmed gap, effective running, underperforming, still testing, credible fatigue, concentration, low concept diversity and matching uncertainty are distinct.
* **Credible fatigue** needs the recent window to cross the funnel benchmark or CPA and CTR to worsen together on enough spend; a CPA rise that stays inside the benchmark is "softening" and still performing.
* **Concentration**: one creative carries 80% or more of spend (and of purchases when there are enough) once at least 300 has been spent.
* **Diversity**: judged only when 70% of meaningful spend is on creatives with a concept recorded.
* Paused ads are historical evidence (direction, season exception), never coverage.
* Any suggested match awaiting review is **uncertainty**, not absence of creative.
* The test period (`test_period_days`) holds back a product with modest demand, but does not silence a strong seller that still lacks creative. One concept in production does not block everything.

## Score and priority

Demand up to 38, creative need up to 28, season up to 15, tier and recoverability, launch strength, recency, stock up to 10, minus a penalty for supply already in play. High from 65,
Medium from 45. Caps hold an item at Medium for: modest demand, incomplete or under-counted sales, source disagreement, out-of-season exception, a revival that is still weakening on non-strong demand.
Every item exposes its score parts, caps and the eligibility rules it met.

## Data reliability

ApparelMagic sales are fetched one day and customer per request. Failed days inside the last 30 are recorded; the item then reports "under-counted" and cannot be High. Missing sales, stock,
launch dates, Meta data or benchmarks produce "insufficient data" with the reason, never a guess and never red.
