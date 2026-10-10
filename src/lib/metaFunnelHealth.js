// Funnel-specific "health" colours for Meta Performance -- built ONLY from the benchmarks WNDRR has approved.
//
// TWO separate things are configured here, so a missing benchmark is easy to add later:
//   COLOUR_CODED  WHICH metrics WNDRR evaluates per funnel (this decides where a colour can ever appear)
//   RULES         the numeric benchmark for each of those metrics -- null until WNDRR approves one (null = neutral)
//
// WNDRR evaluates:                              approved benchmark
//   TOF  Frequency                              green < 2 | orange 2 to 2.4 | red > 2.4         (about 4 days only)
//   TOF  Reach                                  none yet -> neutral
//   TOM  CPA                                    none yet -> neutral
//   TOM  Reach                                  none yet -> neutral
//   MOF  CPA                                    green <= $60 | orange > $60 to $72 | red > $72   (any range)
//   MOF  Reach                                  none yet -> neutral
// Every other metric (TOF CPA, TOM Frequency, MOF Frequency, spend, purchases, ...) is NOT colour-coded and always displays
// neutral, as does every Unknown / Mixed funnel. The real numbers are always shown; colour is only ever an extra signal.
//
// THE COLOUR RULE (percentage based, one rule for every metric):
//   green   meets the approved target
//   orange  misses the target by up to 20 %
//   red     misses the target by more than 20 %
// For a metric where LOWER is better (CPA, Frequency) "missing" is a value above the maximum target, measured as a percentage of
// that target: limit = target x 1.2. For a metric where HIGHER is better it is a value below the minimum target: limit = target x 0.8.
// A value better than the target (e.g. a MOF CPA under $40) stays green -- it is never penalised for being low.
// Boundaries: the target itself is green when `inclusive` (MOF CPA <= $60) and orange when not (TOF Frequency < 2, so exactly 2.0 is
// orange); the 20 % limit itself is still orange (<= 72, <= 2.4).
//
// FREQUENCY IS PERIOD-AWARE. The frequency guidance is for about 4 days; a Frequency of 2 over 30 days is not the same thing.
// A rule with period 'approx_4_days' is judged only when the SELECTED range is APPROX_4_DAYS.min_days .. max_days calendar days
// long (inclusive of both end dates, counted from the real dates, not from the preset's name). Any other length shows the number
// with no colour. Thresholds are never scaled or extrapolated.
//
// TO ADD A BENCHMARK LATER, edit RULES only (the metric is already colour-coded) using percentRule(), e.g.
//   TOF: { reach: percentRule({ direction: 'higher', target: 50000, inclusive: true }) }
// -- or supply it through META_HEALTH_RULES (below) with no code change. A rule is
// { period: 'approx_4_days' | null, green?: {min?,max?,lt?,lte?,gt?,gte?}, orange?: {...}, red?: {...} }, evaluated red -> orange ->
// green; a value matching none is neutral. To start colour-coding a new metric, add it to COLOUR_CODED too.
const ENABLED = true;
const RULES_VERSION = 3;
const TOLERANCE_PCT = 20; // orange = missing the target by up to this percentage; beyond it is red

const APPROX_4_DAYS = { target_days: 4, min_days: 3, max_days: 5 };

// which metrics WNDRR colour-codes for each funnel
const COLOUR_CODED = {
  TOF: ['frequency', 'reach'],
  TOM: ['cpa', 'reach'],
  MOF: ['cpa', 'reach'],
};

// Builds a percentage-based rule from ONE approved target.
//   direction 'lower'  (lower is better):  green at/under the target, orange up to target x (1 + pct/100), red beyond it
//   direction 'higher' (higher is better): green at/over the target,  orange down to target x (1 - pct/100), red below it
//   inclusive          is the target value itself green (true) or already orange (false)
const r6 = (x) => Math.round(x * 1e6) / 1e6;
function percentRule({ direction, target, inclusive = true, pct = TOLERANCE_PCT, period = null }) {
  if (!['lower', 'higher'].includes(direction) || !Number.isFinite(target) || !Number.isFinite(pct) || pct < 0) throw new Error('percentRule: bad arguments');
  if (direction === 'lower') {
    const limit = r6(target * (1 + pct / 100));
    return { period, green: inclusive ? { lte: target } : { lt: target }, orange: { ...(inclusive ? { gt: target } : { gte: target }), lte: limit }, red: { gt: limit } };
  }
  const limit = r6(target * (1 - pct / 100));
  return { period, green: inclusive ? { gte: target } : { gt: target }, orange: { ...(inclusive ? { lt: target } : { lte: target }), gte: limit }, red: { lt: limit } };
}

