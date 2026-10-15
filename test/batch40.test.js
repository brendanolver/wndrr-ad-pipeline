'use strict';
// Batch 40: Concept Development actions, Editing's three stages, Final Approval creative / naming / destination. Pure rules and static contracts; the rendered pages are QA'd in the browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const app = read('public', 'app.js');
const html = read('public', 'index.html');
const ux = read('public', 'ux.js');
const naming = require('../src/lib/adSetupNaming');
const pageUrl = require('../src/lib/productPageUrl');

test('Concept Development: one set of actions in the page header; the duplicate Creative Tools / New Concept beside "New Concepts" are gone', () => {
  const fn = app.slice(app.indexOf('function renderConceptDevProductWorkspace'), app.indexOf('function renderConceptDevProductWorkspace') + 900);
  assert.match(fn, /cd-workspace-toolbar-heading">New Concepts</);
  assert.doesNotMatch(fn, /Creative Tools|New Concept<\/button>|cd-new-concept-btn|openAddConceptModal/);
  assert.match(html, /id="cd-header-new-concept" onclick="conceptDevHeaderNewConcept\(\)">\+ New Concept/);
  assert.match(html, /onclick="openCreativeToolkit\(\)"[^>]*>[\s\S]*?Creative Toolkit/);
  const hdr = app.slice(app.indexOf('function conceptDevHeaderNewConcept'), app.indexOf('function conceptDevHeaderNewConcept') + 400);
  assert.match(hdr, /openAddConceptModal\(cd\.currentItemId\)/, 'inside a product it adds to that product');
  assert.match(hdr, /openAdHocConceptModal\(\)/);
});

test('Editing: three stages (Filmed, Editing, Approval); Booked is not a stage but the scheduling underneath is kept', () => {
  const fn = app.slice(app.indexOf('const EDITING_STAGES'), app.indexOf('async function editingExplainSubmitted'));
  assert.match(fn, /\[\['to_edit', 'Filmed'\], \['editing', 'Editing'\], \['ready_for_approval', 'Approval'\]\]/);
  assert.doesNotMatch(fn, /Booked|short:/);
  assert.match(fn, /status === 'scheduled' \? 0/, 'a concept with an editing day shows as Filmed until editing starts');
  assert.match(fn, /advanceEditingToInProgress/); assert.match(fn, /advanceEditingToEdited/); assert.match(fn, /editingMoveBackToFilmed/);
  assert.match(fn, /editingExplainSubmitted/, 'backwards from Approval goes through Request Changes in Final Approval');
  const bi = app.indexOf('async function editingMoveBackToFilmed'); const back = app.slice(bi, app.indexOf('\n}\n', bi));
  assert.match(back, /\/unstart/); assert.doesNotMatch(back, /editing_day|PATCH|DELETE/, 'the editing day, edits and links are untouched');
  assert.match(app, /const EDITING_STATUS_LABELS = \{ to_edit: 'Filmed', scheduled: 'Scheduled'/, 'the Scheduled status/summary still exists');
});

test('final creative: the finished edit is shown; the product catalogue picture is never substituted', () => {
  assert.match(ux, /function finalCreativeHtml/); assert.match(ux, /Final creative missing/);
  const fn = ux.slice(ux.indexOf('function finalCreativeHtml'), ux.indexOf('function productFallbackHtml'));
  assert.doesNotMatch(fn, /productFallbackHtml|productImage|creativeThumbHtml/);
  const modal = app.slice(app.indexOf('<div class="as-creative">'), app.indexOf('<div class="as-section-title">Final check</div>'));
  assert.match(modal, /UX\.finalCreativeHtml\(d\.final_edit_link/); assert.doesNotMatch(modal, /product_image_url|creativeThumbHtml/);
  assert.match(modal, /View creative/); assert.match(modal, /Final creative missing/);
  assert.match(app, /function adSetupMediaHtml\(item\) \{\s*return UX\.finalCreativeHtml/);
  assert.match(app, /UX\.finalCreativeHtml\(v\.final_edit_link/, 'the Final Approval strip too');
  const fe = ux.slice(ux.indexOf('function placeholderHtml'), ux.indexOf('function placeholderHtml') + 500);
  assert.match(fe, /preview unavailable/, 'a link that cannot be previewed says so');
});

test('naming: Product Name does not repeat the Product Category (structured category first, word rules otherwise)', () => {
  const s = naming.splitProductName;
  assert.deepEqual(s('ASSET RAGLAN BOX FIT TEE', 'BOX FIT TEE'), { name: 'ASSET RAGLAN', category: 'BOX FIT TEE' });
  assert.deepEqual(s('Asset Raglan Box Fit Tee', null), { name: 'Asset Raglan', category: 'Box Fit Tee' });
  assert.deepEqual(s('Rothman Sport Short', null), { name: 'Rothman', category: 'Sport Short' });
  assert.deepEqual(s('Hexed Box Fit Tee', null), { name: 'Hexed', category: 'Box Fit Tee' });
  assert.deepEqual(s('Offend Beach Short', null), { name: 'Offend', category: 'Beach Short' });
  assert.deepEqual(s('Linen Shirt', 'Shirt'), { name: 'Linen', category: 'Shirt' });
  assert.deepEqual(s('Cargo Pant', 'Pants'), { name: 'Cargo', category: 'Pants' });
  assert.deepEqual(s('Soho 1/4 Zips', null), { name: 'Soho', category: '1/4 Zips' });
  assert.deepEqual(s('WNDRR Cap', 'Accessories'), { name: 'WNDRR', category: 'Cap' }, 'a coarse bucket is not a category');
  assert.deepEqual(s('Asset Raglan Box Fit Tee', 'Tees'), { name: 'Asset Raglan', category: 'Box Fit Tee' }, 'a coarse category inside a specific type: the specific type wins');
  assert.deepEqual(s('Mystery Item', null), { name: 'Mystery Item', category: null }, 'no known garment word: nothing is guessed');
});

test('naming: meaningful words are not stripped (only a whole category run, not words here and there)', () => {
  assert.deepEqual(naming.splitProductName('Tee Time Box Fit Tee', 'Box Fit Tee'), { name: 'Tee Time', category: 'Box Fit Tee' });
  assert.deepEqual(naming.splitProductName('Asset Raglan Box Fit Tee Black', null), { name: 'Asset Raglan Black', category: 'Box Fit Tee' });
  assert.equal(naming.nameWithoutCategory('Rothman', 'Sport Short'), 'Rothman');
  assert.equal(naming.nameWithoutCategory('Box Fit Tee', 'Box Fit Tee'), 'Box Fit Tee', 'never reduced to nothing');
});

test('the generated Meta ad name keeps its structure and never says the category twice', () => {
  const base = { batchNumber: 215, weekNo: '26-WK39', adDate: '2026-09-24', hookShort: 'HOOK', mediaType: 'video', adType: 'single', creatorName: null, conceptLabel: 'Try on', urlLinkPage: 'product', adCategory: 'core' };
  const good = naming.buildMetaAdName({ ...base, productName: 'ASSET RAGLAN', productCategory: 'BOX FIT TEE' });
  const legacy = naming.buildMetaAdName({ ...base, productName: 'ASSET RAGLAN BOX FIT TEE', productCategory: 'BOX FIT TEE' });
  assert.equal(good, '#215_26-WK39_24-09_ASSET RAGLAN_BOX FIT TEE_HOOK_Video_Single_*_TRY ON_Product');
  assert.equal(legacy, good, 'a stored full name produces the same ad name');
  assert.equal(naming.URL_LINK_PAGE_LABELS.product, 'Product', 'the segment word is unchanged so existing names and matching still line up');
  assert.match(app, /const URL_LINK_PAGE_OPTION_LABELS = \{ \.\.\.URL_LINK_PAGE_LABELS, product: 'Product Page' \}/);
  assert.match(app, /adSetupNameWithoutCategory\(d\.product_label, d\.product_type\)/, 'the live preview matches the server');
});

test('product naming is display-only: nothing here writes to product records', () => {
  const r = read('src', 'routes', 'adSetup.js');
  const fn = r.slice(r.indexOf('async function normaliseLegacyProductLabel'), r.indexOf('async function applyDestinationDefaults'));
  assert.match(fn, /UPDATE ad_setups SET product_label/); assert.doesNotMatch(fn, /UPDATE styles|UPDATE shoot_plan_items|categories/);
  assert.match(fn, /full\.has\(/, 'only a Product Name that is still a linked product\'s full catalogue name is touched');
});

const variants = (list) => ({ productVariants: { nodes: list } });
const P1 = { id: 'gid://1', status: 'ACTIVE', onlineStoreUrl: 'https://wndrr.example/products/asset-raglan-box-fit-tee' };

test('product page URL: one published Shopify product with this product code', () => {
  const r = pageUrl.pickFromVariants([{ sku: 'W26JA004BLKS', product: P1 }, { sku: 'W26JA004BLKM', product: P1 }, { sku: 'W26JA005BLKS', product: { id: 'x', status: 'ACTIVE', onlineStoreUrl: 'https://x' } }], 'W26JA004');
  assert.equal(r.url, P1.onlineStoreUrl);
});

test('product page URL: nothing found, unpublished, or ambiguous gives no URL (never a guess)', () => {
  assert.equal(pageUrl.pickFromVariants([], 'W26JA004').reason, 'not_found');
  assert.equal(pageUrl.pickFromVariants([{ sku: 'W26JA004BLKS', product: { ...P1, onlineStoreUrl: null } }], 'W26JA004').reason, 'not_published');
  assert.equal(pageUrl.pickFromVariants([{ sku: 'W26JA004BLKS', product: { ...P1, status: 'DRAFT' } }], 'W26JA004').reason, 'not_published');
  assert.equal(pageUrl.pickFromVariants([{ sku: 'W26JA004BLKS', product: P1 }, { sku: 'W26JA004ROBS', product: { ...P1, id: 'gid://2' } }], 'W26JA004').reason, 'ambiguous');
});

test('product page URL: Shopify first, then the address a person saved earlier, else a clear "needs attention" answer', async () => {
  pageUrl._cache.clear();
  const ok = await pageUrl.resolveProductPageUrl('W26JA004', { gql: async () => variants([{ sku: 'W26JA004BLK', product: P1 }]) });
  assert.deepEqual([ok.url, ok.source], [P1.onlineStoreUrl, 'shopify']);
  pageUrl._cache.clear();
  const db = { query: async () => ({ rows: [{ destination_url: ' https://wndrr.example/products/rothman ' }] }) };
  const earlier = await pageUrl.resolveProductPageUrl('W26JA010', { gql: async () => variants([]), db });
  assert.deepEqual([earlier.url, earlier.source], ['https://wndrr.example/products/rothman', 'earlier_ad_setup']);
  pageUrl._cache.clear();
  const none = await pageUrl.resolveProductPageUrl('W26JA011', { gql: async () => variants([]), db: { query: async () => ({ rows: [] }) } });
  assert.equal(none.url, null); assert.ok(none.message);
  pageUrl._cache.clear();
  const denied = await pageUrl.resolveProductPageUrl('W26JA012', { gql: async () => { throw new Error('Shopify refused the token (HTTP 403)'); } });
  assert.equal(denied.url, null); assert.match(denied.message, /read_products/);
  const unconfigured = await pageUrl.resolveProductPageUrl('W26JA013', { env: {} });
  assert.equal(unconfigured.reason, 'shopify_not_configured');
  assert.equal((await pageUrl.resolveProductPageUrl(null, {})).url, null);
});

test('product page URL: read-only Shopify lookup; the token stays on the server', () => {
  const lib = read('src', 'lib', 'productPageUrl.js');
  assert.match(lib, /query ProductPageByProductCode/); assert.doesNotMatch(lib, /mutation|productUpdate|method: 'PUT'|method: 'DELETE'/i);
  assert.doesNotMatch(app, /SHOPIFY_ADMIN_TOKEN/);
});

test('destination default: one specific product (however many colourways) -> Product; sale / multi-product rules unchanged', () => {
  const { deriveUrlLinkPage, productScope } = require('../src/lib/adSetupProduct');
  const st = (code) => ({ style_code: code, name: 'x' });
  const one = productScope({ styles: [st('W26JA004BLK'), st('W26JA004ROB'), st('W26JA004WHT')], shootPlanItem: null });
  assert.deepEqual(one, { single: true, code: 'W26JA004' }, 'three colourways are one product');
  const many = productScope({ styles: [st('W26JA004BLK'), st('W26JA005BLK')], shootPlanItem: null });
  assert.equal(many.single, false);
  assert.equal(productScope({ styles: [], shootPlanItem: { product_code: 'w26ja009' } }).code, 'W26JA009');
  assert.equal(deriveUrlLinkPage('core', one, null), 'product');
  assert.equal(deriveUrlLinkPage('new_drop', one, null), 'product');
  assert.equal(deriveUrlLinkPage('core', many, null), 'new_arrivals');
  assert.equal(deriveUrlLinkPage('organic_first', { single: false, code: null }, null), 'new_arrivals');
  assert.equal(deriveUrlLinkPage('promotion', one, 'hype'), 'sign_up');
  assert.equal(deriveUrlLinkPage('promotion', one, 'sale_live'), null, 'sale ads are still chosen by the team');
});

test('destination defaults never overwrite a saved choice, and run the page default only once', () => {
  const r = read('src', 'routes', 'adSetup.js');
  const fn = r.slice(r.indexOf('async function applyDestinationDefaults'), r.indexOf("router.get('/:id', async"));
  assert.match(fn, /!row\.destination_defaulted_at/); assert.match(fn, /destination_defaulted_at IS NULL/);
  assert.match(fn, /const untouched = !String\(row\.destination_url \|\| ''\)\.trim\(\) && \(!row\.url_link_page \|\| row\.url_link_page === 'new_arrivals'\)/);
  assert.match(fn, /\(destination_url IS NULL OR btrim\(destination_url\) = ''\)/, 'a URL that is already there is never replaced');
  assert.match(fn, /row\.status !== 'draft'/);
  assert.match(r, /destination_defaulted_at\n?\s*\) VALUES|naming_prefilled_at, destination_defaulted_at/, 'new Ad Setups are created with the default already applied');
  const sql = read('db', 'schema.sql');
  const block = sql.slice(sql.indexOf('-- Batch 40:'), sql.indexOf('-- Approved Ad Matching concepts'));
  assert.match(block, /ALTER TABLE ad_setups ADD COLUMN IF NOT EXISTS destination_defaulted_at TIMESTAMPTZ;/);
  assert.doesNotMatch(block, /\b(DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE|UPDATE )/);
});

test('Final Check: Destination is ready only with a link page AND a valid web address (client and server)', () => {
  assert.match(app, /\{ label: 'Destination', ready: !!\(d\.url_link_page && adSetupHttpUrl\(d\.destination_url\)\) \}/);
  const r = read('src', 'routes', 'adSetup.js');
  assert.match(r, /!productPageUrl\.isHttpUrl\(row\.destination_url\)\) missing\.push/);
  assert.equal(pageUrl.isHttpUrl('https://wndrr.example/products/x'), true);
  assert.equal(pageUrl.isHttpUrl('wndrr.example/products/x'), false);
  assert.equal(pageUrl.isHttpUrl('javascript:alert(1)'), false);
  assert.equal(pageUrl.isHttpUrl(''), false);
  assert.match(app, /Paste the product page address/);
  assert.match(app, /async function adSetupChooseLinkPage/);
});

test('Meta copy functionality is untouched by this release', () => {
  const r = read('src', 'routes', 'adSetup.js');
  for (const frag of ['syncCopyRules', 'selected_primary_text', 'primary_text_approved', 'copy_set_id', 'copy_fields_manual']) assert.ok(r.includes(frag), frag);
  for (const frag of ['adSetupAiPanelHtml', 'adSetupCopySectionHtml', 'Library not loaded', 'selectAdSetupCopy']) assert.ok(app.includes(frag), frag);
});
