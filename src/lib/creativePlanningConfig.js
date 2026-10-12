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
};
const ALLOC_LIMITS = {
  videos_high_need_strong: [0, 20], videos_high_need_ok: [0, 20], videos_high_need_low: [0, 20], videos_medium_need_strong: [0, 20], videos_medium_need_ok: [0, 20], videos_medium_need_low: [0, 20],
  videos_low_need_strong: [0, 20], videos_low_need_ok: [0, 20], videos_low_need_low: [0, 20], max_videos_per_product: [1, 20], shoot_now_min_score: [10, 150], coming_up_min_score: [5, 150], monitor_min_score: [0, 100],
  strong_sales_percentile: [50, 95], weak_sales_percentile: [5, 50], creative_age_stale_days: [14, 365], creative_age_old_days: [30, 730], pipeline_lookback_weeks: [1, 26],
};
const ALLOC_LABEL = {
  videos_high_need_strong: 'High need + strong demand: videos', videos_high_need_ok: 'High need + steady demand: videos', videos_high_need_low: 'High need + weak demand: videos',
  videos_medium_need_strong: 'Medium need + strong demand: videos', videos_medium_need_ok: 'Medium need + steady demand: videos', videos_medium_need_low: 'Medium need + weak demand: videos',
  videos_low_need_strong: 'Low need + strong demand: videos', videos_low_need_ok: 'Low need + steady demand: videos', videos_low_need_low: 'Low need + weak demand: videos',
  max_videos_per_product: 'Most videos for any one product', shoot_now_min_score: 'Points needed for "Shoot now"', coming_up_min_score: 'Points needed for "Coming up"', monitor_min_score: 'Points needed for "Monitor"',
  strong_sales_percentile: 'Strong sales = top % of products by 30-day units', weak_sales_percentile: 'Weak sales = bottom % of products by 30-day units',
  creative_age_stale_days: 'Creative is ageing after (days)', creative_age_old_days: 'Creative is old after (days)', pipeline_lookback_weeks: 'Count videos still in production from the last (weeks)',
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

// the settings the UI shows, grouped, with the default and the allowed range of each
const GROUPS = [
  { key: 'evidence', title: 'How much evidence before judging an ad', keys: ['window_days', 'trend_days', 'min_spend', 'min_impressions', 'min_trend_spend', 'trend_decline_pct', 'min_performing_creatives'] },
  { key: 'videos', title: 'How many videos per product', keys: Object.keys(ALLOCATION).filter((k) => k.startsWith('videos_') || k === 'max_videos_per_product') },
  { key: 'ranking', title: 'How products are ranked', keys: ['shoot_now_min_score', 'coming_up_min_score', 'monitor_min_score', 'strong_sales_percentile', 'weak_sales_percentile', 'creative_age_stale_days', 'creative_age_old_days', 'pipeline_lookback_weeks'] },
];
const describe = (config) => GROUPS.map((g) => ({ key: g.key, title: g.title, fields: g.keys.map((k) => ({ key: k, label: LABEL[k], value: config[k], default: DEFAULTS[k], min: LIMITS[k][0], max: LIMITS[k][1] })) }));

module.exports = { DEFAULTS, LIMITS, LABEL, GROUPS, resolve, describe };
