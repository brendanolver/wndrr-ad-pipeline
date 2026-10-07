// Core creative plan: CORE families, stock gate, size warning, recommendations, history folding and
// server-side money stripping. Pure (no database / network): the real engine runs over an in-memory snapshot.
//   npm test
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused'; // pool is lazy; never connected here
const test = require('node:test');
const assert = require('node:assert/strict');
const plan = require('../src/lib/coreCreativePlan');
const co = require('../src/lib/creativeOpportunities');

const NOW = new Date('2026-10-07T02:00:00Z');
const WIN = co.buildWindows(NOW);
const ago = (n) => { const d = new Date(NOW.getTime() - n * 86400000); return d.toISOString().slice(0, 10); };
const st = (code, name, o = {}) => [code, { productName: name, category: o.category || 'TEES', isCore: o.core !== false, imageUrl: null, sizeRangeId: '1' }];
const AM = new Map([
  st('W26AA001BLK', 'ALPHA HEAVY WEIGHT TEE'), st('W26AA001WHT', 'ALPHA HEAVY WEIGHT TEE'), st('W24AA001BLK', 'ALPHA HEAVY WEIGHT TEE', { core: false }),
  st('W26BB001BLK', 'BRAVO BOX FIT TEE'), st('W26CC001BLK', 'CHARLIE SWEAT'), st('W26DD001BLK', 'DELTA TRACKPANT'), st('W26EE001BLK', 'ECHO JEAN'),
  st('W26FF001BLK', 'FOXTROT SHORT'), st('W26GG001BLK', 'GOLF SHORT'), st('W26II001BLK', 'INDIA POLO'), st('W23II001BLK', 'INDIA POLO', { core: false }),
  st('W26HA001BLK', 'HAT', { category: 'ACCESSORIES' }), st('W26HH001BLK', 'HOTEL HOODIE', { core: false }), st('SHIPPROTECT', 'Shipping protection'),
]);
const stock = new Map([['W26AA001BLK', 40], ['W26AA001WHT', 40], ['W26BB001BLK', 120], ['W26CC001BLK', 90], ['W26DD001BLK', 60], ['W26EE001BLK', 20], ['W26FF001BLK', 30], ['W26GG001BLK', 29], ['W26II001BLK', 80], ['W23II001BLK', 5], ['W26HA001BLK', 500], ['W26HH001BLK', 500]]);
stock.sizes = new Map([['W26AA001BLK', new Map(Object.entries({ S: 10, M: 0, L: 0, XL: 30 }))], ['W26AA001WHT', new Map(Object.entries({ S: 0, M: 0, L: 0, XL: 40 }))]]);
const w = (spend, purchases) => ({ spend, purchases, impressions: 20000, outbound_clicks: 200, add_to_cart: 0 });
const zero = () => ({ spend: 0, purchases: 0, impressions: 0, outbound_clicks: 0, add_to_cart: 0 });
let n = 0;
const mkAd = (code, name, createdAgo, concept, spend, purchases, creative) => {
  n += 1;
  return {
    id: `ad${n}`, name: `${name} ad${n}`, effective_status: 'ACTIVE', creative_key: creative || `cr${n}`, status: 'confirmed', products: [{ code, name }],
    concept_key: `legacy:${concept}`, concept_label: concept, concept_legacy: true, creator_key: 'mark', creator_label: 'Mark', media_key: 'video',
    first_spend: ago(2), last_spend: ago(1), created: ago(createdAgo), launch: ago(createdAgo), launch_basis: 'test',
    w: { e: w(spend, purchases), m: w(spend, purchases), r: zero(), p: zero() },
  };
};
const dm = (u30, u365, tier) => ({ units_7d: u30 / 4, units_30d: u30, units_365d: u365, tier });
const demand = { available: true, byProduct: new Map([['W26AA001', dm(80, 900, 'platinum')], ['W24AA001', dm(10, 100, null)], ['W26BB001', dm(70, 800, 'platinum')], ['W26CC001', dm(6, 100, 'dog')], ['W26DD001', dm(5, 90, 'egg')], ['W26EE001', dm(60, 700, 'platinum')], ['W26FF001', dm(50, 600, 'rocket')], ['W26GG001', dm(40, 500, 'platinum')], ['W26II001', dm(30, 400, 'platinum')]]) };
const A = 'W26AA001'; const B = 'W26BB001';
const ads = [
  mkAd(A, 'ALPHA', 90, 'TRYON', 500, 7), mkAd(A, 'ALPHA', 150, 'TRYON', 500, 7),
  mkAd(B, 'BRAVO', 10, 'TRYON', 500, 7), mkAd(B, 'BRAVO', 20, 'CAROUSEL', 500, 3), mkAd(B, 'BRAVO', 30, 'CAROUSEL', 500, 3),
  mkAd('W26CC001', 'CHARLIE', 200, 'FLATLAY', 60, 1),
  mkAd('W26DD001', 'DELTA', 10, 'FLATLAY', 60, 0), mkAd('W26DD001', 'DELTA', 25, 'FLATLAY', 60, 0), mkAd('W26DD001', 'DELTA', 40, 'FLATLAY', 60, 0),
  mkAd('W26EE001', 'ECHO', 150, 'FLATLAY', 60, 1), mkAd('W26GG001', 'GOLF', 150, 'FLATLAY', 60, 1), mkAd('W26FF001', 'FOXTROT', 150, 'FLATLAY', 60, 1),
  mkAd('W23II001', 'INDIA', 200, 'FLATLAY', 60, 1), // history under the OLD season code
  mkAd('W26HH001', 'HOTEL', 5, 'FLATLAY', 60, 1),
];
const snapshot = { win: WIN, ads, families: new Map(), wndrr: new Map(), coverage: { first_day: ago(5), last_day: ago(1) } };
const { families, codeToFamily } = plan.buildCoreFamilies(AM);
const sizeOrderFor = () => ['S', 'M', 'L', 'XL'];
const build = (over = {}) => plan.buildPlan({ families, codeToFamily, snapshot, demand, stock, sizesByStyle: stock.sizes, sizeOrderFor, now: NOW, stateRows: [], salesAvailable: true, ...over });
const P = build();
const names = (l) => l.map((c) => c.product.product_name);

