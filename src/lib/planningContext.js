// Everything Creative Planning needs to apply the combined priority (lib/creativePriority.js), loaded ONCE per request and shared by the Core plan and
// the High Stocks list so both rank products with the same facts:
//   settings    minimum active ads per product + the High Stocks threshold (planning_settings)
//   coverage    distinct ACTIVE Meta ads per product (lib/activeAdCoverage.js)
//   seasonality data-driven season per product / category (lib/seasonality.js) from the ApparelMagic online-sales crawl, bucketed by month
//   overrides   manual business priorities (creative_priority_overrides)
//   onOrder     open purchase-order units per style (a confirmed restock), from ApparelMagic
// Every piece is optional: if one cannot be loaded the context says why and the priority simply does not weigh it (it never guesses). All sources are
// injectable (deps) so the whole thing is testable without a database or ApparelMagic. Read-only; local database + cached ApparelMagic only.
const { pool } = require('../db');
const apparelmagic = require('./apparelmagic');
const { canonicalKey } = require('./metaMatchingCatalogue');
const seasonality = require('./seasonality');
const seasonalSales = require('./seasonalSales');
const coverageLib = require('./activeAdCoverage');
const prio = require('./creativePriority');
const cfg = require('./creativePriorityConfig');

const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);

// Every product family in the catalogue (CORE or not), grouped the way the Core plan groups them: colourways and season codes with the same
// canonical product name are one product. [{ key, name, category, codes[], style_codes[], is_core }]
function buildAllFamilies(amDetails) {
  const groups = new Map();
  for (const [styleCode, d] of amDetails.entries()) {
    if (!apparelmagic.isWndrrStyleCode(styleCode) || apparelmagic.isAdExcludedCategory(d)) continue;
    const key = canonicalKey(d.productName);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ styleCode, productCode: apparelmagic.deriveProductCode(styleCode), d });
  }
  const out = [];
  groups.forEach((styles) => {
    const perCode = new Map();
    styles.forEach((s) => perCode.set(s.productCode, (perCode.get(s.productCode) || 0) + 1));
    const rep = [...perCode.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    const first = styles.filter((s) => s.productCode === rep).sort((a, b) => a.styleCode.localeCompare(b.styleCode))[0];
    out.push({
      key: rep, name: first.d.productName, category: first.d.category || null, codes: [...perCode.keys()].sort(), style_codes: styles.map((s) => s.styleCode).sort(),
      is_core: styles.some((s) => s.d.isCore),
    });
  });
  return out;
}

async function loadSettings(db = pool) {
  try {
    const r = (await db.query('SELECT * FROM planning_settings WHERE id = 1')).rows[0] || {};
    return {
      min_active_ads: Number(r.min_active_ads_per_product) || cfg.MIN_ACTIVE_ADS_DEFAULT, high_stock_min_soh: Number(r.high_stock_min_soh) || 0,
      weekly_video_target: Number(r.weekly_video_target) || 25, season_immediate_days: Number(r.season_immediate_days) || 7, season_secondary_days: Number(r.season_secondary_days) || 14,
      creative_planning_config: r.creative_planning_config && typeof r.creative_planning_config === 'object' ? r.creative_planning_config : {}, source: 'settings',
    };
  } catch (e) {
    return { min_active_ads: cfg.MIN_ACTIVE_ADS_DEFAULT, high_stock_min_soh: 0, weekly_video_target: 25, season_immediate_days: 7, season_secondary_days: 14, creative_planning_config: {}, source: 'default', error: e.message };
  }
}

async function loadOverrides(db = pool) {
  try {
    const r = await db.query(
      `SELECT o.id, o.product_code, o.kind, o.note, o.videos, to_char(o.until_date, 'YYYY-MM-DD') AS until, o.created_at, u.name AS created_by
         FROM creative_priority_overrides o LEFT JOIN users u ON u.id = o.created_by_user_id WHERE o.removed_at IS NULL ORDER BY o.id`);
    return r.rows;
  } catch (e) { return []; }
}

