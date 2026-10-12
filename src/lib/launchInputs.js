// Builds the per-colourway evidence that launchStatus.assessStyle judges, from the sources every caller already holds (the cached ApparelMagic catalogue and sales,
// the Upcoming Drops / override context, and optionally Shopify). One place, so High Stocks, Core and the Weekly Plan can never disagree about what was known.
// Pure: no I/O.
//   ctx: { amDetails: Map, salesByStyle: Map|null, drops: Map, overrides: Map, shopify: Map|null }
function forStyle(styleCode, ctx) {
  const d = (ctx.amDetails && ctx.amDetails.get(styleCode)) || {};
  const e = ctx.salesByStyle ? ctx.salesByStyle.get(styleCode) : null;
  return {
    style_code: styleCode,
    launchDate: d.launchDate || null,
    launchDateRaw: d.launchDateRaw || null,
    launchDateReadable: d.launchDateReadable === undefined ? (d.launchDateRaw ? !!d.launchDate : null) : d.launchDateReadable,
    drop: (ctx.drops && ctx.drops.get(styleCode)) || null,
    qty: ctx.salesByStyle ? (e ? (e.qty365 || 0) : 0) : null,
    months: e && e.months ? e.months : null,
    isCore: !!d.isCore,
    override: (ctx.overrides && ctx.overrides.get(styleCode)) || null,
    shopify: (ctx.shopify && ctx.shopify.get(styleCode)) || null,
  };
}
module.exports = { forStyle };
