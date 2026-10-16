'use strict';
// Batch 29: the LIVE ADS column. One live ad = one distinct creative execution (an identical Meta creative id, or a "- Copy" by name), never a Meta ad id.
// Built on the REAL grouping code (productAdPerformance.loadProductAdPerformance over a stubbed database) and the real engine, so the Live Ads count, creative coverage,
// concentration and the explanations are proved to share one creative identity. No database, no network.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const perf = require('../src/lib/productAdPerformance');
const nameCopies = require('../src/lib/metaNameCopies');
const opp = require('../src/lib/planningOpportunities');
const cfgLib = require('../src/lib/creativePlanningConfig');
const E = require('../public/planningExplain');
const { CFG, TODAY, day, salesOf, base } = require('./_planningFixtures');

const health = require('../src/lib/metaFunnelHealth');
const RULES = health.effectiveRules(); const CODED = health.COLOUR_CODED;
const fam = { key: 'W26AA001', codes: ['W26AA001'] };

// one Meta ad row as the loader's query returns it
const ad = (id, o = {}) => ({
  meta_ad_id: id, ad_name: o.name || `Ad ${id}`, meta_creative_id: o.creative === undefined ? `cr_${id}` : o.creative, created_time: o.created || `${day(60)}T00:00:00Z`, funnel: o.funnel || 'MOF',
  first_day: o.first === undefined ? day(40) : o.first, last_day: o.last === undefined ? day(1) : o.last, life_spend: o.spend === undefined ? 400 : o.spend,
  concept_label: o.concept || null, creator_name: null, creative_style_id: null, media_type: o.media || null, product_codes: ['W26AA001'], delivery_rows: o.rows === undefined ? 14 : o.rows,
  t_spend: o.spend === undefined ? 400 : o.spend, t_imp: 40000, t_clk: 800, t_pur: o.purchases === undefined ? 8 : o.purchases, t_val: 1600,
  f_spend: 0, f_imp: 0, f_clk: 0, f_pur: 0, f_val: 0, g_spend: 0, g_imp: 0, g_clk: 0, g_pur: 0, g_val: 0, r_spend: 0, r_imp: 0, r_clk: 0, r_pur: 0, r_val: 0, p_spend: 0, p_imp: 0, p_clk: 0, p_pur: 0, p_val: 0,
});
const stubDb = (rows, newest = day(1), origins = []) => ({
  query: async (sql) => (/creative-origins/.test(sql) ? { rows: origins } : /MIN\(insight_date\)/.test(sql) ? { rows: [{ d: day(200), n: newest }] } : { rows }),
});
const load = async (rows, newest) => (await perf.loadProductAdPerformance([fam], { db: stubDb(rows, newest), rules: RULES, coded: CODED, today: TODAY, nameCopies })).get(fam.key);
const evalWith = async (rows, o = {}, cfg = CFG) => {
  const ev = await load(rows, o.newest);
  return opp.evaluate(base({ sales: salesOf(150, { units7: 40, units14: 75 }), coverage: { known: true, active_ads: rows.length, possible: o.pending || 0, unresolved: 0, unresolved_share_pct: 0, min: 5 }, creatives: ev.creatives, insights_last_day: ev.insights_last_day, ...(o.product || {}) }), cfg, TODAY, 'core');
};

test('live ads: one creative duplicated across five campaigns is ONE live ad (five Meta ad instances)', async () => {
  const rows = [1, 2, 3, 4, 5].map((i) => ad(`a${i}`, { creative: 'cr_same', name: 'Try-on video', spend: 100, purchases: 2 }));
  const it = await evalWith(rows);
  assert.equal(it.facts.live_creatives, 1);
  assert.equal(it.facts.live_instances, 5);
  assert.equal(it.facts.unique_creatives, 1, 'creative coverage uses the same identity');
  assert.equal(it.creatives.length, 1); assert.equal(it.creatives[0].ads, 5); assert.equal(it.creatives[0].name, 'Try-on video');
  const lv = E.liveAds(it);
  assert.equal(lv.count, 1); assert.equal(lv.instances, 5, 'the instance count stays available for audit');
  assert.ok(!/Meta ad/i.test(lv.lines.join(' ') + lv.title), 'Batch 30: the display never mentions Meta ad instances');
  assert.match(E.conditionsSummary(it) || '', /1 unique creative \(1 delivering now\):/, 'the explanation quotes the same deduplicated identity, without instance counts');
  assert.equal(it.facts.top_creative_spend_share, 100, 'concentration sees one creative holding all the spend, not five');
});

test('live ads: three completely different creatives for one product are three live ads', async () => {
  const it = await evalWith([ad('a1'), ad('a2'), ad('a3')]);
  assert.equal(it.facts.live_creatives, 3); assert.equal(it.facts.live_instances, 3); assert.equal(it.facts.unique_creatives, 3);
  assert.equal(E.liveAds(it).lines.length, 0, 'nothing but the number when every ad is its own creative');
});

test('live ads: the same concept with different executions is NOT merged (different creative ids stay separate)', async () => {
  const it = await evalWith([ad('a1', { concept: 'TRY ON' }), ad('a2', { concept: 'TRY ON' }), ad('a3', { concept: 'TRY ON' })]);
  assert.equal(it.facts.live_creatives, 3, 'a shared concept or creator does not deduplicate executions');
  assert.equal(it.facts.distinct_concepts, 1, 'but diversity still sees one concept');
});

test('live ads: a "- Copy" of an ad by name is the same creative even with its own creative id', async () => {
  const it = await evalWith([ad('a1', { name: 'Hero video', creative: 'cr_1' }), ad('a2', { name: 'Hero video - Copy', creative: 'cr_2' }), ad('a3', { name: 'Other video', creative: 'cr_3' })]);
  assert.equal(it.facts.live_creatives, 2); assert.equal(it.facts.live_instances, 3);
});

