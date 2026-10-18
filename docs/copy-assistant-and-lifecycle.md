# Concept lifecycle, Meta copy rules and the WNDRR AI Copy Assistant (v1.2.9)

## 1. Tuesday Review eligibility

A concept enters Tuesday Review only when someone explicitly submits it with **Ready for Review** in Concept Development (or it already carries a review decision).

* Eligible: `ready_for_review`, `changes_required`, `approved`. A `killed` concept only stays visible if it was actually submitted or reviewed (`submitted_for_review_at` / `reviewed_at`).
* Never eligible: `not_started`, `in_development` (drafts stay in Concept Development), or a draft that was killed before it was ever submitted.
* The rule lives in `src/lib/tuesdayReview.js` and is applied **on the server**: `GET /api/concept-development?scope=review` returns only eligible concepts. Review counts, filters and the dashboard use the same data, so the numbers are genuine. Changes-required still follows the existing revision workflow (back to the creator, resubmit); approved and killed concepts keep their history.

## 2. Archive / Kill / Remove Test Concept

> From v1.3.0 the UI offers **Kill Concept** only (see `docs/ux-workflow-refinement-v1.3.0.md`). Archive, Restore and Remove Test Concept remain as API actions with the rules below, except that an approved (unpublished) Ad Setup no longer blocks Kill (it still blocks permanent removal).

One consistent three-dot menu on Concept Development, Shooting, Editing, Final Approval and Ad Setup cards. The same two endpoints serve every screen, because the rules depend on the concept's real state, not on where the button was clicked:

* `GET /api/concept-lifecycle/:id` returns what is allowed and the consequences.
* `POST /api/concept-lifecycle/:id/:action` (`archive`, `unarchive`, `kill`, `remove_test`) needs `{ "confirm": true, "reason": "..." }`.

| Action | Effect | Who |
| --- | --- | --- |
| Archive Concept | Leaves every active queue and count. Row and all history stay. Restorable. | any user |
| Kill Concept | Marks a legitimate concept as not proceeding (`concept_dev_status = 'killed'`), reason kept. | any user |
| Remove Test Concept | Permanently deletes a disposable concept and its drafts (shoot schedule, final edit rows, Ad Setup drafts, status history). A JSON snapshot is written to `concept_lifecycle_log` first. | admin only |

Rules enforced server-side:

* A concept that has been **published** (`uploaded_live`), whose **Ad Setup is approved**, or whose Ad Setup is **matched to a real Meta ad** can only be archived. Meta ads are never touched.
* Nothing external is deleted: a Final Edit's link is only a row. No Drive / Frame.io / Meta file or record is touched.
* Every action is idempotent (repeating it reports "already done") and audited in `concept_lifecycle_log`.
* The active-queue filter is one shared definition (`ACTIVE_CONCEPT_SQL`): `archived_at IS NULL AND concept_dev_status <> 'killed'`, applied to Shooting, Editing, Final Approval, Ad Setup, the board, Shoot Plan progress, the weekly video plan, promotion coverage and dashboard counts.

### Removing a promotion workspace vs removing a concept

The error "has progressed to Tuesday Review ... Move Back first" came from the workspace delete route reusing the Move Back rules. `DELETE /api/concept-development/workspace/:id` now: deletes an **empty** promotion workspace outright; otherwise removes the workspace only if every concept in it may be removed (Remove Test Concept rules); and otherwise explains that the concepts should be archived or killed. Removing an empty workspace never touches a concept, and it is logged (`remove_workspace`).

### Cleaning up Final Approval / Ad Setup drafts

Unwanted drafts such as "ASSET RAGLAN BOX FIT TEE - Asset Raglan Tee - 3 Ways to Style" or "Black Friday 2026 - test blk fri" can be archived (or, for an admin, removed as test concepts) from the card's three-dot menu. **Nothing is deleted automatically on deploy.** Archived Ad Setups stay in the database and can be restored.

## 3. Ad Setup thumbnails

Ad Setup and Final Approval show the actual creative from the Final Edit link (static image, a video still, a YouTube thumbnail). A product image is never used.

