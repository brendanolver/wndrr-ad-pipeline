// Core creative plan -- every threshold in one place (the shared Creative
// Opportunities thresholds -- freshness bands, seller tiers, concept evidence
// rules -- stay in creativeOpportunitiesConfig.js and are reused as-is).
//
// All values are PROVISIONAL starting points to tune against real data.
module.exports = {
  VERSION: 1,

  // HARD eligibility gate: a CORE product family with fewer sellable units than this
  // (ApparelMagic qty_avail_sell, summed across every colourway and every season code
  // of the family) is never recommended for a shoot. Unknown stock = not eligible.
  STOCK: { min_sellable_units: 30 },

  // Size availability is a WARNING only (never a gate yet). A size counts as available at
  // `min_units_per_size` or more units summed across colours; the run's outer
  // `core_trim` share at each end is ignored when judging the "middle" sizes.
  //   limited: a middle size is low/sold out, or fewer than `limited_share` of sizes available
  //   broken:  two or more middle sizes low/sold out, or fewer than `broken_share` available
  SIZE: { min_units_per_size: 3, core_trim: 0.2, limited_share: 0.6, broken_share: 0.5, min_sizes_to_judge: 3 },

  // Creative history can only be trusted from the period every Meta ad was reviewed/matched.
  // Older creative is counted only where an ad was matched, so absence there is "unknown".
  HISTORY: { reliable_days: 90 },

  // "Usable" creative = distinct creatives running (ACTIVE) or with spend in the last 30 days.
  // A strong seller needs at least this many to count as covered.
  USABLE_MIN_CREATIVES: 3,

  // Poor sales despite this many NEW creatives in the evidence window = testing has been done:
  // recommend holding off rather than shooting more.
  HOLD: { min_new_creatives_90d: 3 },

  // Meta performance label (human wording; numbers stay admin-only).
  META_LABEL: { min_spend_for_judgement: 50, strong_cpa_ratio: 0.9, weak_cpa_ratio: 1.5, weak_min_spend_no_purchases: 100 },

  LIMITS: { evidence_creatives: 8, concept_evidence_ads: 4, concept_example_products: 3, max_try_concept_total: 6, visible_cards: 12 },
};
