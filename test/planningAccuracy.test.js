'use strict';
// Batch 29: Planning recommendation accuracy. Stock eligibility (available stock only, shootable colourways, usable size runs), demand qualification, creative-condition honesty
// (testing is measured from the first delivery, never from a creation date; missing benchmarks are named), thumbnails and colourways. Everything is fixture data: no database, no network.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const opp = require('../src/lib/planningOpportunities');
const dm = require('../src/lib/planningDemand');
const recency = require('../src/lib/creativeRecency');
const cfgLib = require('../src/lib/creativePlanningConfig');
const loader = require('../src/lib/planningOpportunitiesLoader');
const E = require('../public/planningExplain');
const { CFG, TODAY, day, cr, salesOf, base } = require('./_planningFixtures');

const run = (p, mode = 'core', cfg = CFG) => opp.evaluate(p, cfg, TODAY, mode);
const strong = salesOf(150, { units7: 40, units14: 75 });
const cov = (o = {}) => ({ known: true, active_ads: 0, possible: 0, unresolved: 0, unresolved_share_pct: 0, uncertain: false, min: 5, ...o });
const stock = (units, extra = {}) => ({ known: true, units, on_order: 0, colourways: { total: 1, active: 1, viable: 1 }, ...extra });
const gapProduct = (o = {}) => base({ sales: strong, coverage: cov(), stock: stock(300), ...o });

// ── STOCK ──────────────────────────────────────────────────────────────────────────────────────────────
test('stock: fewer than 40 available sellable units is never recommended; exactly 40 can be', () => {
  assert.equal(CFG.opp_min_stock_units, 40, "WNDRR's rule: 40 available units");
  const low = run(gapProduct({ stock: stock(39) }));
  assert.equal(low.status, 'low_stock'); assert.equal(low.stock_issue, 'below_minimum'); assert.equal(E.categoryOf(low), 'hidden');
  const exact = run(gapProduct({ stock: stock(40), sales: salesOf(40, { units7: 9, units14: 19 }) }));
  assert.notEqual(exact.status, 'low_stock', 'exactly 40 passes the minimum');
});
test('stock: incoming stock, reorders and open purchase orders never count as available', () => {
  const o = run(gapProduct({ stock: stock(25, { on_order: 500 }) }));
  assert.equal(o.status, 'low_stock'); assert.match(o.reason, /500 on order do not count: not available to sell yet/);
  // and they never close a short runway
  const runway = run(gapProduct({ stock: stock(80, { on_order: 900 }), sales: salesOf(100, { units7: 25, units14: 50 }) }));
  assert.equal(runway.status, 'low_stock'); assert.equal(runway.stock_issue, 'short_runway'); assert.equal(runway.stock.band, 'short');
  assert.equal(dm.stockOf({ known: true, units: 80, on_order: 900 }, 25, CFG).cover_with_order_weeks > 4, true, 'the order is shown as information only');
});
test('stock: healthy family total is not enough when no single colourway can be shot; one shootable colourway is', () => {
  const none = run(gapProduct({ stock: stock(300, { colourways: { total: 6, active: 6, viable: 0 } }) }));
  assert.equal(none.status, 'low_stock'); assert.equal(none.stock_issue, 'no_viable_colourway'); assert.match(none.reason, /no single colourway can be shot now/);
  const one = run(gapProduct({ stock: stock(300, { colourways: { total: 6, active: 6, viable: 1 } }) }));
  assert.equal(one.status, 'act');
  const off = cfgLib.resolve({ stock_require_viable_colourway: 0 }).config;
  assert.equal(run(gapProduct({ stock: stock(300, { colourways: { total: 6, active: 6, viable: 0 } }) }), 'core', off).status, 'act', 'a setting, not a hidden rule');
});
test('stock: broken sizing means not recommended when no colourway has a usable run; thresholds are the existing size-run judgement', () => {
  const sizes = { available: true, level: 'broken', warning: 'Broken sizes: S, XL low or sold out (2 of 5 sizes available)', available_sizes: 2, total_sizes: 5 };
  const o = run(gapProduct({ stock: stock(300, { colourways: { total: 1, active: 1, viable: 0 }, sizes }) }));
  assert.equal(o.status, 'low_stock'); assert.equal(o.stock_issue, 'broken_sizes'); assert.match(o.reason, /Broken sizes/);
  assert.equal(E.stockRestriction(o).text, 'Sizing is broken: too many sizes are low or sold out.');
});
test('stock: low runway (Halo / Offcut style): high demand with 1.7 weeks of available stock is not an immediate shoot, whatever its sales', () => {
  const o = run(gapProduct({ stock: stock(127), sales: salesOf(312, { units7: 100, units14: 160 }) }));
  assert.equal(o.status, 'low_stock'); assert.equal(o.stock_issue, 'short_runway');
  assert.match(o.reason, /only 1\.\d weeks of stock/);
  assert.equal(E.stockRestriction(o).restricted, true);
});
test('stock: replenishment returns the product by itself (the engine is re-run on every refresh; nothing is stored)', () => {
  const restricted = run(gapProduct({ stock: stock(20) }));
  const replenished = run(gapProduct({ stock: stock(300) }));
  assert.equal(restricted.status, 'low_stock'); assert.equal(replenished.status, 'act');
});

