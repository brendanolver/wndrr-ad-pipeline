'use strict';
// Planning -> Core: the simplified task list. Wording only (PlanningExplain.coreStatus / whyShoot over the engine's output) and the shape of the page.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const E = require('../public/planningExplain');
const lc = require('../src/lib/lastCreativeDate');

const CFG = { min_performing_creatives: 3 };
const needs = (type, facts = {}, extra = {}) => ({ actionable: true, status: 'act', opportunity_type: type, gap: { type }, facts: { demand_level: 'strong', stock_band: 'healthy', unique_creatives: 8, performing: 2, creatives_in_play: 2, distinct_concepts: 1, top_creative_spend_share: 91, ...facts }, ...extra });

test('core status: the Creative Gap names', () => {
  assert.deepEqual(E.coreStatus(needs('confirmed_gap'), CFG), { label: 'No Active Creative', tone: 'red', text: 'Strong sales, but no ads currently running.' });
  assert.equal(E.coreStatus(needs('confirmed_gap', { demand_level: 'steady' }), CFG).text, 'Steady sales, but no ads currently running.');
  assert.equal(E.coreStatus(needs('underperforming'), CFG).text, 'Only 2 of 8 creatives performing.');
  assert.equal(E.coreStatus(needs('underperforming', { performing: 0, unique_creatives: 2 }), CFG).text, 'None of 2 creatives are performing.');
  assert.equal(E.coreStatus(needs('underperforming', { performing: 0, unique_creatives: 1 }), CFG).text, 'None of 1 creative is performing.');
  assert.equal(E.coreStatus(needs('thin'), CFG).label, 'Low Creative Coverage'); assert.equal(E.coreStatus(needs('stale'), CFG).label, 'Old Creative');
  const testing = E.coreStatus({ actionable: false, status: 'testing', facts: { testing: 2 } }, CFG);
  assert.deepEqual([testing.label, testing.tone], ['Creative in Testing', 'amber']);
  assert.deepEqual(E.coreStatus({ actionable: false, status: 'covered', facts: { performing: 1, unique_creatives: 3 } }, CFG).label, 'Adequately Covered');
  const review = E.coreStatus({ actionable: false, status: 'insufficient_data', needs_review: true, review_reason: 'missing_benchmark', facts: {} }, CFG);
  assert.deepEqual([review.label, review.tone], ['Benchmark Missing', 'grey']);
});

test('why shoot: ONE concise sentence from the engine facts, for every gap type and category', () => {
  const sentences = (t) => (t.match(/[.](\s|$)/g) || []).length;
  for (const type of ['confirmed_gap', 'underperforming', 'fatigue', 'concentration', 'diversity', 'stale', 'thin', 'mystery']) {
    const t = E.whyShoot(needs(type), CFG);
    assert.equal(sentences(t), 1, `${type}: ${t}`); assert.ok(t.length < 200, `${type} is concise`); assert.match(t, /^Strong recent sales and healthy stock levels, but /);
  }
  assert.equal(E.whyShoot(needs('underperforming'), CFG), 'Strong recent sales and healthy stock levels, but only 2 of 8 active creatives are performing against the approved CPA limit.');
  assert.match(E.whyShoot(needs('confirmed_gap', { demand_level: 'steady', stock_band: 'slow' }), CFG), /^Steady sales and plenty of stock, but no ads are currently running\.$/);
  assert.equal(E.whyShoot({ actionable: false, status: 'in_production', facts: {} }, CFG), 'A concept is already progressing through the Shoot Plan, so no new creative is needed yet.');
  assert.equal(sentences(E.whyShoot({ actionable: false, status: 'covered', facts: { performing: 3, unique_creatives: 4 } }, CFG)), 1);
  assert.equal(sentences(E.whyShoot({ actionable: false, status: 'insufficient_data', needs_review: true, review_reason: 'insufficient_delivery', facts: {} }, CFG)), 1);
});

