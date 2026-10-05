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

-- Starter seed: proven_winners is Settings-owned admin data that was never
-- seeded by a migration -- production's real list was entered by hand
-- through Settings at some point before this table's schema even existed
-- here. That's WHY a fresh/PR-test database's Drop product pages show "No
-- required concepts yet" instead of auto-populating (generateOrTopUpPlan
-- in dropProductPlans.js already reads straight from this table -- it's
-- the correct source of truth, just empty). This is not a new invented
-- list: it's the exact vocabulary concept_types' own one-time seed further
-- below already copied from proven_winners' production contents at the
-- time it ran ("Flatlay Photo, POV from iPhone, Try on/Flatlay Video,
-- Ecom Photo, Green Screen Video", etc.) -- restoring the table those
-- comments already assumed existed. Guarded the same way: fires only the
-- first time this runs against a database where proven_winners is still
-- empty, so it's a pure no-op against production (which already has these
-- rows under their own ids) and never overwrites a later rename/reorder/
-- deactivate/addition made through Settings.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM proven_winners) THEN
    INSERT INTO proven_winners (name, rank, default_format, default_classification) VALUES
      ('Flatlay Photo', 1, 'static', 'tested_proven'),
      ('POV from iPhone', 2, 'video', 'tested_proven'),
      ('Try on/Flatlay Video', 3, 'video', 'tested_proven'),
      ('Ecom Photo', 4, 'static', 'tested_proven'),
      ('Green Screen Video', 5, 'video', 'tested_proven'),
      ('Flatlay Video', 6, 'video', 'tested_proven'),
      ('Product Close Up', 7, 'video', 'tested_proven'),
      ('Rug Try On', 8, 'video', 'tested_proven');
  END IF;
END $$;

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

-- Shez is a real filming person (already the second name in
-- CONCEPT_ASSIGNEES, app.js -- the concept_assignee/editing_owner roster)
-- but src/db.js's SEED_USERS only creates login accounts, and therefore
-- auto-links content_creators, for the six named team accounts -- Shez
-- doesn't have one. Without this row, Shez can never appear in Shooting's
-- owner filter, Core/Promotion's Filming picker, or any other UI driven off
-- content_creators, even though everywhere else in the app already treats
-- Shez as a real assignable person. No user_id: this doesn't create a login,
-- only the same plain named-creator row Settings' "+ Add Content Creator"
-- already supports for anyone without an account.
INSERT INTO content_creators (name) VALUES ('Shez') ON CONFLICT (name) DO NOTHING;

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
-- Black Friday 2026 starter promotion: seeds a Promotion Overview with a
-- realistic multi-stage campaign structure (Hype Ads / Sale Live Ads / Mid
-- Sale Offers Ads / Last Chance) instead of the single generic "General"
-- stage every other promotion gets from the backfill above, since planning
-- the biggest sale of the year needs a real example structure to start
-- from. The four required_count values (20/30/25/8) are STARTING targets
-- only -- fully editable afterwards from each stage card exactly like any
-- other stage, and the Promotion Overview's totals (e.g. 83 target) are
-- never stored anywhere; they're always computed live from whatever these
-- four numbers currently are (see summarizePromotion in promotions.js), so
-- editing, removing, reordering, or adding a stage updates the overview
-- automatically with no extra code.
--
-- Handles two cases without ever touching any OTHER promotion:
--  1. No "Black Friday 2026" promotion exists yet -- create it with all
--     four stages together.
--  2. It already exists (e.g. created by hand through the UI, with just a
--     single "Hype" stage, before this template existed) -- bring it up to
--     the four-stage template in place rather than delete-and-recreate, so
--     any Shoot Plan items already linked to that stage stay linked. The
--     'Hype'/'Mid Sale Offers' -> '...Ads' renames only ever match the
--     literal old name, so once corrected once they never re-fire and can't
--     clobber a later manual edit; any of the four stages still missing
--     (by name) gets topped up, and a stage the team has already renamed to
--     something else, or added themselves, is left completely alone.
DO $$
DECLARE
  bf_id INTEGER;
BEGIN
  SELECT id INTO bf_id FROM promotions WHERE name = 'Black Friday 2026';

  IF bf_id IS NULL THEN
    INSERT INTO promotions (name, start_date, end_date, notes)
    VALUES (
      'Black Friday 2026', '2026-11-12', '2026-12-01',
      'Starter Campaign Stages seeded automatically -- rename, retarget, reorder, or add more stages as needed.'
    )
    RETURNING id INTO bf_id;

    INSERT INTO promotion_stages (promotion_id, name, required_count, sort_order) VALUES
      (bf_id, 'Hype Ads', 20, 0),
      (bf_id, 'Sale Live Ads', 30, 1),
      (bf_id, 'Mid Sale Offers Ads', 25, 2),
      (bf_id, 'Last Chance / Ends Today', 8, 3);
  ELSE
    UPDATE promotion_stages SET name = 'Hype Ads', required_count = 20, updated_at = now()
    WHERE promotion_id = bf_id AND name = 'Hype';
    UPDATE promotion_stages SET name = 'Mid Sale Offers Ads', required_count = 25, updated_at = now()
    WHERE promotion_id = bf_id AND name = 'Mid Sale Offers';

    INSERT INTO promotion_stages (promotion_id, name, required_count, sort_order)
    SELECT bf_id, v.name, v.required_count, v.sort_order
    FROM (VALUES
      ('Hype Ads', 20, 0),
      ('Sale Live Ads', 30, 1),
      ('Mid Sale Offers Ads', 25, 2),
      ('Last Chance / Ends Today', 8, 3)
    ) AS v(name, required_count, sort_order)
    WHERE NOT EXISTS (
      SELECT 1 FROM promotion_stages ps WHERE ps.promotion_id = bf_id AND ps.name = v.name
    );
  END IF;
END $$;

-- promotions.notes is the only free-text field a promotion has -- genuinely
-- meant to hold a real offer/message once someone adds one (see the
-- Promotion Concept Development modal's Promotion/Offer Context block),
-- not internal setup metadata. The one-time seed above wrote its own
-- "stages seeded automatically" admin note straight into it, which then
-- surfaced to creators as if it were the actual creative offer. Clear it,
-- but ONLY while it still holds exactly that original seed text -- so a
-- real note anyone has since typed in its place is never touched.
UPDATE promotions SET notes = NULL, updated_at = now()
WHERE name = 'Black Friday 2026'
  AND notes = 'Starter Campaign Stages seeded automatically -- rename, retarget, reorder, or add more stages as needed.';

-- ---------------------------------------------------------------------------
-- Remove the obsolete duplicate "Black Friday 2026" promotion. Root cause:
-- the correction block above (and the original seed before it) only ever
-- matches the exact string 'Black Friday 2026'. The live app already had a
-- promotion whose name differs only by case/whitespace (e.g. the "BLACK
-- FRIDAY 2026" spelling used earlier when this feature was first
-- specified) -- that row never matched, so it was left behind untouched
-- with its old single "Hype"/15 stage while a second, correctly-templated
-- row got created (or corrected) under the exact-match name, producing two
-- cards on the Promotions screen.
--
-- Only ever removes a case/whitespace-variant duplicate, and only when it
-- is provably unused: no Shoot Plan items linked to any of its stages
-- (i.e. nothing of production value would be lost). If a duplicate has any
-- real linked data, it's left alone -- same "never destructively touch
-- real progress" rule as everywhere else in this file -- for a human to
-- look at instead of being silently deleted.
DO $$
DECLARE
  bf_id INTEGER;
  dup RECORD;
BEGIN
  SELECT id INTO bf_id FROM promotions WHERE name = 'Black Friday 2026';
  IF bf_id IS NOT NULL THEN
    FOR dup IN
      SELECT id FROM promotions
      WHERE id != bf_id AND TRIM(name) ILIKE 'black friday 2026'
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM shoot_plan_items spi
        JOIN promotion_stages ps ON ps.id = spi.promotion_stage_id
        WHERE ps.promotion_id = dup.id
      ) THEN
        DELETE FROM promotion_stages WHERE promotion_id = dup.id;
        DELETE FROM promotions WHERE id = dup.id;
      END IF;
    END LOOP;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Rolling major-sales calendar: tags a promotion as one of the four
-- recurring annual sale types WNDRR runs, so the Promotions screen can
-- distinguish "the next occurrence of an annual sale" from an ad-hoc/
-- custom promotion. Nullable and untouched for every existing promotion
-- except Black Friday 2026 (backfilled below) -- a custom promotion is
-- simply never tagged, and behaves exactly as it always has.
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS sale_type VARCHAR(20)
  CHECK (sale_type IN ('black_friday', 'boxing_day', 'birthday_sale', 'eofy_winter_sale'));

UPDATE promotions SET sale_type = 'black_friday' WHERE name = 'Black Friday 2026' AND sale_type IS NULL;

-- ---------------------------------------------------------------------------
-- WNDRR Yearly Cadence: generates upcoming occurrences of the four
-- recurring annual sales from their real source of truth -- the ISO
-- calendar WEEK each one falls in (Birthday Sale W12-13, EOFY Winter Sale
-- W28-30, Black Friday W46-48, Boxing Day W52-53), not a fixed date that
-- would drift awkwardly copied year to year. For each sale type, this
-- walks forward from the current ISO year until it finds the first
-- occurrence that hasn't finished yet, seeds that one, then seeds the one
-- after it too -- two occurrences of headroom per type, so the rolling
-- "next 4 sales" view never runs dry between deploys even if nobody
-- touches this file for a while.
--
-- Existing promotions are never touched: each occurrence is only inserted
-- if no promotion already exists under its exact computed name (e.g.
-- "Black Friday 2026") -- this is how the already-seeded/corrected Black
-- Friday 2026 (real dates, four stages, 83 target) is left completely
-- alone here, while "Black Friday 2027" still gets created fresh from the
-- week pattern once its year comes up. New occurrences get NO campaign
-- stages of their own -- never copies Black Friday's structure -- and the
-- pre-existing "General" stage backfill (elsewhere in this file) is left
-- exactly as-is, applying to these the same way it always has to any
-- stage-less promotion.
DO $$
DECLARE
  cadence RECORD;
  candidate_year INTEGER;
  occurrence_start DATE;
  occurrence_end DATE;
  occurrences_made INTEGER;
  i INTEGER;
BEGIN
  FOR cadence IN
    SELECT * FROM (VALUES
      ('black_friday', 'Black Friday', 46, 48),
      ('boxing_day', 'Boxing Day', 52, 53),
      ('birthday_sale', 'Birthday Sale', 12, 13),
      ('eofy_winter_sale', 'EOFY Winter Sale', 28, 30)
    ) AS c(sale_type, name_prefix, week_start, week_end)
  LOOP
    candidate_year := EXTRACT(ISOYEAR FROM CURRENT_DATE)::INTEGER;
    occurrences_made := 0;

    -- Bounded to 6 years ahead so a malformed week number can never loop
    -- forever -- in practice this always resolves within 1-2 iterations.
    FOR i IN 0..6 LOOP
      EXIT WHEN occurrences_made >= 2;

      -- Postgres's IYYY-IW-ID format gives the Monday (ID=1) of a given
      -- ISO week/year for the start, Sunday (ID=7) for the end.
      occurrence_start := to_date(candidate_year || '-' || cadence.week_start || '-1', 'IYYY-IW-ID');
      occurrence_end := to_date(candidate_year || '-' || cadence.week_end || '-7', 'IYYY-IW-ID');

      IF occurrence_end >= CURRENT_DATE THEN
        INSERT INTO promotions (name, start_date, end_date, sale_type)
        SELECT cadence.name_prefix || ' ' || candidate_year, occurrence_start, occurrence_end, cadence.sale_type
        WHERE NOT EXISTS (
          SELECT 1 FROM promotions WHERE name = cadence.name_prefix || ' ' || candidate_year
        );
        occurrences_made := occurrences_made + 1;
      END IF;

      candidate_year := candidate_year + 1;
    END LOOP;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Standard creative structure for recurring main sales: applies the same
-- four Campaign Stages Black Friday already uses (Hype Ads 20, Sale Live
-- Ads 30, Mid Sale Offers Ads 25, Last Chance / Ends Today 8, total 83) to
-- every OTHER recurring annual sale generated above (Boxing Day, Birthday
-- Sale, EOFY Winter Sale, and any future year of any of the four types) --
-- these are starting targets only, editable per stage exactly like Black
-- Friday's, not a permanent rule. Part of the same recurring migration
-- set, so a newly generated occurrence (e.g. Black Friday 2027, once its
-- cycle comes up) gets this structure automatically the same deploy it's
-- created, with no separate step required.
--
-- Never touches "Black Friday 2026" itself (explicit name guard, on top
-- of the structural check below already making it a no-op there). Only
-- ever applies to a promotion that is CLEARLY still on the untouched
-- default: either zero stages, or exactly one stage literally named
-- "General" with required_count = 1 -- exactly what the "General"
-- backfill above creates, and not something a person would deliberately
-- configure as their real structure. A promotion carrying any other stage
-- setup -- partial, renamed, or fully custom -- is left completely alone,
-- protecting real manual configuration per the safeguard. Also idempotent
-- against itself: a promotion that already has all four of these stage
-- names (even alongside extra stages someone has since added) is skipped
-- outright, so re-running this block can never create duplicates.
DO $$
DECLARE
  promo RECORD;
  stage_names TEXT[];
BEGIN
  FOR promo IN
    SELECT id, name FROM promotions
    WHERE sale_type IS NOT NULL AND name != 'Black Friday 2026'
  LOOP
    SELECT array_agg(name) INTO stage_names FROM promotion_stages WHERE promotion_id = promo.id;

    CONTINUE WHEN stage_names @> ARRAY['Hype Ads', 'Sale Live Ads', 'Mid Sale Offers Ads', 'Last Chance / Ends Today'];

    IF stage_names IS NULL THEN
      INSERT INTO promotion_stages (promotion_id, name, required_count, sort_order) VALUES
        (promo.id, 'Hype Ads', 20, 0),
        (promo.id, 'Sale Live Ads', 30, 1),
        (promo.id, 'Mid Sale Offers Ads', 25, 2),
        (promo.id, 'Last Chance / Ends Today', 8, 3);
    ELSIF stage_names = ARRAY['General'] AND EXISTS (
      SELECT 1 FROM promotion_stages WHERE promotion_id = promo.id AND name = 'General' AND required_count = 1
    ) THEN
      DELETE FROM promotion_stages WHERE promotion_id = promo.id AND name = 'General' AND required_count = 1;
      INSERT INTO promotion_stages (promotion_id, name, required_count, sort_order) VALUES
        (promo.id, 'Hype Ads', 20, 0),
        (promo.id, 'Sale Live Ads', 30, 1),
        (promo.id, 'Mid Sale Offers Ads', 25, 2),
        (promo.id, 'Last Chance / Ends Today', 8, 3);
    END IF;
    -- Any other existing stage configuration (partial, renamed, or fully
    -- custom) is left completely alone.
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Round 9: correct the four confirmed occurrences' dates to WNDRR's real
-- Yearly Cadence source of truth (the week-number generator above is an
-- approximation until each occurrence is actually confirmed). Guarded by
-- the OLD, generator-computed dates so this fires exactly once per
-- promotion -- once corrected, the WHERE clause no longer matches, so this
-- can never re-fire and clobber a date someone has since edited by hand via
-- the Edit Promotion modal (same "never destructively touch real progress"
-- pattern as the Black Friday 2026 notes-clear above). Deliberately does
-- NOT touch any other occurrence (e.g. Black Friday 2027, Boxing Day 2027)
-- -- only these four are confirmed; the rest stay on the week-based
-- approximation until they're confirmed too.
UPDATE promotions SET start_date = '2026-11-11', end_date = '2026-11-30', updated_at = now()
WHERE name = 'Black Friday 2026' AND start_date = '2026-11-12' AND end_date = '2026-12-01';

