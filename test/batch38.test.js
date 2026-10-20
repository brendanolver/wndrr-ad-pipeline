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
  const o = plain(g);
  assert.equal(o.view, 'front-crop'); assert.deepEqual([o.left, o.top, o.width, o.height], [0, 0, 200, 100]);
  assert.deepEqual(o.clip, { t: 0, r: 50, b: 0, l: 0 }, 'the back half is clipped from the picture itself');
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
  assert.deepEqual(plain(small).clip, plain(big).clip, 'the clip is a share of the picture, so the size does not matter');
  assert.deepEqual([small.left, small.top, small.width, small.height], [big.left, big.top, big.width, big.height], 'the placement is a share of the box, so the size does not matter');
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
  assert.match(cell, /PE\.coverage\(it,/); assert.match(cell, /pt-cov-d/); assert.match(cell, /plAgo\(c\.days\)/, 'the date, then how long ago');
  assert.match(pl, /plCoreTableHtml\(mode, items, cat\)/); assert.match(pl, /plCoreCoverageCell\(it\)\}\$\{why \? plCoreWhyCell\(it\) : plCoreStatusCell\(it\)\}/, 'the status cell, or only the engine sentence in Other High Stock Products');
  assert.doesNotMatch(pl, /toLocaleDateString|\.getFullYear\(\)/, 'no second date formatter in the Planning page');
});
test('the long form (tooltips, expanded view) still reads "D Month YYYY"', () => {
  assert.equal(E.longDate('2025-09-30'), '30 September 2025'); assert.equal(E.longDate('2026-02-30'), null);
});

