# Planning experience (Batch 28)

A UX-only redesign of Planning. **No recommendation calculation changed**: demand, stock, season, Core classification, launch dates, Protect Momentum, creative coverage / effectiveness /
fatigue / concentration / diversity, matching confidence, production activity and data uncertainty are exactly as in Batch 27 (`docs/planning-intelligence.md`). Meta Performance was not modified.

The page answers three questions in order: **what needs shooting, why, and how to organise the shoot**.

## Navigation

Planning is one sidebar item with an expandable sub-menu, the same pattern as Meta Performance (own CSS class `sidebar-sub-pl`, so Meta Performance's wiring never sees it):

* **Core**, **High Stocks**, **Shoot Plan**. Clicking *Planning* opens Core. The sub-menu shows while Planning is open and collapses when you leave. The active section is highlighted; a small tick marks a section that is reviewed (Core / High Stocks) or confirmed (Shoot Plan).
* The numbered in-page buttons (1 Core, 2 High Stocks, 3 Shoot Plan) and the "Continue to ..." footers are gone: no duplicate navigation.
* Deep links: `#planning`, `#planning/core`, `#planning/high-stocks`, `#planning/shoot-plan` (Back / Forward follow the sections). The pre-restructure `#planning/drop...` and `#planning/promotion...` redirects still work.
* A full page refresh still lands on the Dashboard: that is the app-wide landing rule introduced earlier (the leftover hash is cleared on start), deliberately not changed here.
* Past weeks only show the Shoot Plan (a historical record): Core and High Stocks are disabled in the sub-menu, as they were disabled as buttons before.
* **Protect Momentum is not a page.** It is an *Opportunity* filter option on both Core and High Stocks. Recent launches that are official Core products appear under Core; the rest appear under High Stocks labelled "Not Core: recent launch". Nothing is reclassified: the lists come from the engine unchanged, only the place they are shown differs.

## Core and High Stocks (one interface)

`plPageHtml()` renders both: a compact summary, one filter card, one table, expandable rows.

* **Summary**: `7 PRODUCTS NEED CREATIVE · 4 Protect Momentum opportunities · 2 need review`, from the real lists (zero segments are omitted).
* **Weekly strip** (header): `THIS WEEK'S SHOOT PLAN  2 concepts planned / 15 target — 13 concepts remaining`, then products selected and concepts carried over from earlier weeks, each from its own source: concepts are counted by the unchanged `shootPlanProgress` (a concept adapted for several products counts once, carried-over concepts are not new). Nothing is invented to reach the target.
* **Batch 29 note (columns):** the table is now Product, Why it needs creative, **Live ads** (restored, unique creatives), Stock, Sales 30d, Priority; see `docs/planning-accuracy.md`.
* **Batch 29 note:** the page now shows three categories (Needs creative, Covered / monitoring, Needs review); products that are not selling enough, lack stock or sizing, or are out of season are not shown (their assessment is kept). See `docs/planning-accuracy.md`. The paragraph below describes the Batch 28 grouping.
* **Four categories** replace the eight status pills. Every engine status maps to exactly one (`public/planningExplain.js`, tested), and every product stays reachable:

  | Category | Engine statuses |
  |---|---|
  | NEEDS CREATIVE | act |
  | COVERED / MONITORING | covered, momentum_ok, testing, in_production |
  | NOT RECOMMENDED | out_of_season, weak_demand, low_stock, too_new, no_proven_demand, not_recent, not_launched |
  | INSUFFICIENT DATA | insufficient_data, unavailable, launch_unknown |

  *Testing* is a condition of existing creative (it says so in the sentence; a testing creative is never called underperforming). *In production* is a small secondary indicator under the product name. *Out of season* is a reason in the sentence, not a status.
* **Table**: Product (small thumbnail, name, category), Why it needs creative, Stock (units; a quiet amber "3.1w cover" only on a short runway), Sales 30d, Priority (High / Medium with a small dot; scoring unchanged). Sorting (Product, Stock, Sales 30d, Priority) and search are kept; the Opportunity and Priority filters sit in the same card. No table cell is filled red / green / orange.
* Removed from the default table (all still in the expanded details or evidence): Sales 7d, Sales trend, Active / Effective creatives, Last new creative, opportunity classification, action buttons, tier / pace / season columns.

## Batch 32: workspace redesign (UI only)

Presentation only. The engine, Meta matching, classifications, benchmarks, scoring and Shoot Plan writes are unchanged; every label below is worded from engine output by `PlanningExplain.creativeStatus()` (pure, tested in `test/planningCreativeStatus.test.js`).

* **Table** (Core and High Stocks share it): PRODUCT (thumbnail, name, category, chevron) | KEY METRICS (Sales 30D, Stock on hand, Live ads; Live ads is still only the number) | CREATIVE STATUS (short coloured label + one sentence) | PRIORITY (Needs creative only) | ACTION.
* **Status tones**: red = creative attention (No Active Ads Identified, Underperforming Creative, Creative Fatigue); amber = monitoring / testing / thin (Concentrated Delivery, Low Concept Variety, Old Creative, Low Creative Coverage, Early Testing, In Production); green = Performing Well / Adequately Covered; grey = Needs review (Matching Uncertain, Ads Not Identified, Benchmark Missing, Insufficient Delivery, Not Delivering, Meta Data Unavailable, Insufficient Data). Missing benchmarks or delivery are never worded as poor performance.
* **Action**: Needs creative shows the purple `+ Add to Shoot Plan`, which becomes `In Shoot Plan` once the product is in this week's plan (click again to add another concept). Covered and Needs review show a subtle `View` / `Review`. Every row keeps a `...` menu with the manual Add (restricted-stock decisions are unchanged) and View details.
* **Sorting**: header buttons plus a Sort menu (Product, Priority [Needs only], Sales 30D, Stock on hand, Live ads).
* **Weekly strip**: concepts planned / target, remaining, products selected, carried over, `View Shoot Plan`, and a thin "Weekly creative goal" progress bar.
* **Expanded panel**: A) large thumbnail, name, priority, recommendation headline + one explanation, Add action; B) three metric cards; C) compact colourway grid (available vs unavailable, stock, sizes, shootable; selection rules unchanged); D) three collapsibles: Why was this product recommended? / Recent live ads / Additional details. All previous evidence is kept inside them.