test('why shoot: it only words the engine output (no stock claim without stock evidence, no creative count it does not have)', () => {
  assert.doesNotMatch(E.whyShoot(needs('confirmed_gap', { stock_band: null }), CFG), /stock/);
  assert.match(E.whyShoot(needs('underperforming', { unique_creatives: null }), CFG), /the active creative is not performing/);
  const it = needs('underperforming'); const copy = JSON.parse(JSON.stringify(it)); E.whyShoot(it, CFG); E.coreStatus(it, CFG); assert.deepEqual(it, copy);
});

test('days since last creative is whole days from the name date to today (display only)', async () => {
  const stub = { query: async (sql) => (/last-creative-origins/.test(sql) ? { rows: [] } : { rows: [{ meta_ad_id: 'a', ad_name: '#306_26-WK38_18-09_X_Video', meta_creative_id: 'c1', effective_status: 'ACTIVE', created_time: '2026-09-19T00:00:00Z', product_codes: ['W26AA001'] }] }) };
  const out = await lc.loadLastCreativeDates([{ key: 'W26AA001', codes: ['W26AA001'] }], { db: stub, today: '2026-10-14' });
  assert.equal(out.byFamily.get('W26AA001').days_since, 26);
  assert.equal(E.lastCreative({ last_creative: { last_creative_uploaded_date: '2026-09-18', days_since: 26 } }).days, 26);
});

