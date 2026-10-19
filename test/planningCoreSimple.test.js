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

test('page shape: Core, High Stocks and the Core Catalogue share ONE table row and ONE expanded product detail; View Meta ads is one button', () => {
  const root = path.join(__dirname, '..');
  const pl = fs.readFileSync(path.join(root, 'public', 'planning.js'), 'utf8'); const css = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
  const fn = (name, next) => pl.slice(pl.indexOf(`function ${name}`), pl.indexOf(next, pl.indexOf(`function ${name}`)));
  // the expanded row is just a wrapper around the shared panel
  const row = fn('plCoreDetailHtml', 'function plCoreHeadHtml');
  assert.match(row, /plProductPanelHtml\(it\)/); assert.doesNotMatch(row, /plCoreMetrics|plMainImg/, 'no second detail layout');
  const panel = fn('plProductPanelHtml', 'function plCoreDetailHtml');
  for (const part of ['plSalesInventoryHtml(it)', 'plCreativeSummaryCardHtml(it)', 'plCreativePaneHtml(it)', 'plShootPaneHtml(it)', 'plEvidenceHtml(it)']) assert.ok(panel.includes(part), part);
  assert.match(panel, /Overview|PL_PX_TABS/); assert.match(pl, /\['overview', 'Overview'\], \['creative', 'Creative Performance'\], \['shoot', 'Shoot Readiness'\]/, 'the three sections');
  // section A: sales and inventory
  const si = fn('plSalesInventoryHtml', 'function plCreativeCountsHtml');
  for (const label of ['Last 7 days', 'Last 30 days', 'Trend', 'MTD vs LY', 'Stock on hand', 'On order', 'Weeks of cover']) assert.ok(si.includes(label), label);
  // section B: creative performance, each funnel on its own benchmark
  const counts = fn('plCreativeCountsHtml', 'function plCreativeSummaryCardHtml');
  for (const label of ['Active', 'Effective', 'Underperforming', 'Testing', 'Unrated']) assert.ok(counts.includes(`'${label}'`), label);
  assert.match(fn('plFunnelTableHtml', 'function plCreativePaneHtml'), /No approved .* benchmark: those creatives are shown as Unrated, never as underperforming/);
  assert.match(pl, /View Meta ads &rarr;/); assert.doesNotMatch(pl, /plCoreAdsHtml|pl-ads-table|pl-cx-ads/, 'no embedded Meta ads table in Planning');
  assert.match(pl, /mpOpenProduct\(\{ codes, label: it\.name, key: it\.key, from: state\.planningStep/, 'it opens Meta Performance scoped to the product');
  // section C: shoot readiness: colourways, production activity, one Add action
  const shoot = fn('plShootPaneHtml', 'function plEvidenceHtml');
  assert.match(shoot, /plCoreColourCards\(it\)/); assert.match(shoot, /Already in production/); assert.match(shoot, /plCoreAddBtn\(it\)/);
  assert.equal((shoot.match(/plCoreAddBtn\(it\)/g) || []).length, 1, 'exactly one primary action');
  assert.match(pl, /drop-card-product-tile pl-cc-tile/, 'colourway thumbnails are the Upcoming Drops tile'); assert.match(pl, /#i-image/, 'the same image icon fallback');
  // the detailed evidence stays one click down
  assert.match(fn('plEvidenceHtml', 'function plProductPanelHtml'), /<details class="pl-evidence"[\s\S]*View detailed evidence/);
  // one row builder for every page
  assert.match(pl, /return plCoreTableHtml\(mode, items, cat\)/, 'Core and High Stocks render the same table');
  assert.match(pl, /plCoreRowHtml\(r\.info\.it, 'cat'/, 'the Core Catalogue renders the same row');
  assert.match(pl, /plPageHtml\('high', tierNote\)/);
  for (const gone of ['function plTableHtml', 'function plDetailHtml', 'function plMetricsCell', 'function plLiveAdsHtml', 'function plCoreMetrics', 'const plMainImg']) assert.ok(!pl.includes(gone), `${gone} was an older layout and is gone`);
  assert.match(css, /\.pl-px-tab\.active\{/); assert.match(css, /\.pl-px-cards\{display:grid/);
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
