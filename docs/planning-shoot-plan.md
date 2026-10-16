# Planning: selection tray, Shoot Plan and Confirm & Send (v1.3.1)

Engine calculations, recommendation algorithms, product eligibility, stock and the Shooting / Editing / Final Approval workflows are unchanged. This is the product-selection and hand-off workflow only.

## The flow

Planning (Core / High Stocks / Creative Insights) -> **Add to Shoot** -> the **selection tray** -> **Shoot Plan** (compact tiles) -> **Confirm & Send Shoot Plan** -> concepts are completed in Concept Development -> only concepts submitted with Ready for Review reach Tuesday Review.

## What a "selection" is

A selection is a `shoot_plan_items` row for the planning week (plus the Concept Development concept(s) started with it). There is no second selection store, so it persists in the database, is scoped to its week, and survives tab changes and reloads. The existing rule still applies: a product can only be selected once per week (a repeat merges into the existing record; nothing is duplicated, client or server).

* **Add to Shoot** (Core, High Stocks, Creative Insights) is one click. It uses the same `POST /api/shoot-plan` as the "Shoot This Week" form, with: the colourways that can be shot now (or the ones ticked in the expanded row), Settings default sizes, the default content creator, one concept. "More options..." / "Add another concept..." in the expanded row opens the full form (colourways, sizes, concept type, number of concepts). If no colourway can be shot right now the full form opens instead (it asks before overriding a stock restriction).
* Entries that **Upcoming Drops** assignments create so Shooting can pick a Required Concept up are *not* Planning selections: they carry `shoot_plan_items.auto_linked` (new rows) or are recognised by the same rule (a Drop entry whose concept fulfils a Required Concept slot; older rows). They never appear in the tray or on the Shoot Plan page and are not removable there. Shooting, Editing and Concept Development are unchanged.
* Entries made on purpose elsewhere (Promotion concepts, manually started concepts) are still shown, with a small source label.

## The tray

Directly under the Planning tabs, sticky while scrolling, on Core / High Stocks / Creative Insights, hidden when the week has no selections and on the Shoot Plan page. Shows the count, up to five thumbnails then "+X", a purple "View Shoot Plan" button and a collapse control (remembered in the browser). Past weeks are read-only.

## Shoot Plan page

Title, one-line description, the existing week selector and, top right, **Confirm & Send Shoot Plan**. One tile per product: thumbnail, name, colourways, concepts (first two names, "+N more" / "Manage concepts" opens the existing concept list with stage and "Adapt"), owner, source label, Open concept, + Concept, Remove from plan. A stock warning appears only when the existing assessment has one. The Apparel Magic CSV link remains a quiet utility under the tiles when samples are required. Empty state: "No products added to this week's shoot plan yet." with a link back to Core.

## Confirm & Send

`GET /api/weekly-shoot-plan-confirmation/preview?week_start=` (read-only) lists the products and concepts and anything worth knowing (no concept yet, no colourways, missing sample sizes). The dialog shows it and says plainly that nothing is submitted for Tuesday Review. `POST /api/weekly-shoot-plan-confirmation` stays idempotent (first confirmation is kept; the concepts already exist and are reused, so nothing is duplicated) and now refuses an empty plan. It never touches `concept_dev_status`. After sending, anything added later reaches Concept Development without a second confirmation.

## Removing a product

`GET /api/shoot-plan/:id/removal` (read-only) and `DELETE /api/shoot-plan/:id`:

* every concept is still an untouched draft -> the plan entry is removed and the drafts are **archived** (history and lifecycle log kept, restorable). Concepts are never deleted.
* any concept has saved details, has left the first draft, is scheduled/filmed/edited/approved/published or has an Ad Setup -> **409**: the product stays and the answer names the concept and says where to close it (Kill Concept / Move Back). 
* the ApparelMagic / catalogue product is never touched; past weeks are read-only; Drops-created entries are refused.

## Schema

`shoot_plan_items.auto_linked BOOLEAN NOT NULL DEFAULT false` (additive, idempotent; no existing row is rewritten).

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

## Core catalogue: Creative Attention and Creative Freshness (v1.4.1)

The "Browse the full Core catalogue" panel (Core Shoot Planning) no longer uses its own older flag / stale count. Both columns now come from the same results as the Core table above (`plCatalogueMap` in `planning.js`, keyed by product code):

* **Creative Attention** (category row): how many products need creative attention (the Core table's "needs creative" category), how many of those are High priority, and how many need review. Categories are ranked by that count. **Product row**: the Core table's own status pill (for example "No Active Creative"), its priority, the status sentence and "N Active Ads". Only products the Core table lists as needing creative are shown under a category, ordered by priority then score.
* **Creative Freshness** (category row): how many products have a stale (or no) latest creative. **Product row**: the Core table's "Latest creative" date, how long ago, and a band. Bands use the engine's own windows from the Planning settings: Recent (under `recent_creative_days`, default 30), Ageing, Stale (`stale_creative_days`, default 90 or more), and "No creative" when nothing is on record. Creatives without a reliable date show "Unknown" and no band.
* Products the Core table has not assessed show "Not assessed". If the Planning results are not loaded, the panel falls back to the older flags until they arrive, and re-renders when they do.

From v1.4.2 the Core page has one tab bar, **Creative Opportunities | Core Catalogue**, instead of two stacked sections; only the selected view shows. Each tab carries a count (products needing creative | products in the catalogue). The choice is kept for the browser session, and the tabs work with the arrow, Home and End keys.

## Creative coverage dates (v1.3.3)

The "Latest:" date in Core and High Stocks (one shared cell, `plCoreCoverageCell` -> `PlanningExplain.coverage`) is always `D Mon YYYY`, using the year in the creative's own source date (never the current year, never invented). Missing creative dates stay `Unknown` / `None`; an impossible date is treated as unavailable. Display only: counting and recommendations are unchanged.
