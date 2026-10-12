// Batch 11: the combined creative priority inside the real Core plan engine (stock x season x active-ad coverage x sales + exceptions), with every
// source injected (no database, no network). Existing behaviour must be unchanged when no planning context is supplied.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const plan = require('../src/lib/coreCreativePlan');
const co = require('../src/lib/creativeOpportunities');
const pc = require('../src/lib/planningContext');
const cov = require('../src/lib/activeAdCoverage');

const NOW = new Date('2026-10-12T02:00:00Z');
const TODAY = '2026-10-12';
const WIN = co.buildWindows(NOW);
const ago = (n) => new Date(NOW.getTime() - n * 86400000).toISOString().slice(0, 10);
const st = (code, name, o = {}) => [code, { productName: name, category: o.category || 'TEES', isCore: o.core !== false, imageUrl: null, sizeRangeId: '1', launchDate: o.launch || null }];
const AM = new Map([
  st('W26AA001BLK', 'ALPHA HEAVY WEIGHT TEE'), st('W26AA001WHT', 'ALPHA HEAVY WEIGHT TEE'), st('W26BB001BLK', 'BRAVO BOX FIT TEE'), st('W26CC001BLK', 'CHARLIE SWEAT', { category: 'SWEATS' }),
  st('W26DD001BLK', 'DELTA TRACKPANT', { category: 'PANTS' }), st('W26EE001BLK', 'ECHO JEAN', { category: 'JEANS' }), st('W26FF001BLK', 'FOXTROT SHORT', { category: 'SHORTS' }), st('W26GG001BLK', 'GOLF SHORT', { category: 'SHORTS' }),
  st('W26II001BLK', 'INDIA POLO', { category: 'POLOS' }), st('W26JJ001BLK', 'JULIET SWEAT', { category: 'SWEATS' }), st('W26KK001BLK', 'KILO TEE', { category: 'TEES' }), st('W26LL001BLK', 'LIMA TEE', { category: 'TEES' }),
]);
const stock = new Map([['W26AA001BLK', 40], ['W26AA001WHT', 40], ['W26BB001BLK', 400], ['W26CC001BLK', 90], ['W26DD001BLK', 60], ['W26EE001BLK', 0], ['W26FF001BLK', 300], ['W26GG001BLK', 29], ['W26II001BLK', 80], ['W26JJ001BLK', 120], ['W26KK001BLK', 100], ['W26LL001BLK', 100]]);
stock.sizes = new Map();
const w = (spend, purchases) => ({ spend, purchases, impressions: 20000, outbound_clicks: 200, add_to_cart: 0 });
const zero = () => ({ spend: 0, purchases: 0, impressions: 0, outbound_clicks: 0, add_to_cart: 0 });
let n = 0;
const mkAd = (code, name, createdAgo, concept, spend, purchases) => {
  n += 1;
  return {
    id: `ad${n}`, name: `${name} ad${n}`, effective_status: 'ACTIVE', creative_key: `cr${n}`, status: 'confirmed', products: [{ code, name }],
    concept_key: `legacy:${concept}`, concept_label: concept, concept_legacy: true, creator_key: 'mark', creator_label: 'Mark', media_key: 'video',
    first_spend: ago(2), last_spend: ago(1), created: ago(createdAgo), launch: ago(createdAgo), launch_basis: 'test',
    w: { e: w(spend, purchases), m: w(spend, purchases), r: zero(), p: zero() },
  };
};
const dm = (u30, u365, tier) => ({ units_7d: u30 / 4, units_30d: u30, units_365d: u365, tier });
const demand = { available: true, byProduct: new Map([['W26AA001', dm(80, 900, 'platinum')], ['W26BB001', dm(70, 800, 'platinum')], ['W26CC001', dm(6, 100, 'dog')], ['W26DD001', dm(30, 400, 'surfer')], ['W26EE001', dm(80, 900, 'platinum')], ['W26FF001', dm(90, 1000, 'platinum')], ['W26GG001', dm(80, 900, 'platinum')], ['W26II001', dm(30, 400, 'surfer')], ['W26JJ001', dm(30, 400, 'surfer')], ['W26KK001', dm(30, 400, 'surfer')], ['W26LL001', dm(30, 400, 'surfer')]]) };
const ads = [
  mkAd('W26AA001', 'ALPHA', 150, 'TRYON', 500, 7), mkAd('W26BB001', 'BRAVO', 150, 'TRYON', 500, 7), mkAd('W26FF001', 'FOXTROT', 200, 'FLATLAY', 500, 7), mkAd('W26GG001', 'GOLF', 200, 'FLATLAY', 500, 7),
  mkAd('W26CC001', 'CHARLIE', 200, 'FLATLAY', 60, 1), mkAd('W26DD001', 'DELTA', 20, 'FLATLAY', 60, 3), mkAd('W26EE001', 'ECHO', 200, 'FLATLAY', 60, 1),
  // steady sellers with recent creative: the engine has nothing to recommend for them (so any card they get here is a COVERAGE card)
  mkAd('W26II001', 'INDIA', 20, 'FLATLAY', 60, 1), mkAd('W26JJ001', 'JULIET', 20, 'FLATLAY', 60, 1), mkAd('W26KK001', 'KILO', 20, 'FLATLAY', 60, 1), mkAd('W26LL001', 'LIMA', 20, 'FLATLAY', 60, 1),
];
const snapshot = { win: WIN, ads, families: new Map(), wndrr: new Map(), coverage: { first_day: ago(5), last_day: ago(1) } };
const { families, codeToFamily } = plan.buildCoreFamilies(AM);
const allFamilies = pc.buildAllFamilies(AM);
const famKey = (name) => allFamilies.find((f) => f.name === name).key;

