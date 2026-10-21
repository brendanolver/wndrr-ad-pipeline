'use strict';
// v1.4.1: the "Browse the full Core catalogue" panel. Its Creative Attention / Creative Freshness are the Core table's own results; the panel header is prominent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const pl = read('public', 'planning.js');
const app = read('public', 'app.js');
const html = read('public', 'index.html');
const css = read('public', 'styles.css');
const fn = (src, name) => { const i = src.indexOf(`function ${name}(`); return src.slice(i, src.indexOf('\n}\n', i) + 2); };

// plFreshBand is pure: evaluate it on its own
const plFreshBand = new Function(`${fn(pl, 'plFreshBand')}; return plFreshBand;`)();
const cov = (o) => ({ known: true, latestKnown: true, latest: '1 Jan 2026', days: 10, ...o });

test('freshness bands use the engine\'s own windows (recent / stale days from the Planning settings)', () => {
  const cfg = { recent_creative_days: 30, stale_creative_days: 90 };
  assert.deepEqual(plFreshBand(cov({ days: 0 }), cfg), { key: 'fresh', label: 'Recent' });
  assert.equal(plFreshBand(cov({ days: 29 }), cfg).key, 'fresh');
  assert.equal(plFreshBand(cov({ days: 30 }), cfg).key, 'aging');
  assert.equal(plFreshBand(cov({ days: 89 }), cfg).key, 'aging');
  assert.equal(plFreshBand(cov({ days: 90 }), cfg).key, 'stale');
  assert.equal(plFreshBand(cov({ days: 10 }), { recent_creative_days: 7, stale_creative_days: 14 }).key, 'aging', 'follows the settings, not a fixed number');
  assert.equal(plFreshBand(cov({ days: 10 }), {}).key, 'fresh', 'defaults 30 / 90 when settings are not present');
});

test('freshness: nothing on record is stale; creatives without a reliable date get NO band; nothing loaded gives none', () => {
  const cfg = {};
  assert.deepEqual(plFreshBand(cov({ latestKnown: false, latest: 'None', days: null }), cfg), { key: 'stale', label: 'No creative' });
  assert.equal(plFreshBand(cov({ latestKnown: false, latest: 'Unknown', days: null }), cfg), null);
  assert.equal(plFreshBand(cov({ days: null }), cfg), null);
  assert.equal(plFreshBand({ known: false, latest: null }, cfg), null);
  assert.equal(plFreshBand(null, cfg), null);
});

test('the catalogue reads the Core table\'s results (status, category, priority, coverage) and classifies nothing itself', () => {
  const map = fn(pl, 'plCatalogueMap');
  for (const f of ['PE.coverage(', 'PE.categoryOf(', 'PE.coreStatus(']) assert.ok(map.includes(f), f);
  assert.match(map, /it\.codes/, 'keyed by product code (and the item\'s other codes)');
  assert.match(fn(pl, 'plCatalogueFreshnessHtml'), /plAgo\(c\.days\)/, 'date, then how long ago, then the band');
});

test('the catalogue rows use those results; the older flags are only a fallback while they are not loaded (Core Product Catalogue)', () => {
  const render = fn(app, 'renderCoreShootPlanning');
  assert.match(render, /plCatalogueMap\(\)/, 'the Core table\'s own results');
  assert.match(fn(app, 'coreFamilyPriority'), /p\.flag === 'needs_attention'/, 'the older flag orders products only while the results are not loaded');
  assert.match(fn(app, 'coreCreativeStatus'), /plCatalogueSupport\(info\)/);
  assert.match(app, /data-core-fam/);
  assert.match(pl, /renderCoreShootPlanning\(\); \} catch \(e\) \{ console\.error\('core catalogue render failed'/, 're-rendered when the Planning results arrive');
});

test('the Core page has ONE tab bar (Creative Opportunities | All Core Products); only the selected view shows (v1.4.2)', () => {
  assert.match(html, /<div class="core-tabs" id="core-tabs" role="tablist"/);
  assert.match(html, /data-core-tab="opportunities"[\s\S]*data-core-tab="catalogue"/);
  assert.match(html, /<div id="core-plan" class="core-plan" role="tabpanel"/);
  assert.match(html, /<div class="core-catalogue-panel" id="core-view-catalogue" role="tabpanel"[^>]*\bhidden\b/, 'the catalogue is its own panel, hidden until its tab is chosen');
  assert.doesNotMatch(html, /core-browse|<summary>Browse the full/, 'the dropdown is gone');
  const apply = fn(pl, 'plApplyCoreTab');
  assert.match(apply, /aria-selected/); assert.match(apply, /opp\.hidden = tab !== 'opportunities'/); assert.match(apply, /cat\.hidden = tab !== 'catalogue'/);
  assert.match(apply, /o\.core\.actionable/, 'the Opportunities count is the table\'s own "needs creative" total');
  assert.ok(!/wndrr\.coreTab|sessionStorage/.test(fn(pl, 'plCoreTab') + fn(pl, 'plSetCoreTab')), 'the tab is not remembered between visits: Core always opens on Creative Opportunities'); assert.match(app, /if \(key === 'core' && \(!fromHash \|\| state\.planningStep !== 'core'\)\) state\.coreTab = 'opportunities';/); assert.match(pl, /ArrowRight/); assert.match(pl, /ev\.key === 'Home'/);
  assert.match(pl, /host\.innerHTML = plPageHtml\('core'\);\n  plApplyCoreTab\(\);/, 're-applied whenever the Core table re-renders');
  assert.match(css, /\.core-tab\.active\{[^}]*border-bottom-color/); assert.match(css, /\.core-plan\[hidden\],\.core-catalogue-panel\[hidden\]\{display:none;\}/);
});
