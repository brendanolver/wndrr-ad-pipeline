# Planning: selection tray, Shoot Plan and Confirm Shoot Plan

Engine calculations, recommendation algorithms, product eligibility, stock and the Shooting / Editing / Final Approval workflows are unchanged. This is the product-selection and hand-off workflow only.

## The flow

Planning (Core / High Stocks / Creative Insights) -> **Add to Shoot** -> the **selection tray** -> **Shoot Plan** (one card per product) -> **Confirm Shoot Plan**. Concept Development is a separate workflow: it lists the products of a confirmed week and is not part of this page. Concepts are completed there; only concepts submitted with Ready for Review reach Tuesday Review.

## What a "selection" is

A selection is a `shoot_plan_items` row for the planning week (plus the Concept Development concept(s) started with it). There is no second selection store, so it persists in the database, is scoped to its week, and survives tab changes and reloads. The existing rule still applies: a product can only be selected once per week (a repeat merges into the existing record; nothing is duplicated, client or server).

* **Add to Shoot** (Core, High Stocks, Creative Insights) is one click. It uses the same `POST /api/shoot-plan` as the "Shoot This Week" form, with: the colourways that can be shot now (or the ones ticked in the expanded row), Settings default sizes, the default content creator, one concept. "More options..." / "Add another concept..." in the expanded row opens the full form (colourways, sizes, concept type, number of concepts). If no colourway can be shot right now the full form opens instead (it asks before overriding a stock restriction).
* Entries that **Upcoming Drops** assignments create so Shooting can pick a Required Concept up are *not* Planning selections: they carry `shoot_plan_items.auto_linked` (new rows) or are recognised by the same rule (a Drop entry whose concept fulfils a Required Concept slot; older rows). They never appear in the tray or on the Shoot Plan page and are not removable there. Shooting, Editing and Concept Development are unchanged.
* Entries made on purpose elsewhere (Promotion concepts, manually started concepts) are still shown, with a small source label.

## The tray

Directly under the Planning tabs, sticky while scrolling, on Core / High Stocks / Creative Insights, hidden when the week has no selections and on the Shoot Plan page. Shows the count, up to five thumbnails then "+X", a purple "View Shoot Plan" button and a collapse control (remembered in the browser). Past weeks are read-only.

## Shoot Plan page

A simple operational hand-off: which products are shot this week, who shoots them and which samples the warehouse pulls. Nothing on the page develops, reviews or approves a concept (no concept counts, names, Manage / Open concept or + Concept; existing concept records and their links to products are untouched).

* **Header**: the Planning tabs and week selector, and top right **Confirm Shoot Plan** (once confirmed: "Shoot Plan confirmed · date" with **Edit plan**).
* **Summary bar** under the heading, all live from the week's records (`shootPlanStats`): *Products selected* (unique products), *Samples selected* (every selected colourway + size, in the office or not), *To request from warehouse* (the selected samples NOT marked as already in the office) and *Shoot assignments* (products with a shoot owner). The **ApparelMagic Sample Pick List** is in the same bar (`Download CSV`, the same export and fields as before; it lists only the samples to request, and is disabled when there are none).
* **Cards** (four across on desktop, then 3 / 2 / 1): one image, name, colourway count and source (Core, High Stocks, ...), a **sample readiness** line, then *Shoot owner* (dropdown of the existing content creators, saved straight away to the Shoot Plan record), one line **"4 colourways · 4 samples — Edit →"**, and **Shoot notes (optional)** (collapsed by default, saved to `shoot_plan_items.shoot_notes`; not a concept field). A subtle **X** removes the product from this week's plan only (the existing removal, below).
* **Select samples** (Edit →) is one wide dialog, "Select samples — PRODUCT": a row per colourway with a tick, a 52px thumbnail that shows the whole garment (`object-fit: contain`, padded, original aspect ratio), real colourway name (the SKU stays in the data and the CSV), *N available*, a **Size** dropdown and an **Already in office** tick (column heading ALREADY IN OFFICE; description "Select samples for the shoot. Tick if already in office."). The list and stock rules are Planning's own (`POST /api/opportunities/prepare-shoot`, which now also returns `size_stock` when ApparelMagic exposes stock by size). A colourway already in the plan is ticked; an out-of-stock colourway is never ticked for you (it is greyed and cannot be newly ticked; one already in the plan can be unticked). A newly ticked sample starts on **S** when that size has stock (otherwise the first size with stock, or the existing per-garment default for sizing systems with no S); a size with no stock cannot be chosen, and Save checks the chosen size is in stock where size stock is known. **Already in office** starts unticked for a new sample (unticked = request from the warehouse, ticked = already in the office, no transfer); a saved size and a saved In office state are always shown as saved and never replaced by a default. The footer shows live counts, for ticked colourways only (**Warehouse to send: X samples**, with a smaller muted *Y already in office*) beside **Save Samples**; nothing is saved until Save, and closing the dialog discards every change. Save is one atomic request, `PUT /api/shoot-plan/:id/samples` (the set of `{style_id, size, in_office, colour_label}`; past weeks refused), after which the card, readiness and summary update at once.
* **Sample readiness** uses stock the app already holds and never claims a sample has been picked or has arrived: *Stock available* (green) when every sample still to be requested has stock, *N sample(s) needed* (amber) when one has no stock or no size, *Availability not confirmed* (grey) when stock cannot be checked, and *Samples in office* (green) when every selected sample is marked as in the office (samples in the office are not checked against stock).
* **Where In office is stored**: `shoot_plan_item_styles.in_office` (additive column, default false). An entry added earlier as "already in the office" (`shoot_plan_items.stock_status = 'in_office'`) still reads as in office for every one of its samples, so no data is migrated; Save writes explicit per-sample flags and keeps the entry's `stock_status` in step (`in_office` only when every sample is).
* **Locked once confirmed**: a confirmed plan shows its owners, counts and notes read-only until **Edit plan** (then **Done**). Past weeks are always read-only.

