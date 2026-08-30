const express = require('express');
const apparelmagic = require('../lib/apparelmagic');
const reportPipeline = require('../lib/reportPipeline');
const metaAds = require('../lib/metaAds');
const { fetchAmData } = require('../lib/planningData');
const { pool } = require('../db');

const router = express.Router();

// Report Pipeline (High Stock's Platinum/Rocket tier source) cache status
// plus a tier-value breakdown -- lets us tell "genuinely no eligible
// styles" apart from "the tier map only partially resolved" (e.g. a chunk
// of SKUs failed to match a style_code) without guessing.
router.get('/pipeline/status', async (req, res, next) => {
  try {
    const status = { configured: reportPipeline.configured(), cache: reportPipeline.getPipelineCacheStatus().styleTiers };
    if (!reportPipeline.configured()) return res.json(status);
    const tiers = await reportPipeline.getStyleTiers();
    const breakdown = {};
    for (const { tier } of tiers.values()) breakdown[tier] = (breakdown[tier] || 0) + 1;
    res.json({ ...status, totalStyleCodesResolved: tiers.size, tierBreakdown: breakdown });
  } catch (err) {
    next(err);
  }
});

// Diagnostic only -- for a High Stock product that isn't showing up as
// expected, this shows exactly what each stage of the pipeline saw for it:
// whether AM carries the style at all (and its SOH), whether the Report
// Pipeline resolved a tier for it, and what High Stock's own gates computed.
// Search by product-name substring since style codes aren't always at hand.
// Must match HIGH_STOCK_MIN_DAYS_SINCE_LAUNCH in highStockProducts.js.
const HIGH_STOCK_MIN_DAYS_SINCE_LAUNCH = 14;

router.get('/high-stock/lookup', async (req, res, next) => {
  try {
    const query = (req.query.name || '').trim().toLowerCase();
    if (!query) return res.status(400).json({ error: 'Provide ?name=<product name substring>' });

    const salesReady = apparelmagic.getAmCacheStatus().sales.hasData;
    const [am, tiers, salesByStyle] = await Promise.all([
      fetchAmData(),
      reportPipeline.configured() ? reportPipeline.getStyleTiers() : Promise.resolve(new Map()),
      salesReady ? apparelmagic.getSalesByStyle() : Promise.resolve(new Map()),
    ]);
    if (!am.amConfigured || !am.amDetails) {
      return res.status(503).json({ error: 'ApparelMagic is not configured' });
    }

    const candidateCodes = [];
    for (const [styleCode, details] of am.amDetails.entries()) {
      if ((details.productName || '').toLowerCase().includes(query)) candidateCodes.push(styleCode);
    }
    const localRows = candidateCodes.length
      ? (await pool.query(`SELECT style_code, tier, drop_id FROM styles WHERE style_code = ANY($1::text[])`, [candidateCodes])).rows
      : [];
    const localByCode = new Map(localRows.map((r) => [r.style_code, r]));
    const dropIds = [...new Set(localRows.map((r) => r.drop_id).filter((id) => id != null))];
    const upcomingDropIdsResult = dropIds.length
      ? await pool.query(`SELECT id FROM drops WHERE id = ANY($1::int[]) AND launch_date >= CURRENT_DATE`, [dropIds])
      : { rows: [] };
    const upcomingDropIds = new Set(upcomingDropIdsResult.rows.map((r) => r.id));

    const matches = candidateCodes.map((styleCode) => {
      const details = am.amDetails.get(styleCode);
      const soh = am.amStock ? (am.amStock.get(styleCode) ?? 0) : null;
      const tierEntry = tiers.get(styleCode) || null;
      const qty7 = salesByStyle.get(styleCode)?.qty7 ?? 0;
      const sellThrough7Pct = (qty7 + soh) > 0 ? Math.round((qty7 / (qty7 + soh)) * 100) : 0;
      const local = localByCode.get(styleCode) || null;
      const daysSinceLaunch = details.launchDate ? Math.floor((Date.now() - details.launchDate.getTime()) / 86400000) : null;
      return {
        style_code: styleCode,
        product_name: details.productName,
        is_core: details.isCore,
        category: details.category,
        soh,
        is_wndrr_style_code: apparelmagic.isWndrrStyleCode(styleCode),
        qty7,
        sell_through_7d_pct: sellThrough7Pct,
        launch_date: details.launchDateRaw || null,
        days_since_launch: daysSinceLaunch,
        recent_launch_exclusion: daysSinceLaunch != null && daysSinceLaunch < HIGH_STOCK_MIN_DAYS_SINCE_LAUNCH
          ? `launched ${daysSinceLaunch} day${daysSinceLaunch === 1 ? '' : 's'} ago -- excluded as a recent drop (< ${HIGH_STOCK_MIN_DAYS_SINCE_LAUNCH} days)`
          : null,
        tier_lookup: tierEntry ? { tier: tierEntry.tier, index_score: tierEntry.indexScore } : 'not found in Report Pipeline tier map',
        local_exclusion: local
          ? (local.tier === 'core_proven' ? 'already tracked locally as core_proven'
            : (local.drop_id != null && upcomingDropIds.has(local.drop_id)) ? `already tied to UPCOMING drop_id ${local.drop_id}`
              : local.drop_id != null ? `tied to PAST drop_id ${local.drop_id} -- not excluded`
                : null)
          : null,
      };
    });
    res.json({ query, pipeline_configured: reportPipeline.configured(), total_tier_map_size: tiers.size, sales_data_ready: salesReady, matches });
  } catch (err) {
    next(err);
  }
});

// Whether the AM cache (stock/catalogue/on-order) has data yet, and whether
// a fetch is currently in flight -- useful to tell "genuinely no matching
// styles" apart from "still doing the first crawl since deploy."
router.get('/am/status', (req, res) => {
  res.json({ configured: apparelmagic.configured(), cache: apparelmagic.getAmCacheStatus() });
});

// Whether the Meta Ads live sync (Drop cards' "N live on Meta" figure) is
// configured and working -- useful right after setting META_AD_ACCOUNT_ID /
// META_ACCESS_TOKEN in Railway, to confirm the token/account actually work
// without waiting on a Drop page load or a 45m cache TTL. If configured,
// forces a fresh fetch (bypassing the cache) so a bad token surfaces here
// immediately rather than only on the next real request.
router.get('/meta-ads/status', async (req, res, next) => {
  try {
    const status = { configured: metaAds.configured(), cache: metaAds.getMetaAdsCacheStatus() };
    if (!metaAds.configured()) return res.json(status);
    const { counts, totalLiveAds, unmapped, unparsed } = await metaAds.getLiveAdCoverage();
    res.json({
      ...status,
      total_live_ads: totalLiveAds,
      mapped_product_families: counts.size,
      unmapped_live_ads: unmapped,
      unparsed_ad_names: unparsed,
    });
  } catch (err) {
    res.status(502).json({ configured: true, error: err.message });
  }
});

// Diagnostic only -- returns a raw ApparelMagic product record so we can see
// real field names (e.g. images) instead of guessing. Requires auth like
// everything else; not linked from the UI.
router.get('/am/product/:styleCode', async (req, res, next) => {
  try {
    if (!apparelmagic.configured()) {
      return res.status(503).json({ error: 'ApparelMagic is not configured' });
    }
    const result = await apparelmagic.rawRequest('products', {
      style_number: req.params.styleCode,
      // ApparelMagic rejects page sizes below 10 ("must be between 10 and 1000").
      'pagination[page_size]': 10,
    });
    res.status(result.status).json(result.data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
