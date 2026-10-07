// Funnel-specific CPA + Frequency "health" (green / orange / red) -- PREPARED BUT INACTIVE.
//
// What a good CPA or Frequency is depends on where an ad sits in the funnel, so the rules differ for TOF, TOM and MOF.
// WNDRR has not yet supplied the targets, and NOTHING here guesses them: every target below is null, ENABLED is false, and
// classify() therefore returns null (no colour) for everything. Colour is only ever an extra signal beside the real number.
//
// To switch it on later, edit ONLY this file:
//   1. fill TARGETS for each funnel and metric with   { green: [min, max], orange: [min, max] }
//        - a value inside `green` is healthy, inside `orange` (but outside green) is "watch", anything else is red
//        - use null for an open end, e.g. CPA green: [null, 25] means "25 or less"; orange: [null, 40] means "up to 40"
//        - `orange` must contain `green` (checked by validTarget)
//   2. set ENABLED = true
// A funnel/metric with no valid target stays uncoloured on its own, so the three funnels can be switched on one by one.
// The Unknown / Mixed funnel is never judged: only the literal TOF, TOM and MOF funnels can receive a colour.
const ENABLED = false;
const RULES_VERSION = 0; // bump when WNDRR changes the targets, so the change is visible in the API

const TARGETS = {
  TOF: { cpa: null, frequency: null },
  TOM: { cpa: null, frequency: null },
  MOF: { cpa: null, frequency: null },
};
const JUDGED_FUNNELS = ['TOF', 'TOM', 'MOF'];
const METRICS = ['cpa', 'frequency'];

const inRange = (v, r) => (r[0] === null || r[0] === undefined || v >= r[0]) && (r[1] === null || r[1] === undefined || v <= r[1]);
function validTarget(t) {
  if (!t || !Array.isArray(t.green) || !Array.isArray(t.orange) || t.green.length !== 2 || t.orange.length !== 2) return false;
  const nums = [...t.green, ...t.orange].every((x) => x === null || (typeof x === 'number' && Number.isFinite(x)));
  if (!nums) return false;
  const lo = (r) => (r[0] === null ? -Infinity : r[0]);
  const hi = (r) => (r[1] === null ? Infinity : r[1]);
  return lo(t.green) <= hi(t.green) && lo(t.orange) <= hi(t.orange) && lo(t.orange) <= lo(t.green) && hi(t.orange) >= hi(t.green);
}

// 'green' | 'orange' | 'red' | null (null = no judgement). `targets`/`enabled` are injectable for tests only.
function classify(funnel, metric, value, { targets = TARGETS, enabled = ENABLED } = {}) {
  if (!enabled) return null;
  if (!JUDGED_FUNNELS.includes(funnel) || !METRICS.includes(metric)) return null; // Unknown / Mixed / anything else: no judgement
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return null;
  const t = targets[funnel] && targets[funnel][metric];
  if (!validTarget(t)) return null;
  const v = Number(value);
  if (inRange(v, t.green)) return 'green';
  if (inRange(v, t.orange)) return 'orange';
  return 'red';
}

function status({ targets = TARGETS, enabled = ENABLED } = {}) {
  const defined = {};
  JUDGED_FUNNELS.forEach((f) => { defined[f] = {}; METRICS.forEach((m) => { defined[f][m] = validTarget(targets[f] && targets[f][m]); }); });
  return { enabled: !!enabled, rules_version: RULES_VERSION, judged_funnels: JUDGED_FUNNELS, defined, active: !!enabled && JUDGED_FUNNELS.some((f) => METRICS.some((m) => defined[f][m])) };
}

module.exports = { ENABLED, RULES_VERSION, TARGETS, JUDGED_FUNNELS, classify, validTarget, status };