test('CORE universe: colourways merged, old season codes join the family, accessories / non-core / non-WNDRR codes excluded', () => {
  assert.equal(families.length, 8);
  const alpha = families.find((f) => f.name === 'ALPHA HEAVY WEIGHT TEE');
  assert.deepEqual(alpha.codes, ['W24AA001', 'W26AA001']);
  assert.deepEqual(alpha.core_codes, ['W26AA001']);
  assert.equal(codeToFamily.get('W24AA001'), alpha);
  assert.ok(!families.some((f) => /HAT|HOTEL|Shipping/i.test(f.name)));
});

test('STOCK GATE: 30 passes, 29 and 20 do not; below the gate means no shoot recommendation, listed as held back', () => {
  assert.equal(plan.familyStock(families.find((f) => f.name === 'FOXTROT SHORT'), stock, null, []).pass, true);
  assert.equal(plan.familyStock(families.find((f) => f.name === 'GOLF SHORT'), stock, null, []).pass, false);
  assert.deepEqual(P.held_low_stock.map((x) => `${x.product_name}:${x.units}`).sort(), ['ECHO JEAN:20', 'GOLF SHORT:29']);
  assert.ok(P.held_low_stock.every((x) => x.would_have_been === 'Shoot fresh creative'));
  assert.ok(!names(P.recommendations).some((nme) => /ECHO|GOLF/.test(nme)));
});

test('stock UNKNOWN: never a shoot recommendation', () => {
  const U = build({ stock: null, sizesByStyle: null });
  assert.equal(U.recommendations.length, 0);
  assert.equal(U.counts.stock_known, false);
  assert.ok(U.held_low_stock.every((x) => x.known === false));
});

test('stock is summed across colourways AND old season codes of the family', () => {
  const alpha = families.find((f) => f.name === 'ALPHA HEAVY WEIGHT TEE');
  assert.equal(plan.familyStock(alpha, stock, stock.sizes, ['S', 'M', 'L', 'XL']).units, 80);
});

test('size availability is a WARNING only (never a gate)', () => {
  const alpha = P.recommendations.find((c) => c.product.product_name === 'ALPHA HEAVY WEIGHT TEE' && c.type === 'shoot_fresh');
  assert.ok(alpha, 'ALPHA still gets its recommendation despite broken sizes');
  assert.match(alpha.stock.size_warning, /Broken sizes: M, L low or sold out/);
  const h = (qs) => plan.sizeHealth(plan.orderSizes(Object.entries(qs), ['S', 'M', 'L', 'XL']));
  assert.equal(h({ S: 9, M: 9, L: 9, XL: 9 }).level, 'ok');
  assert.equal(h({ S: 9, M: 0, L: 9, XL: 9 }).level, 'limited');
  assert.equal(h({ S: 9, M: 0, L: 0, XL: 9 }).level, 'broken');
  assert.equal(plan.sizeHealth([{ size: 'S', qty: 5 }]).available, false);
});

