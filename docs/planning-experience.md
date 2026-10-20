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
* **Action**: every product can be added by hand. A black `+ Shoot` where creative is needed (or nothing is assessed), a quieter outline `+ Shoot` where the engine does not recommend new creative (covered, or not recommended: the shoot form still asks before using a restricted colourway), `✓ Shooting` once selected. Only products that cannot be planned (not launched or launch not confirmed, or a past week) show a plain `View`.
* **Sorting**: header buttons plus a Sort menu (Product, Priority [Needs only], Sales 30D, Stock on hand, Live ads).
* **Weekly strip**: concepts planned / target, remaining, products selected, carried over, `View Shoot Plan`, and a thin "Weekly creative goal" progress bar.
* **Expanded panel**: A) large thumbnail, name, priority, recommendation headline + one explanation, Add action; B) three metric cards; C) compact colourway grid (available vs unavailable, stock, sizes, shootable; selection rules unchanged); D) three collapsibles: Why was this product recommended? / Recent live ads / Additional details. All previous evidence is kept inside them.

## Planning -> Core and High Stocks: a prioritised creative task list

Presentation only (`public/planning.js` `plCore*` functions, `PlanningExplain.coverage` / `coreStatus` / `whyShoot`, CSS). The engine, benchmarks, matching, scoring and Shoot Plan writes are unchanged. **Core and High Stocks share one table and one expanded view** (Batch 33: before it, High Stocks still had the Batch 32 layout); only the title, subtitle and tier note differ.

* **Card header**: title, a High / Medium (/ Low) summary with the product count, search, Opportunity, Priority (Needs creative only) and Sort (default Recommended order), then the tabs Needs creative / Covered & monitoring / Needs review with counts.
* **Table**: `#` (plain rank, Needs creative only) | Product (62px square thumbnail, `object-fit: contain`) | Sales (30D) with the 7D trend underneath | Stock with weeks of cover | **Creative coverage** | Creative gap | Priority (Needs creative only) | Action. White rows, grey dividers, no row highlighting.
* **Creative coverage** (`PlanningExplain.coverage`):
  * Line 1 is **Active Ads** (`5 Active Ads`, `1 Active Ad`): the number of genuinely different creatives delivering on Meta now. A creative counts when at least one of its instances is ACTIVE, confirmed / auto matched to the product family (all colourways), not a DPA, and delivered inside the configurable delivery window (`live_delivery_days`, default 7). One creative running in several campaigns, ad sets or funnels counts once, and `- Copy` / `- Copy 2` / `- Copy - Copy` duplicates fold into one (below). It is the engine's `live_creatives` fact. When stored Meta delivery is too old to judge it shows a dash, never a guess.
  * Line 2 is `Latest: 18 Sep`: the newest creative date written in the ad names (`lastCreativeDate.js`, unchanged) from ANY matched creative, paused and historical included, never a delivery or modified date. The two lines use different populations on purpose: `0 Active Ads / Latest: 18 Sep` is correct. `Unknown` = creatives exist but none has a reliable name date; `None` = no creative on record; `?` = an undated creative was made after the latest dated one. The year is added when it is not this year.
