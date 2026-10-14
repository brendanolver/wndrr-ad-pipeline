// Creative RECENCY: where each of a product's unique creatives is in its life, so a creative that was uploaded last week is never treated like one that has
// run for six months, and a creative that has not had time to gather data is never called weak.
//
// Input: the per-creative verdicts from lib/productAdPerformance.js (state: performing | underperforming | declining | insufficient | unrated | unavailable,
// judged ONLY from the approved Meta Performance benchmarks) plus each creative's creation date (the earliest Meta created_time among its ads).
// PHASES (one per creative):
//   testing            created within the test period and not yet judged: it is still gathering data
//   recent_performing  created within the "recent" window and within the approved benchmark
//   recent_weak        created within the "recent" window and judged over the approved benchmark WITH enough data (a real result, not a guess)
//   performing         older, within the approved benchmark
//   declining          its own results have got clearly worse (a fatigue signal; relative to itself, not to a target)
//   weak               older, judged over the approved benchmark
//   stale              old (past the stale window) and not performing (weak, or too little delivery to judge)
//   unrated            enough data but no approved benchmark applies (e.g. TOF / TOM CPA): neither good nor bad
//   unjudged           too little delivery to judge and not new enough to be "testing" (an old, barely-delivering creative is `stale`; an undated one stays here)
// Nothing here invents a benchmark or a threshold for performance: the day counts are tunable windows (creativePlanningConfig), not performance targets.
const DAY = 86400000;
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const toMs = (s) => Date.parse(`${ymd(s)}T00:00:00Z`);
const addDaysYmd = (s, n) => new Date(toMs(s) + n * DAY).toISOString().slice(0, 10);

const LABEL = {
  testing: 'New: in its first days of delivery', recent_performing: 'Recent, performing', recent_weak: 'Recent, underperforming', performing: 'Established, performing', declining: 'Previously performing, declining',
  weak: 'Underperforming', stale: 'Old / stale', unrated: 'No approved benchmark', unjudged: 'Too little delivery to judge', not_delivering: 'Not currently delivering',
};
// The six conditions staff care about. A product can have creatives in several of them at once, so they are counted apart and never collapsed into one generic statement.
const CONDITION = {
  testing: 'new', recent_performing: 'performing', performing: 'performing', declining: 'fatigued', weak: 'underperforming', recent_weak: 'underperforming',
  stale: null, unrated: 'missing_benchmark', unjudged: 'insufficient_delivery', not_delivering: 'not_delivering',
};

function ageDays(created, today) {
  if (!created) return null;
  const a = Math.floor((toMs(today) - toMs(created)) / DAY);
  return Number.isFinite(a) ? Math.max(0, a) : null;
}

// WHEN did this creative start? A creation date is not a start date (an ad can be created long before it delivers, or copied), so the first day of STORED delivery is preferred. If that day is
// only where our stored history begins (first_delivery_truncated) it proves nothing about being new, so the Meta creation date is used (and disclosed). With neither, the start is unknown.
function startOf(c) {
  if (c.first_delivery && !c.first_delivery_truncated) return { date: ymd(c.first_delivery), basis: 'first_delivery' };
  if (c.created) return { date: ymd(c.created), basis: 'created' };
  if (c.first_delivery) return { date: ymd(c.first_delivery), basis: 'first_stored_delivery' };
  return { date: null, basis: null };
}

// pure: ONE creative → { phase, label, age_days, started, started_basis, condition }
function phaseOf(c, today, cfg) {
  const test = cfg.test_period_days; const recent = cfg.recent_creative_days; const stale = cfg.stale_creative_days;
  const st = startOf(c);
  const age = ageDays(st.date, today);
  const canBeNew = st.basis !== 'first_stored_delivery';
  const out = (phase) => ({ phase, label: LABEL[phase], age_days: age, started: st.date, started_basis: st.basis, condition: phase === 'stale' ? (c.state === 'underperforming' ? 'underperforming' : 'insufficient_delivery') : CONDITION[phase] });
  switch (c.state) {
    case 'performing': return out(age !== null && age <= recent && canBeNew ? 'recent_performing' : 'performing');
    case 'declining': return out('declining');
    case 'underperforming': return out(age !== null && age <= recent && canBeNew ? 'recent_weak' : age !== null && age >= stale ? 'stale' : 'weak');
    case 'unrated': return out('unrated');
    case 'unavailable': return out('not_delivering'); // no delivery stored for it in the window: it is not running, and it is not "gathering data"
    case 'insufficient':
    default:
      if (age !== null && age <= test && canBeNew) return out('testing');
      if (age !== null && age >= stale) return out('stale');
      return out('unjudged');
  }
}

