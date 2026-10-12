# Batch 14: Creative Planning, Performance Intelligence and the WNDRR design system

Status: implemented and tested locally on branch `batch14` (from main `48fd5c7`). Not pushed, merged or deployed.

## 1. Workflow

Planning is now **Core -> High Stocks -> Shoot Plan**. The Weekly Plan screen, the 25-video target, the automatic video allocation and the
recommended / deferred capacity split are gone from the app. Backend modules that history or Settings still depend on
(`weeklyVideoPlan*.js`, the launch-override and tuning endpoints) are kept and marked RETIRED AS A WORKFLOW in their headers; no data was removed.

The weekly goal is **15 new concepts** (`planning_settings.weekly_new_concept_target`, an existing setting, editable in Settings).

## 2. What counts as a concept (`src/lib/shootPlanProgress.js`)

One concept = one `creative_assets` row (the existing Concept Development record). There is no parallel tracking table.

| Stage | Derived from |
|---|---|
| Uploaded | `status = 'uploaded_live'` |
| Approved | `final_approval_status = 'approved'` |
| Edited | `editing_submitted_at` set |
| Filmed | `shoot_schedule.status = 'shot'` |
| Awaiting production | `concept_dev_status = 'approved'`, not yet shot |
| Planned | anything earlier |

* A concept adapted for several products is **one** row; extra products live in the additive `concept_product_links` table and never add to the count.
* Several concepts for one product are counted separately. Final Edits (Primary Hook, Alt Hook) are never counted. Killed concepts are excluded.
* Week = the `shoot_plan_items.week_start` the concept was planned in.
* Mon plan / Tue-Thu film-edit-approve / Fri upload needs nothing new: stages come from the existing Shooting, Editing, Final Approval and upload steps.
* **Carryover:** unfinished concepts from earlier weeks are never reset, hidden or auto-completed. They are listed separately in their real stage and are not counted toward the new week's 15.
* If fewer than 15 products genuinely qualify, the page shows the shortfall in words. It never pads the list.

## 3. Core (`src/lib/planningOpportunities.js`, loader `planningOpportunitiesLoader.js`)

Core is a list of products that genuinely need creative **this week**, not the catalogue. Per product the engine weighs:

* sellable stock (and weeks of cover at the current pace), recent and historical sales, season, official launch status (`mid_code`)
* unique Meta creatives (grouped by creative id, not ad count), judged against the **approved** benchmarks only (`productAdPerformance.judgeCreative`); no CPA targets are invented
* creative recency phase (`creativeRecency.js`): testing / recently launched and weak / recently launched and performing / established performing / declining / weak / stale / unrated
* last new creative, planned / in-production concepts (from the Shoot Plan), and DPA exclusion

Statuses: `act` (needs creative now), `testing`, `in_production`, `covered`, `momentum_ok`, `insufficient_data`, `unavailable`, `out_of_season`, `low_stock`,
`weak_demand`, `no_proven_demand`, `too_new`, `not_launched`, `launch_unknown`. Only `act` is a recommendation. Out-of-season products are a separate, non-action view
(they can still be planned deliberately with "Plan anyway"). Every recommendation carries a headline, the structured reasons (gap, what was tested, why this week) and a
creative direction **only when that product's own history supports one**.

Minimum data thresholds (all in Settings > Recommendation settings, provisional): `test_period_days` 14, `recent_creative_days` 30, `stale_creative_days` 90,
`opp_min_recent_units` 8, `opp_min_stock_units` 30, plus the existing `min_spend` / purchases evidence rules from Meta Performance.

**Seasonality** (`seasonRelevance.js`): combines a category prior (WNDRR's stated Australian rule: tees, shorts, swim, lightweight shirts in; winter trackpants and heavy fleece out;
jeans and long pants are NOT blanket-banned) with the data-driven monthly pattern from `seasonality.js`. The prior is a business assumption supplied by WNDRR, labelled provisional,
and lives in one table. A product selling strongly now is not excluded for being out of season; that exception is shown.

## 4. High Stocks

High Stocks = non-Core products already classified **Platinum or Rocket** by Demand Planning, which still have the stock to justify more creative **and** have lost momentum
(last 28 days below `revival_decline_pct` of the first 28 days, selling for at least `revival_min_age_days`, at least `revival_min_cover_weeks` weeks of stock).
High stock with poor sales is not a revival. A sales decline is never attributed to creative fatigue automatically: the card lists other explanations the data supports
(stock-outs, seasonality, launch timing, price/promotion unknown) and says what is not known.

