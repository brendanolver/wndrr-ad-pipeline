// CREATIVE INSIGHTS (Batch 30): which creative CONCEPTS work across WNDRR's products, and which products could test them.
//
// One source of truth, built from what already exists (nothing is re-derived a second way):
//   creative identity   productAdPerformance.creativeGroupKey / newGroup / addRowToGroup / mergeNameCopies: the same "unique creative" Planning counts (an identical Meta creative
//                       id, or a "- Copy" by name). One video running in five campaigns is ONE creative; different executions are never merged because they share a product,
//                       creator, concept or format.
//   verdicts            productAdPerformance.judgeAcrossFunnels over the approved benchmarks (metaBenchmarks.getEffective): each creative is judged WITHIN each funnel it ran in.
//                       Today only the MOF CPA has an approved benchmark, so TOF / TOM creatives are shown with their numbers and are never called good or bad.
//   concept             the HUMAN-confirmed Meta Ad Matching classification (meta_ad_classifications.concept_type_id / concept_label). Nothing is inferred from an ad name. An ad with no
//                       concept recorded is "unclassified": it is reported as classification coverage, never grouped into a concept. A free-text legacy label (no concept_type_id) is
//                       used but flagged.
//   evidence thresholds creativeOpportunitiesConfig.CONCEPT (the Creative Opportunities V1 evidence rules, kept as the single source of the numbers) plus the existing
//                       concentration share (creativePlanningConfig). Nothing new is invented; they are listed in the payload so the page can state them.
//   product eligibility the Planning engine's own result for each product (demand qualification, stock / colourway / size checks, season): this module never re-implements them.
//
// A concept is judged per approved-benchmark funnel, never from one blended CPA across TOF / TOM / MOF, and duplicated ads are never independent evidence (they are one creative).
//   ESTABLISHED WINNER  in a benchmarked funnel: at least CONCEPT.min_creatives unique creatives performing, on at least CONCEPT.test_min_products products (each with at least
//                       CONCEPT.min_product_spend of allocated spend), at least CONCEPT.min_spend and CONCEPT.min_purchases in total, more performing than underperforming
//                       creatives, and no single product carrying concentration_share_pct or more of the performing purchases (one exceptional product cannot make a winner).
//   PROMISING TEST      at least one creative performing and more performing than underperforming, but below the established requirements (limited sample).
//   MIXED PERFORMANCE   performing and underperforming creatives both present and the underperforming are as many or more.
//   WEAK                no creative performing and at least two underperforming (shown as "Underperforming").
//   INSUFFICIENT        nothing rated: no creative has enough delivery, or its funnel has no approved benchmark.
// A product's spend on a creative that features several products is split equally between them (the Creative Opportunities V1 rule); presence counts for every product.
const health = require('./metaFunnelHealth');
const perf = require('./productAdPerformance');
const recency = require('./creativeRecency');
const dpaLib = require('./metaDpa');
const opCfg = require('./creativeOpportunitiesConfig');
const { MEDIA_LABEL } = require('./metaNameParsing');

