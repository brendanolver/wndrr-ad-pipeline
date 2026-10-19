'use strict';
// Core Shoot Planning, expanded product rows: product picture next to the name, status + priority with ONE supporting sentence, freshness led by the age of the newest creative, no tinted
// selected row. Display only: the status, priority, counts and freshness bands are the existing results.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const E = require('../public/planningExplain');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const pl = read('public', 'planning.js'); const app = read('public', 'app.js'); const css = read('public', 'styles.css');
const fnSrc = (src, name) => { const i = src.indexOf(`function ${name}(`); return src.slice(i, src.indexOf('\n}\n', i) + 2); };
const plEsc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const plNum = (v) => Number(v || 0).toLocaleString('en-AU');
const plAgo = (d) => (d === null || d === undefined ? '' : d === 0 ? 'today' : `${d} ${d === 1 ? 'day' : 'days'} ago`);
const { support, freshness } = new Function('plEsc', 'plNum', 'plAgo', `${fnSrc(pl, 'plCatalogueSupport')}${fnSrc(pl, 'plCatalogueFreshnessHtml')}; return { support: plCatalogueSupport, freshness: plCatalogueFreshnessHtml };`)(plEsc, plNum, plAgo);
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const item = (o = {}) => ({ it: { actionable: true, priority: 'High', facts: { unique_creatives: 2, performing: 0, active_ads: 2, demand_level: 'strong' }, ...(o.it || {}) }, st: { tone: 'red', label: 'Underperforming Creative', text: 'None of 2 creatives are performing.', ...(o.st || {}) }, cov: { known: true, latest: '30 Sep 2026', latestKnown: true, days: 19, title: 'x', ...(o.cov || {}) }, band: o.band === undefined ? { key: 'fresh', label: 'Recent' } : o.band });

test('attention: status and priority on one line, one supporting sentence built from the engine counts', () => {
  assert.equal(support(item()), '0 of 2 active ads performing');
  assert.equal(support(item({ it: { facts: { unique_creatives: 4, performing: 2, active_ads: 4 } }, st: { text: 'Only 2 of 4 creatives performing.' } })), '2 of 4 active ads performing');
  assert.equal(support(item({ st: { label: 'No Active Creative', text: 'Strong sales, but no ads currently running.' } })), 'Strong sales · 0 active ads');
  assert.equal(support(item({ st: { label: 'Low Creative Coverage', text: 'Depends on a single creative. Opportunity to test more.' } })), 'Depends on a single creative. Opportunity to test more.', 'other statuses keep the engine\'s own sentence');
});

