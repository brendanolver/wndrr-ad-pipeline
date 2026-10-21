'use strict';
// Batch 37: Planning selection tray + simplified Shoot Plan + Confirm & Send. Pure rules and static contracts (the browser journey is QA'd separately on the isolated database).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const html = read('public', 'index.html');
const app = read('public', 'app.js');
const pl = read('public', 'planning.js');
const css = read('public', 'styles.css');
const sel = require('../src/lib/shootPlanSelection');

const draft = { concept_dev_status: 'not_started', status: 'awaiting_concept_development', has_shoot: false, editing_submitted_at: null, final_approval_status: 'pending', final_edits: 0, ad_setups: 0, has_content: false };

test('removal rule: an untouched draft concept does not block removing the product', () => {
  assert.deepEqual(sel.conceptWork(draft), []);
});

test('removal rule: any work or progress on a concept blocks removal and says why', () => {
  assert.ok(sel.conceptWork({ ...draft, has_content: true }).some((r) => /saved concept details/.test(r)));
  assert.ok(sel.conceptWork({ ...draft, concept_dev_status: 'ready_for_review' }).length);
  assert.ok(sel.conceptWork({ ...draft, concept_dev_status: 'approved', status: 'filming' }).length >= 2);
  assert.ok(sel.conceptWork({ ...draft, has_shoot: true }).some((r) => /shooting/.test(r)));
  assert.ok(sel.conceptWork({ ...draft, editing_submitted_at: new Date() }).length);
  assert.ok(sel.conceptWork({ ...draft, final_approval_status: 'approved' }).length);
  assert.ok(sel.conceptWork({ ...draft, final_edits: 1 }).length);
  assert.ok(sel.conceptWork({ ...draft, ad_setups: 2 }).length);
});

test('removal message names the concept, the way out (Kill Concept) and that the product is untouched', () => {
  const m = sel.blockingMessage({ item: { product_name: 'Rothman Sport Short' }, blocking: [{ name: 'New Concept (1)', where: 'Shooting', reasons: ['it is scheduled for shooting'] }] });
  assert.match(m, /Rothman Sport Short cannot be removed from the plan/); assert.match(m, /"New Concept \(1\)"/);
  assert.match(m, /Kill Concept/); assert.match(m, /Move Back in Shooting/); assert.match(m, /product itself is not affected/);
});

test('removal never deletes a concept: untouched drafts are archived through the lifecycle action, work blocks (server)', async () => {
  const calls = []; const deleted = [];
  const db = { query: async (sql) => {
    if (/FROM shoot_plan_items spi WHERE spi.id/.test(sql)) return { rows: [{ id: 5, product_name: 'P', source: 'core', auto_linked: false, week_start: '2026-10-19' }] };
    if (/FROM creative_assets ca/.test(sql)) return { rows: [{ id: 9, concept_name: 'C1', ...draft }] };
    if (/DELETE FROM shoot_plan_items/.test(sql)) { deleted.push(sql); return { rows: [] }; }
    throw new Error('unexpected ' + sql);
  } };
  const out = await sel.removeSelection(db, 5, async (id, reason) => { calls.push([id, reason]); });
  assert.deepEqual(out, { removed: true, archived_concepts: 1 });
  assert.equal(calls.length, 1); assert.match(calls[0][1], /Removed from the Shoot Plan/);
  assert.equal(deleted.length, 1, 'only the plan entry is deleted');
  const worked = { query: async (sql) => (/FROM shoot_plan_items spi WHERE spi.id/.test(sql) ? { rows: [{ id: 5, product_name: 'P', source: 'core', auto_linked: false }] } : { rows: [{ id: 9, concept_name: 'C1', ...draft, has_content: true }] }) };
  await assert.rejects(() => sel.removeSelection(worked, 5, async () => assert.fail('must not archive')), (e) => e.status === 409 && e.blocking.length === 1);
  const auto = { query: async () => ({ rows: [{ id: 5, product_name: 'P', source: 'drop', auto_linked: true }] }) };
  await assert.rejects(() => sel.removeSelection(auto, 5, async () => {}), (e) => e.status === 409 && /Upcoming Drops/.test(e.message));
});

