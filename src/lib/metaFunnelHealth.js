// Funnel-specific "health" colours for Meta Performance -- built ONLY from the guidance WNDRR has confirmed.
//
// TWO separate things are configured here, so a missing benchmark is easy to add later:
//   COLOUR_CODED  WHICH metrics WNDRR evaluates per funnel (this decides where a colour can ever appear)
//   RULES         the numeric benchmark for each of those metrics -- null until WNDRR supplies one (null = neutral)
//
// WNDRR evaluates:                              benchmark today
//   TOF  Frequency                              green under 2, over roughly a 3-5 day period
//   TOF  Reach                                  none yet -> neutral
//   TOM  CPA                                    none yet -> neutral
//   TOM  Reach                                  none yet -> neutral
//   MOF  CPA                                    green $40 to $60 inclusive (any range)
//   MOF  Reach                                  none yet -> neutral
// Every other metric (TOF CPA, TOM Frequency, MOF Frequency, spend, purchases, ...) is NOT colour-coded and always displays
// neutral, as does every Unknown / Mixed funnel. The real numbers are always shown; colour is only ever an extra signal.
// There are NO orange ranges and no invented thresholds.
//
// FREQUENCY IS PERIOD-AWARE. The frequency guidance is for about 4 days; a Frequency of 2 over 30 days is not the same thing.
// A rule with period 'approx_4_days' is judged only when the SELECTED range is APPROX_4_DAYS.min_days .. max_days calendar days
// long (inclusive of both end dates, counted from the real dates, not from the preset's name). Any other length shows the number
// with no colour. Thresholds are never scaled or extrapolated.
//
// TO ADD A BENCHMARK LATER, edit RULES only (the metric is already colour-coded, so nothing else changes), e.g.
//   TOF: { reach: { period: null, green: { min: 50000 } } }
// A rule is { period: 'approx_4_days' | null, green?: {min?,max?,lt?,lte?}, orange?: {...}, red?: {...} }, evaluated
// red -> orange -> green; a value matching none is neutral. To start colour-coding a new metric, add it to COLOUR_CODED too.
const ENABLED = true;
const RULES_VERSION = 2;

const APPROX_4_DAYS = { target_days: 4, min_days: 3, max_days: 5 };

// which metrics WNDRR colour-codes for each funnel
const COLOUR_CODED = {
  TOF: ['frequency', 'reach'],
  TOM: ['cpa', 'reach'],
  MOF: ['cpa', 'reach'],
};

// benchmarks for the colour-coded metrics (null = WNDRR has not supplied one yet: the value shows, uncoloured)
const RULES = {
  TOF: {
    frequency: { period: 'approx_4_days', green: { lt: 2 } },
    reach: null, // colour-coded, but no benchmark supplied yet
  },
  TOM: {
    cpa: null, // colour-coded, but no benchmark supplied yet (never inferred from TOF / MOF)
    reach: null, // colour-coded, but no benchmark supplied yet
  },
  MOF: {
    cpa: { period: null, green: { min: 40, max: 60 } },
    reach: null, // colour-coded, but no benchmark supplied yet
  },
};
const JUDGED_FUNNELS = ['TOF', 'TOM', 'MOF'];
const METRICS = ['cpa', 'frequency', 'reach'];
const STATES = ['red', 'orange', 'green'];

// The two benchmarks WNDRR has CONFIRMED. A configured override may ADD bands around them (e.g. an orange range) but can never
// change or remove the confirmed green band or its period.
const CONFIRMED_GREEN = {
  TOF: { frequency: { period: 'approx_4_days', green: { lt: 2 } } },
  MOF: { cpa: { period: null, green: { min: 40, max: 60 } } },
};

// ── Configurable benchmarks (no code change, no schema change) ─────────────────────────────────────────────────────────────
// META_HEALTH_RULES (an environment variable, JSON) lets WNDRR add the benchmarks it approves later, e.g.
//   {"TOF":{"reach":{"period":null,"green":{"min":50000}}},"TOM":{"cpa":{"period":null,"green":{"max":45},"orange":{"min":45,"max":60},"red":{"min":60}}}}
// Only the metrics already colour-coded for a funnel (COLOUR_CODED) can be configured; a malformed rule is IGNORED (that metric stays
// neutral) and listed under status().config_errors -- one bad entry never breaks the dashboard and nothing is guessed. A rule for a
// metric with a CONFIRMED benchmark must keep that confirmed green band exactly. Unset / blank = the built-in rules above.
const sameCond = (a, b) => !!a && !!b && JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
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
      const keep = CONFIRMED_GREEN[f] && CONFIRMED_GREEN[f][m];
      if (keep && !(rule.period === keep.period && sameCond(rule.green, keep.green))) { out.errors.push(`${f} ${m}: the confirmed green band (${describe(keep)}) cannot be changed here`); continue; }
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

function describe(rule) {
  const part = (c) => [c.gt !== undefined && `over ${c.gt}`, c.gte !== undefined && `${c.gte} or more`, c.lt !== undefined && `under ${c.lt}`, c.lte !== undefined && `${c.lte} or less`, (c.min !== undefined || c.max !== undefined) && `${c.min ?? ''}–${c.max ?? ''}`].filter(Boolean).join(', ');
  return STATES.filter((s) => rule[s] !== undefined).map((s) => `${s} ${part(rule[s])}`).join('; ');
}

function status({ rules = effectiveRules(), enabled = ENABLED, coded = COLOUR_CODED, range = null } = {}) {
  const days = rangeDays(range);
  const defined = {}; // colour-coded metric -> described benchmark, or null when none has been supplied yet
  const colourCoded = {};
  const pending = []; // colour-coded but waiting for a benchmark, e.g. 'TOF reach'
  JUDGED_FUNNELS.forEach((f) => {
    defined[f] = {}; colourCoded[f] = (coded[f] || []).filter((m) => METRICS.includes(m));
    colourCoded[f].forEach((m) => {
      const r = rules[f] && rules[f][m];
      defined[f][m] = validRule(r) ? describe(r) + (r.period ? ' (about 4 days)' : '') : null;
      if (!defined[f][m]) pending.push(`${f} ${m}`);
    });
  });
  return {
    enabled: !!enabled, rules_version: RULES_VERSION, rules_source: overrides().source, config_errors: overrides().errors, judged_funnels: JUDGED_FUNNELS, colour_coded: colourCoded, defined, pending_benchmarks: pending,
    active: !!enabled && JUDGED_FUNNELS.some((f) => colourCoded[f].some((m) => defined[f][m])),
    period: { days, approx_4_days: { ...APPROX_4_DAYS }, frequency_judged: isApprox4Days(days) },
    note: 'Colours use only WNDRR-confirmed benchmarks; everything else is neutral. Frequency is judged only for a period of about 4 days.',
  };
}

module.exports = { parseOverrides, effectiveRules, CONFIRMED_GREEN, ENABLED, RULES_VERSION, APPROX_4_DAYS, COLOUR_CODED, RULES, JUDGED_FUNNELS, METRICS, rangeDays, isApprox4Days, validRule, classify, status };
