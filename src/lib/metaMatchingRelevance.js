// Which ads are worth a PERSON's matching time right now?
//
// Ad Matching used to put every historical ad in one queue. The business value is
// current CORE product creative, so the human queue is split into
//   ACTIONABLE  -- worth a person's time now
//   HISTORICAL  -- not currently relevant (still stored, still searchable, still
//                  reachable through the Historical filter; nothing is deleted,
//                  hidden for good, or auto-classified)
//
// "Relevant product" here means: an ApparelMagic CORE apparel family (accessories
// excluded) with sellable stock > 0. This is deliberately NOT the Planning/Core
// "< 30 units: don't shoot new content" threshold -- that decides whether to SHOOT;
// this only decides whether existing ads still matter, and 12 units can still have
// live ads. The CORE membership / accessory exclusion / per-family stock all come
// from the same pure helpers Planning/Core uses (buildCoreFamilies, familyStock),
// read-only and unchanged.
//
// Per-ad rule (first match wins). Evidence = the matcher's product SUGGESTIONS at
// >= MEDIUM confidence (weaker hints are not treated as product evidence):
//   0. relevance data unavailable (catalogue / stock not loaded)  -> ACTIONABLE
//      (never hide anything because data is missing)
//   1. currently running: effective_status ACTIVE with spend in the last 7 days
//                                                                 -> ACTIONABLE
//   2. product evidence points at a relevant (CORE, in-stock) family -> ACTIONABLE
//   3. product evidence exists but only for non-relevant products  -> HISTORICAL
//   4. no product evidence but activity in the last 30 days        -> ACTIONABLE
//      (imperfect metadata must not make a recent ad disappear)
//   5. no product evidence and no recent activity                  -> HISTORICAL
const MEDIUM_CONFIDENCE = 0.6;

// A family whose styles have no ApparelMagic inventory record at all is a DATA gap,
// not "zero stock": it stays relevant so it is never hidden by missing data.
async function loadRelevantProducts(deps = {}) {
  const apparelmagic = require('./apparelmagic');
  const { buildCoreFamilies, familyStock } = require('./coreCreativePlan');
  const unknown = (reason) => ({ known: false, reason, relevant_codes: [], core_families: 0, relevant_families: 0, zero_stock_families: 0, stock_unknown_families: 0 });
  if (!apparelmagic.configured() && !deps.amDetails) return unknown('ApparelMagic is not configured');
  const status = deps.amStatus || apparelmagic.getAmCacheStatus();
  if (!deps.amDetails && !(status.catalogue && status.catalogue.hasData)) return unknown('The ApparelMagic product catalogue has not loaded yet');
  const amDetails = deps.amDetails || await apparelmagic.getStyleCatalogue();
  let stock;
  if (deps.stock !== undefined) stock = deps.stock;
  else stock = status.stock && status.stock.hasData ? await apparelmagic.getStockByStyle() : null;
  if (!stock) return unknown('ApparelMagic stock has not loaded yet');

  const { families } = buildCoreFamilies(amDetails);
  const codes = new Set();
  let relevant = 0;
  let zero = 0;
  let noRecord = 0;
  for (const f of families) {
    const st = familyStock(f, stock, null, []);
    if (!st.known) { noRecord += 1; f.codes.forEach((c) => codes.add(c)); continue; }
    if (st.units > 0) { relevant += 1; f.codes.forEach((c) => codes.add(c)); } else zero += 1;
  }
  return {
    known: true, reason: null, relevant_codes: [...codes].sort(),
    core_families: families.length, relevant_families: relevant, zero_stock_families: zero, stock_unknown_families: noRecord,
  };
}

// SQL building blocks. `p` supplies the parameter placeholders ($n) the caller bound:
//   rel   text[]  relevant product codes      known  boolean  relevance data usable
//   d7    date    7-day activity floor         d30    date     30-day activity floor
// Aliases the caller must provide: m = meta_ads.
const EVIDENCE_JOIN = `LEFT JOIN LATERAL (
    SELECT COALESCE(array_agg(s.value_key), '{}'::varchar[]) AS codes
      FROM meta_ad_suggestions s
     WHERE s.meta_ad_id = m.meta_ad_id AND s.field = 'product' AND s.confidence >= ${MEDIUM_CONFIDENCE}
  ) ev ON true`;

function relevanceCase(p) {
  return `(CASE
    WHEN NOT ${p.known} THEN 'actionable'
    WHEN m.effective_status = 'ACTIVE' AND EXISTS (SELECT 1 FROM meta_ad_insights_daily i WHERE i.meta_ad_id = m.meta_ad_id AND i.insight_date >= ${p.d7} AND i.spend > 0) THEN 'actionable'
    WHEN ev.codes::text[] && ${p.rel}::text[] THEN 'actionable'
    WHEN cardinality(ev.codes) > 0 THEN 'historical'
    WHEN EXISTS (SELECT 1 FROM meta_ad_insights_daily i WHERE i.meta_ad_id = m.meta_ad_id AND i.insight_date >= ${p.d30} AND (i.spend > 0 OR i.impressions > 0)) THEN 'actionable'
    ELSE 'historical' END)`;
}

// Why an ad was classified the way it was (for the analysis breakdown).
function relevanceReasonCase(p) {
  return `(CASE
    WHEN NOT ${p.known} THEN 'relevance_data_unavailable'
    WHEN m.effective_status = 'ACTIVE' AND EXISTS (SELECT 1 FROM meta_ad_insights_daily i WHERE i.meta_ad_id = m.meta_ad_id AND i.insight_date >= ${p.d7} AND i.spend > 0) THEN 'currently_running'
    WHEN ev.codes::text[] && ${p.rel}::text[] THEN 'core_in_stock_product'
    WHEN cardinality(ev.codes) > 0 THEN 'product_not_current_core_in_stock'
    WHEN EXISTS (SELECT 1 FROM meta_ad_insights_daily i WHERE i.meta_ad_id = m.meta_ad_id AND i.insight_date >= ${p.d30} AND (i.spend > 0 OR i.impressions > 0)) THEN 'recent_activity_no_product_evidence'
    ELSE 'no_evidence_and_inactive' END)`;
}

module.exports = { MEDIUM_CONFIDENCE, loadRelevantProducts, EVIDENCE_JOIN, relevanceCase, relevanceReasonCase };
