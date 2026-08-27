const express = require('express');
const apparelmagic = require('../lib/apparelmagic');
const reportPipeline = require('../lib/reportPipeline');
const { fetchAmData } = require('../lib/planningData');

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
router.get('/high-stock/lookup', async (req, res, next) => {
  try {
    const query = (req.query.name || '').trim().toLowerCase();
    if (!query) return res.status(400).json({ error: 'Provide ?name=<product name substring>' });

    const [am, tiers] = await Promise.all([
      fetchAmData(),
      reportPipeline.configured() ? reportPipeline.getStyleTiers() : Promise.resolve(new Map()),
    ]);
    if (!am.amConfigured || !am.amDetails) {
      return res.status(503).json({ error: 'ApparelMagic is not configured' });
    }

    const matches = [];
    for (const [styleCode, details] of am.amDetails.entries()) {
      if (!(details.productName || '').toLowerCase().includes(query)) continue;
      const soh = am.amStock ? (am.amStock.get(styleCode) ?? 0) : null;
      const tierEntry = tiers.get(styleCode) || null;
      matches.push({
        style_code: styleCode,
        product_name: details.productName,
        is_core: details.isCore,
        category: details.category,
        soh,
        is_wndrr_style_code: apparelmagic.isWndrrStyleCode(styleCode),
        tier_lookup: tierEntry ? { tier: tierEntry.tier, index_score: tierEntry.indexScore } : 'not found in Report Pipeline tier map',
      });
    }
    res.json({ query, pipeline_configured: reportPipeline.configured(), total_tier_map_size: tiers.size, matches });
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
