// Creative Opportunities V1 -- the ONE place every threshold lives.
//
// Nothing in creativeOpportunities.js hard-codes a number: change a value
// here and the recommendations, the evidence drawer's wording and the QA
// all follow. These are PROVISIONAL starting values (money is in the Meta
// account's own currency; days are calendar days in the Sydney reporting
// timezone) -- tune them against real data, not in the engine.
//
// Everything is deterministic and explainable: there is no model, no hidden
// score. The only numeric sort key (rank_score) is `PRIORITY_BASE[priority]
// + strength`, where `strength` (0-100) is built from the named components
// each recommendation lists under `rank.components`.

module.exports = {
  VERSION: 1,

  // ── Creative freshness (days since the product's NEWEST creative) ──────
  //   < fresh_lt          Fresh
  //   fresh_lt .. aging_lt   Aging
  //   aging_lt .. stale_lt   Stale
  //   >= stale_lt         Very stale          (no creative on record = Very stale)
  FRESHNESS: { fresh_lt: 30, aging_lt: 60, stale_lt: 120 },

  // ── Evidence windows ──────────────────────────────────────────────────
  WINDOWS: {
    evidence_days: 90, // concept / coverage / mix evidence
    recent_days: 30, // "recent" Meta activity
    fatigue_days: 14, // each side of the fatigue comparison (last 14d vs the 14d before)
  },

  // ── What counts as a creative's launch date ───────────────────────────
  // Order of preference (see launchDateOf in creativeOpportunities.js):
  //   1. the first day the ad's cumulative spend reached `meaningful_spend`
  //      (an ad that merely exists, or spent cents, has not launched);
  //   2. if that day falls within `coverage_edge_days` of the earliest stored
  //      insight (the ad was already running when stored data begins), the
  //      ad's created_time, because the true launch is unknowable and the
  //      first stored day would understate its age.
  // created_time alone is NOT used: duplicated / re-created ads reset it
  // while re-using an old creative, and drafts can sit for weeks before
  // spending.
  LAUNCH: { meaningful_spend: 50, coverage_edge_days: 2 },

  // ── Strong / weak seller (reuses the app's existing demand signals) ───
  // Primary: the Report Pipeline's sales tier -- the same Platinum/Rocket
  // tiers High Stock uses -- taken as the BEST tier across a product's
  // styles. Units come from ApparelMagic order history (the same
  // getSalesByStyle Core / High Stock use); the trend uses High Stock's own
  // salesTrendInfo (±10% dead-zone, vel365 >= 1/wk to be trusted).
  SELLER: {
    strong_tiers: ['platinum', 'rocket'],
    weak_tiers: ['dog', 'egg'],
    // a weak tier only counts once the product has real sales history, so a
    // brand-new "egg" with no sales is not called a weak seller
    weak_min_units_365d: 20,
    // fallback when the pipeline has no tier for a product / isn't configured:
    // relative rank of 30-day units among products with sales
    fallback_strong_percentile: 0.75,
    fallback_weak_percentile: 0.25,
    fallback_min_units_30d_strong: 10,
  },

  // A product is "relevant enough" for a recommendation when it sold at least
  // this many units in the last 30 days OR it had at least this much recent
  // Meta spend.
  RELEVANCE: { min_units_30d: 5, min_recent_meta_spend: 50 },

  // ── Concept evidence ("proven" needs ALL of these) ────────────────────
  // Lowest-CPA-wins is never used: a concept must clear sample size first.
  CONCEPT: {
    min_spend: 1000, // in the evidence window
    min_purchases: 10,
    min_creatives: 3, // distinct creatives running the concept
    max_cpa_ratio: 1.0, // concept CPA <= account CPA x this
    min_product_spend: 100, // allocated spend for a product to count as "used on" it
    min_products_cross_product: 3, // label "cross-product winner" at/above this
    test_min_products: 2, // a concept is only suggested for a NEW product if proven on >= this many
    weak_cpa_ratio: 1.5, // CPA above account CPA x this (with min_spend) = weak
    // a concept the product itself already ran, used as the "worked before" hint
    own_concept_min_purchases: 3,
  },

  // ── Coverage ──────────────────────────────────────────────────────────
  COVERAGE: { min_creatives_90d: 3 },

  // ── Concentration (diversify_*) ───────────────────────────────────────
  CONCENTRATION: {
    share: 0.9, // top concept / creator / media carries >= this share of 90d spend
    min_creatives: 3, // below this, coverage is the issue, not concentration
    min_product_spend: 300, // enough spend for a share to mean something
    min_field_coverage: 0.7, // share of spend whose ads actually have the field
  },

  // ── Possible creative fatigue (never uses reach / frequency) ──────────
  // Same ads, last `fatigue_days` vs the `fatigue_days` before, only ads
  // that have been spending for >= min_run_days.
  FATIGUE: {
    min_run_days: 28,
    min_impressions: 10000, // each window
    min_purchases: 3, // each window (for the CPA comparison)
    ctr_drop_pct: 25, // outbound CTR fell by at least this %
    cpa_rise_pct: 25, // CPA rose by at least this %
  },

  // ── Weak seller + stale creative ──────────────────────────────────────
  WEAK_SELLER: {
    // under-tested: creative is at least "Stale" AND 90d spend below this ("not enough to judge")
    fair_test_spend: 100,
    high_after_days: 240, // High priority at/after this age (else Medium)
  },

  // ── Priority ──────────────────────────────────────────────────────────
  //   freshen_strong_seller            strong seller; creative Stale (>= freshness.aging_lt)
  //                                      Critical  Very stale (>= stale_lt) or none on record
  //                                      High      Stale
  //   refresh_before_deprioritising    weak seller; creative Very stale / none, or Stale but under-tested
  //                                      High      >= WEAK_SELLER.high_after_days or none on record
  //                                      Medium    otherwise
  //   test_proven_concept              High if the product is a strong seller, else Medium
  //   increase_creative_coverage       High if strong seller, else Medium
  //   possible_fatigue                 High if strong seller, else Medium
  //   diversify_concept/creator/media  High if strong seller, else Medium
  PRIORITY_BASE: { Critical: 300, High: 200, Medium: 100 },
  PRIORITY_RANK: { Medium: 1, High: 2, Critical: 3 },

  // One primary staleness/coverage recommendation per product, in this order
  // (a later one is suppressed when an earlier one fired for the same product).
  PRIMARY_ORDER: ['freshen_strong_seller', 'refresh_before_deprioritising', 'increase_creative_coverage'],

  // ── Output limits (no hundreds of speculative combinations) ───────────
  LIMITS: {
    max_test_concept_total: 8,
    max_test_concept_per_product: 2,
    max_test_concept_per_concept: 3,
    evidence_ads: 10, // ads listed in an evidence drawer
  },

  // ── Dismiss / acted-on ────────────────────────────────────────────────
  //   dismissed  stays hidden until its priority OR severity materially
  //              increases (see severity in creativeOpportunities.js)
  //   acted_on   leaves the list; if the same opportunity still qualifies
  //              this many days later it returns, flagged "previously acted on"
  STATE: { acted_on_review_days: 60 },
};
