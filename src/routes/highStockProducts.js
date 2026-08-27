const express = require('express');
const { pool } = require('../db');
const apparelmagic = require('../lib/apparelmagic');
const { fetchAmData, getAssetCounts } = require('../lib/planningData');

const router = express.Router();

// v1 heuristic thresholds -- new territory, not shared with coreProducts.js
// (Core's own weights are only ever tuned to compare candidates within one
// product's own branch, never calibrated to be comparable ACROSS different
// products the way a single cross-product priority score needs to be).
// Tunable later if needed.
const HIGH_STOCK_WEEKS_COVER_REF = 12;
const HIGH_STOCK_RECENT_DECLINE_RATIO = 0.7; // vel7 vs vel30 -- a smaller, hidden "recent trend" pressure signal, deliberately separate from the displayed indicator below
const HIGH_STOCK_ON_ORDER_WEEKS_REF = 4;
const HIGH_STOCK_STALE_DAYS = 21;
const HIGH_STOCK_TREND_DEADZONE_PCT = 10; // matches Core's own ±10% steady-state threshold
const HIGH_STOCK_MIN_RELIABLE_HIST_VEL = 1; // vel365 below this (units/week) isn't enough sales history for a trustworthy % comparison

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

// 30D Sell-Through: this codebase has no order-received/COGS data to
// compute a textbook sold/received rate, so it's approximated from what IS
// available -- 30D sales vs. 30D sales + remaining stock. A low percentage
// means a lot of stock sitting against very little recent movement. Always
// computable (unlike the trend indicator below, it needs no sales history
// baseline), so it's always shown.
function sellThroughInfo(vel30, soh) {
  const ratio = (vel30 + soh) > 0 ? vel30 / (vel30 + soh) : 0;
  return { ratio, pct: Math.round(ratio * 100) };
}

// The displayed Sales Trend indicator: 30D weekly average vs. a 365D
// trailing weekly baseline (same vel365 pattern coreProducts.js already
// uses for its own velocity strip) -- NOT the volatile 7D figure, since a
// single week is too noisy for a High Stock product that may not move fast.
// When the baseline itself is too thin to trust a percentage off of (a
// near-zero trailing year), that's flagged rather than shown as a
// misleading/undefined-looking percentage -- distinct from 30D Sell-Through
// above, which answers a different question and is shown regardless.
function salesTrendInfo(vel30, vel365) {
  if (vel365 < HIGH_STOCK_MIN_RELIABLE_HIST_VEL) {
    return { display: 'Limited Sales History', cls: 'core-trend-flat', reliable: false, pct: null };
  }
  const pct = Math.round((vel30 / vel365 - 1) * 100);
  if (pct <= -HIGH_STOCK_TREND_DEADZONE_PCT) return { display: `↓ Sales ${Math.abs(pct)}%`, cls: 'core-trend-down', reliable: true, pct };
  if (pct >= HIGH_STOCK_TREND_DEADZONE_PCT) return { display: `↑ Sales ${pct}%`, cls: 'core-trend-up', reliable: true, pct };
  return { display: `→ Sales ${Math.abs(pct)}%`, cls: 'core-trend-flat', reliable: true, pct };
}

