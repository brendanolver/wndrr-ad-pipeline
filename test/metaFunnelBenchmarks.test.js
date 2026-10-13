// Per-funnel benchmarks for six measures: direction, range rule, parsing of the table's funnel checkboxes. Pure logic (no database).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const health = require('../src/lib/metaFunnelHealth');
const bench = require('../src/lib/metaBenchmarks');
const perf = require('../src/lib/metaPerformance');

const row = (funnel, metric, target, extra = {}) => ({ funnel, metric, target, target_min: null, inclusive: true, tolerance_pct: 20, active: true, min_days: null, max_days: null, ...extra });
const cls = (rows, f, m, v, days = 7) => { const c = bench.compile(rows); return health.classify(f, m, v, { days }, { rules: c.rules, coded: c.coded }); };

test('nine measures (every table measure except Amount Spent and Purchases), each with its good direction', () => {
  assert.deepEqual(health.METRICS, ['cpa', 'purchase_value', 'roas', 'add_to_cart', 'cost_per_atc', 'outbound_ctr', 'cpm', 'reach', 'frequency']);
  assert.ok(!health.METRICS.includes('spend') && !health.METRICS.includes('purchases'), 'Amount Spent and Purchases are not benchmarkable');
  assert.deepEqual(bench.DIRECTION, { cpa: 'lower', purchase_value: 'higher', roas: 'higher', add_to_cart: 'higher', cost_per_atc: 'lower', outbound_ctr: 'higher', cpm: 'lower', reach: 'higher', frequency: 'lower' });
});

test('the same value is judged by each funnel\'s own benchmark, and by none where nothing is set', () => {
  const rows = [row('TOF', 'cpa', 120), row('TOM', 'cpa', 80), row('TOF', 'roas', 2), row('MOF', 'roas', 4)];
  assert.equal(cls(rows, 'TOF', 'cpa', 100), 'green'); assert.equal(cls(rows, 'TOM', 'cpa', 100), 'red'); assert.equal(cls(rows, 'MOF', 'cpa', 100), null);
  assert.equal(cls(rows, 'TOF', 'roas', 2.5), 'green'); assert.equal(cls(rows, 'MOF', 'roas', 2.5), 'red'); assert.equal(cls(rows, 'TOM', 'roas', 2.5), null);
  assert.equal(cls(rows, 'unknown', 'cpa', 1), null); assert.equal(cls(rows, 'multiple', 'roas', 99), null);
});

test('higher-is-better and lower-is-better measures use the 20% rule on the right side', () => {
  const rows = [row('TOF', 'outbound_ctr', 1), row('TOF', 'cpm', 10)];
  assert.equal(cls(rows, 'TOF', 'outbound_ctr', 1.4), 'green'); assert.equal(cls(rows, 'TOF', 'outbound_ctr', 0.8), 'orange'); assert.equal(cls(rows, 'TOF', 'outbound_ctr', 0.79), 'red');
  assert.equal(cls(rows, 'TOF', 'cpm', 8), 'green'); assert.equal(cls(rows, 'TOF', 'cpm', 12), 'orange'); assert.equal(cls(rows, 'TOF', 'cpm', 12.01), 'red');
});

test('a Frequency range: green inside, orange within 20% outside either end, red beyond; and it is stated as a range', () => {
  const rows = [row('TOF', 'frequency', 2, { target_min: 1.2 })];
  for (const [v, want] of [[1.5, 'green'], [1.2, 'green'], [2, 'green'], [1.0, 'orange'], [2.4, 'orange'], [0.9, 'red'], [2.5, 'red']]) assert.equal(cls(rows, 'TOF', 'frequency', v), want, String(v));
  const c = bench.compile(rows);
  assert.match(health.describe(c.rules.TOF.frequency[0]), /1\.2 to 2/);
  assert.equal(bench.ruleOf(row('TOF', 'cpa', 60, { target_min: 5 })).green.lte, 60, 'a range is only read for Frequency');
});

