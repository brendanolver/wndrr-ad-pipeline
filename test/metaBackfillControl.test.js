'use strict';
// Settings > Meta Sync > "Backfill history" and the plain-English Reach message for very long ranges. Source-contract checks: nothing here calls Meta.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('public/app.js'); const html = read('public/index.html'); const route = read('src/routes/metaSync.js');

test('the plan route is admin-only, reads stored sync history only (no Meta call) and chunks like runBackfill', () => {
  const plan = route.slice(route.indexOf("router.get('/backfill-plan'"), route.indexOf('// Production-QA reconciliation aid'));
  assert.match(plan, /router\.get\('\/backfill-plan', requireAdmin/);
  assert.match(plan, /perf\.getCoverage\(/); assert.match(plan, /metaSync\.chunkRange\(r\.since, r\.until, metaSync\.BACKFILL_CHUNK_DAYS\)/);
  assert.ok(!/metaGet|metaGetAllPages|runSync|runBackfill|fetch\(/.test(plan), 'planning never calls Meta');
  assert.match(plan, /addDays\(perf\.ymdInZone\(new Date\(\), perf\.REPORTING_TIMEZONE\), -1\)/, 'today is left to the automatic sync');
  assert.match(plan, /cov\.missing_ranges, \.\.\.cov\.partial_ranges/, 'days synced before they finished are pulled again');
});

test('the Settings control: dates, check, confirm first, one chunk per request, stop, resumable, never automatic', () => {
  for (const id of ['meta-backfill-since', 'meta-backfill-until', 'meta-backfill-check-btn', 'meta-backfill-run-btn', 'meta-backfill-stop-btn', 'meta-backfill-progress']) assert.ok(html.includes(`id="${id}"`), id);
  const run = app.slice(app.indexOf('async function metaBackfillRun()'), app.indexOf("metaBackfillEl('meta-backfill-check-btn').addEventListener"));
  assert.match(run, /await confirmDialog\(/, 'asks before pulling anything');
  assert.ok(run.indexOf('confirmDialog(') < run.indexOf("api('/meta-sync/backfill'"), 'the confirm comes first');
  assert.match(run, /api\('\/meta-sync\/backfill', \{ method: 'POST', body: JSON\.stringify\(\{ since: c\.since, until: c\.until \}\) \}\)/, 'one chunk per request');
  assert.match(run, /if \(metaBackfillStop\)/); assert.match(run, /break;[\s\S]*Stopped at the first problem/, 'stops at the first failure');
  assert.match(run, /if \(!r\.completed \|\| res\.ok === false\)/);
  assert.equal((app.match(/api\('\/meta-sync\/backfill'/g) || []).length, 1, 'only this control calls the backfill route');
  const open = app.slice(app.indexOf('async function loadMetaSyncPanel()'), app.indexOf('async function loadMetaSyncPanel()') + 200);
  assert.ok(!/metaBackfillRun|backfill-plan/.test(open), 'opening the panel never starts or plans anything');
});

test('Reach for a range Meta will not calculate: a plain message, and no automatic retries', () => {
  const reach = read('src/lib/metaRangeReach.js'); const fresh = read('src/lib/metaFreshness.js');
  assert.match(reach, /reduce the amount of data/); assert.match(reach, /range_too_long/);
  assert.match(reach, /Meta won't calculate unique Reach for a range this long\. Choose a shorter range\./);
  assert.match(fresh, /last_error\.code === 'range_too_long'\) &&/, 'an automatic refresh does not keep asking Meta');
});

// ── a chunk Meta calls "too much data" is split instead of failing the run ───
const vm = require('vm');
const block = app.slice(app.indexOf('// <backfill-pure>'), app.indexOf('// </backfill-pure>'));
const ctx = {}; vm.createContext(ctx);
vm.runInContext(`${block}; this.api = { metaBackfillDays, metaBackfillSplit, metaBackfillHalves, metaBackfillTooMuch };`, ctx);
const { metaBackfillDays, metaBackfillSplit, metaBackfillHalves, metaBackfillTooMuch } = ctx.api;
const J = (v) => JSON.parse(JSON.stringify(v)); // values built inside the vm are from another realm

test('splitting: whole days, inclusive, no gaps or overlaps, in order', () => {
  assert.equal(metaBackfillDays('2025-10-26', '2025-11-24'), 30);
  const parts = J(metaBackfillSplit('2025-10-26', '2025-11-24', 7));
  assert.deepEqual(parts.map((p) => p.days), [7, 7, 7, 7, 2]);
  assert.equal(parts[0].since, '2025-10-26'); assert.equal(parts[4].until, '2025-11-24');
  parts.slice(1).forEach((p, i) => assert.equal(Date.parse(`${p.since}T00:00:00Z`) - Date.parse(`${parts[i].until}T00:00:00Z`), 86400000, 'the next piece starts the day after'));
  assert.deepEqual(J(metaBackfillSplit('2026-03-01', '2026-03-01', 30)), [{ since: '2026-03-01', until: '2026-03-01', days: 1 }]);
});

test('halving: 30 -> 15 + 15, 7 -> 4 + 3, 1 day cannot be halved; only Meta\'s "reduce the amount of data" message triggers it', () => {
  assert.deepEqual(J(metaBackfillHalves('2025-10-26', '2025-11-24')).map((p) => p.days), [15, 15]);
  assert.deepEqual(J(metaBackfillHalves('2025-10-26', '2025-11-01')).map((p) => p.days), [4, 3]);
  assert.equal(metaBackfillHalves('2025-10-26', '2025-10-26'), null);
  assert.ok(metaBackfillTooMuch('Meta request failed (Meta HTTP 500, code 1): Please reduce the amount of data you\'re asking for, then retry your request'));
  assert.ok(!metaBackfillTooMuch('Meta rate limit reached. Existing data is safe. Try again later.') && !metaBackfillTooMuch('') && !metaBackfillTooMuch(null));
});

test('the run halves on that message, keeps the size that worked, and still stops on any other failure or at a single day', () => {
  const run = app.slice(app.indexOf('async function metaBackfillRun()'), app.indexOf("metaBackfillEl('meta-backfill-check-btn').addEventListener"));
  assert.match(run, /metaBackfillTooMuch\(errText\) \? metaBackfillHalves\(c\.since, c\.until\) : null/);
  assert.match(run, /maxDays = halves\[0\]\.days; queue\.unshift\(\.\.\.halves\)/);
  assert.match(run, /if \(c\.days > maxDays\)/, 'later chunks start at the size that worked');
  assert.match(run, /Meta refuses even a single day/);
  assert.match(run, /failed = metaBackfillTooMuch\(errText\) \?[\s\S]*?break;/);
});
