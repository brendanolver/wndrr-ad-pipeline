'use strict';
// Core Product Catalogue: five columns (Product | Sales (7D) | Stock | Creative Status | Action). The functions are taken straight from app.js; sales and stock are the existing Demand Planning
// numbers, and the Creative Status is the Core table's own engine result re-worded for a badge (nothing is reclassified here).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const PE = require('../public/planningExplain');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const app = read('public', 'app.js'); const pl = read('public', 'planning.js'); const html = read('public', 'index.html'); const css = read('public', 'styles.css');
const fnSrc = (src, name) => { const i = src.indexOf(`function ${name}(`); return src.slice(i, src.indexOf('\n}\n', i) + 2); };
const escapeHtml = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const names = ['coreFamilies', 'coreFamilySales', 'coreSalesCellHtml', 'coreFamilyStock', 'coreStockCellHtml', 'coreCreativeStatus', 'coreFamilyPriority', 'coreFamilyInfo', 'coreFamilySelected', 'coreActionHtml'];
const state = { coreProducts: [] };
const plCatalogueSupport = new Function('plNum', `${fnSrc(pl, 'plCatalogueSupport')}; return plCatalogueSupport;`)((v) => Number(v || 0).toLocaleString('en-AU'));
const C = new Function('state', 'escapeHtml', 'PE', 'plCatalogueSupport', 'PL_BLOCKED', `
  const coreNum = (n) => Number(n).toLocaleString('en-AU');
  let coreFamilyCache = { src: null, n: -1, list: [] };
  const coreNeedsAttention = (info) => !!info && (info.cat === 'needs' || info.cat === 'review');
  ${names.map((n) => fnSrc(app, n)).join('\n')}
  return { ${names.join(', ')}, coreNeedsAttention };`)(state, escapeHtml, PE, plCatalogueSupport, ['not_launched', 'launch_unknown', 'unavailable']);
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&uarr;/g, '↑').replace(/&darr;/g, '↓').replace(/&rarr;/g, '→').replace(/&mdash;/g, '—').replace(/\s+/g, ' ').trim();
const prod = (code, o = {}) => ({ product_code: code, product_name: o.name || 'Offend Tee', category: o.cat || 'TEES', colours: o.colours || [], soh: 'soh' in o ? o.soh : 100, on_order: 'oo' in o ? o.oo : 50, vel30: 'vel30' in o ? o.vel30 : 10, weeks_cover: 'wk' in o ? o.wk : 10, cadence: o.cadence, flag: o.flag });
const cad = (cur, prev, pct) => ({ has_data: true, last_7d_units: cur, prev_7d_units: prev, last_7d_pct_change: pct });

test('Sales (7D): total units with the exact % change against the previous 7 days; green up, red down, grey otherwise', () => {
  const one = C.coreFamilySales({ members: [prod('A', { cadence: cad(120, 100, 20) })] });
  assert.deepEqual(one, { cur: 120, prev: 100, pct: 20 });
  assert.equal(text(C.coreSalesCellHtml(one)), '120 ↑ 20%'); assert.match(C.coreSalesCellHtml(one), /data-tone="up"/);
  const down = C.coreFamilySales({ members: [prod('A', { cadence: cad(40, 50, -20) })] });
  assert.equal(text(C.coreSalesCellHtml(down)), '40 ↓ 20%'); assert.match(C.coreSalesCellHtml(down), /data-tone="down"/);
  const flat = C.coreFamilySales({ members: [prod('A', { cadence: cad(50, 50, 0) })] });
  assert.equal(text(C.coreSalesCellHtml(flat)), '50 → 0%'); assert.match(C.coreSalesCellHtml(flat), /data-tone="flat"/);
  const fresh = C.coreFamilySales({ members: [prod('A', { cadence: cad(8, 0, null) })] });
  assert.equal(text(C.coreSalesCellHtml(fresh)), '8 New', 'nothing sold the week before: no % is invented'); assert.match(C.coreSalesCellHtml(fresh), /data-tone="flat"/);
  assert.equal(text(C.coreSalesCellHtml(C.coreFamilySales({ members: [prod('A', {})] }))), '—', 'no sales data');
  assert.equal(text(C.coreSalesCellHtml(C.coreFamilySales({ members: [prod('A', { cadence: { has_data: false } })] }))), '—');
});

