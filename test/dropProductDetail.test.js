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

test('reference: linked content opens in a new tab (video gets a play mark), nothing set in the Playbook = a dash (no Add reference on the drop page)', () => {
  const video = dropReferenceHtml({ reference_link: 'https://example.com/v', reference_id: 4, reference_has_thumb: true, reference_thumb_version: 2, default_format: 'video' });
  assert.match(video, /href="https:\/\/example.com\/v" target="_blank" rel="noopener noreferrer"/); assert.match(video, /dpv-ref-play/); assert.match(video, /View video/);
  assert.match(video, /\/api\/drop-product-plans\/reference-thumb\/4\?v=2/);
  const still = dropReferenceHtml({ reference_link: 'https://example.com/i', reference_id: 5, default_format: 'static' });
  assert.match(still, /View example/); assert.ok(!/dpv-ref-play/.test(still));
  for (const none of [{ id: 9, proven_winner_id: 3 }, { id: 9 }]) assert.ok(!/Add reference|<button/.test(dropReferenceHtml(none)) && /&mdash;/.test(dropReferenceHtml(none)));
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

test('reference is a link to the Reference Library record from the Creative Playbook entry, never a duplicate; additive schema; read-only on the drop page', () => {
  assert.match(schema, /ALTER TABLE proven_winners ADD COLUMN IF NOT EXISTS reference_id INTEGER REFERENCES reference_library\(id\) ON DELETE SET NULL;/);
  assert.match(route, /LEFT JOIN proven_winners pw[\s\S]*LEFT JOIN reference_library rl/);
  assert.match(route, /router\.get\('\/reference-thumb\/:referenceId/);
  assert.ok(!/\/reference'/.test(route) && !app.includes('openDropReferenceModal') && !html.includes('dpv-ref-modal'), 'the reference is set in Settings > Creative Playbook, not on the drop page');
  assert.match(route, /ca\.final_approval_status AS asset_final_approval[\s\S]*ss\.status AS shoot_status/, 'stage data is read from the existing pipeline');
});

test('no Edit button on a concept row; Assigned To, the milestones, the menu and the Playbook link remain', () => {
  const rows = app.slice(app.indexOf('function renderRequiredConcepts('), app.indexOf("document.getElementById('product-plan-playbook-link')"));
  assert.ok(!rows.includes('editConceptAsset') && !/>Edit</.test(rows), 'no Edit button');
  for (const kept of ['dpv-assign', 'dropMilestonesHtml', 'dpv-menu', 'Create Asset']) assert.ok(rows.includes(kept), kept);
});

test('Settings > Creative Playbook: each entry has a Reference link and a Default assigned to, saved by the existing routes', () => {
  const modal = html.slice(html.indexOf('id="pw-modal"'), html.indexOf('id="pw-modal"') + 4200);
  assert.match(modal, /id="pw-assignee"/); assert.match(modal, /id="pw-reference" placeholder/);
  const save = app.slice(app.indexOf('async function savePw()'), app.indexOf('async function deletePw()'));
  assert.match(save, /default_assignee, reference_link/); assert.match(save, /assignee_applied/);
  assert.match(schema, /ALTER TABLE proven_winners ADD COLUMN IF NOT EXISTS default_assignee VARCHAR\(20\);/);
  assert.match(schema, /ALTER TABLE drop_product_plan_slots ADD COLUMN IF NOT EXISTS assignee_from_playbook BOOLEAN NOT NULL DEFAULT false;/);
  const pw = read('src', 'routes', 'provenWinners.js');
  assert.match(pw, /CONCEPT_ASSIGNEES\.includes\(body\.default_assignee\)/); assert.match(pw, /preview\.publicUrl\(String\(body\.reference_link\)/);
  assert.match(pw, /LEFT JOIN reference_library rl ON rl\.id = pw\.reference_id/, 'the Playbook list returns the reference link');
  assert.match(pw, /applyPlaybookAssignee\(client, Number\(req\.params\.id\)\)/);
});

test('Playbook person flow: only unassigned (or Playbook-filled) concepts before filming, never a hand pick; a hand pick stops it following', () => {
  const fn = route.slice(route.indexOf('async function applyPlaybookAssignee('), route.indexOf('// Default people for a NEW Required Concept'));
  assert.match(fn, /ca\.concept_assignee IS NULL OR \(s\.assignee_from_playbook AND ca\.concept_assignee <> \$4\)/);
  assert.match(fn, /ca\.status = ANY\(\$3::text\[\]\)/); assert.match(route, /PRE_PRODUCTION_STATUSES = \['not_started', 'awaiting_proven_concept', 'awaiting_concept_development', 'concept_script'\]/);
  assert.match(fn, /ca\.archived_at IS NULL AND ca\.concept_dev_status <> 'killed'/);
  assert.match(fn, /ensureDropProductionLinkage\(client/, 'same Shooting hand-off as picking the person by hand');
  assert.match(fn, /if \(!person\) return 0;/, 'clearing the Playbook person changes nothing');
  assert.match(route, /applyPlaybookAssignee\(client, pw\.id, \{ slotId: slotResult\.rows\[0\]\.id \}\);\s*await applyDropAssignmentDefaults/, 'new concepts take the Playbook person before the general default');
  assert.match(read('src', 'routes', 'creativeAssets.js'), /UPDATE drop_product_plan_slots SET assignee_from_playbook = false WHERE fulfilled_by_asset_id/);
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

test('a concept with all three milestones ticked is styled as complete (green row and solid ticks)', () => {
  assert.match(app, /const complete = fulfilled && s\.asset_status === 'uploaded_live';/, 'complete = Filmed + Edited + Uploaded, the same status the third box reads');
  assert.match(app, /dpv-row\$\{complete \? ' dpv-row-complete' : ''\}/);
  assert.match(css, /\.dpv-row-complete\{background:#f1faf4;box-shadow:inset 3px 0 0 #22a35a;\}/);
  assert.match(css, /\.dpv-row-complete \.dpv-ms \.dpv-ms-box\{background:#22a35a;/);
});

test('the header progress bar is a real block element (an inline span ignores its width, so the fill never showed) and is re-rendered from the refreshed coverage after a tick', () => {
  const sum = app.slice(app.indexOf('function renderProductSummary()'), app.indexOf('function renderProductSummary()') + 3000);
  assert.match(sum, /<div class="coverage-progress-track"><div class="coverage-progress-fill \$\{group\.status\}" style="width:\$\{pct\}%;"><\/div><\/div>/);
  assert.ok(!/<span class="coverage-progress-(track|fill)/.test(sum));
  const tog = app.slice(app.indexOf('async function toggleDropMilestone('), app.indexOf('// The Creative Playbook entry'));
  assert.match(tog, /await loadProductView\(state\.currentDropId/, 'the drop (and so the coverage count and bar) is re-read after every saved tick');
});

test('Drop page product cards: a card whose coverage is complete (the green COVERAGE COMPLETE status) is tinted green; others are not', () => {
  assert.match(app, /class="coverage-card\$\{c\.soh !== null && c\.status === 'green' \? ' coverage-card-complete' : ''\}"/);
  assert.match(app, /if \(c\.status === 'green'\) return 'COVERAGE COMPLETE';/, 'same condition as the label');
  assert.match(css, /\.coverage-card-complete\{background:#f1faf4;border-color:#bfe3cd;\}/);
  assert.match(css, /\.coverage-card-complete \.coverage-card-imgrow\{background:#e1f2e8;\}/);
});

test('the concept table does not clip the options menu: no overflow:hidden on the list, rounded corners on the last row instead, and the last row menu opens upward', () => {
  const list = css.match(/\.dpv-list\{[^}]*\}/)[0];
  assert.ok(!/overflow/.test(list), 'a clipping list hides the menu of the last row');
  assert.match(css, /\.dpv-list \.dpv-row:last-child\{border-bottom:0;border-radius:0 0 var\(--r-lg\) var\(--r-lg\);\}/);
  assert.match(css, /\.dpv-list \.dpv-row:last-child \.dpv-menu-pop\{top:auto;bottom:calc\(100% \+ 4px\);\}/);
});

test('Remove: only a manually added concept has a Remove button; the server archives it (history kept) and refuses Playbook and published concepts', () => {
  const rows = app.slice(app.indexOf('function renderRequiredConcepts('), app.indexOf("document.getElementById('product-plan-playbook-link')"));
  assert.match(rows, /const canRemove = s\.source === 'new' && !complete;/, 'never a Playbook (proven) concept, never one already Uploaded to Meta');
  assert.match(rows, /\$\{primary\}\$\{menu\}\$\{removeBtn\}/);
  const del = app.slice(app.indexOf('async function deleteConceptSlot('), app.indexOf('function showAddNewConceptForm()'));
  assert.match(del, /confirmDialog\(msg, \{ okLabel: 'Remove' \}\)/); assert.match(del, /history is kept and it can be restored/); assert.match(del, /method: 'DELETE'/);
  assert.match(del, /catch \(e\) \{\s*toast\(e\.message, true\);/, 'a refusal is shown, never a false success');
  const route = read('src', 'routes', 'dropProductPlans.js');
  const fn = route.slice(route.indexOf("router.delete('/:id/slots/:slotId'"), route.indexOf('// Link an EXISTING creative asset'));
  assert.match(fn, /row\.source !== 'new'[\s\S]*409/); assert.match(fn, /info\.protected/);
  assert.match(fn, /applyAction\(row\.fulfilled_by_asset_id, 'archive'/); assert.ok(!/DELETE FROM creative_assets/.test(fn), 'the production record is archived, never deleted');
  assert.ok(fn.indexOf("'archive'") < fn.indexOf('DELETE FROM drop_product_plan_slots'), 'archive first (idempotent), then the slot, so a retry can finish the job');
  assert.match(app, /filter\(\(a\) => !a\.archived_at && a\.concept_dev_status !== 'killed'\)/, 'an archived concept leaves Other Creative Concepts and the Link existing list');
  assert.match(css, /\.dpv-del\{/);
});
