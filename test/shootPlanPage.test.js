'use strict';
// Planning > Shoot Plan: a simple operational hand-off. Which products, who shoots them, which samples the warehouse pulls. No concept development on the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const app = read('public', 'app.js'); const html = read('public', 'index.html'); const css = read('public', 'styles.css'); const schema = read('db', 'schema.sql'); const route = read('src', 'routes', 'shootPlan.js');

// the pure helpers, straight from the shipped file
const block = app.slice(app.indexOf('// <shoot-plan-pure>'), app.indexOf('// </shoot-plan-pure>'));
const ctx = {}; vm.createContext(ctx);
vm.runInContext(`${block}; this.api = { shootPlanPlural, shootPlanSamples, shootPlanStats, shootPlanReadiness };`, ctx);
const { shootPlanSamples, shootPlanStats, shootPlanReadiness } = ctx.api;
const j = (v) => JSON.parse(JSON.stringify(v)); // values built inside the vm are from another realm
const style = (code, size = 'M', label = code) => ({ style_id: 1, style_code: code, size, colour_label: label });
const item = (o = {}) => ({ id: 1, product_code: 'P1', stock_status: 'needs_to_be_brought_in', creator: 'Mark', styles: [style('A'), style('B')], ...o });
const opp = (cws) => ({ colourways: cws });

test('summary counts come from the week\'s records: unique products, samples (one per colourway being brought in), assignments', () => {
  const items = [item({ product_code: 'P1', styles: [style('A'), style('B'), style('C'), style('D')] }), item({ id: 2, product_code: 'P2', styles: [style('E'), style('F')] }),
    item({ id: 3, product_code: 'P3', stock_status: 'in_office', styles: [style('G')] }), item({ id: 4, product_code: 'P1', styles: [style('H')] }), item({ id: 5, product_code: 'P4', creator: ' ', styles: [] })];
  assert.deepEqual(j(shootPlanStats(items)), { products: 4, samples: 4 + 2 + 0 + 1 + 0, assigned: 4 });
  assert.equal(shootPlanSamples(items[2]), 0, 'a sample already in the office is not pulled');
  assert.deepEqual(j(shootPlanStats([])), { products: 0, samples: 0, assigned: 0 });
});

test('sample readiness: stock available (green), N samples needed (amber: no stock or no size), not confirmed (grey); never claims a sample has been picked', () => {
  const full = opp([{ style_code: 'A', soh: 12, viable: true }, { style_code: 'B', soh: 5, viable: true }]);
  let r = shootPlanReadiness(item(), full); assert.equal(r.tone, 'green'); assert.equal(r.text, 'Stock available'); assert.match(r.title, /does not confirm the samples have been picked/);
  r = shootPlanReadiness(item(), opp([{ style_code: 'A', soh: 12, viable: true }, { style_code: 'B', soh: 0, viable: false, restriction: 'No stock available.' }]));
  assert.equal(r.tone, 'amber'); assert.equal(r.text, '1 sample needed'); assert.match(r.title, /B: No stock available/);
  r = shootPlanReadiness(item({ styles: [style('A', null), style('B', '')] }), full); assert.equal(r.text, '2 samples needed'); assert.match(r.title, /size not chosen/);
  r = shootPlanReadiness(item(), null); assert.equal(r.tone, 'grey'); assert.equal(r.text, 'Availability not confirmed');
  r = shootPlanReadiness(item(), opp([{ style_code: 'A', soh: 3, viable: true }])); assert.equal(r.tone, 'grey', 'one colourway cannot be checked');
  r = shootPlanReadiness(item({ stock_status: 'in_office' }), null); assert.equal(r.tone, 'green'); assert.equal(r.text, 'Samples in office');
  r = shootPlanReadiness(item({ styles: [] }), full); assert.equal(r.tone, 'grey'); assert.equal(r.text, 'No colourways selected');
});

