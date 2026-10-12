// Batch 14: the Core / High Stocks opportunity engine, seasonal relevance, creative recency and DPA detection. Every input is a fixture (no database, no network,
// no live data); the dates are fixed so the results are reproducible.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const opp = require('../src/lib/planningOpportunities');
const season = require('../src/lib/seasonRelevance');
const recency = require('../src/lib/creativeRecency');
const dpa = require('../src/lib/metaDpa');
const launch = require('../src/lib/launchStatus');
const cfgLib = require('../src/lib/creativePlanningConfig');

const TODAY = '2026-10-12';
const CFG = cfgLib.resolve({}).config;
const launched = { status: 'launched', eligible: true, needs_check: false, detail: 'ApparelMagic launch date 2026-03-01 has passed.' };
const day = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
const cr = (key, state, o = {}) => ({ key, state, created: day(o.age === undefined ? 120 : o.age), severity: o.severity || null, spend: o.spend === undefined ? 400 : o.spend, cpa: o.cpa || null, concept: o.concept || null, ad_count: 1, ...o });
const inSeason = season.assess({ category: 'TEES', name: 'Box Fit Tee', month: 10 });
const base = (o = {}) => ({
  key: 'W26AA001', name: 'Test Box Fit Tee', category: 'TEES', codes: ['W26AA001'], style_codes: ['W26AA001BLK'], is_core: true, launch: launched,
  stock: { known: true, units: 240, on_order: 0 }, sales: { available: true, units7: 20, units30: 80, units365: 900, initial28: 150, recent28: 70, age_days: 300 },
  tier: { tier: 'rocket', index: 120 }, tierState: 'ok', season: inSeason, coverage: { known: true, active_ads: 6, possible: 0, uncertain: false, min: 5 },
  creatives: [], pipeline: { in_flight: 0, by_stage: {}, uploaded: [], this_week: 0 }, history: { winners: [] }, ...o,
});
// a field of other products so the percentile bands are meaningful: the product under test sits at the top (strong) or the middle (steady)
const filler = (n, u30) => Array.from({ length: n }, (_, i) => base({ key: `F${i}`, name: `Filler ${i}`, sales: { available: true, units7: 2, units30: u30 + i, units365: 300, initial28: 50, recent28: 40, age_days: 200 } }));
const run = (p, mode = 'core', others = filler(9, 10)) => {
  const { items } = opp.assessAll([p, ...others], CFG, TODAY, mode);
  return items[0];
};
const strongSales = { available: true, units7: 40, units30: 150, units365: 1500, initial28: 200, recent28: 140, age_days: 400 };