const num = (v) => Number(v) || 0;
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const money = (v) => `$${Math.round(num(v)).toLocaleString('en-AU')}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
const daysAdd = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

const STATUS_LABEL = { established: 'Established winner', promising: 'Promising test', mixed: 'Mixed performance', weak: 'Underperforming', insufficient: 'Insufficient evidence' };
const STATUS_RANK = { established: 0, promising: 1, mixed: 2, weak: 3, insufficient: 4 };
const RATED = new Set(['performing', 'underperforming', 'declining']);
// planning statuses a product may have and still be suggested for a new concept: the engine has passed its stock, demand and season checks and creative is not blocked by matching doubt
const SUGGESTABLE = new Set(['act', 'covered', 'testing', 'in_production']);

// ── loading (local database only; nothing here calls Meta) ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function loadAds({ db, today, cfg }) {
  const end = daysAdd(today, -1);
  const from = daysAdd(end, -(cfg.insights_window_days - 1));
  const recentFrom = daysAdd(end, -(cfg.trend_days - 1)); const priorTo = daysAdd(recentFrom, -1); const priorFrom = daysAdd(priorTo, -(cfg.trend_days - 1));
  const fatFrom = daysAdd(end, -(cfg.fatigue_days - 1)); const fatPriorTo = daysAdd(fatFrom, -1); const fatPriorFrom = daysAdd(fatPriorTo, -(cfg.fatigue_days - 1));
  const joinFrom = fatPriorFrom < from ? fatPriorFrom : from;
  // every matched, product-specific, non-DPA ad in the window, whatever its status today (a paused ad that ran last month is evidence a concept worked)
  const cond = `m.match_status IN ('confirmed', 'auto_matched') AND NOT COALESCE(cl.excluded_from_intelligence, false) AND NOT COALESCE(cl.not_product_specific, false)
        AND NOT COALESCE((${dpaLib.dpaPredicate('m', 'c')}), false)
        AND EXISTS (SELECT 1 FROM meta_ad_products p WHERE p.meta_ad_id = m.meta_ad_id AND p.product_code <> ALL($1::text[]))
        AND EXISTS (SELECT 1 FROM meta_ad_insights_daily x WHERE x.meta_ad_id = m.meta_ad_id AND x.insight_date BETWEEN $2::date AND $3::date AND (x.spend > 0 OR x.impressions > 0))`;
  const rows = (await db.query(perf.adRowsSql(cond), [[], from, end, recentFrom, priorFrom, priorTo, fatFrom, fatPriorFrom, fatPriorTo, joinFrom])).rows;
  const prod = await db.query('SELECT meta_ad_id, product_code, product_name FROM meta_ad_products WHERE meta_ad_id = ANY($1::text[])', [rows.map((r) => r.meta_ad_id)]);
  const concepts = await db.query('SELECT id, name FROM concept_types');
  let horizon = null; let newest = null;
  try { const h = (await db.query("SELECT to_char(MIN(insight_date), 'YYYY-MM-DD') AS d, to_char(MAX(insight_date), 'YYYY-MM-DD') AS n FROM meta_ad_insights_daily")).rows[0] || {}; horizon = h.d || null; newest = h.n || null; } catch (e) { /* freshness unknown */ }
  return { rows, products: prod.rows, conceptNames: new Map(concepts.rows.map((r) => [r.id, r.name])), window: { from, end }, horizon, newest };
}
// concepts already planned or in production (Shoot Plan concepts with a concept type, not killed), per product code: they are never suggested again for that product
async function loadInProduction({ db, weekStart, lookbackWeeks = 6 }) {
  const since = daysAdd(weekStart, -7 * lookbackWeeks);
  const rows = (await db.query(
    `SELECT spi.product_code, ca.concept_type FROM creative_assets ca JOIN shoot_plan_items spi ON spi.id = ca.shoot_plan_item_id
      WHERE ca.concept_type IS NOT NULL AND ca.concept_dev_status <> 'killed' AND spi.week_start >= $1::date AND spi.product_code IS NOT NULL`, [since])).rows;
  const out = new Map();
  rows.forEach((r) => { if (!out.has(r.product_code)) out.set(r.product_code, new Set()); out.get(r.product_code).add(norm(r.concept_type)); });
  return out;
}

// ── pure: ads -> unique creatives (identity, verdicts, concept, products) ────────────────────────────────────────────────────────────────────────────────────────────────────
function buildCreatives({ rows, products = [], conceptNames = new Map(), rules, coded, cfg, today, nameCopies = null, horizon = null, newest = null }) {
  const byAd = new Map(rows.map((r) => [r.meta_ad_id, r]));
  const prodOf = new Map(); const nameOf = new Map();
  products.forEach((p) => { if (!prodOf.has(p.meta_ad_id)) prodOf.set(p.meta_ad_id, []); prodOf.get(p.meta_ad_id).push(p.product_code); if (p.product_name && !nameOf.has(p.product_code)) nameOf.set(p.product_code, p.product_name); });
  const groups = new Map();
  rows.forEach((r) => {
    if (!(num(r.t_spend) > 0 || num(r.t_imp) > 0)) return; // no delivery in the window: not evidence
    const codes = prodOf.get(r.meta_ad_id) || [];
    if (!codes.length) return;
    const key = perf.creativeGroupKey(r, nameCopies);
    if (!groups.has(key)) groups.set(key, perf.newGroup(key));
    perf.addRowToGroup(groups.get(key), r, codes.length > 1);
  });
  if (nameCopies) perf.mergeNameCopies(groups, nameCopies);
  const out = [];
  groups.forEach((g) => {
    const verdict = perf.judgeAcrossFunnels(g, { rules, coded, cfg });
    const ads = g.ads.map((a) => byAd.get(a.id)).filter(Boolean);
    const codes = [...new Set(ads.flatMap((a) => prodOf.get(a.meta_ad_id) || []))];
    // concept: the spend-weighted majority of the classifications on this creative's ads; a disagreement is flagged, never silently resolved
    const tally = new Map();
    ads.forEach((a) => {
      if (!a.concept_label && !a.concept_type_id) return;
      const label = a.concept_type_id && conceptNames.get(a.concept_type_id) ? conceptNames.get(a.concept_type_id) : a.concept_label;
      const k = a.concept_type_id ? `ct:${a.concept_type_id}` : `legacy:${norm(label)}`;
      const t = tally.get(k) || { key: k, label, legacy: !a.concept_type_id, spend: 0 };
      t.spend += num(a.t_spend) + 0.01; tally.set(k, t);
    });
    const ranked = [...tally.values()].sort((a, b) => b.spend - a.spend);
    const concept = ranked[0] || null;
    const start = recency.startOf({ first_delivery: g.first_day, first_delivery_truncated: !!(g.first_day && horizon && g.first_day <= horizon), created: g.created });
    out.push({
      ...verdict, key: g.key, name: (g.ads[0] && g.ads[0].name) || null, ads: g.ads.length, ad_ids: g.ads.slice(0, 3).map((a) => a.id),
      ad_list: g.ads.slice(0, 12).map((a) => ({ id: a.id, name: a.name || null, status: a.status || null })), // display only: the original Meta ad names / ids / status shown in the detailed evidence
      media: g.media || null, format: g.media ? (MEDIA_LABEL[g.media] || g.media) : null, created: g.created, first_delivery: g.first_day || null, last_delivery: g.last_day || null,
      started: start.date, products: codes, product_names: codes.map((c) => nameOf.get(c) || c),
      concept_key: concept ? concept.key : null, concept_label: concept ? concept.label : null, concept_legacy: concept ? concept.legacy : false, concept_conflict: ranked.length > 1,
      live_status: recency.liveStatusOf({ last_delivery: g.last_day, created: g.created }, today, cfg, newest),
    });
  });
  return out;
}

// ── pure: unique creatives -> concepts ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function hasBenchmark(funnel, rules, coded) { return ['TOF', 'TOM', 'MOF'].includes(funnel) && health.classify(funnel, 'cpa', 0.01, {}, { rules, coded }) !== null; }
function approvedLimit(funnel, rules) { const g = rules && rules[funnel] && rules[funnel].cpa && rules[funnel].cpa.green; return g ? (g.lte !== undefined ? g.lte : g.lt !== undefined ? g.lt : null) : null; }

function funnelStatus(b, C, shareLimit) {
  const P = b.performing.size; const U = b.under.size; const rated = P + U;
  const perfProducts = [...b.products.values()].filter((p) => p.performing && p.spend >= C.min_product_spend);
  const perfPurchases = perfProducts.reduce((s, p) => s + p.perf_purchases, 0);
  const topShare = perfPurchases > 0 ? Math.max(...perfProducts.map((p) => p.perf_purchases)) / perfPurchases : 0;
  const req = {
    creatives: { need: C.min_creatives, have: P, ok: P >= C.min_creatives }, products: { need: C.test_min_products, have: perfProducts.length, ok: perfProducts.length >= C.test_min_products },
    spend: { need: C.min_spend, have: Math.round(b.spend), ok: b.spend >= C.min_spend }, purchases: { need: C.min_purchases, have: Math.round(b.purchases), ok: b.purchases >= C.min_purchases },
    consistent: { have: `${P} performing vs ${U} underperforming`, ok: P > U }, dominance: { limit_pct: shareLimit, top_pct: Math.round(topShare * 100), ok: topShare * 100 < shareLimit },
  };
  let status = 'insufficient';
  if (P >= 1 && P > U && Object.values(req).every((x) => x.ok)) status = 'established';
  else if (P >= 1 && P > U) status = 'promising';
  else if (P >= 1 && U >= P && rated >= 2) status = 'mixed';
  else if (P === 0 && U >= 2) status = 'weak';
  return { status, requirements: req, performing_products: perfProducts.length, top_product_share_pct: Math.round(topShare * 100) };
}

function analyseConcepts({ creatives, rules, coded, cfg, today, categoryOf = () => null }) {
  const C = opCfg.CONCEPT; const shareLimit = cfg.concentration_share_pct;
  const total = { spend: 0, classified: 0, legacy: 0, creatives: 0, classified_creatives: 0 };
  const concepts = new Map();
  creatives.forEach((c) => {
    total.spend += num(c.spend); total.creatives += 1;
    if (c.concept_key) { total.classified += num(c.spend); total.classified_creatives += 1; if (c.concept_legacy) total.legacy += num(c.spend); }
    if (!c.concept_key) return;
    if (!concepts.has(c.concept_key)) concepts.set(c.concept_key, { key: c.concept_key, label: c.concept_label, legacy: c.concept_legacy, creatives: [], funnels: new Map(), products: new Map(), conflicts: 0 });
    const k = concepts.get(c.concept_key); k.creatives.push(c); if (c.concept_conflict) k.conflicts += 1;
    const n = Math.max(1, c.products.length);
    c.products.forEach((code) => {
      const p = k.products.get(code) || { code, name: null, creatives: 0, spend: 0, purchases: 0, performing: 0, perf_purchases: 0 };
      p.creatives += 1; p.spend += num(c.spend) / n; p.purchases += num(c.purchases) / n; k.products.set(code, p);
    });
    (c.funnel_results || [{ funnel: c.funnel || 'unknown', state: c.state, spend: c.spend, purchases: c.purchases, impressions: c.impressions, value: 0, cpa: c.cpa }]).forEach((fr) => {
      if (!k.funnels.has(fr.funnel)) k.funnels.set(fr.funnel, { funnel: fr.funnel, creatives: new Set(), performing: new Set(), under: new Set(), insufficient: new Set(), unrated: new Set(), spend: 0, purchases: 0, impressions: 0, value: 0, products: new Map() });
      const b = k.funnels.get(fr.funnel);
      b.creatives.add(c.key); b.spend += num(fr.spend); b.purchases += num(fr.purchases); b.impressions += num(fr.impressions); b.value += num(fr.value);
      if (fr.state === 'performing') b.performing.add(c.key); else if (fr.state === 'underperforming' || fr.state === 'declining') b.under.add(c.key);
      else if (fr.state === 'unrated') b.unrated.add(c.key); else b.insufficient.add(c.key);
      c.products.forEach((code) => {
        const p = b.products.get(code) || { performing: false, spend: 0, perf_purchases: 0 };
        p.spend += num(fr.spend) / n;
        if (fr.state === 'performing') { p.performing = true; p.perf_purchases += num(fr.purchases) / n; }
        b.products.set(code, p);
      });
    });
  });
  const out = [];
  concepts.forEach((k) => {
    const live = k.creatives.filter((c) => c.live_status === 'delivering').length;
    const perFunnel = []; const verdicts = [];
    ['MOF', 'TOM', 'TOF', ...[...k.funnels.keys()].filter((f) => !['MOF', 'TOM', 'TOF'].includes(f))].forEach((f) => {
      const b = k.funnels.get(f); if (!b) return;
      const bench = hasBenchmark(f, rules, coded);
      const fs = bench ? funnelStatus(b, C, shareLimit) : null;
      if (fs && b.performing.size + b.under.size > 0) verdicts.push(fs.status);
      perFunnel.push({
        funnel: f, benchmarked: bench, approved_cpa_limit: bench ? approvedLimit(f, rules) : null, creatives: b.creatives.size, performing: b.performing.size, underperforming: b.under.size, insufficient: b.insufficient.size, unrated: b.unrated.size,
        spend: Math.round(b.spend), purchases: Math.round(b.purchases), cpa: b.purchases > 0 ? r1(b.spend / b.purchases) : null, roas: b.spend > 0 && b.value > 0 ? Math.round((b.value / b.spend) * 100) / 100 : null,
        status: fs ? fs.status : null, requirements: fs ? fs.requirements : null, top_product_share_pct: fs ? fs.top_product_share_pct : null,
      });
    });
    let status = 'insufficient';
    if (verdicts.length === 1) status = verdicts[0];
    else if (verdicts.length > 1) status = verdicts.every((v) => v === verdicts[0]) ? verdicts[0] : 'mixed';
    const prods = [...k.products.values()].sort((a, b) => b.spend - a.spend);
    const spend = k.creatives.reduce((s, c) => s + num(c.spend), 0);
    const topProd = prods[0]; const topShare = spend > 0 && topProd ? topProd.spend / spend : 0;
    const perfCats = new Set(); const allCats = new Set();
    prods.forEach((p) => { const cat = categoryOf(p.code); if (cat) allCats.add(cat); });
    k.creatives.forEach((c) => { if ((c.funnel_results || []).some((fr) => fr.state === 'performing' && hasBenchmark(fr.funnel, rules, coded))) c.products.forEach((code) => { const cat = categoryOf(code); if (cat) perfCats.add(cat); }); });
    const benchFunnels = perFunnel.filter((f) => f.benchmarked && f.performing + f.underperforming > 0);
    const noBench = perFunnel.filter((f) => !f.benchmarked && f.creatives > 0);
    const evidence = [];
    if (benchFunnels.length) benchFunnels.forEach((f) => evidence.push(`${f.funnel}: ${f.performing} performing and ${f.underperforming} over the approved CPA limit${f.approved_cpa_limit ? ` (${money(f.approved_cpa_limit)})` : ''}, ${money(f.spend)} spent, ${plural(f.purchases, 'purchase')}${f.cpa ? `, CPA ${money(f.cpa)}` : ''}.`));
    if (noBench.length) evidence.push(`${noBench.map((f) => f.funnel).join(' / ')}: ${plural(noBench.reduce((s, f) => s + f.creatives, 0), 'creative')} with delivery but no approved benchmark, so no verdict is given (${money(noBench.reduce((s, f) => s + f.spend, 0))} spent).`);
    if (k.conflicts) evidence.push(`${plural(k.conflicts, 'creative')} ${k.conflicts === 1 ? 'has' : 'have'} ads classified under different concepts; the spend-weighted majority is used.`);
    if (k.legacy) evidence.push('This is a free-text (legacy) concept label, not a concept type from the vocabulary.');
    if (topShare >= shareLimit / 100 && prods.length > 1) evidence.push(`${Math.round(topShare * 100)}% of the spend is on one product (${topProd.name || topProd.code}): the result may not carry to other products.`);
    out.push({
      key: k.key, label: k.label, legacy: k.legacy, status, status_label: STATUS_LABEL[status],
      products_tested: prods.length, unique_creatives: k.creatives.length, live_creatives: live, spend: Math.round(spend), purchases: Math.round(k.creatives.reduce((s, c) => s + num(c.purchases), 0)),
      share_of_creatives_pct: total.creatives ? Math.round((k.creatives.length / total.creatives) * 1000) / 10 : null,
      funnels: perFunnel, evidence, concept_conflicts: k.conflicts, top_product_share_pct: Math.round(topShare * 100),
      categories: { all: [...allCats].sort(), performing: [...perfCats].sort() },
      products: prods.map((p) => ({ code: p.code, name: null, creatives: p.creatives, spend: Math.round(p.spend), purchases: Math.round(p.purchases * 10) / 10 })),
      creatives: k.creatives.slice().sort((a, b) => num(b.spend) - num(a.spend)).map((c) => ({
        key: c.key, name: c.name, format: c.format, funnel: c.funnel_results && c.funnel_results.length > 1 ? c.funnel_results.map((f) => f.funnel).join(' / ') : (c.funnel_results && c.funnel_results[0] ? c.funnel_results[0].funnel : null),
        funnel_results: (c.funnel_results || []).map((f) => ({ funnel: f.funnel, state: f.state, spend: Math.round(num(f.spend)), purchases: f.purchases, cpa: f.cpa === null || f.cpa === undefined ? null : r1(f.cpa) })),
        state: c.state, spend: Math.round(num(c.spend)), purchases: c.purchases, ads: c.ads, live_status: c.live_status, last_delivery: c.last_delivery, started: c.started, products: c.product_names,
        ad_ids: c.ad_ids || [], ad_list: c.ad_list || [],
      })),
    });
  });
  out.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.products_tested - a.products_tested || b.spend - a.spend || String(a.key).localeCompare(String(b.key)));
  return {
    concepts: out,
    coverage: {
      creatives: total.creatives, classified_creatives: total.classified_creatives, unclassified_creatives: total.creatives - total.classified_creatives,
      spend: Math.round(total.spend), classified_spend_pct: total.spend > 0 ? Math.round((total.classified / total.spend) * 1000) / 10 : null, legacy_spend_pct: total.spend > 0 ? Math.round((total.legacy / total.spend) * 1000) / 10 : null,
    },
  };
}

// ── pure: concepts + Planning items -> suggested products ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// items: Planning engine results (core + high stocks + momentum, one per product family). inProduction: Map(product_code -> Set(normalised concept name)).
function eligibility(item) {
  const f = item.facts || {};
  if (!SUGGESTABLE.has(item.status)) return { ok: false, why: `Planning status is ${item.status_label || item.status}` };
  if (item.stock_issue) return { ok: false, why: 'stock restricted' };
  if (!f.demand_qualified_by) return { ok: false, why: 'demand does not qualify' };
  return { ok: true };
}
function testedBy(item, concept, inProduction) {
  const labels = new Set([norm(concept.label)]);
  const codes = item.codes || [];
  if (concept.products.some((p) => codes.includes(p.code))) return 'meta';
  if ((item.creatives || []).some((c) => c.concept && labels.has(norm(c.concept)))) return 'meta';
  if (codes.some((c) => inProduction.has(c) && inProduction.get(c).has(norm(concept.label)))) return 'production';
  if (inProduction.has(item.key) && inProduction.get(item.key).has(norm(concept.label))) return 'production';
  return null;
}
function recommend({ concepts, items, inProduction = new Map(), cfg, rules }) {
  const maxN = cfg.insights_max_products;
  const suggestions = new Map();
  concepts.forEach((c) => {
    if (!['established', 'promising'].includes(c.status)) { suggestions.set(c.key, []); return; }
    const cands = [];
    const bench = c.funnels.filter((f) => f.benchmarked && f.performing > 0).sort((a, b) => b.performing - a.performing)[0] || null;
    items.forEach((item) => {
      const el = eligibility(item); if (!el.ok) return;
      if (testedBy(item, c, inProduction)) return;
      const cat = item.category || null;
      const sameCat = !!(cat && c.categories.performing.includes(cat));
      const crossCat = c.status === 'established' && c.categories.performing.length >= opCfg.CONCEPT.min_products_cross_product;
      if (!sameCat && !crossCat) return; // a promising concept is only suggested where it has worked for a similar (same-category) product
      const f = item.facts || {};
      const unclassified = (item.creatives || []).filter((x) => !x.concept).length;
      const fit = sameCat ? `it has worked on other ${cat.toLowerCase()} products` : `it has worked across ${plural(c.categories.performing.length, 'product category', 'product categories')}`;
      const evidence = c.status === 'established'
        ? `${c.label} has performed well across ${plural(c.products_tested, 'product')} (${plural(c.unique_creatives, 'unique creative')}${bench && bench.cpa ? `, ${bench.funnel} CPA ${money(bench.cpa)}${bench.approved_cpa_limit ? ` against the approved ${money(bench.approved_cpa_limit)} limit` : ''}` : ''}).`
        : `${c.label} is a promising test: ${plural(bench ? bench.performing : 0, 'creative')} performing${bench && bench.cpa ? ` (${bench.funnel} CPA ${money(bench.cpa)})` : ''} on ${plural(c.products_tested, 'product')}, a limited sample.`;
      const own = `${item.name} has ${Math.round(num(f.stock_units)).toLocaleString('en-AU')} units available${f.units30 !== null && f.units30 !== undefined ? `, ${Math.round(num(f.units30))} sold in 30 days` : ''} and no ${c.label} creative identified (${fit}).`;
      cands.push({
        concept_key: c.key, concept_label: c.label, item_key: item.key, product_name: item.name, product_codes: item.codes || [], category: cat, image_url: item.image_url || null,
        planning_status: item.status, planning_label: item.status_label, priority: item.priority || null, score: item.score || 0, units30: num(f.units30), stock_units: num(f.stock_units),
        suitability: sameCat ? 'same_category' : 'cross_category', reason: `${evidence} ${own}`,
        caveat: unclassified ? `${unclassified} of its ${unclassified === 1 ? 'creatives has' : 'creatives have'} no concept recorded, so a similar creative may already exist.` : null,
      });
    });
    cands.sort((a, b) => (a.planning_status === 'act' ? 0 : 1) - (b.planning_status === 'act' ? 0 : 1) || b.score - a.score || b.units30 - a.units30 || a.product_name.localeCompare(b.product_name));
    suggestions.set(c.key, cands.slice(0, maxN).concat([]));
    suggestions.get(c.key).total_eligible = cands.length;
  });
  return suggestions;
}

// ── orchestration ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// pure: loaded data + Planning items -> the page payload (nothing is read or written here)
function assemble({ data, items = [], inProduction = new Map(), today, cfg, benchmarks, nameCopies = null, categoryIndex = null }) {
  const rules = benchmarks.rules; const coded = benchmarks.coded;
  const creatives = buildCreatives({ rows: data.rows, products: data.products, conceptNames: data.conceptNames, rules, coded, cfg, today, nameCopies, horizon: data.horizon, newest: data.newest });
  const catByCode = new Map(categoryIndex || []);
  items.forEach((i) => (i.codes || []).forEach((c) => { if (i.category) catByCode.set(c, i.category); }));
  const nameByCode = new Map();
  data.products.forEach((p) => { if (p.product_name && !nameByCode.has(p.product_code)) nameByCode.set(p.product_code, p.product_name); });
  items.forEach((i) => (i.codes || []).forEach((c) => nameByCode.set(c, i.name)));
  const analysed = analyseConcepts({ creatives, rules, coded, cfg, today, categoryOf: (code) => catByCode.get(code) || null });
  analysed.concepts.forEach((c) => c.products.forEach((p) => { p.name = nameByCode.get(p.code) || p.code; }));
  const sugg = recommend({ concepts: analysed.concepts, items, inProduction, cfg, rules });
  const concepts = analysed.concepts.map((c) => ({ ...c, suggestions: sugg.get(c.key) || [], suggestions_total: (sugg.get(c.key) || {}).total_eligible || (sugg.get(c.key) || []).length }));
  const C = opCfg.CONCEPT;
  return {
    available: true, generated_at: new Date().toISOString(), today, window: { ...data.window, days: cfg.insights_window_days }, delivery_through: data.newest,
    concepts, coverage: analysed.coverage,
    funnels: ['TOF', 'TOM', 'MOF'].map((f) => ({ funnel: f, benchmarked: hasBenchmark(f, rules, coded), approved_cpa_limit: hasBenchmark(f, rules, coded) ? approvedLimit(f, rules) : null })),
    requirements: { min_creatives: C.min_creatives, min_products: C.test_min_products, min_product_spend: C.min_product_spend, min_spend: C.min_spend, min_purchases: C.min_purchases, dominance_pct: cfg.concentration_share_pct, cross_category_min: C.min_products_cross_product },
    counts: { concepts: concepts.length, established: concepts.filter((c) => c.status === 'established').length, promising: concepts.filter((c) => c.status === 'promising').length, creatives: creatives.length },
  };
}
// items: the Planning payload's product results; nothing is written; no Meta call is made.
async function compute({ db, items = [], today, weekStart, cfg, benchmarks, nameCopies = null, categoryIndex = null }) {
  const data = await loadAds({ db, today, cfg });
  const inProduction = await loadInProduction({ db, weekStart, lookbackWeeks: cfg.pipeline_lookback_weeks });
  return assemble({ data, items, inProduction, today, cfg, benchmarks, nameCopies, categoryIndex });
}

module.exports = { STATUS_LABEL, assemble, loadAds, loadInProduction, buildCreatives, analyseConcepts, eligibility, testedBy, recommend, compute, hasBenchmark, funnelStatus };