// benchmarks for the colour-coded metrics (null = WNDRR has not approved one yet: the value shows, uncoloured)
const RULES = {
  TOF: {
    frequency: percentRule({ direction: 'lower', target: 2, inclusive: false, period: 'approx_4_days' }), // green < 2, orange 2-2.4, red > 2.4
    reach: null, // colour-coded, but no benchmark approved yet
  },
  TOM: {
    cpa: null, // colour-coded, but no benchmark approved yet (never inferred from TOF / MOF)
    reach: null, // colour-coded, but no benchmark approved yet
  },
  MOF: {
    cpa: percentRule({ direction: 'lower', target: 60, inclusive: true }), // green <= $60 (the $40-$60 target; below $40 stays green), orange <= $72, red > $72
    reach: null, // colour-coded, but no benchmark approved yet
  },
};
const JUDGED_FUNNELS = ['TOF', 'TOM', 'MOF'];
const METRICS = ['cpa', 'frequency', 'reach'];
const STATES = ['red', 'orange', 'green'];

// The two benchmarks WNDRR has APPROVED. A configured override can never change them (it may only supply the still-pending metrics).
const APPROVED = {
  TOF: { frequency: RULES.TOF.frequency },
  MOF: { cpa: RULES.MOF.cpa },
};

// ── Configurable benchmarks (no code change, no schema change) ─────────────────────────────────────────────────────────────
// META_HEALTH_RULES (an environment variable, JSON) lets WNDRR add the benchmarks it approves later, e.g.
//   {"TOF":{"reach":{"period":null,"green":{"gte":50000},"orange":{"gte":40000,"lt":50000},"red":{"lt":40000}}}}
// Only the metrics already colour-coded for a funnel (COLOUR_CODED) can be configured; a malformed rule is IGNORED (that metric stays
// neutral) and listed under status().config_errors -- one bad entry never breaks the dashboard and nothing is guessed. A rule for a
// metric with an APPROVED benchmark cannot be changed this way. Unset / blank = the built-in rules above.
const sameCond = (a, b) => (a === undefined && b === undefined) || (!!a && !!b && JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort()));
const sameRule = (a, b) => a.period === b.period && STATES.every((s) => sameCond(a[s], b[s]));
function parseOverrides(raw) {
  const out = { rules: null, errors: [], source: 'default' };
  if (raw === undefined || raw === null || String(raw).trim() === '') return out;
  let parsed;
  try { parsed = JSON.parse(String(raw)); } catch (e) { out.errors.push('META_HEALTH_RULES is not valid JSON; the built-in benchmarks are used'); return out; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { out.errors.push('META_HEALTH_RULES must be a JSON object keyed by funnel; the built-in benchmarks are used'); return out; }
  const merged = {};
  JUDGED_FUNNELS.forEach((f) => { merged[f] = { ...(RULES[f] || {}) }; });
  let applied = 0;
  for (const [f, metrics] of Object.entries(parsed)) {
    if (!JUDGED_FUNNELS.includes(f) || !metrics || typeof metrics !== 'object') { out.errors.push(`${f}: not a judged funnel (TOF, TOM, MOF)`); continue; }
    for (const [m, rule] of Object.entries(metrics)) {
      if (!(COLOUR_CODED[f] || []).includes(m)) { out.errors.push(`${f} ${m}: not a colour-coded measure for ${f}`); continue; }
      if (!validRule(rule)) { out.errors.push(`${f} ${m}: not a valid rule (period must be null or "approx_4_days"; green / orange / red take min, max, gt, gte, lt or lte numbers)`); continue; }
      const keep = APPROVED[f] && APPROVED[f][m];
      if (keep && !sameRule(rule, keep)) { out.errors.push(`${f} ${m}: the approved benchmark (${describe(keep)}) cannot be changed here`); continue; }
      merged[f][m] = rule; applied += 1;
    }
  }
  if (applied) { out.rules = merged; out.source = 'env'; }
  return out;
}
let overrideCache = { raw: undefined, parsed: null };
function overrides() {
  const raw = process.env.META_HEALTH_RULES;
  if (overrideCache.parsed === null || overrideCache.raw !== raw) overrideCache = { raw, parsed: parseOverrides(raw) };
  return overrideCache.parsed;
}
// the rules in force right now: the built-in ones, plus any valid configured benchmarks
const effectiveRules = () => overrides().rules || RULES;

// whole calendar days of an inclusive range, from the dates themselves ('YYYY-MM-DD')
function rangeDays(range) {
  if (!range || !range.since || !range.until) return null;
  const p = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const n = Math.round((p(range.until) - p(range.since)) / 86400000) + 1;
  return Number.isFinite(n) && n >= 1 ? n : null;
}
const isApprox4Days = (days) => days !== null && days !== undefined && days >= APPROX_4_DAYS.min_days && days <= APPROX_4_DAYS.max_days;

const match = (v, c) => !!c
  && (c.gt === undefined || v > c.gt) && (c.gte === undefined || v >= c.gte)
  && (c.lt === undefined || v < c.lt) && (c.lte === undefined || v <= c.lte)
  && (c.min === undefined || v >= c.min) && (c.max === undefined || v <= c.max);
const validCond = (c) => !!c && typeof c === 'object' && Object.keys(c).length > 0 && Object.entries(c).every(([k, x]) => ['gt', 'gte', 'lt', 'lte', 'min', 'max'].includes(k) && typeof x === 'number' && Number.isFinite(x));
function validRule(r) {
  if (!r || typeof r !== 'object') return false;
  if (r.period !== null && r.period !== 'approx_4_days') return false;
  const given = STATES.filter((s) => r[s] !== undefined);
  return given.length > 0 && given.every((s) => validCond(r[s]));
}

// 'green' | 'orange' | 'red' | null (null = neutral / not judged). ctx.days = calendar days of the selected range.
// `rules` / `enabled` are injectable for tests only.
function classify(funnel, metric, value, ctx = {}, { rules = effectiveRules(), enabled = ENABLED, coded = COLOUR_CODED } = {}) {
  if (!enabled) return null;
  if (!JUDGED_FUNNELS.includes(funnel) || !METRICS.includes(metric)) return null; // Unknown / Mixed / anything else: neutral
  if (!(coded[funnel] || []).includes(metric)) return null; // not a colour-coded metric for this funnel: always neutral
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return null;
  const rule = rules[funnel] && rules[funnel][metric];
  if (!validRule(rule)) return null;
  if (rule.period === 'approx_4_days' && !isApprox4Days(ctx.days)) return null; // not scaled to other lengths
  const v = Number(value);
  for (const s of STATES) if (rule[s] !== undefined && match(v, rule[s])) return s;
  return null;
}

// "over 60 and up to 72", "2 to 2.4", "under 2" ... (plain words; the UI adds the unit)
function condText(c) {
  const lo = c.gt !== undefined ? ['over', c.gt] : c.gte !== undefined ? ['from', c.gte] : c.min !== undefined ? ['from', c.min] : null;
  const hi = c.lt !== undefined ? ['under', c.lt] : c.lte !== undefined ? ['up to', c.lte] : c.max !== undefined ? ['up to', c.max] : null;
  if (lo && hi) return lo[0] === 'from' && hi[0] === 'up to' ? `${lo[1]} to ${hi[1]}` : `${lo[0]} ${lo[1]} and ${hi[0]} ${hi[1]}`;
  if (hi) return hi[0] === 'under' ? `under ${hi[1]}` : `${hi[1]} or less`;
  if (lo) return lo[0] === 'over' ? `over ${lo[1]}` : `${lo[1]} or more`;
  return '';
}
function describe(rule) {
  return STATES.slice().reverse().filter((s) => rule[s] !== undefined).map((s) => `${s} ${condText(rule[s])}`).join('; ');
}
// [{ state, text, cond }] green -> orange -> red, for the compact colour guide in the UI
const bandsOf = (rule) => ['green', 'orange', 'red'].filter((s) => rule[s] !== undefined).map((s) => ({ state: s, text: condText(rule[s]), cond: rule[s] }));

function status({ rules = effectiveRules(), enabled = ENABLED, coded = COLOUR_CODED, range = null } = {}) {
  const days = rangeDays(range);
  const defined = {}; // colour-coded metric -> described benchmark, or null when none has been approved yet
  const bands = {}; // colour-coded metric -> [{ state, text, cond }] for the UI guide
  const colourCoded = {};
  const pending = []; // colour-coded but waiting for a benchmark, e.g. 'TOF reach'
  JUDGED_FUNNELS.forEach((f) => {
    defined[f] = {}; bands[f] = {}; colourCoded[f] = (coded[f] || []).filter((m) => METRICS.includes(m));
    colourCoded[f].forEach((m) => {
      const r = rules[f] && rules[f][m];
      defined[f][m] = validRule(r) ? describe(r) + (r.period ? ' (about 4 days)' : '') : null;
      bands[f][m] = validRule(r) ? bandsOf(r) : null;
      if (!defined[f][m]) pending.push(`${f} ${m}`);
    });
  });
  return {
    enabled: !!enabled, rules_version: RULES_VERSION, rules_source: overrides().source, config_errors: overrides().errors, judged_funnels: JUDGED_FUNNELS, colour_coded: colourCoded, defined, bands, pending_benchmarks: pending, tolerance_pct: TOLERANCE_PCT,
    active: !!enabled && JUDGED_FUNNELS.some((f) => colourCoded[f].some((m) => defined[f][m])),
    period: { days, approx_4_days: { ...APPROX_4_DAYS }, frequency_judged: isApprox4Days(days) },
    note: 'Colours use only WNDRR-approved benchmarks; everything else is neutral. Frequency is judged only for a period of about 4 days.',
  };
}

module.exports = { percentRule, parseOverrides, effectiveRules, APPROVED, TOLERANCE_PCT, ENABLED, RULES_VERSION, APPROX_4_DAYS, COLOUR_CODED, RULES, JUDGED_FUNNELS, METRICS, rangeDays, isApprox4Days, validRule, classify, status };