test('validation: range only for Frequency and low <= high; unknown metrics refused', () => {
  assert.throws(() => bench.cleanInput({ funnel: 'TOF', metric: 'cpa', target: 60, target_min: 10 }), /only available for Frequency/);
  assert.throws(() => bench.cleanInput({ funnel: 'TOF', metric: 'frequency', target: 1, target_min: 2 }), /cannot be above/);
  assert.throws(() => bench.cleanInput({ funnel: 'TOF', metric: 'bogus', target: 1 }), /Metric must be/);
  assert.throws(() => bench.cleanInput({ funnel: 'TOF', metric: 'cpa', target: 0 }), /above 0, or leave this measure unset/, 'a benchmark is optional: a target of 0 is refused rather than colouring everything');
  assert.throws(() => bench.cleanInput({ funnel: 'TOF', metric: 'cpa', target: '' }), /above 0/);
  assert.equal(bench.cleanInput({ funnel: 'TOF', metric: 'frequency', target: 2, target_min: 1.2 }).target_min, 1.2);
});

test('the table\'s funnel checkboxes: nothing / all three = no restriction, a subset filters, none = empty', () => {
  const q = (funnels) => perf.parseAdsQuery ? perf.parseAdsQuery({ funnels }).funnels : undefined;
  if (perf.parseAdsQuery) {
    assert.equal(q(undefined), null); assert.equal(q('TOF,TOM,MOF'), null); assert.deepEqual(q('TOF'), ['TOF']); assert.deepEqual(q('tom, mof'), ['TOM', 'MOF']);
    assert.deepEqual(q('none'), []); assert.equal(q('garbage'), null);
  }
});

test('"green only": green when the target is met, otherwise no colour (never orange or red)', () => {
  const rows = [row('TOF', 'reach', 20000, { highlight_only: true }), row('TOM', 'cpa', 60, { highlight_only: true }), row('MOF', 'reach', 20000)];
  assert.equal(cls(rows, 'TOF', 'reach', 25000), 'green'); assert.equal(cls(rows, 'TOF', 'reach', 20000), 'green');
  assert.equal(cls(rows, 'TOF', 'reach', 19999), null); assert.equal(cls(rows, 'TOF', 'reach', 100), null);
  assert.equal(cls(rows, 'TOM', 'cpa', 55), 'green'); assert.equal(cls(rows, 'TOM', 'cpa', 61), null); assert.equal(cls(rows, 'TOM', 'cpa', 500), null);
  // the same target without the option still has orange and red
  assert.equal(cls(rows, 'MOF', 'reach', 17000), 'orange'); assert.equal(cls(rows, 'MOF', 'reach', 100), 'red');
  assert.deepEqual(Object.keys(bench.ruleOf(row('TOF', 'reach', 20000, { highlight_only: true }))).filter((k) => ['green', 'orange', 'red'].includes(k)), ['green']);
});

test('Purchase Value, Adds to Cart and Cost / ATC can be benchmarked per funnel', () => {
  const rows = [row('TOF', 'purchase_value', 2000), row('TOF', 'add_to_cart', 150), row('TOF', 'cost_per_atc', 5), row('TOM', 'cost_per_atc', 3)];
  assert.equal(cls(rows, 'TOF', 'purchase_value', 2500), 'green'); assert.equal(cls(rows, 'TOF', 'purchase_value', 1700), 'orange'); assert.equal(cls(rows, 'TOF', 'purchase_value', 1000), 'red');
  assert.equal(cls(rows, 'TOF', 'add_to_cart', 174), 'green'); assert.equal(cls(rows, 'TOF', 'add_to_cart', 100), 'red');
  assert.equal(cls(rows, 'TOF', 'cost_per_atc', 4.74), 'green'); assert.equal(cls(rows, 'TOF', 'cost_per_atc', 6), 'orange'); assert.equal(cls(rows, 'TOM', 'cost_per_atc', 4.74), 'red'); assert.equal(cls(rows, 'MOF', 'cost_per_atc', 4.74), null);
});
