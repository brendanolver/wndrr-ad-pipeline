-- WNDRR Meta Ads Creative Pipeline — Phase 1 schema
-- Style/SKU IDs follow the same scheme as ApparelMagic so this shares data
-- with future tools (e.g. the style-status-tracker) without a migration.

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) UNIQUE NOT NULL,
  meta_campaign_id VARCHAR(128),
  meta_ad_set_id VARCHAR(128),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS styles (
  id SERIAL PRIMARY KEY,
  style_code VARCHAR(64) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  tier VARCHAR(20) NOT NULL CHECK (tier IN ('core_proven', 'new_drop')),
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per ad concept per style.
CREATE TABLE IF NOT EXISTS creative_assets (
  id SERIAL PRIMARY KEY,
  style_id INTEGER NOT NULL REFERENCES styles(id) ON DELETE CASCADE,
  concept_name VARCHAR(255) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'not_started' CHECK (status IN (
    'not_started', 'awaiting_proven_concept', 'concept_script',
    'filming', 'editing', 'qc', 'uploaded_live'
  )),
  concept_classification VARCHAR(20) NOT NULL DEFAULT 'new_experimental'
    CHECK (concept_classification IN ('tested_proven', 'new_experimental')),
  format VARCHAR(10) NOT NULL CHECK (format IN ('video', 'static')),
  -- Deliberate trial: lets a New Drop style bypass the tested-concept gate
  -- into Filming when the team has explicitly chosen to test a new concept.
  is_deliberate_trial BOOLEAN NOT NULL DEFAULT false,
  target_date DATE,
  -- One owner per handoff, so it's visible who's holding up what.
  strategy_owner VARCHAR(255),
  filming_owner VARCHAR(255),
  editing_owner VARCHAR(255),
  qc_owner VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_creative_assets_style_id ON creative_assets(style_id);
CREATE INDEX IF NOT EXISTS idx_creative_assets_status ON creative_assets(status);

-- Status transition log, so the board can show how long an asset has sat
-- in its current stage (a proxy for "who/what is holding it up").
CREATE TABLE IF NOT EXISTS status_history (
  id SERIAL PRIMARY KEY,
  creative_asset_id INTEGER NOT NULL REFERENCES creative_assets(id) ON DELETE CASCADE,
  from_status VARCHAR(30),
  to_status VARCHAR(30) NOT NULL,
  changed_by VARCHAR(255),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_status_history_asset_id ON status_history(creative_asset_id);

-- ---------------------------------------------------------------------------
-- Planning stage (PLANNING -> Briefing -> Production -> Editing -> Approval ->
-- Meta Queue -> Live -> Performance). Additive only -- nothing above this
-- line is touched. ApparelMagic has no "drop" concept of its own, so Drops
-- are manually maintained here, same as Categories.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS drops (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) UNIQUE NOT NULL,
  launch_date DATE NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_drops_launch_date ON drops(launch_date);

-- Drops can now be auto-created from an ApparelMagic launch-date cluster
-- before anyone has named them (see POST /drops/from-suggestion) -- a NULL
-- name displays as "Untitled" until the team edits it. UNIQUE still holds
-- for any drop that IS named (Postgres allows unlimited NULLs under a
-- UNIQUE constraint), so this is a plain nullability change, not a drop of
-- the uniqueness guarantee.
ALTER TABLE drops ALTER COLUMN name DROP NOT NULL;

ALTER TABLE styles ADD COLUMN IF NOT EXISTS drop_id INTEGER REFERENCES drops(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_styles_drop_id ON styles(drop_id);

-- Configurable Stock-on-Hand -> required-creatives thresholds (section 4 of
-- the Planning brief). soh_max NULL = open-ended (the top bracket).
CREATE TABLE IF NOT EXISTS creative_target_rules (
  id SERIAL PRIMARY KEY,
  soh_min INTEGER NOT NULL UNIQUE,
  soh_max INTEGER,
  required_creatives INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO creative_target_rules (soh_min, soh_max, required_creatives) VALUES
  (1, 100, 4),
  (101, 200, 6),
  (201, 400, 8),
  (401, NULL, 10)
ON CONFLICT (soh_min) DO NOTHING;

-- RETIRED: the Creative Jobs feature (modal, +New Creative Job button, the
-- persistent grid on the Planning page) has been removed from the app in
-- favour of the This Week's Shoot Plan summary (state.shootPlan), which
-- covers the same "what are we planning to shoot/produce" need with a
-- simpler, always-visible view. These tables are kept as-is (this codebase
-- never drops tables/columns) so any historical rows already in them are
-- preserved, but nothing in the app reads from or writes to them anymore.
--
-- A Creative Job is the Planning-stage unit of work: operational prep for a
-- concept, before it's briefed. It is NOT a Creative Asset (Phase 1's Kanban
-- entity) -- a Job only becomes tracked production work once it's briefed,
-- which is intentionally out of scope until Briefing is built. Coverage
-- counts therefore never include Jobs, only Creative Assets.
CREATE TABLE IF NOT EXISTS creative_jobs (
  id SERIAL PRIMARY KEY,
  drop_id INTEGER REFERENCES drops(id) ON DELETE SET NULL,

  high_level_concept VARCHAR(255) NOT NULL,
  concept_type VARCHAR(30) NOT NULL DEFAULT 'other' CHECK (concept_type IN (
    'proven_concept', 'new_concept', 'winning_concept_iteration', 'product_content',
    'ugc_creator', 'static', 'existing_content_variation', 'other'
  )),
  expected_deliverables VARCHAR(255),
  expected_ad_variations INTEGER,
  owner VARCHAR(255),
  production_date DATE,
  production_session VARCHAR(255),
  ship_by_date DATE,

  planning_status VARCHAR(20) NOT NULL DEFAULT 'not_started' CHECK (planning_status IN (
    'not_started', 'organising', 'blocked', 'ready_for_briefing'
  )),

  stock_status VARCHAR(20) NOT NULL DEFAULT 'not_required' CHECK (stock_status IN (
    'not_required', 'available', 'needs_organising', 'in_transit', 'blocked'
  )),
  stock_notes TEXT,

  talent_status VARCHAR(20) NOT NULL DEFAULT 'not_required' CHECK (talent_status IN (
    'not_required', 'internal_team', 'model_required', 'creator_required', 'confirmed', 'not_confirmed'
  )),
  talent_assignee VARCHAR(255),
  talent_notes TEXT,

  location_status VARCHAR(20) NOT NULL DEFAULT 'not_required' CHECK (location_status IN (
    'not_required', 'office', 'warehouse', 'studio', 'external_location', 'needs_organising', 'confirmed'
  )),
  location_notes TEXT,

  props_status VARCHAR(20) NOT NULL DEFAULT 'not_required' CHECK (props_status IN (
    'not_required', 'required', 'organised', 'not_organised'
  )),
  props_notes TEXT,

  equipment_needed TEXT[] NOT NULL DEFAULT '{}',
  logistics_notes TEXT,

  blocker_reason VARCHAR(255),
  blocker_owner VARCHAR(255),
  blocker_expected_resolution DATE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_creative_jobs_drop_id ON creative_jobs(drop_id);
CREATE INDEX IF NOT EXISTS idx_creative_jobs_planning_status ON creative_jobs(planning_status);

-- A Creative Job can cover multiple products (section 9: "Allow one or
-- multiple products").
CREATE TABLE IF NOT EXISTS creative_job_products (
  job_id INTEGER NOT NULL REFERENCES creative_jobs(id) ON DELETE CASCADE,
  style_id INTEGER NOT NULL REFERENCES styles(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, style_id)
);

CREATE INDEX IF NOT EXISTS idx_creative_job_products_style_id ON creative_job_products(style_id);

-- Line items under a Job's "What do we need to make this happen?" stock
-- checklist item: specific size/quantity to pull for a shoot, per style.
-- Separate from stock_status (a summary state) so the team can work a real
-- pull list rather than just a status dropdown + free-text note.
CREATE TABLE IF NOT EXISTS creative_job_stock_requests (
  id SERIAL PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES creative_jobs(id) ON DELETE CASCADE,
  style_id INTEGER NOT NULL REFERENCES styles(id) ON DELETE CASCADE,
  size VARCHAR(20) NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'needed' CHECK (status IN ('needed', 'pulled')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_creative_job_stock_requests_job_id ON creative_job_stock_requests(job_id);

-- ---------------------------------------------------------------------------
-- Proven Winners concept playbook: a ranked, reusable list of concept names
-- that auto-populate a new-drop product's required-concept plan. Settings-
-- owned; independent of any one drop or product. Ranking is 100% manual --
-- no scoring/AI/auto-reranking.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS proven_winners (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  rank INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_proven_winners_rank ON proven_winners(rank);

-- Default Format/Classification for assets created from this Proven Winner
-- (see "+ Create Asset" on a Required Concept slot) -- set once here so the
-- team never has to re-pick them per product; a New/Test concept has no
-- Proven Winner to default from, so its create-asset flow still asks.
ALTER TABLE proven_winners ADD COLUMN IF NOT EXISTS default_format VARCHAR(10) NOT NULL DEFAULT 'video'
  CHECK (default_format IN ('video', 'static'));
ALTER TABLE proven_winners ADD COLUMN IF NOT EXISTS default_classification VARCHAR(20) NOT NULL DEFAULT 'tested_proven'
  CHECK (default_classification IN ('tested_proven', 'new_experimental'));

-- A "product" has no table of its own -- it's a derived grouping computed by
-- deriveProductCode/buildCoverage on every request (coverage.js). This table
-- is the stable anchor a generated concept plan snapshots against, keyed on
-- the same (drop_id, product_code) pair the frontend already uses as its
-- hash-route identity (#planning/drop/<id>/product/<code>).
CREATE TABLE IF NOT EXISTS drop_product_plans (
  id SERIAL PRIMARY KEY,
  drop_id INTEGER NOT NULL REFERENCES drops(id) ON DELETE CASCADE,
  product_code VARCHAR(64) NOT NULL,
  last_known_target INTEGER NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (drop_id, product_code)
);

-- One row per required concept slot. concept_name is a SNAPSHOT (copied at
-- generation time) so later renaming/reordering/deactivating/deleting a
-- Proven Winner never rewrites an already-generated plan -- proven_winner_id
-- is optional traceability only (ON DELETE SET NULL, never CASCADE).
CREATE TABLE IF NOT EXISTS drop_product_plan_slots (
  id SERIAL PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES drop_product_plans(id) ON DELETE CASCADE,
  slot_rank INTEGER NOT NULL,
  source VARCHAR(10) NOT NULL CHECK (source IN ('proven', 'new')),
  concept_name VARCHAR(255) NOT NULL,
  description TEXT,
  proven_winner_id INTEGER REFERENCES proven_winners(id) ON DELETE SET NULL,
  -- The specific Creative Asset that fulfils THIS slot (concept-diversity
  -- fulfillment, not raw count). Lives here, not on creative_assets, so no
  -- existing ca.*/SELECT_QUERY/CARD_QUERY read path needs to change.
  fulfilled_by_asset_id INTEGER REFERENCES creative_assets(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plan_id, slot_rank)
);

CREATE INDEX IF NOT EXISTS idx_dpps_plan_id ON drop_product_plan_slots(plan_id);
CREATE INDEX IF NOT EXISTS idx_dpps_fulfilled_by ON drop_product_plan_slots(fulfilled_by_asset_id);

-- Snapshot of the source Proven Winner's default_format/default_classification
-- at generation time (same "snapshot, don't live-rewrite" principle as
-- concept_name) -- NULL for a 'new' source slot, which has no preset.
ALTER TABLE drop_product_plan_slots ADD COLUMN IF NOT EXISTS default_format VARCHAR(10)
  CHECK (default_format IS NULL OR default_format IN ('video', 'static'));
ALTER TABLE drop_product_plan_slots ADD COLUMN IF NOT EXISTS default_classification VARCHAR(20)
  CHECK (default_classification IS NULL OR default_classification IN ('tested_proven', 'new_experimental'));

-- ---------------------------------------------------------------------------
-- Core Creative Testing (Planning -> Core section). Everything else this
-- feature needs already exists (styles.tier = 'core_proven', styles.drop_id
-- nullable, creative_jobs.drop_id nullable, concept_classification =
-- 'new_experimental', status = 'uploaded_live') -- this is the one new
-- scalar setting it introduces. Singleton row, not a generic key/value
-- table: this codebase's pattern is one purpose-built table per concern
-- (see creative_target_rules), and a single INTEGER doesn't earn a KV
-- abstraction.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS planning_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  weekly_new_concept_target INTEGER NOT NULL DEFAULT 15,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO planning_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- High Stocks (Planning -> High Stocks section): non-Core products with
-- meaningful stock exposure that may deserve creative attention. Same
-- singleton-row/one-column-per-setting pattern as weekly_new_concept_target
-- above -- not a generic key/value table.
ALTER TABLE planning_settings ADD COLUMN IF NOT EXISTS high_stock_min_soh INTEGER NOT NULL DEFAULT 150;
ALTER TABLE planning_settings ADD COLUMN IF NOT EXISTS high_stock_recommendations_shown INTEGER NOT NULL DEFAULT 5;

-- High Stocks redesign: replaced the multi-signal pressure heuristic with a
-- flat "over 100 SOH" gate (see highStockProducts.js). Only rewrite rows
-- still on the OLD default (150) -- an admin who already customised this
-- keeps their value. high_stock_recommendations_shown is no longer read
-- anywhere (every eligible product is shown now); column kept, just unused.
UPDATE planning_settings SET high_stock_min_soh = 100 WHERE id = 1 AND high_stock_min_soh = 150;
ALTER TABLE planning_settings ALTER COLUMN high_stock_min_soh SET DEFAULT 100;

-- ---------------------------------------------------------------------------
-- Weekly Shoot Plan (Monday Planning: deciding WHAT gets shot this week
-- and whether the product is in hand). Deliberately minimal -- talent,
-- location, props and scripts are handled later via the existing Creative
-- Job flow once the content creator has developed concepts.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS shoot_plan_items (
  id SERIAL PRIMARY KEY,
  product_code VARCHAR(64) NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  stock_status VARCHAR(30) NOT NULL CHECK (stock_status IN ('in_office', 'needs_to_be_brought_in')),
  creator VARCHAR(255) NOT NULL,
  initial_idea TEXT,
  asset_id INTEGER REFERENCES creative_assets(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shoot_plan_items_created_at ON shoot_plan_items(created_at);

-- Which colourways within the product family are actually being shot.
CREATE TABLE IF NOT EXISTS shoot_plan_item_styles (
  shoot_plan_item_id INTEGER NOT NULL REFERENCES shoot_plan_items(id) ON DELETE CASCADE,
  style_id INTEGER NOT NULL REFERENCES styles(id) ON DELETE CASCADE,
  PRIMARY KEY (shoot_plan_item_id, style_id)
);

-- Physical sample size to pull for this colourway -- nullable since older
-- rows (and any AM account where sizing can't be resolved) predate this.
ALTER TABLE shoot_plan_item_styles ADD COLUMN IF NOT EXISTS size VARCHAR(20);

-- New pre-concept-development hold state, entered automatically when
-- Monday Planning confirms a product needs shooting -- distinct from the
-- generic 'not_started' default and from 'awaiting_proven_concept' (which
-- means something narrower: waiting on a Tested/Proven slot specifically).
ALTER TABLE creative_assets DROP CONSTRAINT IF EXISTS creative_assets_status_check;
ALTER TABLE creative_assets ADD CONSTRAINT creative_assets_status_check
  CHECK (status IN ('not_started', 'awaiting_proven_concept', 'awaiting_concept_development',
                     'concept_script', 'filming', 'editing', 'qc', 'uploaded_live'));

-- Settings-managed list of who can be assigned as Content Creator on a
-- Shoot This Week item -- previously a single hardcoded default ('Mark')
-- in the frontend. Exactly one row is_default at a time (enforced by the
-- partial unique index below); the Shoot This Week modal's creator
-- dropdown pre-selects it, and (once the sizes below are set) auto-fills
-- each colourway's size control from this same row.
CREATE TABLE IF NOT EXISTS content_creators (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) UNIQUE NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_creators_one_default ON content_creators(is_default) WHERE is_default;
INSERT INTO content_creators (name, is_default) VALUES ('Mark', true) ON CONFLICT (name) DO NOTHING;

-- Per-creator default sample size, by garment shape -- replaces the
-- hardcoded CONTENT_CREATOR_SIZE_DEFAULTS object app.js used to key off
-- creator name. A colourway's own resolved size list still decides what's
-- actually selectable; these are just what to pre-select when a match is
-- found (see app.js's defaultSizeForColourway). All nullable -- a creator
-- with no sizes set here simply gets no size pre-filled, same graceful
-- fallback as before.
ALTER TABLE content_creators ADD COLUMN IF NOT EXISTS default_top_size VARCHAR(20);
ALTER TABLE content_creators ADD COLUMN IF NOT EXISTS default_bottom_alpha_size VARCHAR(20);
ALTER TABLE content_creators ADD COLUMN IF NOT EXISTS default_bottom_waist_size VARCHAR(20);
-- One-time backfill of Mark's sizes to match the values that used to be
-- hardcoded -- guarded so it never overwrites a value someone has since
-- set via Settings. Uses the abbreviated scale (see TOP_SIZE_OPTIONS /
-- BOTTOM_ALPHA_SIZE_OPTIONS in app.js) so it pre-selects correctly in the
-- Settings dropdowns, not the old full-word 'Small'.
UPDATE content_creators SET
  default_top_size = 'S', default_bottom_alpha_size = 'S', default_bottom_waist_size = '30'
  WHERE name = 'Mark' AND default_top_size IS NULL AND default_bottom_alpha_size IS NULL AND default_bottom_waist_size IS NULL;

-- Normalises anyone who already picked up the earlier 'Small'-labelled
-- backfill (before the fields became fixed dropdowns) to the same
-- abbreviated scale -- idempotent, and only ever touches this exact
-- legacy value, never a value someone has deliberately set since.
UPDATE content_creators SET default_top_size = 'S' WHERE default_top_size = 'Small';
UPDATE content_creators SET default_bottom_alpha_size = 'S' WHERE default_bottom_alpha_size = 'Small';

-- ---------------------------------------------------------------------------
-- Monday Planning 5-step workflow (Core -> High Stocks -> Upcoming Drops ->
-- Promotions -> Shoot Plan). Which Planning step a shoot came from, and the
-- product image/colourway label to show in the Shoot Plan step, weren't
-- needed while Shoot Plan was a single flat list -- both nullable since
-- existing rows predate this and simply won't group/display as richly.
-- ---------------------------------------------------------------------------
ALTER TABLE shoot_plan_items ADD COLUMN IF NOT EXISTS source VARCHAR(20) CHECK (source IN ('core', 'high_stock', 'drop', 'promotion'));
ALTER TABLE shoot_plan_items ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE shoot_plan_item_styles ADD COLUMN IF NOT EXISTS colour_label VARCHAR(255);

-- Promotions: no ApparelMagic/SOH-driven target the way Core/High Stocks/
-- Drops have, since a promotion isn't one product -- just a manual name/
-- date range/notes shell. The requirement structure (customisable Campaign
-- Stages, each with its own numeric target) lives in promotion_stages
-- below, added once the flat is_ready checklist here was replaced. A
-- promotion with zero stages reads as Needs Attention (nothing organised
-- yet), not On Track.
CREATE TABLE IF NOT EXISTS promotions (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  start_date DATE NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RETIRED: replaced by promotion_stages (see below the weekly shoot plan
-- confirmations table further down). Kept in place, unused, same as every
-- other retired table in this file.
CREATE TABLE IF NOT EXISTS promotion_creative_items (
  id SERIAL PRIMARY KEY,
  promotion_id INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  description VARCHAR(255) NOT NULL,
  is_ready BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per calendar week (Monday-start, matching shoot_plan_items' own
-- week filter) once the team has confirmed that week's shoot plan --
-- persisted rather than a client-side flag so it survives reload and is
-- visible to the whole team, not just whoever clicked confirm.
CREATE TABLE IF NOT EXISTS weekly_shoot_plan_confirmations (
  week_start DATE PRIMARY KEY,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Promotions redesign: Upcoming Drops' own structure (Drop -> Products ->
-- Creative Requirements) mirrored for Promotions (Promotion -> Campaign
-- Stages -> Creative Requirements), replacing the old flat is_ready
-- checklist. A promotion isn't tied to one product/SKU the way a Drop is,
-- so stages are the entity that carries the requirement (a numeric target,
-- like a Drop product's creative_target), and are fully custom per
-- promotion -- no hardcoded Hype/Launch/Mid-Sale/Last Chance set, since
-- different campaigns need different structures. promotion_creative_items
-- is left in place (this codebase never drops tables) but nothing reads or
-- writes it going forward.
-- ---------------------------------------------------------------------------
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS end_date DATE;

CREATE TABLE IF NOT EXISTS promotion_stages (
  id SERIAL PRIMARY KEY,
  promotion_id INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  required_count INTEGER NOT NULL DEFAULT 1 CHECK (required_count >= 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_promotion_stages_promotion_id ON promotion_stages(promotion_id);

-- A stage's requirement is "covered" by linking Shoot Plan items to it
-- (below) -- the same Concept Development pipeline every other Planning
-- step already feeds, rather than a separate parallel workflow. Deliberately
-- NOT tied through creative_assets/style_id directly: a promotion's
-- creative need is the stage/message, not a SKU, and plenty of promotion
-- stages (sitewide sale messaging, a bundle, a GWP) have no single natural
-- product to require a style_id for.
ALTER TABLE shoot_plan_items ADD COLUMN IF NOT EXISTS promotion_stage_id INTEGER REFERENCES promotion_stages(id) ON DELETE SET NULL;

-- Give any promotion that predates this redesign a single "General" stage
-- (sized to its old flat item count, minimum 1) so it isn't left with a
-- blank requirements list on first load -- coverage starts fresh under the
-- new count-based model since the old is_ready flag has no equivalent here.
-- Guarded to only ever run once per promotion (skips any promotion that
-- already has a stage), same idempotent-on-every-boot pattern as the rest
-- of this file.
DO $$
DECLARE
  promo RECORD;
BEGIN
  FOR promo IN
    SELECT p.id, COUNT(i.id)::int AS item_count
    FROM promotions p
    LEFT JOIN promotion_creative_items i ON i.promotion_id = p.id
    WHERE p.id NOT IN (SELECT DISTINCT promotion_id FROM promotion_stages)
    GROUP BY p.id
  LOOP
    INSERT INTO promotion_stages (promotion_id, name, required_count, sort_order)
    VALUES (promo.id, 'General', GREATEST(promo.item_count, 1), 0);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Meta Product Mapping: Meta's ad-naming convention concatenates Product
-- and Product Type (e.g. "HALO SWEAT SET + SWEATS"), but that text doesn't
-- always match the ApparelMagic/internal product name exactly (that example
-- is really "Halo Hood Sweat") -- so attribution can't rely on string
-- matching. This table is the persisted lookup: (meta_product,
-- meta_product_type) -> a stable internal product_code (the same 8-char
-- family key apparelmagic.js's deriveProductCode already derives from a
-- style_code, and that Core/Drops/High Stocks/Coverage all group by) --
-- never a product NAME, since a name can be edited later without the
-- mapping breaking. product_code/product_name are nullable together: a row
-- with product_code IS NULL means the combination has been seen but not
-- yet resolved ("Unmapped"); there is no default/fallback guess. Batch No.
-- (also part of the naming convention) is deliberately not modeled here at
-- all -- it's parsed and passed along as metadata only, never part of the
-- lookup key, since one batch can span multiple products or an entire drop.
CREATE TABLE IF NOT EXISTS meta_product_mappings (
  id SERIAL PRIMARY KEY,
  meta_product VARCHAR(255) NOT NULL,
  meta_product_type VARCHAR(255) NOT NULL,
  product_code VARCHAR(64),
  product_name VARCHAR(255),
  mapped_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Case-insensitive: Meta ad names aren't guaranteed consistent casing
-- between ads for what's meant to be the same Product + Product Type.
CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_product_mappings_key
  ON meta_product_mappings (UPPER(meta_product), UPPER(meta_product_type));

-- ---------------------------------------------------------------------------
-- Promotions V2: a stage's own go-live/due date drives its urgency (On
-- Track / Needs Attention / At Risk in promotions.js) -- the closer the
-- date, the more a remaining gap matters. Optional: plenty of stages
-- (sitewide sale messaging, ongoing GWP) have no single hard deadline.
ALTER TABLE promotion_stages ADD COLUMN IF NOT EXISTS due_date DATE;

-- ---------------------------------------------------------------------------
-- Default Shoot Sizes (Settings -> Default Shoot Sizes): pre-fills each
-- selected colourway's size when the "Shoot This Week" modal opens, keyed
-- by garment type (top vs bottom) and, for bottoms, alpha vs waist sizing
-- (see classifyGarmentType/defaultSizeForColourway in app.js). One shared
-- default rather than one per Content Creator -- replaces that per-creator
-- sizing's role for this specific purpose; the content_creators size
-- columns are unused by this modal going forward but kept in place, same
-- as every other retired-in-place column in this file.
ALTER TABLE planning_settings ADD COLUMN IF NOT EXISTS default_shoot_top_size VARCHAR(20) NOT NULL DEFAULT 'S';
ALTER TABLE planning_settings ADD COLUMN IF NOT EXISTS default_shoot_bottom_alpha_size VARCHAR(20) NOT NULL DEFAULT 'S';
ALTER TABLE planning_settings ADD COLUMN IF NOT EXISTS default_shoot_bottom_waist_size VARCHAR(20) NOT NULL DEFAULT '30';

-- ---------------------------------------------------------------------------
-- Weekly Planning: Shoot Plan items now belong to the week they were
-- planned FOR, not just whichever calendar week they happened to be
-- inserted in. That's what makes week navigation possible -- viewing last
-- week shows what was actually planned then, and advance-planning a future
-- week stores items against that future Monday instead of today's. Backfill
-- existing rows from their created_at, matching the same Monday-start week
-- every other date_trunc('week', ...) call in this app already uses.
ALTER TABLE shoot_plan_items ADD COLUMN IF NOT EXISTS week_start DATE;
UPDATE shoot_plan_items SET week_start = (date_trunc('week', created_at))::date WHERE week_start IS NULL;
ALTER TABLE shoot_plan_items ALTER COLUMN week_start SET DEFAULT (date_trunc('week', now()))::date;
ALTER TABLE shoot_plan_items ALTER COLUMN week_start SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shoot_plan_items_week_start ON shoot_plan_items(week_start);

-- Monday Planning Checklist: per-week, manually-ticked review state for the
-- four recommendation steps (Core/High Stocks/Upcoming Drops/Promotions).
-- Deliberately NOT auto-set by visiting a tab -- the team asked for an
-- explicit tick, not a "was it opened" flag. The checklist's 5th item,
-- "Shoot Plan confirmed", is derived from weekly_shoot_plan_confirmations
-- rather than duplicated here, so there's one source of truth for it.
CREATE TABLE IF NOT EXISTS weekly_planning_progress (
  week_start DATE PRIMARY KEY,
  core_reviewed BOOLEAN NOT NULL DEFAULT false,
  high_stock_reviewed BOOLEAN NOT NULL DEFAULT false,
  drops_reviewed BOOLEAN NOT NULL DEFAULT false,
  promotions_reviewed BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Concept Development: the stage right after Monday Planning confirms a
-- week's Shoot Plan. Concepts are still creative_assets rows (this table is
-- already "one row per ad concept per style") rather than a new parallel
-- entity, so the Kanban board/status history/every existing consumer keep
-- working unchanged, and later Shooting/Editing stages can build on the
-- same rows. All additive/nullable except where noted.
-- ---------------------------------------------------------------------------

-- Scopes a Core/High Stock/Promotion concept to the exact shoot_plan_items
-- handoff it belongs to, so Concept Dev shows only this week's concepts for
-- a product, not every historical asset ever made for the style. Stays NULL
-- for Drop-sourced concepts, which are scoped via drop_product_plan_slots
-- instead (those already have their own assigned-concept structure).
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS shoot_plan_item_id INTEGER REFERENCES shoot_plan_items(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_creative_assets_shoot_plan_item_id ON creative_assets(shoot_plan_item_id);

-- Concept Development's own simple review status -- deliberately separate
-- from the main production `status` (not_started..uploaded_live), which the
-- Kanban board and every "days since last live" check elsewhere already
-- depends on. This is just "how far along is this concept for Tuesday
-- review", not where it sits in the full production pipeline. A freshly
-- created concept starts life already being worked on, not sitting idle --
-- see ALTER COLUMN ... SET DEFAULT below.
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS concept_dev_status VARCHAR(20) NOT NULL DEFAULT 'not_started'
  CHECK (concept_dev_status IN ('not_started', 'in_development', 'ready_for_review', 'changes_required', 'approved'));
ALTER TABLE creative_assets ALTER COLUMN concept_dev_status SET DEFAULT 'in_development';

-- The actual creative-development fields a concept is built from.
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS angle TEXT;
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS hook TEXT;
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS execution TEXT;
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS script_notes TEXT;
-- Reference uploads (image/video/screenshot) are out of scope for V1 -- no
-- object storage exists yet and Railway's own disk is ephemeral, so links
-- are the only supported reference mechanism for now.
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS reference_links TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS reference_note TEXT;
-- Superseded by reference_items below (each reference link needs its own
-- "what we like about it" note, not one shared note for the whole list) --
-- the app no longer reads/writes these two, backfilled once below.
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS reference_items JSONB NOT NULL DEFAULT '[]'::jsonb;
UPDATE creative_assets
   SET reference_items = (
     SELECT COALESCE(jsonb_agg(jsonb_build_object('url', link, 'note', creative_assets.reference_note)), '[]'::jsonb)
     FROM unnest(creative_assets.reference_links) AS link
   )
 WHERE reference_items = '[]'::jsonb AND cardinality(reference_links) > 0;
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS talent_requirement TEXT;
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS props_notes TEXT;
