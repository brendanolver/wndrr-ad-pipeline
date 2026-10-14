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

test('page shape: Core uses its own short table and expanded view; High Stocks keeps the Batch 32 layout', () => {
  const root = path.join(__dirname, '..');
  const pl = fs.readFileSync(path.join(root, 'public', 'planning.js'), 'utf8'); const css = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
  const fn = (name, next) => pl.slice(pl.indexOf(`function ${name}`), pl.indexOf(next, pl.indexOf(`function ${name}`)));
  const core = fn('plCoreDetailHtml', 'function plCoreTableHtml');
  assert.doesNotMatch(core, /<details|plLiveAdsHtml|plEvidenceParts|keyFacts|whyWithNumbers|conditionsSummary|score_parts|Eligibility|Additional details|Recent live ads/, 'the Core expanded view has no accordions and none of the technical evidence');
  assert.match(core, /plMainImg\(it\.image_url\)/); assert.match(core, /plCoreMetrics\(it\)/); assert.match(core, /plCoreColourCards\(it\)/); assert.match(core, /plCoreAddBtn\(it\)/); assert.match(core, /data-opp-meta/);
  assert.equal((core.match(/plCoreAddBtn\(it\)/g) || []).length, 1, 'exactly one primary action in the expanded view');
  assert.match(pl, /coverage-card-imgrow pl-cx-img/, 'the main picture is the Upcoming Drops picture panel'); assert.match(pl, /drop-card-product-tile pl-cc-tile/, 'colourway thumbnails are the Upcoming Drops tile');
  assert.match(pl, /#i-image/, 'the same image icon fallback');
  const metrics = fn('plCoreMetrics', 'function plHasMetaAds');
  assert.equal((metrics.match(/\bm\(/g) || []).length, 3, 'three metrics'); assert.match(metrics, /Sales &middot; 30D/); assert.match(metrics, /Stock on hand/); assert.match(metrics, /Active creatives/);
  assert.match(pl, /return mode === 'core' \? plCoreTableHtml\(mode, items, cat\) : plTableHtml\(mode, items, cat\)/);
  assert.match(pl, /function plDetailHtml/); assert.match(fn('plDetailHtml', 'function plBase') || pl, /Additional details/, 'High Stocks keeps its detailed panel');
  assert.match(css, /\.coverage-card-imgrow\{[^}]*height:170px/); assert.match(css, /\.pl-cx-img\{height:170px/);
});
