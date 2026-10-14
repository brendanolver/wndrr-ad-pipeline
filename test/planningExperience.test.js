'use strict';
// Batch 28: the Planning experience. The wording and status grouping are PURE (public/planningExplain.js) and are tested against REAL engine output (planningOpportunities.evaluate),
// so a sentence can only say what the engine actually found. The page wiring (sidebar sub-menu, five-column table, favicon / title) is checked from the shipped files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const opp = require('../src/lib/planningOpportunities');
const E = require('../public/planningExplain');
const { CFG, TODAY, cr, salesOf, seasonOf, base } = require('./_planningFixtures');

const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const run = (p, mode = 'core') => opp.evaluate(p, CFG, TODAY, mode);
const strong = salesOf(150, { units7: 40, units14: 75 });
const cov = (o = {}) => ({ known: true, active_ads: 0, possible: 0, unresolved: 0, unresolved_share_pct: 0, uncertain: false, min: 5, ...o });
const perf = (n, spends = []) => ['a', 'b', 'c'].slice(0, n).map((k, i) => cr(k, 'performing', { age: 60 - i * 15, spend: spends[i] || 600, purchases: 12, concept: `C${i}` }));
const reason = (it) => E.reasonFor(it, CFG);

test('every engine status maps to a visible category or is deliberately hidden (Batch 29: three visible categories)', () => {
  assert.deepEqual(E.CATEGORY_ORDER, ['needs', 'covered', 'review']);
  for (const status of Object.keys(opp.STATUS_LABEL)) assert.ok(E.STATUS_CATEGORY[status], `status ${status} is mapped`);
  assert.equal(E.categoryOf({ status: 'act' }), 'needs');
  for (const s of ['covered', 'testing', 'in_production']) assert.equal(E.categoryOf({ status: s }), 'covered', s);
  // Needs review is only an unresolved EVIDENCE problem on a product that already passed stock, demand and season
  assert.equal(E.categoryOf({ status: 'insufficient_data', needs_review: true }), 'review');
  assert.equal(E.categoryOf({ status: 'insufficient_data', needs_review: false }), 'hidden', 'missing sales or baseline data is a data-quality matter, not a review item');
  for (const s of ['out_of_season', 'weak_demand', 'low_stock', 'too_new', 'no_proven_demand', 'not_recent', 'not_launched', 'momentum_ok', 'launch_unknown', 'unavailable']) assert.equal(E.categoryOf({ status: s }), 'hidden', s);
  assert.deepEqual(Object.keys(E.CATEGORY).map((k) => E.CATEGORY[k].label), ['Needs creative', 'Covered / monitoring', 'Needs review']);
  assert.ok(!Object.keys(E.CATEGORY).includes('not_recommended'));
});