**Platinum / Rocket source.** Demand Planning's tiers are produced by the Report Pipeline from the Shopify sales export, via `reportPipeline.getStyleTiers()` (reused unchanged apart from
additive fields: first sale day, 4-week/28-day units, `isNew`, `censored`). They are not stored in this database. If the classification cannot be read, High Stocks says so and
recommends nothing. Limitation: products older than the export window (~12 months) are flagged `censored`, because their first 28 days cannot be seen.

## 5. Feeding the Shoot Plan

Core and High Stocks select directly (`POST /api/opportunities/prepare-shoot`, which only creates local `styles` rows for one product, idempotently). The recommendation reason is saved as
`recommendation_snapshot` on the Shoot Plan item and survives to Concept Development. Core and High Stocks are deduplicated (a product in both appears once, tagged "High Stocks revival").
The modal chooses the number of distinct concepts (1-10); concepts already planned / in production / recently uploaded for the product are shown so the same creative is not requested twice.
A concept can be adapted for another product from the Shoot Plan without adding to the count.

## 6. DPA exclusion (`src/lib/metaDpa.js`)

Detection (none of it guesses): classification `DPA`, campaign objective `PRODUCT_CATALOG_SALES`, or the **whole word** DPA in the ad or campaign name
(regex `(^|[^A-Za-z0-9])DPA([^A-Za-z0-9]|$)`, so "UPDATE", "DPAC" and "ADPA" do not match). Applied at read time; nothing is deleted or modified.
DPAs are excluded by default from Meta Performance (table, summary cards, Reach/Frequency scope note), active-ad coverage, creative judgement and recommendations.
`?dpa=include` (the "Include DPAs" toggle) shows them. The totals always say "DPAs excluded" or "DPAs included" with the hidden ad count and spend.
Limitation: an unlabelled DPA in a non-catalogue campaign cannot be detected.

## 7. Coverage confidence ("18 opportunities, 18 coverage uncertain")

Root cause: coverage was bounded by *confirmed + possible + every unattributed ad in the account*, so a single global pool of ads awaiting Ad Matching made every product look
uncertain. Fixed: the upper bound is now confirmed + ads that *possibly* belong to the product. Uncertainty is reported separately from performance, and "insufficient data" /
"uncertain matching" never become a shoot recommendation.

## 8. Launch verification (1,791 products)

Root cause: the Weekly Plan assessed the whole catalogue (every historical style) for launch status, so every style without a usable `mid_code` landed in the verification list. The list is
now limited to products that matter today (stock, an open order, or recent sales); historical products are counted but not listed. Batch 13 rules are unchanged: `mid_code` is official,
future dates exclude, past dates mean launched, manual overrides win, Shopify sales never override, colourways are individual, missing/invalid goes to verification.

## 9. Weekly refresh without scheduled jobs

Opportunities are computed on request and memoised; saving a plan, a concept change, a launch override or a setting invalidates the memo. A product whose new creative is still testing
is not recommended again; nothing is auto-completed; unfinished concepts carry over.

## 10. Visual design

Sidebar uses the real WNDRR wordmark taken from the Demand Planning app (cropped and converted to transparent PNG/SVG, not redrawn; files in `public/brand/`). The WNDRR Global, Warehouse
Management and Tuesday reference screenshots were **not available** in the build environment, so the styling follows the written brief only and is provisional (all values are tokens at the
top of the Batch 14 block in `public/styles.css`). Decorative emojis were removed from navigation and labels; icons are monochrome outline SVGs from one inline sprite.

## 11. Meta Performance layout

Summary cards wrap (`auto-fill`) so Amount Spent and Purchase Value are never truncated; the table scrolls horizontally inside its wrapper with a 300px+ ad-name column (two-line clamp,
full ad and campaign name on hover), right-aligned tabular numbers, 40px thumbnails and a visible Frequency column; CPM card and column kept. Soft full-cell colours and the approved
benchmarks (MOF CPA <=$60 green, $60-72 orange, >$72 red; TOF Frequency <2 / 2-2.4 / >2.4 for 3-5 day windows only) are unchanged. Benchmark rules and timestamps moved into a collapsed
"Benchmarks in use" block and tooltips.

## 12. Migrations

One additive, idempotent block in `db/schema.sql`: `concept_product_links` (+ indexes). No existing table is altered or dropped; no data migration.
