'use strict';
// Batch 30: Creative Insights (cross-product concept intelligence). Fixture data only: no database, no network. The real grouping / judging code (productAdPerformance) is used, so
// "unique creative" and "judged within each funnel" are the same definitions Planning uses.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const insights = require('../src/lib/creativeInsights');
const nameCopies = require('../src/lib/metaNameCopies');
const health = require('../src/lib/metaFunnelHealth');
const cfgLib = require('../src/lib/creativePlanningConfig');
const { TODAY, day } = require('./_planningFixtures');

const CFG = cfgLib.resolve({}).config;
const RULES = health.effectiveRules(); const CODED = health.COLOUR_CODED;
let seq = 0;
// one Meta ad row; `products` is a list of product codes (attached separately, as the loader does)
const ad = (o = {}) => {
  seq += 1; const spend = o.spend === undefined ? 400 : o.spend; const pur = o.purchases === undefined ? 10 : o.purchases;
  return {
    row: {
      meta_ad_id: o.id || `ad${seq}`, ad_name: o.name || `Ad ${seq}`, meta_creative_id: o.creative === undefined ? `cr${seq}` : o.creative, effective_status: o.status || 'ACTIVE', created_time: `${day(o.age || 60)}T00:00:00Z`, funnel: o.funnel === undefined ? 'MOF' : o.funnel,
      concept_type_id: o.conceptId === undefined ? 1 : o.conceptId, concept_label: o.concept === undefined ? 'Styling Video' : o.concept, creator_name: null, creative_style_id: null, media_type: o.media || 'video',
      first_day: day(o.age || 60), last_day: o.last === undefined ? day(1) : o.last, life_spend: spend, delivery_rows: 14,
      t_spend: spend, t_imp: 40000, t_clk: 800, t_pur: pur, t_val: pur * 120, f_spend: 0, f_imp: 0, f_clk: 0, f_pur: 0, f_val: 0, g_spend: 0, g_imp: 0, g_clk: 0, g_pur: 0, g_val: 0, r_spend: 0, r_imp: 0, r_clk: 0, r_pur: 0, r_val: 0, p_spend: 0, p_imp: 0, p_clk: 0, p_pur: 0, p_val: 0,
    },
    products: (o.products || ['P1']).map((c) => ({ meta_ad_id: o.id || `ad${seq}`, product_code: c, product_name: `Product ${c}` })),
  };
};
const build = (ads, extra = {}) => insights.buildCreatives({ rows: ads.map((a) => a.row), products: ads.flatMap((a) => a.products), conceptNames: new Map([[1, 'Styling Video'], [2, 'Flat Lay']]), rules: RULES, coded: CODED, cfg: CFG, today: TODAY, nameCopies, horizon: day(200), newest: day(1), ...extra });
const analyse = (creatives, categoryOf = () => 'SHORTS') => insights.analyseConcepts({ creatives, rules: RULES, coded: CODED, cfg: CFG, today: TODAY, categoryOf });
const concept = (res, label = 'Styling Video') => res.concepts.find((c) => c.label === label);

