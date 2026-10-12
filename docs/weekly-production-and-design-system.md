# Weekly creative production + design system (Batch 12)

This note explains how the weekly video plan works and how to change it. Nothing here is a business target: every number is a configurable default that a person can change in **Settings → Planning**, and the plan never invents a performance benchmark.

## What a "video" is

One **video** is one video-format concept (a `creative_assets` row linked to a Shoot Plan item). Hook variations of the same concept are edits of one video. A product can have several videos in the same week.

* The weekly target (default **25**, allowed **20–30**) is a count of videos, stored in `planning_settings.weekly_video_target`.
* A Shoot Plan item is still one product-week workspace. Its planned quantity is `shoot_plan_items.planned_videos`; the effective planned quantity is the larger of that number and the video concepts that already exist, so a quantity can never be lowered under work that exists. No extra production records are created: the quantity is a number on the existing item.
* Choosing the same product again (from Core, High Stocks, the Weekly Plan or by hand) merges into the existing item (it raises the quantity, adds colourways, never lowers it). Drops and Promotions keep their own items and workflows.

## How the weekly plan decides

Every product family (colourways grouped, stock counted once) gets a score from two sides.

**Need for new creative**

| Signal | Points |
| --- | --- |
| Confirmed active ads below the minimum (0 ads / ≤40% / ≤80% / closer) | +25 / +20 / +12 / +8 |
| Ads awaiting match review that could close the gap | 0 (treated as uncertain, never as a shortage) |
| Effective coverage from the unique creatives: healthy / mixed / thin / unclear | −12 / +8 / +14 (+3 per clearly weak creative, max +10) / 0 |
| At least half of the judged creatives are weak or fading | +10 |
| Creatives declining against their own earlier results | +4 each, max +10 |
| Newest running creative older than the "old" / "ageing" age | +15 / +10 (younger than 14 days: −5) |
| Many creatives but only one or two concepts | +8 / +4 |

**Worth investing in**

| Signal | Points |
| --- | --- |
| Current sales: strong / mid / weak (percentile of launched, in-stock products; needs at least 8 to rank) | +20 / +8 / −15 (rising +5, falling −4) |
| Stock: out / low / ok / high (a confirmed restock softens the first two) | −40 / −15 / +6 / +10 |
| Season starting within the immediate window (default 7 days) / secondary (14) / out of season | +12 / +5 / −10 |

The category comes from the score (defaults): **Shoot now** ≥ 45 (and at least 15 need and 14 worth), **Coming up** ≥ 25, **Monitor** ≥ 10, otherwise **No action**. These guards can only lower a category: unknown launch status, out of stock, weak sales with no seasonal lift, missing sales data, no Meta data at all, or an unclear picture with no real need. A manual priority can raise or hold one.

A plain-language reason is kept for every signal, including the ones that scored zero or were not available.

## Video quantities

For Shoot now products only: a need tier (high ≥ 35, medium ≥ 20, low ≥ 10) crossed with a demand tier (strong ≥ 30, ok ≥ 12, otherwise low) gives the number of videos:

| | strong demand | ok | low |
| --- | --- | --- | --- |
| high need | 5 | 4 | 2 |
| medium | 3 | 2 | 1 |
| low | 2 | 1 | 0 |

capped at 6 per product. Videos from earlier weeks that are still in production are subtracted. Only Shoot now work competes for the weekly capacity; unused capacity is never filled with weaker products ("Only 10 worthwhile videos were identified for the 25-video target…").

## Examples (fixtures from the test suite)

* **Many poor ads vs few strong ones.** A product with 8 confirmed active ads that are only 5 unique creatives (one creative reused by three ads, one a "- Copy"), of which one performs, three are over the approved CPA limit and one has too little spend, scores **69** and is *Shoot now*. A product with 2 active ads, both inside the approved CPA, scores **47**. Having five or more ads does not mean having enough creative.
* **No padding.** With 12 healthy filler products and two weak ones, the plan recommends 10 videos against a target of 25 and says so.
* **No duplicate shoot.** The same product planned from Core and then from High Stocks stays one entry; its quantity is raised, not duplicated. Videos already in production are subtracted from the recommendation. A product with an unconfirmed launch status is held at Monitor.

## Ad performance

Per unique creative (same Meta creative id, or a "- Copy" of the same name, counted once; confirmed or auto-matched, non-excluded, active ads only; bundle ads are attributed to each product they carry without being double counted inside a product) the plan reads the last 14 days: **performing / underperforming / declining / insufficient data / unrated / unavailable**.

* CPA is judged with the approved benchmarks (MOF ≤ $60 green, over $60 to $72 orange, over $72 red). A funnel with no approved benchmark is *unrated*, never judged.
* A creative needs at least $60 spend and 1,000 impressions (configurable) before it is judged. *Declining* compares the latest 7 days with the 7 before, with its own minimum spend.
* Frequency and Reach are not summed across ads, so they are not used at product level; the TOF Frequency benchmark (under 2 / 2–2.4 / over 2.4) stays on Meta Performance and only applies to 3–5-day periods.
* Weak creative is reported as weak creative, not as proof that creative was the cause.

## Launch status

(Superseded by docs/launch-status.md section 4a: the ApparelMagic date field is unverified and a passed date is no longer proof.) A product is **launched** when it has sold, or is in stock with a launch date in the past, or has been marked launched by hand; **unlaunched** when its ApparelMagic launch date is in the future, it belongs to an upcoming Drop, or it has been marked so by hand; **discontinued** only by hand; otherwise **unknown** (flagged, held at Monitor, never assumed). Unlaunched products leave High Stocks, Core and the Weekly Plan, and stay in Upcoming Drops. Stock, zero sales or "Last creative: never" are never used to guess.

## Database (additive, idempotent)

`planning_settings`: `weekly_video_target`, `season_immediate_days`, `season_secondary_days`, `creative_planning_config`. `shoot_plan_items`: `planned_videos`, `recommended_videos`, `video_mix`, `recommendation_snapshot`. `creative_priority_overrides`: `videos`. New table `product_launch_overrides`. No row is changed by the migration.

## Design system

Tokens live at the top of `public/styles.css` (colour, spacing, type, radius, elevation, focus ring) and the shared components (buttons, tabs, forms, tables, badges, cards, modals, empty states) at the bottom. The palette is **provisional** (dark navy sidebar, navy primary buttons, subtle purple active states, off-white page, white cards, soft grey borders, no teal) until it is reconciled with the reference screenshots; changing a token restyles the app.
