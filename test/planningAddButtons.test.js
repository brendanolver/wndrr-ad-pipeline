'use strict';
// Batch 31: + Add on every product row (Needs creative, Covered / monitoring, Needs review), manual planning that never silently bypasses a stock restriction,
// and concise main-table assessments with the detail kept in the expanded row. Static wiring checks + the real wording code; the browser journey and the database writes run in the QA scripts.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const opp = require('../src/lib/planningOpportunities');
const E = require('../public/planningExplain');
const { CFG, TODAY, day, cr, salesOf, base } = require('./_planningFixtures');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const pl = read('public/planning.js'); const app = read('public/app.js'); const css = read('public/styles.css');
const run = (p) => opp.evaluate(p, CFG, TODAY, 'core');
const cov = (n) => ({ known: true, active_ads: n, possible: 0, unresolved: 0, unresolved_share_pct: 0, uncertain: false, min: 5 });
const v = (k, s, o = {}) => ({ ...cr(k, s, { age: o.age === undefined ? 120 : o.age }), first_delivery: day(o.age === undefined ? 120 : o.age), first_delivery_truncated: false, last_delivery: day(1), ...o });

test('add: the Action column (+ Add) is in every category; Priority only in Needs creative', () => {
  const table = pl.slice(pl.indexOf('function plTableHtml'), pl.indexOf('const PL_EMPTY'));
  assert.match(table, /const showPrio = cat === 'needs'/);
  assert.match(table, /th\('Product'[\s\S]*th\('Key metrics'[\s\S]*th\('Creative status'[\s\S]*showPrio \? th\('Priority'[\s\S]*th\('Action'/, 'Product | Key metrics | Creative status | Priority (Needs only) | Action');
  assert.match(pl, /priority: \{[^}]*only: 'needs'/, 'the Priority sort is offered only in Needs creative');
  const act = pl.slice(pl.indexOf('function plActionCell'), pl.indexOf('// sorting'));
  assert.match(act, /cat === 'needs'[\s\S]*pl-act-add[\s\S]*data-opp-add/, 'Needs: the primary + Add to Shoot Plan button');
  assert.match(act, /cat !== 'needs' \? `<button type="button" role="menuitem" data-opp-add/, 'Covered / Needs Review: the same add is one tap away in the row menu');
  assert.match(act, /pl-act-view[\s\S]*data-opp-toggle/, 'Covered / Needs Review show a subtle View / Review action');
});
test('add: one primary button in the purple accent, never disabled because something is in production', () => {
  const cell = pl.slice(pl.indexOf('function plActionCell'), pl.indexOf('// sorting'));
  assert.match(cell, /class="btn btn-sm pl-act pl-act-add"/);
  assert.doesNotMatch(cell.replace(/\/\/.*$/gm, ''), /disabled/, 'the button is never disabled');
  assert.doesNotMatch(cell.replace(/\/\/.*$/gm, ''), /production|prod\./, 'in-production status plays no part in showing the button (it has its own indicator)');
  assert.match(css, /\.pl-act-add\s*\{[^}]*var\(--accent-strong\)/, 'Batch 32: the Add action uses the purple accent');
  const plan = pl.slice(pl.indexOf('async function plPlan'), pl.indexOf('\n}\n', pl.indexOf('async function plPlan')));
  assert.doesNotMatch(plan, /confirmDialog/, 'no confirmation gate in front of a manual add; the modal explains instead');
  assert.match(plan, /additional/); assert.match(plan, /notes:/);
  assert.match(pl, /const quick = ev\.target\.closest\('\[data-opp-add\]'\)/);
});
test('add: manual planning never silently bypasses a stock restriction', () => {
  assert.match(app, /data-restricted="\$\{escapeHtml\(c\.restriction/, 'restricted colourways are marked with their reason');
  assert.match(app, /async function onShootPlanColourToggle/);
  assert.match(app, /Include it in this shoot anyway\?/); assert.match(app, /okLabel: 'Include anyway'/);
  assert.match(app, /if \(checked && el\.dataset\.restricted\) return;/, 'Select All never ticks a restricted colourway');
  assert.match(app, /checkbox\.dataset\.restricted && !checkbox\.dataset\.override/, 'a restricted colourway that was not explicitly confirmed blocks the save');
  assert.match(app, /return c\.viable !== false;/, 'preselection skips restricted colourways');
  assert.match(app, /plShootPlanWarning\(item\)/, 'the existing stock and sizing warnings on the Shoot Plan stay');
});
test('add: the same existing workflow: concept chooser, many colourways, an extra concept goes onto the existing record', () => {
  assert.match(app, /payload\.concept_type = conceptSel\.value/); assert.match(app, /payload\.additional = true/);
  const route = read('src/routes/shootPlan.js');
  assert.match(route, /const wantTotal = additional \? haveNow \+ requestedVideos : requestedVideos/);
  assert.match(route, /DEDUPE_SOURCES = \[null, undefined, 'core', 'high_stock', 'manual', 'momentum'\]/, 'promotions and drops are never merged into a product record');
});

// ── concise assessments ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const sentences = (t) => (t.match(/[^.]+\./g) || []).length;
test('assessment: covered product, one or two short sentences, no counts, funnels or dates', () => {
  const reaper = run(base({ sales: salesOf(164, { units7: 38, units14: 76 }), coverage: cov(9), creatives: [v('a', 'performing', { age: 90, funnel: 'MOF' }), v('b', 'performing', { age: 80, funnel: 'MOF' }), v('c', 'performing', { age: 75, funnel: 'MOF' }), v('x', 'underperforming', { age: 70, severity: 'clear', funnel: 'MOF' }), v('d', 'unrated', { age: 60, funnel: 'TOF' }), v('e', 'unrated', { age: 55, funnel: 'TOF' }), v('f', 'insufficient', { age: 40, spend: 10 }), v('g', 'insufficient', { age: 30, spend: 10 }), v('h', 'insufficient', { age: 2, spend: 8 })] }));
  assert.equal(reaper.status, 'covered');
  const t = E.reasonFor(reaper, CFG);
  assert.equal(t, 'Existing creative coverage is sufficient for now. 3 creatives are performing, with others still being assessed.');
  assert.ok(sentences(t) <= 2 && t.length < 130);
  assert.doesNotMatch(t, /\d+ unique creatives|TOF|benchmark|early testing|insufficient|\d{4}/);
  // the detail is kept for the expanded row
  const detail = E.conditionsSummary(reaper);
  assert.match(detail, /9 unique creatives/); assert.match(detail, /3 performing against the approved benchmark/); assert.match(detail, /1 over the approved limit/); assert.match(detail, /with no approved TOF benchmark/); assert.match(detail, /insufficient delivery/); assert.match(detail, /in early testing/);
  assert.ok(pl.includes('plLiveAdsHtml(it)') && pl.includes('Creative picture:'), 'the expanded row shows the creative picture and the live ads table (funnels, delivery dates, performance)');
});
test('assessment: early testing, uploads and review reasons stay short; missing benchmarks are never read as underperformance', () => {
  const enough = run(base({ sales: salesOf(150, { units7: 40, units14: 75 }), coverage: cov(4), creatives: [v('a', 'performing', { age: 90 }), v('b', 'performing', { age: 80 }), v('c', 'insufficient', { age: 2, spend: 10 }), v('d', 'underperforming', { age: 100, severity: 'clear' })] }));
  assert.equal(enough.status, 'testing');
  assert.equal(E.reasonFor(enough, CFG), 'Existing creative is enough for now while a new creative is in early testing.');
  const review = run(base({ sales: salesOf(150, { units7: 40, units14: 75 }), coverage: cov(2), creatives: [v('a', 'insufficient', { age: 30, spend: 10 }), v('b', 'insufficient', { age: 40, spend: 5 })] }));
  assert.equal(E.reasonFor(review, CFG), 'Insufficient delivery: the live creatives have not spent enough to assess.');
  const unrated = run(base({ sales: salesOf(150, { units7: 40, units14: 75 }), coverage: cov(3), creatives: ['a', 'b', 'c'].map((k, i) => ({ ...v(k, 'unrated', { age: 90 - i }), funnel: 'TOF' })) }));
  assert.doesNotMatch(E.reasonFor(unrated, CFG) + unrated.reason, /underperform|over the approved/i);
  const needs = run(base({ sales: salesOf(150, { units7: 40, units14: 75 }), coverage: cov(0), creatives: [] }));
  assert.ok(sentences(E.reasonFor(needs, CFG)) <= 2);
});
