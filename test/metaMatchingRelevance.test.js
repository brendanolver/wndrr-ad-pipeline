// Which products are worth a person's ad-matching time: CORE apparel with sellable stock > 0 (NOT the
// Planning/Core "< 30 units: don't shoot" threshold). Pure (no database / network).
//   npm test
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused'; // pool is lazy; never connected here
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const rel = require('../src/lib/metaMatchingRelevance');
const cfg = require('../src/lib/coreCreativePlanConfig');

const st = (code, name, o = {}) => [code, { productName: name, category: o.category || 'TEES', isCore: o.core !== false, imageUrl: null, sizeRangeId: '1' }];
const AM = new Map([
  st('W26AA001BLK', 'ALPHA HEAVY WEIGHT TEE'), st('W26BB001BLK', 'BRAVO BOX FIT TEE'), st('W26CC001BLK', 'CHARLIE SWEAT'),
  st('W26DD001BLK', 'DELTA TRACKPANT'), st('W26HA001BLK', 'HAT', { category: 'ACCESSORIES' }), st('W26HH001BLK', 'HOTEL HOODIE', { core: false }),
  st('W26NN001BLK', 'NOVEL JACKET'),
]);
// ALPHA 12 units (below the 30-unit SHOOT threshold but still sellable), BRAVO 500, CHARLIE 0, accessory/non-core stocked, NOVEL has no stock record
const stock = new Map([['W26AA001BLK', 12], ['W26BB001BLK', 500], ['W26CC001BLK', 0], ['W26DD001BLK', 40], ['W26HA001BLK', 900], ['W26HH001BLK', 900]]);
const amStatus = { catalogue: { hasData: true }, stock: { hasData: true } };

test('CORE + any sellable stock is relevant -- including 12 units, which Planning/Core would not shoot', async () => {
  assert.ok(12 < cfg.STOCK.min_sellable_units, 'fixture is below the shoot threshold');
  const r = await rel.loadRelevantProducts({ amDetails: AM, stock, amStatus });
  assert.equal(r.known, true);
  assert.ok(r.relevant_codes.includes('W26AA001'), '12 units still counts');
  assert.ok(r.relevant_codes.includes('W26BB001'));
  assert.ok(r.relevant_codes.includes('W26DD001'));
});

test('zero stock, accessories and non-CORE products are not relevant', async () => {
  const r = await rel.loadRelevantProducts({ amDetails: AM, stock, amStatus });
  assert.ok(!r.relevant_codes.includes('W26CC001'), 'zero stock');
  assert.ok(!r.relevant_codes.includes('W26HA001'), 'accessory');
  assert.ok(!r.relevant_codes.includes('W26HH001'), 'non-CORE');
  assert.equal(r.zero_stock_families, 1);
});

test('a CORE family with NO inventory record is a data gap, not zero stock: it stays relevant', async () => {
  const r = await rel.loadRelevantProducts({ amDetails: AM, stock, amStatus });
  assert.ok(r.relevant_codes.includes('W26NN001'));
  assert.equal(r.stock_unknown_families, 1);
});

test('stock or catalogue not loaded -> relevance is UNAVAILABLE (callers then hide nothing)', async () => {
  const a = await rel.loadRelevantProducts({ amDetails: AM, stock: null, amStatus });
  assert.equal(a.known, false);
  assert.match(a.reason, /stock/i);
  assert.deepEqual(a.relevant_codes, []);
  const b = await rel.loadRelevantProducts({ amStatus: { catalogue: { hasData: false }, stock: { hasData: false } } });
  assert.equal(b.known, false);
});

test('the per-ad rule: unavailable -> actionable; running -> actionable; product evidence decides; else recency', () => {
  const sql = rel.relevanceCase({ rel: '$1', known: '$2', d7: '$3', d30: '$4' });
  const order = ['NOT $2', "effective_status = 'ACTIVE'", 'ev.codes::text[] && $1::text[]', 'cardinality(ev.codes) > 0', '$4'].map((needle) => sql.indexOf(needle));
  assert.ok(order.every((i) => i >= 0), 'every branch present');
  assert.deepEqual([...order].sort((x, y) => x - y), order, 'branches are evaluated in the documented order');
  assert.match(sql, /THEN 'actionable'[\s\S]*THEN 'historical'[\s\S]*ELSE 'historical'/);
});

test('only medium+ product suggestions count as product evidence', () => {
  assert.equal(rel.MEDIUM_CONFIDENCE, 0.6);
  assert.match(rel.EVIDENCE_JOIN, /confidence >= 0\.6/);
});

test('relevance is read-only: no writes, no Meta / ApparelMagic write verbs', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'metaMatchingRelevance.js'), 'utf8');
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /\b(INSERT|UPDATE|DELETE)\b|metaAds|method:\s*['"](POST|PUT|PATCH|DELETE)/);
});