// ── Core scenarios ─────────────────────────────────────────────────────────
test('1. a Core tee with strong sales and DECLINING creative -> act: fatigue, with the numbers behind it', () => {
  const o = run(base({ sales: strongSales, creatives: [cr('a', 'declining', { age: 150, cpa: 66, concept: 'TRY ON' }), cr('b', 'underperforming', { age: 100, severity: 'clear', cpa: 90 }), cr('c', 'performing', { age: 200, cpa: 48 })] }));
  assert.equal(o.status, 'act'); assert.equal(o.actionable, true); assert.equal(o.gap.type, 'fatigue');
  assert.match(o.gap.text, /declining against its own results/); assert.match(o.headline, /Creative fading/);
  assert.ok(o.why.some((w) => w.k === 'demand' && /Selling strongly: 150 units in the last 30 days/.test(w.text)), 'it says why now');
  assert.ok(o.why.some((w) => w.k === 'recent' && /100 days ago/.test(w.text)), 'and when the last creative was made');
  assert.ok(o.priority && o.score > 0);
});
test('2. a Core tee with enough EFFECTIVE creative -> covered, no action, even with 12 active ads', () => {
  const o = run(base({ sales: strongSales, coverage: { known: true, active_ads: 12, possible: 0, uncertain: false, min: 5 }, creatives: [cr('a', 'performing', { age: 60 }), cr('b', 'performing', { age: 40 }), cr('c', 'performing', { age: 20 }), cr('d', 'underperforming', { age: 200, severity: 'marginal' })] }));
  assert.equal(o.status, 'covered'); assert.equal(o.actionable, false); assert.match(o.reason, /3 of 4 unique creatives are performing/);
});
test('2b. 12 active ads but NO proven effective creative is still a gap: ad count is not coverage', () => {
  const o = run(base({ sales: strongSales, coverage: { known: true, active_ads: 12, possible: 0, uncertain: false, min: 5 }, creatives: Array.from({ length: 6 }, (_, i) => cr(`w${i}`, 'underperforming', { age: 100 + i, severity: 'clear', cpa: 95 })) }));
  assert.equal(o.status, 'act'); assert.equal(o.gap.type, 'confirmed_underperformance');
});
test('3. newly uploaded creative still TESTING -> no action, with the date it will be re-assessed', () => {
  const o = run(base({ sales: strongSales, creatives: [cr('a', 'insufficient', { age: 6, spend: 20 }), cr('b', 'underperforming', { age: 120, severity: 'clear' })] }));
  assert.equal(o.status, 'testing'); assert.equal(o.actionable, false); assert.match(o.reason, /still gathering data/); assert.match(o.reason, /2026-10-20/, 'created 6 days ago + 14-day test period');
});
test('3b. an upload recorded only in WNDRR production (not yet matched to a Meta ad) also counts as testing', () => {
  const o = run(base({ sales: strongSales, creatives: [], pipeline: { in_flight: 0, by_stage: {}, uploaded: [{ date: day(3), concept: 'UGC' }], this_week: 0 } }));
  assert.equal(o.status, 'testing'); assert.match(o.reason, /production record/);
});
test('4. newly uploaded creative with ENOUGH evidence of poor performance -> act, flagged as recent and underperforming', () => {
  const o = run(base({ sales: strongSales, creatives: [cr('a', 'underperforming', { age: 18, severity: 'clear', cpa: 92, spend: 300 }), cr('b', 'underperforming', { age: 140, severity: 'clear', cpa: 99 })] }));
  assert.equal(o.status, 'act'); assert.equal(o.gap.type, 'confirmed_underperformance');
  assert.equal(o.recency.by_phase.recent_weak, 1, 'the 18-day-old creative is "recently launched, underperforming", a real result');
});
test('5. an OUT-OF-SEASON trackpant with lots of stock is not actionable (it stays visible under Out of season)', () => {
  const o = run(base({ name: 'Hoxton V2 Tech Trackpant', category: 'TRACKPANTS', stock: { known: true, units: 900, on_order: 0 }, season: season.assess({ category: 'TRACKPANTS', name: 'Hoxton V2 Tech Trackpant', month: 10 }), creatives: [] }));
  assert.equal(o.status, 'out_of_season'); assert.equal(o.actionable, false); assert.match(o.reason, /Out of season/);
});
test('5b. but an out-of-season product that is selling STRONGLY now is not blanket-banned: the exception is stated', () => {
  const s = season.assess({ category: 'TRACKPANTS', name: 'Hoxton Trackpant', month: 10, strongSellingNow: true });
  assert.equal(s.exception, true); assert.equal(s.relevant, true); assert.match(s.reasons.join(' '), /selling strongly right now despite being out of season/);
});
test('5c. jeans and long pants are NEUTRAL, never excluded on season alone', () => {
  for (const name of ['Booster Carpenter Jean', 'Revoked Cargo Pant', 'Bronco Baggy Jean']) {
    const s = season.assess({ category: 'BOTTOMS', name, month: 10 });
    assert.equal(s.class, 'neutral', name); assert.equal(s.relevant, true, name); assert.equal(s.state, 'neutral', name);
  }
});
test('6. an IN-SEASON short with a genuine creative gap -> act', () => {
  const o = run(base({ name: 'Camp Short', category: 'SHORTS', sales: strongSales, season: season.assess({ category: 'SHORTS', name: 'Camp Short', month: 10 }), creatives: [cr('a', 'underperforming', { age: 90, severity: 'clear' })] }));
  assert.equal(o.status, 'act'); assert.match(o.why.find((w) => w.k === 'season').text, /In season/);
});
test('6b. no creative at all with confirmed matching is a CONFIRMED gap (the strongest kind)', () => {
  const o = run(base({ sales: strongSales, creatives: [], coverage: { known: true, active_ads: 0, possible: 0, uncertain: false, min: 5 } }));
  assert.equal(o.status, 'act'); assert.equal(o.gap.type, 'confirmed_gap'); assert.match(o.headline, /No creative running/);
  assert.equal(o.direction, null, 'no direction is invented when the product has no creative history');
});

