const { pool } = require('../db');
const { buildCoverage } = require('./coverage');
const { fetchAmData, fetchMetaAdsData, getRules, getCompletedAssetCounts } = require('./planningData');
const { isAdExcludedCategory } = require('./apparelmagic');

// Extracted from routes/drops.js so both the session-authenticated UI routes
// and the token-authenticated integration routes (for TUESDAY's Marketing >
// Drops tab) share one implementation -- no query logic duplicated between
// "a person is looking at this page" and "another app is reading this data".

// The team doesn't run ads for Accessories, so they're excluded from
// Upcoming/Past Drops entirely -- both from the coverage grid (so an
// Accessories style already attached to a drop never shows as a product
// card) and from suggestions.
function excludeAdExcludedStyles(styleRows, amDetails) {
  if (!amDetails) return styleRows;
  return styleRows.filter((s) => !isAdExcludedCategory(amDetails.get(s.style_code)));
}

function summarize(coverage) {
  const green = coverage.filter((c) => c.status === 'green').length;
  const amber = coverage.filter((c) => c.status === 'amber').length;
  const red = coverage.filter((c) => c.status === 'red').length;
  const totalCovered = coverage.reduce((sum, c) => sum + c.current_coverage, 0);
  const totalTarget = coverage.reduce((sum, c) => sum + (c.creative_target || 0), 0);
  const overallPct = totalTarget > 0 ? Math.round((totalCovered / totalTarget) * 100) : null;
  const styleCount = coverage.reduce((sum, c) => sum + c.styles.length, 0);
  return { productCount: coverage.length, styleCount, green, amber, red, totalCovered, totalTarget, overallPct };
}

function sortByUrgency(coverage) {
  return [...coverage].sort((a, b) => {
    const gapDiff = (b.creative_gap ?? -1) - (a.creative_gap ?? -1);
    if (gapDiff !== 0) return gapDiff;
    return (b.soh ?? -1) - (a.soh ?? -1);
  });
}

async function listDropsWithSummary() {
  const [dropsResult, stylesResult, rules, am, metaAdsData] = await Promise.all([
    pool.query('SELECT * FROM drops ORDER BY launch_date ASC'),
    pool.query('SELECT * FROM styles WHERE drop_id IS NOT NULL'),
    getRules(),
    fetchAmData(),
    fetchMetaAdsData(),
  ]);

  const stylesByDrop = new Map();
  for (const style of stylesResult.rows) {
    if (!stylesByDrop.has(style.drop_id)) stylesByDrop.set(style.drop_id, []);
    stylesByDrop.get(style.drop_id).push(style);
  }

  const assetCounts = await getCompletedAssetCounts(stylesResult.rows.map((s) => s.id));

  const drops = dropsResult.rows.map((drop) => {
    const styleRows = excludeAdExcludedStyles(stylesByDrop.get(drop.id) || [], am.amDetails);
    const coverage = sortByUrgency(
      buildCoverage(styleRows, { assetCounts, amStock: am.amStock, amOnOrder: am.amOnOrder, amDetails: am.amDetails, amSizeRanges: am.amSizeRanges, rules, liveMetaCounts: metaAdsData.metaLiveCounts })
    );
    const daysUntilLaunch = Math.ceil((new Date(drop.launch_date) - new Date()) / 86400000);
    return {
      ...drop,
      days_until_launch: daysUntilLaunch,
      summary: summarize(coverage),
      most_urgent: coverage.slice(0, 3),
      // Lean per-product projection (code/name/first image) for the
      // Upcoming Drops landing page's product list -- coverage itself is
      // already computed above for summary/most_urgent, this just also
      // exposes it product-by-product instead of discarding it. Not the
      // full coverage object (stock/creative-target detail) since the
      // landing page only needs enough to identify each product; that
      // fuller detail still comes from getDropDetail when a drop is opened.
      products: coverage.map((c) => ({
        product_code: c.product_code,
        product_name: c.product_name,
        image_url: c.images[0] || null,
      })),
    };
  });

  return {
    drops,
    apparelmagic: { configured: am.amConfigured, error: am.amError },
    meta_ads: { configured: metaAdsData.metaAdsConfigured, error: metaAdsData.metaAdsError, unmapped: metaAdsData.metaAdsUnmapped },
  };
}

async function getDropDetail(id) {
  const dropResult = await pool.query('SELECT * FROM drops WHERE id = $1', [id]);
  if (dropResult.rows.length === 0) return null;
  const drop = dropResult.rows[0];

  const [stylesResult, rules, am, metaAdsData] = await Promise.all([
    pool.query('SELECT * FROM styles WHERE drop_id = $1 ORDER BY style_code ASC', [drop.id]),
    getRules(),
    fetchAmData(),
    fetchMetaAdsData(),
  ]);
  const assetCounts = await getCompletedAssetCounts(stylesResult.rows.map((s) => s.id));
  const styleRows = excludeAdExcludedStyles(stylesResult.rows, am.amDetails);
  const coverage = sortByUrgency(
    buildCoverage(styleRows, { assetCounts, amStock: am.amStock, amOnOrder: am.amOnOrder, amDetails: am.amDetails, amSizeRanges: am.amSizeRanges, rules, liveMetaCounts: metaAdsData.metaLiveCounts })
  );
  const daysUntilLaunch = Math.ceil((new Date(drop.launch_date) - new Date()) / 86400000);

  return {
    ...drop,
    days_until_launch: daysUntilLaunch,
    summary: summarize(coverage),
    coverage,
    apparelmagic: { configured: am.amConfigured, error: am.amError },
    meta_ads: { configured: metaAdsData.metaAdsConfigured, error: metaAdsData.metaAdsError, unmapped: metaAdsData.metaAdsUnmapped },
  };
}

module.exports = { listDropsWithSummary, getDropDetail, summarize, sortByUrgency, excludeAdExcludedStyles };
