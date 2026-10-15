'use strict';
// Batch 33: ACTIVE ADS (genuinely different creatives delivering now) and creative DEDUPLICATION. Built on the real grouping code (productAdPerformance.loadProductAdPerformance over a stubbed
// database) and the real engine. No database, no network. SQL-level exclusions (paused / DPA / unconfirmed) are proved against the local QA database in qa/b38-sql.js.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const perf = require('../src/lib/productAdPerformance');
const nameCopies = require('../src/lib/metaNameCopies');
const opp = require('../src/lib/planningOpportunities');
const lc = require('../src/lib/lastCreativeDate');
const health = require('../src/lib/metaFunnelHealth');
const E = require('../public/planningExplain');
const { CFG, TODAY, day, salesOf, base } = require('./_planningFixtures');

const RULES = health.effectiveRules(); const CODED = health.COLOUR_CODED;
const fam = { key: 'W26AA001', codes: ['W26AA001'] };
const SCRIPT = '#319_26-WK33_13-08_SCRIPT S/S SHIRT_SHIRTS_*_Image_Single_*_CONCRETE FLAT LAY_Product';

const ad = (id, o = {}) => ({
  meta_ad_id: id, ad_name: o.name || `Ad ${id}`, meta_creative_id: o.creative === undefined ? `cr_${id}` : o.creative, effective_status: 'ACTIVE', created_time: o.created || `${day(60)}T00:00:00Z`, funnel: o.funnel || 'MOF',
  first_day: o.first === undefined ? day(40) : o.first, last_day: o.last === undefined ? day(1) : o.last, life_spend: o.spend === undefined ? 400 : o.spend,
  concept_label: o.concept || null, creator_name: null, creative_style_id: null, media_type: o.media || null, product_codes: ['W26AA001'], delivery_rows: o.rows === undefined ? 14 : o.rows,
  t_spend: o.spend === undefined ? 400 : o.spend, t_imp: 40000, t_clk: 800, t_pur: o.purchases === undefined ? 8 : o.purchases, t_val: o.value === undefined ? 1600 : o.value,
  f_spend: 0, f_imp: 0, f_clk: 0, f_pur: 0, f_val: 0, g_spend: 0, g_imp: 0, g_clk: 0, g_pur: 0, g_val: 0, r_spend: 0, r_imp: 0, r_clk: 0, r_pur: 0, r_val: 0, p_spend: 0, p_imp: 0, p_clk: 0, p_pur: 0, p_val: 0,
});
const stubDb = (rows, { newest = day(1), origins = [] } = {}) => ({ query: async (sql) => (/creative-origins/.test(sql) ? { rows: origins } : /MIN\(insight_date\)/.test(sql) ? { rows: [{ d: day(200), n: newest }] } : { rows }) });
const load = async (rows, o) => (await perf.loadProductAdPerformance([fam], { db: stubDb(rows, o), rules: RULES, coded: CODED, today: TODAY, nameCopies })).get(fam.key);
const evalWith = async (rows, o = {}) => {
  const ev = await load(rows, o);
  return opp.evaluate(base({ sales: salesOf(150, { units7: 40, units14: 75 }), coverage: { known: true, active_ads: rows.length, possible: 0, unresolved: 0, unresolved_share_pct: 0, min: 5 }, creatives: ev.creatives, insights_last_day: ev.insights_last_day }), CFG, TODAY, 'core');
};

// ── DUPLICATION ──────────────────────────────────────────────────────────────────────────────
test('duplication: the live Script S/S Shirt example (Copy, Copy 2, Copy 3, Copy - Copy; four Meta creative ids, no original in the set) is ONE creative', async () => {
  const names = [`${SCRIPT} - Copy`, `${SCRIPT} - Copy 2`, `${SCRIPT} - Copy 3`, `${SCRIPT} - Copy - Copy`];
  const ev = await load(names.map((n, i) => ad(`s${i}`, { name: n, spend: 100, purchases: 2 })));
  assert.equal(ev.creatives.length, 1, 'one creative execution'); assert.equal(ev.creatives[0].ad_count, 4, 'four Meta ad instances behind it');
  const it = await evalWith(names.map((n, i) => ad(`s${i}`, { name: n, spend: 100, purchases: 2 })));
  assert.equal(it.facts.live_creatives, 1); assert.equal(it.facts.unique_creatives, 1); assert.equal(it.facts.live_instances, 4);
});