test('insights: a winning concept across several products is an ESTABLISHED WINNER, judged against the approved MOF CPA', () => {
  const ads = [ad({ products: ['P1'] }), ad({ products: ['P1'] }), ad({ products: ['P2'] }), ad({ products: ['P3'] })]; // 4 creatives, CPA $40, 3 products
  const c = concept(analyse(build(ads)));
  assert.equal(c.status, 'established'); assert.equal(c.products_tested, 3); assert.equal(c.unique_creatives, 4);
  assert.equal(c.funnels.find((f) => f.funnel === 'MOF').performing, 4);
  assert.ok(c.funnels.find((f) => f.funnel === 'MOF').requirements.creatives.ok);
});
test('insights: one exceptional product cannot make a winner (dominance), and a single strong ad is only a PROMISING TEST', () => {
  // three performing creatives, but 95% of the performing purchases sit on one product
  const dom = [ad({ products: ['P1'], purchases: 40, spend: 1200 }), ad({ products: ['P1'], purchases: 20, spend: 800 }), ad({ products: ['P2'], purchases: 2, spend: 100 })];
  const c = concept(analyse(build(dom)));
  assert.equal(c.status, 'promising', 'not established: one product carries almost all the evidence'); assert.ok(c.funnels[0].requirements.dominance.ok === false);
  assert.match(c.evidence.join(' '), /of the spend is on one product|may not carry/);
  const one = concept(analyse(build([ad({ products: ['P1'], spend: 300, purchases: 8 })])));
  assert.equal(one.status, 'promising'); assert.equal(one.unique_creatives, 1);
});
test('insights: mixed performance, underperforming, and insufficient evidence are told apart', () => {
  const mixed = concept(analyse(build([ad({ products: ['P1'] }), ad({ products: ['P2'] }), ad({ products: ['P1'], purchases: 2 }), ad({ products: ['P2'], purchases: 2 })])));
  assert.equal(mixed.status, 'mixed'); // 2 performing (CPA 40) and 2 over the approved limit (CPA 200)
  const weak = concept(analyse(build([ad({ products: ['P1'], purchases: 2 }), ad({ products: ['P2'], purchases: 2 })])));
  assert.equal(weak.status, 'weak'); assert.equal(weak.status_label, 'Underperforming');
  const thin = concept(analyse(build([ad({ spend: 20, purchases: 0 })])));
  assert.equal(thin.status, 'insufficient');
});
test('insights: TOF / TOM have no approved benchmark, so they get numbers but never a verdict, and are never blended into the MOF result', () => {
  const tofOnly = concept(analyse(build([ad({ funnel: 'TOF', products: ['P1'] }), ad({ funnel: 'TOF', products: ['P2'] }), ad({ funnel: 'TOM', products: ['P3'] })])));
  assert.equal(tofOnly.status, 'insufficient');
  assert.ok(tofOnly.funnels.every((f) => f.benchmarked === false && f.status === null));
  assert.match(tofOnly.evidence.join(' '), /no approved benchmark, so no verdict is given/);
  const both = concept(analyse(build([ad({ products: ['P1'] }), ad({ products: ['P2'] }), ad({ products: ['P3'] }), ad({ funnel: 'TOF', spend: 5000, purchases: 5, products: ['P1'] })])));
  const mof = both.funnels.find((f) => f.funnel === 'MOF'); const tof = both.funnels.find((f) => f.funnel === 'TOF');
  assert.equal(mof.cpa, 40, 'the MOF CPA is computed from MOF creatives only'); assert.equal(tof.cpa, 1000);
  assert.equal(both.status, 'established', 'three performing MOF creatives on three products meet the requirements; the huge TOF spend neither helps nor hurts the MOF verdict');
});
test('insights: duplicated Meta ads are ONE creative, never independent evidence; a creative in two funnels is one creative judged in each', () => {
  const dupes = [1, 2, 3, 4, 5].map((i) => ad({ creative: 'same', spend: 100, purchases: 2, products: ['P1'], id: `dup${i}` }));
  const c = concept(analyse(build(dupes)));
  assert.equal(c.unique_creatives, 1, 'five Meta ads, one creative'); assert.equal(c.creatives[0].ads, 5);
  assert.notEqual(c.status, 'established');
  const cross = [ad({ creative: 'x', funnel: 'MOF', spend: 400, purchases: 10, id: 'x1' }), ad({ creative: 'x', funnel: 'TOF', spend: 900, purchases: 3, id: 'x2' })];
  const k = concept(analyse(build(cross)));
  assert.equal(k.unique_creatives, 1); assert.deepEqual(k.creatives[0].funnel_results.map((f) => [f.funnel, f.state]).sort(), [['MOF', 'performing'], ['TOF', 'unrated']]);
  assert.equal(k.funnels.find((f) => f.funnel === 'MOF').performing, 1);
});
test('insights: the same concept with different executions stays separate creatives; ads with no concept are classification coverage, not a concept', () => {
  const ads = [ad({ products: ['P1'] }), ad({ products: ['P1'] }), ad({ products: ['P1'] }), ad({ conceptId: null, concept: null, products: ['P1'], spend: 600 })];
  const res = analyse(build(ads));
  assert.equal(concept(res).unique_creatives, 3);
  assert.equal(res.concepts.length, 1, 'the unclassified creative is not grouped into a concept');
  assert.equal(res.coverage.unclassified_creatives, 1); assert.equal(res.coverage.classified_spend_pct, 66.7);
  const legacy = concept(analyse(build([ad({ conceptId: null, concept: 'Old Hook Idea' })])), 'Old Hook Idea');
  assert.equal(legacy.legacy, true); assert.match(legacy.evidence.join(' '), /legacy/);
});
test('insights: ads of one creative classified under different concepts are flagged, using the spend-weighted majority', () => {
  const ads = [ad({ creative: 'm', conceptId: 1, concept: 'Styling Video', spend: 500, id: 'm1' }), ad({ creative: 'm', conceptId: 2, concept: 'Flat Lay', spend: 50, id: 'm2' })];
  const res = analyse(build(ads));
  assert.equal(res.concepts.length, 1); assert.equal(res.concepts[0].label, 'Styling Video'); assert.equal(res.concepts[0].concept_conflicts, 1);
});

