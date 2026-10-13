// Every tunable number behind the weekly VIDEO recommendations, in one place, with limits. Stored (partially) in planning_settings.creative_planning_config;
// a missing key falls back to the default here. NOTHING in this file is a performance benchmark: the approved CPA / Frequency targets live in Meta Performance
// Settings and are only READ. These are (a) how much evidence is enough before judging an ad, and (b) how the weekly plan weighs and sizes things. Defaults
// are PROVISIONAL starting points to tune against real weeks; each is explained so non-technical staff can change them with confidence.
const perf = require('./productAdPerformance');

const ALLOCATION = {
  // how many videos a product with a given need and demand gets (rows = how much new creative it needs, columns = how worth investing in it is)
  videos_high_need_strong: 5, videos_high_need_ok: 4, videos_high_need_low: 2,
  videos_medium_need_strong: 3, videos_medium_need_ok: 2, videos_medium_need_low: 1,
  videos_low_need_strong: 2, videos_low_need_ok: 1, videos_low_need_low: 0,
  max_videos_per_product: 6,
  shoot_now_min_score: 45,   // combined points needed to be "Shoot now"
  coming_up_min_score: 25,
  monitor_min_score: 10,
  strong_sales_percentile: 70, // a product is "strong" when its 30-day units are at or above this percentile of launched, in-stock products
  weak_sales_percentile: 30,
  creative_age_stale_days: 45, // newest running creative older than this = ageing
  creative_age_old_days: 90,
  pipeline_lookback_weeks: 6,  // videos from earlier weeks still in production count as creative on the way
  // a product that already has a lot of running creative is not given more just because it sells (Batch 13)
  creative_saturation_count: 12, // this many UNIQUE creatives running = well supplied
  videos_when_saturated: 2,      // most videos a well-supplied product gets unless its creative is fatigued
  slow_mover_weeks_cover: 26,    // stock that would take longer than this to sell at the current pace (weeks) = slow mover
  videos_slow_mover: 1,          // most videos for a slow mover (creative may not be what is holding it back)
  // launch status (Batch 13): what counts as proof that a product has gone on sale
  launch_date_verified: 1,       // 1 = WNDRR has confirmed the ApparelMagic mid_code field IS the official launch date (default). 0 = a passed date does not prove a launch; a future date always keeps a product out
  launch_sales_confirms: 0,      // 1 = sustained sales alone count as launched when ApparelMagic has no launch date (0 = such products wait for a person to confirm)
  launch_sales_min_units: 10,    // units sold needed before sales are even considered
  launch_settle_days: 0,         // optional extra check: a launch date that passed less than this many days ago with no sales yet is verified, not assumed (0 = off: a passed official date means launched)
  new_drop_days: 60,             // a product that launched within this many days is labelled a New drop
  // Opportunities (Batch 14: Core / High Stocks). PROVISIONAL starting points to tune against real weeks; none is a performance benchmark (those are in Meta Performance settings).
  test_period_days: 14,          // a new creative is "still testing" this many days after it was created: it is not judged and no more creative is recommended on its account
  recent_creative_days: 30,      // a creative newer than this is "recently launched" (so a clear weak result is "recently launched and underperforming")
  stale_creative_days: 90,       // a creative older than this that is not performing is "old / stale"
  opp_min_recent_units: 8,       // units sold in the last 30 days before a product counts as having demand today
  opp_min_stock_units: 30,       // sellable units below this: never a creative recommendation (nothing to sell)
  revival_decline_pct: 50,       // High Stocks: the last 28 days sell below this % of the product's first 28 days = momentum lost
  revival_min_age_days: 56,      // High Stocks: a product must have sold for at least this many days so its first and latest 28 days do not overlap
  revival_min_cover_weeks: 6,    // High Stocks: weeks of stock at the current pace needed to justify more creative investment
  // Batch 27: current demand, stock sufficiency, season, Protect Momentum, creative concentration, data quality. PROVISIONAL starting points (explained in
  // docs/planning-intelligence.md); every one is editable in Settings, and none is a performance benchmark (those stay in Meta Performance settings).
  demand_steady_units: 20,       // units in 30 days (or the launch-normalised equivalent) from which demand counts as steady; below it demand is "weak"
  demand_strong_units: 50,       // units in 30 days from which demand counts as strong
  trend_pct: 25,                 // the last 7 days must differ from the weekly pace before them by at least this % to be called improving / weakening ...
  trend_min_weekly_units: 2,     // ... AND by at least this many units a week (so 2 -> 1 is noise, 100 -> 70 is not)
  revival_min_recent_units: 20,  // High Stocks: units in the last 30 days a historically strong product must still sell to be a realistic revival
  revival_min_pace_pct: 10,      // High Stocks: below this % of its own launch pace there is too little left to revive
  stock_min_cover_weeks: 4,      // weeks of stock at the current pace needed for creative to pay off (the stock must outlast production and a test)
  stock_overstock_weeks: 26,     // beyond this many weeks of cover the stock earns fewer points (it is a slow mover, not a reason to shoot)
  stock_excess_weeks: 52,        // beyond this many weeks with only weak demand the product is not recommended: creative is not the constraint
  season_override_units: 60,     // an out-of-season product qualifies only when it still sells at least this many units in 30 days ...
  season_pattern_index: 125,     // ... and a sales-pattern "in season" reading needs at least this index (% of its usual month) to overrule the Australian category rule
  momentum_window_days: 60,      // Protect Momentum: a product is a recent launch for this many days after its official (mid_code) launch date
  momentum_min_days_live: 5,     // Protect Momentum: days on sale needed before launch sales are judged (fewer is too early to normalise)
  concentration_share_pct: 80,   // one creative carrying at least this % of the product's spend is "concentrated" ...
  concentration_min_spend: 300,  // ... once the product has spent at least this much in the window (a share of $40 means nothing)
  meaningful_share_pct: 10,      // a creative has "meaningful delivery" at this % of the product's spend (and at least the minimum spend to judge)
  min_distinct_concepts: 2,      // meaningful creatives should span at least this many distinct concepts
  concept_known_pct: 70,         // concept diversity is judged only when this % of meaningful spend is on creatives with a concept recorded
  sales_discrepancy_pct: 35,     // the ApparelMagic and Shopify 28-day figures disagree when they differ by this % ...
  sales_discrepancy_min_units: 10, // ... and by at least this many units
  priority_high_min: 65,         // score for High
  priority_medium_min: 45,       // score for Medium (below it: Low)
};
const ALLOC_LIMITS = {
  videos_high_need_strong: [0, 20], videos_high_need_ok: [0, 20], videos_high_need_low: [0, 20], videos_medium_need_strong: [0, 20], videos_medium_need_ok: [0, 20], videos_medium_need_low: [0, 20],
  videos_low_need_strong: [0, 20], videos_low_need_ok: [0, 20], videos_low_need_low: [0, 20], max_videos_per_product: [1, 20], shoot_now_min_score: [10, 150], coming_up_min_score: [5, 150], monitor_min_score: [0, 100],
  strong_sales_percentile: [50, 95], weak_sales_percentile: [5, 50], creative_age_stale_days: [14, 365], creative_age_old_days: [30, 730], pipeline_lookback_weeks: [1, 26],
  creative_saturation_count: [4, 100], videos_when_saturated: [0, 20], slow_mover_weeks_cover: [8, 104], videos_slow_mover: [0, 20],
  test_period_days: [3, 60], recent_creative_days: [7, 120], stale_creative_days: [30, 365], opp_min_recent_units: [1, 500], opp_min_stock_units: [0, 2000],
  revival_decline_pct: [10, 95], revival_min_age_days: [28, 365], revival_min_cover_weeks: [1, 52],
  demand_steady_units: [2, 500], demand_strong_units: [5, 2000], trend_pct: [5, 90], trend_min_weekly_units: [0, 100], revival_min_recent_units: [1, 500], revival_min_pace_pct: [0, 95],
  stock_min_cover_weeks: [0, 26], stock_overstock_weeks: [4, 104], stock_excess_weeks: [8, 260], season_override_units: [5, 1000], season_pattern_index: [110, 300],
  momentum_window_days: [14, 180], momentum_min_days_live: [1, 28], concentration_share_pct: [50, 99], concentration_min_spend: [0, 5000], meaningful_share_pct: [1, 50], min_distinct_concepts: [1, 10],
  concept_known_pct: [10, 100], sales_discrepancy_pct: [10, 200], sales_discrepancy_min_units: [1, 500], priority_high_min: [30, 100], priority_medium_min: [10, 99],
  launch_date_verified: [0, 1], launch_sales_confirms: [0, 1], launch_sales_min_units: [1, 1000], launch_settle_days: [0, 90], new_drop_days: [14, 180],
};
const ALLOC_LABEL = {
  videos_high_need_strong: 'High need + strong demand: videos', videos_high_need_ok: 'High need + steady demand: videos', videos_high_need_low: 'High need + weak demand: videos',
  videos_medium_need_strong: 'Medium need + strong demand: videos', videos_medium_need_ok: 'Medium need + steady demand: videos', videos_medium_need_low: 'Medium need + weak demand: videos',
  videos_low_need_strong: 'Low need + strong demand: videos', videos_low_need_ok: 'Low need + steady demand: videos', videos_low_need_low: 'Low need + weak demand: videos',
  max_videos_per_product: 'Most videos for any one product', shoot_now_min_score: 'Points needed for "Shoot now"', coming_up_min_score: 'Points needed for "Coming up"', monitor_min_score: 'Points needed for "Monitor"',
  strong_sales_percentile: 'Strong sales = top % of products by 30-day units', weak_sales_percentile: 'Weak sales = bottom % of products by 30-day units',
  creative_age_stale_days: 'Creative is ageing after (days)', creative_age_old_days: 'Creative is old after (days)', pipeline_lookback_weeks: 'Count videos still in production from the last (weeks)',
  creative_saturation_count: 'Well supplied once this many unique creatives are running', videos_when_saturated: 'Most videos for a well-supplied product (unless its creative is fatigued)',
  slow_mover_weeks_cover: 'Slow mover when stock would last longer than (weeks)', videos_slow_mover: 'Most videos for a slow mover',
  test_period_days: 'A new creative is "still testing" for (days after it was created)', recent_creative_days: 'A creative is "recently launched" for (days)', stale_creative_days: 'A non-performing creative older than this is "old" (days)',
  opp_min_recent_units: 'Units sold in the last 30 days for a product to count as having demand', opp_min_stock_units: 'Sellable units needed before creative is recommended',
  revival_decline_pct: 'High Stocks: momentum lost when the last 28 days sell below this % of the first 28 days', revival_min_age_days: 'High Stocks: product must have been selling for at least (days)', revival_min_cover_weeks: 'High Stocks: weeks of stock needed to justify a refresh',
  demand_steady_units: 'Demand is steady from this many units in 30 days', demand_strong_units: 'Demand is strong from this many units in 30 days', trend_pct: 'Sales trend: change in the last 7 days against the pace before it (%)', trend_min_weekly_units: 'Sales trend: and by at least this many units a week',
  revival_min_recent_units: 'High Stocks: units in the last 30 days still needed to be a realistic revival', revival_min_pace_pct: 'High Stocks: lowest % of launch pace worth reviving',
  stock_min_cover_weeks: 'Weeks of stock needed at the current pace for creative to pay off', stock_overstock_weeks: 'Weeks of cover beyond which stock is a slow mover (fewer points)', stock_excess_weeks: 'Weeks of cover beyond which weak sellers are not recommended',
  season_override_units: 'Out of season: units in 30 days needed for an exception', season_pattern_index: 'Sales pattern index (% of usual month) needed to overrule the category season rule',
  momentum_window_days: 'Protect Momentum: days after the official launch a product counts as a recent launch', momentum_min_days_live: 'Protect Momentum: days on sale before launch sales are judged',
  concentration_share_pct: 'Concentration: share of spend on one creative (%)', concentration_min_spend: 'Concentration: spend needed in the window ($)', meaningful_share_pct: 'A creative has meaningful delivery from this share of spend (%)',
  min_distinct_concepts: 'Distinct concepts wanted among meaningful creatives', concept_known_pct: 'Share of spend with a concept recorded before diversity is judged (%)',
  sales_discrepancy_pct: 'Sales sources disagree when they differ by (%)', sales_discrepancy_min_units: 'Sales sources disagree when they differ by at least (units)', priority_high_min: 'Score for High priority', priority_medium_min: 'Score for Medium priority',
  launch_date_verified: 'ApparelMagic mid_code is the OFFICIAL launch date (1 = confirmed by WNDRR, 0 = treat as unverified: a passed date is not proof)', launch_sales_confirms: 'Sales alone confirm a launch (1 = yes, 0 = a person confirms)', launch_sales_min_units: 'Units sold before sales count as launch evidence',
  launch_settle_days: 'Optional: check a launch date that passed less than this many days ago with no sales (days, 0 = off)', new_drop_days: 'A product is a New drop for this many days after launch',
};