// ── LOADER: colourway viability, stock of ACTIVE colourways, thumbnails ────────────────────────────────────
async function loaderRun({ stockByCode, sizesByCode, details, overrides = new Map(), tier = null, sales = {}, name = 'Test Box Fit Tee' }) {
  const codes = Object.keys(stockByCode);
  const amDetails = new Map(codes.map((c) => [c, { productName: name, imageUrl: details[c] || null, launchDate: '2026-01-05', launchDateRaw: '2026-01-05', launchDateReadable: true, isCore: true, category: 'TEES' }]));
  const family = { key: 'W26TE001', name, category: 'TEES', codes: ['W26TE001'], style_codes: codes, is_core: true };
  const salesByStyle = new Map(codes.map((c, i) => [c, { qty7: i === 0 ? (sales.u7 || 20) : 0, qty14: i === 0 ? (sales.u14 || 40) : 0, qty30: i === 0 ? (sales.u30 || 80) : 0, qty365: i === 0 ? 800 : 0, daily: {} }]));
  salesByStyle.window = { fetched_at: new Date().toISOString(), failed_days: [], failed_requests: 0 };
  const fakeDb = { query: async () => ({ rows: [] }) };
  return loader.computeOpportunities({
    now: new Date(`${TODAY}T03:00:00Z`),
    deps: {
      db: fakeDb, today: TODAY, settings: { creative_planning_config: {}, min_active_ads: 5, high_stock_min_soh: 0 },
      am: { amConfigured: true, amDetails, amStock: new Map(Object.entries(stockByCode)), amOnOrder: new Map(), amSizeRanges: new Map() },
      salesByStyle, sizesByStyle: sizesByCode ? new Map(Object.entries(sizesByCode).map(([c, o]) => [c, new Map(Object.entries(o))])) : null,
      planning: { allFamilies: [family], coverage: { available: true, by_family: new Map([['W26TE001', 0]]), pending_by_family: new Map(), unresolved_identities: 0, unresolved_share_pct: 0 }, seasonality: { available: false } },
      tiers: tier ? new Map(codes.map((c) => [c, { tier, indexScore: 180, units4w: 100, units28: 50, units28prev: 50, firstSaleDay: '2025-06-01', censored: false, daysSinceFirstSale: 400 }])) : new Map(),
      launch: { drops: new Map(), overrides, shopify: null },
      benchmarks: { rules: {}, coded: {}, source: 'test' }, performance: new Map(), history: new Map(), pipeline: new Map(),
    },
  });
}
const SIZES_OK = { S: 10, M: 12, L: 12, XL: 8 };
const SIZES_BROKEN = { S: 0, M: 1, L: 0, XL: 0 };