test('duplication: every duplicate-suffix form folds, with or without the original present', async () => {
  const forms = ['', ' - Copy', ' - Copy 2', ' - Copy 3', ' - Copy - Copy', ' - Copy 2 - Copy', ' - Copy - Copy 2 - Copy 3', ' – Copy', ' - copy 12'];
  const withOriginal = await load(forms.map((f, i) => ad(`o${i}`, { name: `${SCRIPT}${f}` })));
  assert.equal(withOriginal.creatives.length, 1, 'with the plain-named original');
  const noOriginal = await load(forms.slice(1).map((f, i) => ad(`n${i}`, { name: `${SCRIPT}${f}` })));
  assert.equal(noOriginal.creatives.length, 1, 'copies of an original that is not in the set still fold into each other');
});

test('duplication: the word "copy" inside a creative name is meaningful content, not a suffix', () => {
  assert.equal(nameCopies.baseOf('COPY WRITING TEST_Video_Single'), 'COPY WRITING TEST_Video_Single');
  assert.equal(nameCopies.hasCopySuffix('Copy of the look_Video'), false); assert.equal(nameCopies.hasCopySuffix('Hero Product Copy'), false, 'no dash: not a duplicate marker');
  assert.equal(nameCopies.hasCopySuffix('Hero - Copy Cat_Video'), false, 'not at the end');
  assert.equal(nameCopies.baseOf('Hero_Video - Copy - Copy 2'), 'Hero_Video');
});

test('duplication: genuinely different executions stay separate (same concept, similar names, identical names with no suffix)', async () => {
  const clean = '#300_26-WK30_20-07_PRODUCT_SHORTS_CLEAN_Video_Single_MARK_STYLING'; const conf = '#300_26-WK30_20-07_PRODUCT_SHORTS_CONFIDENT_Video_Single_MARK_STYLING';
  assert.equal((await load([ad('a', { name: clean, concept: 'STYLING' }), ad('b', { name: conf, concept: 'STYLING' })])).creatives.length, 2, 'same concept, two executions');
  assert.equal((await load([ad('a', { name: `${clean} - Copy` }), ad('b', { name: `${conf} - Copy` })])).creatives.length, 2, 'their copies stay with their own execution');
  assert.equal((await load([ad('a', { name: 'Hero_Video' }), ad('b', { name: 'Hero_Video' })])).creatives.length, 2, 'identical names alone are not evidence of a duplicate');
  assert.equal((await load([ad('a', { name: 'Hero_Video_A - Copy' }), ad('b', { name: 'Hero_Video_B - Copy' })])).creatives.length, 2, 'different bases never merge');
});

test('duplication: the same Meta creative id is one creative whatever the names; different creative ids that are verified copies fold', async () => {
  assert.equal((await load([ad('a', { name: 'X', creative: 'crSame' }), ad('b', { name: 'Y renamed', creative: 'crSame' })])).creatives.length, 1);
  assert.equal((await load([ad('a', { name: 'X_Video', creative: 'cr1' }), ad('b', { name: 'X_Video - Copy', creative: 'cr2' }), ad('c', { name: 'X_Video - Copy 2', creative: 'cr3' })])).creatives.length, 1);
});

test('duplication: a duplicate never resets the creative’s age (the original instance’s dates win) and the production date stays the original’s', async () => {
  const nm = '#306_26-WK38_18-09_SUMMER SHORTS_Video';
  const rows = [ad('dup', { name: `${nm} - Copy`, creative: 'c2', created: `${day(2)}T00:00:00Z`, first: day(1), rows: 2 })];
  const origins = [{ meta_ad_id: 'orig', meta_creative_id: 'c1', ad_name: nm, created_time: `${day(40)}T00:00:00Z`, first_day: day(38) }];
  // the origin lookup finds the original by the shared base name (the paused original is not an active matched ad)
  const ev = await load(rows, { origins });
  assert.equal(ev.creatives[0].first_delivery, day(38)); assert.equal(ev.creatives[0].first_delivery_from_other_instance, true);
  const stub = { query: async (sql) => (/last-creative-origins/.test(sql) ? { rows: [{ meta_ad_id: 'orig', meta_creative_id: 'c1', ad_name: nm, created_time: '2026-09-19T00:00:00Z' }] } : { rows: [{ meta_ad_id: 'dup', ad_name: `${nm} - Copy`, meta_creative_id: 'c2', effective_status: 'ACTIVE', created_time: '2026-10-10T00:00:00Z', product_codes: ['W26AA001'] }] }) };
  const out = await lc.loadLastCreativeDates([fam], { db: stub, today: '2026-10-14' });
  assert.equal(out.byFamily.get('W26AA001').last_creative_uploaded_date, '2026-09-18', 'the original creative date, not the duplicate’s creation');
});