test('strong seller + stale creative -> Shoot fresh creative; strong + enough fresh creative -> no action', () => {
  const alpha = P.recommendations.find((c) => c.product.product_name === 'ALPHA HEAVY WEIGHT TEE' && c.type === 'shoot_fresh');
  assert.equal(alpha.headline, 'Shoot fresh creative');
  assert.match(alpha.why, /selling strongly/);
  assert.ok(!names(P.recommendations).includes('BRAVO BOX FIT TEE'));
  assert.ok(P.no_action.includes('BRAVO BOX FIT TEE'));
});

test('weak seller + stale -> Test new creative; weak despite 3 recent new creatives -> HOLD, not "shoot more"', () => {
  const t = P.recommendations.find((c) => c.type === 'test_new');
  assert.equal(t.product.product_name, 'CHARLIE SWEAT');
  assert.deepEqual(names(P.hold), ['DELTA TRACKPANT']);
  assert.match(P.hold[0].why, /unlikely to be the fix/);
  assert.ok(!names(P.recommendations).includes('DELTA TRACKPANT'));
});

test('"Try this concept on X": only eligible CORE products that have not tried it', () => {
  const tries = P.recommendations.filter((c) => c.type === 'try_concept');
  assert.ok(tries.length >= 1);
  assert.ok(tries.every((c) => c.headline.startsWith('Try TRYON on ')));
  assert.ok(tries.some((c) => c.product.product_name === 'FOXTROT SHORT'));
  assert.ok(!tries.some((c) => /ECHO|GOLF|DELTA|ALPHA|BRAVO/.test(c.product.product_name)), 'low stock, on-hold and already-tested products are excluded');
});

test('history under an OLD season code (same canonical name) carries over to the family', () => {
  const india = P.recommendations.find((c) => c.product.product_name === 'INDIA POLO' && c.type === 'shoot_fresh');
  assert.ok(india);
  assert.ok(india.creative.last_new_creative.days_ago >= 199);
  assert.doesNotMatch(india.why, /no creative on record/);
});

test('exactly one decision per product: never both a shoot card and a hold, accessories / non-core absent', () => {
  assert.ok(!JSON.stringify(P).match(/HOTEL|"HAT"|SHIPPROTECT/));
  const holdNames = new Set(names(P.hold));
  assert.ok(![...holdNames].some((nme) => P.recommendations.some((c) => c.product.product_name === nme && c.type !== 'try_concept')));
});

test('non-admin payload carries NO spend / purchases / CPA, but the same recommendations', () => {
  const sanitized = plan.sanitizeForUser({ ...P, concepts: { proven: 1, benchmark_cpa: 80 } }, false);
  assert.doesNotMatch(JSON.stringify(sanitized), /"admin"|spend_90d|purchases_90d|"cpa"/);
  assert.equal(sanitized.recommendations.length, P.recommendations.length);
  assert.equal(sanitized.recommendations[0].meta_status, P.recommendations[0].meta_status);
  assert.match(JSON.stringify(P), /"admin"/);
});

test('sales unavailable: no seller-based recommendations', () => {
  const S = build({ salesAvailable: false, demand: { available: false, reason: 'x', byProduct: new Map() } });
  assert.equal(S.recommendations.length, 0);
});

test('a steady seller is only flagged when it has no creative at all', () => {
  const f = families.find((x) => x.name === 'BRAVO BOX FIT TEE');
  const steady = { code: f.key, name: f.name, entries: [], sales: { seller_class: 'neutral', units_30d: 20, units_365d: 100, vel30: 5, tier_label: null, trend: { direction: 'flat' } }, e: zero(), m: zero() };
  const facts = plan.creativeFacts(steady, WIN.today, new Map());
  const rec = plan.recommendFamily({ family: f, ps: steady, facts, stock: { units: 100, size: { warning: null } }, benchmarkCpa: 80, salesAvailable: true });
  assert.equal(rec.type, 'test_new');
});

test('creative recency is honest about its reliable window', () => {
  const ps = { code: 'X', entries: [{ ad: mkAd('X', 'X', 200, 'C', 0, 0) }], sales: null, e: zero(), m: zero() };
  const facts = plan.creativeFacts(ps, WIN.today, new Map());
  assert.equal(facts.recency_basis, 'older_than_window');
  const none = plan.creativeFacts({ code: 'Y', entries: [], sales: null, e: zero(), m: zero() }, WIN.today, new Map());
  assert.equal(none.recency_basis, 'none_found');
  assert.equal(none.last_new_creative, null);
});