test('loader: stock is the ACTIVE colourways only; a discontinued colourway is never inferred from zero stock; thumbnails prefer a shootable colourway', async () => {
  const out = await loaderRun({
    stockByCode: { W26TE001BLK: 120, W26TE001WHI: 20, W26TE001OLD: 400, W26TE001NEW: 0 },
    sizesByCode: { W26TE001BLK: SIZES_OK, W26TE001WHI: SIZES_OK, W26TE001OLD: SIZES_OK, W26TE001NEW: SIZES_OK },
    details: { W26TE001BLK: 'https://img/blk.png', W26TE001WHI: 'https://img/whi.png', W26TE001OLD: 'https://img/old-discontinued.png', W26TE001NEW: 'https://img/new.png' },
    overrides: new Map([['W26TE001OLD', { status: 'discontinued' }]]),
  });
  const item = out.core.items[0];
  const cw = (code) => item.colourways.find((c) => c.style_code === code);
  assert.equal(cw('W26TE001OLD').active, false); assert.equal(cw('W26TE001OLD').restriction, 'Discontinued'); assert.equal(cw('W26TE001OLD').viable, false);
  assert.equal(cw('W26TE001NEW').active, true, 'zero stock alone never marks a colourway discontinued'); assert.match(cw('W26TE001NEW').restriction, /Only 0 available/);
  assert.equal(cw('W26TE001WHI').viable, false); assert.match(cw('W26TE001WHI').restriction, /Only 20 available \(40 needed\)/);
  assert.equal(cw('W26TE001BLK').viable, true);
  assert.equal(item.facts.stock_units, 140, 'family stock = active colourways only (120 + 20 + 0), not the discontinued 400');
  assert.equal(item.facts.stock_total_units, 540); assert.equal(item.facts.colourways_viable, 1); assert.equal(item.facts.colourways_active, 3);
  assert.equal(item.image_url, 'https://img/blk.png', 'the shootable, best-stocked colourway; never the discontinued one');
  assert.equal(item.colourways[0].style_code, 'W26TE001BLK', 'shootable colourways first');
});
test('loader: a product with healthy family stock but no shootable colourway is not recommended; colourways keep their reasons', async () => {
  const out = await loaderRun({
    stockByCode: { W26TE001BLK: 30, W26TE001WHI: 30, W26TE001GRY: 30 }, sizesByCode: { W26TE001BLK: SIZES_OK, W26TE001WHI: SIZES_OK, W26TE001GRY: SIZES_OK }, details: {},
  });
  const item = out.core.items[0];
  assert.equal(item.facts.stock_units, 90); assert.equal(item.status, 'low_stock'); assert.equal(item.stock_issue, 'no_viable_colourway'); assert.equal(E.categoryOf(item), 'hidden');
  assert.ok(item.colourways.every((c) => !c.viable));
  assert.equal(item.image_url, null, 'no shootable colourway and no stock to speak of: a neutral placeholder, not a guess');
});
test('loader: broken sizes make a colourway unshootable; unknown sizing never fabricates a verdict', async () => {
  const broken = await loaderRun({ stockByCode: { W26TE001BLK: 200 }, sizesByCode: { W26TE001BLK: SIZES_BROKEN }, details: { W26TE001BLK: 'https://img/b.png' } });
  const b = broken.core.items[0].colourways[0];
  assert.equal(b.viable, false); assert.match(b.restriction, /^Broken sizes: /); assert.equal(broken.core.items[0].stock_issue, 'broken_sizes');
  const unknown = await loaderRun({ stockByCode: { W26TE001BLK: 200 }, sizesByCode: null, details: {} });
  const u = unknown.core.items[0].colourways[0];
  assert.equal(u.sizes, null); assert.equal(u.viable, true, 'no size data: judged on stock only, with no invented size verdict');
});

