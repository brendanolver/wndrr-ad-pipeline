'use strict';
// Shoot Plan > Send to Warehouse (v1.9.5): the week's samples go to Tuesday, which places ONE ApparelMagic order under WNDRR SHOOT STOCK. This app never writes to
// ApparelMagic itself. Every call here goes to a fake Tuesday (a fake fetch) and a fake database: nothing reaches a network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const express = require('express');
const wo = require('../src/lib/warehouseOrders');
const { makeRouter } = require('../src/routes/warehouseOrders');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const app = read('public', 'app.js');
const html = read('public', 'index.html');
const KEY = 'k'.repeat(40);
const ENV = { TUESDAY_URL: 'https://tuesday.test/', TUESDAY_ORDERS_KEY: KEY };

// the page's pure helpers, straight from the shipped file
const block = app.slice(app.indexOf('// <warehouse-order-pure>'), app.indexOf('// </warehouse-order-pure>'));
const ctx = {};
vm.createContext(ctx);
vm.runInContext(`${block}; this.api = { whNextWorkingDay, whIso, whBlockers, whPlural, whSku, whSizeOptions };`, ctx);
const { whNextWorkingDay, whIso, whBlockers, whPlural, whSku, whSizeOptions } = ctx.api;
const j = (v) => JSON.parse(JSON.stringify(v));

test('the default needed-by date is the next working day', () => {
  assert.equal(whIso(whNextWorkingDay(new Date(2026, 10, 24))), '2026-11-25', 'Tuesday -> Wednesday');
  assert.equal(whIso(whNextWorkingDay(new Date(2026, 10, 27))), '2026-11-30', 'Friday -> Monday');
  assert.equal(whIso(whNextWorkingDay(new Date(2026, 10, 28))), '2026-11-30', 'Saturday -> Monday');
  assert.equal(whPlural(1, 'sample'), '1 sample');
  assert.equal(whPlural(6, 'sample'), '6 samples');
});

test('what stops the order: the week\'s problems, sending switched off, real stock problems; stock that could not be looked at does not block', () => {
  const base = { ok: true, review: { problems: [] }, readiness: { canSend: true, blockers: [] }, stock: { ok: true, source: 'live', lines: [] } };
  assert.deepEqual(j(whBlockers(base)), []);
  assert.deepEqual(j(whBlockers({ ...base, review: { problems: ['Crew, Grey: no size chosen.'] } })), ['Crew, Grey: no size chosen.']);
  assert.deepEqual(j(whBlockers({ ...base, readiness: { canSend: false, blockers: ['Switched off.'] } })), ['Switched off.']);
  assert.deepEqual(j(whBlockers({ ...base, stock: { ok: false, source: 'live', lines: [{ message: 'Only 0 of Crew M in stock.' }, { message: null }] } })), ['Only 0 of Crew M in stock.']);
  assert.deepEqual(j(whBlockers({ ...base, stock: { ok: false, source: 'unavailable', lines: [], failure: 'down' } })), []);
  assert.deepEqual(j(whBlockers({ ok: false })), []);
});

test('settings: off unless both the Tuesday address and a long enough key are set', () => {
  assert.equal(wo.settings({}).configured, false);
  assert.equal(wo.settings({ TUESDAY_URL: 'https://t.test', TUESDAY_ORDERS_KEY: 'short' }).configured, false);
  assert.equal(wo.settings({ TUESDAY_URL: 'tuesday.test', TUESDAY_ORDERS_KEY: KEY }).configured, false, 'must be an http(s) address');
  assert.deepEqual(wo.settings(ENV), { url: 'https://tuesday.test', key: KEY, configured: true });
});

function fakeTuesday(reply, status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (reply instanceof Error) throw reply;
    return { status, json: async () => (typeof reply === 'function' ? reply(JSON.parse(init.body)) : reply) };
  };
  return { fetchImpl, calls };
}

