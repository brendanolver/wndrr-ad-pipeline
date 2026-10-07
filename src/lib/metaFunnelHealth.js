// Funnel-specific CPA / Frequency "health" (green / orange / red) -- built ONLY from the guidance WNDRR has confirmed.
//
// Source: Max's directional internal benchmarks (not universal Meta rules):
//   TOF  CPA        over $200 is a concern; TOF is about Reach, so no tighter CPA target exists
//   TOF  Frequency  under 2, over roughly a 4-day period
//   TOF  Reach      matters most, but NO numeric benchmark has been supplied
//   TOM  CPA        no approved benchmark
//   TOM  Frequency  2 to 3 (inclusive), over roughly a 4-day period
//   MOF  CPA        about $40 to $60
//   MOF  Frequency  not relevant
//
// Rules are deliberately PARTIAL. A state exists only where WNDRR confirmed it:
//   TOF CPA        red above $200, otherwise neutral
//   TOF Frequency  green below 2 (4-day period), otherwise neutral
//   TOM Frequency  green from 2 to 3 inclusive (4-day period), otherwise neutral
//   MOF CPA        green from $40 to $60 inclusive, otherwise neutral (a $30 CPA is NOT bad; $70 is not judged)
//   everything else, and every Unknown / Mixed funnel: neutral (null = no colour)
// There are NO orange ranges: none has been confirmed, so none is invented. Colour is only ever an extra signal beside the
// real number, which is always still shown.
//
// FREQUENCY IS PERIOD-AWARE. Max's frequency guidance is for about 4 days; a Frequency of 2 over 30 days is not the same
// thing. It is judged only when the SELECTED range is APPROX_4_DAYS.min_days .. max_days calendar days long (inclusive of both
// end dates, counted from the real dates, not from the preset's name). Any other length shows the number with no colour. The
// thresholds are never scaled or extrapolated to other lengths. CPA guidance carries no period qualifier and applies to any range.
//
// To add a rule later (e.g. a TOF Reach benchmark, a TOM CPA band, an orange range) edit RULES only: each rule is
//   { period: 'approx_4_days' | null, green?: {min?,max?,lt?,lte?}, orange?: {...}, red?: {...} }
// evaluated red -> orange -> green; a value matching none is neutral.
const ENABLED = true;
const RULES_VERSION = 1;

const APPROX_4_DAYS = { target_days: 4, min_days: 3, max_days: 5 };

const RULES = {
  TOF: {
    cpa: { period: null, red: { gt: 200 } },
    frequency: { period: 'approx_4_days', green: { lt: 2 } },
    reach: null, // important for TOF, but no numeric benchmark yet -- intentionally unclassified
  },
  TOM: {
    cpa: null, // no approved benchmark (never inferred from TOF / MOF)
    frequency: { period: 'approx_4_days', green: { min: 2, max: 3 } },
    reach: null,
  },
  MOF: {
    cpa: { period: null, green: { min: 40, max: 60 } },
    frequency: null, // "not particularly relevant"
    reach: null,
  },
};
const JUDGED_FUNNELS = ['TOF', 'TOM', 'MOF'];
const METRICS = ['cpa', 'frequency', 'reach'];
const STATES = ['red', 'orange', 'green'];

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
function classify(funnel, metric, value, ctx = {}, { rules = RULES, enabled = ENABLED } = {}) {
  if (!enabled) return null;
  if (!JUDGED_FUNNELS.includes(funnel) || !METRICS.includes(metric)) return null; // Unknown / Mixed / anything else: neutral
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return null;
  const rule = rules[funnel] && rules[funnel][metric];
  if (!validRule(rule)) return null;
  if (rule.period === 'approx_4_days' && !isApprox4Days(ctx.days)) return null; // not scaled to other lengths
  const v = Number(value);
  for (const s of STATES) if (rule[s] !== undefined && match(v, rule[s])) return s;
  return null;
}

function describe(rule) {
  const part = (c) => [c.gt !== undefined && `over ${c.gt}`, c.gte !== undefined && `${c.gte} or more`, c.lt !== undefined && `under ${c.lt}`, c.lte !== undefined && `${c.lte} or less`, (c.min !== undefined || c.max !== undefined) && `${c.min ?? ''}–${c.max ?? ''}`].filter(Boolean).join(', ');
  return STATES.filter((s) => rule[s] !== undefined).map((s) => `${s} ${part(rule[s])}`).join('; ');
}

function status({ rules = RULES, enabled = ENABLED, range = null } = {}) {
  const days = rangeDays(range);
  const defined = {};
  JUDGED_FUNNELS.forEach((f) => { defined[f] = {}; METRICS.forEach((m) => { const r = rules[f] && rules[f][m]; defined[f][m] = validRule(r) ? describe(r) + (r.period ? ' (about 4 days)' : '') : null; }); });
  return {
    enabled: !!enabled, rules_version: RULES_VERSION, judged_funnels: JUDGED_FUNNELS, defined,
    active: !!enabled && JUDGED_FUNNELS.some((f) => METRICS.some((m) => defined[f][m])),
    period: { days, approx_4_days: { ...APPROX_4_DAYS }, frequency_judged: isApprox4Days(days) },
    note: 'Colours use only WNDRR-confirmed benchmarks; everything else is neutral. Frequency is judged only for a period of about 4 days.',
  };
}

module.exports = { ENABLED, RULES_VERSION, APPROX_4_DAYS, RULES, JUDGED_FUNNELS, METRICS, rangeDays, isApprox4Days, validRule, classify, status };