test('Sales (7D) of a family is computed from its colourways\' unit totals, not by averaging their percentages', () => {
  const fam = { members: [prod('A', { cadence: cad(30, 10, 200) }), prod('B', { cadence: cad(10, 90, -89) })] };
  const s = C.coreFamilySales(fam);
  assert.deepEqual(s, { cur: 40, prev: 100, pct: -60 }, '(40 - 100) / 100');
  const noPrev = C.coreFamilySales({ members: [prod('A', { cadence: cad(30, 10, 200) }), prod('B', { cadence: { has_data: true, last_7d_units: 5, last_7d_pct_change: 0 } })] });
  assert.equal(noPrev.pct, undefined, 'without the previous-7-day units for every colourway the change cannot be worked out, so none is shown');
  assert.equal(text(C.coreSalesCellHtml(noPrev)), '35 —');
  assert.deepEqual(C.coreFamilySales({ members: [prod('A', { cadence: cad(0, 0, 0) }), prod('B', {})] }), { cur: 0, prev: 0, pct: 0 }, 'a colourway with no sales rows counts as zero');
});

test('Stock: stock on hand first, weeks of cover underneath; on order stays out of the row', () => {
  const s = C.coreFamilyStock({ members: [prod('A', { soh: 1240, wk: 12.4 })] });
  const h = C.coreStockCellHtml(s);
  assert.equal(text(h), '1,240 12.4 weeks cover'); assert.doesNotMatch(h, /order|incoming/i);
  const fam = C.coreFamilyStock({ members: [prod('A', { soh: 100, vel30: 10 }), prod('B', { soh: 50, vel30: 5, oo: 7 })] });
  assert.deepEqual(fam, { soh: 150, onOrder: 57, weeks: 10, noSales: false });
  assert.equal(text(C.coreStockCellHtml(C.coreFamilyStock({ members: [prod('A', { soh: 20, vel30: 0, wk: null })] }))), '20 No recent sales');
  assert.equal(text(C.coreStockCellHtml(C.coreFamilyStock({ members: [prod('A', { soh: null, oo: null })] }))), '—');
});

test('colourways of one product (same category and name) are one family; different names or categories are not', () => {
  state.coreProducts = [prod('A1', { name: 'Offend Tee' }), prod('A2', { name: 'OFFEND TEE' }), prod('B1', { name: 'Other Tee' }), prod('C1', { name: 'Offend Tee', cat: 'HOODIES' })];
  const f = C.coreFamilies();
  assert.deepEqual(f.map((x) => x.members.map((m) => m.product_code)), [['A1', 'A2'], ['B1'], ['C1']]);
});

const needs = (label, extra = {}) => ({ cat: 'needs', high: false, it: { status: 'act', key: 'k', product_code: 'A1', facts: { unique_creatives: 2, performing: 0, active_ads: 2 }, last_creative: { creatives_total: 5 }, ...(extra.it || {}) }, st: { label, tone: 'red', text: 'x' } });
test('Creative Status: one badge and one short line, from the engine\'s own result', () => {
  const gap = needs('No Active Creative'); gap.st.text = 'Strong sales, but no ads currently running.';
  let cs = C.coreCreativeStatus(null, gap);
  assert.deepEqual([cs.label, cs.tone, cs.line], ['Creative Gap', 'red', '0 active ads']);
  const never = needs('No Active Creative', { it: { last_creative: { creatives_total: 0 }, facts: { unique_creatives: 0, active_ads: 0 } } });
  assert.equal(C.coreCreativeStatus(null, never).label, 'Never Tested');
  const under = needs('Underperforming Creative', { it: { facts: { unique_creatives: 4, performing: 2, active_ads: 4 } } });
  cs = C.coreCreativeStatus(null, under); assert.deepEqual([cs.label, cs.line], ['Underperforming Creative', '2 of 4 active ads performing']);
  const covered = { cat: 'covered', it: { status: 'covered' }, st: { label: 'Performing Well', tone: 'green', text: '3 effective creatives currently running.' } };
  cs = C.coreCreativeStatus(null, covered); assert.deepEqual([cs.label, cs.tone], ['Covered', 'green']);
  cs = C.coreCreativeStatus(null, { cat: 'covered', it: { status: 'in_production' }, st: { label: 'In Production', tone: 'amber', text: 'A concept is already progressing through the Shoot Plan.' } }); assert.equal(cs.label, 'In Production');
  cs = C.coreCreativeStatus(null, { cat: 'review', it: {}, st: { label: 'Matching Uncertain', tone: 'grey', text: 'Some ads may belong to this product.' } }); assert.deepEqual([cs.label, cs.tone], ['Needs Review', 'grey']);
  cs = C.coreCreativeStatus(null, { cat: 'hidden', it: {}, st: { label: 'Not Recommended', tone: 'grey', text: 'Weak demand.' } }); assert.equal(cs.label, 'Not Recommended');
  assert.equal(C.coreCreativeStatus(null, null).label, 'Not Assessed', 'no result for the product');
  const html = C.coreCreativeStatus(null, gap); assert.ok(html.title.includes('No Active Creative'), 'the engine\'s own label stays in the tooltip');
});