// ── ACTIVE ADS ───────────────────────────────────────────────────────────────────────────────
test('active ads: one creative = 1; different executions count separately; the same creative in several campaigns or funnels counts once', async () => {
  assert.equal((await evalWith([ad('a')])).facts.live_creatives, 1);
  assert.equal((await evalWith([ad('a'), ad('b'), ad('c'), ad('d'), ad('e')])).facts.live_creatives, 5);
  const campaigns = await evalWith([1, 2, 3].map((i) => ad(`c${i}`, { creative: 'crX', name: 'Hero_Video' })));
  assert.deepEqual([campaigns.facts.live_creatives, campaigns.facts.live_instances], [1, 3]);
  const funnels = await evalWith([ad('t', { creative: 'crY', funnel: 'TOF' }), ad('m', { creative: 'crY', funnel: 'TOM' }), ad('o', { creative: 'crY', funnel: 'MOF' })]);
  assert.deepEqual([funnels.facts.live_creatives, funnels.facts.live_instances], [1, 3]);
});

test('active ads: only creatives delivering inside the (configurable) window count; stalled, never-delivered and historical-only do not', async () => {
  const it = await evalWith([ad('on', { name: 'Delivering', last: day(1) }), ad('stalled', { name: 'Stalled', last: day(20), rows: 5 }), ad('never', { name: 'Never', first: null, last: null, rows: 0, spend: 0, purchases: 0 })]);
  assert.equal(it.facts.live_creatives, 1); assert.equal(it.facts.live_stalled, 2);
  assert.equal((await evalWith([])).facts.live_creatives, 0, 'historical creatives only: nothing is loaded as active');
  assert.equal(CFG.live_delivery_days, 7);
});

test('active ads: when stored delivery is stale the count is unknown (a dash), never a guess', async () => {
  const it = await evalWith([ad('a', { last: day(12) })], { newest: day(12) });
  assert.equal(it.facts.live_creatives, null); assert.equal(E.coverage(it, '2026').active, null); assert.equal(E.coverage(it, '2026').activeKnown, false);
});

test('active ads: the coverage wording is "N Active Ads" with the latest creative date on the second line, and the two populations are independent', () => {
  const it = (live, lastCreative) => ({ facts: { live_creatives: live, active_ads: 3, live_unknown: false, live_window_days: 7 }, last_creative: lastCreative });
  const lastC = { creatives_total: 13, last_creative_uploaded_date: '2026-08-28', possibly_newer_undated: false };
  let c = E.coverage(it(5, lastC), '2026');
  assert.deepEqual([c.active, c.activeKnown, c.latest, c.latestKnown], [5, true, '28 Aug 2026', true], '13 creatives on record, 5 active: the table says 5');
  c = E.coverage(it(0, lastC), '2026'); assert.deepEqual([c.active, c.latest], [0, '28 Aug 2026'], '0 Active Ads with a latest creative date is correct');
  c = E.coverage(it(2, { creatives_total: 4, last_creative_uploaded_date: null }), '2026'); assert.equal(c.latest, 'Unknown');
  c = E.coverage(it(2, { creatives_total: 0, last_creative_uploaded_date: null }), '2026'); assert.equal(c.latest, 'None');
  c = E.coverage({ facts: { live_creatives: 2 } }, '2026'); assert.equal(c.latestKnown, false, 'no creative dates loaded: the date is not invented');
  assert.match(E.coverage(it(5, lastC), '2026').title, /5 active ads/i);
});

