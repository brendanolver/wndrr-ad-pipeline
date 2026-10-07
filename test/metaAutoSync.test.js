// Automatic RECENT Meta sync: rolling-window maths, hard cap, and the structural guarantees that it can never
// launch a backfill / inventory refresh / matching work or write to Meta. Pure (no database / network).
//   npm test
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused'; // pool is lazy; never connected here
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const auto = require('../src/lib/metaAutoSync');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('rolling window ends on the Sydney date, not the UTC date', () => {
  // 2026-10-06 22:30 UTC = 2026-10-07 09:30 Sydney (AEDT)
  assert.deepEqual(auto.windowFor(3, new Date('2026-10-06T22:30:00Z')), { since: '2026-10-05', until: '2026-10-07' });
  assert.deepEqual(auto.windowFor(7, new Date('2026-10-06T22:30:00Z')), { since: '2026-10-01', until: '2026-10-07' });
});

test('the window can never be wider than the hard cap, whatever is asked for', () => {
  const w = auto.windowFor(500, new Date('2026-10-07T02:00:00Z'));
  const span = (Date.parse(w.until) - Date.parse(w.since)) / 86400000 + 1;
  assert.equal(span, auto.MAX_WINDOW_DAYS);
  assert.ok(auto.MAX_WINDOW_DAYS <= 7 && auto.NORMAL_WINDOW_DAYS <= auto.SETTLE_WINDOW_DAYS && auto.SETTLE_WINDOW_DAYS <= auto.MAX_WINDOW_DAYS);
});

test('the auto-sync module can reach nothing but the routine sync', () => {
  const src = code('lib/metaAutoSync.js');
  assert.doesNotMatch(src, /refreshInventory|runBackfill|rederiveConversions|refreshSuggestions|startBacklog|metaAdMatching|catalogue|apparelmagic|metaRangeReach|metaAdCreative/i);
  assert.match(src, /require\('\.\/metaSync'\)/);
  const calls = [...src.matchAll(/metaSync\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(calls)].sort(), ['runSync']);
  assert.match(src, /runType: 'default'/);
});

test('the routine sync it calls is read-only against Meta (GET only) and never touches matching', () => {
  const sync = code('lib/metaSync.js');
  assert.doesNotMatch(sync, /method:\s*['"](POST|PUT|PATCH|DELETE)['"]|metaAdMatching/);
  assert.doesNotMatch(code('lib/metaAds.js'), /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/);
});

test('the scheduler is started once from server boot, after listen, and can be turned off', () => {
  const server = read('server.js');
  assert.match(server, /metaAutoSync\.startScheduler\(\)/);
  const src = read('lib/metaAutoSync.js');
  assert.match(src, /META_AUTO_SYNC/);
  assert.match(src, /\.unref\(\)/, 'timers never keep the process alive');
});

test('disabled by env, and a no-op when Meta is not configured', async () => {
  const keep = { a: process.env.META_AUTO_SYNC, t: process.env.META_ACCESS_TOKEN, i: process.env.META_AD_ACCOUNT_ID };
  try {
    process.env.META_AUTO_SYNC = 'off';
    assert.equal((await auto.runOnce({ sync: () => assert.fail('must not sync') })).ran, false);
    assert.equal(auto.startScheduler(), null);
    process.env.META_AUTO_SYNC = 'on';
    delete process.env.META_ACCESS_TOKEN; delete process.env.META_AD_ACCOUNT_ID;
    const r = await auto.runOnce({ sync: () => assert.fail('must not sync') });
    assert.equal(r.ran, false);
    assert.match(r.reason, /not configured/);
  } finally {
    Object.entries({ META_AUTO_SYNC: keep.a, META_ACCESS_TOKEN: keep.t, META_AD_ACCOUNT_ID: keep.i }).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  }
});

test('only one run at a time: runs start under an advisory lock + running-row check shared with the manual buttons', () => {
  const sync = read('lib/metaSync.js');
  assert.match(sync, /pg_advisory_xact_lock/);
  assert.match(sync, /startRunExclusive\(\{ runType, since, until, userId \}\)/);
  assert.match(sync, /startRunExclusive\(\{ runType: 'inventory'/);
  assert.match(read('routes/metaSync.js'), /SYNC_IN_PROGRESS[\s\S]*409/);
});
