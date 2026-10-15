# UX, workflow and Final Approval refinement (v1.3.0)

Refinement of the existing app. No Meta naming algorithm, matching algorithm, counting rule or recommendation calculation changed.

## Kill Concept (one action everywhere)
* The three-dot menu on Concept Development, Shooting, Editing, Final Approval and Ad Setup cards offers **Kill Concept** (and **Restore** for a record that was archived earlier). There are no separate Remove / Delete / Archive actions in the UI. The `archive`, `unarchive` and `remove_test` endpoints still exist (see `docs/copy-assistant-and-lifecycle.md`) but are not offered.
* A killed concept leaves every active queue and count wherever it is (no Move Back first). Its row, history, final edits, ad setups and shoot schedule stay. Nothing is deleted.
* Blocked only when the concept was **published** or its Ad Setup is **matched to a real Meta ad**: Meta relationships are never touched.
* An approved Ad Setup that was never published can be killed; it leaves the Approved list and the record is kept.
* To clear unwanted test concepts: open each card's menu and choose Kill Concept. Nothing is removed automatically on deploy.

## Move Back
Admin only (as before: `/api/move-back` is `requireAdmin`). Shooting and Editing cards now have **Move back** in their menu (Shooting to Tuesday Review, Editing to Shooting), in addition to the buttons inside each modal. The confirmation names the real target stage.

## Previews
`UX.creativeThumbHtml`: the actual creative (uploaded image, video still, YouTube thumbnail) first; if there is none, or it cannot load (for example a private Drive file), the linked product image with a **Product image** tag so it is never mistaken for the finished video; otherwise a neutral placeholder. Used on Final Approval, Ad Setup, Shooting and Editing cards. Drive and Frame.io links are not previewed beyond what a public link allows (no new integration).

## Shooting / Editing status
A stepper: only the current stage is filled (purple); finished stages are ticked and muted; upcoming stages are plain text. Labels: Scheduled, In production, Filmed on Shooting; Filmed, Scheduled, In editing, Awaiting approval on Editing. Status logic is unchanged.

## Ad Setup
* **Category**: Product or Sale. Stored values are unchanged (`promotion` = Sale; `core`, `new_drop`, `organic_first` all display as Product). A record's stored value only changes if a person switches it.
* **Batch**: a text field. "215", "#215" or "Batch 215" finds or creates the numbered batch (the Meta name and Sale sequence counter work as before). Empty clears it; no number is rejected.
* **Creative naming auto-fill**: at creation, and once for older drafts the first time they are opened (`naming_prefilled_at`), only **empty** fields are filled: product name and category (structured category when specific, otherwise the garment split: ASSET RAGLAN BOX FIT TEE becomes ASSET RAGLAN and BOX FIT TEE), hook (from the approved concept, blank if none), media, ad type (Single), creator (the filming person), concept. A field a person later clears is not refilled; saved values are never overwritten.
* **URL link page**: product-specific ad = Product; Sale Hype = Sign Up page; Sale Live, Mid Sale and Last Chance = left unselected (the Destination check stays incomplete until chosen); no product and not a sale (or several products) = New Arrivals.
* The large **Generated Meta name** panel is gone; the name is still generated and can be copied from Ad details ("Copy Meta ad name"). The approved view still shows it.
* Headline / Description / CTA rules, verified offers and approvals are unchanged (`docs/copy-assistant-and-lifecycle.md`). Mid Sale uses the Sale Live rule.

## AI Copy Assistant and the copy library
* The server reads `ANTHROPIC_API_KEY` at request time. Surrounding quotes and spaces are ignored. When it is missing, the message says whether the variable is absent, empty, or whether similarly named variables exist (names only, never values), and reminds you to set it on the Railway service that runs the app and let it redeploy.
* **Import path** when Google Sheets is not connected: Settings > Copy Library > Import from CSV files. Download each tab from the sheet (File > Download > .csv), pick the files, confirm which tab each is, import. The same parser, tone statistics and fact guard are used; the library is replaced by exactly the files chosen; a failed import keeps the previous library. Admin only; the spreadsheet is never touched.

## Meta auto sync
No scheduler or cadence change. `GET /api/meta-sync/auto-status` (admin, read-only) and a line under "Automatic sync" in Settings > Meta Sync show: the raw `META_AUTO_SYNC` value (unset defaults to on), whether Meta credentials are present (presence only), whether the scheduler started in the running process, the last tick, the recent automatic runs and why the next check will or will not sync. If the deployed process shows `off`, change the Railway variable; the app never changes it.

## Upcoming Drops
* Product groups are centred on drop cards and on the product page; Required Concepts use the full width; "+ Add New Concept" is centred; Filmed / Edited / Uploaded to Meta checkboxes are larger with a bigger click target. Progress calculations are unchanged.
* **Default assignments** (Settings > Shoot Prep > Upcoming Drops: default assignments): choose the default Assigned To and Editing person from the existing roster. They apply only to **new** Required Concepts created after that, never over a manual choice or to existing concepts, and only on Upcoming Drops. Choosing the filming person is what queues a Drop concept for Shooting (existing behaviour), so a configured default behaves exactly like picking that person by hand. Unconfigured = nothing changes.

## Settings
Shoot Prep, Meta Mapping, Creative Classification, Planning and Creative Playbook share the Meta Performance Settings pattern: page header, compact cards, consistent save controls. Existing controls and ids are kept.

## Review creative (Meta Ad Matching)
Two-column layout; compact "Previously matched ad found" notice with a "View matched ad" toggle (the previous ad's name is hidden by default); required classification (Product(s), Concept, Media Type) with evidence labels that come from the actual match (Previously confirmed, Exact match, Parsed from ad name, Manually selected; a suggestion is never labelled confirmed); Additional details (Creator, Creative Style, WNDRR Ad Setup) collapsed unless populated; amber "Check naming" popover; progress bar and counts on top; footer Close Review / Previous / Skip & Next / Confirm & Next. Matching algorithms, confirmations, skip behaviour and keyboard shortcuts (Enter, Alt+Left) are unchanged; nothing is auto-confirmed.

## Database (additive, idempotent)
`ad_setups.url_link_page` becomes nullable and accepts `sign_up`; `ad_setups.naming_prefilled_at`; `planning_settings.drop_default_assignee`, `drop_default_editor`; `copy_reference_syncs.source`.
