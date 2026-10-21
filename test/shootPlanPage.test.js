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
vm.runInContext(`${block}; this.api = { shootPlanPlural, shootPlanSamples, shootPlanToRequest, shootPlanStats, shootPlanReadiness, shootPlanDefaultSize, shootPlanSizeQty, shootPlanSamplesSummary, shootPlanCreatorSize };`, ctx);
const { shootPlanSamples, shootPlanToRequest, shootPlanStats, shootPlanReadiness, shootPlanDefaultSize, shootPlanSamplesSummary, shootPlanCreatorSize } = ctx.api;
const j = (v) => JSON.parse(JSON.stringify(v)); // values built inside the vm are from another realm
const style = (code, size = 'M', label = code, in_office = false) => ({ style_id: 1, style_code: code, size, colour_label: label, in_office });
const item = (o = {}) => ({ id: 1, product_code: 'P1', stock_status: 'needs_to_be_brought_in', creator: 'Mark', styles: [style('A'), style('B')], ...o });
const opp = (cws) => ({ colourways: cws });

test('summary counts come from the week\'s records: unique products, samples selected, samples to request (not in the office), assignments', () => {
  const items = [item({ product_code: 'P1', styles: [style('A'), style('B'), style('C'), style('D')] }), item({ id: 2, product_code: 'P2', styles: [style('E'), style('F', 'M', 'F', true)] }),
    item({ id: 3, product_code: 'P3', styles: [style('G', 'M', 'G', true)] }), item({ id: 4, product_code: 'P1', styles: [style('H')] }), item({ id: 5, product_code: 'P4', creator: ' ', styles: [] })];
  assert.deepEqual(j(shootPlanStats(items)), { products: 4, samples: 4 + 2 + 1 + 1, toRequest: 4 + 1 + 0 + 1, assigned: 4 });
  assert.equal(shootPlanSamples(items[2]), 1, 'a sample already in the office still counts towards the shoot');
  assert.equal(shootPlanToRequest(items[2]), 0, 'but it is not requested from the warehouse');
  assert.deepEqual(j(shootPlanStats([])), { products: 0, samples: 0, toRequest: 0, assigned: 0 });
});

test('dialog: the assigned person\'s own size is used when set and in stock, else the usual default; the creator sizes come from Settings > Shoot Prep', () => {
  const c = (o) => ({ sizes: ['XS', 'S', 'M', 'L'], ...o });
  const sami = { default_top_size: 'L', default_bottom_alpha_size: 'L', default_bottom_waist_size: '34' };
  assert.equal(shootPlanCreatorSize(sami, 'top', 'alpha'), 'L'); assert.equal(shootPlanCreatorSize(sami, 'bottom', 'waist'), '34'); assert.equal(shootPlanCreatorSize(sami, 'bottom', 'alpha'), 'L');
  assert.equal(shootPlanCreatorSize({}, 'top'), '', 'no size set'); assert.equal(shootPlanCreatorSize(sami, null), '', 'unknown garment shape');
  assert.equal(shootPlanDefaultSize(c({}), () => 'M', 'L'), 'L');
  assert.equal(shootPlanDefaultSize(c({ size_stock: { XS: 1, S: 5, M: 1, L: 0 } }), () => 'M', 'L'), 'S', 'their size is out of stock: the usual default');
  assert.equal(shootPlanDefaultSize(c({}), () => 'M', 'XXL'), 'S', 'a size the colourway does not have is ignored');
  assert.equal(shootPlanDefaultSize(c({}), () => 'M', ''), 'S', 'no person size: S as before');
});

