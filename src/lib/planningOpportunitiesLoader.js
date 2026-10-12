// Assembles everything the opportunity engine (lib/planningOpportunities.js) needs, from sources the app already has, and returns the Core and High Stocks lists.
// Read-only: it writes nothing and never calls ApparelMagic, Shopify or Meta beyond what the existing cached loaders already do.
//
//   ApparelMagic (cached)   catalogue (CORE group, mid_code launch date), stock, on order, sales by style
//   Report Pipeline         Demand Planning's Platinum / Rocket classification + first-28-day vs latest-28-day sales (lib/reportPipeline.js). NOT reimplemented here.
//   local database          Meta ads / insights (unique creatives, approved benchmarks), launch overrides + drops, the Shoot Plan production records, settings
// A piece that cannot be loaded is reported (data.notes / the item status says "unavailable") and is never replaced by an unrelated number.
//
// One product (a "family": its colourways and season codes) is evaluated once. CORE families are listed under Core; non-Core Platinum / Rocket families under
// High Stocks; a CORE product that also qualifies as a High Stocks revival stays ONE item in Core and carries the revival evidence and a High Stocks tag, so a
// product never appears twice.
const { pool } = require('../db');
const apparelmagic = require('./apparelmagic');
const planningContext = require('./planningContext');
const cfgLib = require('./creativePlanningConfig');
const perf = require('./productAdPerformance');
const history = require('./productCreativeHistory');
const launch = require('./launchStatus');
const launchInputs = require('./launchInputs');
const { loadLaunchContext } = require('./launchContext');
const opp = require('./planningOpportunities');
const season = require('./seasonRelevance');
const progress = require('./shootPlanProgress');
const coverageLib = require('./activeAdCoverage');
const nameCopies = require('./metaNameCopies');
const { ymdInZone, REPORTING_TIMEZONE } = require('./metaPerformance');

const MEMO_MS = 5 * 60 * 1000;
let memo = null;
const invalidate = () => { memo = null; };
const num = (v) => Number(v) || 0;
const mondayOf = (ymd) => { const d = new Date(`${ymd}T00:00:00Z`); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); return d.toISOString().slice(0, 10); };
const TIER_RANK = { platinum: 4, rocket: 3, surfer: 2, dog: 1, egg: 0 };

// the family-level view of Demand Planning's per-colourway tier + launch/current pace. Lead colourway = the one that sold most in its first 28 days.
function familyTier(f, tiers) {
  if (!tiers) return { tier: null, sales: null };
  const rows = f.style_codes.map((c) => ({ code: c, t: tiers.get(c) })).filter((x) => x.t);
  if (!rows.length) return { tier: null, sales: null };
  const lead = rows.slice().sort((a, b) => num(b.t.units4w) - num(a.t.units4w) || (TIER_RANK[b.t.tier] || 0) - (TIER_RANK[a.t.tier] || 0))[0];
  const withSales = rows.filter((x) => x.t.firstSaleDay);
  const earliest = withSales.slice().sort((a, b) => String(a.t.firstSaleDay).localeCompare(String(b.t.firstSaleDay)))[0] || null;
  const censored = earliest ? !!earliest.t.censored : true;
  const sales = {
    initial28: censored ? null : rows.reduce((s, x) => s + num(x.t.units4w), 0),
    recent28: rows.reduce((s, x) => s + num(x.t.units28), 0),
    prior28: rows.reduce((s, x) => s + num(x.t.units28prev), 0),
    age_days: censored || !earliest ? null : earliest.t.daysSinceFirstSale,
    first_sale_day: earliest ? earliest.t.firstSaleDay : null, censored,
  };
  const colourTiers = {}; rows.forEach((x) => { colourTiers[x.t.tier] = (colourTiers[x.t.tier] || 0) + 1; });
  return { tier: { tier: lead.t.tier, index: lead.t.indexScore, lead_style: lead.code, colour_tiers: colourTiers }, sales };
}

