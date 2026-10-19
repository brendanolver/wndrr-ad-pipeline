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
const { support, attention, freshness } = new Function('plEsc', 'plNum', 'plAgo', `${fnSrc(pl, 'plCatalogueSupport')}${fnSrc(pl, 'plCatalogueAttentionHtml')}${fnSrc(pl, 'plCatalogueFreshnessHtml')}; return { support: plCatalogueSupport, attention: plCatalogueAttentionHtml, freshness: plCatalogueFreshnessHtml };`)(plEsc, plNum, plAgo);
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const item = (o = {}) => ({ it: { actionable: true, priority: 'High', facts: { unique_creatives: 2, performing: 0, active_ads: 2, demand_level: 'strong' }, ...(o.it || {}) }, st: { tone: 'red', label: 'Underperforming Creative', text: 'None of 2 creatives are performing.', ...(o.st || {}) }, cov: { known: true, latest: '30 Sep 2026', latestKnown: true, days: 19, title: 'x', ...(o.cov || {}) }, band: o.band === undefined ? { key: 'fresh', label: 'Recent' } : o.band });

test('attention: status and priority on one line, one supporting sentence built from the engine counts', () => {
  assert.equal(support(item()), '0 of 2 active ads performing');
  assert.equal(support(item({ it: { facts: { unique_creatives: 4, performing: 2, active_ads: 4 } }, st: { text: 'Only 2 of 4 creatives performing.' } })), '2 of 4 active ads performing');
  assert.equal(support(item({ st: { label: 'No Active Creative', text: 'Strong sales, but no ads currently running.' } })), 'Strong sales · 0 active ads');
  assert.equal(support(item({ st: { label: 'Low Creative Coverage', text: 'Depends on a single creative. Opportunity to test more.' } })), 'Depends on a single creative. Opportunity to test more.', 'other statuses keep the engine\'s own sentence');
  const html = attention(item());
  assert.match(html, /core-cat-attn-top"><span class="pl-status"[^>]*>[\s\S]*Underperforming Creative[\s\S]*opp-priority" data-priority="High"/, 'badge and priority share the first line');
  assert.equal(text(html), 'Underperforming Creative High 0 of 2 active ads performing');
  assert.doesNotMatch(html, /core-cat-ads|Active Ad/, 'the number of active ads is not repeated underneath');
  assert.match(attention(null), /Not assessed/);
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

test('product rows: a real picture next to every name, no tinted selected row, header names all seven columns', () => {
  const thumb = fnSrc(app, 'coreProductThumbHtml');
  assert.match(thumb, /info\.it\.image_url/); assert.match(thumb, /p\.colours/); assert.match(thumb, /#i-image/, 'the icon only when no picture exists');
  const row = fnSrc(app, 'coreProblemProductRowHtml');
  assert.match(row, /\$\{badge \|\| ''\}\$\{coreProductThumbHtml\(p, info\)\}<span class="core-shoot-review-name">/, 'attention dot, picture, then the name');
  assert.doesNotMatch(row, /core-row-selected/, 'a selected product is not a coloured row');
  assert.match(row, /shootActionHtml\(p\.product_code, 'shootThisWeekForCore', selectedCodes\)/, 'the Shoot / Shooting indicator is unchanged');
  const head = fnSrc(app, 'coreProblemProductsHeaderHtml');
  for (const h of ['Product', 'Inventory', '7D Sales', 'MTD vs LY', 'Creative Attention', 'Creative Freshness', 'This Week']) assert.ok(head.includes(`<span>${h}</span>`), h);
  const tail = css.slice(css.indexOf('Core Shoot Planning: the expanded product rows'));
  assert.match(tail, /\.core-prod-thumb\{width:46px;height:46px/); assert.match(tail, /\.core-shoot-review-row\.core-product-row\.core-row-selected\{background:#fff/);
  assert.match(tail, /@media \(max-width:1350px\)/); assert.match(tail, /@media \(max-width:1150px\)/, 'stays usable on smaller screens');
});

test('the existing calculations are untouched: status, priority and the freshness bands come from the same helpers', () => {
  const att = fnSrc(pl, 'plCatalogueAttentionHtml'); assert.match(att, /info\.st/); assert.match(att, /info\.it\.priority/);
  assert.match(fnSrc(pl, 'plCatalogueMap'), /PE\.coreStatus/); assert.match(fnSrc(pl, 'plCatalogueMap'), /plFreshBand\(cov, cfg\)/);
  assert.equal(typeof E.coreStatus, 'function');
});
