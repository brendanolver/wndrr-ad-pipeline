// Best Ads: query parsing (whitelisted ranking, sane limits) and the large-cover lookup (cache first, one multi-id Meta read, nothing fetched while automatic refresh is off).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const perf = require('../src/lib/metaPerformance');
const thumbs = require('../src/lib/metaCreativeThumbs');

test('defaults: Purchase Value, $500 minimum spend, 5 purchases for CPA / ROAS, 20 per page', () => {
  assert.deepEqual(perf.parseBestQuery({}), { rank: 'purchase_value', minSpend: 500, minPurchases: 5, status: 'all', q: '', page: 1, pageSize: 20 });
});

test('only known rankings are accepted; CPA ranks lowest first, everything else highest first', () => {
  assert.equal(perf.parseBestQuery({ rank: 'drop table' }).rank, 'purchase_value');
  assert.deepEqual(Object.keys(perf.BEST_RANKS).sort(), ['cpa', 'purchase_value', 'purchases', 'roas', 'spend']); // no Reach: it cannot be combined across ads
  assert.equal(perf.BEST_RANKS.cpa.dir, 'asc');
  for (const k of ['purchase_value', 'purchases', 'roas', 'spend']) assert.equal(perf.BEST_RANKS[k].dir, 'desc');
});

test('minimum spend may be zero but never negative or non-numeric; paging is bounded', () => {
  assert.equal(perf.parseBestQuery({ min_spend: '0' }).minSpend, 0);
  assert.equal(perf.parseBestQuery({ min_spend: '-5' }).minSpend, 0);
  assert.equal(perf.parseBestQuery({ min_spend: 'abc' }).minSpend, 500);
  assert.equal(perf.parseBestQuery({ min_purchases: '2.9' }).minPurchases, 2);
  assert.equal(perf.parseBestQuery({ page: '0' }).page, 1);
  assert.equal(perf.parseBestQuery({ page_size: '5000' }).pageSize, 60);
  assert.equal(perf.parseBestQuery({ status: 'weird' }).status, 'all');
  assert.equal(perf.parseBestQuery({ q: ' x '.repeat(200) }).q.length <= 200, true);
});

test('large covers: a 600px lookup, and nothing is fetched from Meta while automatic refresh is off', async () => {
  assert.equal(thumbs.LARGE_PARAMS.thumbnail_width, '600');
  const rows = [];
  const db = { query: async (sql) => ({ rows: /FROM meta_ads/i.test(sql) ? [{ meta_ad_id: 'a1', meta_creative_id: 'c1' }] : rows }) };
  let calls = 0;
  const off = await thumbs.getLargeThumbs(['a1'], {}, { db, configured: () => true, autoEnabled: () => false, metaGetByIds: async () => { calls += 1; return {}; } });
  assert.equal(calls, 0);
  assert.equal(off.stats.meta_calls, 0);
  assert.equal(off.thumbs.a1.state, 'pending');
});

test('creative grouping uses the Ad Matching copy-suffix rule (only trailing suffixes, any dash / case / repeats)', () => {
  const { normaliseAdName } = require('../src/lib/metaNameCopies');
  const base = '#301_26-WK23_02-06_MOTIF 1/4 ZIP_SWEATS_HUMOUR_Video_Single_*_CONCRETE FLAT LAY_Product';
  for (const suffix of [' - Copy', ' - Copy 2', ' – Copy 4', ' - Copy - Copy 2', ' - Copy – Copy 2', ' — copy', ' − COPY 12', '  -  Copy  ']) {
    assert.equal(normaliseAdName(base + suffix).base, base, suffix);
  }
  // not suffixes: meaningful parts of the name are never removed
  for (const name of ['Copy of ' + base, base + ' (Copy)', base + '-Copy', base + ' - Copy of it', base + ' - Hook 2']) assert.equal(normaliseAdName(name).base, name);
  assert.notEqual(normaliseAdName(base).base, normaliseAdName(base.replace('Product', 'Hook 2') + ' - Copy').base);
  // the SQL version used for grouping is the same expression family
  assert.match(perf.creativeKeySql('a'), /copy\(\\s\*\[0-9\]\{1,3\}\)\?\)\+/i);
});
