// Batch 13: funnel-specific benchmarks. Every funnel x {CPA, Frequency} slot can be configured; only the APPROVED ones are set; an unset slot or a reporting window the
// benchmark does not cover shows neutral; nothing is borrowed from another funnel or invented.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const health = require('../src/lib/metaFunnelHealth');
const bench = require('../src/lib/metaBenchmarks');

const row = (funnel, metric, target, extra = {}) => ({ id: 1, funnel, metric, target, inclusive: metric === 'cpa', tolerance_pct: 20, active: true, min_days: null, max_days: null, ...extra });
const cls = (rows, funnel, metric, value, days) => { const { rules, coded } = bench.compile(rows); return health.classify(funnel, metric, value, { days }, { rules, coded }); };

test('the six slots (TOF / TOM / MOF x CPA / Frequency) can each be configured and judged independently', () => {
  const rows = [];
  for (const f of ['TOF', 'TOM', 'MOF']) { rows.push(row(f, 'cpa', 50)); rows.push(row(f, 'frequency', 2.5, { inclusive: false })); }
  for (const f of ['TOF', 'TOM', 'MOF']) {
    assert.equal(cls(rows, f, 'cpa', 45, 7), 'green'); assert.equal(cls(rows, f, 'cpa', 58, 7), 'orange'); assert.equal(cls(rows, f, 'cpa', 80, 7), 'red');
    assert.equal(cls(rows, f, 'frequency', 2, 7), 'green'); assert.equal(cls(rows, f, 'frequency', 3.1, 7), 'red');
  }
});
test('the APPROVED benchmarks are preserved exactly: MOF CPA <= $60 green, to $72 orange, above red; TOF Frequency < 2 green, 2 to 2.4 orange, above red (3-5 days only)', () => {
  const r = health.effectiveRules();
  const c = (f, m, v, d) => health.classify(f, m, v, { days: d });
  assert.equal(c('MOF', 'cpa', 60, 7), 'green'); assert.equal(c('MOF', 'cpa', 72, 30), 'orange'); assert.equal(c('MOF', 'cpa', 72.01, 7), 'red');
  assert.equal(c('TOF', 'frequency', 1.99, 4), 'green'); assert.equal(c('TOF', 'frequency', 2, 4), 'orange'); assert.equal(c('TOF', 'frequency', 2.4, 3), 'orange'); assert.equal(c('TOF', 'frequency', 2.41, 5), 'red');
  assert.ok(r.MOF.cpa && r.TOF.frequency);
});
test('UNAPPROVED slots stay unset and show neutral: TOF CPA, TOM CPA, TOM Frequency and MOF Frequency are never coloured by fabricated thresholds', () => {
  const approvedOnly = [row('MOF', 'cpa', 60), row('TOF', 'frequency', 2, { inclusive: false, min_days: 3, max_days: 5 })];
  for (const [f, m, v] of [['TOF', 'cpa', 40], ['TOF', 'cpa', 400], ['TOM', 'cpa', 70], ['TOM', 'frequency', 1.1], ['TOM', 'frequency', 9], ['MOF', 'frequency', 1.1], ['MOF', 'frequency', 9]]) {
    assert.equal(cls(approvedOnly, f, m, v, 4), null, `${f} ${m} ${v} is neutral`);
    assert.equal(health.classify(f, m, v, { days: 4 }), null, `${f} ${m} ${v} is neutral by default too`);
  }
});
test('a benchmark never borrows another funnel\'s numbers (a MOF CPA target does not colour TOM or TOF CPA)', () => {
  const rows = [row('MOF', 'cpa', 60)];
  assert.equal(cls(rows, 'MOF', 'cpa', 50, 7), 'green'); assert.equal(cls(rows, 'TOM', 'cpa', 50, 7), null); assert.equal(cls(rows, 'TOF', 'cpa', 50, 7), null);
});
test('an incompatible reporting window is neutral: a 3-5 day Frequency benchmark is not applied to a 7- or 30-day period (and not scaled)', () => {
  const rows = [row('TOM', 'frequency', 2, { inclusive: false, min_days: 3, max_days: 5 })];
  assert.equal(cls(rows, 'TOM', 'frequency', 2.2, 4), 'orange');
  assert.equal(cls(rows, 'TOM', 'frequency', 2.2, 7), null); assert.equal(cls(rows, 'TOM', 'frequency', 2.2, 30), null); assert.equal(cls(rows, 'TOM', 'frequency', 2.2, 2), null);
});
test('Unknown and Mixed funnels are never judged, whatever is configured; a disabled slot is neutral', () => {
  const rows = [row('MOF', 'cpa', 60), row('TOF', 'cpa', 60, { active: false })];
  assert.equal(cls(rows, 'unknown', 'cpa', 10, 7), null); assert.equal(cls(rows, 'multiple', 'cpa', 10, 7), null); assert.equal(cls(rows, 'TOF', 'cpa', 10, 7), null);
});
test('Settings explains it: slots per funnel, only approved targets set, neutral when empty, windows, and no CPM benchmark', () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public/index.html'), 'utf8');
  const rules = html.slice(html.indexOf('id="mbench-rules"'), html.indexOf('id="mbench-grid"'));
  for (const t of [/Each funnel has its own slots/, /Only approved targets are set/, /An empty slot shows a neutral value/, /reporting window is judged only inside that window/, /CPM has no benchmark/]) assert.match(rules, t);
});