test('dialog: Assigned to dropdown (defaults to the current owner); changing it re-applies their sizes to sizes not set by hand; saved with the samples in one request', () => {
  assert.match(html, /<select id="shoot-plan-samples-owner" class="sp4-owner-sel">/);
  const open = app.slice(app.indexOf('async function openShootPlanSamplesModal('), app.indexOf('function shootPlanSamplesOwnerChanged('));
  assert.match(open, /const owner = item\.creator \|\|/, 'defaults to the card\'s current owner');
  const chg = app.slice(app.indexOf('function shootPlanSamplesOwnerChanged('), app.indexOf('function shootPlanSamplesRender('));
  assert.match(chg, /if \(!r\.touched\)/, 'sizes chosen by hand are kept'); assert.ok(!/api\(/.test(chg), 'nothing is saved until Save Samples');
  assert.match(app, /\.\.\.\(ctx\.owner && ctx\.owner !== ctx\.item\.creator \? \{ creator: ctx\.owner \} : \{\}\), samples:/);
  assert.match(route, /UPDATE shoot_plan_items SET creator = \$2 WHERE id = \$1/);
});

test('dialog: size defaults to S when it has stock, never to an out-of-stock size; footer counts only ticked rows', () => {
  const c = (o) => ({ sizes: ['XS', 'S', 'M', 'L'], ...o });
  assert.equal(shootPlanDefaultSize(c({}), () => 'M'), 'S', 'S, stock by size unknown');
  assert.equal(shootPlanDefaultSize(c({ size_stock: { XS: 4, S: 9, M: 2, L: 0 } }), () => 'M'), 'S');
  assert.equal(shootPlanDefaultSize(c({ size_stock: { XS: 4, S: 0, M: 2, L: 0 } }), () => 'M'), 'XS', 'S is out, so the first size with stock');
  assert.equal(shootPlanDefaultSize({ sizes: ['8', '10'] }, () => '10'), '10', 'sizing systems with no S use the existing garment default');
  assert.deepEqual(j(shootPlanSamplesSummary([{ checked: true, inOffice: false }, { checked: true, inOffice: true }, { checked: false, inOffice: true }, { checked: true, inOffice: false }])), { samples: 3, toRequest: 2, inOffice: 1 });
});

test('sample readiness: Ready to Shoot (green: stock available or in office), a stock warning (amber: out of stock or no size), not confirmed (grey); never claims a sample has been picked', () => {
  const full = opp([{ style_code: 'A', soh: 12, viable: true }, { style_code: 'B', soh: 5, viable: true }]);
  let r = shootPlanReadiness(item(), full); assert.equal(r.tone, 'green'); assert.equal(r.text, 'Ready to Shoot'); assert.match(r.title, /does not confirm the samples have been picked/);
  r = shootPlanReadiness(item(), opp([{ style_code: 'A', soh: 12, viable: true }, { style_code: 'B', soh: 0, viable: false, restriction: 'No stock available.' }]));
  assert.equal(r.tone, 'amber'); assert.equal(r.text, '1 out of stock'); assert.match(r.title, /B: No stock available/);
  r = shootPlanReadiness(item({ styles: [style('A', null), style('B', '')] }), full); assert.equal(r.text, 'Size needed'); assert.match(r.title, /size not chosen/);
  r = shootPlanReadiness(item({ styles: [style('A', ''), style('B')] }), opp([{ style_code: 'A', soh: 4, viable: true }, { style_code: 'B', soh: 0, viable: false }])); assert.equal(r.text, 'Check stock and sizes');
  r = shootPlanReadiness(item(), null); assert.equal(r.tone, 'grey'); assert.equal(r.text, 'Availability not confirmed');
  r = shootPlanReadiness(item(), opp([{ style_code: 'A', soh: 3, viable: true }])); assert.equal(r.tone, 'grey', 'one colourway cannot be checked');
  r = shootPlanReadiness(item({ styles: [style('A', 'M', 'A', true), style('B', 'M', 'B', true)] }), null); assert.equal(r.tone, 'green'); assert.equal(r.text, 'Ready to Shoot');
  r = shootPlanReadiness(item({ styles: [style('A', 'M', 'A', true), style('B')] }), opp([{ style_code: 'B', soh: 5, viable: true }])); assert.equal(r.text, 'Ready to Shoot', 'in-office samples are not checked against stock');
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

test('summary bar + CSV: Warehouse Pick List in the same bar, same export and fields', () => {
  assert.match(app, /Warehouse Pick List/); assert.match(app, /Samples to send from the warehouse to the office\./); assert.match(app, /Export CSV &darr;/); assert.ok(!/ApparelMagic Sample Pick List/.test(app));
  assert.match(app, /Products to Shoot[\s\S]*Samples Needed[\s\S]*Warehouse Requests[\s\S]*Shoot Assignments/);
  assert.match(app, /const headers = \['customer_po', 'customer_name', 'sku_alt', 'qty', 'date_due', 'date', 'unit_price', 'date_start'\];/);
  assert.match(app, /onclick="downloadApparelMagicCsv\(\)"\$\{st\.toRequest \? '' : ' disabled'\}/);
});

test('cards: owner dropdown from the existing creators, colourway editor on the existing routes, notes collapsed, subtle X (plan only)', () => {
  assert.match(app, /\(state\.contentCreators \|\| \[\]\)\.map\(\(c\) => c\.name\)/);
  assert.match(app, /<details class="sp3-notes" data-sp-notes="\$\{item\.id\}"\$\{shootPlanNotesOpen\.has\(item\.id\) \? ' open' : ''\}>/, 'collapsed unless the person opened it');
  assert.match(app, /<span>Shoot Notes<\/span>/); assert.match(app, /<span class="sp3-label">Assigned to<\/span>/); assert.match(app, /maxlength="1000"/);
  const open = app.slice(app.indexOf('async function openShootPlanSamplesModal('), app.indexOf('function shootPlanSamplesRender('));
  assert.match(open, /\/opportunities\/prepare-shoot/, 'the same colourway list and stock rules Planning uses');
  assert.match(open, /inOffice: !!\(cur && cur\.in_office\)/, 'a saved In office state is kept, never replaced by the default (unticked)');
  assert.match(open, /size: cur && cur\.size \? cur\.size : shootPlanDefaultSize/, 'a saved size is kept on reopen');
  assert.match(open, /checked: !!cur/, 'a colourway is only ticked if it is already in the plan');
  const save = app.slice(app.indexOf('async function saveShootPlanSamples('), app.indexOf('// Formats a confirmation timestamp'));
  assert.match(save, /`\/shoot-plan\/\$\{ctx\.id\}\/samples`, \{ method: 'PUT'/, 'one request on Save samples; nothing is written before that');
  assert.ok(!/api\(/.test(app.slice(app.indexOf('function shootPlanSamplesRender('), app.indexOf('async function saveShootPlanSamples('))), 'ticking, sizing and In office only change the dialog until Save');
  assert.match(save, /out of stock/, 'size-level stock is validated on save');
  assert.match(app, /\$\{shootPlanPlural\(cw, 'colourway'\)\} <i>&middot;<\/i> \$\{shootPlanPlural\(samples, 'sample'\)\} needed[\s\S]{0,200}Manage Samples &rarr;/, 'one line: 4 colourways · 4 samples needed — Manage Samples');
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

test('backend: In office is a per-sample additive column; one atomic PUT saves the sample set; legacy "in office" entries read as in office', () => {
  assert.match(schema, /ALTER TABLE shoot_plan_item_styles ADD COLUMN IF NOT EXISTS in_office BOOLEAN NOT NULL DEFAULT false;/);
  const fn = route.slice(route.indexOf("router.put('/:id/samples'"), route.indexOf("router.patch('/:itemId/styles/:styleId'"));
  assert.match(fn, /BEGIN/); assert.match(fn, /COMMIT/); assert.match(fn, /ROLLBACK/); assert.match(fn, /A past week is a read-only record\./);
  assert.match(fn, /ON CONFLICT \(shoot_plan_item_id, style_id\) DO UPDATE SET[\s\S]*in_office/);
  assert.match(route, /in_office: !!row\.in_office \|\| /, 'an entry saved as "in office" before samples were tracked individually still reads as in office');
  assert.ok(!/creative_assets|initial_idea/.test(fn), 'nothing about concepts');
});