test('callTuesday: one POST to Tuesday\'s route with the key, or a plain "switched off" answer with no call at all', async () => {
  const t = fakeTuesday({ ok: true, review: {} });
  const out = await wo.callTuesday('review', { weekStart: '2026-11-23', items: [] }, { env: ENV, fetchImpl: t.fetchImpl });
  assert.equal(out.ok, true);
  assert.equal(t.calls[0].url, 'https://tuesday.test/api/creative-pipeline/shoot-orders');
  assert.equal(t.calls[0].init.method, 'POST');
  assert.equal(t.calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.deepEqual(t.calls[0].body, { action: 'review', weekStart: '2026-11-23', items: [] });

  const off = fakeTuesday({ ok: true });
  const none = await wo.callTuesday('review', {}, { env: {}, fetchImpl: off.fetchImpl });
  assert.equal(none.notConfigured, true);
  assert.equal(off.calls.length, 0);

  assert.match((await wo.callTuesday('review', {}, { env: ENV, fetchImpl: fakeTuesday({ ok: false }, 401).fetchImpl })).error, /didn't accept this app's key/);
  assert.equal((await wo.callTuesday('review', {}, { env: ENV, fetchImpl: fakeTuesday({ ok: false, error: 'not ready' }, 503).fetchImpl })).notConfigured, true);
  await assert.rejects(wo.callTuesday('place', {}, { env: ENV, fetchImpl: fakeTuesday(new Error('ECONNRESET')).fetchImpl }), wo.TuesdayUnreachable);
  const slow = async (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  await assert.rejects(wo.callTuesday('place', {}, { env: ENV, fetchImpl: slow, timeoutMs: 20 }), /took too long/);
});

test('the week\'s samples are read from the database: selected colourways not in the office, one piece each', async () => {
  let sql = '';
  const db = { query: async (q, params) => { sql = q; assert.deepEqual(params, ['2026-11-23']); return { rows: [{ item_id: 1, style_id: 11, product_name: 'Box Fit Tee', style_code: 'W26IA004NAV ', colour_label: 'Navy', size: 'M' }, { item_id: 2, style_id: 12, product_name: 'Crew', style_code: 'W26CR001GRY', colour_label: null, size: '' }] }; } };
  const items = await wo.weekItems(db, '2026-11-23');
  assert.deepEqual(items, [
    { productName: 'Box Fit Tee', styleNumber: 'W26IA004NAV', colour: 'Navy', size: 'M', quantity: 1 },
    { productName: 'Crew', styleNumber: 'W26CR001GRY', colour: null, size: null, quantity: 1 },
  ]);
  assert.match(sql, /spi\.stock_status <> 'in_office'/);
  assert.match(sql, /NOT COALESCE\(spis\.in_office, false\)/);
  assert.match(sql, /NOT \(spi\.auto_linked OR/, 'products the plan only links automatically are not part of the selection (same as the pick list)');
});

// A catalogue as planningData.fetchAmData() returns it: details per style (size range, colour), size ranges, and warehouse stock per size.
const FAKE_AM = {
  amDetails: new Map([['W26IA004NAV', { sizeRangeId: 'R1', colourNameFromDescription: 'Navy Marle' }], ['W22IK014BLK', { sizeRangeId: 'R1', colourNameFromDescription: 'Faded Black' }], ['W24JK016WBE', { sizeRangeId: 'R2', colorCode: 'WBE' }], ['W22JK015AIR', { sizeRangeId: 'R1', colourNameFromWebTitle: 'AIR BLUE', colourNameFromDescription: null, colorCode: 'AIR' }]]),
  amSizeRanges: new Map([['R1', { sizes: ['S', 'M', 'L'] }], ['R2', { sizes: ['28', '30', '32'] }]]),
  amStock: { sizes: new Map([['W26IA004NAV', new Map([['S', 4], ['M', 0], ['L', 9]])], ['W22IK014BLK', new Map([['S', 37], ['M', 2]])]]) },
};

// The route, mounted on a real Express app with a fake signed-in user, a fake database and a fake Tuesday.
async function withServer(deps, fn) {
  const appx = express();
  appx.use(express.json());
  appx.use((req, res, next) => { req.user = { id: 1, name: 'Mark', email: 'mark@example.test' }; next(); });
  appx.use('/api/warehouse-orders', makeRouter(deps));
  const server = http.createServer(appx);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/api/warehouse-orders`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}
function fakeDb({ past = false, rows = [{ item_id: 1, style_id: 11, product_name: 'Box Fit Tee', style_code: 'W26IA004NAV', colour_label: 'Navy', size: 'M' }] } = {}) {
  return { query: async (q) => (/AS past/.test(q) ? { rows: [{ past }] } : { rows }) };
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

test('route: the review sends the saved samples and the chosen date to Tuesday and says whether sending is on', async () => {
  const t = fakeTuesday((b) => ({ ok: true, review: { weekStart: b.weekStart, toOrder: b.items } }));
  await withServer({ db: fakeDb(), env: ENV, fetchImpl: t.fetchImpl, am: FAKE_AM }, async (base) => {
    const out = await fetch(`${base}?week_start=2026-11-23&due_date=2026-11-28`).then((r) => r.json());
    assert.equal(out.ok, true);
    assert.equal(out.configured, true);
    assert.equal(out.sample_count, 1);
    assert.deepEqual(out.samples, [{ item_id: 1, style_id: 11, product_name: 'Box Fit Tee', style_code: 'W26IA004NAV', colour: 'Navy', size: 'M', sizes: ['S', 'M', 'L'], size_stock: { S: 4, M: 0, L: 9 }, to_order: true }]);
    assert.equal(out.week_passed, false);
    assert.deepEqual(t.calls[0].body, { action: 'review', weekStart: '2026-11-23', dueDate: '2026-11-28', items: [{ productName: 'Box Fit Tee', styleNumber: 'W26IA004NAV', colour: 'Navy', size: 'M', quantity: 1 }] });
    assert.equal((await fetch(`${base}?week_start=nope`)).status, 400);
  });
  await withServer({ db: fakeDb(), env: {}, fetchImpl: t.fetchImpl, am: FAKE_AM }, async (base) => {
    const out = await fetch(`${base}?week_start=2026-11-23`).then((r) => r.json());
    assert.equal(out.configured, false, 'no Tuesday settings: the page says ordering is not switched on');
  });
});

test('route: placing sends the DATABASE\'s samples (never a list from the browser) and who pressed the button', async () => {
  const t = fakeTuesday({ ok: true, order: { orderRef: '186100' } });
  await withServer({ db: fakeDb(), env: ENV, fetchImpl: t.fetchImpl }, async (base) => {
    const out = await post(`${base}/place`, { week_start: '2026-11-23', due_date: '2026-11-28', fingerprint: 'abc', items: [{ productName: 'Injected', quantity: 99 }] });
    assert.equal(out.ok, true);
    assert.deepEqual(t.calls[0].body, { action: 'place', weekStart: '2026-11-23', dueDate: '2026-11-28', fingerprint: 'abc', requestedBy: 'Mark', items: [{ productName: 'Box Fit Tee', styleNumber: 'W26IA004NAV', colour: 'Navy', size: 'M', quantity: 1 }] });
    assert.equal((await post(`${base}/place`, { week_start: '2026-11-23', fingerprint: 'abc' })).ok, false, 'no date: refused before Tuesday is asked');
    assert.equal(t.calls.length, 1);
  });
});

test('route: a finished week can\'t be ordered for, and an unanswered place call is reported as "may have gone through"', async () => {
  const t = fakeTuesday({ ok: true });
  await withServer({ db: fakeDb({ past: true }), env: ENV, fetchImpl: t.fetchImpl }, async (base) => {
    const out = await post(`${base}/place`, { week_start: '2026-11-16', due_date: '2026-11-28', fingerprint: 'abc' });
    assert.equal(out.ok, false);
    assert.match(out.error, /This week has finished/);
    assert.equal(t.calls.length, 0);
  });
  await withServer({ db: fakeDb(), env: ENV, fetchImpl: fakeTuesday(new Error('socket hang up')).fetchImpl }, async (base) => {
    const out = await post(`${base}/place`, { week_start: '2026-11-23', due_date: '2026-11-28', fingerprint: 'abc' });
    assert.equal(out.unknown, true);
    assert.match(out.error, /may still have gone through, so don't send it again/);
  });
});

test('route: check and clear pass the order id through, and clear says who did it', async () => {
  const t = fakeTuesday({ ok: true, check: { kind: 'none', canRelease: true, message: 'none' } });
  await withServer({ db: fakeDb(), env: ENV, fetchImpl: t.fetchImpl }, async (base) => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    assert.equal((await post(`${base}/check`, { week_start: '2026-11-23', order_id: id })).ok, true);
    assert.equal((await post(`${base}/release`, { week_start: '2026-11-23', order_id: id })).ok, true);
    assert.deepEqual(t.calls.map((c) => c.body), [
      { action: 'check', weekStart: '2026-11-23', orderId: id },
      { action: 'release', weekStart: '2026-11-23', orderId: id, requestedBy: 'Mark' },
    ]);
    assert.equal((await post(`${base}/check`, { week_start: '2026-11-23', order_id: 'drop table' })).ok, false);
  });
});

test('this app still never writes to ApparelMagic: the warehouse order goes through Tuesday only', () => {
  for (const f of [['src', 'lib', 'warehouseOrders.js'], ['src', 'routes', 'warehouseOrders.js']]) {
    const src = read(...f);
    // It may read the cached catalogue (colour names, sizes, stock) through the GET-only client's helpers, but never makes an ApparelMagic request itself.
    assert.doesNotMatch(src, /amRequest|rawRequest|fetchAllPages|apparelmagic\.com/i, `${f.join('/')} must not call ApparelMagic`);
  }
  assert.match(read('src', 'server.js'), /app\.use\('\/api\/warehouse-orders', requireAuth, requireModuleAccess\('planning'\)/, 'signed-in Planning users only');
});

test('page: the Send to Warehouse panel sits under the summary bar, refreshes with the plan, and asks before sending', () => {
  assert.match(html, /id="shoot-plan-summary"[^\n]*\n\s*\n\s*<div id="shoot-plan-warehouse" class="whp"/);
  assert.match(app, /renderWarehouseOrder\(\);\n {2}scheduleWarehouseOrderLoad\(\);/);
  assert.match(app, /Yes, send it/);
  assert.match(app, /This creates ApparelMagic order <b>\$\{escapeHtml\(r\.customerPo\)\}<\/b> under WNDRR SHOOT STOCK\./);
  assert.match(app, /Export CSV &darr;/, 'the CSV export stays as the fallback');
});

test('each sample shows a readable colour (the plan\'s label, else ApparelMagic\'s colour name, else the style code) and the sizes and stock for its picker', () => {
  const row = (code, label, size) => ({ item_id: 5, style_id: 9, product_name: 'OFFEND BEACH SHORT', style_code: code, colour_label: label, size });
  assert.deepEqual(wo.toSample(row('W22IK014BLK', null, 'S'), FAKE_AM), { item_id: 5, style_id: 9, product_name: 'OFFEND BEACH SHORT', style_code: 'W22IK014BLK', colour: 'Faded Black', size: 'S', sizes: ['S', 'M', 'L'], size_stock: { S: 37, M: 2 }, to_order: false });
  assert.equal(wo.toSample(row('W22JK015AIR', null, 'S'), FAKE_AM).colour, 'AIR BLUE', 'the web title\'s colour name comes first');
  assert.equal(wo.toSample(row('W24JK016WBE', null, '30'), FAKE_AM).colour, 'WBE', 'colour code when there is no colour name');
  assert.equal(wo.toSample(row('W22IK014BLK', 'Black', 'S'), FAKE_AM).colour, 'Black', 'the plan\'s own label wins');
  const bare = wo.toSample(row('W99XX001ZZZ', null, 'M'), null);
  assert.equal(bare.colour, null, 'the page then shows the style code');
  assert.deepEqual(bare.sizes, []);
  assert.equal(bare.size_stock, null);
  assert.deepEqual(wo.toItem(row('W22IK014BLK', null, ' S ')), { productName: 'OFFEND BEACH SHORT', styleNumber: 'W22IK014BLK', colour: null, size: 'S', quantity: 1 }, 'Tuesday is sent the plan as saved, never a looked-up colour');
});

test('samples still to order are the newest of each SKU, as many as Tuesday says are left', () => {
  const s = (id, code, size) => ({ item_id: id, style_id: id, style_code: code, size, to_order: false });
  const samples = [s(1, 'A', 'S'), s(2, 'B', 'M'), s(3, 'A', 'S'), s(4, 'C', '30')];
  const out = wo.markToOrder(samples, [{ styleNumber: 'a', size: 's', quantity: 1 }, { styleNumber: 'C', size: '30', quantity: 1 }]);
  assert.deepEqual(out.map((x) => [x.item_id, x.to_order]), [[1, false], [2, false], [3, true], [4, true]]);
  assert.equal(wo.skuKey(' w22ik014blk', ' s '), 'W22IK014BLKS');
  assert.equal(whSku('w22ik014blk', 's'), wo.skuKey('W22IK014BLK', 'S'), 'the page and the server match SKUs the same way');
});

test('size picker: every size the colour comes in, sizes with none in stock disabled unless already chosen, and the saved size always kept', () => {
  const opts = j(whSizeOptions({ size: 'M', sizes: ['S', 'M', 'L'], size_stock: { S: 4, M: 0, L: 9 } }));
  assert.deepEqual(opts, [
    { size: 'S', chosen: false, out: false, disabled: false },
    { size: 'M', chosen: true, out: true, disabled: false },
    { size: 'L', chosen: false, out: false, disabled: false },
  ]);
  assert.deepEqual(j(whSizeOptions({ size: 'S', sizes: ['S', 'M'], size_stock: { S: 3, M: 0 } })).map((o) => o.disabled), [false, true]);
  assert.deepEqual(j(whSizeOptions({ size: 'XXL', sizes: ['S', 'M'], size_stock: null })).map((o) => o.size), ['XXL', 'S', 'M'], 'a saved size the catalogue does not list still shows');
  assert.deepEqual(j(whSizeOptions({ size: 'M', sizes: [], size_stock: null })), [{ size: 'M', chosen: true, out: false, disabled: false }]);
});

test('page: the sizes are checked in a visible list, and a change saves to the Shoot Plan sample before Tuesday is asked again', () => {
  assert.match(app, /<b>Check the sizes<\/b>/);
  assert.match(app, /Sizes start from the person each product is assigned to; change any that are wrong before sending\./);
  assert.match(app, /onchange="setWarehouseSampleSize\(\$\{Number\(s\.item_id\)\}, \$\{Number\(s\.style_id\)\}, this\.value\)"/);
  assert.match(app, /await api\(`\/shoot-plan\/\$\{itemId\}\/styles\/\$\{styleId\}`, \{ method: 'PATCH', body: JSON\.stringify\(\{ size \}\) \}\);[\s\S]{0,600}scheduleWarehouseOrderLoad\(true\);/);
  assert.match(app, /const ready = [^;]*!wh\.saving;/, 'no sending while a size is being saved');
});

test('catalogue: the colour name is read from the web title as well as the description (only the warehouse list uses it)', () => {
  const am = require('../src/lib/apparelmagic');
  const details = new Map([['A', { colourNameFromWebTitle: 'FADED BLACK', colourNameFromDescription: 'Black', colorCode: 'BLK' }], ['B', { colourNameFromWebTitle: null, colourNameFromDescription: 'Oyster', colorCode: 'OYS' }], ['C', { colorCode: 'CEG' }]]);
  assert.equal(am.resolveColourName(details, 'A'), 'FADED BLACK');
  assert.equal(am.resolveColourName(details, 'B'), 'Oyster');
  assert.equal(am.resolveColourName(details, 'C'), null, 'never a bare colour code');
  assert.equal(am.resolveColourLabel(details, 'C'), 'CEG', 'other screens are unchanged');
  const src = read('src', 'lib', 'apparelmagic.js');
  assert.match(src, /const colourNameFromWebTitle = webDash >= 0 \? webTitle\.slice\(webDash \+ 3\)\.trim\(\) \|\| null : null;/);
});
