'use strict';
// Meta Mapping: a searchable product picker (type, then pick a result) replaces the long dropdown; "Map" still saves the chosen family's code and name exactly as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const fn = (name) => { const i = app.indexOf(`function ${name}(`); return app.slice(i, app.indexOf('\n}\n', i) + 2); };
const escapeHtml = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const state = { metaProductFamilies: ['HALO SWEAT SET', 'HALO BAGGY TRACKPANT', 'REAPER LAYERED L/S TEE', 'REAPER CARPENTER SHORT', 'MAISON 1/4 ZIP SWEAT'].map((n, i) => ({ product_code: `F${i}`, product_name: n })) };
const { mpmMatches, mpmSuggest, mpmHighlight } = new Function('state', 'escapeHtml', `const mpmNorm = ${app.slice(app.indexOf('const mpmNorm = ') + 'const mpmNorm = '.length, app.indexOf(';\n', app.indexOf('const mpmNorm = ')))}; ${fn('mpmMatches')}${fn('mpmSuggest')}${fn('mpmHighlight')} return { mpmMatches, mpmSuggest, mpmHighlight };`)(state, escapeHtml);
const names = (r) => r.list.map((f) => f.product_name);

test('typing filters by every word, in the name or the code; the best matches come first', () => {
  assert.deepEqual(names(mpmMatches('halo bag', 8)), ['HALO BAGGY TRACKPANT']);
  assert.deepEqual(names(mpmMatches('reaper', 8)), ['REAPER CARPENTER SHORT', 'REAPER LAYERED L/S TEE']);
  assert.deepEqual(names(mpmMatches('f1', 8)), ['HALO BAGGY TRACKPANT'], 'the product code works too');
  assert.deepEqual(names(mpmMatches('1/4 zip', 8)), ['MAISON 1/4 ZIP SWEAT']);
  assert.deepEqual(names(mpmMatches('zzzz', 8)), []); assert.equal(mpmMatches('', 8).total, 0);
  assert.equal(mpmMatches('halo', 1).list.length, 1); assert.equal(mpmMatches('halo', 1).total, 2, 'the total says how many more there are');
});

test('with nothing typed it suggests the families that share the most words with the Meta product', () => {
  assert.deepEqual(names(mpmSuggest('HALO SWEAT SET - ZIP + JUMBO - CAMO SWEATS', 3))[0], 'HALO SWEAT SET');
  assert.deepEqual(names(mpmSuggest('MOTIF REAPER LAYERED L/S TEES', 3))[0], 'REAPER LAYERED L/S TEE');
});

test('matches are highlighted and escaped', () => {
  assert.equal(mpmHighlight('HALO BAGGY', ['bag']), 'HALO <mark>BAG</mark>GY');
  assert.equal(mpmHighlight('A<b>', ['b']), 'A&lt;<mark>b</mark>&gt;');
});

test('wiring: no dropdown; Map is disabled until a family is picked and still saves its code and name', () => {
  const row = fn('metaProductMappingRowHtml');
  assert.doesNotMatch(row, /<select|select internal product family/); assert.match(row, /role="combobox"/); assert.match(row, /id="mpm-map-\$\{m\.id\}"[^>]*disabled/);
  const resolve = fn('resolveMetaProductMapping');
  assert.match(resolve, /mpm-code-\$\{id\}/); assert.match(resolve, /product_code: productCode, product_name: family \? family\.product_name : productCode/);
  assert.match(app, /ArrowDown[\s\S]*Enter[\s\S]*Escape/, 'keyboard: arrows, Enter, Escape');
});
