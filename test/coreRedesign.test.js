'use strict';
// v1.4.7 Core Planning redesign: the creative picture helpers (pure, from the engine's own fields), and the contracts that keep Creative Opportunities and the Core Catalogue on ONE
// row, ONE product detail and ONE selection state.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const E = require('../public/planningExplain');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const pl = read('public', 'planning.js'); const app = read('public', 'app.js'); const css = read('public', 'styles.css'); const html = read('public', 'index.html');
const fn = (src, name) => { const i = src.indexOf(`function ${name}(`); return src.slice(i, src.indexOf('\n}\n', i) + 2); };

test('creative counts: active is the unique creatives delivering now; unrated and testing are counted apart and never as underperforming', () => {
  const c = E.creativeCounts({ facts: { active_ads: 4, live_creatives: 3, live_instances: 5, live_stalled: 1, performing: 1, weak: 0, testing: 1, unrated: 2 } });
  assert.deepEqual([c.known, c.active, c.effective, c.underperforming, c.testing, c.unrated, c.notDelivering], [true, 3, 1, 0, 1, 2, 1]);
  assert.equal(c.underperforming, 0, 'two unrated creatives do not make anything underperforming');
});

test('creative counts: when Meta creative data is unavailable nothing is invented', () => {
  const c = E.creativeCounts({ facts: { active_ads: null, live_creatives: null } });
  assert.equal(c.known, false); assert.equal(c.active, null); assert.equal(c.effective, null); assert.equal(c.unrated, null);
  assert.equal(E.creativeCounts({}).known, false);
  const stale = E.creativeCounts({ facts: { active_ads: 2, live_creatives: 2, live_unknown: true } });
  assert.equal(stale.active, null, 'delivery that cannot be judged is not shown as a number');
});

test('funnel breakdown: each funnel is its own row; a funnel without an approved benchmark shows Unrated, never underperforming', () => {
  const rows = E.funnelBreakdown({ creatives: [
    { funnel: 'MOF', condition: 'performing' }, { funnel: 'MOF', condition: 'underperforming' }, { funnel: 'TOF', condition: 'missing_benchmark' }, { funnel: 'TOF', condition: 'missing_benchmark' },
    { funnel: 'TOM', condition: 'new' }, { funnel: null, condition: 'fatigued' }, { funnel: 'MOF', condition: null },
  ] });
  assert.deepEqual(rows.map((r) => r.funnel), ['TOF', 'TOM', 'MOF', 'unknown'], 'TOF, TOM, MOF, then anything unidentified');
  const tof = rows.find((r) => r.funnel === 'TOF'); assert.deepEqual([tof.total, tof.unrated, tof.underperforming, tof.effective], [2, 2, 0, 0]);
  const mof = rows.find((r) => r.funnel === 'MOF'); assert.deepEqual([mof.total, mof.effective, mof.underperforming], [2, 1, 1], 'a creative the engine did not assess is left out');
  assert.equal(rows.find((r) => r.funnel === 'TOM').testing, 1);
  assert.deepEqual(E.funnelBreakdown({}), []);
});

test('creative gap badge: the engine\'s own status, with testing neutral and adequate coverage green', () => {
  const needs = (type, extra = {}) => ({ status: 'act', actionable: true, priority: 'High', gap: { type }, opportunity_type: type, facts: { demand_level: 'strong', unique_creatives: 2, performing: 0, weak: 2, ...extra }, mode: 'core' });
  const none = E.coreGap(needs('confirmed_gap'));
  assert.deepEqual([none.label, none.tone], ['No Active Creative', 'red']);
  assert.match(none.text, /no ads currently running/);
  const under = E.coreGap(needs('underperforming'));
  assert.deepEqual([under.label, under.tone], ['Underperforming Creative', 'red']);
  assert.match(under.text, /None of 2 creatives are performing\./);
  assert.deepEqual([E.coreGap(needs('thin', { unique_creatives: 1, performing: 1, weak: 0 })).label, E.coreGap(needs('thin', { unique_creatives: 1, performing: 1, weak: 0 })).tone], ['Low Creative Coverage', 'amber']);
  assert.deepEqual([E.coreGap(needs('stale')).label, E.coreGap(needs('stale')).tone], ['Old Creative', 'amber']);
  const testing = E.coreGap({ status: 'testing', facts: { testing: 1, creative_conditions: { new: 1 } } });
  assert.deepEqual([testing.label, testing.tone], ['Testing / Monitoring', 'neutral']);
  const covered = E.coreGap({ status: 'covered', facts: { performing: 3, unique_creatives: 3 } }, { min_performing_creatives: 3 });
  assert.deepEqual([covered.label, covered.tone], ['Adequate Coverage', 'green']);
  const review = E.coreGap({ status: 'insufficient_data', needs_review: true, review_reason: 'missing_benchmark', facts: { unrated_funnels: ['TOF'] } });
  assert.equal(review.tone, 'neutral', 'missing data is neutral, not a problem colour');
  assert.match(review.text, /No approved TOF benchmark/);
});

