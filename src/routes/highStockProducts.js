const express = require('express');
const { pool } = require('../db');
const apparelmagic = require('../lib/apparelmagic');
const reportPipeline = require('../lib/reportPipeline');
const { fetchAmData, getAssetCounts } = require('../lib/planningData');
const { STATUS_LABELS } = require('../lib/statuses');

const router = express.Router();

// v1 thresholds. Tier (platinum/rocket) comes from the Report Pipeline's own
// cohort-based sales index (see reportPipeline.js) -- this file only applies
// the flat SOH/sell-through gates the brief asked for, and keeps every other
// tunable as a hidden ranking/display input, not a scoring model.
const HIGH_STOCK_TIERS = new Set(['platinum', 'rocket']);
const HIGH_STOCK_MAX_SELL_THROUGH_7D_PCT = 5; // strict < -- "under 5%"
// A style this fresh out of the gate reads as a new drop still finding its
// stride, not a High Stock problem yet -- excluding it keeps the list from
// filling up with newly-launched product that just hasn't had time to sell
// through, rather than genuine overstock.
const HIGH_STOCK_MIN_DAYS_SINCE_LAUNCH = 14;
const HIGH_STOCK_STALE_DAYS = 21;
const HIGH_STOCK_TREND_DEADZONE_PCT = 10; // matches Core's own ±10% steady-state threshold
const HIGH_STOCK_MIN_RELIABLE_HIST_VEL = 1; // vel365 below this (units/week) isn't enough sales history for a trustworthy % comparison
const HIGH_STOCK_ASSET_LIST_LIMIT = 8; // expanded-detail creative list is a glance, not a full history -- most recent first

const TIER_EMOJI = { platinum: '💎', rocket: '🚀', surfer: '🏄', dog: '🐶', egg: '🥚' };
const TIER_LABEL = { platinum: 'Platinum', rocket: 'Rocket', surfer: 'Surfer', dog: 'Dog', egg: 'Egg' };

// Fixed single-line read (never a ranked list) -- always resolves to
// something, so the recommendation row always has its four fields: SOH,
// 30D Sell-Through, Sales Trend, Creative Status. Binary rather than the
// finer coverage-count tiers used elsewhere -- "Creative Status" is meant
// to answer one question (is there an obvious creative opportunity here),
// not enumerate exactly how much coverage exists.
function creativeStatusLabel(currentCoverage, daysSinceLastLive) {
  const hasRecentLiveCreative = currentCoverage > 0 && daysSinceLastLive != null && daysSinceLastLive <= HIGH_STOCK_STALE_DAYS;
  return hasRecentLiveCreative ? 'Recent Creative' : 'No Recent Creative';
}

// Generic ratio-to-percent helper, reused for both the gating 7D figure and
// the informational 30D figure shown in the expanded detail -- same formula
// Core uses elsewhere, so "sell-through" means the same thing across the app.
function sellThroughInfo(vel, soh) {
  const ratio = (vel + soh) > 0 ? vel / (vel + soh) : 0;
  return { ratio, pct: Math.round(ratio * 100) };
}

// The displayed Sales Trend indicator: 30D weekly average vs. a 365D
// trailing weekly baseline (same vel365 pattern coreProducts.js already
// uses for its own velocity strip) -- purely informational now, plays no
// role in eligibility. When the baseline itself is too thin to trust a
// percentage off of, that's flagged rather than shown as a misleading
// number.
function salesTrendInfo(vel30, vel365) {
  if (vel365 < HIGH_STOCK_MIN_RELIABLE_HIST_VEL) {
    return { display: 'Limited Sales History', cls: 'core-trend-flat', reliable: false, pct: null };
  }
  const pct = Math.round((vel30 / vel365 - 1) * 100);
  if (pct <= -HIGH_STOCK_TREND_DEADZONE_PCT) return { display: `↓ Sales ${Math.abs(pct)}%`, cls: 'core-trend-down', reliable: true, pct };
  if (pct >= HIGH_STOCK_TREND_DEADZONE_PCT) return { display: `↑ Sales ${pct}%`, cls: 'core-trend-up', reliable: true, pct };
  return { display: `→ Sales ${Math.abs(pct)}%`, cls: 'core-trend-flat', reliable: true, pct };
}

