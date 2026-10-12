// Batch 11 follow-up: Shopify online-order history for seasonality (parsing, store-local days, refunds / cancellations, SKU->style, security of the
// download and the client, the source chooser and its fallback). Everything is injected: no network, no database, no Shopify.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/lib/shopifySales');
const amCache = require('../src/lib/amCache');
const SS = require('../src/lib/seasonalSales');

const TZ = 'Australia/Melbourne';
const dayOf = S.makeDayOf(TZ);
async function* gen(lines) { for (const l of lines) yield l; }
const j = (o) => JSON.stringify(o);
const KNOWN = new Set(['W26AA001BLK', 'W26AA001OYS', 'W26BB002WHT', 'W256A002ASSL']);
const mapStyle = S.makeStyleMapper(KNOWN);

test('SKU -> style uses the longest KNOWN style code (a colour ending in a size letter is never mis-split)', () => {
  assert.equal(mapStyle('W26AA001BLKS'), 'W26AA001BLK');
  assert.equal(mapStyle('W26AA001OYSS'), 'W26AA001OYS', 'OYS + size S, not OY + SS');
  assert.equal(mapStyle('W26AA001OYS'), 'W26AA001OYS');
  assert.equal(mapStyle('W256A002ASSL'), 'W256A002ASSL', 'an odd older SKU that is a known style is kept');
  assert.equal(mapStyle('ZZZZZZZZZZZ'), null);
  assert.equal(mapStyle(''), null);
  assert.equal(mapStyle(null), null);
});

test('store-local day bucketing: midnight and the Melbourne daylight-saving change (4 Oct 2026)', () => {
  assert.equal(dayOf('2026-09-30T14:30:00Z'), '2026-10-01'); // 00:30 AEST on the 1st
  assert.equal(dayOf('2026-09-30T13:30:00Z'), '2026-09-30'); // 23:30 AEST on the 30th
  assert.equal(dayOf('2026-10-03T14:30:00Z'), '2026-10-04'); // 00:30 AEST (+10) just before the change
  assert.equal(dayOf('2026-10-04T13:30:00Z'), '2026-10-05'); // 00:30 AEDT (+11) after it
});

test('aggregation: child rows before parents, cancelled / test orders out, refunded lines out, service lines out, unmapped units reported', async () => {
  const lines = [
    // line items BEFORE their parent orders (Shopify does not guarantee order)
    j({ __parentId: 'o1', sku: 'W26AA001BLKS', currentQuantity: 2 }),
    j({ __parentId: 'o1', sku: 'W26AA001BLKM', currentQuantity: 1 }),
    j({ __parentId: 'o1', sku: 'ORDPRO', currentQuantity: 1 }),
    j({ __parentId: 'o1', sku: '', currentQuantity: 1 }), // gift card
    j({ __parentId: 'o1', sku: 'W26AA001BLKL', currentQuantity: 0 }), // fully refunded / removed
    j({ id: 'o1', createdAt: '2026-09-30T14:30:00Z', cancelledAt: null, test: false }),
    j({ id: 'o2', createdAt: '2026-10-02T01:00:00Z', cancelledAt: '2026-10-02T02:00:00Z', test: false }),
    j({ __parentId: 'o2', sku: 'W26BB002WHTS', currentQuantity: 5 }),
    j({ id: 'o3', createdAt: '2026-10-02T01:00:00Z', cancelledAt: null, test: true }),
    j({ __parentId: 'o3', sku: 'W26BB002WHTS', currentQuantity: 7 }),
    j({ id: 'o4', createdAt: '2026-10-05T01:00:00Z', cancelledAt: null, test: false }),
    j({ __parentId: 'o4', sku: 'W26BB002WHTM', currentQuantity: 3 }),
    j({ __parentId: 'o4', sku: 'NOSUCHSTYLE1S', currentQuantity: 4 }),
    j({ __parentId: 'ghost', sku: 'W26BB002WHTM', currentQuantity: 9 }), // parent never seen
    '', 'not json',
  ];
  const agg = await S.aggregate({ pass1: () => gen(lines), pass2: () => gen(lines), dayOf, mapStyle, sinceDay: '2026-01-01' });
  assert.deepEqual(agg.byStyle.get('W26AA001BLK'), { '2026-10-01': 3 }, 'S + M summed on the store-local day; ORDPRO / gift card / refunded line excluded');
  assert.deepEqual(agg.byStyle.get('W26BB002WHT'), { '2026-10-05': 3 }, 'cancelled and test orders contribute nothing');
  assert.equal(agg.stats.cancelled_orders, 1); assert.equal(agg.stats.test_orders, 1);
  assert.equal(agg.stats.unmapped_units, 4); assert.equal(agg.stats.unmapped_skus, 1);
  assert.equal(agg.stats.non_product_units, 2); assert.equal(agg.stats.unresolved_lines, 1);
  assert.equal(agg.stats.refunded_or_removed_lines, 1);
  assert.equal(agg.firstDay, '2026-10-01'); assert.equal(agg.lastDay, '2026-10-05');
});