// ── DEMAND ─────────────────────────────────────────────────────────────────────────────────────────────
test('demand: a creative gap alone never qualifies a product (Accent Mesh style: 16 units in 30 days)', () => {
  const o = run(gapProduct({ sales: salesOf(16, { units7: 5, units14: 9 }) }));
  assert.equal(o.status, 'weak_demand'); assert.equal(E.categoryOf(o), 'hidden'); assert.match(o.reason, /A creative gap on its own is not a reason for a new shoot/);
});
test('demand: a Platinum or Rocket product (Demand Planning) qualifies while it is still selling; very weak sales never qualify', () => {
  for (const tier of ['platinum', 'rocket']) {
    const o = run(gapProduct({ tier: { tier, index: 180 }, stock: stock(100), sales: salesOf(12, { units7: 3, units14: 6 }) }));
    assert.equal(o.status, 'act', tier); assert.equal(o.facts.demand_qualified_by, 'tier'); assert.notEqual(o.priority, 'High');
  }
  assert.equal(run(gapProduct({ tier: { tier: 'platinum', index: 180 }, sales: salesOf(3, { units7: 1, units14: 2 }) })).status, 'weak_demand');
});
test('demand: an established Core product with steady selling and no Platinum / Rocket status is kept', () => {
  const o = run(gapProduct({ tier: null, sales: salesOf(34, { units7: 8, units14: 16 }) }));
  assert.equal(o.status, 'act'); assert.equal(o.facts.demand_qualified_by, 'steady_sales');
  const off = cfgLib.resolve({ demand_tier_qualifies: 0 }).config;
  assert.equal(run(gapProduct({ tier: { tier: 'platinum', index: 180 }, stock: stock(100), sales: salesOf(12, { units7: 3, units14: 6 }) }), 'core', off).status, 'weak_demand', 'the tier path is a setting');
});
test('demand: strong new launch qualifies; weak and steady launches do not (Accent Mesh: 16 units over about 21 days)', () => {
  const launch = (units, days) => base({ is_core: false, launch_age_days: days - 1, sales: salesOf(units, { units7: Math.round(units / 3), units14: units, since_launch: units, days_live: days }), coverage: cov(), stock: stock(300) });
  assert.equal(run(launch(70, 14), 'momentum').status, 'act');
  const weak = run(launch(16, 21), 'momentum');
  assert.equal(weak.status, 'weak_demand'); assert.equal(E.categoryOf(weak), 'hidden');
  const withTier = run({ ...launch(16, 21), tier: { tier: 'rocket', index: 180 } }, 'momentum');
  assert.equal(withTier.status, 'act'); assert.equal(withTier.facts.demand_qualified_by, 'tier');
});