* YouTube and direct image / video files preview directly.
* **Google Drive** links show a thumbnail through `https://drive.google.com/thumbnail?id=...`. This works **only when the file is shared by link**. If the file is private the thumbnail fails and a clean placeholder naming Google Drive is shown. Making private Drive files preview would need an authenticated Drive integration, which is not part of this release.
* **Frame.io** review links need a Frame.io login, so they cannot be previewed from the browser; the placeholder names Frame.io and the link still opens the file.

## 4. Automatic Meta copy rules (deterministic, no AI)

`src/lib/adCopyRules.js`. The same inputs always give the same output.

| Ad | Headline | Description | CTA |
| --- | --- | --- | --- |
| Standard product / New Drop / Restock | PRODUCT NAME (exact catalogue name, uppercase) | Elevate your everyday | Shop Now |
| Sale Hype / Teaser | SIGN UP TO BE NOTIFIED | the verified offer (adds " sale" unless it already ends with it, or a teaser wording was set) | Sign Up |
| Sale Live and Mid Sale | the verified offer, uppercase | Limited time only! | Shop Now |
| Last Chance | LAST CHANCE + verified offer, uppercase | Don't miss out! | Shop Now |

* The category and stage come from the ad's category and promotion stage; the product name comes from the linked catalogue style(s).
* Offers come only from the promotion's **Verified offer** field (Promotions > edit). `notes` is never used. A missing or placeholder offer (blank, TBC, N/A ...) is never guessed: the fixed parts still apply and a flag asks for the offer.
* Several products on one ad, or none, leave the headline blank with a flag.
* Fields stay editable. Editing the headline, description or CTA marks the ad `copy_fields_manual`, and the rules never overwrite manual copy; "Apply WNDRR rules" asks for confirmation. A chosen reusable **Copy Set** also takes precedence. Untouched drafts follow a corrected offer automatically.

## 5. WNDRR AI Copy Assistant (Primary Text only)

Configuration (environment variables only; nothing is stored in the repository and nothing reaches the browser):

| Variable | Purpose |
| --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | The service-account key JSON (raw, or base64-encoded). |
| `WNDRR_COPY_SHEET_ID` | The spreadsheet id (defaults to the WNDRR copy library sheet). |
| `ANTHROPIC_API_KEY` | Enables Generate Copy and refinement. |
| `COPY_AI_MODEL` | Optional model override (default `claude-sonnet-5-5`). |

Setup: create a Google service account with the Sheets API enabled, **share the spreadsheet with its `client_email` (Viewer)**, set the variables above, then Settings > Copy Library > **Refresh library**. The client asks for the read-only scope (`spreadsheets.readonly`) and only ever issues GET requests: the spreadsheet is never modified. Writing back to the sheet is not implemented.

* Expected tabs: CORE, CORE 26, SALES, 2026 SALES, BUNDLES, BUNDLES 26, USA - BUNDLES 26, 2024 RANGES, 2025 RANGES, 2026 RANGES, PINTEREST. Settings shows a per-tab report (found, examples read, warnings). Tab and column detection is heuristic, so the report is the place to check the parse.
* The library is cached in the database with the time of the last successful update. A failed refresh (permission, outage, empty sheet) keeps the previous library and shows the failure.
* Tone guidance is **computed from the examples actually read** (length, openings, calls to action, punctuation and emoji use, recurring phrases). No finding is assumed.
* Generate Copy gives three distinct Primary Text options (product-led, feature-led, styling-led; sales ads use sales examples and sales angles). Refinement chips ("shorter", "more WNDRR", ...) and "Another three" use the same guard.
* Facts guard: options that state a discount, price, specification, GSM or fabric, stock level, shipping offer, deadline or date that is not in the ad's facts are rejected (one automatic retry, then dropped or an error).
* Approval: suggestions are drafts. "Use" copies one into the editable box; the ad cannot be approved until **Approve Primary Text** is clicked, and editing approved text withdraws the approval. Drafts can be saved without approval.

## 6. Database changes (additive, idempotent, in `db/schema.sql`)

`creative_assets` archive columns; `concept_lifecycle_log`; `ad_setups` copy columns (`selected_description`, `copy_fields_manual`, `copy_rule_key`, `copy_rule_flags`, `primary_text_approved*`, `primary_text_source`, `ai_draft_options`); `promotions.verified_offer*`; `ad_copy_generations`; `copy_reference_syncs`, `copy_reference_examples`, `copy_tone_guidelines`. Existing rows are never rewritten.

