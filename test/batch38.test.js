'use strict';
// Batch 38: single-view garment thumbnails (Planning tray + Shoot Plan tiles) and full creative dates (Core and High Stocks Creative coverage).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const app = read('public', 'app.js'); const pl = read('public', 'planning.js'); const css = read('public', 'styles.css'); const uxSrc = read('public', 'ux.js');
const am = require('../src/lib/apparelmagic');

// ux.js is a browser script (an IIFE assigned to UX); evaluate it with a stub window
const sandbox = { window: {}, document: { addEventListener() {} } };
vm.createContext(sandbox); vm.runInContext(`${uxSrc}\nthis.UX = UX;`, sandbox);
const UX = sandbox.UX;
const exp = (v) => Math.round(v * 100) / 100;
const plain = (o) => JSON.parse(JSON.stringify(o)); // objects made inside the vm context are not reference-equal to ours

test('thumbnail: a front+back composite (two tees) shows only the front half, centred, not stretched', () => {
  const g = UX.garmentFitGeometry(1600, 800, 64, 64, 'TEES', false); // two portrait-ish views side by side: the front half is square
  assert.deepEqual(plain(g), { view: 'front-crop', left: 0, top: 0, width: 200, height: 100 });
});
test('thumbnail: a wide composite (two shorts) fits the front half inside the box and centres it vertically', () => {
  const g = UX.garmentFitGeometry(2000, 900, 64, 64, 'SHORTS', false);
  assert.equal(g.view, 'front-crop'); assert.equal(g.left, 0); assert.equal(g.width, 200);
  assert.equal(g.height, exp(100 / (2000 / 900 / 2)), 'the half keeps its own aspect ratio'); assert.equal(g.top, exp((100 - g.height) / 2));
});
test('thumbnail: two tall bottoms are only about square side by side, and are still recognised as two views', () => {
  const g = UX.garmentFitGeometry(1100, 900, 64, 64, 'CARGO PANT', false);
  assert.equal(g.view, 'front-crop'); assert.ok(g.left > 0 && g.left < 50, 'a portrait half is centred horizontally'); assert.equal(g.top, 0); assert.equal(g.height, 100);
  assert.equal(UX.garmentFitGeometry(1100, 900, 64, 64, 'BOX FIT TEE', false).view, 'whole', 'the same shape for a tee is one view (a tee pair is clearly wider)');
  assert.equal(UX.garmentFitGeometry(1100, 900, 64, 64, 'DENIM SHORT', false).view, 'whole', 'shorts are not treated as long bottoms');
});
test('thumbnail: pictures that are already one view are left whole; so is a separate front picture; bad input is safe', () => {
  assert.equal(UX.garmentFitGeometry(800, 900, 64, 64, 'TEES', false).view, 'whole', 'portrait');
  assert.equal(UX.garmentFitGeometry(1000, 1000, 64, 64, 'TEES', false).view, 'whole', 'square');
  assert.equal(UX.garmentFitGeometry(1400, 1000, 64, 64, 'SHORTS', false).view, 'whole', 'a single landscape product shot is not cut in half');
  assert.equal(UX.garmentFitGeometry(2000, 800, 64, 64, 'TEES', true).view, 'whole', 'an individual front picture is never cropped');
  for (const bad of [[0, 0, 64, 64], [1600, 800, 0, 0], [NaN, 800, 64, 64]]) assert.equal(UX.garmentFitGeometry(bad[0], bad[1], bad[2], bad[3], 'TEES', false).view, 'whole');
});
test('thumbnail: the same geometry works for any box size (tray 40px, tile 64px, rectangular)', () => {
  const small = UX.garmentFitGeometry(1600, 800, 40, 40, 'TEES', false); const big = UX.garmentFitGeometry(1600, 800, 64, 64, 'TEES', false);
  assert.deepEqual(plain(small), plain(big), 'percentages of the box, so the size does not matter');
  const wide = UX.garmentFitGeometry(1600, 800, 100, 50, 'TEES', false);
  assert.equal(wide.view, 'front-crop'); assert.ok(wide.width <= 200 && wide.height <= 100);
});
test('thumbnail markup: front picture first, one img, missing image gives nothing (the placeholder icon shows), URLs are escaped', () => {
  assert.equal(UX.garmentImgHtml({ url: '' }), ''); assert.equal(UX.garmentImgHtml(null), '');
  const front = UX.garmentImgHtml({ url: 'https://x/composite.png', front: 'https://x/front.png', category: 'TEES' });
  assert.match(front, /src="https:\/\/x\/front\.png"/); assert.match(front, /data-gt-single="1"/); assert.doesNotMatch(front, /composite/);
  const comp = UX.garmentImgHtml({ url: 'https://x/a.png?x=1&y="2"', category: 'SHORTS' });
  assert.match(comp, /class="gt-img"/); assert.match(comp, /onload="UX\.garmentFit\(this\)"/); assert.match(comp, /onerror="this\.remove\(\)"/); assert.doesNotMatch(comp, /data-gt-single/); assert.doesNotMatch(comp, /y="2"/);
});
test('tray and tiles use the SAME helper (one picture, one rule)', () => {
  assert.match(pl, /UX\.garmentImgHtml\(\{ url: img, front: i\.front_image_url,/);
  assert.match(app, /UX\.garmentImgHtml\(\{ url: img, front: item\.front_image_url,/);
  assert.doesNotMatch(css.slice(css.indexOf('.pl-tray-th img')), /^[^\n]*pl-tray-th img\{[^}]*object-fit:cover/, 'no centre-crop with object-fit: cover');
  assert.doesNotMatch(css.slice(css.indexOf('.sp2-thumb img{')), /^[^\n]*object-fit:cover/);
});
test('a separate FRONT picture is offered by the server only when ApparelMagic labels one (front and back both labelled)', () => {
  const route = read('src', 'routes', 'shootPlan.js');
  assert.match(route, /pick\.layout === 'front_back' && pick\.front/); assert.match(route, /front_image_url: frontByItem\.get\(i\.id\) \|\| null/);
  const composite = am.pickFrontBack([{ url: 'https://c/1.png', catalog: true, role: null }]);
  assert.equal(composite.layout, 'single', 'the normal catalogue case is one composite picture');
  const sep = am.pickFrontBack([{ url: 'https://c/f.png', role: 'front', role_basis: 'label' }, { url: 'https://c/b.png', role: 'back', role_basis: 'label' }]);
  assert.equal(sep.layout, 'front_back'); assert.equal(sep.front.url, 'https://c/f.png');
});

// ── dates
const E = require('../public/planningExplain.js');
const cov = (date, total = 5) => E.coverage({ facts: { live_creatives: 1 }, last_creative: { creatives_total: total, last_creative_uploaded_date: date, possibly_newer_undated: false } }, '2026');
test('creative coverage date always carries the year it was recorded with (2024, 2025, 2026, any month)', () => {
  assert.equal(cov('2024-08-28').latest, '28 Aug 2024');
  assert.equal(cov('2025-09-30').latest, '30 Sep 2025');
  assert.equal(cov('2026-09-18').latest, '18 Sep 2026', 'even the current year is written out');
  assert.equal(cov('2025-01-05').latest, '5 Jan 2025'); assert.equal(cov('2026-12-31').latest, '31 Dec 2026'); assert.equal(cov('2024-02-29').latest, '29 Feb 2024');
});
test('creative coverage date: the year is the source date\'s own, never the current year or a guess; the reference year is ignored', () => {
  assert.equal(E.coverage({ facts: { live_creatives: 1 }, last_creative: { creatives_total: 2, last_creative_uploaded_date: '2023-03-09' } }, '2031').latest, '9 Mar 2023');
  assert.equal(E.coverage({ facts: { live_creatives: 1 }, last_creative: { creatives_total: 2, last_creative_uploaded_date: '2023-03-09' } }).latest, '9 Mar 2023');
});
test('creative coverage date: missing or impossible dates show a placeholder, never an invented date', () => {
  assert.equal(cov(null).latest, 'Unknown'); assert.equal(cov(null, 0).latest, 'None'); assert.equal(cov('').latest, 'Unknown');
  for (const bad of ['2026-13-45', '2026-02-30', 'not a date', '26-09-18', '2026-00-10']) { const c = cov(bad); assert.equal(c.latest, 'Unknown', bad); assert.equal(c.latestKnown, false); }
  assert.equal(E.coverage({}, '2026').latest, null, 'nothing loaded: no date');
  assert.equal(E.coverage({ last_creative: {} }, '2026').latest, null);
});
test('Core and High Stocks share ONE coverage cell, so one formatting change covers both', () => {
  const cell = pl.slice(pl.indexOf('function plCoreCoverageCell'), pl.indexOf('function plCoreStatusCell'));
  assert.match(cell, /PE\.coverage\(it,/); assert.match(cell, /Latest:/);
  assert.match(pl, /plCoreTableHtml\(mode, items, cat\)/); assert.match(pl, /plCoreCoverageCell\(it\)\}\$\{plCoreStatusCell\(it\)/);
  assert.doesNotMatch(pl, /toLocaleDateString|\.getFullYear\(\)/, 'no second date formatter in the Planning page');
});
test('the long form (tooltips, expanded view) still reads "D Month YYYY"', () => {
  assert.equal(E.longDate('2025-09-30'), '30 September 2025'); assert.equal(E.longDate('2026-02-30'), null);
});
