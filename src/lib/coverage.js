const { computeCreativeTarget } = require('./creativeTarget');
const apparelmagic = require('./apparelmagic');
const { deriveProductCode } = apparelmagic;

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
// one creative target is computed from the summed SOH + on-order rather
// than per colourway. On-order is included in the target figure (not just
// shown alongside it) because it's the same physical stock, just not
// receipted yet -- a new-drop style that's fully pre-ordered but shows 0
// SOH still needs the same creative coverage it will once that on-order
// stock is receipted and becomes SOH. See apparelmagic.js: deriveProductCode.
//
// styleRows: rows from the styles table (id, style_code, name, tier, ...).
// assetCounts: Map<style_id, creative_asset_count>.
// amStock / amOnOrder: Map<style_code, qty> or null if AM isn't configured.
// amDetails: Map<style_code, { productName, imageUrl }> or null.
// amSizeRanges: Map<size_range_id, { name, sizes }> or null -- only needed
// for the Shoot This Week modal's size picker, not any coverage/target math.
// rules: creative_target_rules rows.
function buildCoverage(styleRows, { assetCounts, amStock, amOnOrder, amDetails, amSizeRanges, rules }) {
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
      // A style absent from a successfully-fetched AM map is a confident
      // zero (no warehouse row / no open PO line for it), not "unknown" --
      // same treatment demandplanning gives an absent SKU row. "Unavailable"
      // is reserved for AM itself being unconfigured/errored (map is null),
      // which the product-level soh/on_order fields below already surface.
      const styleSoh = amStock ? amStock.get(style.style_code) ?? 0 : null;
      if (styleSoh != null) {
        soh += styleSoh;
        sohKnown = true;
      }
      const styleOnOrder = amOnOrder ? amOnOrder.get(style.style_code) ?? 0 : null;
      if (styleOnOrder != null) onOrder += styleOnOrder;
      currentCoverage += assetCounts.get(style.id) || 0;

      const details = amDetails ? amDetails.get(style.style_code) : null;
      if (details?.imageUrl) images.push(details.imageUrl);
      const sizing = apparelmagic.resolveStyleSizing(amDetails, amSizeRanges, style.style_code);
      memberSummaries.push({
        style_id: style.id,
        style_code: style.style_code,
        tier: style.tier,
        image_url: details?.imageUrl || null,
        // Per-colour figures, kept alongside (not instead of) the product-
        // level totals below -- SOH/on-order are real per-SKU numbers and
        // showing only a blended total risks reading as if one colour's
        // stock is the other's, or that SOH and on-order are the same pool.
        soh: styleSoh,
        on_order: styleOnOrder,
        // Display-only, for the Shoot This Week modal -- no effect on any
        // coverage/target/gap math below.
        colour_label: apparelmagic.resolveColourLabel(amDetails, style.style_code),
        sizes: sizing.sizes,
        sizing_system: sizing.system,
      });
    }

    const first = members[0];
    const firstDetails = amDetails ? amDetails.get(first.style_code) : null;
    // On-order stock is the same physical units as SOH, just not receipted
    // yet -- a style waiting on a delivery (0 SOH, 200 on order) needs the
    // same creative coverage it will the day that stock arrives, so the
    // target bracket is looked up against the combined total, not SOH alone.
    const creativeTarget = sohKnown ? computeCreativeTarget(soh + onOrder, rules) : null;
    const gap = creativeTarget != null ? Math.max(0, creativeTarget - currentCoverage) : null;

    return {
      product_code: productCode,
      product_name: firstDetails?.productName || first.name,
      // Display-only passthrough for the Shoot This Week modal, matching
      // coreProducts.js's equivalent field -- not used in any target/gap/
      // status computation above.
      category: firstDetails?.category || null,
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