// ── CREATIVE CONDITIONS and DATES ──────────────────────────────────────────────────────────────────────
const verdict = (key, state, o = {}) => ({ ...cr(key, state, { age: o.age === undefined ? 120 : o.age }), ...o });
test('dates: "new" is measured from the first delivery, never from a creation date; a creation date alone is disclosed as such', () => {
  const fd = recency.phaseOf(verdict('a', 'insufficient', { created: day(300), first_delivery: day(5), first_delivery_truncated: false }), TODAY, CFG);
  assert.equal(fd.phase, 'testing'); assert.equal(fd.started_basis, 'first_delivery'); assert.equal(fd.age_days, 5, 'created long ago but only began delivering 5 days ago: genuinely new');
  const old = recency.phaseOf(verdict('b', 'insufficient', { created: day(6), first_delivery: day(80), first_delivery_truncated: false }), TODAY, CFG);
  assert.notEqual(old.phase, 'testing', 'recently CREATED is not recently RUNNING: it has been delivering for 80 days'); assert.equal(old.age_days, 80);
  const created = recency.phaseOf(verdict('c', 'insufficient', { created: day(6) }), TODAY, CFG);
  assert.equal(created.phase, 'testing'); assert.equal(created.started_basis, 'created');
});
test('dates: a first delivery on the day our stored history begins is never taken to mean "just started"', () => {
  const truncated = recency.phaseOf(verdict('a', 'insufficient', { created: day(200), first_delivery: day(4), first_delivery_truncated: true }), TODAY, CFG);
  assert.notEqual(truncated.phase, 'testing'); assert.equal(truncated.started_basis, 'created'); assert.equal(truncated.age_days, 200);
  const only = recency.phaseOf(verdict('b', 'insufficient', { created: null, first_delivery: day(4), first_delivery_truncated: true }), TODAY, CFG);
  assert.notEqual(only.phase, 'testing'); assert.equal(only.started_basis, 'first_stored_delivery');
  assert.match(E.startedPhrase({ date: day(4), basis: 'first_stored_delivery', age_days: 4 }), /our stored history may begin there, so its real start is unknown/);
});
test('conditions: a product can hold creatives in several conditions at once and they are counted apart, never collapsed', () => {
  const cs = [
    verdict('p', 'performing', { first_delivery: day(90), funnel: 'MOF' }), verdict('n', 'insufficient', { first_delivery: day(3), funnel: 'TOM' }),
    verdict('u', 'unrated', { first_delivery: day(60), funnel: 'TOM' }), verdict('i', 'insufficient', { first_delivery: day(60), created: day(60) }),
    verdict('d', 'unavailable', { first_delivery: day(60) }), verdict('w', 'underperforming', { first_delivery: day(70), severity: 'clear' }),
  ];
  const sum = recency.summarize(cs, TODAY, CFG);
  assert.deepEqual(sum.conditions, { new: 1, insufficient_delivery: 1, missing_benchmark: 1, performing: 1, underperforming: 1, fatigued: 0, not_delivering: 1 });
  assert.deepEqual(sum.unrated_funnels, ['TOM']);
  const item = { facts: { unique_creatives: 6, creative_conditions: sum.conditions, unrated_funnels: sum.unrated_funnels } };
  assert.equal(E.conditionsSummary(item), '6 creatives: 1 performing against the approved benchmark, 1 over the approved limit, 1 new (first days of delivery), 1 with no approved TOM benchmark, 1 with too little delivery to judge, 1 active but not delivering.');
});
test('conditions: an ad that is active but not delivering is not "gathering data"', () => {
  const p = recency.phaseOf(verdict('a', 'unavailable', { created: day(3) }), TODAY, CFG);
  assert.equal(p.phase, 'not_delivering'); assert.equal(p.condition, 'not_delivering');
  const o = run(gapProduct({ coverage: cov({ active_ads: 1 }), creatives: [verdict('a', 'unavailable', { created: day(3), spend: 0, purchases: 0 })] }));
  assert.equal(o.status, 'insufficient_data'); assert.equal(o.review_reason, 'not_delivering'); assert.doesNotMatch(o.reason, /gathering data/);
});
test('conditions: a recent upload that a Meta creative already shows is counted once; one with no Meta delivery is "no matching Meta delivery yet"', () => {
  const visible = recency.summarize([verdict('a', 'insufficient', { first_delivery: day(3) })], TODAY, CFG, { uploads: [{ date: day(4), concept: 'X' }] });
  assert.equal(visible.recent_uploads, 0, 'the upload is the same creative as the Meta ad that began delivering');
  const pending = recency.summarize([], TODAY, CFG, { uploads: [{ date: day(4), concept: 'X' }] });
  assert.equal(pending.recent_uploads, 1);
  const o = run(gapProduct({ sales: salesOf(30, { units7: 7, units14: 15 }), pipeline: { in_flight: 0, by_stage: {}, uploaded: [{ date: day(4), concept: 'X' }], this_week: 0 }, creatives: [verdict('b', 'underperforming', { age: 120, severity: 'clear' })], coverage: cov({ active_ads: 1 }) }));
  assert.equal(o.status, 'testing'); assert.match(E.reasonFor(o, CFG), /marked uploaded on \d+ \w+ 2026 \(production record\); no matching Meta delivery found yet/);
});
test('benchmarks: a missing benchmark is named, with the funnel, and is never "still gathering data"; TOF / TOM are never judged against the MOF target', () => {
  const o = run(gapProduct({ coverage: cov({ active_ads: 2 }), creatives: [verdict('a', 'unrated', { funnel: 'TOM', age: 90 }), verdict('b', 'unrated', { funnel: 'TOM', age: 80 })] }));
  assert.equal(o.status, 'insufficient_data'); assert.equal(E.categoryOf(o), 'review');
  assert.equal(E.reasonFor(o, CFG), 'These 2 ads have performance data, but there is no approved TOM benchmark to assess them against.');
  assert.doesNotMatch(o.reason + E.reasonFor(o, CFG), /gathering data/);
  const perf = require('../src/lib/productAdPerformance'); const health = require('../src/lib/metaFunnelHealth');
  const ctx = { rules: health.effectiveRules(), coded: health.COLOUR_CODED };
  const m = (spend, purchases) => ({ total: { spend, impressions: 50000, clicks: 900, purchases, value: 0 }, recent: { spend: spend / 2, impressions: 25000, clicks: 450, purchases: purchases / 2, value: 0 }, prior: { spend: spend / 2, impressions: 25000, clicks: 450, purchases: purchases / 2, value: 0 }, delivery_rows: 14 });
  assert.equal(perf.judgeCreative({ ...m(900, 10), funnel: 'TOF' }, ctx).state, 'unrated');
  assert.equal(perf.judgeCreative({ ...m(900, 10), funnel: 'TOM' }, ctx).state, 'unrated');
  assert.equal(perf.judgeCreative({ ...m(900, 10), funnel: 'MOF' }, ctx).state, 'underperforming', 'only MOF CPA has an approved benchmark');
});
test('review: Needs review is not a dumping ground; weak demand and stock-restricted products are never in it', () => {
  const weak = run(gapProduct({ sales: salesOf(16, { units7: 5, units14: 9 }) }));
  const stockOut = run(gapProduct({ stock: stock(10) }));
  const gap = run(gapProduct());
  const uncertain = run(gapProduct({ coverage: cov({ possible: 2, uncertain: true }) }));
  assert.deepEqual([weak, stockOut].map(E.categoryOf), ['hidden', 'hidden']);
  assert.equal(E.categoryOf(gap), 'needs'); assert.equal(E.categoryOf(uncertain), 'review');
  const noSales = run(gapProduct({ sales: { available: false } }));
  assert.equal(noSales.status, 'insufficient_data'); assert.equal(E.categoryOf(noSales), 'hidden', 'missing sales is a data-quality matter, not a creative review item');
});