* **Creative identity** (`productAdPerformance.js`): one creative = an identical Meta creative id, or ads whose names differ only by a trailing duplicate suffix (`metaNameCopies`: ` - Copy`, ` - Copy 2`, ` - Copy - Copy`, any repetition; a dash and the word at the END only, so "copy" inside a title is content). Batch 33 root cause: `mergeNameCopies` folded a copy only into an ORIGINAL that was itself in the set (an active, matched ad with exactly the base name). When the original was paused or unmatched, the copies (each with its own Meta creative id) were never folded into each other, so four copies of one execution counted as four creatives. `mergeCopySiblings` now folds copies sharing a canonical name (and the plain-named original when present). Different executions, similar names and identical names without a suffix are never merged. The merged creative keeps one pooled result PER FUNNEL (`funnel_results`: spend, purchases, CPA, state), judged against that funnel's approved benchmark; nothing is averaged across funnels, no ad is counted twice, and a funnel with no approved benchmark is unrated, not underperforming. The original ad's dates win, so a duplicate never resets the age or the production date. This is Planning only: Creative Insights keeps `mergeNameCopies` unchanged (the same fix is available there if wanted).
* **Creative gap** (`coreStatus`, the engine's own result): No Active Creative, Underperforming Creative ("Only 2 of 8 creatives performing."), Low Creative Coverage, Old Creative, Concentrated Delivery, Creative in Testing, In Production, Performing Well / Adequately Covered, and the grey review reasons. Red = attention, amber = monitoring / testing, green = covered, grey = not enough information. Missing benchmarks or delivery are never worded as poor performance.
* **Action**: purple `+ Add to Shoot Plan` on Needs creative rows, a quiet outline version on Covered and Needs review rows, and an expand control. Once the product is in this week's plan it reads `In Shoot Plan`, in the row and the expanded view alike; a click adds another concept to the same record (the Shoot Plan modal never creates a duplicate product).
* **Expanded product**: the Upcoming Drops picture panel with the colourway pictures under it; name, priority and category; the Add action; "Why shoot this product?" with ONE sentence (`whyShoot`); three metric cards (Sales 30D with the 7D trend, Stock on hand with weeks of cover, Active / effective creatives); the colourway cards; and one `View Meta Ads ->` button (shown only when the product has matched ads).
* **View Meta Ads**: opens Meta Performance (`#meta-performance/product/<key>`) with the Ad Performance TABLE scoped to the product through the product-to-ad matching: `GET /api/meta-performance/ads?product=CODE1,CODE2` (the family's style codes; `metaPerformance.parseProductScope`) keeps ads whose confirmed / auto-matched association includes one of the codes. All statuses, all three funnels, each Meta ad as its own row (copies are NOT merged here, so copies can be compared across campaigns and funnels), within the selected date range. The date range, DPA choice and benchmarks are the page's own; the summary cards and every calculation are untouched. A chip above the table names the product and offers `Clear product filter` and `Back to Planning`; browser Back returns to the Planning section it came from, and opening Meta Performance from the sidebar is never scoped.
* **Colourways**: a tick, the Drops tile picture (whole, uncropped), name (else SKU), units, size availability and `Ready to shoot`. Colourways that can be shot are ticked; the others are dimmed, say `Can't shoot now` with the reason and cannot be ticked here. The ticked colourways are what the Shoot Plan modal opens with, from the row button or the panel button alike; unticking all of them refuses the add with a message. The existing stock and size eligibility rules decide readiness; a restricted colourway can still be chosen inside the Shoot Plan modal, which asks first.
* **Not shown in Planning any more**: the recommendation engine's evidence, scoring, eligibility rules, matching confidence, data freshness and the embedded Meta ads table. They are still calculated and available through `/api/opportunities` and Meta Performance.

## Table refinement: 7-day sales trend and calmer rows

Visual only (`public/planning.js` `plMetricsCell`, `PlanningExplain.salesTrend`, CSS). The engine, priority and status are untouched, and the trend never feeds them.

* **Rows** are white (open or closed), with grey dividers and a very light grey hover. No coloured left borders and no ranking backgrounds.
* **Key metrics** are flat (no boxes) and read across the row: Sales 30D with its 7D trend underneath, Stock on hand, Live ads, Last creative.
* **7D trend** = (last 7 days - previous 7 days) / previous 7 days x 100, with previous 7 days = last 14 days - last 7 days, from `facts.units7` and `facts.units14` (the sales already loaded; nothing is estimated). Green `up 12%`, red `down 24%`, grey `0%` when unchanged (rounded), `New` when the product has been on sale under 14 days or sold nothing in the previous 7 days, `No comparison` when the 14-day figure is missing or the windows do not reconcile. Both windows include today's part-day; the tooltip shows the two unit counts. This is a display figure and is separate from the engine's own demand trend.
* **Colour** is used only for the trend, the Creative status badge, the priority dot and the purple primary action. The "In Shoot Plan" state is a plain white button.

## Last Creative Uploaded (Core and High Stocks)

Read-only display data (`src/lib/lastCreativeDate.js`, attached to the finished items in `planningOpportunitiesLoader.js`). It never feeds the engine, so no recommendation, status, priority or count depends on it.

**What it is.** The creative date written in the ad name, not a verified Meta upload event. The interface says "Last Creative Uploaded" / "Last creative"; the tooltip states the source.

**Extraction.** `#CREATIVEID_YY-WKXX_DD-MM_...` e.g. `#306_26-WK38_18-09_...` is 18/09/2026 (year from YY, day and month from DD-MM). Validated, never guessed: the structure must match; the date must exist (no 31 September, no 29 February in a non-leap year); `WKXX` must agree with the date (one week either way, New Year weeks wrap); the date may not be in the future, before 2018, or more than 14 days after the ad itself was created in Meta. Anything else is "unavailable" with a reason (`no_pattern`, `invalid_date`, `week_mismatch`, `future`, `implausible_year`, `after_ad_created`).

**Unique creatives.** Same identity as the rest of Planning (`creativeGroupKey`: an identical Meta creative id, or a "- Copy" by name). Every instance of the creative (any status, matched or not) is gathered, and the date is the **original** ad's: the instance Meta created first. A newer duplicate's name date, creation date or first delivery is never used and the newest date is never silently picked. Copies that carry a different date are reported (`has_conflicts`, shown in the panel); copies that disagree with no way to tell the original are unavailable (`conflicting_dates`); if the original has no usable date but a duplicate does, the creative is unavailable (`original_undated`).

**Product.** All reliably matched creatives (confirmed or auto matched; excluded-from-intelligence and Dynamic Product Ads left out) in ANY delivery status, so paused and archived creative counts. `last_creative_uploaded_date` is the newest valid date. If an undated creative was created after it, the table shows a `?` ("may be newer"). No matched creative, or none with a valid date: a dash.

**Where.** Table, Key metrics: Sales 30D, Stock on hand, Live ads, Last creative (`18 Sep` / `2026`). Expanded panel: "Last Creative Uploaded 18 September 2026". Recent live ads: a Creative date column (original date, or the reason it is unavailable), with first and last delivery kept separate in the Delivery column. One row per unique creative.

**Limitations.** Historical ads that do not follow the naming convention have no date. A duplicate that was renamed AND given a new creative id (no "- Copy") is a different creative to the system and keeps its own name date. Shared ads matched to several products date each of them, as for creative coverage.

## Core Product Catalogue (Core page, "Core Catalogue" tab)

The full Core catalogue, separate from the Creative Opportunities recommendation list on the other tab. One row per product family (colourways of one product, same category and name, share a row), five columns:

* **Product**: picture, bold name, category in small grey, and the number of colourways. Click the row to expand it.
* **Sales (7D)**: units over the last 7 days and the % change against the 7 days before (same Demand Planning sales data; for a family the totals of its colourways are summed first, so the % is exact). Green up, red down, grey when unchanged, new (nothing sold the week before) or unavailable.
* **Stock**: stock on hand and the weeks of cover from the Demand Planning data. On order and the rest of the inventory are in the expanded detail only.
* **Creative Status**: one soft badge and one short line, taken from the Core table's own engine result for the product (`PE.coreStatus`, nothing reclassified): Creative Gap / Never Tested (no creative running; Never Tested when the product has never had one), Underperforming Creative and the other engine gap labels, Covered, Creative in Testing, In Production, Needs Review, Not Recommended, Not Assessed (not in the results). Several results for one family: the one that most needs attention is shown.
* **Action**: black `+ Shoot` where creative is needed (opens the same Shoot Plan flow as before), `✓ Shooting` once selected, a quiet `View` (opens the detail) for covered, testing, in-production and not-recommended products.

**By Category is the default view** (the category top level): one row per category with its own numbers (last 7 days' sales and the % against the previous week, last year's month-to-date against this year's with the recent months, how many products need creative, how many have old creative, and what is selected this week), ranked by how many need creative first. Open a category to see its products as the five-column rows; a search or filter opens the categories that have matches (the category numbers always cover the whole category). **Priority** is the flat list of all products in priority order.

Top controls: search (name, category, product code, colour), Priority / By Category, and All Products / Needs Attention / In Production. Needs Attention = the engine says needs creative or needs review; In Production = a concept for it is in the Shoot Plan pipeline. Priority order is the engine's (needs creative with High first, then its score, then needs review, in production, testing, covered); the server flag orders products only while the Planning results are not loaded.

Expanded product (hidden until opened) reuses the Creative Opportunities components: the product picture with colourway thumbnails; a recommendation banner (the engine's status and sentence) only for products the engine says need creative; three cards (Sales: 7-day units, the % against the previous 7 days, 30-day units; Inventory: stock on hand, on order, weeks of cover; Creative Performance: performing of active creatives, underperforming, last new concept, past creatives in subtle grey); the selectable colourway cards (ready to shoot / out of stock, sizes, tick boxes; ticked colourways go into the Shoot Plan as ONE product record through `+ Shoot`, like Creative Opportunities); and a collapsed **More details** (previous 7 days, this month vs last year, weekly rates, the category's monthly history, inventory metrics, creative history and freshness, last new concept, Plan a new concept) with a View Meta Ads link. Products with no engine result still expand (picture, the cards, a plain colourway list) and keep the earlier `+ Shoot` form. The server adds `prev_7d_units` to each product's cadence (the % formula is unchanged).

## Creative Insights (Planning > Creative Insights)

A creative decision tool over the existing insights engine (`src/lib/creativeInsights.js`: unique creatives, concept matching from the confirmed Ad Matching classifications, approved-benchmark verdicts per funnel, product suitability). Nothing about how a concept is rated or suggested changed; the page only presents it.

* **Summary:** Established Winners, Promising Concepts and Concepts Analysed (counted from the concept records themselves, so they always reconcile with the table), a slim indicator of the share of Meta spend that has a concept assigned, and the long benchmark explanation inside the "How concepts are rated" info section.
* **Concept table:** Concept | Tested ("7 products · 6 creatives") | Performance (badge: Established Winner green, Promising Test amber, Mixed Performance grey, Underperforming red, Insufficient Evidence grey, with one funnel's CPA labelled TOM / TOF / MOF underneath) | Next opportunity ("N suitable products", "No matches yet" for a winner or promising concept with none, a dash otherwise). The performance filter and search are unchanged.
* **Expanded concept:** (A) name, badge, products and creatives tested, and "Why is this concept performing this way?" (at most two sentences generated from the concept's funnel results and evidence requirements); (B) one card per funnel that has data (CPA, purchases, performing creatives and the approved-benchmark status; a funnel without an approved benchmark is grey and "not assessed", and CPAs are never combined across funnels); (C) Products tested (creatives, spend, purchases, and CPA only when the concept ran in a single funnel); (D) Where to test next (the engine's own suggestions with image, reason, stock and creative-gap, the current Shoot Plan status and `+ Shoot`, which is the existing add); then (E) a collapsed **Detailed Performance & Creative Evidence** holding the full funnel breakdown, the benchmark criteria with every Met / Not met line and the spend and purchase thresholds, the evidence and matching notes, and each individual creative (thumbnail, readable name, product, format, funnel, spend, purchases, CPA, a link to the Meta ad preview, and the full Meta ad name and IDs).
* The server now also returns each creative's original Meta ad names, IDs and status (`ad_list`) for the detailed evidence.

## High Stocks: "Other High Stock Products"

High Stocks has no product limit: it lists every Platinum / Rocket product that passes the engine's rules (often only a handful). Under the recommendations, **Other High Stock Products** lists products the engine already evaluated but did not recommend because of one rule (sales too low, stock runway, out of season, not enough selling history yet), closest to selling first (30-day units), until the page shows 10 products in all. They are not recommendations: each row shows the engine's own status and sentence for the rule it missed, can be expanded, and has the quiet Add to Shoot. Products that cannot be planned (not launched) and ones that are simply still performing are not listed. The section hides itself when the recommendations already number 10 or more, and follows the search box. No rule, threshold or score changed; to make more products genuinely qualify, adjust the thresholds in Settings > Planning.

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

## Upcoming Drops: Product Detail

* **Header**: product name, code and colourway count, ONE combined picture of both colourways (no thumbnails beside it), `+ Plan Creative`, three chips (concepts planned, creatives completed, live on Meta) and a slim bar of completed creatives against the product's existing required target. The colourway inventory panel on the right is text only (SKU, stock on hand, on order). These are the numbers the Drop page already shows; nothing is recalculated.
* **Creative Production table**: one line per planned concept, `Concept | Reference | Assigned To | Filmed | Edited | Uploaded to Meta | Action`. A concept from the Creative Playbook carries a quiet green PROVEN badge; descriptive text and product thumbnails are not shown in the row.
* **Reference**: set once on the concept's entry in Settings > Creative Playbook (a `Reference link` field; `proven_winners.reference_id` points at one Reference Library record, never a copy), so every Upcoming Drop that uses the concept shows it. The cell shows a thumbnail (play mark for a video) and View video / View example, opening the original link in a new tab. A concept with no reference in the Playbook, and a manually added concept, shows a dash; there is no Add reference on the drop page.
* **Filmed / Edited / Uploaded to Meta**: three checkboxes read from, and saved to, the concept's existing asset status (Filmed = `filming` or later, Edited = `qc` or later, Uploaded to Meta = `uploaded_live`), through the same `PATCH /api/creative-assets/:id/status` the Board uses, so Shooting, Editing, Final Approval and the Board always agree and each change is written to the status history. There is no separate tracking and existing records keep their state. A click saves immediately; the row is locked while saving, and if the save fails the box goes back and the error is shown. Because a status is one line of progress, ticking a later milestone also marks the earlier ones and unticking one also clears the later ones; the page says so when that happens. "Uploaded to Meta" does not mean the ad is live: the Live on Meta count still comes from actual Meta data. A concept with no asset yet has the boxes disabled.
* **Action**: a `···` menu holding the editing-owner dropdown, Link existing asset and Remove. There is no Edit button (a concept with no asset yet shows `+ Create Asset`).
* **Other Creative Concepts**: the product's existing additional concepts, collapsed with a count; nothing is generated and the concept assignment to drops is unchanged.
* **Assigned To from the Playbook**: each Creative Playbook entry also has a `Default assigned to` person (`proven_winners.default_assignee`, roster only). Saving the entry (and creating a new drop concept) fills that person on every Upcoming Drop concept of that entry that has NO one assigned, or whose person was itself filled from the Playbook (`drop_product_plan_slots.assignee_from_playbook`, so a later change of the Playbook person follows it), and only while the concept is still before Filming (nothing shot or edited is re-queued). A hand-picked Assigned To is never replaced and stops following the Playbook; clearing the Playbook person changes nothing already assigned. It goes through the same Shooting hand-off as picking the person in the dropdown, which stays for per-product overrides. The Playbook toast says how many concepts were assigned.