test('a Drop item keeps its (pre-existing) Required Concept: it is detached, never archived', async () => {
  const calls = [];
  const db = { query: async (sql) => {
    if (/FROM shoot_plan_items spi WHERE spi.id/.test(sql)) return { rows: [{ id: 5, product_name: 'P', source: 'drop', auto_linked: false }] };
    if (/FROM creative_assets ca/.test(sql)) return { rows: [{ id: 9, concept_name: 'C1', ...draft }] };
    return { rows: [] };
  } };
  const out = await sel.removeSelection(db, 5, async (id) => calls.push(id));
  assert.equal(out.archived_concepts, 0); assert.equal(calls.length, 0);
});

test('Drops-created entries are not Planning selections (SQL rule used everywhere)', () => {
  const sql = sel.autoLinkedSql('spi');
  assert.match(sql, /spi\.auto_linked/); assert.match(sql, /source = 'drop'/); assert.match(sql, /drop_product_plan_slots/);
  const drops = read('src', 'routes', 'dropProductPlans.js');
  assert.match(drops, /INSERT INTO shoot_plan_items \([^)]*auto_linked\)/, 'the Drops linkage marks its own entries');
  const sp = read('src', 'routes', 'shootPlan.js');
  assert.match(sp, /auto_linked: !!i\.auto_linked/);
  const getQuery = sp.slice(sp.indexOf("router.get('/'"), sp.indexOf('const items = itemsResult.rows;'));
  assert.match(getQuery, /\$\{selection\.autoLinkedSql\('spi'\)\} AS auto_linked/, 'GET /shoot-plan reports the rule, so entries created before the column existed are recognised too');
});

test('schema: auto_linked is an additive column; nothing is rewritten or dropped', () => {
  const sql = read('db', 'schema.sql');
  const block = sql.slice(sql.indexOf('-- Batch 37:'), sql.indexOf('-- Approved Ad Matching concepts'));
  assert.match(block, /ALTER TABLE shoot_plan_items ADD COLUMN IF NOT EXISTS auto_linked BOOLEAN NOT NULL DEFAULT false;/);
  assert.doesNotMatch(block, /\b(DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE|UPDATE )/);
});