// ── data honesty ───────────────────────────────────────────────────────────
test('11. UNCERTAIN Meta matching -> insufficient data, NOT a shoot recommendation', () => {
  const o = run(base({ sales: strongSales, coverage: { known: true, active_ads: 3, possible: 2, uncertain: true, min: 5 }, creatives: [cr('a', 'underperforming', { age: 90, severity: 'clear' })] }));
  assert.equal(o.status, 'insufficient_data'); assert.match(o.reason, /Matching is uncertain/); assert.match(o.reason, /no shoot is recommended on an incomplete count/);
});
test('11b. Meta data unavailable, or creatives that cannot be judged, are not read as underperformance', () => {
  assert.equal(run(base({ sales: strongSales, coverage: { known: false, min: 5 } })).status, 'insufficient_data');
  const o = run(base({ sales: strongSales, creatives: [cr('a', 'unrated', { age: 90 }), cr('b', 'unrated', { age: 80 })] }));
  assert.equal(o.status, 'insufficient_data'); assert.match(o.reason, /no approved benchmark applies/);
  const t = run(base({ sales: strongSales, creatives: [cr('a', 'unavailable', { age: 60 })] }));
  assert.equal(t.status, 'insufficient_data');
});
test('a product with weak demand is not an opportunity (low sell-through is not "needs creative")', () => {
  const o = run(base({ sales: { available: true, units7: 1, units30: 3, units365: 200, initial28: 80, recent28: 3, age_days: 300 }, creatives: [] }));
  assert.equal(o.status, 'weak_demand'); assert.match(o.reason, /Slow sales on their own are not a reason for more creative/);
});
test('low stock is never a recommendation', () => {
  const o = run(base({ stock: { known: true, units: 12, on_order: 200 }, sales: strongSales }));
  assert.equal(o.status, 'low_stock'); assert.match(o.reason, /200 are on order/);
});
test('12. a product already selected for the Shoot Plan is "in production", with the stage counts, not asked for again', () => {
  const o = run(base({ sales: strongSales, creatives: [cr('a', 'underperforming', { age: 90, severity: 'clear' })], pipeline: { in_flight: 2, by_stage: { planned: 1, filmed: 1 }, uploaded: [], this_week: 2 } }));
  assert.equal(o.status, 'in_production'); assert.match(o.reason, /2 concepts already in the Shoot Plan pipeline \(1 planned, 1 filmed\)/);
});
test('10. a FUTURE-launch product with Shopify sales is excluded (the official ApparelMagic date wins over sales)', () => {
  const l = launch.assessFamily({ styles: [{ style_code: 'W26IA006BLK', launchDate: new Date('2026-11-02T00:00:00Z'), qty: 57, shopify: { status: 'ACTIVE', published_at: '2026-08-24T23:02:00Z' } }] }, TODAY);
  const o = run(base({ launch: l, sales: strongSales }));
  assert.equal(o.status, 'not_launched'); assert.equal(o.actionable, false); assert.match(o.reason, /still ahead/);
});
test('18. missing / invalid launch dates go to the verification workflow, never an opportunity', () => {
  const l = launch.assessFamily({ styles: [{ style_code: 'W26IA020FBK', launchDate: null, qty: 34 }] }, TODAY);
  const o = run(base({ launch: l, is_core: false }));
  assert.equal(o.status, 'launch_unknown'); assert.equal(o.actionable, false);
  const bad = launch.assessFamily({ styles: [{ style_code: 'W26IA030BLK', launchDate: null, launchDateRaw: 'TBC', launchDateReadable: false }] }, TODAY);
  assert.equal(run(base({ launch: bad })).status, 'launch_unknown');
});
test('a thin shortfall (some performing creative, fewer than wanted, nothing weak) only acts when demand is strong', () => {
  const thin = [cr('a', 'performing', { age: 100 }), cr('b', 'performing', { age: 90 })];
  assert.equal(run(base({ sales: strongSales, creatives: thin })).gap.type, 'thin');
  const mid = run(base({ sales: { available: true, units7: 6, units30: 24, units365: 400, initial28: 60, recent28: 24, age_days: 300 }, creatives: thin }), 'core', filler(9, 10).map((p, i) => ({ ...p, sales: { ...p.sales, units30: 40 + i * 5 } })));
  assert.notEqual(mid.status, 'act'); assert.match(mid.reason, /thin shortfall alone does not justify action/);
});
test('the direction comes only from the product\'s own history: a previous winner that is no longer running', () => {
  const o = run(base({ sales: strongSales, creatives: [cr('a', 'underperforming', { age: 100, severity: 'clear' })], history: { winners: [{ concept: 'TRY ON', media: 'VIDEO', cpa: 41, spend: 3200, running_now: false }] } }));
  assert.equal(o.direction.basis, 'product_history'); assert.match(o.direction.text, /"TRY ON" concept/); assert.match(o.direction.text, /\$41 CPA/);
});

