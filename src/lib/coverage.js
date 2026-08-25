const { computeCreativeTarget } = require('./creativeTarget');

// "Current Creative Coverage" = count of Creative Assets (Phase 1's "one row
// per ad concept per style" entity) linked to the style, any status. This is
// deliberately the only creative entity we count -- Planning's own Creative
// Jobs are a plan to close the gap, not the gap closed, so they never
// inflate coverage (see schema.sql's comment on creative_jobs). No
// duplicate-export inflation risk either, since a Creative Asset already
// represents one concept, not one technical export.
function coverageStatus(coverage, target) {
  if (target <= 0) return 'green';
  const ratio = coverage / target;
  if (ratio >= 1) return 'green';
  if (ratio >= 0.5) return 'amber';
  return 'red';
}

// styleRows: rows from the styles table (id, style_code, name, tier, ...).
// assetCounts: Map<style_id, creative_asset_count>.
// amStock: Map<style_code, soh> or null if ApparelMagic isn't configured.
// amDetails: Map<style_code, { productName, imageUrl }> or null.
// rules: creative_target_rules rows.
function buildCoverage(styleRows, { assetCounts, amStock, amDetails, rules }) {
  return styleRows.map((style) => {
    const soh = amStock ? amStock.get(style.style_code) ?? null : null;
    const details = amDetails ? amDetails.get(style.style_code) : null;
    const creativeTarget = soh != null ? computeCreativeTarget(soh, rules) : null;
    const currentCoverage = assetCounts.get(style.id) || 0;
    const gap = creativeTarget != null ? Math.max(0, creativeTarget - currentCoverage) : null;

    return {
      style_id: style.id,
      style_code: style.style_code,
      name: style.name,
      tier: style.tier,
      product_name: details?.productName || style.name,
      image_url: details?.imageUrl || null,
      soh,
      creative_target: creativeTarget,
      current_coverage: currentCoverage,
      creative_gap: gap,
      status: creativeTarget != null ? coverageStatus(currentCoverage, creativeTarget) : null,
    };
  });
}

module.exports = { buildCoverage, coverageStatus };
