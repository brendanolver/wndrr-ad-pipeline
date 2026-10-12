// The WEEKLY VIDEO PLAN: which products deserve new creative this week, how many videos for each, and why.
//
// It EXTENDS the Batch 11 combined priority (stock, season, sales, confirmed ad coverage) with what a content team that makes ~20-30 videos a week needs:
//   * how the product's EXISTING ads are actually performing (lib/productAdPerformance.js), because eight weak ads need fresh creative and ten strong ones do not
//   * creative age and diversity, what is already planned this week and what is still in production from earlier weeks
//   * a short production lookahead for seasonality (0-7 days a strong lift, 8-14 days a small one, beyond that no lift this week)
//   * launch status (unlaunched products belong to Upcoming Drops) and uncertainty (unreviewed ads / unclear evidence are flagged, never read as a shortage)
// and turns it into ONE headline per product: SHOOT NOW, COMING UP, MONITOR or NO ACTION, with a video quantity and plain-language reasons.
//
// HOW A PRODUCT IS SCORED (points are listed on every product so the ranking is never a black box):
//   NEED  = why new creative would help   (confirmed-ad coverage, effective coverage from ad performance, fading ads, creative age, repeated concepts)
//   WORTH = why it is worth the investment (current sales, stock, seasonal lift)
//   score = NEED + WORTH. The category comes from the score, then HARD RULES cap it (out of stock, weak sales with no lift, missing sales data, unclear evidence,
//   not launched), then a manual override may raise or lower it. Videos come from a matrix of need tier x demand tier (Settings), minus what is already planned
//   this week and what is still in production, and are NEVER padded to reach the weekly target.
// Pure: no database, no clock, no network (everything is passed in).
const prio = require('./creativePriority');
const cfgFile = require('./creativePriorityConfig');

const CATEGORIES = ['SHOOT_NOW', 'COMING_UP', 'MONITOR', 'NO_ACTION'];
const CATEGORY_LABEL = { SHOOT_NOW: 'Shoot now', COMING_UP: 'Coming up', MONITOR: 'Monitor', NO_ACTION: 'No action' };
const RANK = { SHOOT_NOW: 3, COMING_UP: 2, MONITOR: 1, NO_ACTION: 0 };
const NEED_TIERS = { high: 35, medium: 20, low: 10 };      // need points
const DEMAND_TIERS = { strong: 30, ok: 12 };               // worth-investing points from sales + stock + season
const OVERRIDE_FLOOR = { manual_high: 'SHOOT_NOW', major_promotion: 'SHOOT_NOW', strategic_launch: 'SHOOT_NOW', manual_medium: 'COMING_UP', upcoming_drop: 'COMING_UP', confirmed_restock: 'COMING_UP' };

const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
const fmt = (n) => Number(n).toLocaleString('en-AU');

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

// demand classification for every family at once (a relative ranking within WNDRR's own launched, in-stock range: never an absolute invented figure)
function classifySales(families, config) {
  const pool = families.filter((f) => f.launch && f.launch.eligible && f.stock && f.stock.known && f.stock.units > 0 && f.sales && f.sales.available);
  const units = pool.map((f) => Number(f.sales.units30) || 0).sort((a, b) => a - b);
  const enough = pool.length >= 8;
  const strongCut = enough ? percentile(units, config.strong_sales_percentile) : null;
  const weakCut = enough ? percentile(units, config.weak_sales_percentile) : null;
  const out = new Map();
  families.forEach((f) => {
    if (!f.sales || !f.sales.available) { out.set(f.key, { band: 'unknown', text: 'Sales data is not available, so sales are not weighed.' }); return; }
    const u30 = Number(f.sales.units30) || 0; const u365 = Number(f.sales.units365) || 0;
    const avg30 = (u365 * 30) / 365;
    const trend = avg30 > 0 && u30 >= avg30 * 1.25 ? 'up' : avg30 > 0 && u30 <= avg30 * 0.75 ? 'down' : 'flat';
    let band;
    if (!enough) band = u30 > 0 ? 'neutral' : 'weak';
    else band = u30 >= strongCut && u30 > 0 ? 'strong' : u30 <= weakCut ? 'weak' : 'neutral';
    const rel = enough ? ` (${band === 'strong' ? `top ${100 - config.strong_sales_percentile}%` : band === 'weak' ? `bottom ${config.weak_sales_percentile}%` : 'mid-range'} of ${pool.length} launched, in-stock products)` : ' (too few products to rank demand, so only zero sales read as weak)';
    out.set(f.key, { band, trend, units30: u30, text: band === 'strong' ? `Strong current sales: ${fmt(u30)} units in 30 days${rel}${trend === 'up' ? ', rising' : ''}.` : band === 'weak' ? `Weak current sales: ${fmt(u30)} units in 30 days${rel}.` : `Steady sales: ${fmt(u30)} units in 30 days${rel}.` });
  });
  return out;
}