// ── High Stocks revival ────────────────────────────────────────────────────
const revSales = { available: true, units7: 6, units30: 22, units365: 900, initial28: 260, recent28: 70, age_days: 220 };
const hs = (o = {}) => base({ is_core: false, tier: { tier: 'platinum', index: 188 }, sales: revSales, stock: { known: true, units: 420, on_order: 0 }, creatives: [cr('a', 'declining', { age: 170, cpa: 70 }), cr('b', 'underperforming', { age: 120, severity: 'clear' })], ...o });
test('7. a PLATINUM product with declining sales and declining creative -> revival opportunity, with every required explanation', () => {
  const o = run(hs(), 'revival');
  assert.equal(o.status, 'act'); assert.equal(o.kind, 'high_stock'); assert.equal(o.revival.tier, 'platinum'); assert.equal(o.revival.ratio_pct, 27);
  const text = o.why.map((w) => w.text).join('\n');
  assert.match(text, /Platinum \(index 188\): 260 units in its first 28 days, 70 in the last 28 \(27% of launch pace\)/);
  assert.match(text, /420 units left, about 25\.7 weeks/); assert.match(text, /Last new creative: 120 days ago/);
  assert.ok(o.other_explanations.length >= 1 && o.other_explanations.some((x) => /not measured here/.test(x)), 'other possible causes are listed, not assumed away');
});
test('8. a ROCKET product with strong current performance -> no creative needed (momentum is fine)', () => {
  const o = run(hs({ tier: { tier: 'rocket', index: 120 }, sales: { available: true, units7: 30, units30: 120, units365: 900, initial28: 140, recent28: 120, age_days: 220 } }), 'revival');
  assert.equal(o.status, 'momentum_ok'); assert.equal(o.actionable, false); assert.match(o.reason, /has not lost momentum/);
});
test('9. high stock with NO evidence of historical demand (not Platinum / Rocket) is not a revival opportunity', () => {
  const o = run(hs({ tier: { tier: 'dog', index: 30 }, stock: { known: true, units: 2000, on_order: 0 } }), 'revival');
  assert.equal(o.status, 'no_proven_demand'); assert.match(o.reason, /High stock alone is not a reason for more creative/);
});
test('revival: the tier source being unavailable is reported, never substituted with another metric', () => {
  const o = run(hs({ tier: null, tierState: 'unavailable' }), 'revival');
  assert.equal(o.status, 'unavailable'); assert.match(o.reason, /classification is unavailable/);
});
test('revival: sales down but creative still performing is NOT blamed on creative', () => {
  const o = run(hs({ creatives: [cr('a', 'performing', { age: 40 }), cr('b', 'performing', { age: 50 }), cr('c', 'performing', { age: 60 })] }), 'revival');
  assert.equal(o.status, 'covered');
});
test('revival: too little stock cover, or a product too new to compare, are not actions', () => {
  assert.equal(run(hs({ stock: { known: true, units: 60, on_order: 0 } }), 'revival').status, 'low_stock');
  assert.equal(run(hs({ sales: { ...revSales, age_days: 30 } }), 'revival').status, 'too_new');
  assert.equal(run(hs({ coverage: { known: true, active_ads: 4, possible: 2, uncertain: true, min: 5 }, creatives: [cr('a', 'underperforming', { age: 120, severity: 'clear' })] }), 'revival').status, 'insufficient_data');
});
test('revival: new creative already testing, or concepts already in production, hold the recommendation', () => {
  assert.equal(run(hs({ creatives: [cr('a', 'insufficient', { age: 5 })] }), 'revival').status, 'testing');
  assert.equal(run(hs({ pipeline: { in_flight: 1, by_stage: { awaiting_production: 1 }, uploaded: [], this_week: 1 } }), 'revival').status, 'in_production');
});

