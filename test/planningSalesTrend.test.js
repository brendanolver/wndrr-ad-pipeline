'use strict';
// The 7-day sales trend under Sales 30D: last 7 days vs the 7 days before. Display only, from facts the page already has (units7, units14).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const E = require('../public/planningExplain');
const opp = require('../src/lib/planningOpportunities');
const { CFG, TODAY, salesOf, base } = require('./_planningFixtures');

const it = (units7, units14, extra = {}) => ({ facts: { units7, units14, units30: 60, ...extra } });
const t = (a, b, x) => E.salesTrend(it(a, b, x));

test('trend: percentage = (last 7D - previous 7D) / previous 7D x 100, previous 7D = last 14D - last 7D', () => {
  assert.deepEqual(pick(t(28, 53)), ['up', 12, '↑', '12%']);   // previous 25, last 28
  assert.deepEqual(pick(t(19, 44)), ['down', -24, '↓', '24%']); // previous 25, last 19
  assert.deepEqual(pick(t(25, 50)), ['flat', 0, '→', '0%']);
  assert.deepEqual(pick(t(50, 60)), ['up', 400, '↑', '400%']);  // previous 10
  assert.deepEqual(pick(t(0, 10)), ['down', -100, '↓', '100%']);
});
const pick = (r) => [r.kind, r.pct, r.arrow, r.text];

test('trend: rounding, and a change that rounds to nothing is neutral', () => {
  assert.equal(t(201, 401).pct, 1, 'previous 200, last 201 is +0.5%, rounded to 1%');
  assert.equal(t(1001, 2001).kind, 'flat', '+0.1% rounds to 0%');
  assert.equal(t(2, 5).pct, -33, 'previous 3, last 2');
});

test('trend: never invented. Missing data, no previous sales, inconsistent windows and recent launches are said plainly', () => {
  assert.deepEqual(pick(t(null, 40)), ['none', null, '', 'No comparison']);
  assert.deepEqual(pick(t(10, null)), ['none', null, '', 'No comparison']);
  assert.equal(E.salesTrend({}).kind, 'none'); assert.equal(E.salesTrend({ facts: {} }).text, 'No comparison');
  assert.equal(t(30, 20).kind, 'none', 'last 7 days more than the last 14 days cannot reconcile');
  const fresh = t(12, 12); assert.deepEqual(pick(fresh), ['new', null, '', 'New']); assert.match(fresh.title, /no sales in the previous 7 days/i);
  assert.equal(t(0, 0).kind, 'flat', 'no sales in either week is unchanged, not growth');
  const launch = t(20, 35, { days_on_sale: 9 }); assert.equal(launch.kind, 'new'); assert.match(launch.title, /on sale for 9 days/);
  assert.equal(t(20, 35, { days_on_sale: 14 }).kind, 'up', 'two full weeks on sale can be compared');
  assert.equal(t(20, 35, { days_on_sale: null }).kind, 'up', 'an established product has no part-period');
});

test('trend: the title spells out both windows and says today is a part-day', () => {
  const r = t(28, 53); assert.match(r.title, /\+12%/); assert.match(r.title, /Last 7 days: 28 units\. Previous 7 days: 25 units/); assert.match(r.title, /part-day/);
});

test('trend: it is display only. The engine result and its priority are identical whatever the trend', () => {
  const run = (u7, u14) => opp.evaluate(base({ sales: salesOf(150, { units7: u7, units14: u14 }) }), CFG, TODAY, 'core');
  const a = run(40, 75); const b = run(20, 75);
  assert.equal(a.facts.units7, 40); assert.equal(E.salesTrend(a).kind, 'up'); assert.equal(E.salesTrend(b).kind, 'down');
  const root = path.join(__dirname, '..');
  for (const f of ['planningOpportunities.js', 'planningPrimary.js', 'planningDemand.js']) assert.doesNotMatch(fs.readFileSync(path.join(root, 'src', 'lib', f), 'utf8'), /salesTrend/, `${f} does not use the display trend`);
});

test('wiring: the trend sits under Sales 30D; rows stay white; colour only for trend, status, priority dot and the primary action', () => {
  const root = path.join(__dirname, '..');
  const pl = fs.readFileSync(path.join(root, 'public', 'planning.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
  const cell = pl.slice(pl.indexOf('function plMetricsCell'), pl.indexOf('function plStatusCell'));
  assert.ok(cell.indexOf('<small>Sales 30D') > -1 && cell.indexOf('<small>Sales 30D') < cell.indexOf('${trend}'), 'the trend comes after the Sales 30D figure and label');
  assert.match(cell, /7D trend/);
  assert.match(css, /\.pl-trend\[data-trend="up"\]\{color:#15803d/); assert.match(css, /\.pl-trend\[data-trend="down"\]\{color:#c62828/);
  assert.match(css, /\.pl-table-v2 tbody tr\.pt-row td,\.pl-table-v2 tbody tr\.pt-row\.open td\{background:var\(--surface\)/, 'rows (open or closed) are white');
  assert.doesNotMatch(css.slice(css.indexOf('.pl-table-v2{')), /\.pl-table-v2[^{]*tr[^{]*\{[^}]*border-left/, 'no coloured left borders on rows');
  assert.match(css, /\.pl-m\{border:0;/, 'metrics are flat, not boxes');
  const table = pl.slice(pl.indexOf('function plTableHtml'), pl.indexOf('const PL_EMPTY'));
  assert.doesNotMatch(table, /data-priority|pt-rank|border-left/, 'rows carry no priority colouring');
});
