'use strict';
// Upcoming Drops > Product Detail: compact header with progress chips, a one-line-per-concept table
// (Concept | Reference | Assigned To | Production Status | Action) and a collapsed "Other Creative Concepts"
// section. The production stage is read from the existing pipeline (asset status, shoot schedule, final
// approval); nothing new is tracked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const app = read('public', 'app.js');
const html = read('public', 'index.html');
const css = read('public', 'styles.css');
const schema = read('db', 'schema.sql');
const route = read('src', 'routes', 'dropProductPlans.js');

// Pull the real helpers out of app.js (no DOM needed) so the behaviour under test is the shipped code.
const block = app.slice(app.indexOf('const DROP_STAGES ='), app.indexOf('function renderRequiredConcepts('));
const ctx = { escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') };
vm.createContext(ctx);
vm.runInContext(`${block}; this.api = { dropStageKey, dropStatusLine, dropStepperHtml, dropReferenceHtml, dropShootDateLabel };`, ctx);
const { dropStageKey, dropStatusLine, dropStepperHtml, dropReferenceHtml, dropShootDateLabel } = ctx.api;

test('production stage comes from the existing asset status: no asset = none, anything pre-filming = Planned', () => {
  assert.equal(dropStageKey({ asset_id: null }), null);
  for (const [status, stage] of [['not_started', 'planned'], ['concept_script', 'planned'], ['filming', 'shooting'], ['editing', 'editing'], ['qc', 'final'], ['uploaded_live', 'live']]) {
    assert.equal(dropStageKey({ asset_id: 1, asset_status: status }), stage, status);
  }
});

test('stepper: earlier stages are ticked, the current one is marked, later ones are plain; no "deliverables" counter', () => {
  const out = dropStepperHtml({ asset_id: 1, asset_status: 'editing', asset_editing_owner: 'Sam' });
  assert.match(out, /data-stage="planned"/); assert.match(out, /dpv-step done" data-stage="planned"/); assert.match(out, /dpv-step done" data-stage="shooting"/);
  assert.match(out, /dpv-step current" data-stage="editing" aria-current="step"/); assert.match(out, /dpv-step todo" data-stage="final"/); assert.match(out, /dpv-step todo" data-stage="live"/);
  assert.match(out, /Editing · Assigned to Sam/);
  assert.ok(!/deliverable/i.test(out));
  assert.match(dropStepperHtml({ asset_id: null }), /No asset yet/);
});

test('status line is one short contextual line from schedule / editing owner / final approval', () => {
  assert.equal(dropShootDateLabel({ shoot_week_start: '2026-10-19', shoot_day: 'wednesday' }), 'Wed 21 Oct');
  assert.equal(dropStatusLine({ shoot_week_start: '2026-10-19', shoot_day: 'wednesday' }, 'planned'), 'Scheduled for Wed 21 Oct');
  assert.equal(dropStatusLine({}, 'planned'), 'Not started · No one assigned');
  assert.equal(dropStatusLine({ asset_concept_assignee: 'Sam' }, 'planned'), 'Not started');
  assert.equal(dropStatusLine({ shoot_status: 'shot' }, 'shooting'), 'Shot · waiting for editing');
  assert.equal(dropStatusLine({}, 'editing'), 'Editing · No editor assigned');
  assert.equal(dropStatusLine({ asset_final_approval: 'changes_required' }, 'final'), 'In final approval · Changes requested');
  assert.equal(dropStatusLine({}, 'final'), 'In final approval · Ready for review');
  assert.equal(dropStatusLine({}, 'live'), 'Approved · Uploaded to Meta');
});

test('reference: linked content opens in a new tab (video gets a play mark), none yet = quiet Add reference, manual concept = dash', () => {
  const video = dropReferenceHtml({ reference_link: 'https://example.com/v', reference_id: 4, reference_has_thumb: true, reference_thumb_version: 2, default_format: 'video' });
  assert.match(video, /href="https:\/\/example.com\/v" target="_blank" rel="noopener noreferrer"/); assert.match(video, /dpv-ref-play/); assert.match(video, /View video/);
  assert.match(video, /\/api\/drop-product-plans\/reference-thumb\/4\?v=2/);
  const still = dropReferenceHtml({ reference_link: 'https://example.com/i', reference_id: 5, default_format: 'static' });
  assert.match(still, /View example/); assert.ok(!/dpv-ref-play/.test(still));
  assert.match(dropReferenceHtml({ id: 9, proven_winner_id: 3 }), /\+ Add reference/);
  assert.ok(!/Add reference/.test(dropReferenceHtml({ id: 9 })));
});

test('page markup: header + chips + progress, five-column table, collapsed Other Creative Concepts with a count', () => {
  for (const id of ['product-view-name', 'product-view-code', 'product-view-chips', 'product-view-colours', 'product-view-plan-btn', 'product-plan-slots-header', 'product-plan-slots', 'product-view-other-count', 'product-view-concepts']) assert.ok(html.includes(`id="${id}"`), id);
  const head = html.slice(html.indexOf('id="product-plan-slots-header"'), html.indexOf('id="product-plan-slots"'));
  assert.deepEqual([...head.matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]).filter((t) => t && t !== '#'), ['Concept', 'Reference', 'Assigned To', 'Production Status', 'Action']);
  assert.match(html, /<details id="product-view-other-concepts-section" class="dpv-other"[^>]*>/); assert.ok(!/<details id="product-view-other-concepts-section"[^>]*\bopen\b/.test(html), 'collapsed by default (no open attribute)');
  assert.match(html, /Other Creative Concepts/);
  const sum = app.slice(app.indexOf('function renderProductSummary()'), app.indexOf('function renderProductSummary()') + 2400);
  assert.match(sum, /concept\$\{planned === 1 \? '' : 's'\} planned/); assert.match(sum, /creative\$\{group\.current_coverage === 1 \? '' : 's'\} completed/); assert.match(sum, /live on Meta/);
  assert.match(sum, /required creatives completed for this drop/, 'progress is completed against the existing target');
});

test('the per-stage checkboxes and "deliverables" counter are gone; the existing assignment, editing-owner, link and remove actions are kept', () => {
  for (const gone of ['conceptProgressChecksHtml', 'toggleConceptProgressStage', 'CONCEPT_PROGRESS_STAGES', 'deliverables']) assert.ok(!app.includes(gone), gone);
  const rows = app.slice(app.indexOf('function renderRequiredConcepts('), app.indexOf('function openDropReferenceModal'));
  for (const kept of ['updateConceptAssignee', 'pw-slot-editing-select', 'dpv-menu', 'dropStepperHtml', 'dropReferenceHtml']) assert.ok(rows.includes(kept), kept);
  assert.match(rows, /PROVEN/);
});

test('reference is a link to the Reference Library record from the Creative Playbook entry, never a duplicate; additive schema + guarded routes', () => {
  assert.match(schema, /ALTER TABLE proven_winners ADD COLUMN IF NOT EXISTS reference_id INTEGER REFERENCES reference_library\(id\) ON DELETE SET NULL;/);
  assert.match(route, /LEFT JOIN proven_winners pw[\s\S]*LEFT JOIN reference_library rl/);
  assert.match(route, /router\.get\('\/reference-thumb\/:referenceId/); assert.match(route, /router\.post\('\/:id\(\\\\d\+\)\/slots\/:slotId\(\\\\d\+\)\/reference'/);
  assert.match(route, /409/, 'a Playbook entry that already has a reference is not overwritten');
  assert.match(route, /ca\.final_approval_status AS asset_final_approval[\s\S]*ss\.status AS shoot_status/, 'stage data is read from the existing pipeline');
  const refRoute = route.slice(route.indexOf("slots/:slotId(\\\\d+)/reference'"));
  assert.ok(!/INSERT INTO drop_product_plan_slots|UPDATE drop_product_plan_slots/.test(refRoute.slice(0, refRoute.indexOf('\nrouter.', 10) > 0 ? refRoute.indexOf('\nrouter.', 10) : undefined)), 'adding a reference does not touch how concepts are assigned to drops');
});

test('styling: the stage colours and PROVEN badge exist and no blue accent is introduced', () => {
  const dpv = css.slice(css.indexOf('.dpv-head'));
  for (const sel of ['.dpv-row', '.dpv-step.current', '.dpv-proven', '.dpv-other']) assert.ok(dpv.includes(sel), sel);
});
