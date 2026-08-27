const express = require('express');
const { pool } = require('../db');
const apparelmagic = require('../lib/apparelmagic');
const { fetchAmData } = require('../lib/planningData');

const router = express.Router();

// v1 heuristic thresholds -- deliberately simple and hardcoded (not a
// Settings option), tunable later if the team wants finer control. See the
// Core Creative Testing plan for the reasoning behind each one.
const WEEKS_COVER_HIGH = 16;
const STALE_DAYS_RED = 21;
const STALE_DAYS_OPPORTUNITY = 14;
const VELOCITY_DECLINE_RATIO = 0.7;

// Ensures every AM catalogue style flagged isCore (AM's "AA CORE STYLES"
// group, see apparelmagic.js's CORE_GROUPS) has a local styles row --
// purely additive (INSERT ... ON CONFLICT DO NOTHING), same idempotent
// sync pattern as POST /drops/from-suggestion. Never updates an existing
// row's tier -- a style already locally tracked keeps whatever the team
// has set for it. Accessories are excluded (apparelmagic.js's
// isAdExcludedCategory, shared with Upcoming/Past Drops) -- checked
// wherever a style is considered for this feature, not just at sync time,
// so a style whose AM category changes after being locally synced still
// gets excluded live.
async function syncCoreStylesFromAm(amDetails) {
  if (!amDetails) return;
  for (const [styleCode, details] of amDetails.entries()) {
    if (!details.isCore || apparelmagic.isAdExcludedCategory(details)) continue;
    await pool.query(
      `INSERT INTO styles (style_code, name, tier) VALUES ($1, $2, 'core_proven') ON CONFLICT (style_code) DO NOTHING`,
      [styleCode, details.productName || styleCode]
    );
  }
}

// Simple tertile split of trailing-365-day units across the whole Core set
// -- a far simpler stand-in for demandplanning V2's cohort-curve tier
// model (which needs multi-year history this AM-live approach can't
// produce). Only used as one input into the attention reason below, never
// shown as a standalone rank.
function computeTierBoundaries(qty365List) {
  const sorted = [...qty365List].sort((a, b) => a - b);
  if (!sorted.length) return { low: 0, high: 0 };
  return {
    low: sorted[Math.floor(sorted.length / 3)] ?? 0,
    high: sorted[Math.floor((sorted.length * 2) / 3)] ?? 0,
  };
}
function tierForQty(qty365, boundaries) {
  if (qty365 > boundaries.high) return 'high';
  if (qty365 > boundaries.low) return 'standard';
  return 'low';
}

// Ranks candidate commercial reasons by severity (roughly: how far past its
// own threshold each one is) and returns the top 2-3, both as short chip
// labels (Priority view's compact row) and full sentences (the expanded
// detail's reasoning). Explanation only -- never affects which flag/branch
// buildAttention below has already decided; a candidate is only ever
// included when its own underlying condition is true.
function rankReasons(candidates) {
  const ranked = candidates.filter(Boolean).sort((a, b) => b.weight - a.weight).slice(0, 3);
  return { reason: ranked.map((c) => c.text).join('; '), reason_chips: ranked.map((c) => c.chip) };
}

