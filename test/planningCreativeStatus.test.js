'use strict';
// Batch 32: the short coloured CREATIVE STATUS shown in the redesigned Core / High Stocks table. Pure wording over the engine's output: nothing is recalculated.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const E = require('../public/planningExplain');

const needs = (type, facts = {}, extra = {}) => ({ actionable: true, status: 'act', opportunity_type: type, gap: { type }, facts: { demand_level: 'strong', ...facts }, ...extra });
const CFG = { min_performing_creatives: 3 };
const st = (it) => E.creativeStatus(it, CFG);

test('creative status (Needs): each gap type gets a short label, a tone and one sentence', () => {
  assert.deepEqual(st(needs('confirmed_gap')), { label: 'No Active Ads Identified', tone: 'red', text: 'Selling strongly, but no active ads found.' });
  assert.equal(st(needs('confirmed_gap', { demand_level: 'steady' })).text, 'Consistent sales, but no active ads found.');
  assert.equal(st(needs('confirmed_gap', { demand_level: 'weak' })).text, 'Selling slowly, but no active ads found.');
  assert.deepEqual([st(needs('underperforming', { weak: 2, performing: 0 })).label, st(needs('underperforming', { weak: 2 })).tone], ['Underperforming Creative', 'red']);
  assert.match(st(needs('underperforming', { weak: 2, performing: 1 })).text, /2 creatives above the approved CPA limit\. Only 1 performing\./);
  assert.equal(st(needs('fatigue', { declining: 2, performing: 1 })).label, 'Creative Fatigue');
  const conc = st(needs('concentration', { top_creative_spend_share: 91 }));
  assert.deepEqual([conc.label, conc.tone, conc.text], ['Concentrated Delivery', 'amber', '91% of ad spend is on one creative.']);
  assert.equal(st(needs('diversity', { distinct_concepts: 1 })).label, 'Low Concept Variety');
  assert.equal(st(needs('stale')).label, 'Old Creative');
  const thin = st(needs('thin', { creatives_in_play: 1 }, { gap: { type: 'thin', single: true } }));
  assert.deepEqual([thin.label, thin.tone], ['Low Creative Coverage', 'amber']);
  assert.match(thin.text, /single creative/);
});

test('creative status (Covered): in production / early testing are amber, healthy coverage is green', () => {
  const cov = (o) => ({ actionable: false, status: 'covered', facts: {}, ...o });
  assert.deepEqual([st(cov({ status: 'in_production' })).label, st(cov({ status: 'in_production' })).tone], ['In Production', 'amber']);
  const t = st(cov({ status: 'testing', facts: { testing: 2 } }));
  assert.deepEqual([t.label, t.tone], ['Early Testing', 'amber']); assert.match(t.text, /2 new creatives were recently launched/);
  const good = st(cov({ facts: { performing: 3, unique_creatives: 4 } }));
  assert.deepEqual([good.label, good.tone], ['Performing Well', 'green']); assert.match(good.text, /3 effective creatives currently running/);
  const ok = st(cov({ facts: { performing: 1, unique_creatives: 3 } }));
  assert.deepEqual([ok.label, ok.tone], ['Adequately Covered', 'green']);
});

test('creative status (Needs Review): grey, labelled by the reason the engine gave', () => {
  const rev = (reason, facts = {}) => st({ actionable: false, status: 'insufficient_data', needs_review: true, review_reason: reason, facts });
  const cases = { uncertain_matching: 'Matching Uncertain', unidentified_ads: 'Ads Not Identified', missing_benchmark: 'Benchmark Missing', insufficient_delivery: 'Insufficient Delivery', not_delivering: 'Not Delivering', no_meta_data: 'Meta Data Unavailable', other: 'Insufficient Data' };
  for (const [reason, label] of Object.entries(cases)) { const r = rev(reason, { matching_pending: 3 }); assert.equal(r.label, label); assert.equal(r.tone, 'grey'); assert.ok(r.text.length < 120, 'one short sentence'); }
});

test('creative status: it only re-words the engine output (no recalculation of status, priority or counts)', () => {
  const it = needs('confirmed_gap'); const copy = JSON.parse(JSON.stringify(it));
  st(it); assert.deepEqual(it, copy, 'the engine item is not mutated');
});

test('redesign wiring: row cells, planned state, weekly goal strip and the three-section expanded panel', () => {
  const pl = fs.readFileSync(path.join(__dirname, '..', 'public', 'planning.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(pl, /plStatusCell\(it\)/); assert.match(pl, /plMetricsCell\(it\)/); assert.match(pl, /plActionCell\(it, mode\)/);
  assert.match(pl, /pl-act-planned/, 'a selected product shows a planned state');
  assert.match(pl, /pl-week-goal/); assert.match(pl, /Weekly creative goal/); assert.match(pl, /View Shoot Plan/);
  for (const t of ['Why was this product recommended\\?', 'Recent live ads', 'Additional details']) assert.match(pl, new RegExp(t));
  assert.equal((pl.match(/<details class="pl-x-d"/g) || []).length >= 3, true, 'three collapsible evidence sections');
  for (const tone of ['red', 'amber', 'green', 'grey']) assert.match(css, new RegExp(`\\.pl-status\\[data-tone="${tone}"\\]`), `${tone} tone styled`);
});
