// Batch 13: CPM = Spend / Impressions x 1,000 (cost per thousand impressions). Pure checks of the derivation and of how the page wires it; the database behaviour
// (aggregate, filter and sort over real rows) is covered by the sandbox suite b13-db.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const perf = require('../src/lib/metaPerformance');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('CPM = spend / impressions x 1,000, rounded to cents, from the same columns as every other metric', () => {
  assert.equal(perf.deriveMetrics({ spend: 500, impressions: 40000 }).cpm, 12.5);
  assert.equal(perf.deriveMetrics({ spend: 123.45, impressions: 7777 }).cpm, 15.87);
  assert.equal(perf.deriveMetrics({ spend: '250.00', impressions: '10000' }).cpm, 25);
});
test('no impressions (zero or missing) = null, never 0 and never a division error', () => {
  assert.equal(perf.deriveMetrics({ spend: 100, impressions: 0 }).cpm, null);
  assert.equal(perf.deriveMetrics({ spend: 100 }).cpm, null);
  assert.equal(perf.deriveMetrics({ spend: 0, impressions: 1000 }).cpm, 0, 'impressions with no spend is a genuine $0.00 CPM');
});
test('an aggregate CPM is total spend over total impressions, NOT the average of ad CPMs', () => {
  const a = { spend: 100, impressions: 1000 };   // CPM 100
  const b = { spend: 100, impressions: 100000 }; // CPM 1
  const total = perf.deriveMetrics({ spend: a.spend + b.spend, impressions: a.impressions + b.impressions }).cpm;
  const avg = (perf.deriveMetrics(a).cpm + perf.deriveMetrics(b).cpm) / 2;
  assert.equal(total, 1.98); assert.notEqual(total, avg); assert.equal(avg, 50.5);
});
test('existing metrics are unchanged by adding CPM', () => {
  const m = perf.deriveMetrics({ spend: 400, purchases: 8, purchase_value: 960, add_to_cart: 40, outbound_clicks: 200, impressions: 20000 });
  assert.equal(m.cpa, 50); assert.equal(m.roas, 2.4); assert.equal(m.cost_per_atc, 10); assert.equal(m.outbound_ctr, 1); assert.equal(m.cpm, 20);
});
test('CPM is sortable (whitelisted SQL), a KPI card, a table column, never coloured, and not a benchmark metric', () => {
  const lib = read('src/lib/metaPerformance.js');
  assert.match(lib, /cpm: 'agg\.spend \/ NULLIF\(agg\.impressions, 0\)'/);
  const app = read('public/app.js');
  assert.match(app, /\{ key: 'cpm', label: 'CPM', fmt: 'money', better: null \}/, 'a summary card; better is null so a comparison is never shown as good or bad');
  const row = app.slice(app.indexOf("body.innerHTML = res.ads.map((a) => `"), app.indexOf('ccHydrateThumbs(body);'));
  assert.match(row, /class="num mp-cpm"/); assert.doesNotMatch(row, /cellCls\(a\.cpm/);
  assert.match(read('public/index.html'), /data-sort="cpm"/);
  const health = read('src/lib/metaFunnelHealth.js');
  assert.doesNotMatch(health.slice(health.indexOf('const METRICS')), /'cpm'/, 'no CPM benchmark exists to colour against');
});