// one family -> { need: [{key,label,points,text}], worth: [...], flags: [...] , totals }
function scoreFamily(f, sales, config, settings) {
  const need = []; const worth = []; const flags = [];
  const push = (arr, key, label, points, text) => arr.push({ key, label, points, text });

  // ---- NEED: confirmed-ad coverage (Batch 11 rule: only confirmed / auto-matched ads count; awaiting-review ads keep it uncertain) ----
  const cov = f.coverage;
  if (!cov || !cov.known) { push(need, 'coverage', 'Ad coverage', 0, 'Active ad counts are not available, so coverage is not weighed.'); flags.push('coverage_unknown'); }
  else {
    const min = cov.min || settings.min_active_ads || 5; const n = cov.active_ads || 0;
    const uncertain = !!cov.uncertain || (n < min && (cov.possible || 0) + (cov.unattributed || 0) + n >= min);
    if (n >= min) push(need, 'coverage', 'Ad coverage', 0, `${plural(n, 'confirmed active ad')} meets the minimum of ${min}.`);
    else if (uncertain) { push(need, 'coverage', 'Ad coverage', 0, `${plural(n, 'confirmed active ad')} is below the minimum of ${min}, but active ads are still awaiting review, so the count may be incomplete. Not treated as a shortage.`); flags.push('coverage_uncertain'); }
    else {
      const ratio = n / min;
      const pts = n === 0 ? 25 : ratio <= 0.4 ? 20 : ratio <= 0.8 ? 12 : 8;
      push(need, 'coverage', 'Ad coverage', pts, `${n === 0 ? 'No confirmed active ads' : `Only ${plural(n, 'confirmed active ad')}`} (minimum ${min}).`);
    }
  }

  // ---- NEED: effective coverage from how the existing ads are doing ----
  const perf = f.performance;
  if (!perf || perf.unique_creatives === 0) {
    push(need, 'performance', 'Ad performance', 0, perf ? 'No running creative to judge.' : 'Ad performance is not available for this product.');
    if (!perf) flags.push('performance_unavailable');
  } else {
    let pts = 0; let text;
    if (perf.assessment === 'healthy') { pts = -12; text = `Existing creative is healthy: ${perf.text}`; }
    else if (perf.assessment === 'mixed') { pts = 8; text = `Mixed creative results: ${perf.text}`; }
    else if (perf.assessment === 'thin') { pts = 14 + Math.min(10, perf.clear_weak * 3); text = `Thin effective coverage: ${perf.text}`; }
    else { pts = 0; text = `Effective coverage is unclear: ${perf.text}`; flags.push('performance_unclear'); }
    if (perf.judged >= 3 && perf.weak_share !== null && perf.weak_share >= 50) { pts += 10; text += ` ${perf.weak_share}% of judged creatives are weak or fading.`; }
    if (perf.declining >= 1) { const d = Math.min(10, perf.declining * 4); pts += d; text += ` ${plural(perf.declining, 'creative is', 'creatives are')} declining against ${perf.declining === 1 ? 'its' : 'their'} own earlier results.`; }
    push(need, 'performance', 'Ad performance', pts, text);
  }

  // ---- NEED: creative age ----
  const age = f.creative_age_days;
  if (age === null || age === undefined) push(need, 'age', 'Creative age', 0, 'No running creative to date.');
  else if (age > config.creative_age_old_days) push(need, 'age', 'Creative age', 15, `The newest running creative is ${age} days old (old after ${config.creative_age_old_days}).`);
  else if (age > config.creative_age_stale_days) push(need, 'age', 'Creative age', 10, `The newest running creative is ${age} days old (ageing after ${config.creative_age_stale_days}).`);
  else if (age < 14) push(need, 'age', 'Creative age', -5, `Fresh creative: the newest was made ${age} days ago.`);
  else push(need, 'age', 'Creative age', 0, `The newest running creative is ${age} days old.`);

  // ---- NEED: diversity (the same concept repeated) ----
  const cs = f.creatives || [];
  if (cs.length >= 4) {
    const concepts = new Set(cs.map((c) => String(c.concept || '').trim().toLowerCase()).filter(Boolean));
    if (concepts.size <= 1 && concepts.size > 0) push(need, 'diversity', 'Concept diversity', 8, `${cs.length} creatives but only ${concepts.size} concept: little variety to test.`);
    else if (cs.length >= 6 && concepts.size > 0 && concepts.size <= 2) push(need, 'diversity', 'Concept diversity', 4, `${cs.length} creatives across only ${concepts.size} concepts.`);
  }

  // ---- WORTH: sales, stock, season ----
  const P = { sales: { strong: 20, up: 5, neutral: 8, weak: -15, down: -4 } };
  if (sales.band === 'unknown') { push(worth, 'sales', 'Sales', 0, sales.text); flags.push('sales_unavailable'); }
  else {
    let pts = sales.band === 'strong' ? P.sales.strong : sales.band === 'weak' ? P.sales.weak : P.sales.neutral;
    if (sales.band !== 'weak' && sales.trend === 'up') pts += P.sales.up;
    if (sales.trend === 'down') pts += P.sales.down;
    push(worth, 'sales', 'Sales', pts, sales.text);
  }
  const sb = prio.stockBand(f.stock, { highMin: settings.high_stock_min_soh > 0 ? settings.high_stock_min_soh : Infinity });
  const restock = f.launch && f.launch.restock;
  if (sb.band === 'unknown') { push(worth, 'stock', 'Stock', 0, 'Stock is not available, so it is not weighed.'); flags.push('stock_unknown'); }
  else if (sb.band === 'out') push(worth, 'stock', 'Stock', restock ? -5 : -40, restock ? `Out of stock, but ${fmt(f.launch.on_order)} units are on order.` : 'Out of stock.');
  else if (sb.band === 'low') push(worth, 'stock', 'Stock', restock ? -2 : -15, `${fmt(sb.units)} units available: below the ${cfgFile.STOCK_GATE_UNITS}-unit minimum${restock ? `, with ${fmt(f.launch.on_order)} on order` : ''}.`);
  else push(worth, 'stock', 'Stock', sb.band === 'high' ? 10 : 6, `${fmt(sb.units)} units available${sb.band === 'high' ? ': strong stock' : ''}.`);
  const se = f.season;
  if (!se || se.status === 'unavailable') { push(worth, 'season', 'Season', 0, `${(se && se.reason) || 'Seasonal data has not loaded'}, so season is not weighed.`); flags.push('season_unavailable'); }
  else if (se.status === 'insufficient_data') { push(worth, 'season', 'Season', 0, 'Not enough sales history to judge seasonality; season is not weighed.'); flags.push('season_insufficient'); }
  else {
    const o = se.outlook || {};
    if (o.boost === 'strong') push(worth, 'season', 'Season', 12, o.text);
    else if (o.boost === 'small') push(worth, 'season', 'Season', 5, o.text);
    else if (se.status === 'out_of_season') push(worth, 'season', 'Season', -10, `Out of season. ${o.text || ''}`.trim());
    else push(worth, 'season', 'Season', 0, o.text || (se.status === 'year_round' ? 'Sells steadily all year: no seasonal lift.' : 'No seasonal lift this week.'));
  }
  const sum = (a) => a.reduce((s, x) => s + x.points, 0);
  return { need, worth, flags, need_points: sum(need), worth_points: sum(worth), stock_band: sb.band, stock_units: sb.units };
}