// ── recommendations ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const item = (o = {}) => ({ key: o.key || 'K1', name: o.name || 'Rothman Sport Short', category: o.category === undefined ? 'SHORTS' : o.category, codes: o.codes || ['R1'], status: o.status || 'act', status_label: o.status_label || 'Needs creative', stock_issue: o.stock_issue || null,
  priority: 'High', score: o.score || 70, image_url: null, creatives: o.creatives || [], facts: { demand_qualified_by: o.qualified === undefined ? 'steady_sales' : o.qualified, stock_units: 431, units30: 71, ...(o.facts || {}) } });
const winnerRes = () => analyse(build([ad({ products: ['P1'] }), ad({ products: ['P1'] }), ad({ products: ['P2'] }), ad({ products: ['P3'] })]), () => 'SHORTS');
const suggest = (items, inProduction = new Map(), res = winnerRes()) => insights.recommend({ concepts: res.concepts, items, inProduction, cfg: CFG, rules: RULES }).get('ct:1');

test('recommend: a suggested product has real stock, demand and no tested concept, with the reasoning stated from the data', () => {
  const s = suggest([item()]);
  assert.equal(s.length, 1); assert.equal(s[0].item_key, 'K1'); assert.equal(s[0].suitability, 'same_category');
  assert.match(s[0].reason, /Styling Video has performed well across 3 products \(4 unique creatives, MOF CPA \$40 against the approved \$60 limit\)\. Rothman Sport Short has 431 units available, 71 sold in 30 days and no Styling Video creative identified/);
});
test('recommend: stock-restricted, weak-demand, not-qualified and review products are never suggested', () => {
  const s = suggest([item({ key: 'a', stock_issue: 'below_minimum', status: 'low_stock' }), item({ key: 'b', status: 'weak_demand' }), item({ key: 'c', qualified: null }), item({ key: 'd', status: 'insufficient_data' }), item({ key: 'e', status: 'out_of_season' }), item({ key: 'ok', name: 'Fine Short' })]);
  assert.deepEqual(s.map((x) => x.item_key), ['ok']);
});
test('recommend: a concept the product already tested (Meta) or already has in production is not suggested again', () => {
  const testedByMeta = suggest([item({ key: 'm', codes: ['P2'] })]); assert.equal(testedByMeta.length, 0, 'P2 already ran the concept');
  const viaCreatives = suggest([item({ key: 'v', creatives: [{ concept: 'styling video' }] })]); assert.equal(viaCreatives.length, 0);
  const prod = suggest([item({ key: 'p', codes: ['R1'] })], new Map([['R1', new Set(['styling video'])]])); assert.equal(prod.length, 0, 'in production for that concept already');
  const other = suggest([item({ key: 'o', codes: ['R1'] })], new Map([['R1', new Set(['flat lay'])]])); assert.equal(other.length, 1, 'a different concept in production does not block this one');
});
test('recommend: only established / promising concepts produce suggestions; a promising one only for a same-category product; needs-creative products rank first', () => {
  const promising = analyse(build([ad({ products: ['P1'], spend: 300, purchases: 8 })]), () => 'TEES');
  const pc = insights.recommend({ concepts: promising.concepts, items: [item({ key: 'tee', category: 'TEES' }), item({ key: 'short', category: 'SHORTS' })], cfg: CFG, rules: RULES }).get('ct:1');
  assert.deepEqual(pc.map((x) => x.item_key), ['tee'], 'a promising concept is only suggested where it worked for a similar product');
  const weak = analyse(build([ad({ purchases: 2 }), ad({ purchases: 2 })]));
  assert.equal(insights.recommend({ concepts: weak.concepts, items: [item()], cfg: CFG, rules: RULES }).get('ct:1').length, 0);
  const ranked = suggest([item({ key: 'cov', status: 'covered', score: 90, name: 'Covered One' }), item({ key: 'act', status: 'act', score: 50, name: 'Act One' })]);
  assert.deepEqual(ranked.map((x) => x.item_key), ['act', 'cov']);
});
test('recommend: the caveat is shown when a product has unclassified creative; the list is capped by the setting', () => {
  const s = suggest([item({ creatives: [{ concept: null }, { concept: null }] })]);
  assert.match(s[0].caveat, /2 of its creatives have no concept recorded, so a similar creative may already exist/);
  const many = Array.from({ length: 12 }, (_, i) => item({ key: `k${i}`, name: `Short ${String(i).padStart(2, '0')}`, codes: [`C${i}`] }));
  const capped = suggest(many); assert.equal(capped.length, CFG.insights_max_products); assert.equal(capped.total_eligible, 12);
});
test('insights: requirements are the existing Creative Opportunities evidence rules, documented in the payload', () => {
  const opCfg = require('../src/lib/creativeOpportunitiesConfig');
  const s = insights.funnelStatus({ performing: new Set(['a']), under: new Set(), products: new Map([['P1', { performing: true, spend: 500, perf_purchases: 10 }]]), spend: 500, purchases: 10 }, opCfg.CONCEPT, 80);
  assert.equal(s.requirements.creatives.need, opCfg.CONCEPT.min_creatives); assert.equal(s.requirements.products.need, opCfg.CONCEPT.test_min_products);
  assert.equal(s.requirements.spend.need, opCfg.CONCEPT.min_spend); assert.equal(s.requirements.purchases.need, opCfg.CONCEPT.min_purchases);
});

test('insights: the original Meta ad names, ids and status ride along on each creative for the detailed evidence (display data only)', () => {
  const ads = [ad({ id: 'ad-a', name: '#101_26-WK39_20-09_OFFEND_UGC_MOF_Founder Story - Hook 1', products: ['P1'] }), ad({ id: 'ad-a2', name: '#101_26-WK39_20-09_OFFEND_UGC_MOF_Founder Story - Hook 1 - Copy', creative: 'cr-a', products: ['P1'] })];
  const c = concept(analyse(build(ads)));
  const cr = c.creatives[0];
  assert.ok(Array.isArray(cr.ad_list) && cr.ad_list.length >= 1);
  assert.ok(cr.ad_list.every((a) => a.id && 'name' in a && 'status' in a)); assert.ok(cr.ad_ids.length >= 1);
  assert.equal(c.status, concept(analyse(build(ads.map((a) => ({ row: { ...a.row }, products: a.products }))))).status, 'the rating does not depend on the added fields');
});