test('freshness: age first with the band, the creative date underneath; unknown and missing states are grey / explicit', () => {
  const ok = freshness(item());
  assert.equal(text(ok), '19 days ago Recent 30 Sep 2026'); assert.match(ok, /data-band="fresh"/); assert.match(ok, /core-cat-datesub">30 Sep 2026/);
  assert.match(freshness(item({ band: { key: 'aging', label: 'Ageing' }, cov: { days: 31, latest: '18 Sep 2026' } })), /31 days ago[\s\S]*data-band="aging"[\s\S]*18 Sep 2026/);
  const stale = freshness(item({ band: { key: 'stale', label: 'Needs refresh' }, cov: { days: 120, latest: '1 Jun 2026' } })); assert.match(stale, /data-band="stale"[^>]*>Needs refresh/);
  assert.equal(text(freshness(item({ cov: { latest: 'None', latestKnown: false, days: null }, band: { key: 'stale', label: 'No creative' } }))), 'No creative Needs refresh');
  assert.equal(text(freshness(item({ cov: { latest: 'Unknown', latestKnown: false, days: null }, band: null }))), 'Date unknown Not assessed');
  const none = freshness(null); assert.equal(text(none), '&mdash; Not assessed'); assert.doesNotMatch(none, /data-band/);
  assert.match(ok, /not a Meta delivery date[\s\S]*not limited to new concepts/i, 'the tooltip says what the date is');
  assert.doesNotMatch(fnSrc(pl, 'plCatalogueFreshnessHtml').replace(/\/\/.*$/gm, ''), /new concept"|Last new concept/);
});

test('catalogue rows: a real picture next to every name; the row is not tinted', () => {
  const thumb = fnSrc(app, 'coreProductThumbHtml');
  assert.match(thumb, /info\.it\.image_url/); assert.match(thumb, /p\.colours/); assert.match(thumb, /#i-image/, 'the icon only when no picture exists');
  const row = fnSrc(app, 'coreFamilyRowHtml');
  assert.match(row, /coreProductThumbHtml\(fam\.members\[0\], info\)/); assert.match(row, /coreColourwaySuffixHtml/);
  assert.doesNotMatch(row, /background|core-row-selected/, 'a selected product is not a coloured row');
});

test('the existing calculations are untouched: status, priority and the freshness bands come from the same helpers', () => {
  assert.match(fnSrc(pl, 'plCatalogueSupport'), /info\.st/);
  assert.match(fnSrc(pl, 'plCatalogueMap'), /PE\.coreStatus/); assert.match(fnSrc(pl, 'plCatalogueMap'), /plFreshBand\(cov, cfg\)/);
  assert.equal(typeof E.coreStatus, 'function');
});

test('products that share a name are told apart by their real colourway (or product code), never an invented colour', () => {
  const src = fnSrc(app, 'coreNameSuffixes') ;
  const mk = (list) => { const state = { coreProducts: list }; const esc = (v) => String(v); const f = new Function('state', 'escapeHtml', `let coreSuffixCache = { src: null, n: -1, map: new Map() }; ${src}; const coreColourwaySuffixHtml = (p) => { const s = coreNameSuffixes().get(p.product_code); return s ? ' <span class="core-prod-colour">&mdash; ' + escapeHtml(s) + '</span>' : ''; }; return { map: coreNameSuffixes, html: coreColourwaySuffixHtml };`); return f(state, esc); };
  const P = (code, name, labels, cat = 'SHORTS') => ({ product_code: code, product_name: name, category: cat, colours: labels.map((l) => ({ colour_label: l })) });
  const a = mk([P('A1', 'Offend Beach Short', ['Black']), P('A2', 'Offend Beach Short', ['Grey']), P('B1', 'Rothman Sport Short', ['Black'])]);
  assert.equal(a.map().get('A1'), 'BLACK'); assert.equal(a.map().get('A2'), 'GREY'); assert.equal(a.map().has('B1'), false, 'a unique name gets no suffix');
  assert.match(a.html(P('A1', 'x', [])), /&mdash; BLACK/); assert.equal(a.html(P('B1', 'x', [])), '');
  const same = mk([P('A1', 'Offend Beach Short', ['Black']), P('A2', 'Offend Beach Short', ['Black'])]);
  assert.deepEqual([same.map().get('A1'), same.map().get('A2')], ['A1', 'A2'], 'colours that do not tell them apart: the real product code');
  const none = mk([P('A1', 'Offend Beach Short', []), P('A2', 'Offend Beach Short', ['Grey'])]);
  assert.deepEqual([none.map().get('A1'), none.map().get('A2')], ['A1', 'A2'], 'no colour name is invented for a product without one');
  const two = mk([P('A1', 'Hood', ['Black', 'Grey']), P('A2', 'Hood', ['Navy'])]); assert.equal(two.map().get('A1'), 'BLACK / GREY');
  const many = mk([P('A1', 'Hood', ['A', 'B', 'C']), P('A2', 'Hood', ['Navy'])]); assert.equal(many.map().get('A1'), 'A1', 'more than two colourways: the product code, not a guess');
  const other = mk([P('A1', 'Offend Beach Short', ['Black']), P('C1', 'Offend Beach Short', ['Black'], 'OTHER')]); assert.equal(other.map().size, 0, 'the same name in different categories is not a clash');
});
