// Gathers everything the weekly video plan needs and runs the pure engine (lib/weeklyVideoPlan.js). READ-ONLY: local database + cached ApparelMagic only. It never
// writes, never calls Meta or Shopify, never starts a sync. Every source is injectable (deps) so it is testable with fixtures; a source that is missing is reported,
// not guessed. The result is the Shoot Plan's "recommended / planned / remaining" view of the week.
const { pool } = require('../db');
const apparelmagic = require('./apparelmagic');
const planningContext = require('./planningContext');
const cfgLib = require('./creativePlanningConfig');
const perf = require('./productAdPerformance');
const launch = require('./launchStatus');
const launchInputs = require('./launchInputs');
const mixLib = require('./creativeMix');
const engine = require('./weeklyVideoPlan');
const nameCopies = require('./metaNameCopies');

const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);
const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const mondayOf = (s) => { const [y, m, d] = s.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d)); const dow = (dt.getUTCDay() + 6) % 7; return new Date(Date.UTC(y, m - 1, d - dow)).toISOString().slice(0, 10); };

// What is already planned / in production, per product CODE, for one week, plus what is still in production from earlier weeks.
// A shoot_plan_item is a product's workspace for a week; each video-format concept in it (creative_assets) is one VIDEO. The planned figure for an item is
// whichever is larger: the quantity someone planned, or the video concepts that actually exist (work is never silently dropped from the count).
async function loadShootPlanCounts(db, weekStart, lookbackWeeks) {
  const items = (await db.query(
    `SELECT spi.id, spi.product_code, spi.source, spi.planned_videos,
            COUNT(ca.id) FILTER (WHERE ca.format = 'video')::int AS video_assets,
            COUNT(ca.id) FILTER (WHERE ca.format = 'video' AND ca.status IN ('awaiting_concept_development', 'concept_script', 'not_started', 'awaiting_proven_concept'))::int AS in_concept,
            COUNT(ca.id) FILTER (WHERE ca.format = 'video' AND ca.status IN ('filming', 'editing', 'qc'))::int AS in_production,
            COUNT(ca.id) FILTER (WHERE ca.format = 'video' AND ca.status = 'uploaded_live')::int AS completed
       FROM shoot_plan_items spi LEFT JOIN creative_assets ca ON ca.shoot_plan_item_id = spi.id
      WHERE spi.week_start = $1::date GROUP BY spi.id`, [weekStart])).rows;
  const earlier = (await db.query(
    `SELECT spi.product_code, COUNT(ca.id)::int AS n
       FROM shoot_plan_items spi JOIN creative_assets ca ON ca.shoot_plan_item_id = spi.id
      WHERE ca.format = 'video' AND ca.status <> 'uploaded_live' AND spi.week_start < $1::date AND spi.week_start >= ($1::date - ($2::int * 7))
      GROUP BY spi.product_code`, [weekStart, lookbackWeeks])).rows;
  const confirmed = (await db.query('SELECT confirmed_at FROM weekly_shoot_plan_confirmations WHERE week_start = $1::date', [weekStart])).rows[0] || null;
  return { items: items.map((i) => ({ ...i, planned: Math.max(i.planned_videos || 1, i.video_assets || 0) })), earlier, confirmed };
}