UPDATE promotions SET start_date = '2026-12-24', end_date = '2026-12-29', updated_at = now()
WHERE name = 'Boxing Day 2026' AND start_date = '2026-12-21' AND end_date = '2027-01-03';

UPDATE promotions SET start_date = '2027-03-24', end_date = '2027-04-04', updated_at = now()
WHERE name = 'Birthday Sale 2027' AND start_date = '2027-03-22' AND end_date = '2027-04-04';

UPDATE promotions SET start_date = '2027-07-14', end_date = '2027-07-28', updated_at = now()
WHERE name = 'EOFY Winter Sale 2027' AND start_date = '2027-07-12' AND end_date = '2027-08-01';

-- ---------------------------------------------------------------------------
-- Round 10: real names for eight already-existing Upcoming Drops, taken
-- from the original WNDRR app (not invented/generic) -- the isolated PR
-- database only ever had these drops' auto-created rows, never their real
-- names. Matched by launch_date (the only stable identifier available here)
-- and guarded by "name IS NULL" so this only ever fills in a genuinely
-- still-unnamed drop -- a name anyone has since set by hand (via the Edit
-- Drop modal's Drop Name field) always wins and is never overwritten, and
-- this can never re-fire once a row is named. Touches drops.name only --
-- launch_date, products, product plans, and concepts are all untouched.
-- Deliberately eight individual statements, not a generic naming rule: this
-- is a one-time data correction for known real names, not new fallback
-- logic, and it never creates a drop that doesn't already exist.
UPDATE drops SET name = 'Spring Capsule Drop', updated_at = now() WHERE launch_date = '2026-09-24' AND name IS NULL;
UPDATE drops SET name = 'October Drop 1', updated_at = now() WHERE launch_date = '2026-10-01' AND name IS NULL;
UPDATE drops SET name = 'Soho 1/4 Zip New Colours', updated_at = now() WHERE launch_date = '2026-10-08' AND name IS NULL;
UPDATE drops SET name = 'October Drop 2', updated_at = now() WHERE launch_date = '2026-10-15' AND name IS NULL;
UPDATE drops SET name = 'November Drop 1', updated_at = now() WHERE launch_date = '2026-10-22' AND name IS NULL;
UPDATE drops SET name = 'November Drop 2', updated_at = now() WHERE launch_date = '2026-10-29' AND name IS NULL;
UPDATE drops SET name = 'Black Friday Drop', updated_at = now() WHERE launch_date = '2026-11-11' AND name IS NULL;
UPDATE drops SET name = 'December Drop', updated_at = now() WHERE launch_date = '2026-11-19' AND name IS NULL;

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
-- review", not where it sits in the full production pipeline. Stays Not
-- Started until the creator actually saves work on it in the Individual
-- Concept workspace -- Save Draft/Ready for Review are the only things
-- that ever move it off Not Started (see conceptDevelopment.js PATCH
-- /concepts/:id and app.js's saveConceptDevModal).
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS concept_dev_status VARCHAR(20) NOT NULL DEFAULT 'not_started'
  CHECK (concept_dev_status IN ('not_started', 'in_development', 'ready_for_review', 'changes_required', 'approved'));

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

-- One-time backfill for concepts stuck at 'in_development' purely because
-- an earlier version of concept_dev_status's column default put new rows
-- there instead of 'not_started' (see the ALTER COLUMN comment above) --
-- with none of the actual creative-development fields ever filled in,
-- these were never really "being worked on", so reset them to match.
UPDATE creative_assets SET concept_dev_status = 'not_started'
 WHERE concept_dev_status = 'in_development'
   AND angle IS NULL AND hook IS NULL AND execution IS NULL AND script_notes IS NULL
   AND reference_items = '[]'::jsonb
   AND talent_requirement IS NULL AND location IS NULL AND props_notes IS NULL;

-- A Concept is a distinct idea, not one ad -- "1 Concept -> 3 Hook
-- Variations -> 3 (future) Creative Assets", never 3 concepts. Rather than
-- invent a new top-level entity, hook_variations holds every opening this
-- concept is trying (the first entry is the Primary Hook, any further ones
-- are Alternative Hooks) directly on the same creative_assets row --
-- exactly the reference_items pattern above, and exactly why counting
-- product.concepts.length elsewhere in the app is unaffected by how many
-- hooks a concept has. Superseded by this column: `hook` (a single-hook-
-- per-concept field) -- the app no longer reads/writes it, backfilled once
-- below into this concept's Primary Hook.
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS hook_variations JSONB NOT NULL DEFAULT '[]'::jsonb;
UPDATE creative_assets SET hook_variations = jsonb_build_array(jsonb_build_object('text', hook))
 WHERE hook_variations = '[]'::jsonb AND hook IS NOT NULL AND trim(hook) <> '';

-- What to Shoot: the literal, physical footage list a concept needs
-- captured -- deliberately separate from both Execution (the creative
-- flow/direction, still free text, untouched) and hook_variations (the
-- opening variations being tested). Exactly the hook_variations/
-- reference_items pattern -- one JSONB array of { name, capture } objects
-- directly on the row, array order IS shot order (no separate rank
-- column to keep in sync). Purely additive: defaults to '[]' so every
-- existing Concept keeps working with no structured shots at all -- the
-- Shooting page's "does this concept have What to Shoot data" check is
-- just "is this array non-empty", never a destructive backfill from the
-- existing free-text Execution (see the brief: never invent Shot records
-- for a Concept that never had them).
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS shots JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ---------------------------------------------------------------------------
-- Creative Toolkit: research/inspiration resources shown alongside Concept
-- Development, configurable so the team can add their own (TikTok Creative
-- Center, Motion, Pinterest, Drive folders, competitor sites, internal
-- docs...) without a code change. Deliberately just a plain external link +
-- helper copy -- the ChatGPT prompt generators and the Proven Winners link
-- shown in the same toolkit have real app logic behind them (context-aware
-- prompt building, an internal view) that this simple shape can't represent,
-- so those stay fixed cards in the frontend rather than rows here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS creative_resources (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) UNIQUE NOT NULL,
  description TEXT,
  url TEXT NOT NULL,
  resource_type VARCHAR(100),
  cta_label VARCHAR(100) NOT NULL DEFAULT 'Open ↗',
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO creative_resources (name, description, url, resource_type, cta_label, sort_order)
VALUES ('Meta Ad Library', 'See what other brands are currently running.', 'https://www.facebook.com/ads/library/', 'Research competitors', 'Open Ad Library ↗', 0)
ON CONFLICT (name) DO NOTHING;
INSERT INTO creative_resources (name, description, url, resource_type, cta_label, sort_order)
VALUES ('Ecommerce Equation', 'EE''s library of creative resources and trainings.', 'https://www.skool.com/ecommerce-equation/classroom/c0802fc9?md=a37c99fa293240f6b7944aed0d618130', 'Creative training', 'Open Classroom ↗', 1)
ON CONFLICT (name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Customer Avatars: WNDRR's reusable library of "who are we actually making
-- this for" profiles, selected per-concept in Concept Development so every
-- concept has a specific person on the other side of it before production
-- time gets spent. Deliberately kept to five short fields (mindset/behaviour,
-- not a demographic questionnaire) -- name plus four strategic questions:
-- who they are, what they want, what stops them buying, what resonates.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_avatars (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) UNIQUE NOT NULL,
  who_they_are TEXT,
  what_they_care_about TEXT,
  what_stops_buying TEXT,
  what_resonates TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One Primary Customer Avatar per concept, deliberately -- the brief wants
-- "who is this ad primarily speaking to", not an unlimited multi-select
-- that lets a concept dodge the question by targeting everyone. A plain
-- nullable FK (rather than a join table) is the simplest shape that still
-- leaves room for a future secondary_customer_avatar_id column without
-- restructuring anything, if that's ever needed -- not built now because
-- the brief explicitly doesn't want that complexity in the current UI.
-- custom_avatar_description/avatar_why_care hold the "+ Other / New Avatar"
-- one-off path: a concept-specific audience the creator described inline
-- rather than picking (or saving) a library avatar for. Exactly one of
-- customer_avatar_id / custom_avatar_description is populated at a time;
-- avatar_why_care (the creator's own "why does THIS concept matter to
-- them" answer) is never auto-filled from the avatar profile either way.
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS customer_avatar_id INTEGER REFERENCES customer_avatars(id) ON DELETE SET NULL;
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS custom_avatar_description TEXT;
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS avatar_why_care TEXT;

-- ---------------------------------------------------------------------------
-- Tuesday Creative Review: the human quality gate right after Concept
-- Development, before a concept is allowed into Shooting. A concept enters
-- this stage the moment concept_dev_status becomes 'ready_for_review' --
-- no separate "workflow stage" column needed, concept_dev_status already
-- carries that meaning end to end (not_started/in_development -> pre-review,
-- ready_for_review -> awaiting Tuesday, changes_required/approved/killed ->
-- Tuesday's own outcomes). 'killed' is new here; the constraint has to be
-- dropped and re-added (not just an additive ALTER TABLE) since it's
-- changing the allowed values of an existing column -- idempotent by using
-- Postgres's default auto-generated constraint name.
ALTER TABLE creative_assets DROP CONSTRAINT IF EXISTS creative_assets_concept_dev_status_check;
ALTER TABLE creative_assets ADD CONSTRAINT creative_assets_concept_dev_status_check
  CHECK (concept_dev_status IN ('not_started', 'in_development', 'ready_for_review', 'changes_required', 'approved', 'killed'));

-- reviewed_at/review_feedback/kill_reason/kill_note hold the CURRENT
-- decision's detail, for simple, no-JSON-parsing display (e.g. surfacing
-- "what needs changing" to the creator in Concept Development).
-- review_history is the append-only full record -- every decision ever
-- made on this concept, in order -- so resubmitting after Changes Required
-- never loses the earlier feedback, and a killed concept keeps its reason
-- for future creative learnings even though the row itself is never
-- deleted. No dedicated audit-log UI yet (per the brief), just the data to
-- support one later. Each entry: {decision, feedback?, kill_reason?,
-- kill_note?, decided_at}.
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS review_feedback TEXT;
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS kill_reason VARCHAR(50);
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS kill_note TEXT;
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS review_history JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ---------------------------------------------------------------------------
-- Shooting stage: Approved Concept -> Unscheduled -> Scheduled -> Shot ->
-- Ready for Editing. One row per Concept (creative_asset), created
-- automatically the moment Tuesday Review approves it (see
-- PATCH /concept-development/concepts/:id/review) -- the Concept itself is
-- never duplicated, this table just tracks where/when it gets shot.
--
-- original_week_start is set once and never changes -- it's the week the
-- Concept was approved into Shooting, and is what History's per-week
-- Planned/Shot/Carried Over/Not Completed accounting is keyed on.
-- scheduled_week_start/scheduled_day are the CURRENT placement, and do
-- change (assigning a day, moving between days, or carrying an unfinished
-- Concept into a later week's Unscheduled area). A Concept is "carried
-- over" for History purposes purely by scheduled_week_start no longer
-- matching original_week_start -- no separate flag needed.
CREATE TABLE IF NOT EXISTS shoot_schedule (
  id SERIAL PRIMARY KEY,
  creative_asset_id INTEGER NOT NULL UNIQUE REFERENCES creative_assets(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'unscheduled' CHECK (status IN ('unscheduled', 'scheduled', 'shot')),
  original_week_start DATE NOT NULL,
  scheduled_week_start DATE NOT NULL,
  scheduled_day VARCHAR(10) CHECK (scheduled_day IN ('monday', 'tuesday', 'wednesday', 'thursday', 'friday')),
  shot_at TIMESTAMPTZ,
  ready_for_editing BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shoot_schedule_scheduled_week ON shoot_schedule(scheduled_week_start);
CREATE INDEX IF NOT EXISTS idx_shoot_schedule_original_week ON shoot_schedule(original_week_start);

-- ---------------------------------------------------------------------------
-- Reference Library: a shared, lightweight bank of external creative
-- references (competitor ads, UGC, anything that sparked an idea) the whole
-- team can add to and browse. Lives inside the existing Creative Toolkit /
-- Creative Tools modals -- deliberately not a new toolkit or nav item, see
-- the ct-card entries in index.html. idea_type is intentionally just
-- BAU/SALE, no further tag taxonomy, per the brief. style_id is optional
-- context only (which product/category a reference might apply to),
-- reusing the existing styles/categories data rather than a new table.
--
-- Forward-looking, not yet wired up in the UI: a Concept's own
-- reference_items JSONB array (see below) can already hold an arbitrary
-- object per entry, so a future "attach this Library reference to a
-- Concept" feature can add a library_reference_id key to one of those
-- entries with zero schema change here -- the entry's own `note` stays a
-- separate, concept-specific field and must never be overwritten with (or
-- by) this table's `comment`.
CREATE TABLE IF NOT EXISTS reference_library (
  id SERIAL PRIMARY KEY,
  link TEXT NOT NULL,
  comment TEXT NOT NULL,
  idea_type VARCHAR(10) NOT NULL CHECK (idea_type IN ('bau', 'sale')),
  style_id INTEGER REFERENCES styles(id) ON DELETE SET NULL,
  added_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reference_library_created_at ON reference_library(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reference_library_idea_type ON reference_library(idea_type);

-- ---------------------------------------------------------------------------
-- Users & Auth foundation: real per-user accounts, replacing the single
-- shared APP_PASSWORD gate (see src/auth.js), plus role-based permissions --
-- structured now so the app never has to retrofit "who did this" or
-- feature-level access control later. Deliberately minimal for V1: four
-- broad role presets, no per-user permission overrides, no admin UI for any
-- of this yet -- just the data model and a read-only session/permissions
-- surface. Password hashing needs Node's crypto (scrypt), not plain SQL, so
-- the six seed users themselves are inserted by seedUsersAndBackfill() in
-- src/db.js right after this file runs, not here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'creative' CHECK (role IN ('admin', 'marketing', 'creative', 'viewer')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- Feature/action-level permission keys -- finer-grained than role alone, so
-- a future "grant this one extra permission to this one person" only needs
-- a new table (e.g. user_permissions), never a schema change here. `name`
-- is a human label for a future admin screen; `key` is what code checks.
CREATE TABLE IF NOT EXISTS permissions (
  id SERIAL PRIMARY KEY,
  key VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL
);
INSERT INTO permissions (key, name) VALUES
  ('planning.view', 'View Planning'),
  ('planning.edit', 'Edit Planning'),
  ('concepts.view', 'View Concepts'),
  ('concepts.edit', 'Edit Concepts'),
  ('concepts.review', 'Review Concepts (Tuesday Review)'),
  ('shooting.view', 'View Shooting'),
  ('shooting.edit', 'Edit Shooting'),
  ('promotions.view', 'View Promotions'),
  ('promotions.edit', 'Edit Promotions'),
  ('settings.view', 'View Settings'),
  ('settings.edit', 'Edit Settings'),
  ('results.view', 'View Results'),
  ('users.manage', 'Manage Users')
ON CONFLICT (key) DO NOTHING;

-- Which permissions each role grants -- the only piece of "access control"
-- actually queryable right now (see src/lib/permissions.js's hasPermission
-- helper and GET /auth/session, which returns the caller's own permission
-- list). Nothing in the app enforces these on any existing route yet -- per
-- the brief, this is the data model/service layer to build on later, not a
-- finished access-control rollout. Broad, defensible-for-now defaults:
-- Admin gets everything; Marketing covers Planning/Promotions/Results;
-- Creative covers the day-to-day production workflow; Viewer is read-only
-- everywhere.
CREATE TABLE IF NOT EXISTS role_permissions (
  role VARCHAR(20) NOT NULL,
  permission_key VARCHAR(50) NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role, permission_key)
);
INSERT INTO role_permissions (role, permission_key)
  SELECT 'admin', key FROM permissions
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role, permission_key) VALUES
  ('marketing', 'planning.view'), ('marketing', 'planning.edit'),
  ('marketing', 'promotions.view'), ('marketing', 'promotions.edit'),
  ('marketing', 'concepts.view'), ('marketing', 'results.view'),
  ('marketing', 'settings.view'),
  ('creative', 'planning.view'),
  ('creative', 'concepts.view'), ('creative', 'concepts.edit'), ('creative', 'concepts.review'),
  ('creative', 'shooting.view'), ('creative', 'shooting.edit'),
  ('creative', 'results.view'), ('creative', 'settings.view'),
  ('viewer', 'planning.view'), ('viewer', 'concepts.view'),
  ('viewer', 'shooting.view'), ('viewer', 'promotions.view'),
  ('viewer', 'settings.view'), ('viewer', 'results.view')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Migrate name-based ownership to real user relationships. Each FK below is
-- nullable and additive -- the existing text/name columns are left exactly
-- as they are (never dropped, per this file's own convention) so every
-- display call site keeps working unchanged; the FK is the new "real"
-- relationship, backfilled by name match once users exist (see
-- seedUsersAndBackfill() in src/db.js, which runs right after this file).
-- ---------------------------------------------------------------------------

-- Content Creators <-> Users: once seeded, this list IS effectively "the
-- active users, plus optional per-person sample-size defaults" -- every
-- seed user gets a linked content_creators row (see src/db.js), so the
-- existing Shoot This Week creator dropdown (already sourced from
-- content_creators) naturally becomes a users-backed list with zero
-- frontend change.
ALTER TABLE content_creators ADD COLUMN IF NOT EXISTS user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL;

-- Shoot Plan: who's actually shooting this product is now a real
-- relationship; `creator` stays the display text, unchanged.
ALTER TABLE shoot_plan_items ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Confirming a week's Shoot Plan didn't record who confirmed it at all
-- before this.
ALTER TABLE weekly_shoot_plan_confirmations ADD COLUMN IF NOT EXISTS confirmed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Concept Development / Tuesday Review: who created the concept, who last
-- submitted it for review, and who made the Tuesday Review decision.
-- Going forward, each review_history JSONB entry also carries its own
-- decided_by/decided_by_user_id (see conceptDevelopment.js) -- no migration
-- needed there, JSONB is schemaless and older entries simply predate it.
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS submitted_for_review_at TIMESTAMPTZ;
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS submitted_for_review_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Reference Library: added_by stays the display text; this is the real
-- relationship, always set automatically from the logged-in session now
-- that one exists (see referenceLibrary.js POST) -- the old client-side
-- "who am I" localStorage prompt is retired, it's genuinely redundant now.
ALTER TABLE reference_library ADD COLUMN IF NOT EXISTS added_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Settings: the one genuinely shared/global settings row -- who last
-- changed it. Every other Settings-managed table (Creative Resources,
-- Proven Winners, Customer Avatars...) is its own CRUD list rather than a
-- single shared config row, so "who changed it" is less meaningful there
-- and isn't instrumented yet -- deliberately out of scope for V1.
ALTER TABLE planning_settings ADD COLUMN IF NOT EXISTS updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Reference Library's optional Product/Category field is a Category picker,
-- not a specific product/style -- there are far fewer categories than
-- styles, so this is the one that's actually fast to pick from a dropdown
-- while adding a reference. Superseded: style_id above (the app no longer
-- reads/writes it, kept in place same as every other retired-in-place
-- column in this file).
ALTER TABLE reference_library ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;

-- Superseding category_id above: the app's own `categories` table (used by
-- Styles admin for Meta campaign/ad-set mapping) is a different concept from
-- ApparelMagic's own per-product category ("BOX FIT TEES", "HEAVY WEIGHT
-- TEES", ...) that the team actually thinks in terms of, and that Core Shoot
-- Planning/High Stocks already group by live from AM. Reference Library's
-- Category field should offer that same live AM category list, not the
-- unrelated local one -- a plain denormalized string (like added_by), not
-- another FK, since AM categories have no stable local id. category_id
-- retired in place, same as style_id before it.
ALTER TABLE reference_library ADD COLUMN IF NOT EXISTS category TEXT;

-- ---------------------------------------------------------------------------
-- Editing: turns a Shot Concept into one or more trackable Final Edits (the
-- actual ads). A Concept becomes available here the moment Shooting marks it
-- Shot (shoot_schedule.ready_for_editing -- that flag already existed,
-- unused until now). Deliberately a separate table rather than more
-- creative_assets rows: a Concept can now fan out into several independently
-- tracked Final Edits (Primary Hook, Alt Hook 01, Visual-first, ...), which
-- doesn't fit "one creative_assets row per style" and would otherwise flood
-- the Board Kanban (every creative_assets row shows there via its own
-- `status`) with rows that have nothing to do with that pipeline. Each row
-- still links straight back to its Concept, so Product/Concept/Hook context
-- is never re-entered -- see routes/editing.js.
--
-- V1 only stores the CURRENT final edit link (final_edit_link) -- a replace,
-- not a new version -- but final_edit_history keeps a lightweight append-only
-- log of every link this asset has ever had, purely for future reference; no
-- versioning UI is built against it yet.
CREATE TABLE IF NOT EXISTS final_edits (
  id SERIAL PRIMARY KEY,
  creative_asset_id INTEGER NOT NULL REFERENCES creative_assets(id) ON DELETE CASCADE,
  asset_name VARCHAR(255) NOT NULL,
  format VARCHAR(10) NOT NULL DEFAULT 'video' CHECK (format IN ('video', 'static', 'carousel')),
  variation_text TEXT,
  editor VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'to_edit' CHECK (status IN ('to_edit', 'editing', 'ready_for_approval')),
  final_edit_link TEXT,
  final_edit_updated_at TIMESTAMPTZ,
  final_edit_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  editor_notes TEXT,
  ready_for_approval_at TIMESTAMPTZ,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_final_edits_creative_asset_id ON final_edits(creative_asset_id);
CREATE INDEX IF NOT EXISTS idx_final_edits_status ON final_edits(status);

-- Editing workflow revision: Ready for Approval is now a Concept-level
-- action (submit once every required Final Edit is complete) rather than a
-- per-Final-Edit one -- final_edits.status above still derives to_edit/
-- editing per row, it just never reaches 'ready_for_approval' anymore. See
-- src/routes/editing.js's ready-for-approval endpoint.
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS editing_submitted_at TIMESTAMPTZ;
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS editing_submitted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Round 8: explicit "an editor has actually clicked In Progress" signal.
-- Previously the client inferred In Progress from "a final_edits row
-- exists", which is only true because the same user action creates the row
-- -- but keying status off a side effect is fragile, and live QA reported a
-- Concept showing In Progress before anyone had started it. This column is
-- the one thing that action does that means "started": set only by POST
-- /editing/concepts/:id/final-edits (advanceEditingToInProgress/
-- startEditingFinalEdit), cleared by DELETE /editing/final-edits/:id only
-- when that was the Concept's last remaining Final Edit (see editing.js).
-- Scheduling/rescheduling (PATCH /editing/schedule/:id) never touches this,
-- same as it never touches editing_submitted_at.
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS editing_started_at TIMESTAMPTZ;

-- Who is responsible for developing/handling this concept (Upcoming Drops'
-- Required Concepts list) -- deliberately separate from strategy_owner/
-- filming_owner/editing_owner/qc_owner above, which are the OLD Kanban
-- Board's per-production-stage handoff owners (STATUS_OWNER_FIELD in
-- statuses.js swaps which of those is "active" as status changes). This is
-- a single stable assignment that doesn't shift with pipeline stage, so it
-- needs its own column. NULL = Unassigned. Lives on creative_assets (not
-- drop_product_plan_slots) so it follows the concept into Concept
-- Development and beyond, since that's the record those stages actually
-- read/write -- a slot is just a Drop-specific pointer to it.
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS concept_assignee VARCHAR(20)
  CHECK (concept_assignee IS NULL OR concept_assignee IN ('Mark', 'Shez', 'Til'));

-- Steve (an existing team member/user, not a new one -- see SEED_USERS in
-- db.js and his existing content_creators row) is a real option for
-- Concept Development's "Assigned To", same roster as Mark/Shez/Til. Widens
-- the CHECK in place (drop + re-add, since Postgres has no ALTER ... ADD
-- VALUE for an inline CHECK) rather than a new column -- purely additive,
-- never narrows what's already allowed, and touches no existing row's data.
ALTER TABLE creative_assets DROP CONSTRAINT IF EXISTS creative_assets_concept_assignee_check;
ALTER TABLE creative_assets ADD CONSTRAINT creative_assets_concept_assignee_check
  CHECK (concept_assignee IS NULL OR concept_assignee IN ('Mark', 'Steve', 'Shez', 'Til'));

-- ---------------------------------------------------------------------------
-- Promotion concept-first flow: Promotion's "+ Shoot This Week" now starts
-- from a Concept Type + Concept Name, not a product -- see the architecture
-- investigation this round is built from. Two additive pieces:
--
-- 1. concept_types: a reusable, editable vocabulary of ad/concept formats
--    (e.g. "Green Screen Video", "POV"), deliberately NOT proven_winners --
--    that table drives Drops' automatic Required Concept generation
--    (generateOrTopUpPlan pulls every active row), so writing a
--    Promotion-only type there would silently start appearing as a Drop
--    requirement. This table is seeded ONCE from proven_winners' current
--    active names (so the team's existing vocabulary -- Flatlay Photo, POV
--    from iPhone, Try on/Flatlay Video, Ecom Photo, Green Screen Video,
--    etc. -- is already there on day one) and never synced again
--    afterwards; proven_winners itself is never written to by this
--    feature, in either direction.
CREATE TABLE IF NOT EXISTS concept_types (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) UNIQUE NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One-time-only seed: only fires the first time this ever runs against a
-- database where concept_types is still empty, so a proven_winner added
-- (or renamed) later never gets pulled in automatically -- deliberately no
-- ongoing sync between the two tables.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM concept_types) THEN
    INSERT INTO concept_types (name, sort_order)
    SELECT name, rank FROM proven_winners WHERE active ORDER BY rank;
  END IF;
END $$;

-- 2. concept_type on the concept itself -- separate from concept_name (the
-- individual idea), e.g. concept_type = "Green Screen Video", concept_name
-- = "Black Friday Price Shock". Free text (not an FK to concept_types) so
-- an existing concept's type is never invalidated by a later rename/
-- deactivation of that concept_types row, same reasoning as
-- drop_product_plan_slots.concept_name being a snapshot, not a live FK.
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS concept_type VARCHAR(255);

-- ---------------------------------------------------------------------------
-- Genuine "no product required" Promotion concepts: a promotion's creative
-- need is often the message/format itself (sitewide sale messaging, a
-- countdown graphic), with no single product to require. Making style_id
-- nullable (rather than a dummy/sentinel style row) keeps this honest --
-- an empty shoot_plan_item_styles set simply means no products are needed,
-- nothing fake stands in for "none". See board.js/creativeAssets.js for the
-- corresponding LEFT JOIN fixes this requires; assertCanEnterFilming
-- already short-circuits safely on a null style_tier (only gates
-- style_tier = 'new_drop', see rules.js), so no rule change needed there.
ALTER TABLE creative_assets ALTER COLUMN style_id DROP NOT NULL;
ALTER TABLE shoot_plan_items ALTER COLUMN product_code DROP NOT NULL;
ALTER TABLE shoot_plan_items ALTER COLUMN product_name DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- Promotion Concept Development: a separate UI/workflow for Promotion
-- concepts (see conceptDevelopment.js/app.js), NOT a separate concept entity
-- -- the same creative_assets row still flows through Concept Development ->
-- Tuesday Review -> Shooting -> Editing exactly as before. Static Promotion
-- concepts (a graphic tile, a DPA, a countdown) need actual on-creative copy,
-- which nothing existing represents: script_notes is spoken/talking-points
-- content for Video, angle is the 1-2 sentence brief (reused as-is for
-- Static's "What needs to be made?"), neither is "the words on the creative".
-- Three small, generically-named, nullable fields -- unused by Video, same
-- as talent_requirement/shots are unused by Static -- rather than repurposing
-- an existing column into a second meaning.
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS headline TEXT;
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS supporting_copy TEXT;
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS cta_text VARCHAR(100);

-- Static vs Video classification for a Concept Type, so the Promotion
-- concept-first flow's Concept Type dropdown can filter out irrelevant
-- options once a Format is picked (e.g. "Campaign Video" never needs to
-- show up while Format = Static). NULL = Either -- the safe default for
-- every existing type (Flatlay Photo, POV from iPhone, etc. all genuinely
-- can apply to either format in practice) and for any future "Other / New
-- Type" addition, which has no admin UI to classify it from yet.
ALTER TABLE concept_types ADD COLUMN IF NOT EXISTS format VARCHAR(10) CHECK (format IN ('video', 'static'));

-- New Promotion creative types from the sale Creative Calculator, added
-- alongside (never replacing) the existing vocabulary. Same idempotent
-- ON CONFLICT DO NOTHING pattern already used for content_creators/
-- creative_resources above -- safe to run on every boot, never touches
-- proven_winners in either direction (see the concept_types table comment),
-- and has no effect on Drop Required Concepts (generateOrTopUpPlan reads
-- only from proven_winners, never from concept_types).
INSERT INTO concept_types (name, sort_order, format) VALUES
  ('Graphic tile', 100, 'static'),
  ('GWP - Graphic', 101, 'static'),
  ('GWP - Video', 102, 'video'),
  ('GIF', 103, 'static'),
  ('PNG frame (flat lay, e-comm) - single', 104, 'static'),
  ('PNG frame (flat lay, e-comm) - carousel', 105, 'static'),
  ('DPA', 106, 'static'),
  ('Price Strikethrough', 107, 'static'),
  ('Founder Video', 108, 'video'),
  ('EGC Video', 109, 'video'),
  ('UGC Video', 110, 'video'),
  ('BAU Video', 111, 'video'),
  ('Campaign Video', 112, 'video'),
  ('Other Video', 113, 'video')
ON CONFLICT (name) DO NOTHING;

-- Backfill: every concept_type carried over from the original proven_winners
-- seed (the one-time DO $$ block above) never got a format classification,
-- so it defaulted to NULL/Either -- correct for genuinely ambiguous names
-- (e.g. "Product Close Up", "Rug Try On"), but wrong for ones that say their
-- format right in the name (e.g. "Flatlay Photo", "Ecom Photo" showing up
-- while Format = Video is selected -- see B4). Same keyword classification
-- the PR #210 INSERT above already uses, applied retroactively; only ever
-- touches a still-NULL row, so a type someone has since classified by hand
-- is never overwritten.
UPDATE concept_types SET format = 'static' WHERE format IS NULL AND name ILIKE '%photo%';
UPDATE concept_types SET format = 'video' WHERE format IS NULL AND name ILIKE '%video%';

-- New vs Existing Concept, for Promotion Video Concept Development only:
-- whether Max needs to develop the strategic idea from scratch (The Idea +
-- Audience) or is producing an execution brief for a concept the team
-- already understands. Deliberately NOT concept_classification (that column
-- means "has this ad proven itself in market" and is wired to
-- assertCanEnterFilming's New Drop -> Filming bypass gate -- a different
-- axis, and this must never touch that gate). NULL for every Static
-- Promotion concept, every Core/High Stock/Drop concept, and every existing
-- row -- nothing outside the Promotion Video intake ever sets or reads
-- this column, so it's purely additive.
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS concept_origin VARCHAR(20)
  CHECK (concept_origin IN ('new', 'existing'));

-- Shooting's production status was too binary (Scheduled -> Shot in one
-- hidden click) -- see the Shoot Week/Scheduling brief, item 7. Adds
-- 'in_progress' as a genuine middle state between 'scheduled' and 'shot',
-- reusing this SAME existing shoot_schedule.status column/domain rather
-- than a new field -- the brief's own instruction to prefer existing
-- canonical state over schema expansion. 'in_progress' deliberately never
-- sets ready_for_editing (see shooting.js's /:id/start route) -- only
-- reaching 'shot' does, so a concept mid-shoot can never leak into Editing.
ALTER TABLE shoot_schedule DROP CONSTRAINT IF EXISTS shoot_schedule_status_check;
ALTER TABLE shoot_schedule ADD CONSTRAINT shoot_schedule_status_check
  CHECK (status IN ('unscheduled', 'scheduled', 'in_progress', 'shot'));

-- Editing was only ever a flat queue for the week -- see the Shoot Week/
-- Scheduling brief, item 8: it needs its own weekly calendar (Unscheduled +
-- Mon-Fri), separate from the shoot's own scheduled_week_start/scheduled_day
-- (a Concept shouldn't be assumed to be edited on the day it was filmed).
-- Reuses this SAME shoot_schedule row (already the one canonical row per
-- Concept's production lifecycle) rather than a new table, mirroring the
-- exact original_week_start/scheduled_week_start/scheduled_day shape
-- Shooting already has for its own calendar. Both stay NULL until the
-- Concept is actually marked Shot (see shooting.js's /:id/mark-shot, which
-- now also sets editing_original_week_start/editing_week_start to the
-- current week -- "enters Editing as Unscheduled", item 8) and are cleared
-- back to NULL by /:id/unmark-shot, so a Concept that's no longer
-- ready_for_editing leaves no stale calendar placement behind.
ALTER TABLE shoot_schedule ADD COLUMN IF NOT EXISTS editing_original_week_start DATE;
ALTER TABLE shoot_schedule ADD COLUMN IF NOT EXISTS editing_week_start DATE;
ALTER TABLE shoot_schedule ADD COLUMN IF NOT EXISTS editing_day VARCHAR(10)
  CHECK (editing_day IN ('monday', 'tuesday', 'wednesday', 'thursday', 'friday'));
CREATE INDEX IF NOT EXISTS idx_shoot_schedule_editing_week ON shoot_schedule(editing_week_start);

-- Final Approval: a genuine stage after Editing submits a Concept (see the
-- Editing-simplification/Final-Approval brief, item 11) -- reusing
-- editing_submitted_at as "awaiting a decision" (unchanged meaning) plus a
-- small decision record here, same shape as Tuesday Review's own
-- reviewed_at/review_feedback pair on the Concept Development side. Request
-- Changes clears editing_submitted_at (the Concept reappears in Editing's
-- normal queue, same final_edits row intact -- never a duplicate) and
-- records feedback; Approve stamps who/when and advances the Concept's
-- canonical `status` into the existing 'qc' Kanban stage if it hasn't
-- already reached it (see src/routes/finalApproval.js) -- the natural
-- holding stage for "approved, not yet uploaded" that already existed in
-- STATUSES, reused rather than inventing a new one. A future Ad Template /
-- Meta-preparation stage has a place to build from here (Kanban's own
-- qc -> uploaded_live progression); it is NOT built in this pass.
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS final_approval_status VARCHAR(20) NOT NULL DEFAULT 'pending'
  CHECK (final_approval_status IN ('pending', 'approved', 'changes_required'));
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS final_approval_feedback TEXT;
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS final_approved_at TIMESTAMPTZ;
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS final_approved_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_creative_assets_final_approval_status ON creative_assets(final_approval_status);

-- ---------------------------------------------------------------------------
-- Round 11: per-user module (sidebar tab) access, kept deliberately separate
-- from `role` (see the brief: "Role and module visibility should be
-- separate" -- role stays a default/category label only, still admin/
-- marketing/creative/viewer/lead/member, never itself checked for access).
-- Widened additively -- 'lead'/'member' are new values alongside the four
-- that already exist, nothing already stored changes meaning.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'marketing', 'creative', 'viewer', 'lead', 'member'));

-- Deny-list, not an allow-list -- this is the safe-default choice the brief
-- explicitly calls for (item 15): a user with zero rows here (every existing
-- account, and every brand-new one, until someone deliberately restricts
-- them) has full access to every module, so this migration can never lock
-- an existing account out of the app it could already fully use. module_key
-- matches index.html's tab-btn data-tab values 1:1 (dashboard, planning,
-- concept-dev, tuesday-review, shooting, editing, final-approval, board,
-- admin [Styles & Categories], reference-library, drops, promotions,
-- settings) so the frontend needs no second mapping table, and is a plain
-- VARCHAR rather than an FK to a modules table -- there's nothing else a
-- "modules" row would ever need to carry.
CREATE TABLE IF NOT EXISTS user_module_restrictions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_key VARCHAR(50) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, module_key)
);

-- One-time role correction for the five pre-existing seed accounts named in
-- the Round 11 brief's initial access matrix -- guarded by the OLD role
-- value ('creative', what seedUsersAndBackfill originally gave every
-- non-Brendan seed user), so this can only ever fire once per account and
-- can never clobber a role an admin has since changed by hand through the
-- new Settings user-management UI.
UPDATE users SET role = 'admin', updated_at = now() WHERE email = 'max@kohindustries.com' AND role = 'creative';
UPDATE users SET role = 'admin', updated_at = now() WHERE email = 'lucy@kohindustries.com' AND role = 'creative';
UPDATE users SET role = 'lead', updated_at = now() WHERE email = 'steve@kohindustries.com' AND role = 'creative';
UPDATE users SET role = 'lead', updated_at = now() WHERE email = 'sheridan@kohindustries.com' AND role = 'creative';
UPDATE users SET role = 'member', updated_at = now() WHERE email = 'mark@kohindustries.com' AND role = 'creative';

-- One-time restriction seed for Mark (the one named user in the initial
-- matrix who already existed before this round -- Tllestio/Ronit are brand
-- new accounts and get theirs seeded directly at creation time in
-- src/db.js's seedUsersAndBackfill instead, which needs no such guard since
-- it only ever runs once per account, at insert). Guarded by "Mark
-- currently has zero restriction rows" rather than a plain ON CONFLICT DO
-- NOTHING per-row insert, so that guard -- like the role correction above --
-- can only ever fire once: if an admin later removes even one of these
-- three via the Settings UI, this can never re-add it on a future deploy.
INSERT INTO user_module_restrictions (user_id, module_key)
SELECT u.id, m.module_key
FROM users u
CROSS JOIN (VALUES ('planning'), ('board'), ('admin')) AS m(module_key)
WHERE u.email = 'mark@kohindustries.com'
  AND NOT EXISTS (SELECT 1 FROM user_module_restrictions r WHERE r.user_id = u.id);

-- Production follow-up pass, item 2: 'manual' is a spontaneous/ad-hoc
-- concept started directly from Concept Development's own "+ New Concept"
-- button, with no Planning product/week required. Reuses the exact same
-- shoot_plan_items/creative_assets entity and POST /shoot-plan endpoint
-- every other source already uses -- see conceptDevelopment.js's GET /,
-- which extends its existing 'promotion' unconditional-current-week bypass
-- to also cover 'manual', so these never wait on someone confirming that
-- week's Shoot Plan in Planning, the same way a Promotion concept doesn't.
ALTER TABLE shoot_plan_items DROP CONSTRAINT IF EXISTS shoot_plan_items_source_check;
ALTER TABLE shoot_plan_items ADD CONSTRAINT shoot_plan_items_source_check
  CHECK (source IN ('core', 'high_stock', 'drop', 'promotion', 'manual'));

-- =====================================================================
-- Part C: Final Approval -> Ad Setup -> Approved (Meta ad structuring,
-- no Meta connection). Everything below is additive: new nullable
-- columns/tables only. Ad Setup progress is tracked with its OWN columns
-- (ad_setup_approved_at/by), the same "separate column, never widen an
-- existing CHECK" pattern already used for concept_dev_status and
-- EDITING_STATUSES -- creative_assets.final_approval_status keeps its
-- existing 3 values and existing meaning unchanged. "Approve Creative"
-- (Ready for Approval -> Ad Setup) is still just final_approval_status
-- turning 'approved', exactly as it already worked; this section only
-- adds the NEXT step, Ad Setup -> Approved.
-- =====================================================================

ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS ad_setup_approved_at TIMESTAMPTZ;
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS ad_setup_approved_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Batch numbering: sequential, stable once assigned, admin-correctable
-- starting point. next_ad_batch_number is read+incremented inside one
-- transaction when a batch is created (see routes/adSetup.js), so it's
-- concurrency-safe without a raw SEQUENCE object. Starts at 1; an admin
-- must correct this to the real current Meta batch number once, via
-- Settings, before the first live batch is created (there is no way to
-- know WNDRR's real current Meta batch number from inside this app).
ALTER TABLE planning_settings ADD COLUMN IF NOT EXISTS next_ad_batch_number INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS ad_batches (
  id SERIAL PRIMARY KEY,
  batch_number INTEGER NOT NULL,
  name VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (batch_number)
);

-- Copy Set: several creatives that share Product/Hook/offer/Promotion-stage
-- context can point at the SAME chosen copy instead of each generating its
-- own -- see ad_setups.copy_set_id. Deliberately minimal (one selected
-- Primary Text/Headline/CTA per set, no versioning) for this first pass.
CREATE TABLE IF NOT EXISTS ad_copy_sets (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  primary_text TEXT,
  headline TEXT,
  cta VARCHAR(30),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Sale sequential ad number: a monotonic counter PER (promotion_stage,
-- batch), never derived from MAX(existing rows) -- that would let a
-- deleted row's number get reissued to the next ad created, which the
-- brief explicitly rules out. Allocated once, atomically, via an
-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING in routes/adSetup.js.
CREATE TABLE IF NOT EXISTS ad_sale_sequence_counters (
  promotion_stage_id INTEGER NOT NULL REFERENCES promotion_stages(id) ON DELETE CASCADE,
  ad_batch_id INTEGER NOT NULL REFERENCES ad_batches(id) ON DELETE CASCADE,
  next_number INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (promotion_stage_id, ad_batch_id)
);

-- The structured Ad Setup record itself. One row per final_edits row (a
-- concept with several hook-variation final edits gets one Ad Setup each,
-- since each is a distinct piece of creative that needs its own Meta ad
-- name) -- UNIQUE(final_edit_id) makes entering Ad Setup for the same
-- final edit twice an idempotent no-op rather than a duplicate. Always
-- linked back to creative_asset_id (the canonical concept) and
-- final_edit_id (the canonical, already-approved final creative) --
-- neither is ever copied or re-uploaded here.
CREATE TABLE IF NOT EXISTS ad_setups (
  id SERIAL PRIMARY KEY,
  creative_asset_id INTEGER NOT NULL REFERENCES creative_assets(id) ON DELETE CASCADE,
  final_edit_id INTEGER NOT NULL UNIQUE REFERENCES final_edits(id) ON DELETE CASCADE,
  ad_batch_id INTEGER REFERENCES ad_batches(id) ON DELETE SET NULL,

  ad_category VARCHAR(20) NOT NULL DEFAULT 'core',
  ad_category_auto_detected BOOLEAN NOT NULL DEFAULT true,

  -- Meta naming fields (all structured/editable; the generated name string
  -- is assembled from these, never stored as free text so it can never
  -- drift out of sync -- see lib/adSetupNaming.js).
  week_no VARCHAR(20),
  ad_date DATE,
  product_label VARCHAR(255),
  product_type VARCHAR(100),
  hook_short VARCHAR(160),
  media_type VARCHAR(10),
  ad_type VARCHAR(20) NOT NULL DEFAULT 'single',
  creator_name VARCHAR(255),
  concept_label VARCHAR(255),
  url_link_page VARCHAR(20) NOT NULL DEFAULT 'product',
  destination_url TEXT,

  -- Sale/Promotion-only: which of the promotion's existing 4 stages this
  -- ad belongs to, plus its assigned sequential number within that
  -- stage+batch. NULL for every non-Promotion ad category.
  promotion_stage_id INTEGER REFERENCES promotion_stages(id) ON DELETE SET NULL,
  sale_sequence_number INTEGER,

  -- Copy: either copy_set_id points at a shared ad_copy_sets row (reused
  -- copy), or selected_primary_text/selected_headline/cta hold this ad's
  -- own selection from primary_text_options/headline_options (its
  -- AI-drafted -- rule/template-based, not a live external AI call --
  -- starting suggestions, regenerable, never auto-applied without the
  -- fields above supporting them).
  copy_set_id INTEGER REFERENCES ad_copy_sets(id) ON DELETE SET NULL,
  primary_text_options JSONB NOT NULL DEFAULT '[]',
  headline_options JSONB NOT NULL DEFAULT '[]',
  selected_primary_text TEXT,
  selected_headline TEXT,
  cta VARCHAR(30) NOT NULL DEFAULT 'shop_now',

  status VARCHAR(20) NOT NULL DEFAULT 'draft',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);

ALTER TABLE ad_setups DROP CONSTRAINT IF EXISTS ad_setups_ad_category_check;
ALTER TABLE ad_setups ADD CONSTRAINT ad_setups_ad_category_check
  CHECK (ad_category IN ('new_drop', 'core', 'promotion', 'organic_first'));
ALTER TABLE ad_setups DROP CONSTRAINT IF EXISTS ad_setups_media_type_check;
ALTER TABLE ad_setups ADD CONSTRAINT ad_setups_media_type_check
  CHECK (media_type IS NULL OR media_type IN ('image', 'video'));
ALTER TABLE ad_setups DROP CONSTRAINT IF EXISTS ad_setups_ad_type_check;
ALTER TABLE ad_setups ADD CONSTRAINT ad_setups_ad_type_check
  CHECK (ad_type IN ('single', 'carousel'));
ALTER TABLE ad_setups DROP CONSTRAINT IF EXISTS ad_setups_url_link_page_check;
ALTER TABLE ad_setups ADD CONSTRAINT ad_setups_url_link_page_check
  CHECK (url_link_page IN ('product', 'category', 'new_arrivals', 'home', 'sale_bundle', 'other'));
ALTER TABLE ad_setups DROP CONSTRAINT IF EXISTS ad_setups_cta_check;
ALTER TABLE ad_setups ADD CONSTRAINT ad_setups_cta_check
  CHECK (cta IN ('shop_now', 'sign_up', 'learn_more', 'shop_the_sale'));
ALTER TABLE ad_setups DROP CONSTRAINT IF EXISTS ad_setups_status_check;
ALTER TABLE ad_setups ADD CONSTRAINT ad_setups_status_check
  CHECK (status IN ('draft', 'approved'));

CREATE INDEX IF NOT EXISTS idx_ad_setups_creative_asset_id ON ad_setups(creative_asset_id);
CREATE INDEX IF NOT EXISTS idx_ad_setups_status ON ad_setups(status);
CREATE INDEX IF NOT EXISTS idx_ad_setups_ad_batch_id ON ad_setups(ad_batch_id);

-- Canonical multi-product linkage snapshot for an Ad Setup -- copied in
-- from shoot_plan_item_styles (the ONLY reliable multi-product source;
-- creative_assets.style_id is a stale first-colourway-only pointer) at
-- creation time, never the free-text Meta "Product" label. Future
-- analysis of an Ad Setup's product(s) must always join through here.
CREATE TABLE IF NOT EXISTS ad_setup_products (
  ad_setup_id INTEGER NOT NULL REFERENCES ad_setups(id) ON DELETE CASCADE,
  style_id INTEGER NOT NULL REFERENCES styles(id) ON DELETE CASCADE,
  PRIMARY KEY (ad_setup_id, style_id)
);

-- =====================================================================
-- Move Back (QA/testing + workflow correction): a controlled way to send
-- an existing concept back to an earlier pipeline stage without ever
-- creating a duplicate concept/shoot/final edit/Ad Setup record -- see
-- routes/moveBack.js. The only new structural bit this needs is a way to
-- mark a final_edits row inactive (a hook Tuesday Review no longer
-- confirms) without deleting it, since real editor work (link/notes)
-- may already be on it and rule 5 of the brief is "don't permanently
-- delete useful work unless it genuinely needs to be regenerated" --
-- defaults every existing row to active, so nothing already in
-- production changes visibility.
-- =====================================================================
ALTER TABLE final_edits ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

-- =====================================================================
-- Black Friday 2026 creative-style matrix, progress, ideas, and
-- inspiration library. Extends the EXISTING Promotion/Campaign Stage
-- system (promotions/promotion_stages/shoot_plan_items.promotion_stage_id)
-- rather than a parallel Black Friday application -- every table below is
-- generic (not literally "black_friday_*") so a future sale could reuse
-- the same structure, but only Black Friday 2026 is seeded/wired up in
-- this pass. All additive; nothing here alters or removes an existing
-- column, row, or table.
-- =====================================================================

-- The 14-row creative-style vocabulary the team's planning matrix uses
-- (Graphic tile, EGC Video, ...). A plain reference table, not an enum, so
-- the list itself stays editable without a migration later. media_type
-- drives Ad Setup's existing Media auto-detect the same way format already
-- does elsewhere -- never invented twice.
CREATE TABLE IF NOT EXISTS creative_styles (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  media_type VARCHAR(10) NOT NULL CHECK (media_type IN ('graphic', 'video')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO creative_styles (name, media_type, sort_order) VALUES
  ('Graphic tile', 'graphic', 0),
  ('GWP/Giveaway - Graphic', 'graphic', 1),
  ('GWP/Giveaway - Video', 'video', 2),
  ('GIF', 'graphic', 3),
  ('PNG frame (flat lay, e-comm) - single/carousel', 'graphic', 4),
  ('Product Focused Video', 'video', 5),
  ('DPA', 'graphic', 6),
  ('Price Strikethrough', 'graphic', 7),
  ('Founder Video', 'video', 8),
  ('EGC Video', 'video', 9),
  ('UGC Video', 'video', 10),
  ('BAU Video', 'video', 11),
  ('Campaign Video', 'video', 12),
  ('Other Video (eg. Humour, TikTok)', 'video', 13)
ON CONFLICT (name) DO NOTHING;

-- The target matrix itself: how many of a given Creative Style are
-- required in a given Campaign Stage, for a given Promotion. Structured
-- data (per the brief: "target definitions should be structured data, not
-- hardcoded all through the frontend"), one row per non-zero cell -- a
-- missing (promotion_stage_id, creative_style_id) pair simply means 0
-- required, so a stage/style combo with no requirement never needs an
-- explicit zero row.
CREATE TABLE IF NOT EXISTS promotion_creative_targets (
  id SERIAL PRIMARY KEY,
  promotion_id INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  promotion_stage_id INTEGER NOT NULL REFERENCES promotion_stages(id) ON DELETE CASCADE,
  creative_style_id INTEGER NOT NULL REFERENCES creative_styles(id) ON DELETE CASCADE,
  required_count INTEGER NOT NULL DEFAULT 0 CHECK (required_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (promotion_stage_id, creative_style_id)
);
CREATE INDEX IF NOT EXISTS idx_promotion_creative_targets_promotion_id ON promotion_creative_targets(promotion_id);

-- A planning record ("2026 idea") -- What/Who/Where/Script/Need from the
-- team's spreadsheet, plus the two links that make it real: promotion_stage_id
-- + creative_style_id (which drive the progress counters below) and
-- linked_creative_asset_id, the STABLE id of the real creative_assets row
-- once this idea is sent into (or matched against) the existing pipeline --
-- never a second/duplicate creative record. Lifecycle status is
-- deliberately NOT a stored column here: it's derived at read time from
-- the linked concept's own real pipeline state (concept_dev_status/
-- shoot_schedule/editing_submitted_at/final_approval_status), same
-- "progress is derived, not manually maintained" rule as the rest of this
-- app's coverage counters.
CREATE TABLE IF NOT EXISTS promotion_creative_ideas (
  id SERIAL PRIMARY KEY,
  promotion_id INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  promotion_stage_id INTEGER REFERENCES promotion_stages(id) ON DELETE SET NULL,
  creative_style_id INTEGER REFERENCES creative_styles(id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL,
  who VARCHAR(255),
  where_text VARCHAR(255),
  concept_script TEXT,
  need_text TEXT,
  reference_note TEXT,
  linked_creative_asset_id INTEGER REFERENCES creative_assets(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_promotion_creative_ideas_promotion_id ON promotion_creative_ideas(promotion_id);
CREATE INDEX IF NOT EXISTS idx_promotion_creative_ideas_linked_asset ON promotion_creative_ideas(linked_creative_asset_id);

-- Previous Winning Ads / Inspiration Library -- deliberately its own table,
-- separate from promotion_creative_ideas and from reference_library (that
-- one is a generic "reference for a new idea" list without the
-- structured campaign/style/video-preview needs here). A historical
-- record only, never itself a production job -- nothing in this app ever
-- creates a shoot_plan_items/creative_assets row from one of these.
CREATE TABLE IF NOT EXISTS creative_inspiration (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  campaign_name VARCHAR(255),
  creative_style_id INTEGER REFERENCES creative_styles(id) ON DELETE SET NULL,
  media_type VARCHAR(10) CHECK (media_type IS NULL OR media_type IN ('graphic', 'video')),
  video_url TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Many-to-many: a 2026 idea can point at more than one previous winning ad
-- ("this is why we're doing it"), and the same winning ad can inspire more
-- than one new idea. Both sides use their own stable id, per the brief.
CREATE TABLE IF NOT EXISTS promotion_creative_idea_inspirations (
  promotion_creative_idea_id INTEGER NOT NULL REFERENCES promotion_creative_ideas(id) ON DELETE CASCADE,
  creative_inspiration_id INTEGER NOT NULL REFERENCES creative_inspiration(id) ON DELETE CASCADE,
  PRIMARY KEY (promotion_creative_idea_id, creative_inspiration_id)
);

-- ---------------------------------------------------------------------
-- Black Friday 2026: the old 20/30/25/8 (total 83) targets are obsolete,
-- replaced with 35/50/75/20 (total 180) -- see the brief. Guarded by the
-- OLD known value on each stage (same "only correct it if it's still
-- exactly the seeded default" idiom the Hype/Mid Sale Offers rename above
-- already uses), so this can only ever fire once per stage and can never
-- clobber a required_count an admin has since edited by hand.
-- ---------------------------------------------------------------------
UPDATE promotion_stages ps SET required_count = 35, updated_at = now()
FROM promotions p WHERE p.id = ps.promotion_id AND p.name = 'Black Friday 2026'
  AND ps.name = 'Hype Ads' AND ps.required_count = 20;
UPDATE promotion_stages ps SET required_count = 50, updated_at = now()
FROM promotions p WHERE p.id = ps.promotion_id AND p.name = 'Black Friday 2026'
  AND ps.name = 'Sale Live Ads' AND ps.required_count = 30;
UPDATE promotion_stages ps SET required_count = 75, updated_at = now()
FROM promotions p WHERE p.id = ps.promotion_id AND p.name = 'Black Friday 2026'
  AND ps.name = 'Mid Sale Offers Ads' AND ps.required_count = 25;
UPDATE promotion_stages ps SET required_count = 20, updated_at = now()
FROM promotions p WHERE p.id = ps.promotion_id AND p.name = 'Black Friday 2026'
  AND ps.name = 'Last Chance / Ends Today' AND ps.required_count = 8;

-- Black Friday 2026's creative-style matrix (29 non-zero cells, columns
-- sum to 35/50/75/20 = 180 total -- see the brief). Resolved by name
-- lookup against the promotion/stage/style rows seeded above, so this
-- never hardcodes an id; ON CONFLICT keeps it idempotent (a redeploy, or
-- this file running again, never duplicates or resets a value an admin
-- has since edited).
DO $$
DECLARE
  bf_id INTEGER;
BEGIN
  SELECT id INTO bf_id FROM promotions WHERE name = 'Black Friday 2026';
  IF bf_id IS NOT NULL THEN
    INSERT INTO promotion_creative_targets (promotion_id, promotion_stage_id, creative_style_id, required_count)
    SELECT bf_id, ps.id, cs.id, v.required_count
    FROM (VALUES
      ('Hype Ads', 'Graphic tile', 6),
      ('Sale Live Ads', 'Graphic tile', 12),
      ('Mid Sale Offers Ads', 'Graphic tile', 8),
      ('Last Chance / Ends Today', 'Graphic tile', 8),
      ('Hype Ads', 'GWP/Giveaway - Graphic', 5),
      ('Sale Live Ads', 'GWP/Giveaway - Graphic', 4),
      ('Hype Ads', 'GWP/Giveaway - Video', 5),
      ('Sale Live Ads', 'GWP/Giveaway - Video', 6),
      ('Mid Sale Offers Ads', 'GIF', 4),
      ('Mid Sale Offers Ads', 'PNG frame (flat lay, e-comm) - single/carousel', 15),
      ('Hype Ads', 'Product Focused Video', 4),
      ('Sale Live Ads', 'Product Focused Video', 6),
      ('Mid Sale Offers Ads', 'Product Focused Video', 6),
      ('Mid Sale Offers Ads', 'DPA', 3),
      ('Mid Sale Offers Ads', 'Price Strikethrough', 15),
      ('Hype Ads', 'Founder Video', 3),
      ('Sale Live Ads', 'Founder Video', 4),
      ('Mid Sale Offers Ads', 'Founder Video', 4),
      ('Last Chance / Ends Today', 'Founder Video', 4),
      ('Hype Ads', 'EGC Video', 6),
      ('Sale Live Ads', 'EGC Video', 12),
      ('Mid Sale Offers Ads', 'EGC Video', 6),
      ('Last Chance / Ends Today', 'EGC Video', 8),
      ('Hype Ads', 'UGC Video', 4),
      ('Mid Sale Offers Ads', 'UGC Video', 4),
      ('Mid Sale Offers Ads', 'BAU Video', 10),
      ('Sale Live Ads', 'Campaign Video', 2),
      ('Hype Ads', 'Other Video (eg. Humour, TikTok)', 2),
      ('Sale Live Ads', 'Other Video (eg. Humour, TikTok)', 4)
    ) AS v(stage_name, style_name, required_count)
    JOIN promotion_stages ps ON ps.promotion_id = bf_id AND ps.name = v.stage_name
    JOIN creative_styles cs ON cs.name = v.style_name
    ON CONFLICT (promotion_stage_id, creative_style_id) DO NOTHING;
  END IF;
END $$;

-- =====================================================================
-- Black Friday 2026 follow-up: master idea -> stage executions, and real
-- 2026 planning-sheet data. The same creative idea (eg. "Car talk
-- through") legitimately runs across more than one Black Friday phase
-- with the same underlying footage/design, so promotion_creative_ideas is
-- now the MASTER creative record (concept/footage/who/where/inspo) and
-- each phase it runs in gets its own row here -- this is what the
-- 180-target progress counters count against, never the master idea
-- itself (one master idea used in 3 stages = 3 planned pieces, not 1).
-- Additive only: the master idea's own promotion_stage_id/
-- creative_style_id/linked_creative_asset_id columns are left in place
-- (never dropped) for backward data compatibility, and every existing row
-- that already used them is migrated into one matching execution row
-- below so nothing already in production is lost; new code reads/writes
-- exclusively through this table from here on.
-- =====================================================================
CREATE TABLE IF NOT EXISTS promotion_creative_idea_executions (
  id SERIAL PRIMARY KEY,
  promotion_creative_idea_id INTEGER NOT NULL REFERENCES promotion_creative_ideas(id) ON DELETE CASCADE,
  promotion_stage_id INTEGER NOT NULL REFERENCES promotion_stages(id) ON DELETE CASCADE,
  -- NULL = "Needs Classification" (the brief's own term) -- never guessed.
  creative_style_id INTEGER REFERENCES creative_styles(id) ON DELETE SET NULL,
  -- NULL = inherit the master idea's shared linked_creative_asset_id (the
  -- default -- "do not create three identical shoot jobs"); set only when
  -- the team deliberately produces a separate version for this one stage.
  linked_creative_asset_id INTEGER REFERENCES creative_assets(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (promotion_creative_idea_id, promotion_stage_id)
);
CREATE INDEX IF NOT EXISTS idx_pci_executions_idea_id ON promotion_creative_idea_executions(promotion_creative_idea_id);
CREATE INDEX IF NOT EXISTS idx_pci_executions_stage_id ON promotion_creative_idea_executions(promotion_stage_id);
CREATE INDEX IF NOT EXISTS idx_pci_executions_linked_asset ON promotion_creative_idea_executions(linked_creative_asset_id);

-- One-time-per-row, idempotent backfill: every existing idea that already
-- had a single stage/style/asset assigned (the pre-this-migration shape)
-- gets exactly one matching execution row. ON CONFLICT means an idea that
-- already has that execution (from a previous run of this file, or
-- created fresh through the new multi-stage API) is never touched again.
INSERT INTO promotion_creative_idea_executions (promotion_creative_idea_id, promotion_stage_id, creative_style_id, linked_creative_asset_id)
SELECT id, promotion_stage_id, creative_style_id, linked_creative_asset_id
FROM promotion_creative_ideas
WHERE promotion_stage_id IS NOT NULL
ON CONFLICT (promotion_creative_idea_id, promotion_stage_id) DO NOTHING;

-- Stable spreadsheet row identity so importing the team's planning sheet is
-- idempotent (re-running this file never creates a duplicate master idea)
-- and safely re-runnable later if a row is added. NULL for any idea
-- created by hand in the app. source_label is the human-readable version
-- shown nowhere except a detail view -- never the raw key.
ALTER TABLE promotion_creative_ideas ADD COLUMN IF NOT EXISTS source_key VARCHAR(64) UNIQUE;
ALTER TABLE promotion_creative_ideas ADD COLUMN IF NOT EXISTS source_label VARCHAR(255);

-- Video/Graphic now lives on the MASTER idea (an idea's medium doesn't
-- change per stage), separate from any one execution's creative_style_id
-- classification -- which may be null ("Needs Classification") even
-- though the idea's medium is always known. Backfilled once from the
-- legacy single creative_style_id for any idea that predates this column;
-- guarded by "only if still NULL" so it can never overwrite a value the
-- import below (or a human) has since set.
ALTER TABLE promotion_creative_ideas ADD COLUMN IF NOT EXISTS media_type VARCHAR(10) CHECK (media_type IS NULL OR media_type IN ('graphic', 'video'));
UPDATE promotion_creative_ideas pci SET media_type = cs.media_type
FROM creative_styles cs WHERE cs.id = pci.creative_style_id AND pci.media_type IS NULL;

-- ---------------------------------------------------------------------
-- Real Black Friday 2026 planning-sheet data: the VIDEO IDEAS 2026 and
-- GRAPHIC IDEAS 2026 tabs of the team's "WNDRR Black Friday Sale 2026 -
-- ad ideas" sheet, imported verbatim -- no invented ideas. Each row below
-- is a MASTER idea; a follow-up INSERT creates its real stage executions
-- (a master used across N stages becomes N planned pieces, matching how
-- the sheet itself marks ideas like "Hype/Live/last chance"). Style
-- classification only applied where reasonably unambiguous from the
-- sheet's own idea name/description -- everything else is left NULL
-- ("Needs Classification") for the team to correct, never guessed. The
-- sheet's "TOP ADS FROM PREVIOUS SALES" tab (historical Inspiration
-- Library import) is NOT included here -- that data was not available at
-- implementation time; see the accompanying report.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  bf_id INTEGER;
BEGIN
  SELECT id INTO bf_id FROM promotions WHERE name = 'Black Friday 2026';
  IF bf_id IS NOT NULL THEN
    INSERT INTO promotion_creative_ideas (promotion_id, source_key, source_label, media_type, title, who, where_text, concept_script, reference_note, created_by_user_id)
    SELECT bf_id, v.source_key, 'Black Friday 2026 Planning Sheet', v.media_type, v.title, v.who, v.where_text, v.concept_script, v.reference_note, NULL
    FROM (VALUES
      ('bf2026-video-1', 'video', 'Green screen - top picks', 'Mark', 'Office', NULL::text, 'https://fb.me/adspreview/facebook/1VCTklXnOho27py'),
      ('bf2026-video-2', 'video', 'Green screen - sale details', 'Mark', 'Office', NULL::text, 'https://fb.me/adspreview/facebook/27xjj23NsmwJEwt'),
      ('bf2026-video-3', 'video', 'Couch - sale details talk through', 'Steve', 'Office', NULL::text, 'https://fb.me/adspreview/facebook/1Sm7nXcgcP6F8do'),
      ('bf2026-video-4', 'video', 'Green screen - rage bait', 'Mark', 'Office', NULL::text, 'https://fb.me/adspreview/facebook/22VaQ6XxTJmNBn4'),
      ('bf2026-video-5', 'video', 'Flat lay - array of products', 'Mark', 'Office', NULL::text, 'https://fb.me/adspreview/facebook/22RcgDnYKWptBIs'),
      ('bf2026-video-6', 'video', 'Car talk through', 'Steve', 'Car', NULL::text, 'https://fb.me/adspreview/facebook/1VZOTtBHaIQ21PK'),
      ('bf2026-video-7', 'video', 'Roll bar top picks', 'Mark, Steve', 'Office', NULL::text, 'https://fb.me/adspreview/facebook/21Z8alfx1ZV2S4Z'),
      ('bf2026-video-8', 'video', 'Poster drop', 'Shez', 'Warehouse', NULL::text, 'https://fb.me/adspreview/facebook/1VwBSHLuNJvoeGU'),
      ('bf2026-video-9', 'video', 'Warehouse talk through', 'Steve / Mark', 'Warehouse', NULL::text, 'https://fb.me/adspreview/facebook/1ZjffsTKz719Dcx'),
      ('bf2026-video-10', 'video', 'Founder/EGC warehouse talk through', 'Steve, warehouse team', 'Warehouse', NULL::text, 'https://fb.me/adspreview/facebook/1VfFfJVsd6ck5mL'),
      ('bf2026-video-11', 'video', 'Shock value (eg. forklift and gym accident)', 'Max, Steve, Mark', 'Warehouse', NULL::text, E'https://fb.me/adspreview/facebook/2a3gYFQIc3Q7vqb\nhttps://fb.me/adspreview/facebook/2jraB8Hp88wloQ5'),
      ('bf2026-video-12', 'video', 'BF Campaign', 'Steve', 'Off-site', NULL::text, 'https://fb.me/adspreview/facebook/28XsA6HoZaCnMpK'),
      ('bf2026-video-13', 'video', 'GWP couch talk through', 'Mark, Steve', 'Office', NULL::text, 'https://fb.me/adspreview/facebook/2iSOyatgZQ9GCzw'),
      ('bf2026-video-14', 'video', 'Flat lay BAU (sale edition)', 'Shez', 'Office', NULL::text, 'https://fb.me/adspreview/facebook/23yywEbk8knSnr2'),
      ('bf2026-video-15', 'video', 'What $X can get you', 'Mark', 'Office', NULL::text, 'https://fb.me/adspreview/facebook/27SXiLusVGCuqqd'),
      ('bf2026-video-16', 'video', 'Secret envelope', 'Mark, Steve', 'Office', 'Passing Steve or Mark an envelope in different situations, such as through a car window or dropping it on a desk. At the end of the video they pull out the graphic showing it is the Black Friday sale. Suspenseful and builds hype.', NULL::text),
      ('bf2026-video-17', 'video', 'Flyer video', 'Mark', 'Office', 'Short clips of sticking flyers on poles, putting them on car windows, etc.', NULL::text),
      ('bf2026-video-18', 'video', 'UGC content', NULL, NULL, 'UGC creator promoting what can be purchased during the sale.', NULL::text),
      ('bf2026-video-19', 'video', 'Stencil graffiti', 'Steve, Mark', NULL, NULL::text, 'https://www.instagram.com/reel/DQs4Gv7E-aT/?stkn=MWZlaWE0ZjJqbXNtMw=='),
      ('bf2026-video-20', 'video', 'Snipping ribbon in front of computer screen to indicate sale is live', 'Mark', NULL, NULL::text, NULL::text),
      ('bf2026-graphic-1', 'graphic', 'GWP with offer', 'Til', NULL, NULL::text, 'https://fb.me/adspreview/facebook/2ivpLIxsKNotBtX'),
      ('bf2026-graphic-2', 'graphic', 'Sale offer', 'Til', NULL, NULL::text, E'https://fb.me/adspreview/facebook/23cEP8FFDAYslMS\nhttps://fb.me/adspreview/facebook/27ndGrXMuPpzlOB'),
      ('bf2026-graphic-3', 'graphic', 'Apology statement', 'Til', NULL, NULL::text, 'https://fb.me/adspreview/facebook/1SIAFq5PExTU0Ur'),
      ('bf2026-graphic-4', 'graphic', 'Ugly ad carousel', 'Til', NULL, NULL::text, 'https://fb.me/adspreview/facebook/21KXM5VEgIbwGyC'),
      ('bf2026-graphic-5', 'graphic', 'AI poster drop - using real footage', 'Til, Shez', NULL, NULL::text, 'https://fb.me/adspreview/facebook/yBpjtyXM1IXsW12'),
      ('bf2026-graphic-6', 'graphic', 'Notes app', 'Shez', NULL, NULL::text, 'https://fb.me/adspreview/facebook/1WOA5MYBYejFqwd')
    ) AS v(source_key, media_type, title, who, where_text, concept_script, reference_note)
    ON CONFLICT (source_key) DO NOTHING;

    INSERT INTO promotion_creative_idea_executions (promotion_creative_idea_id, promotion_stage_id, creative_style_id)
    SELECT pci.id, ps.id, cs.id
    FROM (VALUES
      ('bf2026-video-1', 'Hype Ads', 'EGC Video'),
      ('bf2026-video-1', 'Sale Live Ads', 'EGC Video'),
      ('bf2026-video-2', 'Hype Ads', 'EGC Video'),
      ('bf2026-video-2', 'Sale Live Ads', 'EGC Video'),
      ('bf2026-video-3', 'Hype Ads', 'Founder Video'),
      ('bf2026-video-4', 'Sale Live Ads', 'Other Video (eg. Humour, TikTok)'),
      ('bf2026-video-5', 'Sale Live Ads', 'Product Focused Video'),
      ('bf2026-video-5', 'Last Chance / Ends Today', 'Product Focused Video'),
      ('bf2026-video-6', 'Hype Ads', 'Founder Video'),
      ('bf2026-video-6', 'Sale Live Ads', 'Founder Video'),
      ('bf2026-video-6', 'Last Chance / Ends Today', 'Founder Video'),
      ('bf2026-video-7', 'Hype Ads', NULL),
      ('bf2026-video-7', 'Mid Sale Offers Ads', NULL),
      ('bf2026-video-8', 'Hype Ads', NULL),
      ('bf2026-video-8', 'Sale Live Ads', NULL),
      ('bf2026-video-9', 'Sale Live Ads', NULL),
      ('bf2026-video-9', 'Last Chance / Ends Today', NULL),
      ('bf2026-video-10', 'Hype Ads', NULL),
      ('bf2026-video-11', 'Sale Live Ads', 'Other Video (eg. Humour, TikTok)'),
      ('bf2026-video-12', 'Sale Live Ads', 'Campaign Video'),
      ('bf2026-video-13', 'Sale Live Ads', 'GWP/Giveaway - Video'),
      ('bf2026-video-14', 'Mid Sale Offers Ads', 'BAU Video'),
      ('bf2026-video-15', 'Sale Live Ads', 'Product Focused Video'),
      ('bf2026-video-16', 'Hype Ads', NULL),
      ('bf2026-video-16', 'Sale Live Ads', NULL),
      ('bf2026-video-17', 'Hype Ads', NULL),
      ('bf2026-video-17', 'Sale Live Ads', NULL),
      ('bf2026-video-18', 'Hype Ads', 'UGC Video'),
      ('bf2026-video-18', 'Sale Live Ads', 'UGC Video'),
      ('bf2026-video-19', 'Hype Ads', NULL),
      ('bf2026-video-19', 'Sale Live Ads', NULL),
      ('bf2026-video-20', 'Sale Live Ads', NULL),
      ('bf2026-graphic-1', 'Hype Ads', 'GWP/Giveaway - Graphic'),
      ('bf2026-graphic-2', 'Hype Ads', 'Graphic tile'),
      ('bf2026-graphic-2', 'Sale Live Ads', 'Graphic tile'),
      ('bf2026-graphic-3', 'Hype Ads', NULL),
      ('bf2026-graphic-3', 'Sale Live Ads', NULL),
      ('bf2026-graphic-4', 'Mid Sale Offers Ads', NULL),
      ('bf2026-graphic-5', 'Hype Ads', NULL),
      ('bf2026-graphic-6', 'Hype Ads', NULL),
      ('bf2026-graphic-6', 'Sale Live Ads', NULL),
      ('bf2026-graphic-6', 'Last Chance / Ends Today', NULL)
    ) AS v(source_key, stage_name, style_name)
    JOIN promotion_creative_ideas pci ON pci.source_key = v.source_key
    JOIN promotion_stages ps ON ps.promotion_id = bf_id AND ps.name = v.stage_name
    LEFT JOIN creative_styles cs ON cs.name = v.style_name
    ON CONFLICT (promotion_creative_idea_id, promotion_stage_id) DO NOTHING;
  END IF;
END $$;

-- =====================================================================
-- Black Friday 2026 follow-up: real "TOP ADS FROM PREVIOUS SALES" data
-- into the existing Inspiration Library, linked to the 2026 ideas they
-- inspired where the connection is clear from title/creator/reference URL
-- -- never a duplicate inspiration row for a creative reused across
-- stages (the sheet's own multi-stage labels, eg. "Hype / Live", are kept
-- as one row's sale_stage_note, exactly like the 2026 import's multi-stage
-- master ideas). All additive: no existing inspiration/idea/link row is
-- ever altered or removed by this block.
-- =====================================================================
ALTER TABLE creative_inspiration ADD COLUMN IF NOT EXISTS creator VARCHAR(255);
ALTER TABLE creative_inspiration ADD COLUMN IF NOT EXISTS sale_stage_note VARCHAR(255);
-- Extra reference URLs beyond the primary video_url (which drives the
-- single provider-aware preview/play button) -- newline-separated, shown
-- as additional "Open Original" links rather than silently dropped.
ALTER TABLE creative_inspiration ADD COLUMN IF NOT EXISTS additional_urls TEXT;
ALTER TABLE creative_inspiration ADD COLUMN IF NOT EXISTS source_key VARCHAR(64) UNIQUE;
ALTER TABLE creative_inspiration ADD COLUMN IF NOT EXISTS source_label VARCHAR(255);
-- A small number of historical ads are genuinely both ("AI poster drop -
-- using real footage": Graphic + Video) -- loosens the existing
-- graphic/video-only check rather than forcing one or the other.
ALTER TABLE creative_inspiration DROP CONSTRAINT IF EXISTS creative_inspiration_media_type_check;
ALTER TABLE creative_inspiration ADD CONSTRAINT creative_inspiration_media_type_check
  CHECK (media_type IS NULL OR media_type IN ('graphic', 'video', 'mixed'));

INSERT INTO creative_inspiration (source_key, source_label, campaign_name, sale_stage_note, media_type, creator, title, video_url, additional_urls, created_by_user_id)
SELECT v.source_key, 'Black Friday 2026 Planning Sheet', v.campaign_name, v.sale_stage_note, v.media_type, v.creator, v.title, v.video_url, v.additional_urls, NULL
FROM (VALUES
  ('hist-winter26-01', 'Winter Sale 2026', 'Hype', 'graphic', 'Til', 'Backpack with offer', 'https://fb.me/adspreview/facebook/2ivpLIxsKNotBtX', NULL::text),
  ('hist-winter26-02', 'Winter Sale 2026', 'Hype / Live', 'graphic', 'Til', 'Offer - snow on landcruiser (AI)', 'https://fb.me/adspreview/facebook/23cEP8FFDAYslMS', NULL::text),
  ('hist-winter26-03', 'Winter Sale 2026', 'Hype', 'video', 'Mark', 'Green screen - 50% off products', 'https://fb.me/adspreview/facebook/1VCTklXnOho27py', NULL::text),
  ('hist-winter26-04', 'Winter Sale 2026', 'Hype', 'video', 'Mark', 'Green screen - sale details', 'https://fb.me/adspreview/facebook/27xjj23NsmwJEwt', NULL::text),
  ('hist-winter26-05', 'Winter Sale 2026', 'Hype', 'graphic', 'Til', 'Sale offer', 'https://fb.me/adspreview/facebook/27ndGrXMuPpzlOB', NULL::text),
  ('hist-winter26-06', 'Winter Sale 2026', 'Hype', 'video', 'Steve', 'Couch - sale details talk through', 'https://fb.me/adspreview/facebook/1Sm7nXcgcP6F8do', NULL::text),
  ('hist-winter26-07', 'Winter Sale 2026', 'Live', 'graphic', 'Til', 'Apology statement', 'https://fb.me/adspreview/facebook/1SIAFq5PExTU0Ur', NULL::text),
  ('hist-winter26-08', 'Winter Sale 2026', 'Live', 'video', 'Mark', 'Green screen - rage bait comment', 'https://fb.me/adspreview/facebook/22VaQ6XxTJmNBn4', NULL::text),
  ('hist-winter26-09', 'Winter Sale 2026', 'Live', 'video', 'Mark', 'Flat lay - 50% offer', 'https://fb.me/adspreview/facebook/22RcgDnYKWptBIs', NULL::text),
  ('hist-winter26-10', 'Winter Sale 2026', 'Live', 'video', 'Steve', 'Car talk through', 'https://fb.me/adspreview/facebook/1VZOTtBHaIQ21PK', NULL::text),
  ('hist-winter26-11', 'Winter Sale 2026', 'Live', 'video', 'Steve', 'Couch - GWP talk through', 'https://fb.me/adspreview/facebook/268OSrIEkHATtOP', NULL::text),
  ('hist-winter26-12', 'Winter Sale 2026', 'Live', 'video', 'Mark', 'Green screen - top picks', 'https://fb.me/adspreview/facebook/2afk1UOg57bLbpe', NULL::text),
  ('hist-winter26-13', 'Winter Sale 2026', 'Live', 'graphic', 'Til', 'Sale offer', 'https://fb.me/adspreview/facebook/278F7dnHLAUULTS', NULL::text),
  ('hist-winter26-14', 'Winter Sale 2026', 'Mid Sale', 'graphic', 'Til', 'Ugly ad carousel', NULL::text, NULL::text),
  ('hist-winter26-15', 'Winter Sale 2026', 'Last Chance', 'video', 'Mark', 'Flat lay - array of products', 'https://fb.me/adspreview/facebook/2lkpzYgWaI2SOzU', NULL::text),
  ('hist-winter26-16', 'Winter Sale 2026', 'Last Chance', 'video', 'Mark', 'Roll bar talk through', 'https://fb.me/adspreview/facebook/21Z8alfx1ZV2S4Z', NULL::text),
  ('hist-bday26-01', 'Birthday Sale 2026', 'Hype', 'graphic', 'Til', 'Apology statement', 'https://fb.me/adspreview/facebook/2ncMOwgbfamtW44', NULL::text),
  ('hist-bday26-02', 'Birthday Sale 2026', 'Hype', 'mixed', 'Til / Shez', 'AI poster drop - using real footage', 'https://fb.me/adspreview/facebook/yBpjtyXM1IXsW12', NULL::text),
  ('hist-bday26-03', 'Birthday Sale 2026', 'Hype', 'video', 'Shez', 'GWP concrete flat lay', 'https://fb.me/adspreview/facebook/2iSzn6WoY8nBOiI', NULL::text),
  ('hist-bday26-04', 'Birthday Sale 2026', 'Hype / Live / Last Chance', 'video', 'Steve', 'Car talk through - sale details', 'https://fb.me/adspreview/facebook/2d4hse6qjTY1H9m', E'https://fb.me/adspreview/facebook/1VwBSHLuNJvoeGU\nhttps://fb.me/adspreview/facebook/26bWn6LPKqTNeht'),
  ('hist-bday26-05', 'Birthday Sale 2026', 'Hype / Mid Sale', 'video', 'James', 'Roll bar with try on - top picks', 'https://fb.me/adspreview/facebook/2gg8dKbXFvhzfG0', NULL::text),
  ('hist-bday26-06', 'Birthday Sale 2026', 'Hype', 'video', 'Shez', 'Poster drop', 'https://fb.me/adspreview/facebook/1VwBSHLuNJvoeGU', NULL::text),
  ('hist-bday26-07', 'Birthday Sale 2026', 'Live', 'graphic', 'Til', 'Ugly ad carousel', 'https://fb.me/adspreview/facebook/21KXM5VEgIbwGyC', NULL::text),
  ('hist-bday26-08', 'Birthday Sale 2026', 'Live', 'video', 'Steve', 'Warehouse talk through', 'https://fb.me/adspreview/facebook/1ZjffsTKz719Dcx', NULL::text),
  ('hist-bday26-09', 'Birthday Sale 2026', 'Live', 'graphic', 'Til', 'Sale offer', 'https://fb.me/adspreview/facebook/1W6j85AtISfeBTd', NULL::text),
  ('hist-bday26-10', 'Birthday Sale 2026', 'Mid Sale', 'video', 'James', 'Green screen - top picks', 'https://fb.me/adspreview/facebook/ySH3Yu8Dr932fLi', NULL::text),
  ('hist-bday26-11', 'Birthday Sale 2026', 'Last Chance', 'graphic', 'Shez', 'Notes app', 'https://fb.me/adspreview/facebook/1WOA5MYBYejFqwd', NULL::text),
  ('hist-bf25-01', 'Black Friday 2025', 'Hype', 'video', 'Fiverr', 'AI poster drop - with real footage', 'https://fb.me/adspreview/facebook/2aGyrXETwblpmWF', NULL::text),
  ('hist-bf25-02', 'Black Friday 2025', 'Hype', 'video', 'Shez', 'Poster drop', 'https://fb.me/adspreview/facebook/26UVSQQTzKW30aK', NULL::text),
  ('hist-bf25-03', 'Black Friday 2025', 'Hype', 'video', 'Shez', 'Facebook comments with graphic', 'https://fb.me/adspreview/facebook/1VvBbVokItUyF8p', NULL::text),
  ('hist-bf25-04', 'Black Friday 2025', 'Hype', 'video', 'Steve, warehouse team', 'Founder/EGC warehouse talkthrough', 'https://fb.me/adspreview/facebook/1VfFfJVsd6ck5mL', NULL::text),
  ('hist-bf25-05', 'Black Friday 2025', 'Live', 'graphic', 'Jake', 'Ugly carousel', 'https://fb.me/adspreview/facebook/2bSYVPJcBbyE511', NULL::text),
  ('hist-bf25-06', 'Black Friday 2025', 'Live', 'video', 'Fiverr', 'AI Poster drop - with real footage', 'https://fb.me/adspreview/facebook/1Vm26vul8sbZjrA', NULL::text),
  ('hist-bf25-07', 'Black Friday 2025', 'Live / Last Chance', 'graphic', 'Shez', 'Notes app', 'https://fb.me/adspreview/facebook/24Y4rhYBriJAV7N', 'https://fb.me/adspreview/facebook/2jvV4PvfNgipQs3'),
  ('hist-bf25-08', 'Black Friday 2025', 'Live', 'graphic', 'Jake', 'Sale offer', 'https://fb.me/adspreview/facebook/2b2sKVylDxyEJIy', NULL::text),
  ('hist-bf25-09', 'Black Friday 2025', 'Live', 'video', 'Max', 'Forklift accident', 'https://fb.me/adspreview/facebook/2a3gYFQIc3Q7vqb', NULL::text),
  ('hist-bf25-10', 'Black Friday 2025', 'Live', 'video', 'Steve', 'Gym accident', 'https://fb.me/adspreview/facebook/2jraB8Hp88wloQ5', NULL::text),
  ('hist-bf25-11', 'Black Friday 2025', 'Live', 'video', 'Steve', 'Campaign', 'https://fb.me/adspreview/facebook/28XsA6HoZaCnMpK', NULL::text),
  ('hist-bf25-12', 'Black Friday 2025', 'Live', 'graphic', 'Jake', 'Sale offer V2', 'https://fb.me/adspreview/facebook/27GoazzhwSmz8P1', NULL::text),
  ('hist-bf25-13', 'Black Friday 2025', 'GWP', 'video', 'Steve', 'Couch talk through', 'https://fb.me/adspreview/facebook/2iSOyatgZQ9GCzw', NULL::text),
  ('hist-bf25-14', 'Black Friday 2025', 'GWP', 'video', 'Steve', 'Warehouse talk through announcement', 'https://fb.me/adspreview/facebook/1WrIIKsfC766Odz', NULL::text),
  ('hist-bf25-15', 'Black Friday 2025', 'Mid Sale', 'video', 'Steve, team', 'Hangover skit', 'https://fb.me/adspreview/facebook/2qC1m15nTWSo9hk', NULL::text),
  ('hist-bf25-16', 'Black Friday 2025', 'Mid Sale', 'video', 'Steve', 'Roll bar top picks', 'https://fb.me/adspreview/facebook/28eQzcB93Kw21mv', NULL::text),
  ('hist-bf25-17', 'Black Friday 2025', 'Mid Sale', 'video', 'Shez', 'Flat lay', 'https://fb.me/adspreview/facebook/23yywEbk8knSnr2', NULL::text),
  ('hist-bf25-18', 'Black Friday 2025', 'Mid Sale', 'graphic', 'Shez', 'DPA frame carousel - best-sellers', 'https://fb.me/adspreview/facebook/2qC1m15nTWSo9hk', NULL::text),
  ('hist-bf25-19', 'Black Friday 2025', 'Last Chance', 'video', 'Steve', 'Warehouse talk through announcement', 'https://fb.me/adspreview/facebook/1WWP8ufMi6N6kje', NULL::text),
  ('hist-misc-01', 'Mystery Box', 'Live', 'video', 'Mark', 'Unboxing', NULL::text, NULL::text),
  ('hist-misc-02', 'Mystery Box', 'Live', 'graphic', 'Til', 'Apology statement', NULL::text, NULL::text),
  ('hist-misc-03', 'Mystery Box', 'Live', 'video', 'Mark', 'What $X can get you', NULL::text, NULL::text),
  ('hist-misc-04', 'Boxing Day', 'Live', 'graphic', 'Shez', 'Notes app', NULL::text, NULL::text),
  ('hist-misc-05', 'Boxing Day', 'Live', 'graphic', 'Til', 'Ugly ad carousel', NULL::text, NULL::text)
) AS v(source_key, campaign_name, sale_stage_note, media_type, creator, title, video_url, additional_urls)
ON CONFLICT (source_key) DO NOTHING;

-- Idea <-> historical winner links -- only where the connection is clear
-- from title/creator/reference URL (several confirmed by an exact URL
-- match between the idea's own reference_note and the historical record
-- imported above). Genuinely ambiguous 2026 ideas (Secret envelope, Flyer
-- video, UGC content, Stencil graffiti, Snipping ribbon) are deliberately
-- left unlinked -- no historical precedent found, never guessed.
INSERT INTO promotion_creative_idea_inspirations (promotion_creative_idea_id, creative_inspiration_id)
SELECT pci.id, ci.id
FROM (VALUES
  ('bf2026-video-1', 'hist-winter26-12'), ('bf2026-video-1', 'hist-bday26-10'),
  ('bf2026-video-2', 'hist-winter26-04'),
  ('bf2026-video-3', 'hist-winter26-06'),
  ('bf2026-video-4', 'hist-winter26-08'),
  ('bf2026-video-5', 'hist-winter26-15'),
  ('bf2026-video-6', 'hist-winter26-10'), ('bf2026-video-6', 'hist-bday26-04'),
  ('bf2026-video-7', 'hist-winter26-16'), ('bf2026-video-7', 'hist-bday26-05'), ('bf2026-video-7', 'hist-bf25-16'),
  ('bf2026-video-8', 'hist-bday26-06'), ('bf2026-video-8', 'hist-bf25-02'),
  ('bf2026-video-9', 'hist-bday26-08'), ('bf2026-video-9', 'hist-bf25-14'), ('bf2026-video-9', 'hist-bf25-19'),
  ('bf2026-video-10', 'hist-bf25-04'),
  ('bf2026-video-11', 'hist-bf25-09'), ('bf2026-video-11', 'hist-bf25-10'),
  ('bf2026-video-12', 'hist-bf25-11'),
  ('bf2026-video-13', 'hist-winter26-11'), ('bf2026-video-13', 'hist-bf25-13'),
  ('bf2026-video-14', 'hist-bf25-17'),
  ('bf2026-video-15', 'hist-misc-03'),
  ('bf2026-graphic-1', 'hist-winter26-01'),
  ('bf2026-graphic-2', 'hist-winter26-02'), ('bf2026-graphic-2', 'hist-winter26-05'),
  ('bf2026-graphic-3', 'hist-winter26-07'),
  ('bf2026-graphic-4', 'hist-bday26-07'),
  ('bf2026-graphic-5', 'hist-bday26-02'), ('bf2026-graphic-5', 'hist-bf25-01'), ('bf2026-graphic-5', 'hist-bf25-06'),
  ('bf2026-graphic-6', 'hist-bday26-11'), ('bf2026-graphic-6', 'hist-bf25-07'), ('bf2026-graphic-6', 'hist-misc-04')
) AS v(idea_source_key, inspiration_source_key)
JOIN promotion_creative_ideas pci ON pci.source_key = v.idea_source_key
JOIN creative_inspiration ci ON ci.source_key = v.inspiration_source_key
ON CONFLICT DO NOTHING;

-- Classification review of the 21 Needs Classification executions (see
-- the brief): only one is genuinely unambiguous enough to resolve --
-- "Founder/EGC warehouse talk through" is Steve-led with the warehouse
-- team as support (matching its Black Friday 2025 precedent, a
-- confirmed-founder-led format), so it becomes Founder Video. Everything
-- else stays Needs Classification deliberately (mixed founder/staff
-- casts, or formats with no clean existing bucket) -- "better data, not
-- zero unclassified rows at any cost". Guarded by "still NULL" so this can
-- never overwrite a classification the team has since corrected by hand.
UPDATE promotion_creative_idea_executions pcie SET creative_style_id = cs.id, updated_at = now()
FROM promotion_creative_ideas pci, promotion_stages ps, creative_styles cs
WHERE pcie.promotion_creative_idea_id = pci.id AND pci.source_key = 'bf2026-video-10'
  AND pcie.promotion_stage_id = ps.id AND ps.name = 'Hype Ads'
  AND cs.name = 'Founder Video'
  AND pcie.creative_style_id IS NULL;

-- Max's follow-up decision on 5 more of the remaining Needs Classification
-- ideas (see the brief): applies to EVERY stage execution the idea
-- currently has (not just one stage), since the classification is a
-- property of the idea's format, not of which sale stage it's running in.
-- "Secret envelope", "Flyer video", and "Stencil graffiti" are deliberately
-- NOT touched here -- Max's decision was to leave them Needs Classification
-- rather than force them into an ill-fitting existing style. Each UPDATE is
-- guarded by "still NULL" so it can never overwrite a classification the
-- team has since corrected by hand.
UPDATE promotion_creative_idea_executions pcie SET creative_style_id = cs.id, updated_at = now()
FROM promotion_creative_ideas pci, creative_styles cs
WHERE pcie.promotion_creative_idea_id = pci.id AND pci.source_key = 'bf2026-video-7'
  AND cs.name = 'EGC Video'
  AND pcie.creative_style_id IS NULL;

UPDATE promotion_creative_idea_executions pcie SET creative_style_id = cs.id, updated_at = now()
FROM promotion_creative_ideas pci, creative_styles cs
WHERE pcie.promotion_creative_idea_id = pci.id AND pci.source_key = 'bf2026-video-8'
  AND cs.name = 'EGC Video'
  AND pcie.creative_style_id IS NULL;

UPDATE promotion_creative_idea_executions pcie SET creative_style_id = cs.id, updated_at = now()
FROM promotion_creative_ideas pci, creative_styles cs
WHERE pcie.promotion_creative_idea_id = pci.id AND pci.source_key = 'bf2026-graphic-3'
  AND cs.name = 'Graphic tile'
  AND pcie.creative_style_id IS NULL;

UPDATE promotion_creative_idea_executions pcie SET creative_style_id = cs.id, updated_at = now()
FROM promotion_creative_ideas pci, creative_styles cs
WHERE pcie.promotion_creative_idea_id = pci.id AND pci.source_key = 'bf2026-graphic-5'
  AND cs.name = 'Graphic tile'
  AND pcie.creative_style_id IS NULL;

UPDATE promotion_creative_idea_executions pcie SET creative_style_id = cs.id, updated_at = now()
FROM promotion_creative_ideas pci, creative_styles cs
WHERE pcie.promotion_creative_idea_id = pci.id AND pci.source_key = 'bf2026-graphic-6'
  AND cs.name = 'Graphic tile'
  AND pcie.creative_style_id IS NULL;

-- =====================================================================
-- Black Friday 2026 follow-up: "Creative Plan" reference tab -- planning
-- source documents the 26 master ideas / inspiration library were built
-- from (see the brief, Part 4B). Deliberately NOT a hardcoded/guessed
-- Google Sheet URL -- url starts NULL and is filled in later through the
-- app (or left empty forever, which the UI handles as a normal state,
-- never a broken link/dependency). Generic (promotion_id-scoped, not
-- literally Black-Friday-only) so any future promotion could use the same
-- mechanism, but only Black Friday 2026 is seeded here.
-- =====================================================================
CREATE TABLE IF NOT EXISTS promotion_reference_sources (
  id SERIAL PRIMARY KEY,
  promotion_id INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  label VARCHAR(255) NOT NULL,
  description VARCHAR(500),
  url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_promotion_reference_sources_promotion_id ON promotion_reference_sources(promotion_id);

DO $$
DECLARE
  bf_id INTEGER;
BEGIN
  SELECT id INTO bf_id FROM promotions WHERE name = 'Black Friday 2026';
  IF bf_id IS NOT NULL THEN
    INSERT INTO promotion_reference_sources (promotion_id, label, description, sort_order)
    SELECT bf_id, v.label, v.description, v.sort_order
    FROM (VALUES
      ('Creative Target & Mix Plan', 'Original guideline used to build the 180-piece creative-style matrix below. Targets are directional.', 0),
      ('WNDRR Black Friday Sale 2026 -- Ad Ideas', 'Video ideas, graphic ideas and previous winning ads -- source for the 26 master ideas and the Inspiration Library.', 1)
    ) AS v(label, description, sort_order)
    WHERE NOT EXISTS (
      SELECT 1 FROM promotion_reference_sources prs WHERE prs.promotion_id = bf_id AND prs.label = v.label
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Meta performance data layer, Phase 1 (Meta -> database only -- see the
-- investigation/validation rounds that preceded this). Four additive
-- tables, nothing above this line touched, no existing table altered.
-- Stable Meta IDs are the source of truth throughout; ad names are
-- metadata/historical-matching assistance only (see meta_ads.ad_name).
-- Nothing here is populated automatically on deploy -- see
-- src/lib/metaSync.js / src/routes/metaSync.js: every sync is admin-
-- triggered via an explicit endpoint call, never a startup hook.
-- ---------------------------------------------------------------------------

-- One row per Meta ad, upserted by metaSync.js's discovery pass. Name/
-- status/campaign/adset/creative IDs are refreshed on every discovery run
-- (an ad's name or status can change on Meta's side); the match_* columns
-- are deliberately NEVER touched by that upsert (see metaSync.js's own
-- comment on its ON CONFLICT clause) -- a confirmed mapping must survive
-- forever, and even a 'suggested' one is only ever overwritten by a human
-- action, never silently re-guessed by a later discovery run.
CREATE TABLE IF NOT EXISTS meta_ads (
  id SERIAL PRIMARY KEY,
  meta_ad_id VARCHAR(64) UNIQUE NOT NULL,
  meta_adset_id VARCHAR(64),
  meta_campaign_id VARCHAR(64),
  meta_creative_id VARCHAR(64),
  ad_name TEXT,
  effective_status VARCHAR(30),
  created_time TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Mapping to WNDRR's own creative record -- ad -> creative, a separate axis
  -- from the PRODUCT-FAMILY mapping that already exists in Settings -> Meta
  -- Mapping (meta_product_mappings: Product + Product Type -> product_code).
  -- That existing system is preserved as-is and is NOT duplicated here: a
  -- later round can parse ad_name with metaProductMapping.parseMetaAdName
  -- and look the result up in meta_product_mappings to SUGGEST a product
  -- family for a historical ad, but such a suggestion is only ever a
  -- hint -- it must never write match_status = 'confirmed' (only an
  -- explicit human action does). Stable meta_ad_id stays the permanent ad
  -- identity throughout. No FK to a specific table is
  -- forced here (ad_setups is the obvious target once the matching UI
  -- exists, but that's a future round's decision) -- matched_ad_setup_id
  -- stays a plain nullable integer rather than a premature FK, so this
  -- round's schema can't silently constrain a decision nobody has made
  -- yet. match_status is the real state machine: unmatched (default,
  -- every historical/newly-discovered ad starts and stays here until a
  -- human or a future matching step acts), suggested (a candidate match
  -- exists but isn't confirmed), confirmed (persists permanently; see
  -- above).
  matched_ad_setup_id INTEGER,
  match_status VARCHAR(20) NOT NULL DEFAULT 'unmatched'
    CHECK (match_status IN ('unmatched', 'suggested', 'confirmed')),
  match_confidence NUMERIC(4,3),
  match_method VARCHAR(30),
  match_confirmed_at TIMESTAMPTZ,
  match_confirmed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_meta_ads_match_status ON meta_ads(match_status);
CREATE INDEX IF NOT EXISTS idx_meta_ads_meta_campaign_id ON meta_ads(meta_campaign_id);
CREATE INDEX IF NOT EXISTS idx_meta_ads_meta_adset_id ON meta_ads(meta_adset_id);

-- Daily ad-level performance, the grain every flexible date range (Today/
-- Last 7 Days/This Month/Custom/Compare-to-previous-period, per the
-- architecture brief) is built from by summing rows -- never pre-
-- aggregated weekly/monthly totals, which could never support an
-- arbitrary custom range. UNIQUE(meta_ad_id, insight_date) is the upsert
-- key metaSync.js's daily-insights upsert conflicts on, so re-syncing the
-- same ad/day (the 3-day overlap refresh, or a re-run backfill chunk)
-- updates in place rather than duplicating.
--
-- cost_per_add_to_cart / cost_per_purchase are deliberately NOT columns
-- here -- see the Phase 1 report's reasoning: derived as spend / count at
-- query time (with a NULLIF guard against divide-by-zero) stays correct
-- automatically if spend or conversion counts are later corrected by a
-- re-sync, where a stored derived value would silently go stale.
--
-- raw_actions / raw_action_values keep the exact action_type breakdown
-- Meta returned for that ad/day, beyond just the canonical purchase/
-- add-to-cart figures already extracted into their own columns -- so a
-- different canonical action_type choice later never requires re-pulling
-- this day from Meta again, only a backfill over what's already stored
-- locally.
CREATE TABLE IF NOT EXISTS meta_ad_insights_daily (
  id SERIAL PRIMARY KEY,
  meta_ad_id VARCHAR(64) NOT NULL REFERENCES meta_ads(meta_ad_id) ON DELETE CASCADE,
  insight_date DATE NOT NULL,

  impressions BIGINT NOT NULL DEFAULT 0,
  reach BIGINT NOT NULL DEFAULT 0,
  frequency NUMERIC(10,4),
  spend NUMERIC(14,2) NOT NULL DEFAULT 0,

  outbound_clicks BIGINT NOT NULL DEFAULT 0,
  outbound_ctr NUMERIC(10,6),

  -- Derived conversion figures. Which Meta action_type each is extracted
  -- from (omni_purchase / omni_add_to_cart -- verified against Ads Manager
  -- for 2-4 Oct 2026) is configured in exactly one place
  -- (src/lib/metaReportingConfig.js) -- never hard-wired here or anywhere
  -- else. Changing it needs no schema change: raw_actions /
  -- raw_action_values below keep the full per-alias breakdown, and
  -- POST /api/meta-sync/rederive-conversions recomputes these three
  -- columns from that stored raw data without calling Meta.
  add_to_cart BIGINT NOT NULL DEFAULT 0,
  purchases BIGINT NOT NULL DEFAULT 0,
  purchase_value NUMERIC(14,2) NOT NULL DEFAULT 0,

  video_plays BIGINT NOT NULL DEFAULT 0,
  thruplays BIGINT NOT NULL DEFAULT 0,
  video_p25 BIGINT NOT NULL DEFAULT 0,
  video_p50 BIGINT NOT NULL DEFAULT 0,
  video_p75 BIGINT NOT NULL DEFAULT 0,
  video_p95 BIGINT NOT NULL DEFAULT 0,
  video_p100 BIGINT NOT NULL DEFAULT 0,

  raw_actions JSONB,
  raw_action_values JSONB,

  currency VARCHAR(8),
  -- What WE explicitly requested for this pull (action_attribution_windows
  -- sent on the Insights call), never a value Meta told us was "the"
  -- account setting -- the validation round confirmed Meta doesn't expose
  -- that cleanly (use_account_attribution_setting is not a valid field;
  -- Meta error #100). PROVISIONAL: configured in one place
  -- (src/lib/metaReportingConfig.js) and compared against Ads Manager
  -- during production QA before attribution behaviour is finalised.
  attribution_setting VARCHAR(60),

  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (meta_ad_id, insight_date)
);
CREATE INDEX IF NOT EXISTS idx_meta_ad_insights_daily_date ON meta_ad_insights_daily(insight_date);

-- Single-row-per-account snapshot of the settings needed to interpret
-- stored figures consistently (currency/timezone) -- refreshed by every
-- sync run, never hand-edited. Keyed by the account id (not a bare
-- singleton row) so a second ad account is additive, not a schema change,
-- if WNDRR ever has one.
CREATE TABLE IF NOT EXISTS meta_account_settings (
  meta_ad_account_id VARCHAR(64) PRIMARY KEY,
  account_name VARCHAR(255),
  currency VARCHAR(8),
  timezone_name VARCHAR(64),
  timezone_offset_hours_utc NUMERIC(5,2),
  account_status VARCHAR(30),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per sync run (default-window or backfill-chunk), so "most recent
-- successful sync" / counts / date range synced (the debug endpoint's own
-- requirements) are a real log, not a guess from the data tables alone --
-- a run that fails partway still leaves a record of exactly what it did
-- and didn't get through.
CREATE TABLE IF NOT EXISTS meta_sync_runs (
  id SERIAL PRIMARY KEY,
  run_type VARCHAR(20) NOT NULL CHECK (run_type IN ('default', 'backfill', 'inventory')),
  range_since DATE NOT NULL,
  range_until DATE NOT NULL,
  ads_discovered INTEGER NOT NULL DEFAULT 0,
  ads_inserted INTEGER NOT NULL DEFAULT 0,
  ads_updated INTEGER NOT NULL DEFAULT 0,
  daily_rows_inserted INTEGER NOT NULL DEFAULT 0,
  daily_rows_updated INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed')),
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  started_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_meta_sync_runs_started_at ON meta_sync_runs(started_at);

-- 'inventory' = the explicit full ad-inventory refresh (no Insights pulled),
-- logged here for visibility but EXCLUDED from sync-coverage calculations
-- (metaPerformance.getCoverage only counts 'default'/'backfill'). Databases
-- created before this existed have the narrower two-value CHECK, so widen it
-- in place -- idempotent (no-ops once the constraint already allows it) and
-- touches no rows.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'meta_sync_runs_run_type_check'
      AND conrelid = 'meta_sync_runs'::regclass
      AND pg_get_constraintdef(oid) NOT LIKE '%inventory%'
  ) THEN
    ALTER TABLE meta_sync_runs DROP CONSTRAINT meta_sync_runs_run_type_check;
    ALTER TABLE meta_sync_runs ADD CONSTRAINT meta_sync_runs_run_type_check
      CHECK (run_type IN ('default', 'backfill', 'inventory'));
  END IF;
END $$;

-- =====================================================================
-- Meta Ad Matching V1: classify Meta ads into WNDRR's creative-intelligence
-- vocabulary (Product(s) / Concept / Creative Style / Creator / optional
-- Ad Setup link) without inventing records that don't exist.
--
-- Source-of-truth split (no duplicated truths):
--   meta_ads                 Meta-owned fields (sync/inventory write ONLY
--                            these) + the EXISTING match_status /
--                            matched_ad_setup_id / match_* state machine
--                            (unmatched | suggested | confirmed), which
--                            stays THE state field. Sync and inventory
--                            refresh never touch any match_* column or
--                            anything below.
--   meta_ad_classifications  the HUMAN-confirmed classification values
--                            (+ excluded / skipped flags), one row per ad.
--   meta_ad_products         the HUMAN-confirmed product(s), many per ad,
--                            keyed on the stable product_code
--                            (deriveProductCode(style_code)) -- the same
--                            identity meta_product_mappings and coverage
--                            use. Never a free-typed product name.
--   meta_ad_suggestions      DISPOSABLE, derived suggestions (value +
--                            confidence + reason). Rewritable at will;
--                            never read as truth, never written for a
--                            confirmed ad.
--
-- An ad that matches a WNDRR Ad Setup links via the existing
-- meta_ads.matched_ad_setup_id (ad_setup -> final_edit -> creative_asset);
-- a historical ad with no Ad Setup is classified here directly, with
-- matched_ad_setup_id left NULL -- no fake ad_setup/final_edit/creative_asset
-- rows are ever created.
--
-- Two taxonomies are deliberately kept SEPARATE (not merged here):
--   concept_type_id   -> concept_types (the reusable concept vocabulary;
--                        creative_assets.concept_type / ad_setups.
--                        concept_label come from it). concept_label always
--                        snapshots the text, so a historical concept that
--                        isn't in concept_types can be saved as a legacy
--                        free-text classification (concept_type_id NULL)
--                        without polluting concept_types.
--   creative_style_id -> creative_styles (the Black Friday / promotion
--                        creative-style matrix vocabulary).
-- (concept_types today also contains the 14 creative_styles names -- that
-- overlap is existing data, left exactly as it is.)
-- Creator stays a plain name (like ad_setups.creator_name) -- no user FK.
-- =====================================================================
ALTER TABLE meta_ads ADD COLUMN IF NOT EXISTS match_suggestions_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS meta_ad_classifications (
  meta_ad_id VARCHAR(64) PRIMARY KEY REFERENCES meta_ads(meta_ad_id) ON DELETE CASCADE,
  -- Deliberate "Not product-specific" decision (DPA / sale / campaign /
  -- general ads) -- mutually exclusive with any meta_ad_products rows.
  not_product_specific BOOLEAN NOT NULL DEFAULT false,
  concept_type_id INTEGER REFERENCES concept_types(id) ON DELETE SET NULL,
  concept_label VARCHAR(255),
  creative_style_id INTEGER REFERENCES creative_styles(id) ON DELETE SET NULL,
  creator_name VARCHAR(255),
  -- Reversible "Not relevant for creative intelligence" flag (utility /
  -- DPA / internal ads that must not influence concept recommendations).
  excluded_from_intelligence BOOLEAN NOT NULL DEFAULT false,
  excluded_reason VARCHAR(255),
  excluded_at TIMESTAMPTZ,
  -- "Skip for now": no classification is implied, the ad just sorts to the
  -- bottom of the matching queue.
  skipped_at TIMESTAMPTZ,
  classified_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meta_ad_products (
  meta_ad_id VARCHAR(64) NOT NULL REFERENCES meta_ads(meta_ad_id) ON DELETE CASCADE,
  product_code VARCHAR(64) NOT NULL,
  -- Display snapshot only; identity is product_code.
  product_name VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (meta_ad_id, product_code)
);
CREATE INDEX IF NOT EXISTS idx_meta_ad_products_product_code ON meta_ad_products(product_code);

CREATE TABLE IF NOT EXISTS meta_ad_suggestions (
  id SERIAL PRIMARY KEY,
  meta_ad_id VARCHAR(64) NOT NULL REFERENCES meta_ads(meta_ad_id) ON DELETE CASCADE,
  field VARCHAR(20) NOT NULL CHECK (field IN ('product', 'concept', 'creator', 'creative_style', 'ad_setup', 'scope')),
  -- Natural key of the proposed value (product_code / normalised concept or
  -- creator text / style id / ad setup id / 'not_product_specific').
  value_key VARCHAR(255) NOT NULL,
  value_label VARCHAR(255),
  -- concept_types.id / creative_styles.id / ad_setups.id when the value is
  -- one of those records; NULL for free-text (legacy) concept/creator.
  value_ref INTEGER,
  confidence NUMERIC(4,3) NOT NULL,
  reason TEXT NOT NULL,
  source VARCHAR(40) NOT NULL,
  evidence JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (meta_ad_id, field, value_key)
);
CREATE INDEX IF NOT EXISTS idx_meta_ad_suggestions_meta_ad_id ON meta_ad_suggestions(meta_ad_id);
