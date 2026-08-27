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
-- set via Settings.
UPDATE content_creators SET
  default_top_size = 'Small', default_bottom_alpha_size = 'Small', default_bottom_waist_size = '30'
  WHERE name = 'Mark' AND default_top_size IS NULL AND default_bottom_alpha_size IS NULL AND default_bottom_waist_size IS NULL;
