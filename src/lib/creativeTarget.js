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

module.exports = { computeCreativeTarget };