test('live ads: a video and a static image of the same product are two live ads, each with its format', async () => {
  const it = await evalWith([ad('v1', { media: 'video', name: 'Video one' }), ad('s1', { media: 'image', name: 'Static one' })]);
  assert.equal(it.facts.live_creatives, 2);
  const fmt = Object.fromEntries(it.creatives.map((c) => [c.name, c.format]));
  assert.deepEqual(fmt, { 'Video one': 'Video', 'Static one': 'Image / Static' });
});

test('live ads: active in Meta without recent delivery is not live (and is told apart from a brand-new ad)', async () => {
  const it = await evalWith([
    ad('on', { name: 'Delivering', last: day(1) }),
    ad('stalled', { name: 'Stalled', last: day(20), rows: 5 }),                                  // delivered before, not in the live window
    ad('never', { name: 'Never delivered', first: null, last: null, rows: 0, spend: 0, purchases: 0 }),
    ad('new', { name: 'Just launched', first: null, last: null, rows: 0, spend: 0, purchases: 0, created: `${day(1)}T00:00:00Z` }),
  ]);
  assert.equal(it.facts.live_creatives, 1, 'only the delivering creative is live');
  assert.equal(it.facts.live_stalled, 2, 'previously delivering + never delivered');
  assert.equal(it.facts.live_starting, 1, 'a creative launched yesterday is too new to have data: listed, not counted');
  const by = Object.fromEntries(it.creatives.map((c) => [c.name, c.live_status]));
  assert.deepEqual(by, { Delivering: 'delivering', Stalled: 'stalled', 'Never delivered': 'no_delivery', 'Just launched': 'starting' });
  const lv = E.liveAds(it);
  assert.ok(lv.lines.includes('+2 not delivering') && lv.lines.includes('+1 just launched'));
});

test('live ads: the delivery window is a setting, not a hidden rule (default 7 days)', async () => {
  assert.equal(CFG.live_delivery_days, 7);
  const rows = [ad('a1', { last: day(10), rows: 8 })];
  assert.equal((await evalWith(rows)).facts.live_creatives, 0, '10 days ago is outside the 7-day window');
  const wide = cfgLib.resolve({ live_delivery_days: 14 }).config;
  assert.equal((await evalWith(rows, {}, wide)).facts.live_creatives, 1);
  assert.equal(cfgLib.resolve({ live_delivery_days: 99 }).config.live_delivery_days, 7, 'out-of-range values are refused');
});

test('live ads: when stored delivery is stale nothing is invented (unknown, shown as a dash)', async () => {
  const it = await evalWith([ad('a1', { last: day(12) })], { newest: day(12) });
  assert.equal(it.facts.live_creatives, null); assert.equal(it.facts.live_unknown, true);
  const lv = E.liveAds(it); assert.equal(lv.known, false); assert.match(lv.title, /too old/);
  assert.equal(E.keyFacts(it).find((r) => r[0] === 'Live ads')[1], 'Not available');
});

test('live ads: uncertain product matches are disclosed, never added to the count', async () => {
  const it = await evalWith([ad('a1'), ad('a2')], { pending: 3 });
  assert.equal(it.facts.live_creatives, 2, 'awaiting-review ads are not counted');
  const lv = E.liveAds(it);
  assert.equal(lv.pending, 3); assert.ok(lv.lines.includes('+3 unreviewed')); assert.match(lv.title, /may belong to this product, so the count may be incomplete/);
  assert.match(E.keyFacts(it).find((r) => r[0] === 'Live ads')[1], /\+3 awaiting review/);
});

test('live ads: a product with no matched active ads has zero live ads (not unknown) when Meta data is fresh', async () => {
  const it = await evalWith([]);
  assert.equal(it.facts.live_creatives, 0); assert.equal(E.liveAds(it).count, 0);
});

test('live ads: Live Ads, coverage, concentration and the explanation agree on the number of creatives', async () => {
  const rows = [ad('a1', { creative: 'big', spend: 900, purchases: 10 }), ad('a2', { creative: 'big', spend: 100, purchases: 1 }), ad('a3', { creative: 'small', spend: 100, purchases: 1 })];
  const it = await evalWith(rows);
  assert.equal(it.facts.unique_creatives, 2); assert.equal(it.facts.live_creatives, 2); assert.equal(it.facts.live_instances, 3);
  assert.equal(it.creatives.length, 2);
  assert.equal(Math.round(it.facts.top_creative_spend_share), 91, '(900+100)/(1100) of the spend sits on the one duplicated creative');
});

test('live ads: page wiring (Active Ads in the Creative coverage column on both pages, settings)', () => {
  const pl = fs.readFileSync(path.join(__dirname, '..', 'public', 'planning.js'), 'utf8');
  const cell = pl.slice(pl.indexOf('function plCoreCoverageCell'), pl.indexOf('function plCoreActiveAdsLine'));
  const active = pl.slice(pl.indexOf('function plCoreActiveAdsLine'), pl.indexOf('function plCoreStatusCell'));
  assert.ok(active.includes('Active ') && pl.slice(pl.indexOf('function plCoreProductCell'), pl.indexOf('// the trend is shown')).includes('plCoreActiveAdsLine(it)'), 'Active Ads sit under the product name');
  assert.ok(cell.includes('pt-cov-d') && !/Active \$\{/.test(cell), 'the Latest creative column holds only the date and how long ago');
  assert.ok(pl.includes("plPageHtml(mode") || (pl.includes("plPageHtml('core')") && pl.includes("plPageHtml('high', tierNote)")), 'Core and High Stocks share one table');
  assert.ok(Object.keys(cfgLib.LABEL).includes('live_delivery_days'));
});
