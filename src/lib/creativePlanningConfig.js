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
};
const ALLOC_LIMITS = {
  videos_high_need_strong: [0, 20], videos_high_need_ok: [0, 20], videos_high_need_low: [0, 20], videos_medium_need_strong: [0, 20], videos_medium_need_ok: [0, 20], videos_medium_need_low: [0, 20],
  videos_low_need_strong: [0, 20], videos_low_need_ok: [0, 20], videos_low_need_low: [0, 20], max_videos_per_product: [1, 20], shoot_now_min_score: [10, 150], coming_up_min_score: [5, 150], monitor_min_score: [0, 100],
  strong_sales_percentile: [50, 95], weak_sales_percentile: [5, 50], creative_age_stale_days: [14, 365], creative_age_old_days: [30, 730], pipeline_lookback_weeks: [1, 26],
  creative_saturation_count: [4, 100], videos_when_saturated: [0, 20], slow_mover_weeks_cover: [8, 104], videos_slow_mover: [0, 20],
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
  if (out.weak_sales_percentile >= out.strong_sales_percentile) { out.weak_sales_percentile = Math.max(5, out.strong_sales_percentile - 10); issues.push('weak_sales_percentile must be below strong_sales_percentile'); }
  return { config: out, issues };
}

// the settings the UI shows, grouped the way staff think about them, with the default and the allowed range of each. `advanced` groups are collapsed in Settings.
const GROUPS = [
  { key: 'weekly', title: 'Weekly production', help: 'How much any one product can take from the week, and how earlier unfinished videos are counted. The weekly video target itself is set above.', keys: ['max_videos_per_product', 'pipeline_lookback_weeks'] },
  { key: 'coverage', title: 'Creative coverage', help: 'What enough creative means for a product, beyond the minimum number of active ads.', keys: ['min_performing_creatives', 'creative_age_stale_days', 'creative_age_old_days', 'creative_saturation_count', 'videos_when_saturated', 'slow_mover_weeks_cover', 'videos_slow_mover'] },
  { key: 'evidence', title: 'Performance evidence', help: 'How much spend and time an ad needs before it is judged against the approved benchmarks. The benchmarks themselves are in Settings, Meta Performance.', keys: ['window_days', 'trend_days', 'min_spend', 'min_impressions', 'min_trend_spend', 'trend_decline_pct'] },
  { key: 'launch', title: 'Launch status', help: 'What counts as proof that a product has officially launched. WNDRR has confirmed that the ApparelMagic mid_code is the official launch date: a future date keeps a product out of every recommendation, a passed date means launched (unless a person overrides it), and neither Shopify nor sales history can override a future date. Products with a missing or unreadable date and no other evidence are listed for verification, not recommended.', keys: ['launch_date_verified', 'launch_sales_confirms', 'launch_sales_min_units', 'launch_settle_days', 'new_drop_days'] },
  { key: 'scoring', title: 'Recommendation scoring', advanced: true, help: 'Where the Shoot now, Coming up and Monitor lines sit and how demand is ranked. Change these only after watching a few weeks of recommendations.', keys: ['shoot_now_min_score', 'coming_up_min_score', 'monitor_min_score', 'strong_sales_percentile', 'weak_sales_percentile'] },
  { key: 'videos', title: 'Video quantities', advanced: true, help: 'How many videos a product gets for each combination of need and demand.', keys: Object.keys(ALLOCATION).filter((k) => k.startsWith('videos_') && !['videos_when_saturated', 'videos_slow_mover'].includes(k)) },
];
const describe = (config) => GROUPS.map((g) => ({ key: g.key, title: g.title, help: g.help, advanced: !!g.advanced, fields: g.keys.map((k) => ({ key: k, label: LABEL[k], value: config[k], default: DEFAULTS[k], min: LIMITS[k][0], max: LIMITS[k][1] })) }));

module.exports = { DEFAULTS, LIMITS, LABEL, GROUPS, resolve, describe };