const DEFAULTS = { ...perf.DEFAULTS, ...ALLOCATION };
const LIMITS = { ...perf.LIMITS, ...ALLOC_LIMITS };
const LABEL = { ...perf.LABEL, ...ALLOC_LABEL };

// validate + merge. Unknown keys are rejected; out-of-range values are reported and ignored (the default stays).
function resolve(stored = {}) {
  const issues = [];
  const out = { ...DEFAULTS };
  Object.keys(stored || {}).forEach((k) => {
    if (!(k in DEFAULTS)) { issues.push(`${k} is not a setting`); return; }
    const v = Number(stored[k]); const [lo, hi] = LIMITS[k];
    if (!Number.isFinite(v) || v < lo || v > hi) { issues.push(`${k} must be between ${lo} and ${hi}`); return; }
    out[k] = v;
  });
  if (out.trend_days * 2 > out.window_days) { out.trend_days = Math.floor(out.window_days / 2); issues.push('trend_days was reduced so two halves fit in the window'); }
  if (out.coming_up_min_score >= out.shoot_now_min_score) { out.coming_up_min_score = Math.max(5, out.shoot_now_min_score - 5); issues.push('coming_up_min_score must be below shoot_now_min_score'); }
  if (out.monitor_min_score >= out.coming_up_min_score) { out.monitor_min_score = Math.max(0, out.coming_up_min_score - 5); issues.push('monitor_min_score must be below coming_up_min_score'); }
  if (out.priority_medium_min >= out.priority_high_min) { out.priority_medium_min = Math.max(10, out.priority_high_min - 10); issues.push('priority_medium_min must be below priority_high_min'); }
  if (out.demand_steady_units >= out.demand_strong_units) { out.demand_steady_units = Math.max(2, out.demand_strong_units - 5); issues.push('demand_steady_units must be below demand_strong_units'); }
  if (out.stock_overstock_weeks >= out.stock_excess_weeks) { out.stock_overstock_weeks = Math.max(4, out.stock_excess_weeks - 8); issues.push('stock_overstock_weeks must be below stock_excess_weeks'); }
  if (out.weak_sales_percentile >= out.strong_sales_percentile) { out.weak_sales_percentile = Math.max(5, out.strong_sales_percentile - 10); issues.push('weak_sales_percentile must be below strong_sales_percentile'); }
  return { config: out, issues };
}