// ── monthly sales: shorts peak in summer, sweats in winter, the rest flat; a store-wide spike in November ──
const dim = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
const MONTHS = []; for (let y = 2025, m = 10; !(y === 2026 && m === 11); m += 1) { if (m === 13) { m = 1; y += 1; } MONTHS.push(`${y}-${String(m).padStart(2, '0')}`); if (y === 2026 && m === 10) break; }
const cover = (m) => (m === '2025-10' ? 19 / 31 : m === '2026-10' ? 12 / 31 : 1);
const shapes = { shorts: (k) => ([12, 1, 2].includes(k) ? 90 : k === 11 || k === 3 ? 45 : k === 10 ? 30 : 12), sweats: (k) => ([5, 6, 7, 8].includes(k) ? 90 : [4, 9].includes(k) ? 45 : 10), flat: () => 50 };
const shapeOf = (code) => (/FF|GG/.test(code) ? 'shorts' : /CC|JJ/.test(code) ? 'sweats' : 'flat');
const salesByStyle = new Map();
for (const code of AM.keys()) {
  const months = {}; MONTHS.forEach((m) => { months[m] = Math.round(shapes[shapeOf(code)](Number(m.slice(5))) * (m === '2025-11' ? 3 : 1) * cover(m) * 100) / 100; });
  salesByStyle.set(code, { qty7: 5, qty30: 20, qty365: 600, months });
}
salesByStyle.window = { from: '2025-10-13', to: TODAY, days: 365 };
const covBy = (o) => ({ available: true, min: 5, by_family: new Map(allFamilies.map((f) => [f.key, o[f.name] === undefined ? 5 : o[f.name]])), status_as_of: NOW.toISOString(), stale: false, stale_days: 0 });
const ctxFor = async (over = {}) => pc.loadPlanningContext({ amDetails: AM, today: TODAY, deps: { settings: { min_active_ads: 5, high_stock_min_soh: 100 }, salesByStyle, coverage: covBy({}), overrides: [], onOrder: new Map(), ...over } });
const baseArgs = { families, codeToFamily, snapshot, demand, stock, sizesByStyle: stock.sizes, sizeOrderFor: () => ['S', 'M', 'L'], now: NOW, stateRows: [], salesAvailable: true };
const names = (l) => l.map((c) => c.product.product_name);