test('the page has no concept development: no concept counts, names, Manage / Open concept, + Concept, creation or editing', () => {
  const page = app.slice(app.indexOf('function shootPlanTileHtml('), app.indexOf('// Formats a confirmation timestamp'));
  for (const gone of ['sp2-concepts', 'plConceptsFor', 'Manage concepts', 'Open concept', '+ Concept', 'plAddConcepts', 'plOpenConceptFromShootPlan', 'wpShootPlanVideosHtml', 'conceptProgress', 'concept_type']) assert.ok(!page.includes(gone), gone);
  assert.ok(!/concept/i.test(html.slice(html.indexOf('id="planning-step-shoot-plan"'), html.indexOf('id="planning-step-shoot-plan"') + 700)), 'no concept wording in the page markup');
  assert.ok(!/Concept Development/.test(html.slice(html.indexOf('id="shoot-plan-actions"'), html.indexOf('id="shoot-plan-actions"') + 900)), 'the header no longer says "Sent to Concept Development"');
  assert.match(app, /toast\(impact\.message \|\| `\$\{name\} has work in progress/, 'a blocked removal explains itself instead of opening a concept');
});

test('header: Confirm Shoot Plan; once confirmed a compact line with the date and Edit plan; a confirmed plan is locked until Edit plan', () => {
  assert.match(html, /onclick="openShootPlanConfirm\(\)">Confirm Shoot Plan &rarr;<\/button>/); assert.ok(!html.includes('Confirm &amp; Send'));
  assert.match(html, /Shoot Plan confirmed &middot; <span id="shoot-plan-confirmed-timestamp">/); assert.match(html, /id="shoot-plan-edit-btn" onclick="toggleShootPlanEditing\(\)">Edit plan/);
  assert.match(app, /const shootPlanLocked = \(\) => state\.planningWeekOffset < 0 \|\| \(!!state\.weeklyShootPlanConfirmation && !shootPlanEditingThisWeek\(\)\);/);
  const fn = app.slice(app.indexOf('async function confirmWeeklyShootPlan('), app.indexOf("// Mirrors the Mystery Box Builder's"));
  assert.match(fn, /api\('\/weekly-shoot-plan-confirmation', \{\s*method: 'POST'/, 'the existing confirmation route (downstream integrations unchanged)');
  assert.ok(!/concept/i.test(fn.replace(/Concept Development/g, '')), 'confirming needs no concept');
  const warn = app.slice(app.indexOf('function shootPlanConfirmWarnings('), app.indexOf('function openShootPlanConfirm('));
  assert.ok(!/concept/i.test(warn), 'warnings are about colourways, sizes and stock only');
});

test('summary bar + CSV: ApparelMagic Sample Pick List in the same bar, same export and fields', () => {
  assert.match(app, /ApparelMagic Sample Pick List/); assert.match(app, /Export selected products and colourways for the warehouse\./); assert.match(app, /Download CSV &darr;/);
  assert.match(app, /Products selected[\s\S]*Samples required[\s\S]*Shoot assignments/);
  assert.match(app, /const headers = \['customer_po', 'customer_name', 'sku_alt', 'qty', 'date_due', 'date', 'unit_price', 'date_start'\];/);
  assert.match(app, /onclick="downloadApparelMagicCsv\(\)"\$\{st\.samples \? '' : ' disabled'\}/);
});

test('cards: owner dropdown from the existing creators, colourway editor on the existing routes, notes collapsed, subtle X (plan only)', () => {
  assert.match(app, /\(state\.contentCreators \|\| \[\]\)\.map\(\(c\) => c\.name\)/);
  assert.match(app, /<details class="sp3-notes" data-sp-notes="\$\{item\.id\}"\$\{shootPlanNotesOpen\.has\(item\.id\) \? ' open' : ''\}>/, 'collapsed unless the person opened it');
  assert.match(app, /Shoot notes \(optional\)/); assert.match(app, /maxlength="1000"/);
  const ed = app.slice(app.indexOf('async function saveShootPlanColours('), app.indexOf('// Formats a confirmation timestamp'));
  assert.match(ed, /\/styles\/\$\{sid\}`, \{ method: 'DELETE'/); assert.match(ed, /\/styles`, \{ method: 'POST'/); assert.match(ed, /method: 'PATCH', body: JSON\.stringify\(\{ size \}\)/);
  const open = app.slice(app.indexOf('async function openShootPlanColoursModal('), app.indexOf('async function saveShootPlanColours('));
  assert.match(open, /\/opportunities\/prepare-shoot/, 'the same colourway list and stock rules Planning uses');
  assert.ok(!/checked.*viable|viable.*checked/.test(open.replace(/const checked = !!cur;/, '')), 'a colourway is only ticked if it is already in the plan');
  assert.match(app, /removeShootPlanItem\(\$\{item\.id\}\)/, 'X uses the existing removal (plan only, product untouched)');
  assert.match(css, /\.sp3-grid\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\);gap:16px;/); assert.match(css, /@media \(max-width:680px\)\{\.sp3-grid\{grid-template-columns:minmax\(0,1fr\)/);
});

test('backend: shoot_notes is an additive column; one PATCH saves owner and/or notes; past weeks are read-only; concept data is never touched', () => {
  assert.match(schema, /ALTER TABLE shoot_plan_items ADD COLUMN IF NOT EXISTS shoot_notes TEXT;/);
  assert.match(route, /shoot_notes: i\.shoot_notes \|\| null,/);
  const fn = route.slice(route.indexOf("router.patch('/:id', async"), route.indexOf("// Change how many VIDEOS"));
  assert.match(fn, /hasCreator[\s\S]*hasNotes/); assert.match(fn, /A past week is a read-only record\./); assert.match(route, /const SHOOT_NOTES_MAX = 1000;/);
  assert.ok(!/creative_assets|initial_idea/.test(fn), 'nothing about concepts');
});
