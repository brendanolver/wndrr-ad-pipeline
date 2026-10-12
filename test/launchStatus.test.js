// Batch 12: launch status. Unlaunched products stay out of Core / High Stocks; stock, zero sales or "never had creative" never prove anything.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/lib/launchStatus');
const TODAY = '2026-10-12';
const fam = (styles, extra = {}) => L.assessFamily({ styles, ...extra }, TODAY);

test('a future ApparelMagic launch date = unlaunched (excluded)', () => {
  const f = fam([{ style_code: 'W26AA001BLK', launchDate: new Date('2026-11-01T00:00:00Z'), qty: 0 }], { stock: { known: true, units: 400 } });
  assert.equal(f.status, 'unlaunched'); assert.equal(f.eligible, false); assert.match(f.detail, /still ahead/);
});
test('stock alone proves nothing: no date, no drop, no sales -> UNKNOWN and flagged, not assumed launched, not assumed unlaunched', () => {
  const f = fam([{ style_code: 'W26BB001BLK', launchDate: null, qty: null }], { stock: { known: true, units: 900 } });
  assert.equal(f.status, 'unknown'); assert.equal(f.needs_check, true); assert.equal(f.eligible, false); assert.match(f.detail, /Stock alone does not prove it/);
  assert.equal(fam([{ style_code: 'W26BB001BLK', launchDate: null, qty: 0 }]).status, 'unknown', 'zero sales is not evidence of "unlaunched" either');
});
test('positive sales prove it is on sale (launched) even with no launch date', () => {
  const f = fam([{ style_code: 'W26CC001BLK', launchDate: null, qty: 42 }]);
  assert.equal(f.status, 'launched'); assert.equal(f.basis, 'sales'); assert.equal(f.eligible, true);
  assert.equal(fam([{ style_code: 'W26CC001BLK', launchDate: null, qty: 3 }]).status, 'unknown', 'a handful of units is not enough to be sure');
});
test('a past launch date = launched', () => {
  const f = fam([{ style_code: 'W26DD001BLK', launchDate: new Date('2026-03-01T00:00:00Z'), qty: 0 }]);
  assert.equal(f.status, 'launched'); assert.equal(f.basis, 'launch_date');
});
test('an upcoming drop wins over everything except a manual override: unlaunched, "handled in Upcoming Drops"', () => {
  const drop = { launch_date: '2026-10-20', name: 'Drop 24' };
  const f = fam([{ style_code: 'W26EE001BLK', launchDate: new Date('2026-01-01T00:00:00Z'), qty: 500, drop }]);
  assert.equal(f.status, 'unlaunched'); assert.equal(f.in_upcoming_drop, true); assert.match(f.detail, /Upcoming Drops/);
  assert.equal(fam([{ style_code: 'W26EE001BLK', launchDate: null, qty: 0, drop: { launch_date: '2026-06-01' } }]).status, 'launched', 'a past drop = launched');
});
test('manual override wins and is explained; discontinued is excluded', () => {
  const f = fam([{ style_code: 'W26FF001BLK', launchDate: new Date('2026-12-01T00:00:00Z'), qty: 0, override: { status: 'launched', note: 'soft launch to VIPs' } }]);
  assert.equal(f.status, 'launched'); assert.equal(f.basis, 'manual'); assert.match(f.detail, /soft launch to VIPs/);
  const d = fam([{ style_code: 'W26FF001BLK', qty: 90 }], { familyOverride: { status: 'discontinued' } });
  assert.equal(d.status, 'discontinued'); assert.equal(d.eligible, false);
});
test('colourways are judged one by one: a family with a launched and an unlaunched colour is launched, the unlaunched colour is noted', () => {
  const f = fam([{ style_code: 'W26GG001BLK', launchDate: new Date('2026-02-01T00:00:00Z') }, { style_code: 'W26GG001WHT', launchDate: new Date('2026-12-01T00:00:00Z') }]);
  assert.equal(f.status, 'launched'); assert.match(f.detail, /1 colourway\(s\) have not launched/);
  assert.equal(f.by_style.find((x) => x.style_code === 'W26GG001WHT').status, 'unlaunched');
});
test('upcoming restock: launched, out or low, with a real order on the way', () => {
  const f = fam([{ style_code: 'W26HH001BLK', launchDate: new Date('2026-01-01T00:00:00Z') }], { stock: { known: true, units: 5 }, onOrder: 120 });
  assert.equal(f.status, 'upcoming_restock'); assert.equal(f.eligible, true); assert.equal(f.restock, true);
  assert.equal(fam([{ style_code: 'W26HH001BLK', launchDate: new Date('2026-01-01T00:00:00Z') }], { stock: { known: true, units: 5 }, onOrder: 10 }).status, 'launched', 'too little on order to count as a restock');
  assert.equal(fam([{ style_code: 'W26HH001BLK', launchDate: new Date('2026-01-01T00:00:00Z') }], { stock: { known: true, units: 500 }, onOrder: 500 }).status, 'launched', 'plenty in stock: not a restock case');
});
test('no colourways -> unknown', () => { assert.equal(fam([]).status, 'unknown'); });