test('Action: every product can be added; black + Shoot where creative is needed, an outline one where it is not recommended, ✓ Shooting once selected', () => {
  const fam = { id: 'A1', name: 'Offend Tee', members: [prod('A1')] };
  const all = (info) => C.coreActionHtml(fam, info, new Set());
  assert.match(all(needs('x')), /class="cat2-shoot"[^>]*data-opp-add="k"[^>]*>\+ Shoot</, 'engine result: the Creative Opportunities add, which carries the ticked colourways');
  assert.match(C.coreActionHtml(fam, needs('x'), new Set(['A1'])), /✓ Shooting/); assert.doesNotMatch(C.coreActionHtml(fam, needs('x'), new Set(['A1'])), /\+ Shoot/);
  for (const cat of ['covered', 'hidden', 'review']) assert.match(all({ cat, it: { key: 'k', status: 'weak_demand' } }), /data-opp-add="k"[^>]*>\+ Shoot</, `${cat}: still has + Shoot`);
  assert.match(all({ cat: 'hidden', it: { key: 'k', status: 'low_stock' } }), /cat2-shoot cat2-shoot-quiet/, 'not recommended: the quieter outline');
  assert.doesNotMatch(all(needs('x')), /cat2-shoot-quiet/);
  assert.match(C.coreActionHtml(fam, null, new Set()), /onclick="shootThisWeekForCore\('A1'\)"/, 'no engine result: the existing Shoot Plan form');
  assert.match(all({ cat: 'hidden', it: { key: 'k', status: 'not_launched' } }), /class="cat2-view"/, 'not launched: cannot be planned, so only View (the server refuses it too)');
});

test('Priority order: needs creative (High first), needs review, in production, testing, covered; the server flag only before results load', () => {
  const fam = (f) => ({ members: [prod('A', { flag: f })] });
  const rank = (info) => C.coreFamilyPriority(fam(), info);
  const hi = { ...needs('x'), high: true, it: { ...needs('x').it, score: 10 } };
  const order = [hi, needs('x'), { cat: 'review', it: {} }, { cat: 'covered', it: { status: 'in_production' } }, { cat: 'covered', it: { status: 'testing' } }, { cat: 'covered', it: { status: 'covered' } }, { cat: 'hidden', it: {} }];
  const ranks = order.map(rank); assert.deepEqual([...ranks].sort((a, b) => b - a), ranks);
  assert.ok(C.coreFamilyPriority(fam('needs_attention'), null) > C.coreFamilyPriority(fam('opportunity'), null));
});

test('markup: heading, search, Priority / By Category, three simple filters; five columns; no Key Reasons', () => {
  const panel = html.slice(html.indexOf('id="core-view-catalogue"'), html.indexOf('id="planning-step-high-stocks"'));
  assert.match(panel, /All Core Products/); assert.match(panel, /placeholder="Search products…"/);
  assert.match(panel, /data-view="category">By Category[\s\S]*data-view="priority">Priority/);
  for (const f of ['all', 'attention', 'production']) assert.match(panel, new RegExp(`data-core-filter="${f}"`));
  assert.match(panel, /All Products[\s\S]*Needs Attention[\s\S]*In Production/); assert.match(panel, /Showing|core-cat-count/);
  assert.doesNotMatch(panel, /View All Core Products|Core Shoot Planning|Key Reasons/);
  assert.match(app, /<span class="cat2-prod">Product<\/span><span class="cat2-c-sales">Sales \(7D\)<\/span><span class="cat2-c-stock">Stock<\/span><span class="cat2-c-status">Creative Status<\/span><span class="cat2-c-action">Action<\/span>/);
  assert.doesNotMatch(app, /Key Reasons|corePriorityRowHtml|core-reason-chip/);
});

