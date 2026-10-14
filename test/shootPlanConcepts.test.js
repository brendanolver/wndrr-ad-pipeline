'use strict';
// Batch 30: Shoot Plan concept / colourway rules, proved with a fake database client (no database): one concept covers several colourways, another concept adds to a product,
// repeating a request never duplicates, existing concepts are never changed, and the route keeps promotions and carried-over records alone. The same writes are exercised against
// a real (local) database by the QA scripts; this test pins the logic in the repository.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const router = require('../src/routes/shootPlan');
const { ensureConcepts } = router;

// a fake client: `have` live concepts already exist for the item; every INSERT INTO creative_assets creates the next id
const fake = (have) => {
  const calls = []; let nextId = 100; let live = have;
  return {
    calls,
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/SELECT count\(\*\)::int AS n FROM creative_assets/.test(sql)) return { rows: [{ n: live }] };
      if (/SELECT style_id FROM shoot_plan_item_styles/.test(sql)) return { rows: [{ style_id: 1 }] };
      if (/INSERT INTO creative_assets/.test(sql)) { live += 1; nextId += 1; return { rows: [{ id: nextId, status: 'awaiting_concept_development' }] }; }
      return { rows: [] };
    },
    created: () => calls.filter((c) => /INSERT INTO creative_assets/.test(c.sql)),
    linked: () => calls.filter((c) => /UPDATE creative_assets SET shoot_plan_item_id/.test(c.sql)),
  };
};
const opts = (o = {}) => ({ baseName: 'B30 Concept', creator: 'Mark', createdByUserId: null, conceptType: 'Styling Video', assignee: null, editingOwner: null, format: 'video', plannedStyleIds: [11, 12, 13, 14], ...o });

test('one concept covers several colourways: four colourways make ONE concept record, never four', async () => {
  const c = fake(0);
  const made = await ensureConcepts(c, { id: 7 }, 1, opts());
  assert.equal(made, 1); assert.equal(c.created().length, 1);
  assert.deepEqual(c.linked()[0].params[2], [11, 12, 13, 14], 'the concept records the colourways it covers');
  assert.equal(c.created()[0].params[12], 'Styling Video', 'with its concept type');
});
test('another concept for the same product is added; existing concepts are never recreated or changed', async () => {
  const c = fake(1);
  const made = await ensureConcepts(c, { id: 7 }, 2, opts({ conceptType: 'Flat Lay', plannedStyleIds: [11, 12] }));
  assert.equal(made, 1, 'one more concept, not two'); assert.equal(c.created().length, 1);
  assert.deepEqual(c.linked()[0].params[2], [11, 12]);
  assert.ok(!c.calls.some((x) => /UPDATE creative_assets SET (concept_name|concept_type|planned_style_ids)(?! =)/.test(x.sql) && !/shoot_plan_item_id/.test(x.sql)), 'no existing concept is updated');
});
test('repeating a request creates no duplicate concept (the count asked for is already live)', async () => {
  const c = fake(2);
  assert.equal(await ensureConcepts(c, { id: 7 }, 2, opts()), 0); assert.equal(c.created().length, 0);
  assert.equal(await ensureConcepts(fake(3), { id: 7 }, 2, opts()), 0, 'more live concepts than asked for: nothing is added or removed');
});
test('no colourways recorded is stored as NULL (the product record decides), never as an empty list', async () => {
  const c = fake(0);
  await ensureConcepts(c, { id: 7 }, 1, opts({ plannedStyleIds: [] }));
  assert.equal(c.linked()[0].params[2], null);
});

test('route: "additional" adds to the live concepts; the merge never lowers the planned count; promotions and drops keep their own items', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'shootPlan.js'), 'utf8');
  assert.match(src, /const additional = !!\(req\.body && req\.body\.additional === true\)/);
  assert.match(src, /const wantTotal = additional \? haveNow \+ requestedVideos : requestedVideos/);
  assert.match(src, /const raised = Math\.max\(ex\.planned_videos \|\| 1, wantTotal\)/, 'the planned count is only ever raised');
  assert.match(src, /DEDUPE_SOURCES = \[null, undefined, 'core', 'high_stock', 'manual', 'momentum'\]/, 'promotions and drops are never merged');
  assert.match(src, /WHERE shoot_plan_item_id = \$1 AND concept_dev_status <> 'killed'/, 'killed concepts do not count as live');
  assert.match(src, /plannedStyleIds: trimmedColourways\.map/, 'both the merge and the first-create paths record the colourways');
});
test('schema: the new column is additive and idempotent, and nothing is dropped or rewritten', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const i = sql.indexOf('Batch 30: colourways belong to a CONCEPT');
  const block = sql.slice(i, sql.indexOf('-- Approved Ad Matching concepts'));
  assert.match(block, /ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS planned_style_ids INTEGER\[\];/);
  assert.doesNotMatch(block, /\b(DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE|UPDATE )/);
});
test('ui: the Shoot Plan modal sends the concept and the additional flag; every colourway that can be shot is preselected', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /if \(conceptSel && conceptSel\.value\) payload\.concept_type = conceptSel\.value/);
  assert.match(app, /if \(shootPlanModalContext\.additional\) payload\.additional = true/);
  assert.match(app, /return c\.viable !== false;/, 'restricted colourways are listed but not ticked');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /id="shoot-plan-concept-type"/); assert.match(html, /One concept covers every colourway ticked below/);
});
