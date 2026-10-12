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
  testing: 'Still testing', recent_performing: 'Recent, performing', recent_weak: 'Recent, underperforming', performing: 'Established, performing', declining: 'Previously performing, declining',
  weak: 'Underperforming', stale: 'Old / stale', unrated: 'No approved benchmark', unjudged: 'Too little data',
};

function ageDays(created, today) {
  if (!created) return null;
  const a = Math.floor((toMs(today) - toMs(created)) / DAY);
  return Number.isFinite(a) ? Math.max(0, a) : null;
}

// pure: ONE creative → { phase, label, age_days }
function phaseOf(c, today, cfg) {
  const test = cfg.test_period_days; const recent = cfg.recent_creative_days; const stale = cfg.stale_creative_days;
  const age = ageDays(c.created, today);
  const out = (phase) => ({ phase, label: LABEL[phase], age_days: age });
  switch (c.state) {
    case 'performing': return out(age !== null && age <= recent ? 'recent_performing' : 'performing');
    case 'declining': return out('declining');
    case 'underperforming': return out(age !== null && age <= recent ? 'recent_weak' : age !== null && age >= stale ? 'stale' : 'weak');
    case 'unrated': return out('unrated');
    case 'insufficient':
    case 'unavailable':
    default:
      if (age !== null && age <= test) return out('testing');
      if (age !== null && age >= stale) return out('stale');
      return out('unjudged');
  }
}

// pure: a product's creatives → counts + the facts the explanations quote.
//   uploads  concepts that WNDRR's own production records show as uploaded: [{ date, concept }] (a Meta ad may not be matched to the product yet)
function summarize(creatives, today, cfg, { uploads = [] } = {}) {
  const list = (creatives || []).map((c) => ({ ...c, ...phaseOf(c, today, cfg) }));
  const by = { testing: 0, recent_performing: 0, recent_weak: 0, performing: 0, declining: 0, weak: 0, stale: 0, unrated: 0, unjudged: 0 };
  list.forEach((c) => { by[c.phase] += 1; });
  const ages = list.map((c) => c.age_days).filter((a) => a !== null);
  const upAges = (uploads || []).map((u) => ageDays(u.date, today)).filter((a) => a !== null);
  const testing = list.filter((c) => c.phase === 'testing');
  const testingUntil = testing.map((c) => addDaysYmd(c.created, cfg.test_period_days)).sort().pop() || null;
  const recentUploads = (uploads || []).filter((u) => { const a = ageDays(u.date, today); return a !== null && a <= cfg.test_period_days; });
  const uploadTestingUntil = recentUploads.map((u) => addDaysYmd(u.date, cfg.test_period_days)).sort().pop() || null;
  const newestMeta = ages.length ? Math.min(...ages) : null;
  const newestUpload = upAges.length ? Math.min(...upAges) : null;
  const newest = [newestMeta, newestUpload].filter((a) => a !== null);
  return {
    list, by, total: list.length,
    // "weak" = judged over the approved benchmark with enough data, whatever its age (an old over-limit creative is both weak and stale); "stale" here is the rest
    // of the old ones: too little delivery to judge, so they are not called weak
    performing: by.performing + by.recent_performing,
    weak: list.filter((c) => c.state === 'underperforming').length, declining: by.declining,
    stale: list.filter((c) => c.phase === 'stale' && c.state !== 'underperforming').length, testing: by.testing, unrated: by.unrated, unjudged: by.unjudged,
    clear_weak: list.filter((c) => c.state === 'underperforming' && c.severity !== 'marginal').length,
    newest_age_days: newest.length ? Math.min(...newest) : null,
    newest_source: newest.length === 0 ? null : (newestUpload !== null && (newestMeta === null || newestUpload <= newestMeta)) ? 'production' : 'meta',
    testing_until: [testingUntil, uploadTestingUntil].filter(Boolean).sort().pop() || null,
    recent_uploads: recentUploads.length,
  };
}

module.exports = { LABEL, ageDays, phaseOf, summarize, addDaysYmd };