async function computeOpportunities({ now = new Date(), deps = {} } = {}) {
  const db = deps.db || pool;
  const today = deps.today || ymdInZone(now, REPORTING_TIMEZONE);
  const weekStart = mondayOf(today);
  const settings = deps.settings || await planningContext.loadSettings(db);
  const { config: baseCfg, issues: configIssues } = cfgLib.resolve(settings.creative_planning_config || {});
  const cfg = { ...baseCfg, min_performing_creatives: baseCfg.min_performing_creatives };
  const notes = [];

  const am = deps.am || await require('./planningData').fetchAmData();
  if (!am.amConfigured || !am.amDetails || !am.amStock) {
    return { available: false, reason: am.amConfigured ? 'The ApparelMagic catalogue or stock has not loaded yet. Try again in a few minutes.' : 'ApparelMagic is not configured, so opportunities cannot be built.', week_start: weekStart };
  }
  const salesByStyle = deps.salesByStyle !== undefined ? deps.salesByStyle : (apparelmagic.getAmCacheStatus().sales.hasData ? await apparelmagic.getSalesByStyle() : null);
  if (!salesByStyle) notes.push('ApparelMagic sales have not loaded yet, so demand cannot be judged and no opportunity can be confirmed.');

  const ctx = deps.planning || await planningContext.loadPlanningContext({ amDetails: am.amDetails, today, deps: { settings, ...(deps.planningDeps || {}) } });
  const families = ctx.allFamilies;
  const month = Number(today.slice(5, 7));

  // Demand Planning's classification (the Report Pipeline). Never substituted: when it is unavailable High Stocks says so.
  let tiers = null; let tierState = 'unavailable'; let tierReason = 'The Report Pipeline that carries Demand Planning\'s Platinum / Rocket classification is not configured on this server.';
  if (deps.tiers !== undefined) { tiers = deps.tiers; tierState = tiers ? 'ok' : 'unavailable'; if (tiers) tierReason = null; }
  else {
    const rp = require('./reportPipeline');
    if (rp.configured()) {
      try { tiers = await rp.getStyleTiers(); tierState = 'ok'; tierReason = null; } catch (e) { tierReason = `The Platinum / Rocket classification could not be loaded (${e.message}).`; }
    }
  }

  // launch status, stock and sales per family
  const allStyles = families.flatMap((f) => f.style_codes);
  const lc = deps.launch || await loadLaunchContext(db, allStyles);
  const launchCfg = launch.fromConfig(settings.creative_planning_config || {});
  const stockOf = (f) => ({ known: f.style_codes.some((c) => am.amStock.has(c)), units: f.style_codes.reduce((s, c) => s + Math.max(0, Number(am.amStock.get(c)) || 0), 0), on_order: am.amOnOrder ? f.style_codes.reduce((s, c) => s + Math.max(0, Number(am.amOnOrder.get(c)) || 0), 0) : 0 });
  const salesOf = (f) => {
    if (!salesByStyle) return { available: false };
    const t = { available: true, units7: 0, units30: 0, units365: 0 };
    f.style_codes.forEach((c) => { const e = salesByStyle.get(c); if (e) { t.units7 += e.qty7 || 0; t.units30 += e.qty30 || 0; t.units365 += e.qty365 || 0; } });
    return t;
  };
  const rows = families.map((f) => {
    const stock = stockOf(f); const sales = salesOf(f);
    const lstyles = f.style_codes.map((c) => launchInputs.forStyle(c, { amDetails: am.amDetails, salesByStyle, drops: lc.drops, overrides: lc.overrides, shopify: lc.shopify || deps.shopifyEvidence || null }));
    const l = launch.assessFamily({ styles: lstyles, familyOverride: lc.overrides.get(f.key) || null, stock: { known: stock.known, units: stock.units }, onOrder: stock.on_order }, today, launchCfg);
    const ft = familyTier(f, tiers);
    const lsByStyle = new Map(l.by_style.map((x) => [x.style_code, x.status]));
    const colourways = f.style_codes.map((c) => ({ style_code: c, colour_label: apparelmagic.resolveColourLabel(am.amDetails, c), image_url: (am.amDetails.get(c) || {}).imageUrl || null, launch_status: lsByStyle.get(c) || null, soh: Math.max(0, Number(am.amStock.get(c)) || 0) }));
    return { f, stock, sales: { ...sales, ...(ft.sales || {}), initial28: ft.sales ? ft.sales.initial28 : null, recent28: ft.sales ? ft.sales.recent28 : null, age_days: ft.sales ? ft.sales.age_days : null }, launch: l, tier: ft.tier, colourways };
  });

  // who is a candidate: launched, enough stock, and either CORE or a Platinum / Rocket product above the High Stocks threshold
  const hsMin = Math.max(num(settings.high_stock_min_soh), cfg.opp_min_stock_units);
  const isTierOk = (r) => r.tier && ['platinum', 'rocket'].includes(r.tier.tier);
  const coreRows = rows.filter((r) => r.f.is_core);
  const hsRows = rows.filter((r) => !r.f.is_core && isTierOk(r) && r.stock.known && r.stock.units >= hsMin);
  const coreRevivalRows = coreRows.filter((r) => isTierOk(r) && r.stock.units >= hsMin);
  const need = new Map(); [...coreRows, ...hsRows].forEach((r) => { if (r.launch.eligible && r.stock.known && r.stock.units >= cfg.opp_min_stock_units) need.set(r.f.key, r.f); });
  const evFamilies = [...need.values()].map((f) => ({ key: f.key, codes: f.codes }));

  // creative evidence (confirmed ads; DPAs excluded), history, the Shoot Plan pipeline
  const benchmarks = deps.benchmarks || await require('./metaBenchmarks').getEffective();
  const evidence = deps.performance || (ctx.coverage && ctx.coverage.available ? await perf.loadProductAdPerformance(evFamilies, { db, rules: benchmarks.rules, coded: benchmarks.coded, config: cfg, today, nameCopies }) : new Map());
  const hist = deps.history || (ctx.coverage && ctx.coverage.available ? await history.loadCreativeHistory(evFamilies, { db, rules: benchmarks.rules, coded: benchmarks.coded, today, config: cfg, nameCopies }) : new Map());
  const pipeline = deps.pipeline || await progress.loadProductPipeline(db, weekStart, { lookbackWeeks: cfg.pipeline_lookback_weeks });
  const pipeFor = (f) => {
    const seen = new Set(); const out = { in_flight: 0, by_stage: {}, uploaded: [], this_week: 0 };
    [...f.codes, f.key].forEach((c) => {
      const e = pipeline.get(c); if (!e) return;
      (e.concepts || []).forEach((k) => {
        if (seen.has(k.id)) return; seen.add(k.id);
        if (k.stage === 'uploaded') return;
        out.in_flight += 1; out.by_stage[k.stage] = (out.by_stage[k.stage] || 0) + 1;
      });
      (e.uploaded || []).forEach((u) => { if (!out.uploaded.some((x) => x.date === u.date && x.concept === u.concept)) out.uploaded.push(u); });
      out.this_week += e.this_week || 0;
    });
    return out;
  };

  const cov = ctx.coverage && ctx.coverage.available ? ctx.coverage : null;
  const toInput = (r) => {
    const f = r.f; const ev = evidence.get(f.key) || { creatives: [], ads: 0 };
    const active = cov ? (cov.by_family.get(f.key) || 0) : 0; const possible = cov ? ((cov.pending_by_family && cov.pending_by_family.get(f.key)) || 0) : 0;
    const cls = cov ? coverageLib.classify({ confirmed: active, possible, unattributed: cov.unattributed_pending || 0, min: settings.min_active_ads }) : null;
    const g = ctx.seasonality && ctx.seasonality.available ? ctx.seasonality.groups.get(f.key) : null;
    const h = hist.get(f.key) || { winners: [] };
    return {
      key: f.key, name: f.name, category: f.category, codes: f.codes, style_codes: f.style_codes, is_core: f.is_core, image_url: (r.colourways.find((c) => c.image_url) || {}).image_url || null,
      launch: r.launch, stock: r.stock, sales: r.sales, tier: r.tier, tierState,
      coverage: cov ? { known: true, active_ads: active, possible, uncertain: !!(cls && cls.state === 'uncertain'), min: settings.min_active_ads } : { known: false, min: settings.min_active_ads },
      creatives: ev.creatives || [], history: h, pipeline: pipeFor(f), seasonData: g ? g.status : (ctx.seasonality && ctx.seasonality.available ? 'insufficient_data' : null),
    };
  };

  // two-phase so the seasonal exception ("selling strongly now") can use the sales band
  const run = (rowSet, mode) => {
    const inputs = rowSet.map(toInput);
    const bands = opp.salesBands(inputs, cfg);
    return inputs.map((p) => {
      const band = opp.bandOf(p, bands, cfg);
      const s = season.assess({ category: p.category, name: p.name, month, data: p.seasonData, strongSellingNow: band === 'strong' });
      return opp.evaluate({ ...p, salesBand: band, season: s }, cfg, today, mode);
    });
  };
  const coreEvals = run(coreRows, 'core');
  const coreRevEvals = new Map(run(coreRevivalRows, 'revival').map((e) => [e.key, e]));
  const hsEvals = run(hsRows, 'revival');

  const colourFor = (key) => (rows.find((r) => r.f.key === key) || {}).colourways || [];
  const decorate = (e, extra = {}) => ({ ...e, product_code: (e.codes && e.codes[0]) || e.key, colourways: colourFor(e.key), ...extra });
  // a CORE product that is also a High Stocks revival stays ONE item: the revival evidence wins when it is the action
  const tierTag = (e) => (e.facts && e.facts.tier === 'platinum' ? 'Platinum' : e.facts && e.facts.tier === 'rocket' ? 'Rocket' : null);
  const coreItems = coreEvals.map((e) => {
    const rev = coreRevEvals.get(e.key) || null;
    const tags = ['Core']; if (tierTag(e)) tags.push(tierTag(e));
    if (rev && rev.status === 'act' && e.status !== 'act') return decorate({ ...rev, kind: 'core', kinds: ['core', 'high_stock'], tags: [...tags, 'High Stocks revival'] });
    if (rev && rev.status === 'act' && e.status === 'act') return decorate({ ...e, kinds: ['core', 'high_stock'], tags: [...tags, 'High Stocks revival'], revival: rev.revival, other_explanations: rev.other_explanations, why: [...e.why, ...rev.why.filter((w) => ['demand', 'stock'].includes(w.k)).map((w) => ({ ...w, k: `revival_${w.k}` }))] });
    return decorate({ ...e, kinds: ['core'], tags });
  });
  const hsItems = hsEvals.map((e) => decorate({ ...e, kinds: ['high_stock'], tags: [e.facts.tier === 'platinum' ? 'Platinum' : 'Rocket'] }));

  const rank = { act: 0, testing: 1, in_production: 2, insufficient_data: 3, covered: 4, momentum_ok: 4, out_of_season: 5, weak_demand: 6, low_stock: 7, too_new: 8, no_proven_demand: 9, unavailable: 10, launch_unknown: 11, not_launched: 12 };
  const order = (a, b) => (rank[a.status] - rank[b.status]) || (b.score - a.score) || String(a.name).localeCompare(String(b.name));
  coreItems.sort(order); hsItems.sort(order);
  const countBy = (items) => { const c = {}; items.forEach((i) => { c[i.status] = (c[i.status] || 0) + 1; }); return c; };

  // launch review: only products that matter (stock or recent sales) go to a person; the long historical tail does not
  const unknown = rows.filter((r) => r.launch.status === 'unknown');
  const relevantUnknown = unknown.filter((r) => (r.stock.known && r.stock.units > 0) || num(r.sales.units30) > 0 || (r.stock.on_order || 0) > 0);
  const byBasis = {}; unknown.forEach((r) => { byBasis[r.launch.basis] = (byBasis[r.launch.basis] || 0) + 1; });
  const unlaunched = rows.filter((r) => r.launch.status === 'unlaunched' && r.stock.known && r.stock.units > 0);
  const launchReview = {
    total_unknown: unknown.length, relevant_count: relevantUnknown.length, historical_count: unknown.length - relevantUnknown.length, by_basis: byBasis,
    relevant: relevantUnknown.sort((a, b) => b.stock.units - a.stock.units).slice(0, 50).map((r) => ({ key: r.f.key, name: r.f.name, product_code: r.f.codes[0], image_url: (r.colourways.find((c) => c.image_url) || {}).image_url || null, soh_total: r.stock.units, units_30d: Math.round(num(r.sales.units30)), basis: r.launch.basis, detail: r.launch.detail, evidence: (r.launch.by_style[0] && r.launch.by_style[0].evidence) || [] })),
    excluded_unlaunched_count: unlaunched.length,
    excluded_unlaunched: unlaunched.sort((a, b) => b.stock.units - a.stock.units).slice(0, 40).map((r) => ({ key: r.f.key, name: r.f.name, detail: r.launch.detail, in_upcoming_drop: r.launch.in_upcoming_drop, soh_total: r.stock.units })),
    note: unknown.length > relevantUnknown.length ? `${unknown.length - relevantUnknown.length} products with no readable launch date have no stock, no open order and no sales in the last 30 days: they are historical catalogue entries and are not asked of the team.` : null,
  };

  const mem = ctx.coverage && ctx.coverage.available && ctx.coverage.reliability ? ctx.coverage.reliability : null;
  if (mem && mem.awaiting_review > 0) notes.push(`${mem.awaiting_review} of ${mem.active_ads} active Meta ads (${mem.share_awaiting_review}%) are still awaiting review in Ad Matching; products they may belong to show "Not enough data" rather than a shortage.`);
  if (!ctx.coverage || !ctx.coverage.available) notes.push((ctx.coverage && ctx.coverage.reason) || 'Meta ad data is unavailable, so no product can be confirmed as needing creative.');
  if (tierState !== 'ok') notes.push(tierReason);
  if (tiers) notes.push('Platinum / Rocket are Demand Planning\'s own classification (first 28 days of sales against products that first sold the same week). Products that first sold before the start of the ~12-month sales export cannot be compared with their launch.');
  notes.push('Seasonal rule: tees, shorts, swim and lightweight shirts are in season approaching Australian summer; winter trackpants and heavy fleece are not; jeans and long pants are neutral. This is a WNDRR rule, not measured sales; a measured sales pattern outranks it.');
  notes.push('Dynamic Product Ads are not counted as creative coverage.');

  return {
    available: true, generated_at: now.toISOString(), today, week_start: weekStart,
    config: { min_performing_creatives: cfg.min_performing_creatives, test_period_days: cfg.test_period_days, recent_creative_days: cfg.recent_creative_days, stale_creative_days: cfg.stale_creative_days, opp_min_recent_units: cfg.opp_min_recent_units, opp_min_stock_units: cfg.opp_min_stock_units, revival_decline_pct: cfg.revival_decline_pct, revival_min_cover_weeks: cfg.revival_min_cover_weeks, high_stock_min_soh: hsMin },
    core: { items: coreItems, counts: countBy(coreItems), total: coreItems.length, actionable: coreItems.filter((i) => i.actionable).length },
    high_stocks: { items: hsItems, counts: countBy(hsItems), total: hsItems.length, actionable: hsItems.filter((i) => i.actionable).length, tier_state: tierState, tier_note: tierReason },
    launch_review: launchReview,
    data: { notes, config_issues: configIssues, coverage_reliability: mem, season_source: ctx.salesSource ? ctx.salesSource.label : null, benchmarks_source: benchmarks.source || null },
  };
}