// Deliberately NOT coreProducts.js's buildAttention() -- High Stock products
// may be unproven, so this never emits a flag/label/emoji implying "needs a
// New Concept" the way Core's 🔴/🟠 badges do. It produces a continuous
// priority score (for ranking, using every signal available) and the fixed
// four-field display (SOH is read straight off the product elsewhere; 30D
// Sell-Through, Sales Trend, and Creative Status come from here).
//
// The brief asks to surface products with BOTH inventory pressure AND a
// creative gap -- a conjunction, not a sum. Pure addition would let a
// product with huge inventory pressure but ample recent creative still rank
// at the top on pressure alone, which contradicts that. So the score is
// pressure * gapMultiplier: pressure alone still ranks (gapMultiplier is
// floored at 0.2, never zero), but a product where a real creative gap
// exists too ranks meaningfully higher than pressure alone would.
function scoreHighStock({ soh, onOrder, vel7, vel30, vel365, weeksCover, currentCoverage, daysSinceLastLive }) {
  const sellThrough = sellThroughInfo(vel30, soh);
  const salesTrend = salesTrendInfo(vel30, vel365);
  const onOrderWeeks = vel30 > 0 ? onOrder / vel30 : (onOrder > 0 ? Infinity : 0);
  const neverLive = daysSinceLastLive == null;

  // Inventory-pressure terms, each capped so no single signal dominates
  // unboundedly. Weeks Cover stays purely a hidden ranking input here --
  // never surfaced in the recommendation row, per the brief.
  const weeksCoverTerm = weeksCover != null ? Math.min(Math.max(weeksCover - HIGH_STOCK_WEEKS_COVER_REF, 0) * 3, 60) : 0;
  const onOrderTerm = onOrder > 0 ? Math.min(15 + Math.min(onOrderWeeks, 40) * 3, 40) : 0;

  // Historical-trend pressure -- driven by the same number behind the
  // displayed Sales Trend indicator: a real decline adds pressure, and "not
  // enough history to say" gets a comparable flat bonus of its own (likely
  // near-dead stock, itself worth a look).
  const historicalDeclineTerm = !salesTrend.reliable
    ? 45
    : salesTrend.pct < 0
      ? Math.min(20 + Math.abs(salesTrend.pct), 60)
      : 0;

  // Recent (7D vs 30D) trend -- a smaller, separate "recent sales trend"
  // ranking signal, deliberately NOT surfaced in the display (7D is too
  // noisy for the single visible number on a High Stock product).
  const recentDeclining = vel30 > 0 && vel7 < vel30 * HIGH_STOCK_RECENT_DECLINE_RATIO;
  const recentTrendTerm = recentDeclining ? 15 : 0;

  // Sell-through pressure -- the same displayed 30D Sell-Through percentage
  // also feeds ranking: a low ratio means a lot of stock sitting against
  // very little recent movement.
  const sellThroughTerm = (1 - sellThrough.ratio) * 25;

  const pressureScore = weeksCoverTerm + onOrderTerm + historicalDeclineTerm + recentTrendTerm + sellThroughTerm;

  // Creative-gap multiplier: the stronger of a coverage-based and a
  // staleness-based signal, floored at 0.2 -- a high-pressure product with
  // some existing creative still ranks (discounted, not hidden).
  const coverageGap = currentCoverage === 0 ? 1.0
    : currentCoverage === 1 ? 0.7
      : currentCoverage === 2 ? 0.45
        : 0.25;
  const stalenessGap = neverLive ? 1.0
    : daysSinceLastLive > HIGH_STOCK_STALE_DAYS ? 0.8
      : 0.4;
  const gapMultiplier = Math.max(coverageGap, stalenessGap, 0.2);

  const priorityScore = pressureScore * gapMultiplier;

  return {
    priority_score: priorityScore,
    sell_through_pct: sellThrough.pct,
    sales_trend: { display: salesTrend.display, cls: salesTrend.cls },
    creative_status_label: creativeStatusLabel(currentCoverage, daysSinceLastLive),
  };
}