## Last Creative Uploaded (Core and High Stocks)

Read-only display data (`src/lib/lastCreativeDate.js`, attached to the finished items in `planningOpportunitiesLoader.js`). It never feeds the engine, so no recommendation, status, priority or count depends on it.

**What it is.** The creative date written in the ad name, not a verified Meta upload event. The interface says "Last Creative Uploaded" / "Last creative"; the tooltip states the source.

**Extraction.** `#CREATIVEID_YY-WKXX_DD-MM_...` e.g. `#306_26-WK38_18-09_...` is 18/09/2026 (year from YY, day and month from DD-MM). Validated, never guessed: the structure must match; the date must exist (no 31 September, no 29 February in a non-leap year); `WKXX` must agree with the date (one week either way, New Year weeks wrap); the date may not be in the future, before 2018, or more than 14 days after the ad itself was created in Meta. Anything else is "unavailable" with a reason (`no_pattern`, `invalid_date`, `week_mismatch`, `future`, `implausible_year`, `after_ad_created`).

**Unique creatives.** Same identity as the rest of Planning (`creativeGroupKey`: an identical Meta creative id, or a "- Copy" by name). Every instance of the creative (any status, matched or not) is gathered, and the date is the **original** ad's: the instance Meta created first. A newer duplicate's name date, creation date or first delivery is never used and the newest date is never silently picked. Copies that carry a different date are reported (`has_conflicts`, shown in the panel); copies that disagree with no way to tell the original are unavailable (`conflicting_dates`); if the original has no usable date but a duplicate does, the creative is unavailable (`original_undated`).

**Product.** All reliably matched creatives (confirmed or auto matched; excluded-from-intelligence and Dynamic Product Ads left out) in ANY delivery status, so paused and archived creative counts. `last_creative_uploaded_date` is the newest valid date. If an undated creative was created after it, the table shows a `?` ("may be newer"). No matched creative, or none with a valid date: a dash.

**Where.** Table, Key metrics: Sales 30D, Stock on hand, Live ads, Last creative (`18 Sep` / `2026`). Expanded panel: "Last Creative Uploaded 18 September 2026". Recent live ads: a Creative date column (original date, or the reason it is unavailable), with first and last delivery kept separate in the Delivery column. One row per unique creative.

**Limitations.** Historical ads that do not follow the naming convention have no date. A duplicate that was renamed AND given a new creative id (no "- Copy") is a different creative to the system and keeps its own name date. Shared ads matched to several products date each of them, as for creative coverage.

## Plain-English reasons

Built by `PlanningExplain.reasonFor()` from fields the engine returned (`facts`, `gap.type`, `status`, `revival`, `launch_age_days`); never from a product list.

| Engine finding | Sentence |
|---|---|
| confirmed gap | Selling consistently (75 units in 30 days), but we haven't identified any active ads for it. |
| underperforming | ... but 2 of 2 active creatives are over the approved cost-per-purchase limit and fewer than 3 are performing. |
| concentration | ... but 90% of ad spend is on a single creative. |
| credible fatigue | ... but 1 creative is showing signs of fatigue and fewer than 3 are performing well. |
| protect momentum | New launch (12 days ago), selling strongly (...), but ... |
| matching uncertain | Creative coverage could not be confirmed: 3 active ads awaiting review in Ad Matching may belong to this product. |
| insufficient data | We can't confidently assess this product's creative coverage yet. |