test('page shape: Core and High Stocks share the short table and expanded view; View Meta Ads is one button', () => {
  const root = path.join(__dirname, '..');
  const pl = fs.readFileSync(path.join(root, 'public', 'planning.js'), 'utf8'); const css = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
  const fn = (name, next) => pl.slice(pl.indexOf(`function ${name}`), pl.indexOf(next, pl.indexOf(`function ${name}`)));
  const core = fn('plCoreDetailHtml', 'function plCoreTableHtml');
  assert.doesNotMatch(core, /<details|plLiveAdsHtml|plEvidenceParts|keyFacts|whyWithNumbers|conditionsSummary|score_parts|Eligibility|Additional details|Recent live ads/, 'the expanded view has no accordions and none of the technical evidence');
  assert.match(core, /plMainImg\(it\.image_url\)/); assert.match(core, /plCoreMetrics\(it\)/); assert.match(core, /plCoreColourCards\(it\)/); assert.match(core, /plMetaBtn\(it\)/);
  assert.equal((core.match(/plCoreAddBtn\(/g) || []).length, 0, 'the row already has Add to Shoot / Added: the expanded view does not repeat it');
  assert.match(core, /data-opp-plan=/, 'the full Shoot This Week form stays reachable from the expanded view (More options)');
  assert.match(pl, /View Meta Ads &rarr;/); assert.doesNotMatch(pl, /plCoreAdsHtml|pl-ads-table|pl-cx-ads/, 'no embedded Meta ads table in Planning');
  assert.match(pl, /mpOpenProduct\(\{ codes, label: it\.name, key: it\.key, from: state\.planningStep/, 'it opens Meta Performance scoped to the product');
  assert.match(pl, /coverage-card-imgrow pl-cx-img/, 'the main picture is the Upcoming Drops picture panel'); assert.match(pl, /drop-card-product-tile pl-cc-tile/, 'colourway thumbnails are the Upcoming Drops tile');
  assert.match(pl, /#i-image/, 'the same image icon fallback');
  const metrics = pl.slice(pl.indexOf('const plMetricCard'), pl.indexOf('function plHasMetaAds'));
  assert.equal((fn('plCoreMetrics', 'function plHasMetaAds').match(/plMetricCard\(|plCreativeCardHtml\(/g) || []).length, 3, 'three metric cards'); assert.match(metrics, /Sales \(30D\)/); assert.match(metrics, /Stock on hand/); assert.match(metrics, /Active creatives performing/); assert.match(metrics, /PE\.creativeCard\(it\)/); assert.match(metrics, /No Active Creative/); assert.match(metrics, /No ads currently running for this product/); assert.match(metrics, /awaiting data/); assert.match(metrics, /past /); assert.match(metrics, /Creative Performance/); assert.match(metrics, /No past creatives/, 'the history line is always shown when known');
  assert.match(pl, /return plCoreTableHtml\(mode, items, cat\)/, 'Core and High Stocks render the same table');
  assert.match(pl, /plPageHtml\('high', tierNote\)/);
  for (const gone of ['function plTableHtml', 'function plDetailHtml', 'function plMetricsCell', 'function plLiveAdsHtml']) assert.ok(!pl.includes(gone), `${gone} was the old High Stocks layout and is gone`);
  assert.match(css, /\.coverage-card-imgrow\{[^}]*height:170px/); assert.match(css, /\.pl-cx-img\{height:200px/);
});

test('creative coverage: Active Ads and the latest NAME date; Unknown / None are told apart; never a delivery date', () => {
  const lc2 = (o, live = 5) => ({ facts: { live_creatives: live, active_ads: 6 }, last_creative: { creatives_total: 13, last_creative_uploaded_date: '2026-09-18', possibly_newer_undated: false, ...o } });
  let c = E.coverage(lc2({}), '2026');
  assert.deepEqual([c.known, c.active, c.latest, c.latestKnown], [true, 5, '18 Sep 2026', true]);
  assert.equal(E.coverage(lc2({ last_creative_uploaded_date: '2025-12-30' }), '2026').latest, '30 Dec 2025', 'a date from another year carries its year');
  c = E.coverage(lc2({ last_creative_uploaded_date: null }), '2026'); assert.deepEqual([c.active, c.latest, c.latestKnown], [5, 'Unknown', false]);
  c = E.coverage(lc2({ creatives_total: 0, last_creative_uploaded_date: null }, 0), '2026'); assert.deepEqual([c.active, c.latest], [0, 'None']);
  assert.equal(E.coverage({}, '2026').known, false); assert.equal(E.coverage({ last_creative: {} }, '2026').latest, null);
  assert.equal(E.coverage(lc2({ possibly_newer_undated: true }), '2026').uncertain, true);
  assert.match(E.coverage(lc2({}), '2026').title, /Copy.*count once[\s\S]*not a delivery date/);
});

test('creative coverage: the loader counts each unique creative once across campaigns, funnels and Copy suffixes', async () => {
  const nm = (n) => `#${n}_26-WK38_18-09_X_Video`;
  const r = (id, name, cr) => ({ meta_ad_id: id, ad_name: name, meta_creative_id: cr, effective_status: 'ACTIVE', created_time: '2026-09-19T00:00:00Z', product_codes: ['W26AA001'] });
  const rows = [r('a1', nm(1), 'c1'), r('a2', nm(1), 'c1'), r('a3', nm(1), 'c1'),       // one creative in three campaigns
    r('b1', nm(2), 'c2'), r('b2', `${nm(2)} - Copy`, 'c3'), r('b3', `${nm(2)} - Copy 2`, 'c4'), // a creative and its copies (own creative ids)
    r('d1', nm(3), 'c5'), r('d2', nm(4), 'c6')];                                          // two different executions
  const stub = { query: async (sql) => (/last-creative-origins/.test(sql) ? { rows: [] } : { rows }) };
  const out = await lc.loadLastCreativeDates([{ key: 'W26AA001', codes: ['W26AA001', 'W26AA001BLK'] }], { db: stub, today: '2026-10-14' });
  assert.equal(out.byFamily.get('W26AA001').creatives_total, 4, '1 + 1 (with its copies) + 2 different executions');
});

test('creative history: earlier = all-time unique creatives minus those on active ads; unknown stays unknown', () => {
  const it = (all, onActive, active = 2) => ({ facts: { unique_creatives: onActive, active_ads: active }, last_creative: all === undefined ? undefined : { creatives_total: all } });
  assert.deepEqual(E.creativeHistory(it(11, 2)), { allTime: 11, earlier: 9 });
  assert.deepEqual(E.creativeHistory(it(2, 2)), { allTime: 2, earlier: 0 }, 'no history');
  assert.deepEqual(E.creativeHistory(it(1, 2)), { allTime: 2, earlier: 0 }, 'never negative: the larger figure is the all-time count');
  assert.equal(E.creativeHistory(it(undefined, 2)), null, 'creative dates not loaded');
  assert.equal(E.creativeHistory(it(5, 2, null)), null, 'Meta creative data unavailable');
  assert.equal(E.creativeHistory({}), null);
});