// ── Batch 39: centring the garment (measured box) and the picture-reading maths
const rgba = (w, h, fn) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = fn(x, y); const k = (y * w + x) * 4; d[k] = c[0]; d[k + 1] = c[1]; d[k + 2] = c[2]; d[k + 3] = c[3] === undefined ? 255 : c[3]; } return d; };
const WHITE = [255, 255, 255]; const BLUE = [31, 63, 160];
test('garment box: the bounding box of the garment on a white page', () => {
  const d = rgba(100, 50, (x, y) => (x >= 20 && x < 40 && y >= 10 && y < 40 ? BLUE : WHITE));
  assert.deepEqual(plain(UX.garmentBBox(d, 100, 50)), { x0: 20, y0: 10, x1: 40, y1: 40 });
});
test('garment box: transparent pictures, coloured backgrounds, specks and the back view are handled', () => {
  const tr = rgba(100, 50, (x, y) => (x >= 30 && x < 60 && y >= 5 && y < 45 ? [10, 10, 10, 255] : [255, 255, 255, 0]));
  assert.deepEqual(plain(UX.garmentBBox(tr, 100, 50)), { x0: 30, y0: 5, x1: 60, y1: 45 }, 'transparent background');
  const grey = rgba(100, 50, (x, y) => (x >= 10 && x < 30 && y >= 10 && y < 30 ? BLUE : [230, 230, 232]));
  assert.deepEqual(plain(UX.garmentBBox(grey, 100, 50)), { x0: 10, y0: 10, x1: 30, y1: 30 }, 'a light-grey page is the background, not the garment');
  const speck = rgba(100, 50, (x, y) => ((x >= 20 && x < 40 && y >= 10 && y < 40) || (x === 90 && y === 3) ? BLUE : WHITE));
  assert.deepEqual(plain(UX.garmentBBox(speck, 100, 50)), { x0: 20, y0: 10, x1: 40, y1: 40 }, 'a single stray pixel does not stretch the box');
  const pair = rgba(200, 50, (x, y) => (y >= 5 && y < 45 && ((x >= 15 && x < 45) || (x >= 120 && x < 180)) ? BLUE : WHITE));
  assert.deepEqual(plain(UX.garmentBBox(pair, 200, 50, { x0: 0, y0: 0, x1: 100, y1: 50 })), { x0: 15, y0: 5, x1: 45, y1: 45 }, 'only the chosen (front) half is measured');
  assert.equal(UX.garmentBBox(rgba(100, 50, () => WHITE), 100, 50), null, 'nothing but background');
  assert.equal(UX.garmentBBox(new Uint8ClampedArray(4), 100, 50), null, 'bad data');
});
test('centring: a garment drawn off-centre in the front half lands in the middle of the thumbnail, in proportion and unclipped', () => {
  // a 1600x800 composite; the front garment sits well to the left of its half (x 80..360, y 120..700)
  const g = UX.garmentFitGeometry(1600, 800, 64, 64, 'SHORTS', false, { x0: 80, y0: 120, x1: 360, y1: 700 });
  assert.equal(g.view, 'front-crop');
  const px = (pct, size) => pct / 100 * size;
  const imgW = px(g.width, 64); const imgH = px(g.height, 64); const left = px(g.left, 64); const top = px(g.top, 64);
  assert.equal(exp(imgW / imgH), exp(1600 / 800), 'the picture keeps its own proportions (no stretching)');
  const cx = left + (80 + 360) / 2 / 1600 * imgW; const cy = top + (120 + 700) / 2 / 800 * imgH;
  assert.ok(Math.abs(cx - 32) < 0.5 && Math.abs(cy - 32) < 0.5, `the garment centre is the box centre (${cx}, ${cy})`);
  const gx0 = left + 80 / 1600 * imgW; const gx1 = left + 360 / 1600 * imgW; const gy0 = top + 120 / 800 * imgH; const gy1 = top + 700 / 800 * imgH;
  assert.ok(gx0 >= 0 && gy0 >= 0 && gx1 <= 64 && gy1 <= 64, 'the whole garment is inside the box');
  assert.ok(gx0 > 0.5 && gy0 > 0.5, 'with even padding around it');
  assert.ok(g.clip.r >= 50 - 1e-6 || g.clip.r > 0, 'the back view is clipped away');
});
test('centring: padding is even on all sides for tall and wide garments, and a single view is centred too', () => {
  for (const [nw, nh, m] of [[1600, 800, { x0: 100, y0: 60, x1: 700, y1: 740 }], [2000, 900, { x0: 150, y0: 200, x1: 850, y1: 700 }]]) {
    const g = UX.garmentFitGeometry(nw, nh, 64, 64, 'TEES', false, m);
    const W = g.width / 100 * 64; const H = g.height / 100 * 64; const L = g.left / 100 * 64; const T = g.top / 100 * 64;
    const left = L + m.x0 / nw * W; const right = 64 - (L + m.x1 / nw * W); const top = T + m.y0 / nh * H; const bottom = 64 - (T + m.y1 / nh * H);
    assert.ok(Math.abs(left - right) < 0.6 && Math.abs(top - bottom) < 0.6, `balanced margins ${[left, right, top, bottom].map(exp)}`);
  }
  const one = UX.garmentFitGeometry(800, 900, 64, 64, 'TEES', false, { x0: 50, y0: 40, x1: 500, y1: 860 });
  assert.equal(one.view, 'centred'); assert.ok(one.clip.t > 0 || one.clip.l > 0 || one.clip.r > 0 || one.clip.b >= 0);
});
test('centring: an unmeasured picture is still shown (front half or whole) and never throws', () => {
  assert.equal(UX.garmentFitGeometry(1600, 800, 64, 64, 'TEES', false, null).view, 'front-crop');
  assert.equal(UX.garmentFitGeometry(800, 900, 64, 64, 'TEES', false, null).view, 'whole');
  assert.equal(UX.garmentFitGeometry(1600, 800, 64, 64, 'TEES', false, { x0: 10, y0: 10, x1: 10, y1: 50 }).view, 'front-crop', 'an empty measurement is ignored');
});
test('large preview: the whole picture, contained; missing url gives nothing', () => {
  assert.equal(UX.productImgFullHtml({ url: '' }), '');
  const h = UX.productImgFullHtml({ url: 'https://x/a.png', alt: 'Tee' });
  assert.match(h, /class="gt-full"/); assert.match(h, /onerror="this\.remove\(\)"/); assert.doesNotMatch(h, /garmentFit/);
  assert.match(css, /\.gt-big img\.gt-full\{[^}]*object-fit:contain/);
});
test('Upcoming Drops: the card tiles and the product header show whole pictures', () => {
  assert.match(app, /dpc-img">\$\{UX\.productImgFullHtml\(\{ url: p\.image_url, alt: p\.product_name \}\)/);
  assert.ok(!/gt-box-48">\$\{UX\.garmentImgHtml\(\{ url: s\.image_url,/.test(app.slice(app.indexOf('function renderProductViewImages('), app.indexOf('function renderProductSummary('))), 'the product header and colourway panel carry no repeated thumbnails');
  assert.match(app, /gt-big">\$\{UX\.productImgFullHtml\(\{ url, alt: group\.product_name \}\)/);
});
