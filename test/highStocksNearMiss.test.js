'use strict';
// High Stocks "Almost qualifying": products the engine already returns but did not recommend because of one rule, shown under the recommendations until the page lists 10 products.
// Display only: nothing about the engine's rules, scores or classification changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const PE = require('../public/planningExplain');

const pl = fs.readFileSync(path.join(__dirname, '..', 'public', 'planning.js'), 'utf8');
const fnSrc = (name) => { const i = pl.indexOf(`function ${name}(`); return pl.slice(i, pl.indexOf('\n}\n', i) + 2); };
const make = (items, visible) => {
  const state = { opportunities: { available: true, high_stocks: { items } }, oppQuery: { high: '' } };
  const f = new Function('state', 'PE', 'plBase', 'PL_NEAR_MISS', 'PL_HS_TARGET', `${fnSrc('plNearMisses')}; return plNearMisses;`);
  return { state, run: () => f(state, PE, () => new Array(visible).fill(0), ['weak_demand', 'low_stock', 'out_of_season', 'too_new'], 10)() };
};
const it = (name, status, units30) => ({ key: name, name, category: 'SWEATS', status, facts: { units30 } });

test('near misses: only the rules that narrowly missed, closest to selling first, filling to 10 in all', () => {
  const items = [it('Act', 'act', 80), it('A', 'weak_demand', 20), it('B', 'low_stock', 31), it('C', 'out_of_season', 24), it('D', 'too_new', 2), it('E', 'not_launched', 99), it('F', 'momentum_ok', 98), it('G', 'weak_demand', 9), it('H', 'weak_demand', 14), it('I', 'out_of_season', 22)];
  const out = make(items, 5).run().map((i) => i.name);
  assert.deepEqual(out, ['B', 'C', 'I', 'A', 'H'], 'room for 5: sorted by 30-day units; recommended, not-launched and still-performing products are excluded');
  assert.equal(make(items, 1).run().length, 7, 'room for 9 but only 7 qualify');
  assert.equal(make(items, 10).run().length, 0, 'ten recommendations already: nothing is added'); assert.equal(make(items, 12).run().length, 0);
});

test('search applies, and an unavailable result gives nothing', () => {
  const m = make([it('Pulse Crew', 'weak_demand', 5), it('Slammed Hood', 'low_stock', 9)], 0); m.state.oppQuery.high = 'slammed';
  assert.deepEqual(m.run().map((i) => i.name), ['Slammed Hood']);
  m.state.opportunities.available = false; assert.deepEqual(m.run(), []);
});

test('wiring: a collapsed accordion "Other High Stock Products (N)" with helper text, the shared table with "Why Not Recommended" and no repeated badge; the engine files are untouched', () => {
  assert.match(pl, /plPageHtml\('high', tierNote\) \+ plNearMissHtml\(\)/);
  const html = fnSrc('plNearMissHtml');
  assert.match(html, /<details class="pl-other" data-opp-other="high"\$\{open \? ' open' : ''\}>/, 'collapsed unless the person opened it');
  assert.match(html, /Other High Stock Products \(\$\{items\.length\}\)/); assert.match(html, /Products with elevated stock that don't currently meet the creative recommendation criteria\./);
  assert.match(html, /plCoreTableHtml\('high', items, 'covered', \{ fixed: true, why: true \}\)/, 'the existing product table');
  assert.doesNotMatch(pl, /Almost qualifying/);
  const t = fnSrc('plCoreTableHtml');
  assert.match(t, /why \? 'Why Not Recommended' : 'Creative status'/); assert.match(t, /why \? plCoreWhyCell\(it\) : plCoreStatusCell\(it\)/); assert.match(t, /!fixed && key && PL_SORTS\[key\]/, 'no sortable headers in the fixed table');
  const cell = fnSrc('plCoreWhyCell'); assert.doesNotMatch(cell, /pl-status|st\.label/, 'no Not Recommended badge: only the engine\'s sentence'); assert.match(cell, /st\.text/);
  assert.match(pl, /state\.oppOtherOpen = o\.open/, 'the open state survives a re-render');
  assert.doesNotMatch(pl.slice(pl.indexOf('const PL_NEAR_MISS'), pl.indexOf('function plRenderHighStocks')), /fetch\(|api\(|score\s*[+*]/, 'no new data source or scoring');
  const loader = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'planningOpportunitiesLoader.js'), 'utf8');
  assert.doesNotMatch(loader, /near_miss|NEAR_MISS/, 'the engine is not changed');
});
