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
