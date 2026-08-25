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