// ── UNSUPPORTED CLAIMS ─────────────────────────────────────────────────────────────────────────────────
test('claims: product sales are never described as proof that Meta creative works', () => {
  const o = { status: 'momentum_ok', facts: {} };
  assert.match(E.reasonFor(o), /That is product demand, not evidence about Meta creative/);
  const files = [fs.readFileSync(path.join(__dirname, '..', 'public', 'planningExplain.js'), 'utf8'), fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'planningOpportunities.js'), 'utf8')].join('\n');
  assert.doesNotMatch(files, /creative in place is working/); assert.doesNotMatch(files, /holding up since launch, so/i);
  assert.doesNotMatch(files, /still gathering data/, 'the phrase is gone from the engine and the wording module');
});
test('claims: launch and delivery dates are real, labelled, and never hardcoded', () => {
  const x = { launch_date: '2026-08-14', launch_age_days: 60, newest_started: { date: '2026-09-18', basis: 'first_delivery', age_days: 25 }, unique_creatives: 1, active_ads: 1 };
  const kf = Object.fromEntries(E.keyFacts({ facts: x }));
  assert.equal(kf['Product launched'], '14 August 2026 (60 days ago)');
  assert.equal(kf['Latest creative started'], '18 September 2026 (25 days ago)');
  const created = Object.fromEntries(E.keyFacts({ facts: { ...x, newest_started: { date: '2026-09-18', basis: 'created', age_days: 25 } } }));
  assert.match(created['Latest creative started'], /ad created \(first delivery date not available\)/);
  const mom = E.reasonFor({ mode: 'momentum', status: 'act', launch_date: '2026-08-14', launch_age_days: 60, gap: { type: 'confirmed_gap' }, facts: { demand_level: 'strong', units30: 70 } }, CFG);
  assert.match(mom, /^New launch \(launched 14 August 2026 \(60 days ago\)\), selling strongly/);
});

