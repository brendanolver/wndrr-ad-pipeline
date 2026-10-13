// Assembles everything the opportunity engine (lib/planningOpportunities.js) needs, from sources the app already has, and returns the Core and High Stocks lists.
// Read-only: it writes nothing and never calls ApparelMagic, Shopify or Meta beyond what the existing cached loaders already do.
//
//   ApparelMagic (cached)   catalogue (CORE group, mid_code launch date), stock, on order, sales by style
//   Report Pipeline         Demand Planning's Platinum / Rocket classification + first-28-day vs latest-28-day sales (lib/reportPipeline.js). NOT reimplemented here.
//   local database          Meta ads / insights (unique creatives, approved benchmarks), launch overrides + drops, the Shoot Plan production records, settings
// A piece that cannot be loaded is reported (data.notes / the item status says "unavailable") and is never replaced by an unrelated number.
//
// One product (a "family": its colourways and season codes) is evaluated for every opportunity type it could qualify for (core, High Stocks revival, Protect
// Momentum) and shown ONCE, with one primary recommendation (lib/planningPrimary.js). Official Core products (ApparelMagic group AA CORE STYLES) always stay in
// Core and keep that identity; a High Stocks result never replaces a Core result. Non-Core Platinum / Rocket products are High Stocks; recent launches that qualify
// for Protect Momentum and are not Core are listed in their own `momentum` list (shown as a view inside the Core step, labelled "Not Core: recent launch").
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
const planningSales = require('./planningSales');
const primaryLib = require('./planningPrimary');
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
  const window = salesByStyle && salesByStyle.window ? salesByStyle.window : null;
  // size availability is a WARNING only and only where ApparelMagic exposes stock by size (the field is verified in production, never assumed): never loaded cold
  let sizesByStyle = null; let sizeField = null;
  try {
    if (deps.sizesByStyle !== undefined) { sizesByStyle = deps.sizesByStyle; sizeField = sizesByStyle ? 'injected' : null; }
    else if (apparelmagic.configured() && apparelmagic.getAmCacheStatus().stock && apparelmagic.getAmCacheStatus().stock.hasData) { const ss = await apparelmagic.getStockSizes(); sizesByStyle = ss.sizes && ss.sizes.size ? ss.sizes : null; sizeField = ss.sizeField || null; }
  } catch (e) { sizesByStyle = null; }
  const sizesOf = (f) => {
    if (!sizesByStyle) return null;
    const { orderSizes, sizeHealth } = require('./coreCreativePlan');
    const m = new Map();
    f.style_codes.forEach((c) => { const sm = sizesByStyle.get(c); if (sm) sm.forEach((q, sz) => m.set(sz, (m.get(sz) || 0) + Math.max(0, num(q)))); });
    return m.size ? sizeHealth(orderSizes(m.entries(), [])) : null;
  };
  const rows = families.map((f) => {
    const stock = stockOf(f);
    const lstyles = f.style_codes.map((c) => launchInputs.forStyle(c, { amDetails: am.amDetails, salesByStyle, drops: lc.drops, overrides: lc.overrides, shopify: lc.shopify || deps.shopifyEvidence || null }));
    const l = launch.assessFamily({ styles: lstyles, familyOverride: lc.overrides.get(f.key) || null, stock: { known: stock.known, units: stock.units }, onOrder: stock.on_order }, today, launchCfg);
    const ft = familyTier(f, tiers);
    const launchDate = planningSales.familyLaunchDate(l, am.amDetails);
    const fs = planningSales.familySales({ style_codes: f.style_codes, salesByStyle, window, launchDate, today, tierSales: ft.sales, cfg });
    const launchAge = launchDate ? planningSales.daysBetween(launchDate, today) : null;
    const lsByStyle = new Map(l.by_style.map((x) => [x.style_code, x.status]));
    const colourways = f.style_codes.map((c) => ({ style_code: c, colour_label: apparelmagic.resolveColourLabel(am.amDetails, c), image_url: (am.amDetails.get(c) || {}).imageUrl || null, launch_status: lsByStyle.get(c) || null, soh: Math.max(0, Number(am.amStock.get(c)) || 0) }));
    return { f, stock: { ...stock, sizes: sizesOf(f) }, sales: fs.sales, quality: fs.quality, launch: l, launch_date: launchDate, launch_age_days: launchAge, tier: ft.tier, colourways };
  });

  // who is evaluated for what:
  //   core      every official Core family (ApparelMagic group AA CORE STYLES): the classification is never inferred from sales, stock or age
  //   revival   Platinum / Rocket families (Demand Planning's classification) with enough stock: High Stocks for non-Core; for a Core family it is only supplementary evidence
  //   momentum  families officially launched (mid_code) within momentum_window_days with enough stock: no tier, decline or 56 days needed
  const hsMin = Math.max(num(settings.high_stock_min_soh), cfg.opp_min_stock_units);
  const isTierOk = (r) => r.tier && ['platinum', 'rocket'].includes(r.tier.tier);
  const isRecent = (r) => r.launch.eligible && r.launch_age_days !== null && r.launch_age_days >= 0 && r.launch_age_days <= cfg.momentum_window_days && r.stock.known && r.stock.units >= cfg.opp_min_stock_units;
  const coreRows = rows.filter((r) => r.f.is_core);
  const revivalRows = rows.filter((r) => isTierOk(r) && r.stock.known && r.stock.units >= hsMin);
  const momentumRows = rows.filter(isRecent);
  const need = new Map(); [...coreRows, ...revivalRows, ...momentumRows].forEach((r) => { if (r.launch.eligible && r.stock.known && r.stock.units >= cfg.opp_min_stock_units) need.set(r.f.key, r.f); });
  const evFamilies = [...need.values()].map((f) => ({ key: f.key, codes: f.codes }));

  // creative evidence (confirmed ads; DPAs excluded), history (includes paused winners), the Shoot Plan pipeline
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
    // ANY awaiting-review ad suggested for this product makes its picture uncertain (the old rule needed enough of them to reach the minimum)
    const cls = cov ? coverageLib.classify({ confirmed: active, possible, unattributed: cov.unattributed_pending || 0, min: settings.min_active_ads }) : null;
    const g = ctx.seasonality && ctx.seasonality.available ? ctx.seasonality.groups.get(f.key) : null;
    const h = hist.get(f.key) || { winners: [] };
    return {
      key: f.key, name: f.name, category: f.category, codes: f.codes, style_codes: f.style_codes, is_core: f.is_core, image_url: (r.colourways.find((c) => c.image_url) || {}).image_url || null,
      launch: r.launch, launch_age_days: r.launch_age_days, launch_date: r.launch_date, stock: r.stock, sales: r.sales, data_quality: r.quality, tier: r.tier, tierState,
      coverage: cov ? { known: true, active_ads: active, possible, unresolved: cov.unresolved_identities || 0, uncertain: !!(cls && cls.state === 'uncertain'), min: settings.min_active_ads } : { known: false, min: settings.min_active_ads },
      creatives: ev.creatives || [], history: h, pipeline: pipeFor(f), seasonData: g ? g.status : (ctx.seasonality && ctx.seasonality.available ? 'insufficient_data' : null), seasonEvidence: g && g.evidence ? g.evidence : null,
    };
  };

  const runMode = (rowSet, mode) => {
    const inputs = rowSet.map(toInput);
    const bands = opp.salesBands(inputs, cfg);
    return new Map(inputs.map((p) => {
      const band = opp.bandOf(p, bands, cfg);
      // season is assessed WITHOUT the strong-selling exception: the engine decides an exception from absolute units and creative evidence
      const s = season.assess({ category: p.category, name: p.name, month, data: p.seasonData, dataEvidence: p.seasonEvidence, patternIndex: cfg.season_pattern_index });
      return [p.key, opp.evaluate({ ...p, salesBand: band, season: s }, cfg, today, mode)];
    }));
  };
  const coreEvals = runMode(coreRows, 'core');
  const revivalEvals = runMode(revivalRows, 'revival');
  const momentumEvals = runMode(momentumRows, 'momentum');

  const colourFor = (key) => (rows.find((r) => r.f.key === key) || {}).colourways || [];
  const rowFor = (key) => rows.find((r) => r.f.key === key);
  const tierTag = (e) => (e.facts && e.facts.tier === 'platinum' ? 'Platinum' : e.facts && e.facts.tier === 'rocket' ? 'Rocket' : null);
  // one primary result per family
  const coreItems = []; const hsItems = []; const momentumItems = [];
  const keys = new Set([...coreRows, ...revivalRows, ...momentumRows].map((r) => r.f.key));
  keys.forEach((key) => {
    const r = rowFor(key);
    const pick = primaryLib.choosePrimary({ is_core: r.f.is_core, core: coreEvals.get(key) || null, revival: revivalEvals.get(key) || null, momentum: momentumEvals.get(key) || null });
    if (!pick.primary) return;
    const e = pick.primary;
    const tags = [];
    if (r.f.is_core) tags.push('Core'); if (tierTag(e)) tags.push(tierTag(e));
    if (e.mode === 'revival') tags.push('High Stocks'); if (e.mode === 'momentum') tags.push(r.f.is_core ? 'Protect momentum' : 'Recent launch');
    const kinds = pick.placement === 'core' ? ['core'] : pick.placement === 'high_stocks' ? ['high_stock'] : ['momentum'];
    if (pick.placement === 'core' && e.mode === 'momentum') kinds.push('momentum');
    const item = {
      ...e, product_code: (e.codes && e.codes[0]) || e.key, colourways: colourFor(key), kinds, tags, placement: pick.placement, also_qualifies: pick.also, evaluated_as: pick.evaluated,
      classification: r.f.is_core ? 'Official Core (ApparelMagic group AA CORE STYLES)' : (e.mode === 'momentum' ? 'Not Core: recent launch' : 'Not Core: Platinum / Rocket'),
      launch_date: r.launch_date, launch_age_days: r.launch_age_days,
    };
    (pick.placement === 'core' ? coreItems : pick.placement === 'high_stocks' ? hsItems : momentumItems).push(item);
  });

  const rank = { act: 0, testing: 1, in_production: 2, insufficient_data: 3, covered: 4, momentum_ok: 4, out_of_season: 5, weak_demand: 6, low_stock: 7, too_new: 8, no_proven_demand: 9, not_recent: 10, unavailable: 11, launch_unknown: 12, not_launched: 13 };
  const order = (a, b) => (rank[a.status] - rank[b.status]) || (b.score - a.score) || String(a.name).localeCompare(String(b.name));
  coreItems.sort(order); hsItems.sort(order); momentumItems.sort(order);
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

  // every family officially launched within the Protect Momentum window, whatever happened to it (so a launch such as a 1 October drop can be checked product by product)
  const placed = new Map([...coreItems, ...hsItems, ...momentumItems].map((i) => [i.key, i]));
  const recentLaunches = rows.filter((r) => r.launch_age_days !== null && r.launch_age_days >= 0 && r.launch_age_days <= cfg.momentum_window_days).map((r) => {
    const it = placed.get(r.f.key) || null;
    return {
      key: r.f.key, name: r.f.name, category: r.f.category, is_core: r.f.is_core, launch_date: r.launch_date, launch_age_days: r.launch_age_days, launch_status: r.launch.status,
      stock_units: r.stock.known ? r.stock.units : null, units7: r.sales.available ? Math.round(num(r.sales.units7)) : null, units14: r.sales.available ? Math.round(num(r.sales.units14)) : null, units30: r.sales.available ? Math.round(num(r.sales.units30)) : null,
      since_launch_units: r.sales.available ? r.sales.since_launch : null, avg_daily_since_launch: r.sales.available ? r.sales.avg_daily_since_launch : null, tier: r.tier ? r.tier.tier : null,
      evaluated: !!it, placement: it ? it.placement : null, status: it ? it.status : (r.stock.known && r.stock.units < cfg.opp_min_stock_units ? 'low_stock' : 'not_evaluated'), status_label: it ? it.status_label : null,
      opportunity_type: it ? it.opportunity_label : null, priority: it ? it.priority : null, reason: it ? it.reason : null,
    };
  }).sort((a, b) => String(a.launch_date).localeCompare(String(b.launch_date)) || String(a.name).localeCompare(String(b.name)));

  // data quality and freshness: every source named, with when it was last read and what is missing
  const mem = ctx.coverage && ctx.coverage.available && ctx.coverage.reliability ? ctx.coverage.reliability : null;
  let metaSync = null;
  try { const r = await db.query("SELECT max(finished_at) AS at FROM meta_sync_runs WHERE status = 'success'"); metaSync = r.rows[0] && r.rows[0].at ? new Date(r.rows[0].at).toISOString() : null; } catch (e) { metaSync = null; }
  const amStatus = apparelmagic.getAmCacheStatus ? apparelmagic.getAmCacheStatus() : {};
  const tierStatus = require('./amCache').cacheStatus('pipelineStyleTiers');
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const failedRecent = window && Array.isArray(window.failed_days) ? window.failed_days.filter((d) => d < 30) : [];
  const incompleteFamilies = rows.filter((r) => r.quality && r.quality.sales_complete === false && (r.launch.eligible)).length;
  const disagree = rows.filter((r) => r.quality && r.quality.discrepancy && r.quality.discrepancy.flag).length;
  const dataQuality = {
    recent_sales: { source: 'ApparelMagic online sales (customers ONLINE SALES and ICONIC ONLINE SALES; approved orders net of cancellations)', available: !!salesByStyle, fetched_at: window ? window.fetched_at || null : iso(amStatus.sales && amStatus.sales.fetchedAt), failed_requests: window ? window.failed_requests || 0 : null, total_requests: window ? window.total_requests || null : null, failed_days_last_30: failedRecent.length, complete: salesByStyle ? (failedRecent.length === 0 && !(window && window.failed_requests > 0 && !Array.isArray(window.failed_days))) : null },
    launch_pace: { source: 'Shopify export through Demand Planning (Platinum / Rocket tiers, first and latest 28 days); not changed by Planning', available: tierState === 'ok', fetched_at: iso(tierStatus.fetchedAt) },
    stock: { source: 'ApparelMagic sellable stock (summed over every colourway and season code of the product)', fetched_at: iso(amStatus.stock && amStatus.stock.fetchedAt), size_data: sizeField ? `by size (field ${sizeField})` : 'not available from ApparelMagic' },
    meta: { source: 'Meta-reported insights and ad status (Triple Whale is not connected and is not substituted); DPAs excluded', last_successful_sync: metaSync, unresolved_ad_identities: cov ? cov.unresolved_identities || 0 : null, ads_status_as_of: ctx.coverage && ctx.coverage.available ? ctx.coverage.status_as_of : null, awaiting_review: mem ? mem.awaiting_review : null, active_ads: mem ? mem.active_ads : null },
    families_with_incomplete_recent_sales: incompleteFamilies, families_with_disagreeing_sources: disagree,
  };
  if (mem && mem.awaiting_review > 0) notes.push(`${mem.awaiting_review} of ${mem.active_ads} active Meta ads (${mem.share_awaiting_review}%) are still awaiting review in Ad Matching; products they may belong to show "Not enough data" rather than a shortage.`);
  if (ctx.coverage && ctx.coverage.available && ctx.coverage.unresolved_identities > 0) notes.push(`${ctx.coverage.unresolved_identities} Meta ads that delivered in the last 14 days could not be identified (their name, campaign and creative lookup failed), so no product is confirmed as lacking creative until the next Meta sync resolves them.`);
  if (!ctx.coverage || !ctx.coverage.available) notes.push((ctx.coverage && ctx.coverage.reason) || 'Meta ad data is unavailable, so no product can be confirmed as needing creative.');
  if (tierState !== 'ok') notes.push(tierReason);
  if (tiers) notes.push('Platinum / Rocket are Demand Planning\'s own classification (first 28 days of sales against products that first sold the same week). Products that first sold before the start of the ~12-month sales export cannot be compared with their launch.');
  if (!dataQuality.recent_sales.complete && salesByStyle) notes.push(`Recent ApparelMagic sales may be under-counted: ${failedRecent.length ? `${failedRecent.length} of the last 30 days could not be read` : `${window.failed_requests} daily requests failed`}. No product is given High priority on incomplete sales.`);
  if (disagree) notes.push(`${disagree} products show a large difference between ApparelMagic online sales and the Shopify export for the latest 28 days; they are held at Medium priority. (ApparelMagic also includes ICONIC online sales, so small differences are normal.)`);
  notes.push('Recent sales (7 / 14 / 30 days, since launch) come from ApparelMagic online sales; launch pace (first 28 days vs latest 28 days) and Platinum / Rocket come from the Shopify export (Demand Planning). They are never blended. Windows include today, a part day.');
  notes.push('Seasonal rule: Australian calendar. Tees, shorts, short-sleeve shirts, swim are in season approaching summer; hoods, sweats, trackpants are not; 1/4 zips and long sleeves layer in autumn / winter / spring; jeans and pants are neutral. A measured sales pattern is used when reliable, but a Black Friday / Christmas peak is not a season. Out-of-season products qualify only on compelling current sales plus creative evidence.');
  notes.push('Dynamic Product Ads are not counted as creative coverage or concepts.');
  if (!sizeField) notes.push('Stock by size is not exposed by ApparelMagic here, so size availability does not affect recommendations.');

  return {
    available: true, generated_at: now.toISOString(), today, week_start: weekStart,
    config: { min_performing_creatives: cfg.min_performing_creatives, test_period_days: cfg.test_period_days, recent_creative_days: cfg.recent_creative_days, stale_creative_days: cfg.stale_creative_days, opp_min_recent_units: cfg.opp_min_recent_units, opp_min_stock_units: cfg.opp_min_stock_units, revival_decline_pct: cfg.revival_decline_pct, revival_min_cover_weeks: cfg.revival_min_cover_weeks, revival_min_age_days: cfg.revival_min_age_days, revival_min_recent_units: cfg.revival_min_recent_units, revival_min_pace_pct: cfg.revival_min_pace_pct, demand_steady_units: cfg.demand_steady_units, demand_strong_units: cfg.demand_strong_units, momentum_window_days: cfg.momentum_window_days, stock_min_cover_weeks: cfg.stock_min_cover_weeks, high_stock_min_soh: hsMin, priority_high_min: cfg.priority_high_min, priority_medium_min: cfg.priority_medium_min },
    core: { items: coreItems, counts: countBy(coreItems), total: coreItems.length, actionable: coreItems.filter((i) => i.actionable).length },
    high_stocks: { items: hsItems, counts: countBy(hsItems), total: hsItems.length, actionable: hsItems.filter((i) => i.actionable).length, tier_state: tierState, tier_note: tierReason },
    momentum: { items: momentumItems, counts: countBy(momentumItems), total: momentumItems.length, actionable: momentumItems.filter((i) => i.actionable).length },
    launch_review: launchReview, recent_launches: recentLaunches,
    data: { notes, config_issues: configIssues, coverage_reliability: mem, season_source: ctx.salesSource ? ctx.salesSource.label : null, benchmarks_source: benchmarks.source || null, quality: dataQuality },
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
