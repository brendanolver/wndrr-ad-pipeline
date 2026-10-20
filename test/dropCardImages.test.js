'use strict';
// Upcoming Drops cards show each product's WHOLE picture (front and back) on a light grey tile, and the picture proxy / measurement no longer fail for long after one hiccup.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { createRouter } = require('../src/routes/productImage');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const app = read('public', 'app.js'); const css = read('public', 'styles.css'); const ux = read('public', 'ux.js');

test('card tile: the whole picture on a grey 2:1 tile, name and code left-aligned; no cropping or measuring', () => {
  const fn = app.slice(app.indexOf('function dropCardProductsHtml('), app.indexOf('function dropCardHtml('));
  assert.match(fn, /<span class="dpc-img">\$\{UX\.productImgFullHtml\(/); assert.ok(!/garmentImgHtml/.test(fn));
  assert.match(css, /\.dpc-img\{[^}]*aspect-ratio:2 \/ 1;[^}]*background:#e8e9eb;/);
  assert.match(css, /\.dpc-img img\.gt-full\{[^}]*object-fit:contain;/);
  assert.match(css, /\.drop-card-product-tile\{align-items:stretch;text-align:left;\}/);
});

async function probe(amData, now) {
  const realNow = Date.now; Date.now = () => now.t;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const router = createRouter({ amData, pool: { query: async () => ({ rows: [] }) }, fetchImpl: async () => ({ ok: true, headers: { get: (h) => (h === 'content-type' ? 'image/png' : null) }, arrayBuffer: async () => png }) });
  const a = express(); a.use('/p', router);
  const srv = await new Promise((r) => { const s = a.listen(0, () => r(s)); });
  const get = async () => (await fetch(`http://localhost:${srv.address().port}/p?u=${encodeURIComponent('https://img.example.com/a.png')}`)).status;
  return { get, done: () => { Date.now = realNow; srv.close(); } };
}

test('picture proxy: a failed ApparelMagic lookup is retried within seconds, not remembered for 10 minutes', async () => {
  let up = false; const now = { t: 1_000_000 };
  const p = await probe(async () => { if (!up) throw new Error('cold start'); return { amDetails: new Map([['S', { imageUrl: 'https://img.example.com/a.png', images: [] }]]) }; }, now);
  try {
    assert.equal(await p.get(), 404, 'unknown while ApparelMagic is down');
    up = true; now.t += 20_000;
    assert.equal(await p.get(), 200, 'served once the lookup is retried');
    up = false; now.t += 60_000;
    assert.equal(await p.get(), 200, 'a successful list is still cached normally');
  } finally { p.done(); }
});

test('measurement: a failed measurement is retried twice, later, before it is given up for the visit', () => {
  const onerr = ux.slice(ux.indexOf('probe.onerror = () => {'), ux.indexOf('probe.src = GT_PROXY'));
  assert.match(onerr, /gtTries/); assert.match(onerr, /n < 3/); assert.match(onerr, /setTimeout\(\(\) => \{ if \(img && img\.isConnected !== false\) garmentFit\(img\); \}, 15000 \* n\)/);
  assert.match(onerr, /else gtCache\.set\(key, false\)/);
});