// A product's ROLE in the range, separate from its creative priority. Built only from what WNDRR's own data already says (nothing is invented):
//   Core = ApparelMagic's CORE product group (an established, ongoing range); New drop = launched within the configured number of days (ApparelMagic launch date, or its
//   Upcoming Drop); Seasonal = the seasonality read says it sells in seasons (in / coming into / out of season); everything else is Range. A product can have several.
const ROLE_LABEL = { core: 'Core', new_drop: 'New drop', seasonal: 'Seasonal', range: 'Range' };
function roleOf({ isCore, lstyles, season, today, newDropDays }) {
  const roles = [];
  const days = (d) => Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${ymd(d)}T00:00:00Z`)) / 86400000);
  if (isCore) roles.push({ key: 'core', basis: 'ApparelMagic CORE product group' });
  const recent = lstyles.map((x) => (x.launchDate ? ymd(x.launchDate) : x.drop && x.drop.launch_date && ymd(x.drop.launch_date) <= today ? ymd(x.drop.launch_date) : null)).filter((d) => d && d <= today && days(d) <= newDropDays).sort().pop();
  if (recent) roles.push({ key: 'new_drop', basis: `launched ${recent}` });
  if (season && ['in_season', 'coming_into_season', 'out_of_season'].includes(season.status)) roles.push({ key: 'seasonal', basis: 'seasonal sales pattern' });
  if (!roles.length) roles.push({ key: 'range', basis: 'not Core, not recently launched, no seasonal pattern' });
  return roles.map((r) => ({ ...r, label: ROLE_LABEL[r.key] }));
}

async function loadLaunchContext(db, styleCodes) {
  const drops = new Map();
  const overrides = new Map();
  try {
    const r = await db.query(`SELECT s.style_code, d.name, to_char(d.launch_date, 'YYYY-MM-DD') AS launch_date FROM styles s JOIN drops d ON d.id = s.drop_id WHERE s.style_code = ANY($1::text[])`, [styleCodes]);
    r.rows.forEach((x) => drops.set(x.style_code, { name: x.name, launch_date: x.launch_date }));
  } catch (e) { /* drops unavailable: launch status simply has less evidence */ }
  try {
    const r = await db.query(`SELECT DISTINCT ON (product_code) product_code, status, note FROM product_launch_overrides WHERE removed_at IS NULL ORDER BY product_code, id DESC`);
    r.rows.forEach((x) => overrides.set(x.product_code, { status: x.status, note: x.note }));
  } catch (e) { /* none */ }
  return { drops, overrides };
}

// → { available, reason?, week_start, plan, production (week totals), settings, config, data, vocab_note }
async function computeWeeklyVideoPlan({ weekStart, today, deps = {} } = {}) {
  const db = deps.db || pool;
  const todayStr = today || ymd(new Date());
  const week = weekStart || mondayOf(todayStr);
  const settings = deps.settings || await planningContext.loadSettings(db);
  const { config, issues: configIssues } = cfgLib.resolve(settings.creative_planning_config || {});

  // ApparelMagic (cached): catalogue, stock, open orders, sales
  const am = deps.am || await require('./planningData').fetchAmData();
  if (!am.amConfigured || !am.amDetails || !am.amStock) {
    return { available: false, reason: am.amConfigured ? 'The ApparelMagic catalogue or stock has not loaded yet.' : 'ApparelMagic is not configured, so the weekly plan cannot be built.', week_start: week, settings: publicSettings(settings), config };
  }
  const salesByStyle = deps.salesByStyle !== undefined ? deps.salesByStyle : (apparelmagic.getAmCacheStatus().sales.hasData ? await apparelmagic.getSalesByStyle() : null);
  const ctx = deps.planning || await planningContext.loadPlanningContext({ amDetails: am.amDetails, today: todayStr, deps: { settings, ...(deps.planningDeps || {}) } });
  const families = ctx.allFamilies.filter((f) => !f.is_core || true);

  // Meta evidence: approved benchmarks + the product's ads
  const benchmarks = deps.benchmarks || await require('./metaBenchmarks').getEffective();
  const evidence = deps.performance || await perf.loadProductAdPerformance(families.map((f) => ({ key: f.key, codes: f.codes })), { db, rules: benchmarks.rules, coded: benchmarks.coded, config, today: todayStr, nameCopies });

  // launch status
  const allStyles = families.flatMap((f) => f.style_codes);
  const lc = deps.launch || await loadLaunchContext(db, allStyles);
  const stockOf = (f) => (f.style_codes.some((c) => am.amStock.has(c)) ? { known: true, units: f.style_codes.reduce((s, c) => s + Math.max(0, Number(am.amStock.get(c)) || 0), 0) } : { known: !!am.amStock && f.style_codes.length > 0, units: 0 });
  const onOrderOf = (f) => (am.amOnOrder ? f.style_codes.reduce((s, c) => s + Math.max(0, Number(am.amOnOrder.get(c)) || 0), 0) : 0);
  const salesOf = (f) => {
    if (!salesByStyle) return null;
    const t = { units7: 0, units30: 0, units365: 0 };
    f.style_codes.forEach((c) => { const e = salesByStyle.get(c); if (e) { t.units7 += e.qty7 || 0; t.units30 += e.qty30 || 0; t.units365 += e.qty365 || 0; } });
    return { available: true, ...t };
  };

  // shoot plan counts
  const counts = deps.shootPlan || await loadShootPlanCounts(db, week, config.pipeline_lookback_weeks);
  const codeToFam = new Map(); families.forEach((f) => f.codes.forEach((c) => codeToFam.set(c, f.key))); families.forEach((f) => codeToFam.set(f.key, f.key));
  const plannedBy = new Map(); const earlierBy = new Map();
  counts.items.forEach((i) => { const k = codeToFam.get(i.product_code); if (!k) return; if (!plannedBy.has(k)) plannedBy.set(k, { this_week: 0, in_pipeline: 0, in_production: 0, in_concept: 0, completed: 0, by_source: {} }); const p = plannedBy.get(k); p.this_week += i.planned; p.in_production += i.in_production; p.in_concept += i.in_concept; p.completed += i.completed; p.by_source[i.source || 'manual'] = (p.by_source[i.source || 'manual'] || 0) + i.planned; });
  counts.earlier.forEach((e) => { const k = codeToFam.get(e.product_code); if (k) earlierBy.set(k, (earlierBy.get(k) || 0) + e.n); });
  const overridesBy = new Map();
  (ctx.overrides || []).forEach((o) => { const k = codeToFam.get(o.product_code); if (!k) return; if (!overridesBy.has(k)) overridesBy.set(k, []); overridesBy.get(k).push(o); });

  const pendingBy = ctx.coverage && ctx.coverage.available ? ctx.coverage.pending_by_family : null;
  const todayMs = Date.parse(`${todayStr}T00:00:00Z`);
  const inputs = families.map((f) => {
    const stock = stockOf(f); const onOrder = onOrderOf(f);
    const sales = salesOf(f);
    const lstyles = f.style_codes.map((c) => launchInputs.forStyle(c, { amDetails: am.amDetails, salesByStyle, drops: lc.drops, overrides: lc.overrides, shopify: lc.shopify || deps.shopifyEvidence || null }));
    const launchRes = launch.assessFamily({ styles: lstyles, familyOverride: lc.overrides.get(f.key) || null, stock, onOrder }, todayStr, launch.fromConfig(settings.creative_planning_config || {}));
    const ev = evidence.get(f.key) || { creatives: [], ads: 0 };
    const cov = ctx.coverage && ctx.coverage.available
      ? { known: true, active_ads: ctx.coverage.by_family.get(f.key) || 0, min: settings.min_active_ads, possible: (pendingBy && pendingBy.get(f.key)) || 0, unattributed: ctx.coverage.unattributed_pending || 0 }
      : { known: false, min: settings.min_active_ads };
    if (cov.known) cov.uncertain = cov.active_ads < cov.min && cov.active_ads + cov.possible >= cov.min;
    const performance = ctx.coverage && ctx.coverage.available ? perf.summarizeProduct(ev.creatives, { pendingAds: cov.possible, minPerforming: config.min_performing_creatives, activeAds: cov.active_ads }) : null;
    const created = ev.creatives.map((c) => c.created).filter(Boolean).map((d) => Math.floor((todayMs - Date.parse(`${ymd(new Date(d))}T00:00:00Z`)) / 86400000));
    const g = ctx.seasonality && ctx.seasonality.available ? ctx.seasonality.groups.get(f.key) : null;
    const season = !ctx.seasonality || !ctx.seasonality.available ? { status: 'unavailable', reason: (ctx.seasonality && ctx.seasonality.reason) || 'Seasonal data is unavailable' }
      : g ? { status: g.status, label: ({ in_season: 'In season', coming_into_season: 'Coming into season', out_of_season: 'Out of season', year_round: 'Year-round', shoulder: 'Shoulder season', insufficient_data: 'Insufficient data' })[g.status] || g.status, outlook: g.evidence && g.evidence.outlook ? g.evidence.outlook : null, level: g.level, evidence: g.evidence }
        : { status: 'insufficient_data', label: 'Insufficient data' };
    const roles = roleOf({ isCore: f.style_codes.some((c) => (am.amDetails.get(c) || {}).isCore), lstyles, season, today: todayStr, newDropDays: config.new_drop_days });
    const planned = plannedBy.get(f.key) || { this_week: 0, in_pipeline: 0, in_production: 0, in_concept: 0, completed: 0, by_source: {} };
    planned.in_pipeline = earlierBy.get(f.key) || 0;
    const colourways = f.style_codes.map((c) => { const d = am.amDetails.get(c) || {}; const e = salesByStyle ? salesByStyle.get(c) : null; const ls = launchRes.by_style.find((x) => x.style_code === c); return { style_code: c, colour_label: apparelmagic.resolveColourLabel(am.amDetails, c), image_url: d.imageUrl || null, soh: Math.max(0, Number(am.amStock.get(c)) || 0), units30: e ? Math.round(e.qty30 || 0) : null, launch_status: ls ? ls.status : 'unknown' }; });
    return {
      key: f.key, name: f.name, category: f.category, style_codes: f.style_codes, codes: f.codes, colourways, launch: launchRes, roles, role: roles[0], stock, sales, coverage: cov, performance, creatives: ev.creatives,
      creative_age_days: created.length ? Math.min(...created) : null, season, planned, overrides: overridesBy.get(f.key) || [], image_url: (colourways.find((c) => c.image_url) || {}).image_url || null,
    };
  });

  // planned videos that belong to no recommendation family (drops, promotions, products the engine does not rank) still use the week's capacity
  const rankedFam = new Set(inputs.filter((i) => i.launch.status !== 'unlaunched' && i.launch.status !== 'discontinued').map((i) => i.key));
  const plannedOther = counts.items.reduce((s, i) => { const k = codeToFam.get(i.product_code); return s + (k && rankedFam.has(k) ? 0 : i.planned); }, 0);
  const result = engine.buildWeeklyVideoPlan({ families: inputs, settings, config, today: todayStr, planned_other: plannedOther });

  // creative mix for the Shoot now products that still need videos (a person can edit it; a stored plan item's own mix wins in the UI)
  const vocab = deps.vocab || await loadVocab(db);
  const allCreatives = [...evidence.values()].flatMap((e) => e.creatives);
  const conceptEvidence = mixLib.poolConceptEvidence(allCreatives);
  const byKey = new Map(inputs.map((i) => [i.key, i]));
  result.products.forEach((p) => {
    const src = byKey.get(p.key);
    p.image_url = src.image_url; p.codes = src.codes; p.style_codes = src.style_codes; p.roles = src.roles; p.role = src.role;
    p.creative_summary = { active_ads: p.coverage && p.coverage.known ? p.coverage.active_ads : null, unique_creatives: p.performance ? p.performance.unique_creatives : null };
    if (p.category === 'SHOOT_NOW' && p.net_recommended > 0) p.mix = mixLib.suggestMix({ videos: p.net_recommended, creatives: src.creatives, vocab, conceptEvidence, minEvidence: 3 });
  });
  [...(result.verification || []), ...(result.excluded || [])].forEach((p) => {
    const src = byKey.get(p.key);
    if (src) { p.image_url = src.image_url; p.codes = src.codes; p.style_codes = src.style_codes; p.roles = src.roles; p.role = src.role; }
  });
  const totals = counts.items.reduce((t, i) => { t.planned += i.planned; t.in_concept += i.in_concept; t.in_production += i.in_production; t.completed += i.completed; return t; }, { planned: 0, in_concept: 0, in_production: 0, completed: 0 });
  const confirmed = !!counts.confirmed;
  result.production = {
    week_start: week, confirmed, confirmed_at: counts.confirmed ? counts.confirmed.confirmed_at : null,
    target: settings.weekly_video_target, recommended: result.summary.recommended_total, planned: totals.planned, remaining_capacity: result.summary.remaining_capacity,
    sent_to_production: confirmed ? totals.planned : 0, in_concept_development: totals.in_concept, in_production: totals.in_production, completed: totals.completed,
    definitions: {
      video: 'One video-format concept (a creative asset). Hook variations of the same concept are edits of one video.',
      planned: 'Videos planned in this week\'s Shoot Plan (the larger of the quantity set and the concepts that exist).',
      sent: 'Planned videos once the week\'s Shoot Plan has been confirmed and handed to Concept Development.',
      in_production: 'Videos in Filming, Editing or QC (Final Approval).', completed: 'Videos that are live (Uploaded/Live).',
    },
  };
  return { available: true, week_start: week, today: todayStr, ...result, settings: publicSettings(settings), config, config_issues: configIssues, data: { sales: !!salesByStyle, seasonality: ctx.seasonality && ctx.seasonality.available ? { available: true, source: ctx.salesSource && ctx.salesSource.label } : { available: false, reason: ctx.seasonality && ctx.seasonality.reason }, coverage: ctx.coverage && ctx.coverage.available ? { available: true, reliability: ctx.coverage.reliability } : { available: false, reason: ctx.coverage && ctx.coverage.reason }, meta_benchmarks: benchmarks.source } };
}

async function loadVocab(db) {
  try {
    const v = require('./metaMatchingVocab');
    const concepts = (await v.listConcepts(db)).map((c) => c.name);
    const creators = (await v.listCreators(db)).map((c) => c.name || c);
    return { concepts, creators };
  } catch (e) { return { concepts: [], creators: [] }; }
}

const publicSettings = (s) => ({ weekly_video_target: s.weekly_video_target, min_active_ads: s.min_active_ads, high_stock_min_soh: s.high_stock_min_soh, season_immediate_days: s.season_immediate_days, season_secondary_days: s.season_secondary_days });

// One short cache so the Planning tabs (Weekly Plan, Core, High Stocks, Shoot Plan) that all want the same plan do not each recompute it.
let memo = null;
const MEMO_MS = 20 * 1000;
const invalidate = () => { memo = null; };
async function getWeeklyPlan(weekStart, { fresh = false, deps } = {}) {
  const key = weekStart || 'current';
  if (!fresh && !deps && memo && memo.key === key && Date.now() - memo.at < MEMO_MS) return memo.value;
  const value = await computeWeeklyVideoPlan({ weekStart, deps });
  if (!deps) memo = { key, at: Date.now(), value };
  return value;
}

module.exports = { getWeeklyPlan, invalidate, computeWeeklyVideoPlan, loadShootPlanCounts, loadLaunchContext, roleOf, ROLE_LABEL, mondayOf, addDays };
