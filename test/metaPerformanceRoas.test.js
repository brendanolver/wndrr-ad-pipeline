// Pure tests: Purchase Value / Purchase ROAS in Meta Performance, and the configurable funnel-health benchmarks.
// (The query layer and the table are exercised end to end by the sandbox suite b9-db / b9-ui.)
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const perf = require('../src/lib/metaPerformance');
const health = require('../src/lib/metaFunnelHealth');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// ── ROAS ────────────────────────────────────────────────────────────────
test('roas = purchase value / spend, rounded to 2 dp, from the same summed columns', () => {
  const m = perf.deriveMetrics({ spend: '200.00', purchases: 4, purchase_value: '650.50', add_to_cart: 9, outbound_clicks: 10, impressions: 1000 });
  assert.equal(m.purchase_value, 650.5);
  assert.equal(m.roas, 3.25);
  assert.equal(m.cpa, 50);
  assert.equal(perf.deriveMetrics({ spend: 3, purchase_value: 10 }).roas, 3.33);
});
test('roas is null (never 0 or Infinity) when nothing was spent, and 0 when money was spent with no purchase value', () => {
  assert.equal(perf.deriveMetrics({ spend: 0, purchase_value: 100 }).roas, null);
  assert.equal(perf.deriveMetrics({ spend: null, purchase_value: 100 }).roas, null);
  assert.equal(perf.deriveMetrics({}).roas, null);
  assert.equal(perf.deriveMetrics({ spend: 50, purchase_value: 0 }).roas, 0);
  assert.equal(perf.deriveMetrics({ spend: 50, purchases: 0 }).roas, 0);
});
test('roas over a period is the ratio of the SUMS, not an average of daily ratios', () => {
  const days = [{ spend: 100, purchase_value: 400 }, { spend: 900, purchase_value: 900 }];
  const sums = days.reduce((a, d) => ({ spend: a.spend + d.spend, purchase_value: a.purchase_value + d.purchase_value }), { spend: 0, purchase_value: 0 });
  assert.equal(perf.deriveMetrics(sums).roas, 1.3);
  const avg = days.map((d) => perf.deriveMetrics(d).roas).reduce((a, b) => a + b, 0) / 2;
  assert.notEqual(avg, 1.3, 'averaging the daily ratios would give a different (wrong) answer');
});
test('roas is a whitelisted sort key; unknown keys still fall back to spend', () => {
  assert.equal(perf.parseAdsQuery({ sort: 'roas', dir: 'asc' }).sort, 'roas');
  assert.equal(perf.parseAdsQuery({ sort: 'purchase_value' }).sort, 'purchase_value');
  assert.equal(perf.parseAdsQuery({ sort: 'roas; DROP TABLE x' }).sort, 'spend');
  const src = read('src/lib/metaPerformance.js');
  assert.match(src, /roas: 'agg\.purchase_value \/ NULLIF\(agg\.spend, 0\)'/, 'sorted on the exact ratio of the aggregated sums');
});
test('no new Meta call: ROAS and Purchase Value come only from the stored daily columns', () => {
  const src = read('src/lib/metaPerformance.js').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /metaGet|graph\.facebook|purchase_roas|fetch\(/);
});

// ── the table: header / cell / empty-row column counts stay in step ──────────
test('Meta Performance table: header, rows and empty rows all have the same number of columns, with Purchase Value and ROAS sortable', () => {
  const html = read('public/index.html');
  const thead = html.slice(html.indexOf('<table class="mp-table mp-perf">'), html.indexOf('<tbody id="mp-ads-body">'));
  const heads = thead.match(/<th\b/g).length;
  assert.equal(heads, 14);
  assert.match(thead, /data-sort="purchase_value"/);
  assert.match(thead, /data-sort="roas"/);
  const app = read('public/app.js');
  const row = app.slice(app.indexOf("body.innerHTML = res.ads.map((a) => `"), app.indexOf('ccHydrateThumbs(body);', app.indexOf("body.innerHTML = res.ads.map((a) => `")));
  assert.equal(row.match(/<td\b/g).length, heads, 'a data row has one cell per header');
  assert.match(row, /mpFmt\(a\.purchase_value, 'money'\)/);
  assert.match(row, /mpFmt\(a\.roas, 'roas'\)/);
  assert.equal((app.match(/colspan="14" class="mp-table-empty"/g) || []).length, 2, 'both empty / error rows span all columns');
  assert.doesNotMatch(app, /colspan="12" class="mp-table-empty"/);
});
test('headline KPIs and the ad detail show Purchase Value and ROAS, with the unavailable case rendered as a dash', () => {
  const app = read('public/app.js');
  assert.match(app, /\{ key: 'purchase_value', label: 'Purchase Value', fmt: 'money', better: 'up' \}/);
  assert.match(app, /\{ key: 'roas', label: 'ROAS', fmt: 'roas', better: 'up' \}/);
  const fmt = new Function(`const mpState = { currency: 'AUD' }; ${app.slice(app.indexOf('function mpFmt('), app.indexOf('function mpStatusChip'))}; return mpFmt;`)();
  assert.match(fmt(null, 'roas'), /—/);
  assert.match(fmt(undefined, 'money'), /—/);
  assert.equal(fmt(3.256, 'roas'), '3.26×');
  assert.equal(fmt(0, 'roas'), '0.00×', 'a real zero is shown as 0.00×, not as unavailable');
  assert.match(app, /<th>Purchase Value<\/th><th>ROAS<\/th>/, 'daily breakdown');
});

