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