test('the table: no ranking column, Creative Coverage and Creative Gap, Priority only where the page ranks', () => {
  const head = fn(pl, 'plCoreHeadHtml');
  assert.doesNotMatch(head, /pt-w-rank|'#'/);
  assert.match(head, /Creative Coverage/); assert.match(head, /prio \? 'Creative Gap' : 'Creative Status'/); assert.match(head, /\$\{prio \? th\('Priority'/);
  const row = fn(pl, 'plCoreRowHtml');
  assert.doesNotMatch(row, /pt-rank/);
  assert.match(row, /plCoreCoverageCell\(it\)[\s\S]*plCoreStatusCell\(it\)[\s\S]*plCoreActionCell\(it, mode\)/);
  assert.match(fn(pl, 'plCoreStatusCell'), /PE\.coreGap\(it, plCfg\(\)\)/);
  assert.match(fn(pl, 'plCoreCoverageCell'), /PE\.creativeCounts\(it\)/);
  assert.doesNotMatch(css.slice(css.indexOf('Core Planning redesign (v1.4.7)')), /tr\.pt-row[^{]*\{[^}]*background:\s*#(fd|ff|e8)/, 'no tinted rows');
});

test('Creative Opportunities and the Core Catalogue are ONE selection state: adding from either re-renders both', () => {
  assert.match(fn(pl, 'plRefreshSelection'), /renderCoreShootPlanning/, 'the catalogue is re-rendered after a selection changes');
  assert.match(fn(pl, 'plRefreshSelection'), /plRenderCore, plRenderHighStocks/);
  assert.match(pl, /const plRerender = \(mode\) => \{[^}]*mode === 'cat'/, 'row expansion in the catalogue re-renders the catalogue');
  // both views decide Added / Add from the same function and the same state.shootPlan
  const add = fn(pl, 'plCoreAddBtn'); assert.match(add, /plInThisWeeksPlan\(it\)/);
  assert.match(fn(pl, 'plInThisWeeksPlan'), /plSelected\(\)/);
  assert.match(fn(pl, 'plSelectedByCategory'), /plSelected\(\)/, 'the category count reads the same selection');
  // a Core product the engine will not recommend can still be chosen by hand, through the existing form
  assert.match(add, /shootThisWeekForCore/);
  assert.match(fn(pl, 'plCatFallbackRow'), /shootThisWeekForCore/);
  assert.doesNotMatch(pl, /Not recommended|not_recommended/, 'no "Not recommended" wording');
});

test('the Core Catalogue: category summary, same product table, month-by-month detail moved inside the category', () => {
  const cat = fn(pl, 'plCatalogueHtml');
  for (const h of ['Category', '7D Sales', 'Sales Trend', 'MTD vs LY', 'Creative Attention', 'Selected This Week']) assert.ok(cat.includes(`<span>${h}</span>`) || cat.includes(`>${h}</span>`), h);
  assert.doesNotMatch(cat, /core-cadence|Creative Freshness/, 'no four monthly boxes and no freshness column on the category row');
  assert.match(cat, /plCatMonthsHtml\(c\.name, trend\)/, 'the months live in the expanded category');
  assert.match(fn(pl, 'plCatMonthsHtml'), /<details class="pl-cat-months"/, 'as a secondary disclosure');
  assert.match(fn(pl, 'plCatProductsHtml'), /plCoreHeadHtml\('cat'/);
  assert.match(fn(app, 'renderCoreShootPlanning'), /plCatalogueHtml\(\)/);
  assert.match(html, /id="core-catalogue-subtitle"/); assert.doesNotMatch(html, /core-shoot-category-header/);
  assert.match(fn(pl, 'plCatAttentionHtml'), /All covered/);
});

test('the compact Shoot Plan strip: the large banner styling is gone', () => {
  const tail = css.slice(css.indexOf('Core Planning redesign (v1.4.7)'));
  assert.match(tail, /\.pl-tray\{padding:6px 10px 6px 12px;/); assert.match(tail, /\.pl-tray-item\{display:inline-flex;flex-direction:row/);
  assert.doesNotMatch(css, /\.pl-tray\{padding:14px 18px 14px 20px/); assert.doesNotMatch(css, /\.pl-tray-th,\.pl-tray-more\{width:64px/);
  assert.match(fn(pl, 'plTrayThumb'), /plPlural\(cws, 'colourway'\)/, 'expanded strip: colourways and concepts of each selected product');
});
