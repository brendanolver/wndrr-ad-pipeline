'use strict';
// Creative Performance card (expanded Core product): the display logic over the engine's own creative classification. Real engine + recency code, fixture data only.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const opp = require('../src/lib/planningOpportunities');
const E = require('../public/planningExplain');
const { CFG, TODAY, day, cr, salesOf, base } = require('./_planningFixtures');

const run = (p) => opp.evaluate(p, CFG, TODAY, 'core');
const v = (key, state, o = {}) => ({ ...cr(key, state, { age: o.age === undefined ? 120 : o.age }), first_delivery: day(o.age === undefined ? 120 : o.age), first_delivery_truncated: false, last_delivery: day(1), ...o });
const cov = (n) => ({ known: true, active_ads: n, possible: 0, unresolved: 0, unresolved_share_pct: 0, uncertain: false, min: 5 });
const strong = salesOf(150, { units7: 40, units14: 75 });
const card = (creatives, all = null) => { const it = run(base({ sales: strong, coverage: cov(creatives.length), creatives })); if (all !== null) it.last_creative = { creatives_total: all }; return E.creativeCard(it); };
const pl = fs.readFileSync(path.join(__dirname, '..', 'public', 'planning.js'), 'utf8');
const fn = (name) => { const i = pl.indexOf(`function ${name}(`); return pl.slice(i, pl.indexOf('\n}\n', i) + 2); };

test('card: 3 of 9 with 4 underperforming and 2 awaiting data (testing, insufficient delivery, no benchmark)', () => {
  const c = card([
    v('p1', 'performing'), v('p2', 'performing'), v('p3', 'performing'),
    v('w1', 'underperforming'), v('w2', 'underperforming'), v('w3', 'underperforming'), v('w4', 'underperforming'),
    v('t1', 'insufficient', { age: 2, spend: 10 }), v('u1', 'unrated'),
  ]);
  assert.equal(c.kind, 'active');
  assert.deepEqual([c.performing, c.total, c.underperforming, c.awaiting, c.declining], [3, 9, 4, 2, 0]);
  assert.equal(c.performing + c.underperforming + c.declining + c.awaiting, c.total, 'the parts always add up to the total');
});

test('card: creatives without an approved benchmark, still testing, or with too little delivery are awaiting data, never underperforming', () => {
  const c = card([v('u1', 'unrated'), v('u2', 'unrated'), v('t1', 'insufficient', { age: 1, spend: 5 }), v('i1', 'insufficient', { age: 30, spend: 20 }), v('n1', 'unavailable')]);
  assert.deepEqual([c.performing, c.underperforming, c.awaiting, c.total], [0, 0, 5, 5]);
});

test('card: a fatigued creative (was performing, clearly worse than it was) is its own count, not underperforming and not awaiting data', () => {
  const c = card([v('p1', 'performing'), v('d1', 'declining')]);
  assert.deepEqual([c.performing, c.declining, c.underperforming, c.awaiting], [1, 1, 0, 0]);
});

test('card: all performing, and no active creative', () => {
  const all = card([v('p1', 'performing'), v('p2', 'performing')]);
  assert.deepEqual([all.kind, all.performing, all.total, all.underperforming, all.awaiting], ['active', 2, 2, 0, 0]);
  const none = card([], 3); assert.equal(none.kind, 'none'); assert.equal(none.history.earlier, 3, 'previous creatives are still reported');
});

test('card: previous creatives = all-time unique creatives not on an active ad; unknown data shows nothing', () => {
  const c = card([v('p1', 'performing'), v('w1', 'underperforming')], 17);
  assert.deepEqual([c.history.earlier, c.history.allTime], [15, 17]);
  assert.equal(E.creativeCard({ facts: { active_ads: null, unique_creatives: null } }).kind, 'unknown');
  assert.equal(E.creativeCard({}).kind, 'unknown');
  const noDates = card([v('p1', 'performing')]); assert.equal(noDates.history, null, 'creative dates not loaded: no footer rather than a guess');
});

test('card wording and colours (display only)', () => {
  const m = fn('plCoreMetrics').replace(/^\s*\/\/.*$/gm, '');
  assert.match(m, /No Active Creative/); assert.match(m, /No ads currently running for this product/);
  assert.doesNotMatch(m, /0 of 0/, 'no "0 of 0" figure'); assert.match(m, /cc\.kind === 'none'/);
  assert.match(m, /`\$\{plNum\(cc\.performing\)\} of \$\{plNum\(cc\.total\)\}`/, 'headline: effective active creatives of all active creatives');
  assert.match(m, /cc\.underperforming \? part\(cc\.underperforming, 'underperforming', 'pl-cm-bad'\)/, 'only non-zero categories');
  assert.match(m, /cc\.awaiting \? part\(cc\.awaiting, 'awaiting data', 'pl-cm-wait'\)/);
  assert.match(m, /join\(' &middot; '\)/);
  assert.match(m, /previous .* tested/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.pl-cm \.pl-cm-bad\{color:#b42318/); assert.match(css, /\.pl-cm \.pl-cm-wait\{color:var\(--text-muted\)/);
});