// ── PAGE WIRING ────────────────────────────────────────────────────────────────────────────────────────
const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
test('page: three categories only, Needs creative by default, no "Not recommended", no "Data and rules" or launch counters on Core / High Stocks', () => {
  const pl = pub('planning.js'); const ex = pub('planningExplain.js');
  const body = (name) => (pl.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`)) || [''])[0];
  for (const fn of ['plRenderCore', 'plRenderHighStocks']) { assert.ok(body(fn).length > 50, fn); assert.doesNotMatch(body(fn), /plNotesHtml|plLaunchReviewHtml/, `${fn} renders neither the data rules nor the launch checks`); }
  assert.match(pl, /host\.innerHTML = plPageHtml\('core'\);/); assert.match(pl, /host\.innerHTML = plPageHtml\('high', tierNote\);/);
  assert.match(pl, /state\.oppView = \{ core: 'needs', high: 'needs' \}/);
  assert.doesNotMatch(ex, /not_recommended|Not recommended/); assert.doesNotMatch(pl, /Not recommended|not_recommended/);
  // the launch checks and data notes now live in Settings > Planning
  const settings = body('plRenderSettingsInfo');
  assert.match(settings, /plLaunchReviewHtml\(o\.launch_review\)/); assert.match(settings, /plNotesHtml\(\)/);
});
test('page: top navigation mirrors the sidebar (same section keys, one handler, synchronised by plSyncChrome)', () => {
  const html = pub('index.html'); const app = pub('app.js'); const pl = pub('planning.js');
  const top = html.slice(html.indexOf('id="planning-topnav"'), html.indexOf('id="planning-production-header"'));
  for (const sec of ['core', 'high-stocks', 'shoot-plan']) assert.ok(top.includes(`data-pl-nav="${sec}"`), sec);
  assert.doesNotMatch(top, /mp-subnav|data-mp-/, "own class: Meta Performance's wiring never sees these buttons");
  assert.match(app, /document\.querySelectorAll\('\[data-pl-nav\]'\)\.forEach\(\(b\) => b\.addEventListener\('click'/, 'one handler for both navigations');
  assert.match(app, /window\.location\.hash = `#planning\/\$\{key\}`/); assert.match(pl, /document\.querySelectorAll\('\[data-pl-nav\]'\)\.forEach\(\(b\) => \{/);
  assert.doesNotMatch(top, /blue|#00|style=/, 'no inline or blue styling');
});
test('page: Settings > Planning has the four parts and the new rules are real, editable settings', () => {
  const html = pub('index.html');
  for (const k of ['rules', 'sources', 'how', 'quality']) { assert.ok(html.includes(`data-plset="${k}"`), k); assert.ok(html.includes(`data-plset-group="${k}"`), k); }
  assert.ok(html.includes('id="wpc-groups"') && html.includes('id="lo-list"') && html.includes('id="po-list"'), 'existing settings and overrides are all still there');
  const keys = cfgLib.describe(CFG).flatMap((g) => g.fields.map((f) => f.key));
  for (const k of ['opp_min_stock_units', 'stock_require_viable_colourway', 'stock_block_broken_sizes', 'demand_tier_qualifies', 'launch_requires_strong_demand']) assert.ok(keys.includes(k), `${k} is editable`);
  assert.equal(CFG.stock_min_cover_weeks, 4, 'the existing runway minimum is unchanged: no new fixed threshold was invented');
  assert.equal(CFG.demand_steady_units, 20); assert.equal(CFG.demand_strong_units, 50);
});
test('shoot plan: planned work is warned about, never changed (the warning reads the assessment; it writes nothing)', () => {
  const pl = pub('planning.js'); const app = pub('app.js');
  const fn = pl.slice(pl.indexOf('function plShootPlanWarning'));
  assert.doesNotMatch(fn.slice(0, fn.indexOf('\n}\n')), /api\(|fetch\(|method:/);
  assert.match(app, /plShootPlanWarning\(item\)/); assert.match(app, /shootPlanColourPreselected\(preset, c\)/);
  // every other caller of the modal passes no colourway data and keeps the old behaviour (all ticked)
  assert.match(app, /return c\.viable !== false;/);
});
test('engine: nothing recommended is removed from the data; hidden products keep their full assessment', () => {
  const o = run(gapProduct({ stock: stock(10) }));
  assert.equal(o.status, 'low_stock'); assert.ok(o.facts && o.demand && o.stock && Array.isArray(o.eligibility), 'the full assessment is still there');
  assert.ok(o.eligibility.some((g) => g.key === 'stock_minimum' && g.ok === false));
});
