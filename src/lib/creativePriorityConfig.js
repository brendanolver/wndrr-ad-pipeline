// Creative priority -- every threshold in one place. Like the other Planning configs these are PROVISIONAL starting points to tune against real
// results; nothing here is invented evidence about WNDRR's customers: it only says how much each already-measured fact should weigh.
module.exports = {
  VERSION: 1,

  // Creative COVERAGE: a product with fewer than this many ACTIVE Meta ads needs new creative. Editable in Settings (planning_settings.
  // min_active_ads_per_product); this is only the default and the fallback when settings cannot be read.
  MIN_ACTIVE_ADS_DEFAULT: 5,

  // Stock bands from the SAME ApparelMagic sellable units the High Stocks page and the Core plan's stock gate use.
  //   out   0 units             -> no shoot unless a confirmed restock / drop / manual priority justifies it
  //   low   under the gate      -> generally lower shoot priority
  //   ok    gate .. high        -> adequate
  //   high  at or above the High Stocks threshold (planning_settings.high_stock_min_soh, applied to the product's total units)
  STOCK_GATE_UNITS: 30,
  // On-order (open purchase orders) units that count as a CONFIRMED restock when a product is out of stock now.
  RESTOCK_MIN_ON_ORDER_UNITS: 30,

  // Points per factor. The total decides the level; hard rules below cap it.
  POINTS: {
    stock: { high: 15, ok: 8, low: -25, out: -60, unknown: 0 },
    season: { in_season: 15, coming_into_season: 20, shoulder: 0, year_round: 5, out_of_season: -25, insufficient_data: 0, unavailable: 0 },
    coverage: { zero: 20, one_two: 15, three_four: 10, ok: 0, unknown: 0 },
    sales: { strong: 15, rising_bonus: 5, neutral: 0, weak: -10, unknown: 0 },
  },
  LEVEL: { high_min: 40, medium_min: 15 },

  // Manual / business overrides. kind -> the lowest level it guarantees (it never LOWERS a level).
  OVERRIDE_KINDS: {
    upcoming_drop: { label: 'Upcoming drop', min_level: 'Medium' },
    confirmed_restock: { label: 'Confirmed restock', min_level: 'Medium' },
    major_promotion: { label: 'Major promotion', min_level: 'High' },
    strategic_launch: { label: 'Strategic launch', min_level: 'High' },
    manual_high: { label: 'Manual priority: High', min_level: 'High' },
    manual_medium: { label: 'Manual priority: Medium', min_level: 'Medium' },
    manual_low: { label: 'Manual priority: Low', max_level: 'Low' },
  },
};