// ── configurable health benchmarks ───────────────────────────────────────────
const withEnv = (v, fn) => { const old = process.env.META_HEALTH_RULES; if (v === undefined) delete process.env.META_HEALTH_RULES; else process.env.META_HEALTH_RULES = v; try { return fn(); } finally { if (old === undefined) delete process.env.META_HEALTH_RULES; else process.env.META_HEALTH_RULES = old; } };

test('health: the approved benchmarks apply by default and nothing else is coloured', () => {
  withEnv(undefined, () => {
    assert.equal(health.classify('MOF', 'cpa', 40, { days: 30 }), 'green');
    assert.equal(health.classify('MOF', 'cpa', 60, { days: 30 }), 'green');
    assert.equal(health.classify('MOF', 'cpa', 60.01, { days: 30 }), 'orange');
    assert.equal(health.classify('MOF', 'cpa', 72.01, { days: 30 }), 'red');
    assert.equal(health.classify('MOF', 'cpa', 20, { days: 30 }), 'green', 'below the $40-$60 range is not penalised');
    assert.equal(health.classify('TOF', 'frequency', 1.9, { days: 4 }), 'green');
    assert.equal(health.classify('TOF', 'frequency', 1.9, { days: 30 }), null, 'frequency is judged only for about 4 days');
    assert.equal(health.classify('TOF', 'frequency', 2, { days: 4 }), 'orange');
    assert.equal(health.classify('TOF', 'frequency', 2.41, { days: 4 }), 'red');
    for (const [f, m] of [['TOF', 'reach'], ['TOM', 'cpa'], ['TOM', 'reach'], ['MOF', 'reach']]) assert.equal(health.classify(f, m, 12345, { days: 4 }), null, `${f} ${m} has no approved benchmark`);
    assert.deepEqual(health.status().pending_benchmarks, ['TOF reach', 'TOM cpa', 'TOM reach', 'MOF reach']);
    assert.equal(health.status().rules_source, 'default');
  });
});
test('health: further approved benchmarks can be configured (green / orange / red) without a code change', () => {
  const cfg = JSON.stringify({
    TOM: { cpa: { period: null, green: { lte: 45 }, orange: { gt: 45, lte: 54 }, red: { gt: 54 } } },
    TOF: { reach: { period: null, green: { gte: 50000 }, orange: { gte: 40000, lt: 50000 }, red: { lt: 40000 } } },
  });
  withEnv(cfg, () => {
    assert.equal(health.status().rules_source, 'env');
    assert.deepEqual(health.status().config_errors, []);
    assert.equal(health.classify('TOM', 'cpa', 44, {}), 'green');
    assert.equal(health.classify('TOM', 'cpa', 50, {}), 'orange');
    assert.equal(health.classify('TOM', 'cpa', 55, {}), 'red');
    assert.equal(health.classify('TOF', 'reach', 60000, { days: 7 }), 'green');
    assert.equal(health.classify('TOF', 'reach', 45000, { days: 7 }), 'orange');
    assert.equal(health.classify('TOF', 'reach', 100, { days: 7 }), 'red');
    assert.equal(health.classify('MOF', 'cpa', 50, {}), 'green', 'approved rules still apply');
    assert.equal(health.classify('MOF', 'cpa', 70, {}), 'orange');
    assert.deepEqual(health.status().pending_benchmarks, ['TOM reach', 'MOF reach']);
  });
});
test('health: a configuration can never change the approved bands, enable a new metric, or break the dashboard', () => {
  const bad = JSON.stringify({
    MOF: { cpa: { period: null, green: { lte: 70 }, orange: { gt: 70, lte: 80 }, red: { gt: 80 } } }, // tries to move the approved bands
    TOF: { frequency: { period: null, green: { lt: 3 } } },                                           // tries to change the approved frequency rule / period
    TOM: { frequency: { period: null, green: { lt: 2 } } },                                           // not a colour-coded TOM measure
    BOF: { cpa: { period: null, green: { max: 1 } } },                                                // not a judged funnel
    MOF2: 'x',
    TOF2: {},
  });
  withEnv(bad, () => {
    const st = health.status();
    assert.equal(st.rules_source, 'default', 'nothing valid was applied');
    assert.ok(st.config_errors.length >= 4, st.config_errors);
    assert.equal(health.classify('MOF', 'cpa', 65, {}), 'orange', 'the approved MOF CPA bands are untouched');
    assert.equal(health.classify('MOF', 'cpa', 75, {}), 'red');
    assert.equal(health.classify('TOF', 'frequency', 2.5, { days: 30 }), null);
    assert.equal(health.classify('TOM', 'frequency', 1, { days: 4 }), null);
  });
  for (const junk of ['not json', '[]', '"x"', '123', '{"TOM":{"cpa":{"green":{"max":"cheap"}}}}']) {
    withEnv(junk, () => { assert.doesNotThrow(() => health.classify('MOF', 'cpa', 50, {})); assert.equal(health.classify('MOF', 'cpa', 50, {}), 'green'); assert.ok(health.status().config_errors.length >= 1, junk); });
  }
});
test('health: configuration is read from META_HEALTH_RULES only and never exposes anything else', () => {
  const src = read('src/lib/metaFunnelHealth.js').replace(/\/\/.*$/gm, '');
  assert.equal([...src.matchAll(/process\.env\.(\w+)/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i).join(','), 'META_HEALTH_RULES');
});