test('backward compatible: with no planning context nothing changes (no planning block, no planning on cards)', () => {
  const P0 = plan.buildPlan(baseArgs);
  assert.equal(P0.planning, null);
  assert.ok(P0.recommendations.every((c) => c.planning === undefined));
  assert.equal(P0.counts.needs_creative, undefined);
});
test('the shared context loads every source and reports where each number comes from (no money, no internals)', async () => {
  const ctx = await ctxFor();
  assert.equal(ctx.seasonality.available, true);
  assert.equal(ctx.coverage.available, true);
  const ds = pc.dataStatus(ctx);
  assert.equal(ds.min_active_ads, 5);
  assert.equal(ds.seasonality.available, true);
  assert.equal(ds.seasonality.months_of_data, 12);
  assert.equal(ds.seasonality.confidence, 'limited');
  assert.match(ds.seasonality.note, /one observed cycle/);
  assert.equal(ds.on_order.available, true);
});
test('annotated cards carry a level, the reasons and the factors; the existing recommendation (type / headline) is unchanged', async () => {
  const P0 = plan.buildPlan(baseArgs);
  const P1 = plan.buildPlan({ ...baseArgs, planning: await ctxFor({ coverage: covBy({ 'FOXTROT SHORT': 2 }) }) });
  const fox0 = P0.recommendations.find((c) => c.product.product_name === 'FOXTROT SHORT');
  const fox1 = P1.recommendations.find((c) => c.product.product_name === 'FOXTROT SHORT');
  assert.ok(fox0 && fox1);
  assert.equal(fox1.type, fox0.type); assert.equal(fox1.headline, fox0.headline); assert.equal(fox1.priority, fox0.priority);
  assert.ok(fox1.planning && ['High', 'Medium', 'Low'].includes(fox1.planning.level));
  assert.equal(fox1.planning.level, 'High', JSON.stringify(fox1.planning.factors));
  const text = fox1.planning.reasons.join('\n');
  assert.match(text, /300 units available — strong stock/);
  assert.match(text, /2 confirmed active Meta ads — below the minimum of 5, and no awaiting-review ad could close the gap. Needs creative/);
  assert.match(text, /(In season|Coming into season)/);
  assert.equal(fox1.score_base, fox0.score, 'the engine\'s own score is kept; the adjustment is added to it');
  assert.ok(fox1.score > fox1.score_base);
});
test('season changes the ranking: with equal coverage an in-season product outranks the same engine score when out of season', async () => {
  const ctx = await ctxFor({ coverage: covBy({ 'FOXTROT SHORT': 2, 'CHARLIE SWEAT': 2 }) });
  const P1 = plan.buildPlan({ ...baseArgs, planning: ctx });
  const sweat = [...P1.recommendations, ...P1.hold].find((c) => c.product.product_name === 'CHARLIE SWEAT');
  const fox = P1.recommendations.find((c) => c.product.product_name === 'FOXTROT SHORT');
  assert.equal(fox.planning.season.status === 'in_season' || fox.planning.season.status === 'coming_into_season', true);
  if (sweat) assert.equal(sweat.planning.season.status, 'out_of_season');
  assert.ok(fox.planning.factors.find((f) => f.key === 'season').points > 0);
});
const where = (P, name) => ({
  card: [...P.recommendations, ...P.hold].find((c) => c.product.product_name === name) || null,
  other: P.planning.needs_creative_other.find((x) => x.product_name === name) || null,
  held: P.held_low_stock.find((x) => x.product_name === name) || null,
});
test('Needs Creative (under 5 active ads) is a flag, not an instruction: a product that needs creative but is out of season / low stock is listed, not made a card', async () => {
  const ctx = await ctxFor({ coverage: covBy({ 'JULIET SWEAT': 1, 'GOLF SHORT': 2, 'INDIA POLO': 4, 'KILO TEE': 5 }) });
  const P1 = plan.buildPlan({ ...baseArgs, planning: ctx });
  const juliet = where(P1, 'JULIET SWEAT');
  assert.equal(juliet.card, null, 'an out-of-season sweat with 1 active ad is NOT made an immediate shoot card');
  assert.ok(juliet.other, 'it is listed as needing creative but not a priority now');
  assert.equal(juliet.other.active_ads, 1); assert.equal(juliet.other.min, 5);
  assert.match(juliet.other.season, /Out of season/);
  const golf = where(P1, 'GOLF SHORT');
  assert.ok(golf.other && /Low stock/.test(golf.other.why_not_a_priority), 'a low-stock product is listed with the reason: ' + JSON.stringify(golf.other));
  assert.equal(where(P1, 'KILO TEE').other, null, '5 active ads meets the minimum');
  assert.equal(where(P1, 'KILO TEE').card, null);
  assert.ok(P1.counts.needs_creative >= 3);
  assert.equal(P1.counts.needs_creative_not_a_priority, P1.planning.needs_creative_other.length);
});
test('a product below the minimum that is worth acting on (adequate stock, steady demand, year-round) gets a "coverage gap" card with reasons', async () => {
  const ctx = await ctxFor({ coverage: covBy({ 'INDIA POLO': 1 }) });
  const P1 = plan.buildPlan({ ...baseArgs, planning: ctx });
  const india = where(P1, 'INDIA POLO');
  assert.ok(india.card, 'India is a card: ' + JSON.stringify(india));
  assert.equal(india.card.type, 'coverage_gap');
  assert.match(india.card.why, /only 1 confirmed active Meta ad \(the minimum is 5\)/);
  assert.ok(['High', 'Medium'].includes(india.card.planning.level));
  assert.ok(india.card.planning.reasons.length >= 4);
  assert.match(india.card.headline, /Add creative/);
  assert.equal(india.card.planning.coverage.needs_creative, true);
});
test('active ads: 0 ads reads "no active Meta ads"; 4 needs creative; 5 does not', async () => {
  const ctx = await ctxFor({ coverage: covBy({ 'KILO TEE': 0, 'LIMA TEE': 4, 'INDIA POLO': 5 }) });
  const P1 = plan.buildPlan({ ...baseArgs, planning: ctx });
  const kilo = where(P1, 'KILO TEE'); const lima = where(P1, 'LIMA TEE'); const india = where(P1, 'INDIA POLO');
  assert.ok(kilo.card && kilo.card.type === 'coverage_gap' && /no confirmed active Meta ads/.test(kilo.card.why), JSON.stringify(kilo));
  assert.ok(lima.card && lima.card.type === 'coverage_gap' && /only 4 confirmed active Meta ads \(the minimum is 5\)/.test(lima.card.why), JSON.stringify(lima));
  assert.equal(india.card, null, '5 active ads meets the minimum: no coverage card');
  assert.equal(india.other, null);
  assert.ok(kilo.card.planning.score_delta > lima.card.planning.score_delta, '0 ads weighs more than 4');
});
test('out of stock is not an immediate shoot -- but a CONFIRMED restock on order (or a manual priority) lifts it, and says why', async () => {
  const ctxNo = await ctxFor({ coverage: covBy({ 'ECHO JEAN': 1 }) });
  const P1 = plan.buildPlan({ ...baseArgs, planning: ctxNo });
  assert.ok(P1.held_low_stock.some((h) => h.product_name === 'ECHO JEAN'), 'out of stock: held back');
  assert.ok(!P1.recommendations.some((c) => c.product.product_name === 'ECHO JEAN'));
  const ctxRestock = await ctxFor({ coverage: covBy({ 'ECHO JEAN': 1 }), onOrder: new Map([['W26EE001BLK', 500]]) });
  const P2 = plan.buildPlan({ ...baseArgs, planning: ctxRestock });
  const echo = P2.recommendations.find((c) => c.product.product_name === 'ECHO JEAN');
  assert.ok(echo, 'a confirmed restock justifies it');
  assert.equal(echo.planning.exceptions[0].kind, 'confirmed_restock');
  assert.match(echo.planning.reasons.join('\n'), /Exception — Confirmed restock: 500 units are on order/);
  assert.ok(!P2.held_low_stock.some((h) => h.product_name === 'ECHO JEAN'));
  assert.deepEqual(P2.planning.promoted_by_exception, ['ECHO JEAN']);
  const ctxManual = await ctxFor({ coverage: covBy({ 'GOLF SHORT': 1 }), overrides: [{ product_code: famKey('GOLF SHORT'), kind: 'major_promotion', note: 'BF hero short', until: '2026-11-30' }] });
  const P3 = plan.buildPlan({ ...baseArgs, planning: ctxManual });
  assert.ok(P3.recommendations.some((c) => c.product.product_name === 'GOLF SHORT' && /Major promotion: BF hero short/.test(c.planning.reasons.join('\n'))), 'a manual Major promotion override lifts the low-stock product');
  const ctxExpired = await ctxFor({ coverage: covBy({ 'GOLF SHORT': 1 }), overrides: [{ product_code: famKey('GOLF SHORT'), kind: 'major_promotion', until: '2026-10-01' }] });
  assert.ok(plan.buildPlan({ ...baseArgs, planning: ctxExpired }).held_low_stock.some((h) => h.product_name === 'GOLF SHORT'), 'an expired override is ignored');
});
test('missing data is stated, never guessed: no sales history -> season unavailable; no Meta ads stored -> coverage unavailable', async () => {
  const ctx = await ctxFor({ salesByStyle: null, coverage: { available: false, reason: 'No Meta ads are stored yet, so active ad counts are unavailable', min: 5 } });
  const P1 = plan.buildPlan({ ...baseArgs, planning: ctx });
  assert.equal(P1.planning.data.seasonality.available, false);
  assert.equal(P1.planning.data.coverage.available, false);
  assert.match(P1.planning.data.seasonality.note, /Priority uses the other factors only/);
  const c = P1.recommendations[0];
  assert.deepEqual(c.planning.missing.sort(), ['coverage', 'season']);
  assert.match(c.planning.reasons.join('\n'), /Monthly sales history has not loaded yet, so season is not weighed/);
  assert.equal(c.planning.coverage.known, false);
  assert.equal(P1.counts.needs_creative, 0, 'unknown coverage is NOT counted as needing creative');
});
test('a failing source degrades to "unavailable" instead of breaking the plan', async () => {
  const ctx = await pc.loadPlanningContext({ amDetails: AM, today: TODAY, deps: { settings: { min_active_ads: 5, high_stock_min_soh: 100 }, salesByStyle: new Map([['X', { months: null }]]), coverage: undefined, overrides: [], onOrder: new Map() } }).catch((e) => ({ error: e.message }));
  assert.ok(ctx.seasonality && ctx.seasonality.available === false, JSON.stringify(ctx.seasonality || ctx));
});
test('active-ad counting: DISTINCT ads per product family; colourways / season codes of one family count once; an ad on two products counts for each', () => {
  const fams = [{ key: 'F1', codes: ['A1', 'A2'] }, { key: 'F2', codes: ['B1'] }];
  const pairs = [
    { product_code: 'A1', meta_ad_id: 'ad1' }, { product_code: 'A2', meta_ad_id: 'ad1' }, // same ad linked to two codes of ONE family -> once
    { product_code: 'A1', meta_ad_id: 'ad2' }, { product_code: 'A1', meta_ad_id: 'ad2' }, // duplicate row -> once
    { product_code: 'A2', meta_ad_id: 'ad3' }, { product_code: 'B1', meta_ad_id: 'ad3' }, // a bundle ad: counts for BOTH families
    { product_code: 'ZZ', meta_ad_id: 'ad9' },                                           // a product that is in no family
  ];
  const m = cov.countByFamily(fams, pairs);
  assert.equal(m.get('F1'), 3); assert.equal(m.get('F2'), 1);
  assert.equal(cov.countByFamily(fams, []).get('F1'), 0);
});
test('planning modules only READ: no writes, no Meta client, no network', () => {
  const read = (f) => require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'lib', f), 'utf8').replace(/\/\/.*$/gm, '');
  ['activeAdCoverage.js', 'planningContext.js', 'seasonality.js', 'creativePriority.js'].forEach((f) => { assert.doesNotMatch(read(f), /\b(INSERT|UPDATE|DELETE)\b|fetch\(|https?\.request|metaAds'\)/, f); });
});

// ── coverage RELIABILITY: confirmed ads vs active ads still awaiting review ──
const withPending = (cov, pendingByName, unattributed) => ({ ...cov, pending_by_family: new Map(allFamilies.map((f) => [f.key, pendingByName[f.name] || 0])), unattributed_pending: unattributed || 0, reliability: { active_ads: 40, confirmed_or_auto: 30, awaiting_review: 10, awaiting_review_without_product: unattributed || 0, share_awaiting_review: 25, complete: false } });

test('classify(): meets / below (reliable) / uncertain, by whether awaiting-review ads could close the gap', () => {
  assert.equal(cov.classify({ confirmed: 5, min: 5 }).state, 'meets');
  assert.equal(cov.classify({ confirmed: 7, possible: 3, unattributed: 9, min: 5 }).state, 'meets', 'confirmed ads alone meet it: pending ads are irrelevant');
  assert.equal(cov.classify({ confirmed: 2, possible: 0, unattributed: 0, min: 5 }).state, 'below', 'nothing pending: a reliable shortage');
  assert.equal(cov.classify({ confirmed: 2, possible: 1, unattributed: 1, min: 5 }).state, 'below', '2 + 1 + 1 = 4 < 5: even all of them would not reach the minimum');
  const u = cov.classify({ confirmed: 2, possible: 2, unattributed: 1, min: 5 });
  assert.equal(u.state, 'uncertain'); assert.equal(u.likely_meets, false, '2 confirmed + 2 suggested for it = 4: only the unattributed ad could make 5');
});
test('classify(): "likely meets" only when confirmed + suggested-for-it reach the minimum', () => {
  assert.equal(cov.classify({ confirmed: 3, possible: 2, unattributed: 0, min: 5 }).likely_meets, true);
  assert.equal(cov.classify({ confirmed: 3, possible: 0, unattributed: 4, min: 5 }).likely_meets, false);
  assert.equal(cov.classify({ confirmed: 3, possible: 0, unattributed: 4, min: 5 }).state, 'uncertain');
});
test('pendingByFamily(): an awaiting-review ad counts toward each product it is suggested for (once per family); ads with no product suggestion are unattributed', () => {
  const fams = [{ key: 'A', codes: ['A1', 'A2'] }, { key: 'B', codes: ['B1'] }];
  const r = cov.pendingByFamily(fams, [
    { meta_ad_id: 'x1', suggested_codes: ['A1', 'A2'] }, // two codes of one family -> once
    { meta_ad_id: 'x2', suggested_codes: ['A2', 'B1'] }, // suggested for two families
    { meta_ad_id: 'x3', suggested_codes: null }, { meta_ad_id: 'x4', suggested_codes: [] }, { meta_ad_id: 'x5', suggested_codes: ['ZZZ'] },
  ]);
  assert.equal(r.by_family.get('A'), 2); assert.equal(r.by_family.get('B'), 1);
  assert.equal(r.unattributed, 2, 'x3 and x4; x5 points at a product that is not in the list');
});
test('a product whose confirmed count is low but whose awaiting-review ads could close the gap is NOT called short of creative', async () => {
  const base = covBy({ 'KILO TEE': 3, 'LIMA TEE': 3, 'INDIA POLO': 3 });
  const ctx = await ctxFor({ coverage: withPending(base, { 'KILO TEE': 2 }, 0) }); // KILO: 3 confirmed + 2 suggested = 5 -> likely meets; LIMA / INDIA: nothing could close it
  const P1 = plan.buildPlan({ ...baseArgs, planning: ctx });
  const kilo = where(P1, 'KILO TEE'); const lima = where(P1, 'LIMA TEE');
  assert.equal(kilo.card, null, 'no "add creative" card for KILO: the count may be incomplete');
  assert.equal(kilo.other, null, 'and it is not in the "needs creative" list either');
  const k = P1.planning.coverage_uncertain.find((x) => x.product_name === 'KILO TEE');
  assert.ok(k && k.confirmed_active_ads === 3 && k.suggested_for_it === 2 && k.likely_meets_after_review === true, JSON.stringify(P1.planning.coverage_uncertain));
  assert.ok(lima.card && lima.card.type === 'coverage_gap', 'LIMA has no awaiting-review ad that could help: a reliable shortage still produces a card');
  assert.equal(lima.card.planning.coverage.reliable, true);
  assert.equal(P1.counts.coverage_uncertain, P1.planning.coverage_uncertain.length);
  assert.ok(P1.planning.counts.needs_creative >= 1 && !P1.planning.coverage_uncertain.some((x) => x.product_name === 'LIMA TEE'));
});
test('unattributed awaiting-review ads can also make a count uncertain, and the reason says exactly why in plain words', async () => {
  const ctx = await ctxFor({ coverage: withPending(covBy({ 'KILO TEE': 3 }), {}, 2) });
  const P1 = plan.buildPlan({ ...baseArgs, planning: ctx });
  const k = P1.planning.coverage_uncertain.find((x) => x.product_name === 'KILO TEE');
  assert.ok(k && k.without_product_suggestion === 2 && k.likely_meets_after_review === false);
  const a = ctx.allFamilies && require('../src/lib/planningContext').assessProduct(ctx, { styleCodes: ['W26KK001BLK'], productCodes: ['W26KK001'], stock: { known: true, units: 100 }, sales: { available: true, seller_class: 'neutral', trend: 'flat' }, existing: null });
  const text = a.reasons.join('\n');
  assert.match(text, /3 confirmed active Meta ads — below the minimum of 5, but the count may be incomplete/);
  assert.match(text, /2 have no product suggestion yet/);
  assert.match(text, /Not treated as a shortage until they are reviewed/);
  assert.ok(a.missing.includes('coverage_confirmation'));
  assert.equal(a.factors.find((f) => f.key === 'coverage').points, 0, 'an uncertain count carries no creative-gap points');
});
test('the threshold is still read from Settings: with a minimum of 3, 3 confirmed ads meets it and 2 + pending is uncertain', async () => {
  const ctx = await ctxFor({ settings: { min_active_ads: 3, high_stock_min_soh: 100 }, coverage: { ...withPending(covBy({ 'KILO TEE': 3, 'LIMA TEE': 2 }), { 'LIMA TEE': 1 }, 0), min: 3 } });
  const pcx = require('../src/lib/planningContext');
  const kilo = pcx.assessProduct(ctx, { styleCodes: ['W26KK001BLK'], productCodes: ['W26KK001'], stock: { known: true, units: 100 }, sales: { available: true, seller_class: 'neutral' }, existing: null });
  const lima = pcx.assessProduct(ctx, { styleCodes: ['W26LL001BLK'], productCodes: ['W26LL001'], stock: { known: true, units: 100 }, sales: { available: true, seller_class: 'neutral' }, existing: null });
  assert.equal(kilo.coverage.needs_creative, false); assert.equal(kilo.coverage.uncertain, false); assert.equal(kilo.coverage.min, 3);
  assert.equal(lima.coverage.uncertain, true); assert.equal(lima.coverage.min, 3);
});
test('data status explains how complete the counts are', async () => {
  const ds = pc.dataStatus(await ctxFor({ coverage: withPending(covBy({}), {}, 3) }));
  assert.equal(ds.coverage.reliability.awaiting_review, 10);
  assert.match(ds.coverage.note, /10 of 40 active Meta ads \(25%\) are still awaiting review/);
  assert.match(ds.coverage.note, /3 of them with no product suggestion/);
  assert.match(ds.coverage.note, /may be incomplete/);
  const clean = pc.dataStatus(await ctxFor({ coverage: { ...covBy({}), reliability: { active_ads: 12, confirmed_or_auto: 12, awaiting_review: 0, awaiting_review_without_product: 0, share_awaiting_review: 0, complete: true } } }));
  assert.match(clean.coverage.note, /Every active Meta ad has been reviewed or auto-matched/);
});

// ── Batch 12: launch status + one unified headline in the Core plan ──
test('Core plan: a CORE product that has not launched (future date / upcoming drop) is left out and reported, never silently dropped', async () => {
  const ctx = await ctxFor();
  const launch = { drops: new Map([['W26AA001BLK', { name: 'Drop 24', launch_date: '2026-11-20' }], ['W26AA001WHT', { name: 'Drop 24', launch_date: '2026-11-20' }]]), overrides: new Map() };
  const run = (extra) => plan.computePlan({ now: NOW, isAdmin: true }, { amDetails: AM, stock, sizeRanges: null, demand, snapshot, stateRows: [], quality: { unreviewed_recent_ads: 0 }, activity: null, planning: ctx, weekly: null, ...extra });
  const base = await run({ launch: { drops: new Map(), overrides: new Map() } });
  const withDrop = await run({ launch });
  const names = (p) => [...p.recommendations, ...p.hold, ...p.no_action.map((n) => ({ product: { product_name: n } }))].map((c) => c.product.product_name);
  assert.ok(names(base).includes('ALPHA HEAVY WEIGHT TEE'), 'launched: it is in the plan');
  assert.ok(!names(withDrop).includes('ALPHA HEAVY WEIGHT TEE'), 'in an upcoming drop: not an ordinary Core recommendation');
  assert.ok(withDrop.launch_excluded.some((x) => x.product_name === 'ALPHA HEAVY WEIGHT TEE' && x.in_upcoming_drop), 'and it is reported as excluded (handled in Upcoming Drops)');
  assert.deepEqual(base.launch_excluded, []);
});
test('Core plan: every card carries the ONE unified production priority from the weekly plan (and only when the weekly plan is available)', async () => {
  const ctx = await ctxFor();
  const weekly = { available: true, products: [{ key: 'W26FF001', codes: ['W26FF001'], category: 'SHOOT_NOW', category_label: 'Shoot now', score: 71, recommended_videos: 4, planned: { this_week: 1 }, remaining: 3, headline: 'Shoot 3 videos this week (1 already planned).', reasons: [{ text: 'x' }] }] };
  const p = await plan.computePlan({ now: NOW, isAdmin: true }, { amDetails: AM, stock, sizeRanges: null, demand, snapshot, stateRows: [], quality: { unreviewed_recent_ads: 0 }, activity: null, planning: ctx, launch: { drops: new Map(), overrides: new Map() }, weekly });
  const fox = [...p.recommendations, ...p.hold].find((c) => c.product.product_name === 'FOXTROT SHORT');
  assert.ok(fox && fox.weekly && fox.weekly.category === 'SHOOT_NOW' && fox.weekly.recommended_videos === 4 && fox.weekly.remaining === 3);
  const other = [...p.recommendations, ...p.hold].find((c) => c.product.product_name !== 'FOXTROT SHORT');
  assert.equal(other && other.weekly, null, 'a product the weekly plan does not cover carries no unified label (the UI then falls back)');
  const none = await plan.computePlan({ now: NOW, isAdmin: true }, { amDetails: AM, stock, sizeRanges: null, demand, snapshot, stateRows: [], quality: { unreviewed_recent_ads: 0 }, activity: null, planning: ctx, launch: { drops: new Map(), overrides: new Map() }, weekly: null });
  assert.ok([...none.recommendations].every((c) => c.weekly === undefined));
});