## Confirm Shoot Plan

The dialog lists the products (owner, colourways, samples) and anything worth a look (colourways without a sample size, no colourways selected, no stock) and says plainly that confirming locks in the week's products, colourways, sample sizes, owners and notes. No concept is needed. It uses the existing `POST /api/weekly-shoot-plan-confirmation` (the first confirmation time is kept; a second click changes nothing), so everything that relies on a confirmed week is unchanged. `GET .../preview` is no longer used by the page.

## Removing a product

`GET /api/shoot-plan/:id/removal` (read-only) and `DELETE /api/shoot-plan/:id`:

* every concept is still an untouched draft -> the plan entry is removed and the drafts are **archived** (history and lifecycle log kept, restorable). Concepts are never deleted.
* any concept has saved details, has left the first draft, is scheduled/filmed/edited/approved/published or has an Ad Setup -> **409**: the product stays and the answer names the concept and says where to close it (Kill Concept / Move Back). 
* the ApparelMagic / catalogue product is never touched; past weeks are read-only; Drops-created entries are refused.

## Schema

`shoot_plan_items.auto_linked BOOLEAN NOT NULL DEFAULT false` and `shoot_plan_items.shoot_notes TEXT` (both additive, idempotent; no existing row is rewritten). `PATCH /api/shoot-plan/:id` saves `creator` and/or `shoot_notes` (owner required, notes up to 1000 characters, past weeks read-only).

## Thumbnails: one garment view (v1.3.3)

WNDRR's normal ApparelMagic catalogue picture is ONE image with the front and back views side by side (see `pickFrontBack` in `src/lib/apparelmagic.js`). At 40-64px that showed two squeezed garments; `object-fit: cover` (used for the first tray/tile version) only cropped through the middle of both, and earlier work (v1.2.5/v1.2.6) deliberately showed the whole picture uncropped.

`UX.garmentImgHtml` / `UX.garmentFit` (`public/ux.js`) now decide per picture, and are used by BOTH the Planning tray and the Shoot Plan tiles:

1. a separate picture that ApparelMagic labels as the **front** (with a different one labelled back) is used whole (`front_image_url` on `GET /api/shoot-plan`);
2. otherwise, once the picture has loaded, if it is wide enough to be two views (width/height >= 1.45; >= 1.0 for long bottoms such as jeans/pants, whose pair is only about square) only the **front half (the left half)** is shown, scaled to fit the box and centred, never stretched. The back half is clipped from the picture itself;
3. a picture that is already one view is shown whole, centred;
4. no picture or a broken URL: the neutral placeholder (no broken-image icon).

Limitations: the left half is assumed to be the front (the catalogue convention; the browser journey cannot see real ApparelMagic pictures); a very wide single product photo, or a pair of tall bottoms whose pair is narrower than the threshold, would be shown whole. The Core table row thumbnails are unchanged.

## Centred thumbnails, tray remove, Upcoming Drops (v1.3.4)

