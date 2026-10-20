// Stock-on-Hand -> required-creatives lookup. Rules come from the
// creative_target_rules table (configurable in-app) rather than being
// hardcoded here, per the Planning brief's section 4.

function computeCreativeTarget(soh, rules) {
  if (soh == null || soh <= 0) return 0;

  const sorted = [...rules].sort((a, b) => a.soh_min - b.soh_min);
  for (const rule of sorted) {
    const max = rule.soh_max == null ? Infinity : rule.soh_max;
    if (soh >= rule.soh_min && soh <= max) return rule.required_creatives;
  }

  // SOH below the lowest configured bracket's min (e.g. rules start at 1
  // but soh is fractional/edge case) -- fall back to the smallest bracket
  // rather than reporting no target for a style that clearly has stock.
  return sorted.length ? sorted[0].required_creatives : null;
}

const MAX_RULES = 12;
const MAX_REQUIRED = 50;
// The ranges must cover every stock figure with no gap and no overlap (a figure that fell between two ranges would silently get the LOWEST range's number, see above): the first starts at 1, each starts
// one above the previous one's end, and the last is open-ended ("and above"). Returns { ok: true, rules } (sorted, whole numbers) or { ok: false, error }.
function validateCreativeTargetRules(input) {
  if (!Array.isArray(input) || input.length < 1) return { ok: false, error: 'At least one range is required.' };
  if (input.length > MAX_RULES) return { ok: false, error: `No more than ${MAX_RULES} ranges.` };
  const rules = [];
  for (const r of input) {
    const min = Number(r && r.soh_min); const max = r && r.soh_max != null && r.soh_max !== '' ? Number(r.soh_max) : null; const req = Number(r && r.required_creatives);
    if (!Number.isInteger(min) || min < 1) return { ok: false, error: 'Each range must start at 1 or more.' };
    if (max !== null && (!Number.isInteger(max) || max < min)) return { ok: false, error: `A range ending at ${r.soh_max} cannot end before it starts (${min}).` };
    if (!Number.isInteger(req) || req < 0 || req > MAX_REQUIRED) return { ok: false, error: `Required concepts must be a whole number from 0 to ${MAX_REQUIRED}.` };
    rules.push({ soh_min: min, soh_max: max, required_creatives: req });
  }
  rules.sort((a, b) => a.soh_min - b.soh_min);
  if (rules[0].soh_min !== 1) return { ok: false, error: 'The first range must start at 1.' };
  for (let i = 0; i < rules.length; i += 1) {
    const last = i === rules.length - 1;
    if (last && rules[i].soh_max !== null) return { ok: false, error: 'The last range must be open-ended ("and above") so every stock level has a number.' };
    if (!last) {
      if (rules[i].soh_max === null) return { ok: false, error: 'Only the last range can be open-ended.' };
      if (rules[i + 1].soh_min !== rules[i].soh_max + 1) return { ok: false, error: `Ranges must follow on from each other with no gap or overlap (after ${rules[i].soh_max} comes ${rules[i].soh_max + 1}).` };
    }
  }
  return { ok: true, rules };
}

module.exports = { computeCreativeTarget, validateCreativeTargetRules, MAX_RULES, MAX_REQUIRED };
