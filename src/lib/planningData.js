const { pool } = require('../db');
const apparelmagic = require('./apparelmagic');
const metaAds = require('./metaAds');

// Shared by drops.js (drop/product coverage) and dropProductPlans.js
// (concept-plan generation) -- both need the exact same live SOH/on-order/
// rules data to compute a product's creative target consistently.

async function fetchAmData() {
  if (!apparelmagic.configured()) {
    return { amStock: null, amDetails: null, amOnOrder: null, amSizeRanges: null, amError: null, amConfigured: false };
  }
  try {
    const [amStock, amDetails, amOnOrder, amSizeRanges] = await Promise.all([
      apparelmagic.getStockByStyle(),
      apparelmagic.getStyleCatalogue(),
      apparelmagic.getOnOrderByStyle(),
      apparelmagic.getSizeRanges(),
    ]);
    return { amStock, amDetails, amOnOrder, amSizeRanges, amError: null, amConfigured: true };
  } catch (err) {
    return { amStock: null, amDetails: null, amOnOrder: null, amSizeRanges: null, amError: err.message, amConfigured: true };
  }
}

// Live "how many ads are actually running" counts per internal product
// family, shown alongside (never replacing) the creative_assets-based
// current_coverage number -- see metaAds.js for why.
async function fetchMetaAdsData() {
  if (!metaAds.configured()) {
    return { metaLiveCounts: null, metaAdsError: null, metaAdsConfigured: false, metaAdsUnmapped: null, metaAdsUnparsed: null };
  }
  try {
    const { counts, unmapped, unparsed } = await metaAds.getLiveAdCoverage();
    return { metaLiveCounts: counts, metaAdsError: null, metaAdsConfigured: true, metaAdsUnmapped: unmapped, metaAdsUnparsed: unparsed };
  } catch (err) {
    return { metaLiveCounts: null, metaAdsError: err.message, metaAdsConfigured: true, metaAdsUnmapped: null, metaAdsUnparsed: null };
  }
}

async function getRules() {
  const result = await pool.query('SELECT * FROM creative_target_rules ORDER BY soh_min ASC');
  return result.rows;
}

async function getAssetCounts(styleIds) {
  if (!styleIds.length) return new Map();
  const result = await pool.query(
    `SELECT style_id, COUNT(*)::int AS count FROM creative_assets WHERE style_id = ANY($1::int[]) GROUP BY style_id`,
    [styleIds]
  );
  return new Map(result.rows.map((r) => [r.style_id, r.count]));
}

// Drops' own "current_coverage" (the progress bar on Upcoming/Past Drops
// cards and a Product view) counts only actually-completed creative --
// status 'uploaded_live', the same status the Board's kanban drag-and-drop
// uses for its final column -- not just a placeholder asset row existing.
// A Required Concept slot's asset is auto-created the moment the slot is
// generated (see dropProductPlans.js), so counting "any status" made
// coverage look complete the instant slots existed, before any real work
// had happened; the Required Concepts tickbox is what actually moves an
// asset into this count now. Kept separate from getAssetCounts above
// (still "any status") since High Stock's own informational Creative
// Assets figure isn't part of this ask and shouldn't silently change.
async function getCompletedAssetCounts(styleIds) {
  if (!styleIds.length) return new Map();
  const result = await pool.query(
    `SELECT style_id, COUNT(*)::int AS count FROM creative_assets
     WHERE style_id = ANY($1::int[]) AND status = 'uploaded_live' GROUP BY style_id`,
    [styleIds]
  );
  return new Map(result.rows.map((r) => [r.style_id, r.count]));
}

module.exports = { fetchAmData, fetchMetaAdsData, getRules, getAssetCounts, getCompletedAssetCounts };