async function getOpportunities({ fresh = false, deps } = {}) {
  if (!fresh && !deps && memo && Date.now() - memo.at < MEMO_MS) return memo.value;
  const value = await computeOpportunities({ deps });
  if (!deps) memo = { at: Date.now(), value };
  return value;
}


// READ-ONLY diagnostics for "why are so many products in launch verification?": exactly what the catalogue holds in the launch-date field, split by whether the value is
// missing, unreadable or readable, and by whether the product matters today (stock, an open order or recent sales). Reads the cached ApparelMagic catalogue only.
async function launchDiagnostics({ deps = {} } = {}) {
  const am = deps.am || await require('./planningData').fetchAmData();
  if (!am.amConfigured || !am.amDetails) return { available: false, reason: 'ApparelMagic is not configured or has not loaded.' };
  const salesByStyle = deps.salesByStyle !== undefined ? deps.salesByStyle : (apparelmagic.getAmCacheStatus().sales.hasData ? await apparelmagic.getSalesByStyle() : null);
  const today = deps.today || ymdInZone(new Date(), REPORTING_TIMEZONE);
  const d = { styles: 0, core: 0, readable_past: 0, readable_future: 0, no_date: 0, unreadable: 0, no_date_relevant: 0, no_date_historical: 0, no_date_core: 0 };
  const rawCounts = new Map(); const bySeason = {};
  am.amDetails.forEach((det, code) => {
    if (!apparelmagic.isWndrrStyleCode(code) || apparelmagic.isAdExcludedCategory(det)) return;
    d.styles += 1; if (det.isCore) d.core += 1;
    const stock = Math.max(0, Number(am.amStock && am.amStock.get(code)) || 0);
    const sold = salesByStyle && salesByStyle.get(code) ? num(salesByStyle.get(code).qty30) : 0;
    const open = am.amOnOrder ? Math.max(0, Number(am.amOnOrder.get(code)) || 0) : 0;
    const relevant = stock > 0 || sold > 0 || open > 0;
    if (det.launchDate) { if (det.launchDate.toISOString().slice(0, 10) > today) d.readable_future += 1; else d.readable_past += 1; return; }
    if (det.launchDateRaw) {
      d.unreadable += 1; const e = rawCounts.get(det.launchDateRaw) || { raw: det.launchDateRaw, n: 0, examples: [] }; e.n += 1; if (e.examples.length < 3) e.examples.push(code); rawCounts.set(det.launchDateRaw, e); return;
    }
    d.no_date += 1; if (det.isCore) d.no_date_core += 1;
    if (relevant) d.no_date_relevant += 1; else d.no_date_historical += 1;
    const season = code.slice(0, 3); bySeason[season] = bySeason[season] || { no_date: 0, relevant: 0 }; bySeason[season].no_date += 1; if (relevant) bySeason[season].relevant += 1;
  });
  return {
    available: true, today, ...d,
    unreadable_values: [...rawCounts.values()].sort((a, b) => b.n - a.n).slice(0, 25),
    no_date_by_season_code: Object.entries(bySeason).sort((a, b) => b[1].no_date - a[1].no_date).slice(0, 12).map(([season_code, v]) => ({ season_code, ...v })),
    explanation: 'Styles with NO date in the field are mostly historical catalogue entries (older seasons, nothing in stock or on order, no recent sales). The opportunity engine and High Stocks only ask the team about products that matter today; the rest are not shown. Unreadable values are listed so a parsing gap can be fixed; none is guessed.',
  };
}

module.exports = { computeOpportunities, getOpportunities, invalidate, familyTier, mondayOf, launchDiagnostics };
