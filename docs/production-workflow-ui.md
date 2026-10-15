# Production workflow UI (Batch 34)

The creative production pages (Dashboard, Planning > Shoot Plan, Concept Development, Tuesday Review, Shooting, Editing, Final Approval and the Ad Setup,
New Concept and Concept editor modals) share one set of building blocks. It is a presentation layer only: no data, schema, workflow state, API contract,
calculation, permission, naming rule or Meta integration changed.

## One design system, not two

Everything uses the existing tokens in `public/styles.css` (`--accent*`, `--surface*`, `--border*`, `--text*`, `--green/--amber/--red`, `--r`, `--r-lg`,
`--shadow-xs`). The new classes are prefixed `ux-` and live in the block "Batch 34: shared production-workflow design system" at the end of the file.
Status colours are purple (active), green (done), amber (needs attention), red (blocked/overdue) and neutral grey. There is no blue accent; the old
per-person colours on Shooting/Editing cards were dropped (the name and an initial carry the information).

| Piece | Markup | Notes |
|---|---|---|
| Page header | `.ux-page-header`, `.ux-page-title`, `.ux-page-desc`, `.ux-page-header-actions` | Title, one-line description, actions on the right |
| Week selector | `.ux-week-nav`, `.ux-week-btn`, `.ux-week-label` | Same pill on every weekly page; the existing ids and handlers are unchanged |
| Tabs / filters | `.ux-tabs`, `.ux-tab`, `.ux-tab-count` | Underline tabs with a quiet count |
| Segmented control | `.ux-seg`, `.ux-seg-btn` | Week / Today / History, owner filters |
| Summary tiles | `UX.statTilesHtml([{label, value, tone}])` | One compact row per page; a figure is shown once |
| Badge | `UX.badgeHtml(text, tone)` | Used sparingly: one status per card |
| Card | `.ux-pcard` (title, sub, meta, status, foot) and `.ux-wcard` (calendar cards) | Consistent height in a grid row |
| Card grid | `.ux-grid`, `.ux-grid-wide`, `.ux-group` | Responsive `auto-fill` columns |
| Empty state | `UX.emptyStateHtml(title, hint)` | Every list has a deliberate empty state |
| Modal | `.ux-modal`, `.ux-field`, `.as-card`, `.cd-modal-nav` | Sticky footers, labelled fields, primary / secondary hierarchy |

`public/ux.js` holds the string builders and the pure media classifier. It has no DOM access at load time and is unit-tested (`test/uxWorkflow.test.js`).

## Dashboard

`GET /api/dashboard` keeps `week`, `current`, `pipeline` and `health` exactly as before and adds a `workflow` block
(`src/lib/dashboardWorkflow.js`, read-only SELECTs). The page shows:

1. Weekly progress: current week, weekly creative target and new concepts planned (the real Core weekly target and count, not the sample figures),
   creatives in production (Shooting + Editing + Final Approval queues), creatives shipped, and a progress bar for concepts planned against the target.
2. Production pipeline: Concept Development, Tuesday Review, Shooting, Editing, Final Approval, Shipped. Concept Development and Tuesday Review are for the
   selected week; Shooting (not yet shot, selected week), Editing and Final Approval are live queues. Each stage links to its page.
3. Needs attention: only alerts that apply (concepts waiting for review, shoots past their scheduled day, shot concepts waiting more than 2 days for editing,
   creatives awaiting final approval with how many have waited over 24h).
4. Quick access: three compact links.

## Final Approval and Ad Setup thumbnails: where they come from

WNDRR stores no media file for a creative. A Final Edit (`final_edits`) holds the link the editor pasted back (`final_edit_link`) and its declared format.
The thumbnail is derived from that link only (`UX.classifyMedia`):

* YouTube link: YouTube's own still of that video, with a small play icon.
* Direct video file (`.mp4`, `.mov`, `.m4v`, `.webm`, `.ogv`): the browser's first frame of the file itself (`preload="metadata"`, `#t=0.1`, muted, never autoplays), with a play icon.
* Direct image file: the image itself, no play icon.
* Anything else (Drive, Frame.io, Dropbox, Vimeo, unknown hosts) or no link: a neutral placeholder that names the format and platform ("Video · Google Drive", "Static · no link yet").
* A preview that fails to load falls back to the same placeholder, never a broken image.

A product catalogue image is never used. A concept with several versions (hooks) shows one thumbnail per version: the Ready for Approval queue now returns every
active Final Edit (`final_edits` array, additive), and each Ad Setup row already corresponds to one Final Edit.

## What was deliberately not changed

Concept counting, weekly target, carryover and selections (Shoot Plan); approval, change-request and kill logic (Tuesday Review); scheduling and status
transitions (Shooting, Editing); approval, request-changes and Move Back (Final Approval); Meta ad name generation, validation, drafts and product relationships
(Ad Setup); every recommendation, stock, demand and Meta Performance calculation. Element ids and handler names that earlier journeys depend on were kept.
