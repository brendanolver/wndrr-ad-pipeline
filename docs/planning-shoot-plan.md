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

## Creative coverage dates (v1.3.3)

The "Latest:" date in Core and High Stocks (one shared cell, `plCoreCoverageCell` -> `PlanningExplain.coverage`) is always `D Mon YYYY`, using the year in the creative's own source date (never the current year, never invented). Missing creative dates stay `Unknown` / `None`; an impossible date is treated as unavailable. Display only: counting and recommendations are unchanged.