router.get('/', async (req, res, next) => {
  try {
    const [am, settingsResult] = await Promise.all([
      fetchAmData(),
      pool.query('SELECT * FROM planning_settings WHERE id = 1'),
    ]);
    const settings = settingsResult.rows[0];
    const minSoh = settings.high_stock_min_soh;
    const recommendationsShown = settings.high_stock_recommendations_shown;

    const emptyResponse = () => ({
      products: [],
      min_soh: minSoh,
      recommendations_shown: recommendationsShown,
      apparelmagic: { configured: am.amConfigured, error: am.amError },
      sales_data: apparelmagic.getAmCacheStatus().sales,
    });

    if (!am.amConfigured || !am.amDetails || !am.amStock) {
      return res.json(emptyResponse());
    }

    // Eligibility is computed entirely from the live AM catalogue -- unlike
    // Core, there's no local "tier" to iterate from, since a High Stock
    // product only earns a local styles row once it's actually eligible
    // (step below). Not-core + not-ad-excluded mirrors Core's own
    // eligibility check, inverted. The real-style-code check additionally
    // excludes non-apparel catalogue entries (shipping/return protection
    // add-ons, etc.) -- Core never sees these since it only ever iterates
    // curated CORE_GROUPS-tagged rows, but High Stock scans everything
    // non-Core in the catalogue, so it needs its own guard.
    const amGroups = new Map(); // productCode -> style_code[]
    for (const [styleCode, details] of am.amDetails.entries()) {
      if (details.isCore || apparelmagic.isAdExcludedCategory(details)) continue;
      if (!apparelmagic.isWndrrStyleCode(styleCode)) continue;
      const productCode = apparelmagic.deriveProductCode(styleCode);
      if (!amGroups.has(productCode)) amGroups.set(productCode, []);
      amGroups.get(productCode).push(styleCode);
    }

    // 150+ SOH only makes a product eligible -- ranking below decides
    // whether it actually deserves attention.
    const eligibleFamilies = [];
    for (const [productCode, styleCodes] of amGroups) {
      let soh = 0;
      for (const styleCode of styleCodes) soh += am.amStock.get(styleCode) ?? 0;
      if (soh >= minSoh) eligibleFamilies.push({ productCode, styleCodes });
    }

    if (!eligibleFamilies.length) return res.json(emptyResponse());

    // Check what's already locally tracked BEFORE inserting anything, so a
    // family that's excluded below never causes a wasted insert attempt.
    const eligibleStyleCodes = eligibleFamilies.flatMap((f) => f.styleCodes);
    const preCheckResult = await pool.query(
      `SELECT * FROM styles WHERE style_code = ANY($1::text[])`,
      [eligibleStyleCodes]
    );
    const preCheckByCode = new Map(preCheckResult.rows.map((s) => [s.style_code, s]));

    // Drop a whole family if any member is already locally tracked as
    // Core (the team's own explicit call, which -- per Core's own
    // established "never auto-changes an existing row's tier" rule --
    // persists even if AM's live category has since drifted) or already
    // tied to an Upcoming/Past Drop (that product already has its own
    // recommendation flow via Drops -- don't show it in two places at
    // once). Never touches an existing row either way.
    const families = eligibleFamilies.filter((f) =>
      f.styleCodes.every((code) => {
        const local = preCheckByCode.get(code);
        if (!local) return true;
        return local.tier !== 'core_proven' && local.drop_id == null;
      })
    );

    if (!families.length) return res.json(emptyResponse());

    // Sync local styles rows ONLY for the surviving families' codes that
    // don't already have one -- scoped this way (unlike Core's
    // whole-catalogue sync) because "not Core" could be thousands of SKUs
    // that will never be shown; only the ones that already passed the SOH
    // filter and aren't already excluded need a local id for the
    // creative_assets FK a "+ Shoot This Week" hand-off requires. Same
    // idempotent pattern as syncCoreStylesFromAm -- 'new_drop' is the only
    // other tier value the styles table's CHECK constraint allows, and
    // it's the mechanistically correct one too: rules.js's
    // assertCanEnterFilming already requires a 'new_drop'-tiered style to
    // use a tested_proven concept or an explicit deliberate-trial flag to
    // reach Filming, which is exactly "don't auto-assume a New Concept."
    const survivingCodes = families.flatMap((f) => f.styleCodes);
    for (const styleCode of survivingCodes) {
      if (preCheckByCode.has(styleCode)) continue;
      const details = am.amDetails.get(styleCode);
      await pool.query(
        `INSERT INTO styles (style_code, name, tier) VALUES ($1, $2, 'new_drop') ON CONFLICT (style_code) DO NOTHING`,
        [styleCode, details?.productName || styleCode]
      );
    }

    const localStylesResult = await pool.query(
      `SELECT * FROM styles WHERE style_code = ANY($1::text[])`,
      [survivingCodes]
    );
    const localStyleByCode = new Map(localStylesResult.rows.map((s) => [s.style_code, s]));

    const styleIds = survivingCodes
      .map((code) => localStyleByCode.get(code)?.id)
      .filter((id) => id != null);

    // Same conditional sales-cache guard coreProducts.js uses -- only await
    // the ~730-request crawl once it's already landed via warmAmCache() at
    // boot, otherwise skip for this request rather than blocking the page.
    // The freshness query below deliberately does NOT filter on
    // concept_classification the way Core's does -- Core only wants "days
    // since a genuinely NEW concept went live" (its whole point is testing
    // new concepts), but High Stock explicitly should not assume a Proven
    // Winner reshoot going live doesn't count -- it does. Filtering it out
    // would make a product the team just addressed via a Proven Winner
    // still show as "never tested"/stale, exactly the auto-New-Concept
    // assumption this feature must avoid.
    const salesReady = apparelmagic.getAmCacheStatus().sales.hasData;
    const [salesByStyle, freshnessRows, assetCounts] = await Promise.all([
      salesReady ? apparelmagic.getSalesByStyle() : Promise.resolve(new Map()),
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
    ]);
    const lastLiveByStyleId = new Map(freshnessRows.rows.map((r) => [r.style_id, r.last_live_at]));

    // A family with a mix of Core and non-Core colourways only shows its
    // non-Core colourways here (their Core siblings already appear under
    // Core) -- same behaviour Core itself has for the reverse case, so
    // total family SOH shown can understate the true family total. Existing
    // pattern, not a new inconsistency.
    const rawProducts = families.map(({ productCode, styleCodes }) => {
      let soh = 0;
      let onOrder = 0;
      let qty7 = 0;
      let qty30 = 0;
      let qty365 = 0;
      let currentCoverage = 0;
      let lastLiveAt = null;
      const colours = [];

      for (const styleCode of styleCodes) {
        const local = localStyleByCode.get(styleCode);
        if (!local) continue; // guards a sync race; shouldn't happen given the insert above

        const styleSoh = am.amStock.get(styleCode) ?? 0;
        soh += styleSoh;
        const styleOnOrder = am.amOnOrder ? am.amOnOrder.get(styleCode) ?? 0 : 0;
        onOrder += styleOnOrder;

        const sales = salesByStyle.get(styleCode);
        if (sales) { qty7 += sales.qty7; qty30 += sales.qty30; qty365 += sales.qty365; }

        currentCoverage += assetCounts.get(local.id) || 0;

        const liveAt = lastLiveByStyleId.get(local.id);
        if (liveAt && (!lastLiveAt || liveAt > lastLiveAt)) lastLiveAt = liveAt;

        const details = am.amDetails.get(styleCode);
        const sizing = apparelmagic.resolveStyleSizing(am.amDetails, am.amSizeRanges, styleCode);
        colours.push({
          style_id: local.id,
          style_code: styleCode,
          image_url: details?.imageUrl || null,
          soh: styleSoh,
          on_order: styleOnOrder,
          colour_label: apparelmagic.resolveColourLabel(am.amDetails, styleCode),
          sizes: sizing.sizes,
          sizing_system: sizing.system,
        });
      }

      if (!colours.length) return null;

      const firstCode = styleCodes[0];
      const firstLocal = localStyleByCode.get(firstCode);
      const firstDetails = am.amDetails.get(firstCode);
      const vel7 = qty7; // already a weekly figure (7 days)
      const vel30 = qty30 / 30 * 7;
      const vel365 = qty365 / 365 * 7; // same trailing-year weekly baseline pattern coreProducts.js uses
      const weeksCover = vel30 > 0 ? +(soh / vel30).toFixed(1) : null;
      const daysSinceLastLive = lastLiveAt
        ? Math.floor((Date.now() - new Date(lastLiveAt).getTime()) / 86400000)
        : null;

      return {
        product_code: productCode,
        product_name: firstDetails?.productName || firstLocal?.name || firstCode,
        category: firstDetails?.category || 'UNCATEGORISED',
        colours,
        soh,
        on_order: am.amOnOrder ? onOrder : null,
        vel7: +vel7.toFixed(1),
        vel30: +vel30.toFixed(1),
        vel365: +vel365.toFixed(1),
        weeks_cover: weeksCover,
        current_coverage: currentCoverage,
        days_since_last_creative: daysSinceLastLive,
      };
    }).filter(Boolean);

    const products = rawProducts.map((p) => {
      const { priority_score, sell_through_pct, sales_trend, creative_status_label } = scoreHighStock({
        soh: p.soh,
        onOrder: p.on_order || 0,
        vel7: p.vel7,
        vel30: p.vel30,
        vel365: p.vel365,
        weeksCover: p.weeks_cover,
        currentCoverage: p.current_coverage,
        daysSinceLastLive: p.days_since_last_creative,
      });
      return { ...p, priority_score, sell_through_pct, sales_trend, creative_status_label };
    });
    products.sort((a, b) => b.priority_score - a.priority_score);

    res.json({
      products,
      min_soh: minSoh,
      recommendations_shown: recommendationsShown,
      apparelmagic: { configured: am.amConfigured, error: am.amError },
      sales_data: apparelmagic.getAmCacheStatus().sales,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