test('the Creative Opportunities list stays separate: the catalogue neither renders into it nor changes the engine', () => {
  const render = fnSrc(app, 'renderCoreShootPlanning');
  assert.match(render, /core-shoot-planning-list/); assert.doesNotMatch(render, /core-plan'|plRenderCore|plPageHtml/);
  const body = app.slice(app.indexOf('// ── Core Product Catalogue'), app.indexOf('// ── Planning: High Stocks'));
  assert.doesNotMatch(body, /fetch\(|api\(/, 'no new data source: it reads state.coreProducts and the engine results already loaded');
  assert.match(html, /id="core-plan" class="core-plan"/);
});

test('the server adds the previous-7-day units to each product\'s cadence (the % formula is unchanged)', () => {
  const rp = read('src', 'lib', 'reportPipeline.js');
  assert.match(rp, /prev_7d_units: Math\.round\(prev7d\)/);
  assert.equal((rp.match(/last_7d_pct_change: prev7d > 0 \? Math\.round\(\(\(last7d - prev7d\) \/ prev7d\) \* 100\) : \(last7d > 0 \? null : 0\)/g) || []).length, 2, 'both windows keep the same % rule');
  assert.match(read('src', 'routes', 'coreProducts.js'), /prev_7d_units: null/);
});

test('styling: white rows with soft dividers, a black + Shoot, soft badge tones, no full-row tint', () => {
  assert.match(css, /\.cat2-shoot\{[^}]*background:#111/); assert.match(css, /\.cat2-badge\[data-tone="red"\]/); assert.match(css, /\.cat2-delta\[data-tone="up"\]\{color:#15803d/);
  assert.match(css, /\.cat2-item\{border-bottom:1px solid var\(--border\)/);
  assert.doesNotMatch(css.slice(css.indexOf('Core Product Catalogue: five columns')), /\.cat2-item\.open\{[^}]*background/);
});

test('expanded product: the Creative Opportunities components, a banner only when attention is needed, collapsed More details', () => {
  const d = fnSrc(app, 'coreFamilyDetailHtml');
  for (const c of ['plMainImg(', 'plCoreThumbs(', 'plMetricCard(', 'plCreativeCardHtml(', 'plCoreColourCards(it)', 'plHasMetaAds(it)', 'data-opp-meta=']) assert.ok(d.includes(c), `reuses ${c}`);
  assert.match(d, /info && info\.cat === 'needs'\s*\?[\s\S]*PE\.whyShoot\(it, cfg\)[\s\S]*:\s*''/, 'the recommendation banner is only for products the engine says need creative, with the engine\'s own sentence');
  assert.match(d, /<details class="cat2-more"[^>]*>(?!.*\bopen\b)/, 'More details is a collapsed disclosure');
  assert.match(d, /head: 'Sales'/); assert.match(d, /head: 'Inventory'/); assert.match(d, /vs previous 7 days/); assert.match(d, /units in 30 days/);
  const more = fnSrc(app, 'coreFamilyMoreHtml');
  for (const k of ['Previous 7 days', 'Weekly rate 7D / 30D / 365D', 'monthly sales vs last year', 'Same days last year', 'Creatives ever made', 'Weeks of cover', 'On order']) assert.ok(more.includes(k), k);
  assert.match(pl, /plRenderCore, plRenderHighStocks, renderCoreShootPlanning/, 'a Shoot Plan change refreshes the catalogue too');
});

test('Creative Performance card is one shared implementation for the Core table and the catalogue', () => {
  assert.match(fnSrc(pl, 'plCoreMetrics'), /plCreativeCardHtml\(it\)/);
  assert.match(fnSrc(app, 'coreFamilyDetailHtml'), /plCreativeCardHtml\(it, lead\)/);
});

test('By Category is the default: category rows with the category numbers, the products (five columns) under each', () => {
  assert.match(app, /coreView: 'category'/);
  const render = fnSrc(app, 'renderCoreShootPlanning');
  assert.match(render, /plCatalogueStats\(products, eng\)/); assert.match(render, /b\.eng\.needs - a\.eng\.needs/, 'categories ranked by how many need creative');
  assert.match(render, /searching \|\| state\.coreShootExpandedCategories\.has\(cat\.name\)/, 'a search or filter opens the categories with matches');
  const row = fnSrc(app, 'coreShootCategoryRowHtml');
  for (const f of ['core7dCellHtml(trend)', 'coreCadenceCellHtml(trend)', 'coreCategoryAttentionHtml(cat)', 'coreCategoryFreshnessHtml(cat)', 'coreSelectedHtml(cat.selectedCount)', 'coreFamilyRowHtml(r, selectedCodes)']) assert.ok(row.includes(f), f);
  assert.match(fnSrc(app, 'coreCatalogueListClick'), /core-shoot-category-toggle[\s\S]*toggleCoreShootCategory/);
});