function activeOverrides(list, today) {
  return (list || []).filter((o) => o && (!o.until || !today || String(o.until) >= today));
}

// MAIN
function buildWeeklyVideoPlan({ families = [], settings = {}, config, today, planned_other = 0 } = {}) {
  const cfg = config;
  const target = Number(settings.weekly_video_target) || 25;
  const sales = classifySales(families, cfg);
  const items = [];
  const excluded = [];
  families.forEach((f) => {
    const l = f.launch || { status: 'unknown', eligible: false, needs_check: true };
    const base = { key: f.key, name: f.name, category_name: f.category || null, launch: l, colourways: f.colourways || [], planned: f.planned || { this_week: 0, in_pipeline: 0, in_production: 0, completed: 0, by_source: {} } };
    if (l.status === 'unlaunched' || l.status === 'discontinued') {
      excluded.push({ ...base, reason: l.status === 'discontinued' ? 'Discontinued / inactive.' : l.detail, in_upcoming_drop: !!l.in_upcoming_drop });
      return;
    }
    const sc = scoreFamily(f, sales.get(f.key), cfg, settings);
    const score = sc.need_points + sc.worth_points;
    const caps = []; // [{category, why}]
    const cap = (category, why) => caps.push({ category, why });
    if (!l.eligible) cap('MONITOR', 'Launch status is unknown: confirm the product has launched before shooting for it.');
    if (sc.stock_band === 'out' && !(f.launch && f.launch.restock)) cap('MONITOR', 'Out of stock: not an immediate shoot unless a restock, drop or manual priority justifies it.');
    else if (sc.stock_band === 'low' && !(f.launch && f.launch.restock)) cap('COMING_UP', 'Low stock: generally a lower shoot priority.');
    const sb = sales.get(f.key).band;
    const boost = f.season && f.season.outlook ? f.season.outlook.boost : 'none';
    if (sb === 'weak' && boost === 'none') cap('MONITOR', 'Weak current sales with no seasonal lift in the next two weeks.');
    if (sb === 'unknown') cap('COMING_UP', 'Sales data is missing, so a shoot is not justified yet.');
    if (sc.flags.includes('coverage_unknown') && sc.flags.includes('performance_unavailable')) cap('MONITOR', 'No Meta ad data at all: not enough evidence to say what is needed.');
    // category from the score
    let category = score >= cfg.shoot_now_min_score ? 'SHOOT_NOW' : score >= cfg.coming_up_min_score ? 'COMING_UP' : score >= cfg.monitor_min_score ? 'MONITOR' : 'NO_ACTION';
    // a shoot needs a real NEED and a real reason to invest
    if (category === 'SHOOT_NOW' && (sc.need_points < 15 || sc.worth_points < 14)) { category = 'COMING_UP'; caps.push({ category: 'COMING_UP', why: sc.need_points < 15 ? 'There is no strong need for more creative yet.' : 'Not enough reason to invest this week.' }); }
    if (sc.flags.includes('performance_unclear') && sc.flags.includes('coverage_uncertain') && RANK[category] > RANK.MONITOR && sc.need_points < 15) category = 'MONITOR';
    caps.forEach((c) => { if (RANK[c.category] < RANK[category]) category = c.category; });
    const capNotes = caps.filter((c) => RANK[c.category] <= RANK[category]).map((c) => c.why);

    // manual override
    const ov = activeOverrides(f.overrides, today);
    const exceptions = [];
    let lowered = null;
    ov.forEach((o) => {
      const floor = OVERRIDE_FLOOR[o.kind];
      if (floor && RANK[floor] > RANK[category]) { category = floor; exceptions.push({ kind: o.kind, note: o.note || null, source: 'manual', effect: `raised to ${CATEGORY_LABEL[floor]}` }); }
      else if (floor) exceptions.push({ kind: o.kind, note: o.note || null, source: 'manual', effect: 'already at or above this' });
      if (o.kind === 'manual_low') { if (RANK[category] > RANK.MONITOR) category = 'MONITOR'; lowered = o; exceptions.push({ kind: o.kind, note: o.note || null, source: 'manual', effect: 'held at Monitor' }); }
    });
    if (f.launch && f.launch.restock && RANK[category] < RANK.COMING_UP && sb !== 'weak') { category = 'COMING_UP'; exceptions.push({ kind: 'confirmed_restock', note: `${fmt(f.launch.on_order)} units on order`, source: 'on_order', effect: 'raised to Coming up' }); }

    // quantity
    const needTier = sc.need_points >= NEED_TIERS.high ? 'high' : sc.need_points >= NEED_TIERS.medium ? 'medium' : sc.need_points >= NEED_TIERS.low ? 'low' : null;
    const demandTier = sc.worth_points >= DEMAND_TIERS.strong ? 'strong' : sc.worth_points >= DEMAND_TIERS.ok ? 'ok' : 'low';
    let matrix = needTier ? Number(cfg[`videos_${needTier}_need_${demandTier}`]) : 0;
    matrix = Math.min(matrix, cfg.max_videos_per_product);
    const overrideVideos = ov.map((o) => o.videos).find((v) => v !== null && v !== undefined);
    let recommended = category === 'SHOOT_NOW' ? Math.max(1, matrix) : 0;
    if (category === 'SHOOT_NOW' && matrix === 0) { category = 'COMING_UP'; recommended = 0; capNotes.push('The sizing rules give no videos for this need and demand.'); }
    let manualVideos = false;
    if (overrideVideos !== undefined) { recommended = Math.min(cfg.max_videos_per_product, overrideVideos); manualVideos = true; if (recommended > 0 && RANK[category] < RANK.SHOOT_NOW) category = 'SHOOT_NOW'; if (recommended === 0 && category === 'SHOOT_NOW') category = 'COMING_UP'; }
    const pl = base.planned;
    const inPipeline = pl.in_pipeline || 0;
    const net = Math.max(0, recommended - inPipeline);
    const remaining = Math.max(0, net - (pl.this_week || 0));

    const reasons = [];
    sc.worth.concat(sc.need).filter((x) => x.points !== 0 || x.key === 'coverage').forEach((x) => reasons.push({ key: x.key, label: x.label, points: x.points, text: x.text }));
    if (inPipeline > 0 && recommended > 0) reasons.push({ key: 'pipeline', label: 'In production', points: 0, text: `${plural(inPipeline, 'video')} from earlier weeks ${inPipeline === 1 ? 'is' : 'are'} still in production and will become new creative, so ${plural(inPipeline, 'video')} fewer ${inPipeline === 1 ? 'is' : 'are'} needed.` });
    if (pl.this_week > 0) reasons.push({ key: 'planned', label: 'Planned', points: 0, text: `${plural(pl.this_week, 'video')} already planned this week.` });
    items.push({
      ...base, category, category_label: CATEGORY_LABEL[category], score, need_points: sc.need_points, worth_points: sc.worth_points,
      need_tier: needTier, demand_tier: demandTier, recommended_videos: recommended, manual_videos: manualVideos, net_recommended: net, remaining, in_pipeline: inPipeline,
      factors: { need: sc.need, worth: sc.worth }, reasons, caps: capNotes, exceptions, flags: sc.flags, sales: sales.get(f.key), stock: { band: sc.stock_band, units: sc.stock_units, on_order: f.launch && f.launch.on_order },
      season: f.season ? { status: f.season.status, label: f.season.label, outlook: f.season.outlook || null } : null,
      coverage: f.coverage || null, performance: f.performance || null, creative_age_days: f.creative_age_days ?? null,
      headline: headline(category, recommended, net, pl, name(f), manualVideos),
    });
  });

  // rank: category, then score
  items.sort((a, b) => RANK[b.category] - RANK[a.category] || b.score - a.score || a.name.localeCompare(b.name));
  // allocation against the weekly target: only SHOOT NOW work competes for capacity; unused capacity is NEVER filled with weak recommendations
  const plannedTotal = items.reduce((s, i) => s + (i.planned.this_week || 0), 0) + (planned_other || 0);
  let capacity = Math.max(0, target - plannedTotal);
  let allocatedTotal = 0; let deferredTotal = 0;
  items.forEach((i) => {
    if (i.category !== 'SHOOT_NOW' || i.remaining <= 0) { i.allocated = 0; i.deferred = 0; return; }
    const a = Math.min(i.remaining, capacity); capacity -= a; i.allocated = a; i.deferred = i.remaining - a; allocatedTotal += a; deferredTotal += i.deferred;
  });
  const recommendedTotal = items.filter((i) => i.category === 'SHOOT_NOW').reduce((s, i) => s + Math.max(i.net_recommended, i.planned.this_week || 0), 0);
  const needsCheck = items.filter((i) => i.launch && i.launch.needs_check);
  const counts = {}; CATEGORIES.forEach((c) => { counts[c] = items.filter((i) => i.category === c).length; });
  const remainingCapacity = Math.max(0, target - plannedTotal);
  const explanation = remainingCapacity === 0
    ? `The ${target}-video target is already planned.`
    : deferredTotal > 0
      ? `${recommendedTotal} videos are recommended but only ${remainingCapacity} fit in the remaining capacity: the highest-ranked ${allocatedTotal} are allocated and ${deferredTotal} are deferred.`
      : allocatedTotal + plannedTotal < target
        ? `Only ${plannedTotal + allocatedTotal} worthwhile videos were identified for the ${target}-video target. The remaining ${target - plannedTotal - allocatedTotal} are deliberately not filled with weak recommendations.`
        : `The recommendations fill the ${target}-video target.`;
  return {
    today, target, config: cfg, categories: CATEGORIES, category_labels: CATEGORY_LABEL, products: items, excluded, needs_launch_check: needsCheck.map((i) => i.key), counts,
    summary: { target, recommended_total: recommendedTotal, planned_total: plannedTotal, remaining_capacity: remainingCapacity, to_plan_from_recommendations: allocatedTotal, deferred: deferredTotal, explanation },
  };
}
const name = (f) => f.name;

function headline(category, recommended, net, pl, nm, manual) {
  if (category === 'SHOOT_NOW') {
    if (net === 0 && recommended > 0) return `${plural(recommended, 'video')} recommended — already covered by videos in production.`;
    const left = Math.max(0, net - (pl.this_week || 0));
    if (left === 0) return `${plural(net, 'video')} recommended — all planned this week.`;
    return `Shoot ${plural(left, 'video')} this week${pl.this_week ? ` (${pl.this_week} already planned)` : ''}${manual ? ' — set manually' : ''}.`;
  }
  if (category === 'COMING_UP') return 'Worth preparing, but not urgent this week.';
  if (category === 'MONITOR') return 'No new creative needed yet — keep an eye on it.';
  return 'No worthwhile creative opportunity right now.';
}

module.exports = { CATEGORIES, CATEGORY_LABEL, RANK, NEED_TIERS, DEMAND_TIERS, classifySales, scoreFamily, buildWeeklyVideoPlan, percentile };