- **Centring.** The shared helper (`UX.garmentImgHtml`) still shows ONE complete garment, but now also centres it by the garment's own bounding box (white margin equal on every side, proportions kept, never cropped or stretched). Browsers cannot read the pixels of a picture served from another site, so the measurement goes through `GET /api/product-image?u=` (`src/routes/productImage.js`): same-origin, behind sign-in, and only for pictures the application already holds (an ApparelMagic image URL or a Shoot Plan item's `image_url`); anything else is refused without being fetched. The picture itself is still displayed from its own URL. If it cannot be measured the front half is shown, as before. Results are cached in memory and `sessionStorage`.
- **Where it applies.** Planning tray, Shoot Plan tiles, Upcoming Drops colour cards and Drop-card product tiles. The large preview on an Upcoming Drops product page shows the WHOLE picture (front and back), `object-fit: contain`, via `UX.productImgFullHtml`. Missing or broken pictures show the neutral placeholder.
- **Tray remove.** Each tray thumbnail has a remove control (visible on hover or keyboard focus, always visible on touch devices). It uses the same guarded removal as the Shoot Plan tile (`removeShootPlanItem`): confirmation first, work-in-progress concepts block it and the message says what to do, untouched drafts are archived (history kept). The tray, tiles and Add to Shoot buttons update immediately.
- **Owner.** New Concept has an Assigned To field from the application's team list (default Mark). It is saved as the concept's `concept_assignee` and the manual plan entry's `creator`, shown on the card and in the editor, and changing it in the editor does not reset the concept.
- **Status control.** Shooting (Scheduled / In production / Filmed) and Editing (Filmed / Scheduled / In editing / Awaiting approval) share one single-line stepper. Any stage can be chosen, forwards or backwards, through the existing endpoints; leaving Filmed asks first, and a concept already in Final Approval is directed to Request Changes there. Nothing is deleted.
- No database change.

## Levelling slightly tilted pictures (v1.4.3)

Catalogue pictures are sometimes a degree or two off level. In the small thumbnails (Planning tray, Shoot Plan tiles, Upcoming Drops colour cards and Drop tiles) the shared helper now levels them. While it measures a picture for centring, it also estimates the garment's tilt (`UX.garmentTilt`): a front view is nearly left-right symmetric, so the tilt is the rotation that makes the silhouette most symmetric. That rotation is applied with CSS about the garment's own centre, so nothing is stretched or redrawn.

Guard rails: only small tilts (up to 5 degrees) and only when levelling is clearly better than leaving it (a tilt under 0.6 degrees, a blurry or white-on-white picture, a garment with no clear symmetry, or an answer at the edge of the range all give no rotation). For a front-and-back picture only the front half is measured. The large preview is never rotated. The cached measurement key changed (`gt2:`) so earlier cached boxes are re-measured once.

## Core catalogue: Creative Attention and Creative Freshness (v1.4.1)

The "Browse the full Core catalogue" panel (Core Shoot Planning) no longer uses its own older flag / stale count. Both columns now come from the same results as the Core table above (`plCatalogueMap` in `planning.js`, keyed by product code):

* **Creative Attention** (category row): how many products need creative attention (the Core table's "needs creative" category), how many of those are High priority, and how many need review. Categories are ranked by that count. **Product row**: the Core table's own status pill (for example "No Active Creative"), its priority, the status sentence and "N Active Ads". Only products the Core table lists as needing creative are shown under a category, ordered by priority then score.
* **Creative Freshness** (category row): how many products have a stale (or no) latest creative. **Product row**: the Core table's "Latest creative" date, how long ago, and a band. Bands use the engine's own windows from the Planning settings: Recent (under `recent_creative_days`, default 30), Ageing, Stale (`stale_creative_days`, default 90 or more), and "No creative" when nothing is on record. Creatives without a reliable date show "Unknown" and no band.
* Products the Core table has not assessed show "Not assessed". If the Planning results are not loaded, the panel falls back to the older flags until they arrive, and re-renders when they do.

From v1.4.2 the Core page has one tab bar, **Creative Opportunities | Core Catalogue**, instead of two stacked sections; only the selected view shows. Each tab carries a count (products needing creative | products in the catalogue). The choice is kept for the browser session, and the tabs work with the arrow, Home and End keys.

## Creative coverage dates (v1.3.3)

The "Latest:" date in Core and High Stocks (one shared cell, `plCoreCoverageCell` -> `PlanningExplain.coverage`) is always `D Mon YYYY`, using the year in the creative's own source date (never the current year, never invented). Missing creative dates stay `Unknown` / `None`; an impossible date is treated as unavailable. Display only: counting and recommendations are unchanged.