test('confirmed creative gap: plain English from the engine\'s own finding, with the real units', () => {
  const it = run(base({ sales: strong, coverage: cov() }));
  assert.equal(it.status, 'act'); assert.equal(it.gap.type, 'confirmed_gap');
  const r = reason(it);
  assert.match(r, /^Selling (strongly|consistently) \(150 units in 30 days\), but we haven't identified any active ads for it\.$/);
  assert.match(E.recommendationFor(it), /next shoot/);
  assert.match(E.whyWithNumbers(it), /150 units sold in 30 days/);
});

test('underperforming creative: counts the creatives over the approved limit; a testing or unrated creative is never called underperforming', () => {
  const weak = run(base({ sales: strong, coverage: cov({ active_ads: 1 }), creatives: [cr('a', 'underperforming', { age: 100, severity: 'clear', spend: 600, purchases: 5, concept: 'A' })] }));
  assert.equal(weak.gap.type, 'underperforming');
  assert.match(reason(weak), /1 of 1 active creative is over the approved cost-per-purchase limit and fewer than 3 are performing/);
  const testing = run(base({ sales: salesOf(40, { units7: 9, units14: 19 }), coverage: cov({ active_ads: 1 }), creatives: [cr('a', 'testing', { age: 4, spend: 40, purchases: 0 })] }));
  const unrated = run(base({ sales: strong, coverage: cov({ active_ads: 1 }), creatives: [cr('a', 'unrated', { age: 100, spend: 500, purchases: 6, concept: 'A' })] }));
  for (const it of [testing, unrated]) assert.doesNotMatch(reason(it), /underperform|over the approved/i, it.status);
  assert.equal(E.categoryOf(testing), 'covered');
  assert.match(reason(testing), /A creative is new: it was created on 8 October 2026 \(4 days ago\); its first delivery date is not available\. Too early to judge\./);
  assert.doesNotMatch(reason(testing), /still gathering data/);
});

test('creative concentration and fatigue are described only when the engine found them', () => {
  const conc = run(base({ sales: strong, coverage: cov({ active_ads: 3 }), creatives: perf(3, [9000, 400, 400]) }));
  if (conc.gap && conc.gap.type === 'concentration') assert.match(reason(conc), /\d+% of ad spend is on a single creative/);
  const fine = run(base({ sales: strong, coverage: cov({ active_ads: 3 }), creatives: perf(3) }));
  assert.doesNotMatch(reason(fine), /fatigue/i);
  const fat = run(base({ sales: strong, coverage: cov({ active_ads: 1 }), creatives: [cr('a', 'declining', { age: 100, spend: 900, purchases: 20, concept: 'A' })] }));
  if (fat.gap && fat.gap.type === 'fatigue') assert.match(reason(fat), /showing signs of fatigue/);
  assert.doesNotMatch(reason(fine), /No active creative|no active ads/i, 'enough effective creative never reads as a gap');
});

test('uncertain matching is never described as "no active creative": it says coverage could not be confirmed', () => {
  const it = run(base({ sales: strong, coverage: cov({ active_ads: 0, possible: 3, uncertain: true }) }));
  assert.equal(it.status, 'insufficient_data'); assert.equal(E.categoryOf(it), 'review'); assert.equal(it.review_reason, 'uncertain_matching');
  const r = reason(it);
  assert.match(r, /^Creative coverage could not be confirmed: 3 active ads awaiting review in Ad Matching/);
  assert.doesNotMatch(r, /No active creative|haven't identified any active ads/i);
  const generic = E.reasonFor({ status: 'insufficient_data', facts: {} }, CFG);
  assert.equal(generic, "We can't confidently assess this product's creative coverage yet.");
  assert.equal(E.keyFacts(it).find(([k]) => k === 'Active creative')[1], '0 (+3 awaiting review)');
});

test('creatives with no approved benchmark are never called good or bad: coverage is "can\'t assess", and one performing creative among them is only "thin"', () => {
  const un = ['a', 'b', 'c'].map((k, i) => cr(k, 'unrated', { age: 60 - i * 10, spend: 600, purchases: 8, concept: `C${i}` }));
  const allUnrated = run(base({ sales: strong, coverage: cov({ active_ads: 3 }), creatives: un }));
  assert.equal(allUnrated.status, 'insufficient_data');
  assert.equal(allUnrated.review_reason, 'missing_benchmark');
  assert.match(reason(allUnrated), /^These 3 ads have performance data, but there is no approved funnel benchmark to assess them against\.$/);
  assert.doesNotMatch(reason(allUnrated), /underperform|over the approved/i);
  const thin = run(base({ sales: strong, coverage: cov({ active_ads: 3 }), creatives: [...un.slice(0, 2), cr('p', 'performing', { age: 30, spend: 600, purchases: 12, concept: 'P' })] }));
  assert.match(reason(thin), /only 1 performing creative is in place \(3 wanted\)/);
});

test('not-recommended reasons are real: out of season, weak demand, low stock', () => {
  const oos = run(base({ name: 'Heavy Hood Sweat', category: 'SWEATS', sales: strong, coverage: cov(), season: seasonOf('Heavy Hood Sweat', 'SWEATS') }));
  if (oos.status === 'out_of_season') assert.match(reason(oos), /^Out of season in Australia right now/);
  const weakDemand = run(base({ sales: salesOf(3, { units7: 1, units14: 2 }), coverage: cov() }));
  assert.equal(weakDemand.status, 'weak_demand'); assert.equal(E.categoryOf(weakDemand), 'hidden');
  assert.match(reason(weakDemand), /^Only 3 units sold in 30 days/);
});

test('protect momentum is an opportunity type inside Core / High Stocks, never a status or a page', () => {
  const mom = run(base({ is_core: false, launch_age_days: 14, sales: salesOf(60, { units7: 20, units14: 36 }), coverage: cov() }), 'momentum');
  if (mom.status === 'act') {
    assert.equal(E.typeLabelOf(mom), 'Protect Momentum');
    assert.match(reason(mom), /^New launch \(14 days ago\), selling/);
  }
  // placement as the engine does it (planningPrimary): an official Core product keeps its Core identity, so its Protect Momentum result lives in the CORE list; only non-Core recent launches go to the momentum list
  const coreMom = run(base({ is_core: true, launch_age_days: 20, sales: salesOf(60, { units7: 20, units14: 36 }), coverage: cov() }), 'momentum');
  assert.equal(E.typeLabelOf(coreMom), 'Protect Momentum');
  const data = { items: [coreMom, { key: 'x', status: 'act', mode: 'core', opportunity_type: 'confirmed_gap', actionable: true }] };
  const momentum = { items: [{ key: 'n1', is_core: false, actionable: true, status: 'act', mode: 'momentum' }, { key: 'n2', is_core: false, actionable: false, status: 'weak_demand', mode: 'momentum' }] };
  assert.deepEqual(E.momentumItemsFor('core', data, momentum).map((i) => i.key), [coreMom.key], 'Core shows its official Core launches (from the Core list)');
  assert.equal(E.summaryCounts('core', data, momentum).protect, 1);
  assert.deepEqual(E.momentumItemsFor('high', { items: [] }, momentum).map((i) => i.key), ['n1', 'n2'], 'High Stocks shows the non-Core recent launches');
  assert.equal(E.summaryCounts('high', { items: [] }, momentum).protect, 1, 'only actionable ones are counted as opportunities');
  assert.equal(E.momentumItemsFor('core', { items: [] }, { items: [{ key: 'n1', is_core: false, mode: 'momentum' }] }).length, 0, 'a non-Core launch never appears on Core');
});

test('the top summary uses real counts and the weekly strip keeps products, concepts and carry-over apart', () => {
  const items = [{ status: 'act' }, { status: 'act' }, { status: 'insufficient_data', needs_review: true }, { status: 'insufficient_data' }, { status: 'covered' }, { status: 'out_of_season' }];
  assert.deepEqual(E.summaryCounts('core', { items }, { items: [] }), { needs: 2, protect: 0, review: 1 });
  const w = E.weeklySummary({ target: 15, planned: 2, remaining: 13, carryover: { count: 4 } }, 7);
  assert.deepEqual(w, { loaded: true, planned: 2, target: 15, remaining: 13, carried: 4, products: 7 });
  assert.equal(E.weeklySummary(null, 3, 15).loaded, false, 'nothing is invented while progress is loading');
});

test('direction and production text come from evidence, and key facts say "Not available" rather than guessing', () => {
  const gap = run(base({ sales: strong, coverage: cov() }));
  assert.match(E.directionFor(gap)[0], /no active creative to build on/);
  assert.equal(E.directionFor({ status: 'covered', facts: {} }).length, 0, 'no direction is invented for a covered product');
  const pipe = E.productionActivity({ pipeline: { planned: 2, by_stage: { filmed: 1, edited: 1 } } }, { filmed: 'Filmed', edited: 'Edited' });
  assert.equal(pipe.active, true); assert.match(pipe.text, /2 concepts already in the Shoot Plan pipeline \(1 filmed, 1 edited\)/);
  assert.equal(E.productionActivity({ pipeline: { planned: 0 } }).active, false);
  const blank = E.keyFacts({ facts: {} });
  assert.ok(blank.filter(([k]) => /stock|Active|Effective|New creative|Unrated|7 days|30 days|coverage|launched/i.test(k)).every(([, v]) => v === 'Not available'));
  assert.equal(blank.find(([k]) => k === 'Latest creative started')[1], 'None found');
  assert.equal(E.stockWarning({ facts: { stock_band: 'short', cover_weeks: 3.1 } }), '3.1w cover');
  assert.equal(E.stockWarning({ facts: { stock_band: 'healthy', cover_weeks: 12 } }), null);
});

test('no product name or hardcoded recommendation text lives in the wording module', () => {
  const src = pub('planningExplain.js');
  for (const name of ['Offend', 'Rothman', 'Soho', 'Hexed', 'Maison', 'Booster', 'Revoked']) assert.ok(!src.includes(name), name);
  assert.doesNotMatch(src, /fetch\(|XMLHttpRequest|api\(/, 'pure: it never reads or writes anything');
});

test('page wiring: sidebar sub-menu replaces the in-page step buttons; five default columns; shared Core / High Stocks interface', () => {
  const html = pub('index.html'); const app = pub('app.js'); const pl = pub('planning.js');
  for (const sec of ['core', 'high-stocks', 'shoot-plan']) assert.match(html, new RegExp(`data-pl-nav="${sec}"`));
  assert.doesNotMatch(html, /planning-step-btn|planning-steps"|id="planning-shoot-summary"|id="planning-shoot-plan-summary-block"/);
  assert.match(app, /window\.location\.hash = `#planning\/\$\{key\}`/, 'sections have deep links');
  assert.match(app, /hash === '#planning' \|\| hash\.startsWith\('#planning\/'\)/);
  assert.match(app, /#planning\/drop/, 'the pre-restructure #planning/drop links still redirect');
  const cols = [...pl.slice(pl.indexOf('const PL_COLS = [')).split('];')[0].matchAll(/label: \([a-z]*\) => (?:\(cat === 'needs' \? '([^']+)' : '[^']+'\)|'([^']+)')/g)].map((m) => m[1] || m[2]);
  assert.deepEqual(cols, ['Product', 'Why it needs creative', 'Stock', 'Sales 30d', 'Priority']);
  for (const gone of ['Sales 7d', 'Sales trend', 'Active creatives', 'Effective creatives', 'Last new creative', 'Opportunity type']) assert.ok(!pl.slice(pl.indexOf('const PL_COLS = [')).split('];')[0].includes(gone), `${gone} is not a default column`);
  assert.match(pl, /plPageHtml\('core'\)/); assert.match(pl, /plPageHtml\('high', tierNote\)/, 'Core and High Stocks render through the same function');
  assert.match(pl, /View detailed evidence/); assert.match(pl, /Add to Shoot Plan/); assert.match(pl, /Existing production activity/); assert.match(pl, /Suggested creative direction/);
  assert.doesNotMatch(pl, /pt-green|pt-orange|pt-red/, 'no table cell is filled red / green / orange');
});

test('favicon and browser title', () => {
  const html = pub('index.html');
  assert.match(html, /<title>WNDRR Creative<\/title>/);
  assert.match(html, /<link rel="icon" href="favicon\.ico"/);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'favicon.ico')));
  const ico = fs.readFileSync(path.join(__dirname, '..', 'public', 'favicon.ico'));
  assert.equal(ico.readUInt16LE(0), 0); assert.equal(ico.readUInt16LE(2), 1, 'a real .ico file');
  assert.ok(!/video|player/i.test(html.slice(html.indexOf('<head>'), html.indexOf('</head>')).replace(/<!--[\s\S]*?-->/g, '').match(/<link rel="[^"]*icon[^>]*>/g).join('')));
});

test('Meta Performance wiring is untouched: its sub-menu selectors and views are exactly as before', () => {
  const html = pub('index.html'); const app = pub('app.js');
  for (const v of ['performance', 'best', 'matching']) assert.match(html, new RegExp(`class="sidebar-sub-btn" data-mp-nav="${v}"`));
  assert.match(app, /document\.querySelectorAll\('\.sidebar-sub-btn'\)\.forEach\(\(b\) => b\.addEventListener\('click'/);
  assert.doesNotMatch(html, /class="sidebar-sub-btn" data-pl-nav/, 'the Planning menu has its own class, so Meta Performance\'s wiring never sees it');
});