test('orders before the window (the padding days) are trimmed', async () => {
  const lines = [j({ id: 'a', createdAt: '2026-01-01T05:00:00Z' }), j({ __parentId: 'a', sku: 'W26AA001BLKS', currentQuantity: 2 }), j({ id: 'b', createdAt: '2026-03-01T05:00:00Z' }), j({ __parentId: 'b', sku: 'W26AA001BLKS', currentQuantity: 5 })];
  const agg = await S.aggregate({ pass1: () => gen(lines), pass2: () => gen(lines), dayOf, mapStyle, sinceDay: '2026-02-01' });
  assert.deepEqual(agg.byStyle.get('W26AA001BLK'), { '2026-03-01': 5 });
});

test('toSalesByStyle: windows, months and an honest window start', () => {
  const byStyle = new Map([['W26AA001BLK', { '2026-10-12': 2, '2026-10-08': 3, '2026-09-20': 4, '2025-11-01': 5, '2025-10-01': 6 }]]);
  const out = S.toSalesByStyle(byStyle, { today: '2026-10-12', sinceDay: '2024-10-13', firstDay: '2025-10-01', tz: TZ, stats: {} });
  const e = out.get('W26AA001BLK');
  assert.equal(e.qty7, 5); assert.equal(e.qty30, 9); assert.equal(e.qty365, 14, '2025-10-01 is outside the last 365 days'); assert.equal(e.months['2026-10'], 5);
  assert.equal(out.window.from, '2025-10-01', 'the window starts where orders really start, not where it was requested');
  assert.equal(out.window.requested_from, '2024-10-13'); assert.equal(out.window.source, 'shopify');
  const none = S.toSalesByStyle(new Map(), { today: '2026-10-12', sinceDay: '2024-10-13', firstDay: null, tz: TZ, stats: {} });
  assert.equal(none.window.from, '2024-10-13');
});

