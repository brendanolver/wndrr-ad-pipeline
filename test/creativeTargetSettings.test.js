'use strict';
// Settings > Creative Playbook > Required Concepts by Stock: the stock ranges behind how many Required Concepts an Upcoming Drop product needs are editable.
// The standard ranges are the existing seed (1-100: 4, 101-200: 6, 201-400: 8, 401+: 10), so nothing changes until someone edits them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { computeCreativeTarget, validateCreativeTargetRules: validate } = require('../src/lib/creativeTarget');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const app = read('public', 'app.js'); const html = read('public', 'index.html'); const css = read('public', 'styles.css'); const schema = read('db', 'schema.sql'); const route = read('src', 'routes', 'creativeTargetRules.js');
const R = (min, max, req) => ({ soh_min: min, soh_max: max, required_creatives: req });
const STANDARD = [R(1, 100, 4), R(101, 200, 6), R(201, 400, 8), R(401, null, 10)];

test('the standard ranges in the editor are the seeded ones, so nothing changes until they are edited', () => {
  assert.match(schema, /INSERT INTO creative_target_rules \(soh_min, soh_max, required_creatives\) VALUES\s*\(1, 100, 4\),\s*\(101, 200, 6\),\s*\(201, 400, 8\),\s*\(401, NULL, 10\)/);
  assert.match(app, /const CRT_STANDARD = \[\{ max: 100, req: 4 \}, \{ max: 200, req: 6 \}, \{ max: 400, req: 8 \}, \{ max: null, req: 10 \}\];/);
  assert.equal(validate(STANDARD).ok, true);
});

test('edited ranges feed the same lookup: e.g. 201-250 can be set to need 6', () => {
  const v = validate([R(1, 100, 4), R(101, 200, 5), R(201, 250, 6), R(251, null, 8)]);
  assert.equal(v.ok, true);
  assert.equal(computeCreativeTarget(220, v.rules), 6); assert.equal(computeCreativeTarget(250, v.rules), 6); assert.equal(computeCreativeTarget(251, v.rules), 8); assert.equal(computeCreativeTarget(0, v.rules), 0);
});

test('validation: no gaps, no overlaps, starts at 1, last range open-ended, whole numbers in range', () => {
  const bad = (rules, re) => { const r = validate(rules); assert.equal(r.ok, false); assert.match(r.error, re); };
  bad([], /At least one range/); bad('x', /At least one range/);
  bad([R(2, null, 4)], /first range must start at 1/);
  bad([R(1, 100, 4), R(102, null, 6)], /no gap or overlap \(after 100 comes 101\)/);
  bad([R(1, 100, 4), R(100, null, 6)], /no gap or overlap/);
  bad([R(1, 100, 4)], /last range must be open-ended/);
  bad([R(1, null, 4), R(101, null, 6)], /Only the last range can be open-ended/);
  bad([R(1, 0, 4), R(1, null, 5)], /cannot end before it starts/);
  bad([R(1, null, -1)], /0 to 50/); bad([R(1, null, 51)], /0 to 50/); bad([R(1, null, 2.5)], /0 to 50/); bad([R(0, null, 4)], /start at 1 or more/);
  bad(Array.from({ length: 13 }, (_, i) => R(i + 1, i === 12 ? null : i + 1, 4)), /No more than 12/);
  assert.equal(validate([R(201, null, 8), R(1, 200, 4)]).rules[0].soh_min, 1, 'order does not matter, it is sorted');
});

test('the save endpoint validates the whole set and swaps it in one transaction; the lookup route is module-guarded', () => {
  assert.match(route, /router\.put\('\/', async/); assert.match(route, /validateCreativeTargetRules\(req\.body && req\.body\.rules\)/);
  assert.match(route, /BEGIN[\s\S]*DELETE FROM creative_target_rules[\s\S]*INSERT INTO creative_target_rules[\s\S]*COMMIT/); assert.match(route, /ROLLBACK/);
  assert.ok(route.indexOf("router.put('/', async") < route.indexOf("router.put('/:id'"), 'registered before the :id route');
  assert.match(read('src', 'server.js'), /app\.use\('\/api\/creative-target-rules', requireAuth, requireModuleAccess\('planning'\)/);
});

test('Settings > Creative Playbook has the editor below Proven Winners, loaded when the panel opens', () => {
  const panel = html.slice(html.indexOf('id="settings-panel-creative-playbook"'));
  assert.ok(panel.indexOf('id="pw-add-btn"') < panel.indexOf('Required Concepts by Stock') && panel.indexOf('Required Concepts by Stock') < panel.indexOf('<h2>Creative Resources</h2>'));
  for (const id of ['crt-editor', 'crt-add-btn', 'crt-defaults-btn', 'crt-discard-btn', 'crt-save-btn']) assert.ok(panel.includes(`id="${id}"`), id);
  assert.match(panel, /busiest colourway: Stock on Hand \+ On Order together/); assert.match(panel, /Concepts already planned are never removed/);
  assert.match(app, /if \(name === 'creative-playbook'\) loadCreativeTargetEditor\(\);/);
  assert.match(css, /\.crt-editor\{/);
});

test('editor behaviour: only the end of each range and its number are typed, starts follow, the last range is "and above", Save only when valid and changed', () => {
  const fn = app.slice(app.indexOf('const crtFrom ='), app.indexOf("document.getElementById('crt-add-btn')"));
  assert.match(fn, /const crtFrom = \(i\) => \(i === 0 \? 1 : \(Number\(crtRows\[i - 1\]\.max\) \|\| 0\) \+ 1\);/);
  assert.match(fn, /soh_max: i === crtRows\.length - 1 \? null : Number\(r\.max\)/);
  assert.match(fn, /crtRows\[crtRows\.length - 1\]\.max = null;/, 'removing the last range makes the one before it "and above"');
  assert.match(fn, /save-btn'\)\.disabled = !dirty \|\| !!bad/);
  assert.match(fn, /method: 'PUT'/); assert.match(fn, /catch \(e\) \{ toast\(e\.message, true\); crtRefreshState\(\); \}/, 'a refused save shows the reason');
});

test('the bulk save releases its database client exactly once, even when the new set is refused (a double release crashes the server)', () => {
  const fn = route.slice(route.indexOf("router.put('/', async"), route.indexOf("router.post('/', async"));
  assert.equal((fn.match(/client\.release\(\)/g) || []).length, 1);
  assert.match(fn, /finally \{ client\.release\(\); \}/);
});