// Simple, explainable rule-based flag -- not a black-box score, so it can
// always say why. Do not simply rank by SOH/sales alone (per the brief):
// this weighs inventory pressure, velocity trend, and creative freshness
// together, and Product Review is deliberately the simplest case (no
// commercial signal at all) rather than a fourth tier of the same scoring.
// The flag/branch thresholds below are unchanged from the original
// heuristic -- only the reason text was rebuilt, to surface specific
// commercial drivers (weeks cover, velocity decline, on-order pressure,
// creative freshness) instead of a generic template string.
function buildAttention({ sohKnown, soh, onOrder, vel7, vel30, vel365, weeksCover, daysSinceLastNewConcept, tier }) {
  if (sohKnown && !soh && !onOrder && !vel365) {
    return {
      flag: 'product_review',
      label: '⚠️ Product Review',
      reason: 'No stock, on-order, or sales activity in the last year — check this product is still active.',
      reason_chips: ['No Activity'],
    };
  }

  const neverTested = daysSinceLastNewConcept == null;
  const staleRed = neverTested || daysSinceLastNewConcept > STALE_DAYS_RED;
  const staleOpportunity = neverTested || daysSinceLastNewConcept > STALE_DAYS_OPPORTUNITY;
  const declining = vel30 > 0 && vel7 < vel30 * VELOCITY_DECLINE_RATIO;
  const declinePct = declining ? Math.round((1 - vel7 / vel30) * 100) : 0;
  const onOrderWeeks = vel30 > 0 ? onOrder / vel30 : (onOrder > 0 ? Infinity : 0);
  const highPressure = (weeksCover != null && weeksCover > WEEKS_COVER_HIGH) || (soh > 0 && declining);

  if (highPressure && staleRed) {
    const { reason, reason_chips } = rankReasons([
      weeksCover != null && weeksCover > WEEKS_COVER_HIGH
        ? { weight: (weeksCover - WEEKS_COVER_HIGH) * 4, chip: `${weeksCover} wks cover`, text: `Weeks Cover is ${weeksCover} — well above the ${WEEKS_COVER_HIGH}-week healthy range` }
        : null,
      declining
        ? { weight: 40 + declinePct, chip: `↓ Sales ${declinePct}%`, text: `Sales velocity is down ${declinePct}% over the last 7 days vs the 30-day average` }
        : null,
      onOrder > 0 && onOrderWeeks > 4
        ? { weight: 30 + Math.min(onOrderWeeks, 40), chip: `+${onOrder} Incoming`, text: `${onOrder} units on order will add further pressure` }
        : null,
      neverTested
        ? { weight: 120, chip: 'Never tested', text: 'Creative has never been tested with a new concept' }
        : { weight: daysSinceLastNewConcept, chip: `Stale ${daysSinceLastNewConcept}d`, text: `Last new concept was ${daysSinceLastNewConcept} days ago — past the ${STALE_DAYS_RED}-day review window` },
    ]);
    return { flag: 'needs_attention', label: '🔴 Needs Creative Attention', reason, reason_chips };
  }
  if (!highPressure && staleOpportunity) {
    const freshnessChip = neverTested ? 'Never tested' : `Stale ${daysSinceLastNewConcept}d`;
    const freshnessReason = neverTested
      ? 'Creative has never been tested with a new concept'
      : `Last new concept was ${daysSinceLastNewConcept} days ago — past the ${STALE_DAYS_OPPORTUNITY}-day review window`;
    const tierNote = tier === 'high' ? '; this is a top-performing Core product' : '';
    return {
      flag: 'opportunity',
      label: '🟠 New Concept Opportunity',
      reason: `Stock is healthy, so this is a good window to test something new. ${freshnessReason}${tierNote}.`,
      reason_chips: tier === 'high' ? [freshnessChip, 'Top Performer'] : [freshnessChip],
    };
  }
  return {
    flag: 'healthy',
    label: '🟢 Healthy',
    reason: 'Recent new-concept test and no inventory pressure.',
    reason_chips: ['On Track'],
  };
}

const ATTENTION_ORDER = { needs_attention: 0, opportunity: 1, healthy: 2, product_review: 3 };