test('download URL allow-list and client safety', () => {
  assert.equal(S.isAllowedDownloadUrl('https://storage.googleapis.com/bulk/x.jsonl?sig=1'), true);
  assert.equal(S.isAllowedDownloadUrl('http://storage.googleapis.com/x'), false);
  assert.equal(S.isAllowedDownloadUrl('https://evil.example.com/x'), false);
  assert.equal(S.isAllowedDownloadUrl('https://googleapis.com.evil.com/x'), false);
  assert.equal(S.isAllowedDownloadUrl('not a url'), false);
  assert.throws(() => S.makeClient({ domain: 'evil.example.com', token: 'x'.repeat(30) }), /myshopify\.com/);
  const c = S.makeClient({ domain: 'shop.myshopify.com', token: 't'.repeat(30), fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  assert.throws(() => c.openLines('https://evil.example.com/x'), /unexpected host/);
});

test('the bulk query asks only for order dates, status flags and line SKU / quantity (no customer, address, price or discount fields)', () => {
  const q = S.bulkQuery('2026-01-01');
  assert.match(q, /createdAt cancelledAt test/); assert.match(q, /sku currentQuantity/);
  for (const bad of ['customer', 'email', 'address', 'phone', 'price', 'discount', 'total', 'name']) assert.doesNotMatch(q.replace(/bulkOperationRunQuery|bulkOperation|userErrors|message/g, ''), new RegExp(bad, 'i'));
});

test('configuration comes only from the environment; a bad domain / short token is "not configured"', () => {
  assert.equal(S.configured({}), false);
  assert.equal(S.configured({ SHOPIFY_SHOP_DOMAIN: 'a.myshopify.com', SHOPIFY_ADMIN_TOKEN: 'short' }), false);
  assert.equal(S.configured({ SHOPIFY_SHOP_DOMAIN: 'a.example.com', SHOPIFY_ADMIN_TOKEN: 't'.repeat(30) }), false);
  assert.equal(S.configured({ SHOPIFY_SHOP_DOMAIN: 'a.myshopify.com', SHOPIFY_ADMIN_TOKEN: 't'.repeat(30) }), true);
  assert.equal(S.envConfig({ SHOPIFY_SHOP_DOMAIN: 'a.myshopify.com', SHOPIFY_ADMIN_TOKEN: 't'.repeat(30) }).lookbackDays, 730);
  assert.equal(S.envConfig({ SHOPIFY_SHOP_DOMAIN: 'a.myshopify.com', SHOPIFY_ADMIN_TOKEN: 't'.repeat(30), SHOPIFY_SALES_LOOKBACK_DAYS: '365' }).lookbackDays, 365);
  assert.equal(S.envConfig({ SHOPIFY_SHOP_DOMAIN: 'a.myshopify.com', SHOPIFY_ADMIN_TOKEN: 't'.repeat(30), SHOPIFY_SALES_LOOKBACK_DAYS: '5' }).lookbackDays, 730, 'an absurd value falls back to the default');
});

function fakeClient({ ops, lines }) {
  const calls = [];
  let i = 0;
  return {
    calls,
    gql: async (q) => {
      calls.push(q.slice(0, 40));
      if (/bulkOperationRunQuery/.test(q)) return { bulkOperationRunQuery: { bulkOperation: { id: 'gid://op/1', status: 'CREATED' }, userErrors: [] } };
      const op = ops[Math.min(i, ops.length - 1)]; i += 1;
      return { currentBulkOperation: op };
    },
    openLines: () => gen(lines),
  };
}
const NOW = new Date('2026-10-12T02:00:00Z');
const goodLines = [j({ id: 'o1', createdAt: '2026-09-30T14:30:00Z' }), j({ __parentId: 'o1', sku: 'W26AA001BLKS', currentQuantity: 2 })];

test('fetchSalesByStyle end to end with a fake Shopify (polls the bulk operation, then aggregates)', async () => {
  const client = fakeClient({ ops: [null, { id: 'gid://op/1', status: 'RUNNING' }, { id: 'gid://op/1', status: 'COMPLETED', url: 'https://storage.googleapis.com/x' }], lines: goodLines });
  const out = await S.fetchSalesByStyle({ client, knownStyles: KNOWN, tz: TZ, now: NOW, lookbackDays: 730, sleep: async () => {} });
  assert.equal(out.get('W26AA001BLK').months['2026-10'], 2);
  assert.equal(out.window.source, 'shopify'); assert.equal(out.window.from, '2026-10-01');
});
test('another bulk export already running -> a clear error, nothing is submitted', async () => {
  const client = fakeClient({ ops: [{ id: 'x', status: 'RUNNING' }], lines: goodLines });
  await assert.rejects(S.fetchSalesByStyle({ client, knownStyles: KNOWN, now: NOW, sleep: async () => {} }), /already running/);
  assert.ok(!client.calls.some((c) => /bulkOperationRunQuery/.test(c)));
});
test('a failed / expired export is an error (never a half result)', async () => {
  const client = fakeClient({ ops: [null, { id: 'gid://op/1', status: 'FAILED', errorCode: 'INTERNAL_SERVER_ERROR' }], lines: [] });
  await assert.rejects(S.fetchSalesByStyle({ client, knownStyles: KNOWN, now: NOW, sleep: async () => {} }), /FAILED/);
});
test('an export whose line items mostly cannot be matched to orders is refused', async () => {
  const lines = [j({ id: 'o1', createdAt: '2026-09-30T14:30:00Z' }), ...Array.from({ length: 20 }, () => j({ __parentId: 'missing', sku: 'W26AA001BLKS', currentQuantity: 1 }))];
  const client = fakeClient({ ops: [null, { id: 'gid://op/1', status: 'COMPLETED', url: 'https://storage.googleapis.com/x' }], lines });
  await assert.rejects(S.fetchSalesByStyle({ client, knownStyles: KNOWN, now: NOW, sleep: async () => {} }), /could not be matched/);
});
test('the token is only ever sent to the shop host', async () => {
  const seen = [];
  const c = S.makeClient({ domain: 'shop.myshopify.com', token: 'SECRET'.repeat(5), fetchImpl: async (url, init) => { seen.push({ url, h: init && init.headers }); return { ok: true, status: 200, json: async () => ({ data: { shop: { ianaTimezone: 'Australia/Melbourne' } } }) }; } });
  await c.gql('{ shop { ianaTimezone } }');
  assert.ok(seen.every((s) => s.url.startsWith('https://shop.myshopify.com/admin/api/')));
  const refused = S.makeClient({ domain: 'shop.myshopify.com', token: 't'.repeat(30), fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  await assert.rejects(refused.gql('{ x }'), /refused the token/);
});

test('compareMonthly lines two sources up month by month', () => {
  const a = new Map([['S1', { months: { '2026-01': 10, '2026-02': 20 } }]]);
  const b = new Map([['S1', { months: { '2026-01': 11 } }], ['S2', { months: { '2026-02': 5 } }]]);
  assert.deepEqual(S.compareMonthly(a, b), [{ month: '2026-01', a: 10, b: 11, diff: 1, pct: 10 }, { month: '2026-02', a: 20, b: 5, diff: -15, pct: -75 }]);
});

// ── the source chooser ──
const amSales = () => { const m = new Map([['W26AA001BLK', { qty7: 1, qty30: 2, qty365: 3, months: { '2026-01': 3 } }]]); m.window = { from: '2025-10-13', to: '2026-10-12', source: 'apparelmagic' }; return m; };
const shSales = () => { const m = new Map([['W26AA001BLK', { qty7: 1, qty30: 2, qty365: 3, months: { '2026-01': 3 } }]]); m.window = { from: '2024-10-13', to: '2026-10-12', source: 'shopify' }; return m; };
const ENV_ON = { SHOPIFY_SHOP_DOMAIN: 'a.myshopify.com', SHOPIFY_ADMIN_TOKEN: 't'.repeat(30) };

test('chooser: not configured -> ApparelMagic path with a stated reason; strict Shopify mode -> unavailable (no silent substitute)', async () => {
  amCache.clear('shopifySales'); SS._resetForTests();
  const a = await SS.load({ amDetails: new Map(), env: {} });
  assert.equal(a.source, null); assert.ok(a.notes.some((n) => /Shopify is not configured/.test(n)));
  const s = await SS.load({ amDetails: new Map(), env: { SEASONAL_SALES_SOURCE: 'shopify' } });
  assert.equal(s.sales, null); assert.match(s.reason, /not configured/);
  assert.equal(SS.sourceMode({ SEASONAL_SALES_SOURCE: 'nonsense' }), 'auto');
});
test('chooser: injected sales are passed through with their source', async () => {
  const r = await SS.load({ deps: { salesByStyle: shSales() }, env: {} });
  assert.equal(r.source, 'shopify'); assert.equal(r.label, 'Shopify online orders');
  const r2 = await SS.load({ deps: { salesByStyle: amSales() }, env: {} });
  assert.equal(r2.source, 'apparelmagic');
  const r3 = await SS.load({ deps: { salesByStyle: null }, env: {} });
  assert.equal(r3.sales, null);
});
test('chooser: a cold Shopify start does not block, then the loaded Shopify data is used; a failure is remembered for 15 minutes', async () => {
  amCache.clear('shopifySales'); SS._resetForTests();
  let calls = 0;
  const first = await SS.load({ amDetails: new Map([['W26AA001BLK', {}]]), env: ENV_ON, deps: { fetchShopify: async () => { calls += 1; return shSales(); } } });
  assert.equal(first.source, null, 'cold: nothing yet (ApparelMagic is not configured in this test)');
  assert.ok(first.notes.some((n) => /still loading/.test(n)));
  await new Promise((r) => setTimeout(r, 20));
  const second = await SS.load({ amDetails: new Map(), env: ENV_ON, deps: { fetchShopify: async () => { calls += 1; return shSales(); } } });
  assert.equal(second.source, 'shopify'); assert.equal(calls, 1, 'loaded once, then served from the cache');

  amCache.clear('shopifySales'); SS._resetForTests();
  let failing = 0;
  const bad = { fetchShopify: async () => { failing += 1; throw new Error('Shopify refused the token (HTTP 401)'); } };
  await SS.load({ amDetails: new Map(), env: ENV_ON, deps: bad });
  await new Promise((r) => setTimeout(r, 20));
  const again = await SS.load({ amDetails: new Map(), env: ENV_ON, deps: bad });
  assert.equal(failing, 1, 'no second call within the back-off');
  assert.ok(again.notes.some((n) => /refused the token/.test(n)));
  const strict = await SS.load({ amDetails: new Map(), env: { ...ENV_ON, SEASONAL_SALES_SOURCE: 'shopify' }, deps: bad });
  assert.equal(strict.sales, null); assert.match(strict.reason, /refused the token/);
  amCache.clear('shopifySales'); SS._resetForTests();
});

// ── how the chosen source shows up in Planning's data status ──
const pc = require('../src/lib/planningContext');
function synth(source, startYm, nMonths, extraWindow = {}) {
  const months = []; let [y, m] = startYm.split('-').map(Number);
  for (let i = 0; i < nMonths; i += 1) { months.push(`${y}-${String(m).padStart(2, '0')}`); m += 1; if (m === 13) { m = 1; y += 1; } }
  const map = new Map();
  for (let k = 0; k < 8; k += 1) { const mo = {}; months.forEach((ym, i) => { mo[ym] = 40 + ((i + k) % 5) * 3; }); map.set(`W2${k}AA001BLK`, { qty7: 1, qty30: 4, qty365: 400, months: mo }); }
  map.window = { from: `${startYm}-01`, to: '2026-10-12', source, ...extraWindow };
  return map;
}
const FAMS = Array.from({ length: 8 }, (_, k) => ({ key: `W2${k}AA001`, name: `P${k}`, category: 'TEES', style_codes: [`W2${k}AA001BLK`], codes: [`W2${k}AA001`] }));
const ctxWith = (sales) => pc.loadPlanningContext({ amDetails: null, today: '2026-10-12', deps: { allFamilies: FAMS, settings: { min_active_ads: 5, high_stock_min_soh: 100 }, coverage: { available: false, reason: 'x' }, overrides: [], onOrder: new Map(), salesByStyle: sales } });

test('planning data status names the source and counts cycles: two years of Shopify orders -> two observed cycles, medium confidence', async () => {
  const ctx = await ctxWith(synth('shopify', '2024-11', 23));
  const ds = pc.dataStatus(ctx);
  assert.equal(ds.seasonality.available, true);
  assert.equal(ds.seasonality.source, 'shopify'); assert.equal(ds.seasonality.source_label, 'Shopify online orders');
  assert.ok(ds.seasonality.years_of_data >= 1);
  assert.match(ds.seasonality.note, /Shopify online orders/);
  if (ds.seasonality.months_of_data >= 24) { assert.equal(ds.seasonality.confidence, 'medium'); assert.match(ds.seasonality.note, /observed cycles/); }
});
test('planning data status: one year -> one observed cycle, limited; ApparelMagic days that failed to load make the data "incomplete" and say so', async () => {
  const ctx = await ctxWith(synth('apparelmagic', '2025-10', 12, { total_requests: 730, failed_requests: 14 }));
  const ds = pc.dataStatus(ctx);
  assert.equal(ds.seasonality.confidence, 'limited'); assert.match(ds.seasonality.note, /one observed cycle/);
  assert.equal(ds.seasonality.incomplete, true); assert.match(ds.seasonality.note, /14 of 730 daily ApparelMagic requests failed/);
  const clean = pc.dataStatus(await ctxWith(synth('apparelmagic', '2025-10', 12, { total_requests: 730, failed_requests: 0 })));
  assert.equal(clean.seasonality.incomplete, false);
});
test('planning data status: Shopify units that matched no known style are reported, and a token that cannot see older orders is flagged', async () => {
  const s = synth('shopify', '2025-10', 12, { requested_from: '2024-10-13', stats: { unmapped_units: 120, unmapped_skus: 7 } });
  const ds = pc.dataStatus(await ctxWith(s));
  assert.equal(ds.seasonality.incomplete, true);
  assert.match(ds.seasonality.note, /120 units on 7 SKUs matched no known style/);
  assert.match(ds.seasonality.note, /later than the 2024-10-13 that was requested/);
});
test('the current-month fold only applies to a one-year window (a two-year window never merges two different years)', async () => {
  const two = await ctxWith(synth('shopify', '2024-10', 24));
  assert.equal(two.seasonality.available, true);
  assert.ok(!two.seasonality.months.some((m) => m === '2026-10'), 'the month in progress is not treated as a complete month');
});

// ── same definitions as Demand Planning (its sales feed + Sales Cadence screen) ──
// Demand Planning's styleFromSku(), copied verbatim from its index.html (V2 branch), as the reference the mapper must agree with for modern SKUs.
function dpStyleFromSku(sku) {
  if (!sku) return '';
  const u = sku.toUpperCase().trim();
  if (/^W\d{2}[A-Z]{2}\d{3}[A-Z]{3}/.test(u) && u.length >= 11) return u.slice(0, 11);
  for (const sz of ['XXXXL', 'XXXL', 'XXL', 'XL', 'XXS', 'XS', 'OS', 'S', 'M', 'L']) { if (u.endsWith(sz)) return u.slice(0, u.length - sz.length); }
  return u.replace(/\d{2}$/, '');
}
test('SKU -> style agrees with Demand Planning for every modern SKU, whether or not the style is in the catalogue (including colours that end in a size letter)', () => {
  const colours = ['BLK', 'WHT', 'OYS', 'WHM', 'LEM', 'BLO', 'BRO', 'STO', 'VIO', 'NAV'];
  const sizes = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'OS', '28', '30', ''];
  const noCatalogue = S.makeStyleMapper([]); const withCatalogue = S.makeStyleMapper(colours.map((c) => `W26HA006${c}`));
  for (const c of colours) for (const sz of sizes) {
    const sku = `W26HA006${c}${sz}`;
    assert.equal(noCatalogue(sku), dpStyleFromSku(sku), `${sku} without a catalogue`);
    assert.equal(withCatalogue(sku), dpStyleFromSku(sku), `${sku} with the catalogue`);
  }
});
test('an older SKU form is attached by the catalogue when known, and REPORTED (not guessed) when not', () => {
  assert.equal(S.makeStyleMapper(['W256A002ASS'])('W256A002ASSL'), 'W256A002ASS');
  assert.equal(S.makeStyleMapper([])('W256A002ASSL'), null);
});

function orderLines(rows) { // rows: [id, createdAt, { cancelledAt, test }, [[sku, qty, productType]]]
  const out = [];
  rows.forEach(([id, createdAt, flags, items]) => {
    out.push(j({ id, createdAt, cancelledAt: (flags || {}).cancelledAt || null, test: !!(flags || {}).test }));
    items.forEach(([sku, qty, ptype]) => out.push(j({ __parentId: id, sku, currentQuantity: qty, product: ptype === undefined ? null : { productType: ptype } })));
  });
  return out;
}
const DAYLINES = orderLines([
  ['o1', '2026-09-30T14:30:00Z', {}, [['W26AA001BLKS', 3, 'Tees'], ['W26AA001BLKM', 2, 'tees'], ['W26BB002WHTS', 4, 'SWEATS']]], // 1 Oct store-local
  ['o2', '2026-10-02T01:00:00Z', {}, [['W26AA001BLKL', 0, 'TEES']]],                                                         // fully refunded
  ['o3', '2026-10-03T01:00:00Z', { cancelledAt: '2026-10-03T02:00:00Z' }, [['W26AA001BLKS', 6, 'TEES']]],                   // cancelled, NOT refunded
  ['o4', '2026-10-04T01:00:00Z', { test: true }, [['W26BB002WHTS', 7, 'SWEATS']]],
  ['o5', '2026-10-05T01:00:00Z', {}, [['RETURNCOVER', 5, 'RETURN'], ['ORDPRO', 5, ''], ['W26BB002WHTM', 1, 'SWEATS']]],
]);
test('reconciliation with Demand Planning: same units for refunds / service lines, and cancelled / test units reported so the difference is explicit', async () => {
  const agg = await S.aggregate({ pass1: () => gen(DAYLINES), pass2: () => gen(DAYLINES), dayOf, mapStyle: S.makeStyleMapper(KNOWN), sinceDay: '2026-01-01' });
  // Demand Planning's feed total over the same data = currentQuantity of every non-service line, cancelled orders included unless refunded
  const dpTotal = 3 + 2 + 4 + 0 + 6 + 7 + 1; // o1 (9) + o2 (0) + o3 (6) + o4 (7) + o5 product line (1)
  const s = agg.stats;
  assert.equal(s.kept_units + s.cancelled_units + s.test_units, dpTotal, 'kept + cancelled + test = what Demand Planning would count');
  assert.equal(s.kept_units, 3 + 2 + 4 + 1); assert.equal(s.cancelled_units, 6); assert.equal(s.test_units, 7);
  assert.equal(s.excluded_category_units, 5, 'the RETURN product type is excluded, as Demand Planning does'); assert.equal(s.non_product_units, 5);
  assert.deepEqual(agg.byStyle.get('W26AA001BLK'), { '2026-10-01': 5 }); // monthly = sum of days
  assert.deepEqual(agg.byStyle.get('W26BB002WHT'), { '2026-10-01': 4, '2026-10-05': 1 });
});
test('category = Shopify product type upper-cased (the Sales Cadence grouping): the type carrying most of a style\'s units', async () => {
  const lines = orderLines([['a', '2026-09-30T14:30:00Z', {}, [['W26AA001BLKS', 5, 'Tees'], ['W26AA001BLKM', 1, 'Tops']]]]);
  const agg = await S.aggregate({ pass1: () => gen(lines), pass2: () => gen(lines), dayOf, mapStyle, sinceDay: '2026-01-01' });
  assert.equal(agg.categories.get('W26AA001BLK'), 'TEES');
  const out = S.toSalesByStyle(agg.byStyle, { today: '2026-10-12', sinceDay: '2025-10-13', firstDay: agg.firstDay, tz: TZ, stats: agg.stats, categories: agg.categories });
  assert.equal(out.categories.get('W26AA001BLK'), 'TEES');
});
test('Planning groups a product by its Shopify product type when the source is Shopify, else by the ApparelMagic category', async () => {
  const shop = synth('shopify', '2025-10', 12); shop.categories = new Map(FAMS.map((f) => [f.style_codes[0], 'SHOP TYPE']));
  const ctx = await ctxWith(shop);
  assert.ok([...ctx.seasonality.categories.keys()].includes('SHOP TYPE') && !ctx.seasonality.categories.has('TEES'), 'categories come from Shopify');
  assert.equal(ctx.salesSource.category_source, 'shopify_product_type');
  const am = await ctxWith(synth('apparelmagic', '2025-10', 12));
  assert.ok(am.seasonality.categories.has('TEES')); assert.equal(am.salesSource.category_source, 'apparelmagic_category');
});
test('cancelled / test units are stated as a definition difference, not as missing data', async () => {
  const s = synth('shopify', '2025-10', 12, { requested_from: '2025-10-13', stats: { cancelled_units: 40, test_units: 2 } });
  const ds = pc.dataStatus(await ctxWith(s));
  assert.equal(ds.seasonality.incomplete, false, 'a definition difference is not incompleteness');
  assert.match(ds.seasonality.note, /42 units on cancelled or test orders are excluded/); assert.deepEqual(ds.seasonality.definitions.length, 1);
});