router.get('/', async (req, res, next) => {
  try {
    const [am, settingsResult] = await Promise.all([
      fetchAmData(),
      pool.query('SELECT * FROM planning_settings WHERE id = 1'),
    ]);
    const settings = settingsResult.rows[0];
    const minSoh = settings.high_stock_min_soh;

    const emptyResponse = () => ({
      products: [],
      min_soh: minSoh,
      apparelmagic: { configured: am.amConfigured, error: am.amError },
      sales_data: apparelmagic.getAmCacheStatus().sales,
      pipeline: { configured: reportPipeline.configured(), styleTiersStatus: reportPipeline.getPipelineCacheStatus().styleTiers },
    });

    if (!am.amConfigured || !am.amDetails || !am.amStock) {
      return res.json(emptyResponse());
    }
    if (!reportPipeline.configured()) {
      return res.json(emptyResponse());
    }

    const salesReady = apparelmagic.getAmCacheStatus().sales.hasData;
    const [salesByStyle, styleTiers] = await Promise.all([
      salesReady ? apparelmagic.getSalesByStyle() : Promise.resolve(new Map()),
      reportPipeline.getStyleTiers(),
    ]);

    // Eligibility is per COLOURWAY (style_code), not per product family --
    // the reference report this brief was built from shows one row per
    // colourway, each with its own SOH/sell-through/tier. Not-core +
    // not-ad-excluded mirrors Core's own eligibility check, inverted. The
    // real-style-code check additionally excludes non-apparel catalogue
    // entries (shipping/return protection add-ons, etc.).
    const eligibleStyleCodes = [];
    for (const [styleCode, details] of am.amDetails.entries()) {
      if (details.isCore || apparelmagic.isAdExcludedCategory(details)) continue;
      if (!apparelmagic.isWndrrStyleCode(styleCode)) continue;
      // No launch date on record -> can't tell it's a recent drop, so it's
      // not excluded on this basis alone.
      if (details.launchDate) {
        const daysSinceLaunch = Math.floor((Date.now() - details.launchDate.getTime()) / 86400000);
        if (daysSinceLaunch < HIGH_STOCK_MIN_DAYS_SINCE_LAUNCH) continue;
      }

      const soh = am.amStock.get(styleCode) ?? 0;
      if (soh <= minSoh) continue;

      const tierInfo = styleTiers.get(styleCode);
      if (!tierInfo || !HIGH_STOCK_TIERS.has(tierInfo.tier)) continue;

      const qty7 = salesByStyle.get(styleCode)?.qty7 ?? 0;
      const sellThrough7 = sellThroughInfo(qty7, soh);
      // Gate on the raw ratio, not the rounded display percentage -- e.g.
      // 4.79% rounds to a displayed 5%, and comparing the ROUNDED value
      // against the threshold would wrongly exclude a style that's
      // genuinely under 5% (confirmed live: GLOBE PANEL HOOD SWEAT,
      // W26EE014STO, true ratio 8/167 = 4.79%, displayed as 5%).
      if (sellThrough7.ratio >= HIGH_STOCK_MAX_SELL_THROUGH_7D_PCT / 100) continue;

      eligibleStyleCodes.push({ styleCode, soh, tierInfo, sellThrough7Pct: sellThrough7.pct });
    }

    if (!eligibleStyleCodes.length) return res.json(emptyResponse());

    // Check what's already locally tracked BEFORE inserting anything, so a
    // style excluded below never causes a wasted insert attempt.
    const codes = eligibleStyleCodes.map((e) => e.styleCode);
    const preCheckResult = await pool.query(
      `SELECT * FROM styles WHERE style_code = ANY($1::text[])`,
      [codes]
    );
    const preCheckByCode = new Map(preCheckResult.rows.map((s) => [s.style_code, s]));

    // A style tied to an UPCOMING drop already has its own recommendation
    // flow via Drops -- don't show it in two places at once. A style tied
    // to a PAST drop has no such active flow (that drop's window has
    // closed), so it's fair game for High Stock like anything else. "Past"
    // matches the same rule the Drops UI itself uses for days_until_launch
    // (app.js) -- launch_date already behind today.
    const dropIds = [...new Set(preCheckResult.rows.map((s) => s.drop_id).filter((id) => id != null))];
    const upcomingDropIdsResult = dropIds.length
      ? await pool.query(`SELECT id FROM drops WHERE id = ANY($1::int[]) AND launch_date >= CURRENT_DATE`, [dropIds])
      : { rows: [] };
    const upcomingDropIds = new Set(upcomingDropIdsResult.rows.map((r) => r.id));

    // Drop a style already locally tracked as Core (the team's own explicit
    // call, which -- per Core's own established "never auto-changes an
    // existing row's tier" rule -- persists even if AM's live category has
    // since drifted) or already tied to an UPCOMING Drop. Never touches an
    // existing row either way.
    const surviving = eligibleStyleCodes.filter((e) => {
      const local = preCheckByCode.get(e.styleCode);
      if (!local) return true;
      return local.tier !== 'core_proven' && !(local.drop_id != null && upcomingDropIds.has(local.drop_id));
    });

    if (!surviving.length) return res.json(emptyResponse());

    // Sync local styles rows ONLY for the surviving codes that don't
    // already have one -- idempotent, same pattern as syncCoreStylesFromAm.
    // 'new_drop' is the only other tier value the styles table's CHECK
    // constraint allows, and it's mechanistically correct too: rules.js's
    // assertCanEnterFilming already requires a 'new_drop'-tiered style to
    // use a tested_proven concept or an explicit deliberate-trial flag to
    // reach Filming -- "don't auto-assume a New Concept."
    for (const { styleCode } of surviving) {
      if (preCheckByCode.has(styleCode)) continue;
      const details = am.amDetails.get(styleCode);
      await pool.query(
        `INSERT INTO styles (style_code, name, tier) VALUES ($1, $2, 'new_drop') ON CONFLICT (style_code) DO NOTHING`,
        [styleCode, details?.productName || styleCode]
      );
    }

    const survivingCodes = surviving.map((e) => e.styleCode);
    const localStylesResult = await pool.query(
      `SELECT * FROM styles WHERE style_code = ANY($1::text[])`,
      [survivingCodes]
    );
    const localStyleByCode = new Map(localStylesResult.rows.map((s) => [s.style_code, s]));
    const styleIds = survivingCodes
      .map((code) => localStyleByCode.get(code)?.id)
      .filter((id) => id != null);

    // Freshness/creative-detail queries, unchanged in shape from before --
    // the freshness query deliberately does NOT filter on
    // concept_classification (counts ANY live creative, Proven Winner
    // reshoots included), while "Last New Concept" explicitly asks the
    // narrower question. Both purely informational now.
    const [freshnessRows, assetCounts, newConceptRows, assetRows] = await Promise.all([
      styleIds.length
        ? pool.query(
            `SELECT ca.style_id, MAX(sh.changed_at) AS last_live_at
             FROM status_history sh
             JOIN creative_assets ca ON ca.id = sh.creative_asset_id
             WHERE sh.to_status = 'uploaded_live'
               AND ca.style_id = ANY($1::int[])
             GROUP BY ca.style_id`,
            [styleIds]
          )
        : Promise.resolve({ rows: [] }),
      getAssetCounts(styleIds),
      styleIds.length
        ? pool.query(
            `SELECT ca.style_id, MAX(sh.changed_at) AS last_new_concept_at
             FROM status_history sh
             JOIN creative_assets ca ON ca.id = sh.creative_asset_id
             WHERE sh.to_status = 'uploaded_live'
               AND ca.concept_classification = 'new_experimental'
               AND ca.style_id = ANY($1::int[])
             GROUP BY ca.style_id`,
            [styleIds]
          )
        : Promise.resolve({ rows: [] }),
      styleIds.length
        ? pool.query(
            `SELECT id, style_id, concept_name, status, format, concept_classification, created_at
             FROM creative_assets WHERE style_id = ANY($1::int[]) ORDER BY created_at DESC`,
            [styleIds]
          )
        : Promise.resolve({ rows: [] }),
    ]);
    const lastLiveByStyleId = new Map(freshnessRows.rows.map((r) => [r.style_id, r.last_live_at]));
    const lastNewConceptByStyleId = new Map(newConceptRows.rows.map((r) => [r.style_id, r.last_new_concept_at]));
    const assetRowsByStyleId = new Map();
    for (const row of assetRows.rows) {
      if (!assetRowsByStyleId.has(row.style_id)) assetRowsByStyleId.set(row.style_id, []);
      assetRowsByStyleId.get(row.style_id).push(row);
    }

    const products = surviving.map(({ styleCode, soh, tierInfo, sellThrough7Pct }) => {
      const local = localStyleByCode.get(styleCode);
      if (!local) return null; // guards a sync race; shouldn't happen given the insert above
      const details = am.amDetails.get(styleCode);
      const sales = salesByStyle.get(styleCode) || { qty7: 0, qty30: 0, qty365: 0 };
      const onOrder = am.amOnOrder ? (am.amOnOrder.get(styleCode) ?? 0) : null;
      const sizing = apparelmagic.resolveStyleSizing(am.amDetails, am.amSizeRanges, styleCode);

      const vel7 = sales.qty7; // already a weekly figure (7 days)
      const vel30 = (sales.qty30 / 30) * 7;
      const vel365 = (sales.qty365 / 365) * 7;
      const currentCoverage = assetCounts.get(local.id) || 0;
      const lastLiveAt = lastLiveByStyleId.get(local.id) || null;
      const lastNewConceptAt = lastNewConceptByStyleId.get(local.id) || null;
      const daysSinceLastLive = lastLiveAt ? Math.floor((Date.now() - new Date(lastLiveAt).getTime()) / 86400000) : null;
      const daysSinceLastNewConcept = lastNewConceptAt ? Math.floor((Date.now() - new Date(lastNewConceptAt).getTime()) / 86400000) : null;

      const tierLabel = TIER_LABEL[tierInfo.tier] || tierInfo.tier;
      const creativeStatus = creativeStatusLabel(currentCoverage, daysSinceLastLive);

      return {
        style_id: local.id,
        style_code: styleCode,
        product_code: apparelmagic.deriveProductCode(styleCode),
        product_name: details?.productName || local.name || styleCode,
        colour_label: apparelmagic.resolveColourLabel(am.amDetails, styleCode),
        category: details?.category || 'UNCATEGORISED',
        image_url: details?.imageUrl || null,
        soh,
        on_order: onOrder,
        tier: tierInfo.tier,
        tier_label: tierLabel,
        tier_emoji: TIER_EMOJI[tierInfo.tier] || '',
        index_score: tierInfo.indexScore,
        vel7: +vel7.toFixed(1),
        vel30: +vel30.toFixed(1),
        vel365: +vel365.toFixed(1),
        units_sold_30d: +sales.qty30.toFixed(1),
        sell_through_7d_pct: sellThrough7Pct,
        sell_through_pct: sellThroughInfo(vel30, soh).pct,
        sales_trend: (({ display, cls }) => ({ display, cls }))(salesTrendInfo(vel30, vel365)),
        current_coverage: currentCoverage,
        days_since_last_creative: daysSinceLastLive,
        last_live_at: lastLiveAt,
        days_since_last_new_concept: daysSinceLastNewConcept,
        last_new_concept_at: lastNewConceptAt,
        creative_status_label: creativeStatus,
        sizes: sizing.sizes,
        sizing_system: sizing.system,
        recommendation_reasons: [
          `${tierLabel} tier`,
          `Over ${minSoh} SOH (${soh})`,
          `Low 7D sell-through (${sellThrough7Pct}%)`,
        ],
        creative_assets: (assetRowsByStyleId.get(local.id) || [])
          .slice(0, HIGH_STOCK_ASSET_LIST_LIMIT)
          .map((a) => ({
            id: a.id,
            concept_name: a.concept_name,
            status: a.status,
            status_label: STATUS_LABELS[a.status] || a.status,
            format: a.format,
            concept_classification: a.concept_classification,
            created_at: a.created_at,
          })),
      };
    }).filter(Boolean);

    products.sort((a, b) => b.soh - a.soh);

    res.json({
      products,
      min_soh: minSoh,
      apparelmagic: { configured: am.amConfigured, error: am.amError },
      sales_data: apparelmagic.getAmCacheStatus().sales,
      pipeline: { configured: reportPipeline.configured(), styleTiersStatus: reportPipeline.getPipelineCacheStatus().styleTiers },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
