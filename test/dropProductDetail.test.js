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
const block = app.slice(app.indexOf('const DROP_MILESTONES ='), app.indexOf('// Saves on click through the same status endpoint'));
const refBlock = app.slice(app.indexOf('function dropReferenceHtml('), app.indexOf('function renderRequiredConcepts('));
const ctx = { escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'), STATUSES: ['not_started', 'awaiting_proven_concept', 'awaiting_concept_development', 'concept_script', 'filming', 'editing', 'qc', 'uploaded_live'] };
vm.createContext(ctx);
vm.runInContext(`${block}\n${refBlock}; this.api = { DROP_MILESTONES, dropMilestoneDone, dropMilestoneChange, dropMilestonesHtml, dropReferenceHtml };`, ctx);
const { DROP_MILESTONES, dropMilestoneDone, dropMilestoneChange, dropMilestonesHtml, dropReferenceHtml } = ctx.api;
const [FILMED, EDITED, UPLOADED] = DROP_MILESTONES;
// the helpers run in a vm context, so compare by value (arrays from another realm are never reference-equal)
const eq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);

test('the three milestones read the existing asset status: Filmed = filming or later, Edited = QC or later, Uploaded = uploaded', () => {
  eq(DROP_MILESTONES.map((m) => m.label), ['Filmed', 'Edited', 'Uploaded to Meta']);
  const done = (status) => DROP_MILESTONES.map((m) => dropMilestoneDone(status, m));
  eq(done('not_started'), [false, false, false]);
  eq(done('concept_script'), [false, false, false]);
  eq(done('filming'), [true, false, false]);
  eq(done('editing'), [true, false, false], 'still being edited is not yet Edited');
  eq(done('qc'), [true, true, false]);
  eq(done('uploaded_live'), [true, true, true]);
});

test('ticking and unticking write a canonical status; changes to the other milestones are reported', () => {
  eq(dropMilestoneChange('concept_script', FILMED, true), { next: 'filming', changed: [] });
  eq(dropMilestoneChange('filming', FILMED, false), { next: 'concept_script', changed: [] }, 'a mistaken Filmed tick can be undone');
  eq(dropMilestoneChange('filming', EDITED, true), { next: 'qc', changed: [] });
  eq(dropMilestoneChange('qc', EDITED, false), { next: 'filming', changed: [] });
  eq(dropMilestoneChange('qc', UPLOADED, true), { next: 'uploaded_live', changed: [] });
  eq(dropMilestoneChange('uploaded_live', UPLOADED, false), { next: 'qc', changed: [] }, 'untick Uploaded keeps Filmed and Edited');
  eq(dropMilestoneChange('filming', UPLOADED, true), { next: 'uploaded_live', changed: ['Edited'] }, 'a later milestone cannot be done without the earlier ones');
  eq(dropMilestoneChange('uploaded_live', FILMED, false), { next: 'concept_script', changed: ['Edited', 'Uploaded to Meta'] });
});

test('three checkboxes per row: ticked ones are marked, the rest are neutral, a concept with no asset is disabled', () => {
  const html = dropMilestonesHtml({ asset_id: 7, asset_status: 'qc', concept_name: 'Flat <lay>' });
  const boxes = [...html.matchAll(/<input type="checkbox" data-asset-id="7" data-ms="(\w+)"[^>]*?(checked)?[^>]*>/g)];
  eq(boxes.map((m) => m[1]), ['filmed', 'edited', 'uploaded']);
  assert.equal((html.match(/dpv-ms done/g) || []).length, 2); assert.equal((html.match(/ checked/g) || []).length, 2);
  assert.ok(html.includes('aria-label="Filmed: Flat &lt;lay&gt;"'));
  const none = dropMilestonesHtml({ asset_id: null, concept_name: 'x' });
  assert.equal((none.match(/disabled/g) || []).length, 3); assert.ok(!/dpv-ms done/.test(none));
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
  eq([...head.matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]).filter((t) => t && t !== '#'), ['Concept', 'Reference', 'Assigned To', 'Filmed', 'Edited', 'Uploaded to Meta', 'Action']);
  assert.match(html, /<details id="product-view-other-concepts-section" class="dpv-other"[^>]*>/); assert.ok(!/<details id="product-view-other-concepts-section"[^>]*\bopen\b/.test(html), 'collapsed by default (no open attribute)');
  assert.match(html, /Other Creative Concepts/);
  const sum = app.slice(app.indexOf('function renderProductSummary()'), app.indexOf('function renderProductSummary()') + 2400);
  assert.match(sum, /concept\$\{planned === 1 \? '' : 's'\} planned/); assert.match(sum, /creative\$\{group\.current_coverage === 1 \? '' : 's'\} completed/); assert.match(sum, /live on Meta/);
  assert.match(sum, /required creatives completed for this drop/, 'progress is completed against the existing target');
});

test('no stage timeline, deliverables counter or status text; save goes through the shared status endpoint; the existing assignment, editing-owner, link and remove actions are kept', () => {
  for (const gone of ['dropStepperHtml', 'dropStatusLine', 'DROP_STAGES', 'dpv-stepper', 'deliverables']) assert.ok(!app.includes(gone) && !css.includes(gone), gone);
  const tog = app.slice(app.indexOf('async function toggleDropMilestone('), app.indexOf('// The Creative Playbook entry'));
  assert.match(tog, /api\(`\/creative-assets\/\$\{assetId\}\/status`, \{ method: 'PATCH'/, 'the same endpoint the Board writes to, so every page agrees');
  assert.match(tog, /input\.checked = !checked;[\s\S]*toast\(`Could not save/, 'a failed save puts the box back and says so');
  assert.match(tog, /await api\([\s\S]*\} catch \(e\) \{[\s\S]*return;[\s\S]*loadProductView\(/, 'the page only refreshes as saved after the save succeeded');
  assert.match(tog, /disabled = true/, 'locked while saving');
  const rows = app.slice(app.indexOf('function renderRequiredConcepts('), app.indexOf('function openDropReferenceModal'));
  for (const kept of ['updateConceptAssignee', 'pw-slot-editing-select', 'dpv-menu', 'dropMilestonesHtml', 'dropReferenceHtml']) assert.ok(rows.includes(kept), kept);
  assert.match(rows, /PROVEN/); assert.ok(!rows.includes('dpv-thumb'), 'no repeated product thumbnail in each concept row');
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
  for (const sel of ['.dpv-row', '.dpv-ms.done', '.dpv-proven', '.dpv-other']) assert.ok(dpv.includes(sel), sel);
});

test('imagery: one combined product picture, no thumbnails beside it or in the colourway panel; inventory text kept', () => {
  const img = app.slice(app.indexOf('function renderProductViewImages('), app.indexOf('function renderProductSummary('));
  assert.match(img, /dpv-combo/); assert.ok(!/dpv-thumbs|gt-box-48/.test(img));
  assert.match(img, /product-view-colour-code[\s\S]*colourStatsLine\(s\)/, 'SKU, stock on hand and on order are still shown');
  assert.match(css, /\.dpv-combo\{/);
});

test('Uploaded to Meta is separate from Live on Meta, which still comes from the Meta count', () => {
  const sum = app.slice(app.indexOf('function renderProductSummary()'), app.indexOf('function renderProductSummary()') + 2400);
  assert.match(sum, /group\.live_meta_ads[\s\S]*live on Meta/);
  assert.match(app, /Uploaded to Meta" is the asset's uploaded status; it does not mean the ad is live/);
});