router.get('/', async (req, res, next) => {
  try {
    const [am, settingsResult] = await Promise.all([
      fetchAmData(),
      pool.query('SELECT * FROM planning_settings WHERE id = 1'),
    ]);
    const settings = settingsResult.rows[0];

    await syncCoreStylesFromAm(am.amDetails);

    const stylesResult = await pool.query(`SELECT * FROM styles WHERE tier = 'core_proven' ORDER BY style_code ASC`);
    // Live category check (not just at sync time) -- a style synced before
    // this exclusion existed, or whose AM category changed since, is still
    // excluded here.
    const coreStyles = stylesResult.rows.filter((s) => {
      const details = am.amDetails ? am.amDetails.get(s.style_code) : null;
      return !apparelmagic.isAdExcludedCategory(details);
    });
    const styleIds = coreStyles.map((s) => s.id);

    // getSalesByStyle()'s cache is stale-while-revalidate EXCEPT on a true
    // cold start (no data at all yet), where it awaits the full ~730-request
    // crawl -- warmAmCache() already fires that crawl in the background at
    // boot, so only call it here once that first crawl has actually landed;
    // otherwise skip for this request (velocity/weeks-cover just come back
    // null) rather than blocking the whole Planning page load on it.
    const salesReady = apparelmagic.getAmCacheStatus().sales.hasData;
    const [salesByStyle, freshnessRows] = await Promise.all([
      am.amConfigured && salesReady ? apparelmagic.getSalesByStyle() : Promise.resolve(new Map()),
      styleIds.length
        ? pool.query(
            `SELECT ca.style_id, MAX(sh.changed_at) AS last_live_at
             FROM status_history sh
             JOIN creative_assets ca ON ca.id = sh.creative_asset_id
             WHERE sh.to_status = 'uploaded_live'
               AND ca.concept_classification = 'new_experimental'
               AND ca.style_id = ANY($1::int[])
             GROUP BY ca.style_id`,
            [styleIds]
          )
        : Promise.resolve({ rows: [] }),
    ]);
    const lastLiveByStyleId = new Map(freshnessRows.rows.map((r) => [r.style_id, r.last_live_at]));

    // Group colourways into their parent product family -- same
    // deriveProductCode used by coverage.js, no new grouping logic.
    const groups = new Map();
    for (const style of coreStyles) {
      const productCode = apparelmagic.deriveProductCode(style.style_code);
      if (!groups.has(productCode)) groups.set(productCode, []);
      groups.get(productCode).push(style);
    }

    const rawProducts = [...groups.entries()].map(([productCode, members]) => {
      let soh = 0;
      let onOrder = 0;
      let sohKnown = false;
      let qty7 = 0;
      let qty30 = 0;
      let qty365 = 0;
      let lastLiveAt = null;
      const colours = [];

      for (const style of members) {
        const styleSoh = am.amStock ? am.amStock.get(style.style_code) ?? 0 : null;
        if (styleSoh != null) { soh += styleSoh; sohKnown = true; }
        const styleOnOrder = am.amOnOrder ? am.amOnOrder.get(style.style_code) ?? 0 : null;
        if (styleOnOrder != null) onOrder += styleOnOrder;

        const sales = salesByStyle.get(style.style_code);
        if (sales) { qty7 += sales.qty7; qty30 += sales.qty30; qty365 += sales.qty365; }

        const liveAt = lastLiveByStyleId.get(style.id);
        if (liveAt && (!lastLiveAt || liveAt > lastLiveAt)) lastLiveAt = liveAt;

        const details = am.amDetails ? am.amDetails.get(style.style_code) : null;
        const sizing = apparelmagic.resolveStyleSizing(am.amDetails, am.amSizeRanges, style.style_code);
        colours.push({
          style_id: style.id,
          style_code: style.style_code,
          image_url: details?.imageUrl || null,
          soh: styleSoh,
          on_order: styleOnOrder,
          colour_label: apparelmagic.resolveColourLabel(am.amDetails, style.style_code),
          sizes: sizing.sizes,
          sizing_system: sizing.system,
        });
      }

      const first = members[0];
      const firstDetails = am.amDetails ? am.amDetails.get(first.style_code) : null;
      const vel7 = qty7; // already a weekly figure (7 days)
      const vel30 = qty30 / 30 * 7;
      const vel365 = qty365 / 365 * 7;
      const weeksCover = vel30 > 0 && sohKnown ? +(soh / vel30).toFixed(1) : null;
      const daysSinceLastNewConcept = lastLiveAt
        ? Math.floor((Date.now() - new Date(lastLiveAt).getTime()) / 86400000)
        : null;

      return {
        product_code: productCode,
        product_name: firstDetails?.productName || first.name,
        category: firstDetails?.category || 'UNCATEGORISED',
        colours,
        soh: sohKnown ? soh : null,
        on_order: am.amOnOrder ? onOrder : null,
        qty365,
        vel7: +vel7.toFixed(1),
        vel30: +vel30.toFixed(1),
        vel365: +vel365.toFixed(1),
        weeks_cover: weeksCover,
        days_since_last_new_concept: daysSinceLastNewConcept,
        sohKnown,
      };
    });

    const boundaries = computeTierBoundaries(rawProducts.map((p) => p.qty365));
    const products = rawProducts.map((p) => {
      const tier = tierForQty(p.qty365, boundaries);
      const attention = buildAttention({
        sohKnown: p.sohKnown,
        soh: p.soh || 0,
        onOrder: p.on_order || 0,
        vel7: p.vel7,
        vel30: p.vel30,
        vel365: p.vel365,
        weeksCover: p.weeks_cover,
        daysSinceLastNewConcept: p.days_since_last_new_concept,
        tier,
      });
      const { sohKnown, ...rest } = p;
      return { ...rest, tier, ...attention };
    });
    products.sort((a, b) => ATTENTION_ORDER[a.flag] - ATTENTION_ORDER[b.flag]);

    // Creative Jobs (which this used to count) is retired -- the still-active
    // concept-production pipeline is creative_assets, so a "new concept
    // planned this week" is now a new_experimental asset on a Core-tier
    // style, created this week.
    const weeklyCountResult = await pool.query(
      `SELECT COUNT(*)::int AS count FROM creative_assets ca
       JOIN styles s ON s.id = ca.style_id
       WHERE ca.concept_classification = 'new_experimental' AND s.tier = 'core_proven'
         AND ca.created_at >= date_trunc('week', now())`
    );
    const weeklyPlanned = weeklyCountResult.rows[0].count;
    const weeklyTarget = settings.weekly_new_concept_target;

    res.json({
      products,
      weekly_target: weeklyTarget,
      weekly_planned: weeklyPlanned,
      weekly_remaining: Math.max(0, weeklyTarget - weeklyPlanned),
      apparelmagic: { configured: am.amConfigured, error: am.amError },
      sales_data: apparelmagic.getAmCacheStatus().sales,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
