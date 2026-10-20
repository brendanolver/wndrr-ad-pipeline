'use strict';
// Batch 39: UI & workflow refinements. The same-origin picture route (server), and static contracts for the tray remove control, the shared status control, the owner field and
// the concept editor navigation. Geometry of the shared garment helper is covered in batch38.test.js; the rendered result is QA'd in the browser on the isolated database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { createRouter } = require('../src/routes/productImage');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const app = read('public', 'app.js');
const pl = read('public', 'planning.js');
const html = read('public', 'index.html');
const css = read('public', 'styles.css');
const server = read('src', 'server.js');

const KNOWN = 'https://img.example/known.png';
function hdrs(o) { return { get: (k) => o[k.toLowerCase()] }; }
async function call(deps, url) {
  const a = express(); a.use('/api/product-image', createRouter(deps));
  const srv = http.createServer(a); await new Promise((r) => srv.listen(0, r));
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/product-image?u=${encodeURIComponent(url)}`);
    return { status: res.status, type: res.headers.get('content-type'), cache: res.headers.get('cache-control'), body: Buffer.from(await res.arrayBuffer()) };
  } finally { srv.close(); }
}
const okFetch = (type = 'image/png', bytes = Buffer.from('PNG')) => async () => ({ ok: true, status: 200, headers: hdrs({ 'content-type': type, 'content-length': String(bytes.length) }), arrayBuffer: async () => bytes });
const known = { amData: async () => ({ amDetails: new Map([['A', { imageUrl: KNOWN, images: [] }]]) }), pool: { query: async () => ({ rows: [] }) } };

test('picture route: serves a picture the application already holds, as an image, privately cacheable', async () => {
  const r = await call({ ...known, fetchImpl: okFetch() }, KNOWN);
  assert.equal(r.status, 200); assert.equal(r.type, 'image/png'); assert.match(r.cache, /private/); assert.equal(r.body.toString(), 'PNG');
});

test('picture route: a picture saved on a Shoot Plan item is also known', async () => {
  const deps = { amData: async () => ({ amDetails: new Map() }), pool: { query: async (sql, p) => ({ rows: p[0] === KNOWN ? [{}] : [] }) }, fetchImpl: okFetch() };
  assert.equal((await call(deps, KNOWN)).status, 200);
});

test('picture route: not an open proxy (unknown address, http, junk, non-images and oversize are refused)', async () => {
  let fetched = 0; const spy = async (...a) => { fetched++; return okFetch()(...a); };
  assert.equal((await call({ ...known, fetchImpl: spy }, 'https://evil.example/x.png')).status, 404);
  assert.equal((await call({ ...known, fetchImpl: spy }, 'http://img.example/known.png')).status, 400);
  assert.equal((await call({ ...known, fetchImpl: spy }, 'not a url')).status, 400);
  assert.equal(fetched, 0, 'nothing unknown is ever fetched');
  assert.equal((await call({ ...known, fetchImpl: okFetch('text/html') }, KNOWN)).status, 502);
  const big = async () => ({ ok: true, status: 200, headers: hdrs({ 'content-type': 'image/png', 'content-length': String(9 * 1024 * 1024) }), arrayBuffer: async () => Buffer.alloc(1) });
  assert.equal((await call({ ...known, fetchImpl: big }, KNOWN)).status, 502);
  assert.equal((await call({ ...known, fetchImpl: async () => ({ ok: false, status: 404, headers: hdrs({}) }) }, KNOWN)).status, 502);
});

test('picture route is mounted behind authentication', () => {
  assert.match(server, /app\.use\('\/api\/product-image', requireAuth, require\('\.\/routes\/productImage'\)\)/);
});

test('Planning tray: every thumbnail has a keyboard- and touch-reachable remove control that uses the guarded removal', () => {
  assert.match(pl, /class="pl-tray-x" data-pl-tray-remove="\$\{i\.id\}"/); assert.match(pl, /aria-label="Remove .* from this week's Shoot Plan"/);
  assert.match(pl, /removeShootPlanItem\(Number\(x\.dataset\.plTrayRemove\)\)/, 'the same removal (confirmation, protected concepts, refresh) as the Shoot Plan tile');
  assert.match(css, /\.pl-tray-th:hover \.pl-tray-x|\.pl-tray-th:focus-within \.pl-tray-x/); assert.match(css, /@media \(hover:none\)\{[^}]*\.pl-tray-x\{opacity:1/);
  const fn = app.slice(app.indexOf('async function removeShootPlanItem'));
  assert.match(fn.slice(0, 2500), /\/shoot-plan\/\$\{id\}\/removal/); assert.match(fn.slice(0, 2500), /plRefreshSelection/);
});

test('one garment helper for the tray, the tiles and Upcoming Drops', () => {
  assert.match(pl, /UX\.garmentImgHtml\(/); assert.match(app, /UX\.garmentImgHtml\(\{ url: img, front: item\.front_image_url/);
  assert.match(app, /function renderProductViewImages/); assert.match(app, /UX\.productImgFullHtml\(/);
  assert.match(css, /\.gt-big img\.gt-full\{[^}]*object-fit:contain|\.gt-full\{[^}]*object-fit:contain/);
});

test('New Concept: an Assigned To field from the team list, defaulting to Mark, saved with the concept and shown in the editor', () => {
  assert.match(html, /<select id="adhoc-concept-owner"/);
  assert.match(app, /function populateOwnerSelect\(selectId, selected\)/); assert.match(app, /conceptAssignees\(\)/);
  const fn = app.slice(app.indexOf('function populateOwnerSelect'), app.indexOf('function populateOwnerSelect') + 900);
  assert.match(fn, /'Mark'/, 'Mark is the default'); assert.doesNotMatch(fn, /INSERT|users/i);
  assert.match(app, /populateOwnerSelect\('adhoc-concept-owner'\)/);
  assert.match(app, /concept_assignee: owner/); assert.match(app, /populateOwnerSelect\('cd-modal-assignee-select'/);
  const r = read('src', 'routes', 'creativeAssets.js');
  assert.match(r, /UPDATE shoot_plan_items spi SET creator = \$1/); assert.match(r, /spi\.source = 'manual'/, 'only manual entries follow the owner, never a Planning or Drops entry');
});

test('concept editor navigation: pills centred and evenly spaced, indicator and Show all on their own side, measured compact layout', () => {
  assert.match(html, /<div class="cdm-pills" role="group"/); assert.match(html, /<div class="cdm-meta">/);
  for (const sec of ['Idea', 'Audience', 'Hook', 'Production', 'References', 'Shoot Setup']) assert.match(html, new RegExp(`>\\s*(?:<span[^>]*></span>)?\\s*(?:The )?${sec}\\s*<`));
  assert.match(css, /#cdm-nav \.cdm-pills\{[^}]*justify-content:center/); assert.match(css, /#cdm-nav\.cdm-compact \.cdm-pills\{flex:1 1 100%/);
  assert.match(app, /function cdModalFitNav/); assert.match(app, /paddingLeft/, 'the available width excludes the nav padding');
  assert.match(app, /cdModalFitNav\(\);\s*\}/, 'refit whenever the section marks change');
});

test('Shooting and Editing share one status control: one line, every stage reachable, forwards and backwards through the existing endpoints', () => {
  assert.match(app, /function stageStepperHtml\(stages\)/);
  assert.match(app, /function shootingStatusControlHtml/); assert.match(app, /function editingStatusControlHtml/);
  const move = app.slice(app.indexOf('async function shootingMoveStage'), app.indexOf('async function shootingMoveStage') + 2200);
  for (const e of ['start', 'unstart', 'mark-shot', 'unmark-shot']) assert.match(move, new RegExp(`'${e}'`));
  assert.match(move, /confirmDialog/, 'leaving Filmed asks first and explains the effect');
  assert.match(app, /function editingExplainSubmitted/); assert.match(app, /Request Changes/);
  assert.match(css, /\.shoot-status-control\{[^}]*flex-wrap:nowrap/); assert.match(css, /@container \(max-width: 270px\)/);
  assert.doesNotMatch(app.slice(app.indexOf('function stageStepperHtml'), app.indexOf('const SHOOT_STAGES')), /DELETE|method: 'DELETE'/, 'a stage change never deletes anything');
});

test('no database change in this batch', () => {
  const sql = read('db', 'schema.sql'); assert.doesNotMatch(sql, /Batch 39/);
});
