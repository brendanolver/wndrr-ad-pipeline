'use strict';
// v1.4.3: small tilts in a catalogue picture are levelled in the small thumbnails. The estimator is pure (silhouette symmetry), so it is tested on drawn silhouettes of a known tilt.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const UX = require('../public/ux');

// a tee-like silhouette (body + two sleeves), dark on white, rotated by `deg` clockwise (the same convention as CSS rotate)
function drawTee(deg, opts = {}) {
  const w = 240; const h = 220; const data = new Uint8ClampedArray(w * h * 4).fill(255);
  const t = deg * Math.PI / 180; const c = Math.cos(t); const s = Math.sin(t); const cx = w / 2; const cy = h / 2;
  const inside = (x, y) => {
    const body = Math.abs(x) <= 52 && y >= -75 && y <= 80;
    const rightSleeve = x > 40 && x <= 95 && y >= -75 && y <= -35 - (x - 40) * 0.2;
    const leftSleeve = opts.oneSleeve ? false : (x < -40 && x >= -95 && y >= -75 && y <= -35 - (-x - 40) * 0.2);
    return body || rightSleeve || leftSleeve;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const lx = (x - cx) * c + (y - cy) * s; const ly = -(x - cx) * s + (y - cy) * c; // the source point shown at this pixel
    if (inside(lx, ly)) { const k = (y * w + x) * 4; data[k] = 20; data[k + 1] = 20; data[k + 2] = 30; }
  }
  return { data, w, h };
}
const tilt = (deg, opts) => { const p = drawTee(deg, opts); return UX.garmentTilt(p.data, p.w, p.h, null); };

test('a level garment is left alone', () => {
  assert.equal(tilt(0), 0);
});

test('a small tilt gives the rotation that levels it (same convention as CSS rotate)', () => {
  for (const deg of [1.5, 2, 3, 4]) {
    const got = tilt(deg); assert.ok(Math.abs(got + deg) <= 0.6, `tilted ${deg} -> ${got}`);
    const back = tilt(-deg); assert.ok(Math.abs(back - deg) <= 0.6, `tilted ${-deg} -> ${back}`);
  }
});

test('a tilt too small to see is not touched, and nothing clear enough means no rotation', () => {
  assert.equal(tilt(0.3), 0);
  const white = new Uint8ClampedArray(120 * 100 * 4).fill(255);
  assert.equal(UX.garmentTilt(white, 120, 100, null), 0, 'no garment');
  const tiny = drawTee(0); tiny.data.fill(255); tiny.data[(110 * tiny.w + 120) * 4] = 0;
  assert.equal(UX.garmentTilt(tiny.data, tiny.w, tiny.h, null), 0, 'a speck is not a garment');
});

test('a large "tilt" is more likely a pose or a design than a crooked picture: no rotation', () => {
  assert.equal(tilt(12), 0); assert.equal(tilt(-15), 0);
});

test('an asymmetric garment never gets a wild rotation', () => {
  const got = tilt(0, { oneSleeve: true }); assert.ok(Math.abs(got) <= 5, String(got));
});

test('only the chosen view is measured: the front half of a front-and-back picture', () => {
  const a = drawTee(0); const w = a.w * 2; const data = new Uint8ClampedArray(w * a.h * 4).fill(255);
  const front = drawTee(2.5); const back = drawTee(-4);
  for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) { const k = (y * a.w + x) * 4; const f = (y * w + x) * 4; const b = (y * w + a.w + x) * 4; for (let i = 0; i < 4; i++) { data[f + i] = front.data[k + i]; data[b + i] = back.data[k + i]; } }
  const got = UX.garmentTilt(data, w, a.h, { x0: 0, y0: 0, x1: a.w, y1: a.h });
  assert.ok(Math.abs(got + 2.5) <= 0.6, `front half -> ${got}`);
});

test('the placement carries the rotation about the garment\'s own centre; no tilt means no transform', () => {
  const measured = { x0: 100, y0: 50, x1: 500, y1: 450 };
  const g = UX.garmentFitGeometry(1200, 600, 64, 64, 'Short', false, { ...measured, tilt: -1.5 });
  assert.equal(g.tilt, -1.5); assert.deepEqual(g.origin, { x: 25, y: 41.67 }, 'origin = the garment box centre, as a share of the picture');
  assert.equal(UX.garmentFitGeometry(1200, 600, 64, 64, 'Short', false, measured).tilt, 0);
  assert.equal(UX.garmentFitGeometry(1200, 600, 64, 64, 'Short', false, null).tilt, 0);
});

test('wiring: measured once with the box, applied as a CSS rotation, cached with a new key so older cached boxes are re-measured', () => {
  const ux = fs.readFileSync(path.join(__dirname, '..', 'public', 'ux.js'), 'utf8');
  assert.match(ux, /tilt: garmentTilt\(data, cw, ch, pair \?/);
  assert.match(ux, /transform:rotate\(\$\{g\.tilt\}deg\);transform-origin:\$\{g\.origin\.x\}% \$\{g\.origin\.y\}%;/);
  assert.match(ux, /sessionStorage\.getItem\('gt2:' \+ key\)/);
  assert.match(ux, /data-gt-tilt/);
  assert.equal(UX.garmentImgHtml({ url: 'https://x.example/a.png', category: 'Short' }).includes('rotate'), false, 'nothing is rotated until it has been measured');
});