// The category a product is grouped under for seasonality. With Shopify orders it is Shopify's own Product type (what Demand Planning's Sales
// Cadence groups by): the type carrying most of the family's units. Otherwise (ApparelMagic sales, or a product Shopify has no type for) it is the
// ApparelMagic category.
function categoryOf(f, sales) {
  const cats = sales && sales.categories;
  if (cats && cats.size) {
    const votes = new Map();
    (f.style_codes || []).forEach((c) => { const t = cats.get(c); if (!t) return; const u = (sales.get(c) && sales.get(c).qty365) || 1; votes.set(t, (votes.get(t) || 0) + u); });
    if (votes.size) return [...votes.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
  }
  return f.category;
}

// monthly units per style out of the sales crawl: Map(style -> { 'YYYY-MM': units }) + the window the crawl covers
function monthlyFromSales(salesByStyle) {
  const m = new Map();
  salesByStyle.forEach((v, style) => { if (v && v.months) m.set(style, v.months); });
  return { monthly: m, window: salesByStyle.window || null };
}

async function loadPlanningContext({ amDetails, today, deps = {} } = {}) {
  const allFamilies = deps.allFamilies || (amDetails ? buildAllFamilies(amDetails) : []);
  const styleToFamily = new Map();
  allFamilies.forEach((f) => f.style_codes.forEach((c) => styleToFamily.set(c, f.key)));
  const settings = deps.settings || await loadSettings();
  const ctx = { today, settings, allFamilies, styleToFamily, coverage: null, seasonality: null, salesSource: null, overrides: [], onOrder: null, notes: [] };

  // active ad coverage
  try {
    ctx.coverage = deps.coverage !== undefined ? deps.coverage : await coverageLib.loadActiveAdCoverage(allFamilies.map((f) => ({ key: f.key, codes: f.codes })), { min: settings.min_active_ads });
  } catch (e) { ctx.coverage = { available: false, reason: `Active ad counts could not be read (${e.message})` }; }

  // seasonality from the monthly sales history (Shopify online orders when configured and loaded, else ApparelMagic online sales; the source is reported)
  try {
    const src = await seasonalSales.load({ amDetails, deps });
    ctx.salesSource = { source: src.source, label: src.label, notes: src.notes || [], window: src.sales && src.sales.window ? src.sales.window : null };
    const sales = src.sales;
    if (!sales) ctx.seasonality = { available: false, reason: src.reason || 'Monthly sales history has not loaded yet' };
    else {
      const { monthly, window } = monthlyFromSales(sales);
      const launchByStyle = new Map();
      if (amDetails) amDetails.forEach((d, code) => { const l = ymd(d && d.launchDate); if (l) launchByStyle.set(code, l); });
      ctx.seasonality = seasonality.buildSeasonality({ monthlyByStyle: monthly, groups: allFamilies.map((f) => ({ key: f.key, name: f.name, category: categoryOf(f, sales), style_codes: f.style_codes })), launchByStyle, window, today, lookahead: { immediate_days: settings.season_immediate_days || 7, secondary_days: settings.season_secondary_days || 14 } });
      ctx.salesSource.category_source = sales.categories && sales.categories.size ? 'shopify_product_type' : 'apparelmagic_category';
    }
  } catch (e) { ctx.seasonality = { available: false, reason: `Seasonality could not be calculated (${e.message})` }; }

  // manual overrides
  ctx.overrides = deps.overrides !== undefined ? deps.overrides : await loadOverrides();

  // open purchase orders (a confirmed restock)
  try {
    if (deps.onOrder !== undefined) ctx.onOrder = deps.onOrder;
    else {
      const st = apparelmagic.getAmCacheStatus();
      ctx.onOrder = apparelmagic.configured() && st.onOrder && st.onOrder.hasData ? await apparelmagic.getOnOrderByStyle() : null;
    }
  } catch (e) { ctx.onOrder = null; }
  return ctx;
}

// Assess ONE product with the shared context.
//   styleCodes   every style (colourway / season code) of the product    productCodes  its product codes
//   stock        { known, units }                                        sales  { available, seller_class, trend }   existing  the engine's own card
function assessProduct(ctx, { styleCodes, productCodes, stock, sales, existing }) {
  const famKey = (styleCodes || []).map((c) => ctx.styleToFamily.get(c)).find(Boolean) || null;
  const min = ctx.settings.min_active_ads;
  const seasonal = !ctx.seasonality || !ctx.seasonality.available
    ? { status: 'unavailable', reason: (ctx.seasonality && ctx.seasonality.reason) || 'Seasonal data is unavailable' }
    : (famKey && ctx.seasonality.groups.get(famKey)) || { status: 'insufficient_data', evidence: { reason: 'no sales history for this product', summary: '' } };
  const coverage = ctx.coverage && ctx.coverage.available && famKey
    ? { known: true, active_ads: ctx.coverage.by_family.get(famKey) || 0, min, possible: (ctx.coverage.pending_by_family && ctx.coverage.pending_by_family.get(famKey)) || 0, unattributed: ctx.coverage.unattributed_pending || 0 }
    : { known: false, min };
  const codes = new Set([...(productCodes || []), ...(famKey ? [famKey] : [])]);
  const overrides = (ctx.overrides || []).filter((o) => codes.has(o.product_code));
  const onOrder = ctx.onOrder ? (styleCodes || []).reduce((s, c) => s + Math.max(0, Number(ctx.onOrder.get(c)) || 0), 0) : null;
  const a = prio.assess({
    stock: stock ? { ...stock, on_order: onOrder === null ? 0 : onOrder } : { known: false },
    highStockMin: ctx.settings.high_stock_min_soh, seasonal, coverage, sales, overrides: overrides.map((o) => ({ kind: o.kind, note: o.note, until: o.until })), today: ctx.today, existing,
  });
  a.score_adjust = prio.scoreAdjust(a);
  a.season.evidence = seasonal.evidence ? { summary: seasonal.evidence.summary, level: seasonal.level || null, confidence: seasonal.evidence.confidence || null, months_used: seasonal.evidence.months_used || null, current_index: seasonal.evidence.current_index ?? null, why: seasonal.evidence.why || [], monthly: seasonal.evidence.monthly || [], now_month: seasonal.evidence.now_month || null, horizon_months: seasonal.evidence.horizon_months || [], first_month: seasonal.evidence.first_month || null, last_month: seasonal.evidence.last_month || null, units: seasonal.evidence.units ?? null, troughs: seasonal.evidence.troughs || [], series_label: seasonal.evidence.label || null, horizon_index: seasonal.evidence.horizon_index ?? null, peaks: seasonal.evidence.peaks || [], caveats: seasonal.evidence.caveats || [] } : null;
  a.season.level = seasonal.level || null;
  a.season.source = ctx.salesSource ? { source: ctx.salesSource.source, label: ctx.salesSource.label } : null;
  a.family_key = famKey;
  return a;
}

// what the page needs to say about where the numbers come from (no money, no internals)
// What the active-ad counts are, and how far to trust them (stated, never implied).
function coverageNote(c) {
  const parts = [];
  if (c.stale) parts.push(`Ad statuses were last refreshed ${c.stale_days} days ago, so active counts may be out of date.`);
  const r = c.reliability;
  if (r && r.awaiting_review > 0) parts.push(`${r.awaiting_review} of ${r.active_ads} active Meta ads (${r.share_awaiting_review}%) are still awaiting review in Ad Matching${r.awaiting_review_without_product ? `, ${r.awaiting_review_without_product} of them with no product suggestion` : ''}. Product counts include only confirmed or auto-matched ads, so a count may be incomplete; a product is only called short of creative when those ads could not close the gap.`);
  else if (r) parts.push('Every active Meta ad has been reviewed or auto-matched, so product counts are complete as of the last ad-status refresh.');
  return parts.join(' ') || null;
}

const srcOf = (ctx) => (ctx.salesSource && ctx.salesSource.source) || null;

// What the seasonality was built from, how much of it, and what is incomplete: stated, never implied.
function seasonalityStatus(ctx, s) {
  const src = ctx.salesSource || {};
  const w = src.window || {};
  const st = w.stats || {};
  const months = s.months.length;
  const cycles = months >= 24 ? Math.floor(months / 12) : 1;
  const quality = [];
  if (w.source === 'apparelmagic' && w.failed_requests > 0) quality.push(`${w.failed_requests} of ${w.total_requests} daily ApparelMagic requests failed, so some days are under-counted`);
  const defs = []; // definition differences from Demand Planning: stated, but they are not missing data
  if (w.source === 'shopify' && (st.cancelled_units > 0 || st.test_units > 0)) defs.push(`${(st.cancelled_units || 0) + (st.test_units || 0)} units on cancelled or test orders are excluded (Demand Planning counts them unless the order was refunded)`);
  if (w.source === 'shopify' && st.unmapped_units > 0) quality.push(`${st.unmapped_units} units on ${st.unmapped_skus} SKUs matched no known style and are left out`);
  if (w.source === 'shopify' && w.requested_from && w.from > w.requested_from && (Number(String(w.from).slice(0, 7).replace('-', '')) - Number(String(w.requested_from).slice(0, 7).replace('-', ''))) > 1) quality.push(`Shopify returned orders only from ${w.from}, later than the ${w.requested_from} that was requested (the token may not be able to read older orders)`);
  const label = src.label || 'online sales';
  const cycleText = cycles >= 2
    ? `${cycles} observed cycles, so a pattern that repeats across years is real evidence`
    : 'one observed cycle — real evidence of what sold when, but a second year would confirm that it repeats';
  return {
    available: true, source: src.source || null, source_label: label, window: s.window, months_of_data: months, baseline: s.baseline,
    confidence: cycles >= 2 ? 'medium' : 'limited', years_of_data: cycles, incomplete: quality.length > 0, quality, definitions: defs,
    notes: src.notes || [], category_source: src.category_source || null,
    note: `Seasonality is read from ${months} months of ${label} (${s.window.from} to ${s.window.to}) — ${cycleText}.${quality.length ? ` Data quality: ${quality.join('; ')}.` : ''}${defs.length ? ` Definitions: ${defs.join('; ')}.` : ''}`,
  };
}

function dataStatus(ctx) {
  const s = ctx.seasonality;
  const c = ctx.coverage;
  return {
    min_active_ads: ctx.settings.min_active_ads, high_stock_min_soh: ctx.settings.high_stock_min_soh,
    coverage: c && c.available
      ? { available: true, status_as_of: c.status_as_of, stale: !!c.stale, stale_days: c.stale_days, reliability: c.reliability || null, note: coverageNote(c) }
      : { available: false, note: (c && c.reason) || 'Active ad counts are unavailable.' },
    seasonality: s && s.available ? seasonalityStatus(ctx, s) : { available: false, source: srcOf(ctx), note: `${(s && s.reason) || 'Seasonal data is unavailable'}. Priority uses the other factors only.`, notes: (ctx.salesSource && ctx.salesSource.notes) || [] },
    on_order: { available: !!ctx.onOrder },
    overrides: (ctx.overrides || []).length,
  };
}

module.exports = { buildAllFamilies, loadSettings, loadOverrides, loadPlanningContext, assessProduct, dataStatus, monthlyFromSales };
