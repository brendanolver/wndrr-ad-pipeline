// Batch 36: CSV import parsing for the copy library, AI key detection diagnostics, creative-preview classification helpers and Ad Setup naming labels.
// Pure functions only: no network, no database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseCsv, detectDelimiter } = require('../src/lib/csvParse');
const lib = require('../src/lib/copyLibrary');
const ai = require('../src/lib/copyAi');
const naming = require('../src/lib/adSetupNaming');

test('csv: quoted fields, doubled quotes, embedded commas and line breaks', () => {
  const rows = parseCsv('Product,Primary Text\n"Asset Raglan Tee","Line one,\nline two ""quoted"""\nCargo,Plain copy here\n');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], ['Product', 'Primary Text']);
  assert.equal(rows[1][1], 'Line one,\nline two "quoted"');
  assert.deepEqual(rows[2], ['Cargo', 'Plain copy here']);
});

test('csv: CRLF, BOM, trailing blank lines, tab and semicolon delimiters', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n1,2\r\n\r\n'), [['a', 'b'], ['1', '2']]);
  assert.equal(detectDelimiter('a\tb\tc'), '\t');
  assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv(''), []);
  assert.doesNotThrow(() => parseCsv('a,"unterminated'));
});

test('csv import rows feed the same library parser as a Sheets read', () => {
  const rows = parseCsv('Product,Headline,Primary Text\nAsset Raglan Tee,ASSET RAGLAN TEE,"Your new favourite tee.\nBoxy fit, soft feel, made to wear on repeat."\n');
  const parsed = lib.parseTab(rows, { title: 'CORE' });
  assert.equal(parsed.header_found, true);
  assert.equal(parsed.examples.length, 1);
  assert.match(parsed.examples[0].body, /Boxy fit, soft feel/);
  assert.equal(parsed.examples[0].headline, 'ASSET RAGLAN TEE');
});

test('ai config: a pasted key with quotes / spaces is accepted; the key is never returned in the reason', () => {
  const cfg = ai.aiConfig({ ANTHROPIC_API_KEY: '  "sk-ant-secret-123"  ' });
  assert.equal(cfg.configured, true);
  assert.equal(cfg.key, 'sk-ant-secret-123');
  assert.equal(cfg.reason, null);
});

test('ai config: missing, empty and misnamed variables are told apart (names only, never values)', () => {
  const missing = ai.aiConfig({});
  assert.equal(missing.configured, false);
  assert.match(missing.reason, /not set on this server/);
  assert.match(missing.reason, /Railway service/);
  const empty = ai.aiConfig({ ANTHROPIC_API_KEY: '   ' });
  assert.equal(empty.configured, false);
  assert.match(empty.reason, /value is empty/);
  const near = ai.aiConfig({ ANTHROPIC_KEY: 'sk-ant-should-not-appear' });
  assert.equal(near.configured, false);
  assert.match(near.reason, /ANTHROPIC_KEY/);
  assert.doesNotMatch(near.reason, /should-not-appear/);
});

test('ad setup naming: Sign Up page label exists and an unselected URL page renders as the * placeholder', () => {
  assert.equal(naming.URL_LINK_PAGE_LABELS.sign_up, 'Sign Up Page');
  const name = naming.buildMetaAdName({ batchNumber: 215, weekNo: '26-WK42', adDate: '2026-10-15', productName: 'Asset Raglan', productCategory: 'Box Fit Tee', hookShort: 'STYLE', mediaType: 'video', adType: 'single', creatorName: 'Mark', conceptLabel: 'Fit Check', urlLinkPage: null, adCategory: 'core' });
  assert.ok(name.endsWith('_*'), name);
  assert.match(name, /^#215_26-WK42_15-10_ASSET RAGLAN_BOX FIT TEE_STYLE_Video_Single_MARK_FIT CHECK_/);
});

test('ad setup naming: the full catalogue name splits into product name and category without guessing', () => {
  assert.deepEqual(naming.splitProductName('Asset Raglan Box Fit Tee', null), { name: 'Asset Raglan', category: 'Box Fit Tee' });
  assert.deepEqual(naming.splitProductName('Asset Raglan Box Fit Tee', 'APPAREL'), { name: 'Asset Raglan', category: 'Box Fit Tee' });
  assert.deepEqual(naming.splitProductName('Mystery Item', null), { name: 'Mystery Item', category: null });
});

// The Meta naming algorithm itself must be untouched: the segment order and rules in buildMetaAdName are pinned by the 1.2.x tests; this guards the labels.
test('ad setup naming: existing URL page labels keep their text (names of historical ads must not change)', () => {
  assert.equal(naming.URL_LINK_PAGE_LABELS.product, 'Product');
  assert.equal(naming.URL_LINK_PAGE_LABELS.new_arrivals, 'New Arrivals');
  assert.equal(naming.URL_LINK_PAGE_LABELS.sale_bundle, 'Sale/Bundle Page');
});

// Front-end contract checks (static): the pieces the new UI depends on exist and the removed ones are really gone.
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('public/app.js');
const html = read('public/index.html');
const ux = read('public/ux.js');

test('lifecycle menu offers Kill Concept only (and Restore for an archived record); Move Back is on Shooting and Editing cards', () => {
  assert.match(app, /actions\.filter\(\(a\) => a\.key === 'kill' \|\| a\.key === 'unarchive'\)/);
  assert.doesNotMatch(app, /Archive \/ Kill \/ Remove&hellip;/);
  assert.match(app, /Kill Concept&hellip;/);
  assert.equal((app.match(/moveBackMenuItemHtml\(/g) || []).length >= 3, true);
});

test('creative preview helper: creative first, product image as a labelled fallback, never the other way round', () => {
  assert.match(ux, /function creativeThumbHtml/);
  assert.match(ux, /Product image/);
  assert.match(ux, /data-fallback-image/);
});

test('Ad Setup UI: Product / Sale, typed batch, no generated-name panel', () => {
  assert.match(app, /AD_CATEGORY_CHOICES = \{ product: 'Product', sale: 'Sale' \}/);
  assert.match(app, /id="as-batch"/);
  assert.doesNotMatch(app, /as-name-card/);
  assert.doesNotMatch(app, /\+ New Batch/);
});

test('Review creative modal keeps its element ids and shortcuts', () => {
  for (const id of ['mm-f-products', 'mm-f-concept', 'mm-f-media', 'mm-f-creator', 'mm-f-style', 'mm-f-adsetup', 'mm-nps', 'mm-sess-confirm', 'mm-sess-skip', 'mm-sess-prev', 'mm-sess-close-btn', 'mm-error']) {
    assert.ok(app.includes(`id="${id}"`), id);
  }
  assert.match(app, /Previously matched ad found/);
  assert.match(app, /Check naming/);
  assert.match(app, /e\.key === 'ArrowLeft' && e\.altKey/);
  assert.match(html, /id="mm-modal-sub"/);
});

test('Settings: Upcoming Drops default assignment controls exist', () => {
  assert.match(html, /id="drop-default-assignee"/);
  assert.match(html, /id="drop-default-editor"/);
  assert.match(html, /id="drop-defaults-save-btn"/);
});