"Selling consistently / strongly / slowly" follows the engine's own demand level. A part-period launch is described by days on sale, never as a full month. "No active creative" wording is only produced from a *confirmed* gap (never from uncertain matching).

## Expanded product

A Recommendation (+ a WHY sentence with the real numbers), B Key facts (stock, sales 7d / 30d, coverage, active / effective / testing / unrated creative, last new creative; "Not available" where unknown), C Suggested creative direction (general, from the finding, plus the engine's own product-specific direction when there is one; nothing is created), D Existing production activity, E *View detailed evidence* (collapsed: Meta creative table, sales / stock / season evidence, matching confidence, score breakdown, eligibility rules, other classifications, data freshness), F the action.

**Add to Shoot Plan** is the primary action and opens the existing Shoot Plan modal with the reason attached (writes are unchanged, `POST /shoot-plan` merges a repeat of the same product / week into one record). If the product is already in this week's plan the panel says so first; if it already has concepts in production, a confirmation explains before another can be planned. Products that cannot be planned yet (not launched, launch unknown) show why instead of a button.

## Shoot Plan

The production progress (six stage cards: planned, awaiting production, filmed, edited, approved, uploaded; concepts against the target; products that still need a concept; carried-over concepts; how concepts are counted) moved here from the top of Planning. Products, concepts, owners, sample requirements, shoot notes, adapting a concept, Confirm & Send and the CSV are the existing Shoot Plan, untouched.

## Favicon and title

The app already shipped the official WNDRR wordmark (white on black) as `brand/favicon-32.png` / `favicon-64.png`. The generic icon came from browsers that request `/favicon.ico` by default and found nothing. `public/favicon.ico` now serves the same artwork (PNG-in-ICO, 32 and 64 px), declared first in `<head>`. Title is "WNDRR Creative". No blue, no video icon.

## Benchmarks: how Planning uses them (inspected, not changed)

Findings (no benchmark value, setting or Meta Performance behaviour was changed):

* **Planning already reads the Settings > Benchmarks values.** `planningOpportunitiesLoader` calls `metaBenchmarks.getEffective()` (the `meta_performance_benchmarks` table, falling back to the built-in approved rules only if the table is unreadable) and passes `rules` / `coded` to `productAdPerformance` and the creative-history loader; `judgeCreative` then calls the same `metaFunnelHealth.classify()` Meta Performance uses. The source (`settings` or `default`) is returned as `data.benchmarks_source`.
* **TOF / TOM / MOF are handled correctly, with an important consequence.** An absolute verdict (performing / underperforming) needs an approved benchmark for the creative's single funnel. Today only **MOF CPA** has one (green <= $60, orange to $72, red above). **TOM CPA** is colour-coded but has no approved target, and **TOF CPA** is not colour-coded, so creatives in those funnels are **unrated**: shown with their numbers, never called good or bad, never counted as performing, and never called underperforming. A creative running in more than one funnel is also unrated (it is not judged against one funnel's benchmark). When WNDRR later adds a TOM (or TOF) CPA benchmark in Settings, Planning picks it up automatically through `getEffective()`: no Planning change is needed.
* **Unrated creatives**: counted in "Unrated creative" in Key facts, listed with phase "unrated" in the creative table, never effective, never a reason to call coverage weak on their own. If at least half of a product's creatives are unrated the explanation says no benchmark applies.
* **Reach and Frequency** benchmarks are deliberately not used by Planning: they do not add up across days or ads (see the header of `productAdPerformance.js`), so they stay on Meta Performance's exact-range view.
* **Not benchmarks, but numbers worth knowing about.** Planning has its own provisional evidence thresholds (`productAdPerformance.js` `DEFAULTS` and `creativePlanningConfig.js`, editable under Settings > Planning): `min_spend` 60, `min_impressions` 1,000, `min_performing_creatives` 3, fatigue windows and minimums, concentration 80% / $300. `min_spend` of $60 is documented as "about one approved MOF CPA of spend" but is a separate number: if the MOF CPA benchmark is edited, `min_spend` does not follow. This is the one duplicated figure found; no other CPA constant is hardcoded in Planning.
* **Smallest safe integration for a later batch** (only if wanted): derive the default `min_spend` from the effective MOF CPA green limit (`rules.MOF.cpa.green.lte`) when `min_spend` is not set explicitly, and show "judged from $X (the approved MOF CPA)" in the evidence. No engine change is required for anything else.

## Tests

`test/planningExperience.test.js` (wording and status grouping against real engine output, page wiring, favicon / title, Meta Performance wiring untouched) plus the existing 568. The browser journey and database checks are described in the Batch 28 report; they use route interception for `/api/opportunities` (real engine output) and the isolated local QA database for the write test.