test('confirmation: idempotent, validates, and never touches concept review state', () => {
  const r = read('src', 'routes', 'weeklyShootPlanConfirmation.js');
  assert.match(r, /ON CONFLICT \(week_start\) DO NOTHING/);
  assert.match(r, /Add at least one product to the Shoot Plan before confirming it/);
  assert.match(r, /router\.get\('\/preview'/);
  assert.doesNotMatch(r, /concept_dev_status|ready_for_review|creative_assets/, 'confirming never changes a concept or submits anything for review');
  const lib = read('src', 'lib', 'shootPlanSelection.js');
  const fn = lib.slice(lib.indexOf('async function confirmationPreview'));
  assert.doesNotMatch(fn.slice(0, fn.indexOf('\n}\n')), /INSERT|UPDATE |DELETE/, 'the preview is read-only');
  assert.match(lib, /Nothing is submitted for Tuesday Review/);
});

test('removal endpoint: guarded, past weeks are read-only, the lifecycle archive is used', () => {
  const r = read('src', 'routes', 'shootPlan.js');
  const del = r.slice(r.indexOf("router.delete('/:id'"));
  assert.match(del, /A past week is a read-only record/); assert.match(del, /removeSelection\(/); assert.match(del, /applyAction\(conceptId, 'archive'/);
  assert.match(r, /router\.get\('\/:id\/removal'/);
});

test('Planning page: the old This Week\'s Shoot Plan panel is gone; the tray sits under the tabs and is hidden until something is selected', () => {
  assert.doesNotMatch(html, /This Week's Shoot Plan/); assert.doesNotMatch(pl, /Weekly creative goal|pl-week-goal|carried over from earlier weeks/);
  const top = html.indexOf('id="planning-topnav"'); const tray = html.indexOf('id="planning-production-header"'); const core = html.indexOf('id="planning-step-core"');
  assert.ok(top > 0 && tray > top && core > tray, 'tabs, then tray, then the page content');
  assert.match(html, /id="planning-production-header"[^>]*\bhidden\b/);
  assert.match(css, /\.pl-tray-host\{position:sticky;/);
  assert.match(pl, /const PL_TRAY_MAX = 5;/); assert.match(pl, /\+\$\{more\}/); assert.match(pl, /View Shoot Plan &rarr;/); assert.match(pl, /function plToggleTray/);
  assert.match(pl, /const plSelected = \(\) => \(state\.shootPlan \|\| \[\]\)\.filter\(\(i\) => !i\.auto_linked\)/);
});

test('Add to Shoot: one click through the existing endpoint; duplicates and read-only weeks are refused client-side too', () => {
  const fn = pl.slice(pl.indexOf('async function plQuickAdd'), pl.indexOf('// ── choosing a product: the explicit step into the Shoot Plan'));
  assert.match(fn, /plReadOnly\(\)/); assert.match(fn, /PL_ADDING\.has\(key\)/); assert.match(fn, /plInThisWeeksPlan\(it\)/);
  assert.match(fn, /createShootPlanSelection\(payload\)/); assert.doesNotMatch(fn, /api\('\/shoot-plan'/, 'the write stays in app.js next to the original form');
  assert.match(app, /function createShootPlanSelection\(payload\) \{\s*return api\('\/shoot-plan', \{ method: 'POST'/);
  assert.match(fn, /week_start: planningWeekStart\(\)/);
  assert.match(fn, /plPlan\(key, null, extra\)/, 'nothing shootable: the full form (which asks before overriding a restriction) opens instead');
  assert.match(pl, /data-opp-added/); assert.match(pl, /Add to Shoot</);
});

test('Shoot Plan page: only selected products, product cards, primary action top right, confirmation dialog, empty state', () => {
  assert.match(app, /const shootPlanSelected = \(\) => \(state\.shootPlan \|\| \[\]\)\.filter\(\(i\) => !i\.auto_linked\)/);
  for (const frag of ['sp3-tile', 'sp3-name', 'sp3-facts', 'sp3-owner', 'data-sp-remove', 'Shoot Notes', 'sp3-row-samples', 'Samples Needed', 'Warehouse Requests', 'Assigned to']) assert.ok(app.includes(frag), frag);
  assert.match(app, /No products added to this week's shoot plan yet\./); assert.match(app, /Browse Creative Opportunities &rarr;/);
  assert.match(html, /class="pl-navrow-action" id="shoot-plan-actions"/); assert.match(html, /onclick="openShootPlanConfirm\(\)">Confirm Shoot Plan &rarr;/);
  assert.match(html, /id="shoot-plan-confirm-modal"/);
  assert.match(html, /Confirm what we're shooting and which samples we need\./);
  assert.doesNotMatch(html, /shoot-plan-progress|shoot-plan-summary-stats/, 'the progress panel and counters are gone');
  assert.match(app, /if \(shootPlanConfirmBusy\) return;/, 'a double click does nothing');
  assert.match(app, /\/shoot-plan\/\$\{id\}\/removal/); assert.match(app, /Remove from plan/);
  assert.match(css, /\.sp3-grid\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
});

test('Shoot Plan: nothing populates it automatically (no render path reads Upcoming Drops, Core, High Stocks or Insights lists)', () => {
  const fn = app.slice(app.indexOf('function shootPlanGridHtml'), app.indexOf('function renderPlanningShootPlanSummary'));
  assert.doesNotMatch(fn, /opportunities|coreProducts|highStock|state\.drops|insights/);
});