// the settings the UI shows, grouped the way staff think about them, with the default and the allowed range of each. `advanced` groups are collapsed in Settings.
const GROUPS = [
  { key: 'opportunities', title: 'Opportunities (Core and High Stocks)', help: 'When a product counts as needing new creative this week. A new creative is given time to gather data before another is recommended; products that are out of stock, out of season or not selling are not recommended. These are starting points to tune, not performance targets.', keys: ['min_performing_creatives', 'test_period_days', 'recent_creative_days', 'stale_creative_days', 'opp_min_recent_units', 'opp_min_stock_units', 'strong_sales_percentile', 'weak_sales_percentile'] },
  { key: 'demand', title: 'Demand, stock and season', help: 'How much current selling is needed before creative is worth making, how stock cover is judged (enough stock is needed; a lot of stock is not a reason), and when an out-of-season product can still qualify. Absolute units matter as well as percentage change.', keys: ['demand_steady_units', 'demand_strong_units', 'trend_pct', 'trend_min_weekly_units', 'stock_min_cover_weeks', 'stock_overstock_weeks', 'stock_excess_weeks', 'season_override_units', 'season_pattern_index', 'priority_high_min', 'priority_medium_min'] },
  { key: 'momentum', title: 'Protect Momentum (recent launches)', help: 'Recent launches that are selling well but have too little effective creative. Age comes from the official ApparelMagic launch date; sales are normalised per day so a half-complete period is never compared with a full one.', keys: ['momentum_window_days', 'momentum_min_days_live'] },
  { key: 'concentration', title: 'Creative concentration, diversity and data quality', help: 'When one creative carries most of a product\'s delivery, when the creative is too similar, and when two sales sources disagree.', keys: ['concentration_share_pct', 'concentration_min_spend', 'meaningful_share_pct', 'min_distinct_concepts', 'concept_known_pct', 'sales_discrepancy_pct', 'sales_discrepancy_min_units'] },
  { key: 'revival', title: 'High Stocks revival', help: 'How a proven (Platinum or Rocket) product is judged to have lost momentum and be worth a creative refresh.', keys: ['revival_decline_pct', 'revival_min_age_days', 'revival_min_cover_weeks', 'revival_min_recent_units', 'revival_min_pace_pct'] },
  { key: 'evidence', title: 'Performance evidence', help: 'How much spend and time an ad needs before it is judged against the approved benchmarks. The benchmarks themselves are in Settings, Meta Performance.', keys: ['window_days', 'trend_days', 'min_spend', 'min_impressions', 'min_trend_spend', 'trend_decline_pct'] },
  { key: 'launch', title: 'Launch status', help: 'What counts as proof that a product has officially launched. WNDRR has confirmed that the ApparelMagic mid_code is the official launch date: a future date keeps a product out of every recommendation, a passed date means launched (unless a person overrides it), and neither Shopify nor sales history can override a future date. Products with a missing or unreadable date and no other evidence are listed for verification, not recommended.', keys: ['launch_date_verified', 'launch_sales_confirms', 'launch_sales_min_units', 'launch_settle_days', 'new_drop_days'] },
];
const describe = (config) => GROUPS.map((g) => ({ key: g.key, title: g.title, help: g.help, advanced: !!g.advanced, fields: g.keys.map((k) => ({ key: k, label: LABEL[k], value: config[k], default: DEFAULTS[k], min: LIMITS[k][0], max: LIMITS[k][1] })) }));

module.exports = { DEFAULTS, LIMITS, LABEL, GROUPS, resolve, describe };
