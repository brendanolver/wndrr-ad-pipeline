# WNDRR Meta Ads Creative Pipeline

Tracks a style's ad creative from "needs an ad" through concept/script,
filming, editing, QC, and into Meta Ads Manager as a paused draft. This
tool does not decide what should get shot — that decision (sales, stock,
promotions) is made outside the app. It starts once a style has been
entered as needing an ad.

This repo is built **phase by phase**, per the build brief. Only **Phase
1: Creative pipeline tracker** is implemented so far.

## What's in Phase 1

- **Styles** — style/SKU code (same scheme as ApparelMagic), name, tier
  (Core/Proven or New Drop/Unproven), optional category.
- **Categories** — manually maintained mapping table (style → category →
  target Meta campaign/ad set ID). The IDs are captured now so the table
  can be populated progressively, but nothing reads them until Phase 4.
- **Creative Assets** — one record per ad concept per style, moving
  through: Not Started → Awaiting Proven Concept → Concept/Script →
  Filming → Editing → QC → Uploaded/Live. Each asset tracks a
  strategy/filming/editing/QC owner (the four handoffs) so it's visible
  who's holding up what, and a per-stage "days in stage" counter.
- **Missing-ad flag** — a style is flagged when it has zero creative
  assets in Uploaded/Live status *and* isn't currently parked in Awaiting
  Proven Concept (a deliberate hold isn't the same problem as a style
  nobody's touched).
- **Enforced rule** — a New Drop style's creative asset can only move
  into Filming if its concept classification is Tested/Proven, unless
  it's explicitly marked as a deliberate new-concept trial. This is
  enforced server-side on the status-transition endpoint, not just shown
  in the UI.

### Not in Phase 1 (by design)

- Phase 2 (stock-gated shoot list / ApparelMagic integration)
- Phase 3 (Weekly Plan + on-target tracker)
- Phase 4 (Meta Marketing API auto-upload)
- Tech pack / sampling / PO tracking, spend/stock/sales analytics, or
  auto-generated ad creative — all explicitly out of scope for this tool.

## Stack

Node.js + Express + PostgreSQL, deployed on Railway — matching the
pattern already used for the demand-planning app rather than introducing
a new backend for another internal tool. No frontend build step: the
Kanban board is a single static page (vanilla HTML/CSS/JS) served by
Express, in the same spirit as WNDRR's other internal tools.

Auth is a single shared password (internal tool, no per-user accounts),
gating a signed session cookie — same UX pattern as the demand-planning
app's password screen, but enforced server-side here since this app has
a real backend.

## Local development

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, APP_PASSWORD, SESSION_SECRET
npm start
```

The server runs `db/schema.sql` on boot (idempotent `CREATE TABLE IF NOT
EXISTS`), so there's no separate migration step. Set
`SEED_EXAMPLE_DATA=true` once locally to also load `db/seed.sql`'s
placeholder categories/styles.

Requires a Postgres instance — either a local one
(`postgres://user:pass@localhost:5432/wndrr_ad_pipeline`) or Railway's.

## Deploying to Railway

1. Create a new Railway project from this repo, add a Postgres plugin
   (Railway sets `DATABASE_URL` automatically).
2. Set `APP_PASSWORD` and `SESSION_SECRET` in the service's variables.
3. Deploy — `railway.json` points Nixpacks at `npm start`.

## Before Phase 2 starts

- Sort ApparelMagic API credentials, reusing the scan-to-verify
  integration pattern where possible.
- Populate the real style/category list (the Categories admin screen in
  this app) so the mapping table has something to route to once Phase 4
  begins.

## API

All routes under `/api/*` (except `/api/auth/*`) require the session
cookie from `/api/auth/login`.

| Method | Path | Purpose |
|---|---|---|
| `GET/POST` | `/api/styles` | List / create styles (list includes computed `missing_ad`) |
| `PUT/DELETE` | `/api/styles/:id` | Update / delete a style |
| `GET/POST` | `/api/categories` | List / create categories |
| `PUT/DELETE` | `/api/categories/:id` | Update / delete a category |
| `GET/POST` | `/api/creative-assets` | List (filter by `style_id`/`status`) / create |
| `PUT/DELETE` | `/api/creative-assets/:id` | Update / delete |
| `PATCH` | `/api/creative-assets/:id/status` | Status transition — enforces the New Drop → Filming rule, logs to `status_history` |
| `GET` | `/api/creative-assets/:id/history` | Status transition log for one asset |
| `GET` | `/api/board` | Kanban board: columns of cards grouped by status, plus `missing_ad_styles` |