// ── never padded ───────────────────────────────────────────────────────────
test('there is no padding: only genuine opportunities are actionable, however few', () => {
  const ps = [base({ key: 'A', sales: strongSales, creatives: [cr('a', 'declining', { age: 100 })] }), ...filler(9, 12).map((p) => ({ ...p, creatives: [cr(`${p.key}c`, 'performing', { age: 50 }), cr(`${p.key}d`, 'performing', { age: 60 }), cr(`${p.key}e`, 'performing', { age: 70 })] }))];
  const { items } = opp.assessAll(ps, CFG, TODAY);
  assert.equal(items.filter((i) => i.actionable).length, 1); assert.equal(items.length, 10);
});

// ── seasonal relevance ─────────────────────────────────────────────────────
test('seasonal relevance: tees, shorts, swim are in season approaching Australian summer; winter fleece / trackpants are not', () => {
  const m = 10;
  for (const [cat, name] of [['TEES', 'Heavy Weight Tee'], ['SHORTS', 'Camp Short'], ['SWIM', 'Board Short'], ['SHIRTS', 'Linen Short Sleeve Shirt']]) assert.equal(season.assess({ category: cat, name, month: m }).state, 'in_season', name);
  for (const [cat, name] of [['TRACKPANTS', 'Hoxton Trackpant'], ['SWEATS', 'Revival Hood Sweat'], ['FLEECE', 'Heavy Fleece Crew']]) assert.equal(season.assess({ category: cat, name, month: m }).state, 'out_of_season', name);
  assert.equal(season.assess({ category: 'TRACKPANTS', name: 'Hoxton Trackpant', month: 6 }).state, 'in_season', 'and the same trackpant is in season in June');
});
test('seasonal relevance: a measured sales pattern outranks the category rule, and the disagreement is shown', () => {
  const s = season.assess({ category: 'TEES', name: 'Box Fit Tee', month: 10, data: 'out_of_season' });
  assert.equal(s.state, 'out_of_season'); assert.equal(s.source, 'sales_pattern'); assert.match(s.reasons.join(' '), /category rule would say the opposite/);
});

// ── creative recency ───────────────────────────────────────────────────────
test('recency phases: testing / recent / established / declining / stale, and no data is never "weak"', () => {
  const ph = (c) => recency.phaseOf(c, TODAY, CFG).phase;
  assert.equal(ph(cr('a', 'insufficient', { age: 5 })), 'testing');
  assert.equal(ph(cr('a', 'insufficient', { age: 40 })), 'unjudged');
  assert.equal(ph(cr('a', 'insufficient', { age: 200 })), 'stale');
  assert.equal(ph(cr('a', 'underperforming', { age: 10 })), 'recent_weak');
  assert.equal(ph(cr('a', 'underperforming', { age: 60 })), 'weak');
  assert.equal(ph(cr('a', 'underperforming', { age: 150 })), 'stale');
  assert.equal(ph(cr('a', 'performing', { age: 10 })), 'recent_performing');
  assert.equal(ph(cr('a', 'performing', { age: 200 })), 'performing');
  assert.equal(ph(cr('a', 'declining', { age: 200 })), 'declining');
  assert.equal(ph(cr('a', 'unrated', { age: 200 })), 'unrated');
});

// ── DPA detection ──────────────────────────────────────────────────────────
test('DPA detection: whole-word DPA in the ad or campaign name, catalogue-sales objective, or a person\'s classification; no substring false positives', () => {
  for (const ad_name of ['DPA - Catalogue', '[DPA] All Products', 'WNDRR_DPA_BAU', 'dpa catalogue retargeting', 'Catalogue | DPA']) assert.equal(dpa.isDpa({ ad_name }), true, ad_name);
  assert.equal(dpa.dpaReason({ campaign_name: 'MOF | DPA | Catalogue' }), 'campaign_name');
  assert.equal(dpa.dpaReason({ ad_name: 'x', objective: 'PRODUCT_CATALOG_SALES' }), 'objective');
  assert.equal(dpa.dpaReason({ ad_name: 'x', concept_label: 'dpa' }), 'classified');
  for (const ad_name of ['ADPAD Heavy Weight Tee', 'Updating Tee DPAX', 'Heavy Weight Tee - Try On', 'Sandpaper Tee', '', null]) assert.equal(dpa.isDpa({ ad_name }), false, String(ad_name));
  assert.equal(dpa.parseDpaMode({}), 'exclude'); assert.equal(dpa.parseDpaMode({ dpa: 'include' }), 'include'); assert.equal(dpa.parseDpaMode({ dpa: 'x' }), 'exclude');
});
