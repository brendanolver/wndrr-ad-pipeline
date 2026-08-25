const { computeCreativeTarget } = require('./creativeTarget');
const { deriveProductCode } = require('./apparelmagic');

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

// Groups individual style rows (one per colourway, matching ApparelMagic's
// own style_number scheme) into one coverage entry per base product --
// colourways of the same product share one creative need, so SOH, on-order
// and current coverage are summed across every colourway in the group, and
// one creative target is computed from the summed SOH rather than per
// colourway. See apparelmagic.js: deriveProductCode.
//
// styleRows: rows from the styles table (id, style_code, name, tier, ...).
// assetCounts: Map<style_id, creative_asset_count>.
// amStock / amOnOrder: Map<style_code, qty> or null if AM isn't configured.
// amDetails: Map<style_code, { productName, imageUrl }> or null.
// rules: creative_target_rules rows.
function buildCoverage(styleRows, { assetCounts, amStock, amOnOrder, amDetails, rules }) {
  const groups = new Map(); // product_code -> style rows
  for (const style of styleRows) {
    const productCode = deriveProductCode(style.style_code);
    if (!groups.has(productCode)) groups.set(productCode, []);
    groups.get(productCode).push(style);
  }

  return [...groups.entries()].map(([productCode, members]) => {
    let soh = 0;
    let onOrder = 0;
    let currentCoverage = 0;
    let sohKnown = false;
    const images = [];
    const memberSummaries = [];

    for (const style of members) {
      const styleSoh = amStock ? amStock.get(style.style_code) : null;
      if (styleSoh != null) {
        soh += styleSoh;
        sohKnown = true;
      }
      const styleOnOrder = amOnOrder ? amOnOrder.get(style.style_code) : null;
      if (styleOnOrder != null) onOrder += styleOnOrder;
      currentCoverage += assetCounts.get(style.id) || 0;

      const details = amDetails ? amDetails.get(style.style_code) : null;
      if (details?.imageUrl) images.push(details.imageUrl);
      memberSummaries.push({
        style_id: style.id,
        style_code: style.style_code,
        tier: style.tier,
        image_url: details?.imageUrl || null,
      });
    }

    const first = members[0];
    const firstDetails = amDetails ? amDetails.get(first.style_code) : null;
    const creativeTarget = sohKnown ? computeCreativeTarget(soh, rules) : null;
    const gap = creativeTarget != null ? Math.max(0, creativeTarget - currentCoverage) : null;

    return {
      product_code: productCode,
      product_name: firstDetails?.productName || first.name,
      tier: first.tier,
      styles: memberSummaries,
      images,
      soh: sohKnown ? soh : null,
      on_order: amOnOrder ? onOrder : null,
      creative_target: creativeTarget,
      current_coverage: currentCoverage,
      creative_gap: gap,
      status: creativeTarget != null ? coverageStatus(currentCoverage, creativeTarget) : null,
    };
  });
}

module.exports = { buildCoverage, coverageStatus };
