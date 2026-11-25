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
vm.runInContext(`${block}; this.api = { whNextWorkingDay, whIso, whBlockers, whPlural };`, ctx);
const { whNextWorkingDay, whIso, whBlockers, whPlural } = ctx.api;
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
  const db = { query: async (q, params) => { sql = q; assert.deepEqual(params, ['2026-11-23']); return { rows: [{ product_name: 'Box Fit Tee', style_code: 'W26IA004NAV ', colour_label: 'Navy', size: 'M' }, { product_name: 'Crew', style_code: 'W26CR001GRY', colour_label: null, size: '' }] }; } };
  const items = await wo.weekItems(db, '2026-11-23');
  assert.deepEqual(items, [
    { productName: 'Box Fit Tee', styleNumber: 'W26IA004NAV', colour: 'Navy', size: 'M', quantity: 1 },
    { productName: 'Crew', styleNumber: 'W26CR001GRY', colour: null, size: null, quantity: 1 },
  ]);
  assert.match(sql, /spi\.stock_status <> 'in_office'/);
  assert.match(sql, /NOT COALESCE\(spis\.in_office, false\)/);
  assert.match(sql, /NOT \(spi\.auto_linked OR/, 'products the plan only links automatically are not part of the selection (same as the pick list)');
});

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
function fakeDb({ past = false, rows = [{ product_name: 'Box Fit Tee', style_code: 'W26IA004NAV', colour_label: 'Navy', size: 'M' }] } = {}) {
  return { query: async (q) => (/AS past/.test(q) ? { rows: [{ past }] } : { rows }) };
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

test('route: the review sends the saved samples and the chosen date to Tuesday and says whether sending is on', async () => {
  const t = fakeTuesday((b) => ({ ok: true, review: { weekStart: b.weekStart, toOrder: b.items } }));
  await withServer({ db: fakeDb(), env: ENV, fetchImpl: t.fetchImpl }, async (base) => {
    const out = await fetch(`${base}?week_start=2026-11-23&due_date=2026-11-28`).then((r) => r.json());
    assert.equal(out.ok, true);
    assert.equal(out.configured, true);
    assert.equal(out.samples, 1);
    assert.equal(out.week_passed, false);
    assert.deepEqual(t.calls[0].body, { action: 'review', weekStart: '2026-11-23', dueDate: '2026-11-28', items: [{ productName: 'Box Fit Tee', styleNumber: 'W26IA004NAV', colour: 'Navy', size: 'M', quantity: 1 }] });
    assert.equal((await fetch(`${base}?week_start=nope`)).status, 400);
  });
  await withServer({ db: fakeDb(), env: {}, fetchImpl: t.fetchImpl }, async (base) => {
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
    assert.doesNotMatch(src, /require\(['"][^'"]*apparelmagic['"]\)/, `${f.join('/')} must not use the ApparelMagic client`);
    assert.doesNotMatch(src, /apparelmagic\.com/i, `${f.join('/')} must not call ApparelMagic`);
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