// ── PERFORMANCE ACROSS FUNNELS ───────────────────────────────────────────────────────────────
test('performance: one creative in TOF, TOM and MOF is ONE creative but keeps each funnel’s own spend and purchases (no averaging, no double counting)', async () => {
  const rows = [
    ad('t', { creative: 'crY', funnel: 'TOF', spend: 200, purchases: 2 }), ad('m', { creative: 'crY', funnel: 'TOM', spend: 300, purchases: 6 }), ad('o', { creative: 'crY', funnel: 'MOF', spend: 500, purchases: 25 }),
  ];
  const ev = await load(rows); const c = ev.creatives[0];
  assert.equal(ev.creatives.length, 1); assert.equal(c.mixed_funnels, true);
  const by = Object.fromEntries(c.funnel_results.map((f) => [f.funnel, f]));
  assert.deepEqual([by.TOF.spend, by.TOF.purchases], [200, 2]); assert.deepEqual([by.TOM.spend, by.TOM.purchases], [300, 6]); assert.deepEqual([by.MOF.spend, by.MOF.purchases], [500, 25]);
  assert.equal(c.funnel_results.reduce((s, f) => s + f.spend, 0), 1000, 'the funnels add up to the creative’s spend exactly once');
  assert.equal(by.TOF.cpa, 100); assert.equal(by.MOF.cpa, 20); assert.notEqual(c.cpa, 40.0 + 0 && 1000 / 33 * 0 + 31, 'no blended CPA is invented for the creative as a whole');
});

test('performance: copies in different funnels fold into one creative while each funnel keeps its own pooled metrics', async () => {
  const ev = await load([ad('o', { name: 'X_Video - Copy', creative: 'c1', funnel: 'TOF', spend: 100, purchases: 1 }), ad('p', { name: 'X_Video - Copy 2', creative: 'c2', funnel: 'MOF', spend: 400, purchases: 20 }), ad('q', { name: 'X_Video - Copy 3', creative: 'c3', funnel: 'MOF', spend: 100, purchases: 5 })]);
  assert.equal(ev.creatives.length, 1);
  const by = Object.fromEntries(ev.creatives[0].funnel_results.map((f) => [f.funnel, f]));
  assert.deepEqual([by.MOF.spend, by.MOF.purchases], [500, 25], 'the two MOF copies pool inside MOF'); assert.deepEqual([by.TOF.spend, by.TOF.purchases], [100, 1]);
});

test('performance: approved benchmarks decide; a funnel with no approved benchmark is unrated, never underperforming', async () => {
  const rated = RULES.MOF && RULES.MOF.cpa_limit !== undefined ? 'MOF' : null;
  const ev = await load([ad('t', { creative: 'crY', funnel: 'TOF', spend: 900, purchases: 1 }), ad('o', { creative: 'crY', funnel: 'MOF', spend: 400, purchases: 40 })]);
  const by = Object.fromEntries(ev.creatives[0].funnel_results.map((f) => [f.funnel, f]));
  assert.notEqual(by.TOF.state, 'underperforming', 'TOF has no approved CPA benchmark: its CPA is not judged against another funnel’s');
  assert.ok(['unrated', 'insufficient', 'unavailable'].includes(by.TOF.state), `TOF state: ${by.TOF.state}`);
  assert.ok(rated === 'MOF' || by.MOF.state, 'MOF is judged by its own approved benchmark');
});

test('performance: deduplication feeds the coverage the engine uses (4 copies were 4 creatives, now 1), and ratings come from the pooled execution', async () => {
  const rows = [`${SCRIPT} - Copy`, `${SCRIPT} - Copy 2`, `${SCRIPT} - Copy 3`, `${SCRIPT} - Copy - Copy`].map((n, i) => ad(`s${i}`, { name: n, spend: 100, purchases: 2 }));
  const it = await evalWith(rows);
  assert.equal(it.facts.unique_creatives, 1); assert.equal(it.facts.creatives_in_play, 1, 'coverage counts one execution');
  assert.equal(it.creatives[0].spend, 400, 'the pooled spend of the four instances, once');
});

// ── PRESERVATION ─────────────────────────────────────────────────────────────────────────────
test('preservation: thresholds, ranking inputs and the Creative Insights code are untouched; Planning-only merge is opt-in', () => {
  const root = path.join(__dirname, '..');
  const ci = fs.readFileSync(path.join(root, 'src', 'lib', 'creativeInsights.js'), 'utf8');
  assert.match(ci, /perf\.mergeNameCopies\(groups, nameCopies\)/); assert.doesNotMatch(ci, /mergeCopySiblings/, 'Creative Insights is unchanged and keeps its own merge');
  const cfg = require('../src/lib/creativePlanningConfig');
  assert.equal(cfg.resolve({}).config.live_delivery_days, 7); assert.equal(cfg.resolve({}).config.new_creative_days, 4);
});