## AI Copy Assistant v2: Copy Type, reference selection and product claims (v1.4.5)

**Copy Type** (`src/lib/copyTypes.js`) says what kind of ad the Primary Text is for: Core / Evergreen, New Range / Drop, New Colourways, Bundle, USA Bundle, Sale / Promotion, or the
General product copy fallback. It is worked out from what the pipeline already holds, in this order: a Promotion stage (Sale); a bundle in the creative brief ("bundle", "3 for $150", "mix & match",
and, with a USA mention, USA Bundle: several linked products alone never make a bundle); new colours in the brief or planning reason, or the catalogue showing the same product launched earlier in
other colours (New Colourways); a drop planned from Upcoming Drops / Protect Momentum, or a new-drop product whose drop launched in the last 120 days or launches within 60 (New Range); Core planning
or a core/proven catalogue tier (Core); otherwise General. Nothing is guessed: no evidence, no type, and "new", "new colours" or "bestseller" are never assumed. The result and its reasons are shown in
the AI panel. A person can override it (**Copy type** menu); the choice is saved on the Ad Setup (`ad_setups.copy_type_override`), wins over automatic detection in every later generation and every
later session, and **Reset to automatic** clears it. An approved Ad Setup is never changed (the endpoint answers 409).

**Reference selection** (`copyLibrary.selectExamples`). Each type has its own tabs (`copyTypes.TAB_PLAN`): Core: CORE 26 + CORE; New Range: the RANGES tabs; New Colourways: CORE + RANGES (colour
wording preferred); Bundle: BUNDLES + BUNDLES 26; USA Bundle: USA - BUNDLES 26; Sale: SALES + 2026 SALES; General: CORE + RANGES. The secondary tabs only fill places the primary tabs cannot. Within the tabs,
references are scored on whole-word product matches (decorative lettering such as 𝐇𝐢𝐣𝐚𝐜𝐤 is normalised with NFKC; "boxy" is not "box", "fits" is "fit"), garment type and kind, the best are chosen with a
penalty for near-identical texts, one example per product, and at most half the set from one tab. Recruitment ads, customer testimonials and non-Meta-ad rows (Pinterest) are kept in the library but
never used (`excluded`, `exclude_reason`).

**Importer.** The sheet's columns are `Range | What | Copy`: "What" is the product / subject (stored in `copy_reference_examples.subject`, with `kind`), Range is the label; Range cells (and the sales
tabs' stage) that are merged over several rows are carried down; a `[merged]` marker is never content. Ranges rows whose What is just "Product" take the product name from the copy ("... | The Junkyard Box
Fit Tee"). Rows imported by an earlier version are enriched when read, so no re-import is needed. A refresh is validated before it replaces anything: no examples, fewer than 5 usable examples, or
a library under 60% of the current size (unless accepted explicitly) is rejected and the current library stays active. **Settings > Copy Library > Check before refreshing** (and `POST /api/copy-library/refresh`
with `{ "dry_run": true }`) reads and validates the sheet and reports per-tab counts without writing anything. The sheet itself is only ever read.

**Product claims** (`src/lib/copyClaims.js`). References teach tone, structure and formatting; they are never facts. The model sees a reference with another product's details removed (names, bullet lists,
counts, materials, features, colours, prices, offers, popularity: `[PRODUCT]`, `[DETAIL]`, `[COUNT]` ...). The prompt separates VERIFIED FACTS (product name / category, promotion and verified offer, drop,
creative format) from CREATIVE DIRECTION (concept, hook, idea, audience: mood only). Every generated option is checked against the verified facts plus what the person typed in the request: counts of fits,
colours or ways to wear it ("One tee, three completely different fits"), features, fabric and quality, popularity and "best", launch wording (only for New Range / New Colourways), availability, colours,
offers, prices, stock, shipping and deadlines are rejected unless supported. Options that copy eight or more consecutive words of a reference, or open the same way as another option, are dropped. The model
is asked for extra candidates (5 for three options) so three clean, different options usually survive. A "feature-led" angle is offered only when verified features exist (none are held today).