// pure: a product's creatives → counts + the facts the explanations quote.
//   uploads  concepts that WNDRR's own production records show as uploaded: [{ date, concept }] (a Meta ad may not be matched to the product yet)
function summarize(creatives, today, cfg, { uploads = [] } = {}) {
  const list = (creatives || []).map((c) => ({ ...c, ads_list: Array.isArray(c.ads) ? c.ads.map((a) => a.id) : [], ...phaseOf(c, today, cfg) }));
  const by = { testing: 0, recent_performing: 0, recent_weak: 0, performing: 0, declining: 0, weak: 0, stale: 0, unrated: 0, unjudged: 0, not_delivering: 0 };
  list.forEach((c) => { by[c.phase] += 1; });
  const ages = list.map((c) => c.age_days).filter((a) => a !== null);
  // an upload that a Meta creative already shows (it began delivering from about the upload date) is the SAME creative: counted once, as that creative
  const visibleInMeta = (u) => list.some((c) => c.first_delivery && c.first_delivery >= addDaysYmd(u.date, -2));
  const upAll = (uploads || []).filter((u) => ageDays(u.date, today) !== null);
  const pendingUploads = upAll.filter((u) => ageDays(u.date, today) <= cfg.test_period_days && !visibleInMeta(u));
  const upAges = upAll.map((u) => ageDays(u.date, today));
  const testing = list.filter((c) => c.phase === 'testing');
  const testingUntil = testing.map((c) => addDaysYmd(c.started, cfg.test_period_days)).sort().pop() || null;
  const uploadTestingUntil = pendingUploads.map((u) => addDaysYmd(u.date, cfg.test_period_days)).sort().pop() || null;
  const newestMeta = ages.length ? Math.min(...ages) : null;
  const newestUpload = upAges.length ? Math.min(...upAges) : null;
  const newest = [newestMeta, newestUpload].filter((a) => a !== null);
  const conditions = { new: 0, insufficient_delivery: 0, missing_benchmark: 0, performing: 0, underperforming: 0, fatigued: 0, not_delivering: 0 };
  list.forEach((c) => { if (c.condition) conditions[c.condition] += 1; });
  const dated = list.filter((c) => c.started && c.age_days !== null).sort((a, b) => a.age_days - b.age_days)[0] || null;
  const funnelsOf = (arr) => [...new Set(arr.map((c) => c.funnel).filter(Boolean))].sort();
  return {
    list, by, total: list.length, conditions,
    // "weak" = judged over the approved benchmark with enough data, whatever its age (an old over-limit creative is both weak and stale); "stale" here is the rest
    // of the old ones: too little delivery to judge, so they are not called weak
    performing: by.performing + by.recent_performing,
    weak: list.filter((c) => c.state === 'underperforming').length, declining: by.declining,
    stale: list.filter((c) => c.phase === 'stale' && c.state !== 'underperforming').length, testing: by.testing, unrated: by.unrated, unjudged: by.unjudged, not_delivering: by.not_delivering,
    unrated_funnels: funnelsOf(list.filter((c) => c.phase === 'unrated')), unrated_without_funnel: list.filter((c) => c.phase === 'unrated' && !c.funnel).length,
    softening: list.filter((c) => c.trend && c.trend.softening).length, // worsening against itself but not credibly fatigued: shown, never counted against the ad
    clear_weak: list.filter((c) => c.state === 'underperforming' && c.severity !== 'marginal').length,
    newest_age_days: newest.length ? Math.min(...newest) : null,
    newest_source: newest.length === 0 ? null : (newestUpload !== null && (newestMeta === null || newestUpload <= newestMeta)) ? 'production' : 'meta',
    newest_started: dated ? { date: dated.started, basis: dated.started_basis, age_days: dated.age_days, created: dated.created ? ymd(dated.created) : null } : null,
    testing_until: [testingUntil, uploadTestingUntil].filter(Boolean).sort().pop() || null,
    recent_uploads: pendingUploads.length, pending_uploads: pendingUploads,
  };
}

module.exports = { LABEL, CONDITION, ageDays, startOf, phaseOf, summarize, addDaysYmd };
