'use strict';
// "Last Creative Uploaded": the creative date written in the ad name, per unique creative, newest per product. Display data only: it never feeds the engine.
// Built on the real grouping code (productAdPerformance.creativeGroupKey / newGroup / addRowToGroup / mergeNameCopies) over a stubbed database. No database, no network.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const lc = require('../src/lib/lastCreativeDate');
const E = require('../public/planningExplain');

const TODAY = '2026-10-14';
const EXAMPLE = '#306_26-WK38_18-09_SUMMER SHORTS_SHORTS_SHORTS FOR EVERY OCCASION_Video_Single_STEVE_TALK THROUGH_Category';
const nm = (no, wk, dd, mm, yy = 26) => `#${no}_${yy}-WK${String(wk).padStart(2, '0')}_${String(dd).padStart(2, '0')}-${String(mm).padStart(2, '0')}_TITLE_Video`;

// ── extraction ─────────────────────────────────────────────────────────────
test('extract: the documented example is 18/09/2026', () => {
  const p = lc.parseCreativeDate(EXAMPLE, { today: TODAY });
  assert.deepEqual(p, { ok: true, date: '2026-09-18', creative_no: '306', reason: null });
});

test('extract: structure and date are validated, never guessed', () => {
  const bad = (name) => lc.parseCreativeDate(name, { today: TODAY });
  assert.equal(bad('Summer shorts video').reason, 'no_pattern');
  assert.equal(bad('').reason, 'no_pattern'); assert.equal(bad(null).reason, 'no_pattern');
  assert.equal(bad('#306_2026-WK38_18-09_x').reason, 'no_pattern', 'a four digit year is not the convention');
  assert.equal(bad(nm(1, 38, 31, 9)).reason, 'invalid_date', '31 September');
  assert.equal(bad(nm(1, 9, 29, 2)).reason, 'invalid_date', '29 February 2026 (not a leap year)');
  assert.equal(bad(nm(1, 38, 0, 9)).reason, 'invalid_date');
  assert.equal(bad(nm(1, 38, 18, 13)).reason, 'invalid_date', 'month 13');
  assert.equal(bad(nm(1, 10, 18, 9)).reason, 'week_mismatch', 'WK10 does not contain 18 September');
  assert.equal(bad(nm(1, 60, 18, 9)).reason, 'week_mismatch');
  assert.equal(bad(nm(1, 38, 18, 9, 28)).reason, 'future', 'a date after today is not a produced creative');
  assert.equal(bad(nm(1, 38, 18, 9, 15)).reason, 'implausible_year');
  assert.equal(lc.parseCreativeDate(nm(1, 9, 29, 2, 28), { today: '2028-12-01' }).date, '2028-02-29', 'a real leap day is fine');
});

test('extract: a leading space, a missing # and a week one position off (Sunday vs Monday weeks) are tolerated; New Year weeks wrap', () => {
  assert.equal(lc.parseCreativeDate(` ${nm(7, 38, 18, 9)}`, { today: TODAY }).date, '2026-09-18');
  assert.equal(lc.parseCreativeDate(nm(7, 38, 18, 9).slice(1), { today: TODAY }).date, '2026-09-18');
  assert.equal(lc.parseCreativeDate(nm(7, 37, 18, 9), { today: TODAY }).date, '2026-09-18', 'one week out is accepted');
  assert.equal(lc.parseCreativeDate(nm(7, 53, 1, 1), { today: TODAY }).date, '2026-01-01', '1 January 2026 sits in ISO week 1; week 53 of the previous year is a neighbour');
  assert.equal(lc.parseCreativeDate(nm(7, 1, 30, 12, 25), { today: TODAY }).date, '2025-12-30', '30 December 2025 is ISO week 1 of 2026');
});

// ── one unique creative from its instances ─────────────────────────────────────────────
const inst = (id, name, created) => ({ id, name, created_time: created });

test('creative: the date is the ORIGINAL ad’s; an identical duplicate in another campaign is the same date, not a new one', () => {
  const r = lc.resolveCreativeDate([inst('a1', nm(306, 38, 18, 9), '2026-09-19T01:00:00Z'), inst('a2', nm(306, 38, 18, 9), '2026-10-10T01:00:00Z')], { today: TODAY });
  assert.equal(r.date, '2026-09-18'); assert.equal(r.source, 'original_ad_name'); assert.equal(r.original_id, 'a1'); assert.deepEqual(r.conflicts, []);
});

test('creative: a duplicate re-dated later does not make the creative newer (the newest date is never silently picked); the disagreement is disclosed', () => {
  const r = lc.resolveCreativeDate([inst('orig', nm(306, 38, 18, 9), '2026-09-19T01:00:00Z'), inst('dup', nm(306, 41, 8, 10), '2026-10-09T01:00:00Z')], { today: TODAY });
  assert.equal(r.date, '2026-09-18', 'the original, not the newest');
  assert.deepEqual(r.conflicts, [{ id: 'dup', name: nm(306, 41, 8, 10), date: '2026-10-08' }]);
});

test('creative: a duplicate renamed with a date, whose original has no usable date, is unavailable (no date is invented)', () => {
  const r = lc.resolveCreativeDate([inst('old', 'Summer shorts video', '2026-03-01T00:00:00Z'), inst('dup', nm(306, 41, 8, 10), '2026-10-09T01:00:00Z')], { today: TODAY });
  assert.equal(r.date, null); assert.equal(r.reason, 'original_undated');
});

test('creative: copies that disagree with nothing to say which is the original are unavailable (conflicting dates)', () => {
  const r = lc.resolveCreativeDate([inst('a', nm(1, 38, 18, 9), null), inst('b', nm(1, 36, 4, 9), null)], { today: TODAY });
  assert.equal(r.date, null); assert.equal(r.reason, 'conflicting_dates'); assert.equal(r.conflicts.length, 2);
  const tie = lc.resolveCreativeDate([inst('a', nm(1, 38, 18, 9), '2026-09-19T01:00:00Z'), inst('b', nm(1, 36, 4, 9), '2026-09-19T01:00:00Z')], { today: TODAY });
  assert.equal(tie.date, null, 'two originals created at the same moment with different dates');
  const agree = lc.resolveCreativeDate([inst('a', nm(1, 38, 18, 9), null), inst('b', nm(1, 38, 18, 9), null)], { today: TODAY });
  assert.equal(agree.date, '2026-09-18', 'agreeing copies need no creation time');
});

test('creative: a creative date later than the ad that carries it was created is rejected', () => {
  const r = lc.resolveCreativeDate([inst('a', nm(1, 38, 18, 9), '2026-08-01T00:00:00Z')], { today: TODAY });
  assert.equal(r.date, null); assert.equal(r.reason, 'after_ad_created');
  assert.equal(lc.resolveCreativeDate([inst('a', nm(1, 38, 18, 9), '2026-09-12T00:00:00Z')], { today: TODAY }).date, '2026-09-18', 'a few days of slack are allowed');
});

test('creative: missing and invalid dates give an unavailable state with the reason', () => {
  assert.equal(lc.resolveCreativeDate([inst('a', 'Old creative', '2025-01-01T00:00:00Z')], { today: TODAY }).reason, 'no_pattern');
  assert.equal(lc.resolveCreativeDate([inst('a', nm(1, 38, 31, 9), '2026-10-01T00:00:00Z')], { today: TODAY }).reason, 'invalid_date');
  assert.equal(lc.resolveCreativeDate([], { today: TODAY }).reason, 'no_instances');
});

// ── a product ────────────────────────────────────────────────────────────────
test('product: the newest valid date across several creatives; none when nothing is dated', () => {
  const s = lc.summarizeProduct([
    { key: 'a', name: 'A', date: '2026-07-02', created: '2026-07-03', conflicts: [] },
    { key: 'b', name: 'B', date: '2026-09-18', created: '2026-09-19', conflicts: [] },
    { key: 'c', name: 'C', date: '2026-08-10', created: '2026-08-11', conflicts: [] },
  ]);
  assert.equal(s.last_creative_uploaded_date, '2026-09-18'); assert.equal(s.creative_name, 'B'); assert.deepEqual([s.creatives_total, s.creatives_dated, s.creatives_undated], [3, 3, 0]);
  assert.equal(s.possibly_newer_undated, false);
  const none = lc.summarizeProduct([{ key: 'a', date: null, reason: 'no_pattern', created: '2026-01-01', conflicts: [] }]);
  assert.equal(none.last_creative_uploaded_date, null); assert.equal(none.unavailable_reason, 'no_dated_creative');
  assert.equal(lc.summarizeProduct([]).unavailable_reason, 'no_creative', 'a product with no matched creative');
});

test('product: an undated creative made after the latest dated one is disclosed (the date shown may be too old)', () => {
  const s = lc.summarizeProduct([{ key: 'a', date: '2026-07-02', created: '2026-07-03', conflicts: [] }, { key: 'b', date: null, reason: 'no_pattern', created: '2026-09-30', conflicts: [] }]);
  assert.equal(s.last_creative_uploaded_date, '2026-07-02'); assert.equal(s.possibly_newer_undated, true);
  const old = lc.summarizeProduct([{ key: 'a', date: '2026-07-02', created: '2026-07-03', conflicts: [] }, { key: 'b', date: null, reason: 'no_pattern', created: '2025-12-30', conflicts: [] }]);
  assert.equal(old.possibly_newer_undated, false, 'an older undated creative cannot make the date stale');
});

// ── the loader, over a stubbed database ───────────────────────────────────────────────────
const row = (id, name, o = {}) => ({ meta_ad_id: id, ad_name: name, meta_creative_id: o.creative === undefined ? `cr_${id}` : o.creative, effective_status: o.status || 'ACTIVE', created_time: o.created || '2026-09-19T01:00:00Z', product_codes: o.codes || ['W26AA001'] });
const stubDb = (rows, extra = []) => {
  const seen = [];
  return { seen, query: async (sql) => { seen.push(sql); return /last-creative-origins/.test(sql) ? { rows: extra } : { rows }; } };
};
const FAM = [{ key: 'W26AA001', codes: ['W26AA001'] }, { key: 'W26BB002', codes: ['W26BB002'] }];

test('loader: paused / historical creative counts; the original found among UNMATCHED instances dates a duplicate; each unique creative counts once', async () => {
  const db = stubDb([
    row('p1', nm(300, 30, 24, 7), { status: 'PAUSED', creative: 'crX', created: '2026-07-25T00:00:00Z' }),            // paused history
    row('d1', nm(306, 38, 18, 9), { creative: 'crY', created: '2026-10-09T00:00:00Z' }),                             // active duplicate of the 18 Sep creative
  ], [
    { meta_ad_id: 'o1', meta_creative_id: 'crY', ad_name: nm(306, 38, 18, 9), created_time: '2026-09-19T00:00:00Z' }, // the unreviewed original (not matched)
    { meta_ad_id: 'p1', meta_creative_id: 'crX', ad_name: nm(300, 30, 24, 7), created_time: '2026-07-25T00:00:00Z' },
  ]);
  const out = await lc.loadLastCreativeDates(FAM, { db, today: TODAY });
  const s = out.byFamily.get('W26AA001');
  assert.equal(s.last_creative_uploaded_date, '2026-09-18'); assert.equal(s.creatives_total, 2, 'two unique creatives, not three ads');
  assert.equal(out.byAd.get('d1').date, '2026-09-18'); assert.equal(out.byAd.get('p1').date, '2026-07-24');
  assert.equal(out.byFamily.get('W26BB002').unavailable_reason, 'no_creative', 'a product with no matched creative');
});

test('loader: a duplicate re-dated in its name and created later does not move the date; the copy is reported', async () => {
  const db = stubDb([row('o', nm(306, 38, 18, 9), { creative: 'crY', created: '2026-09-19T00:00:00Z' }), row('d', nm(306, 41, 8, 10), { creative: 'crY', created: '2026-10-09T00:00:00Z' })]);
  const out = await lc.loadLastCreativeDates(FAM, { db, today: TODAY });
  assert.equal(out.byFamily.get('W26AA001').last_creative_uploaded_date, '2026-09-18'); assert.equal(out.byFamily.get('W26AA001').has_conflicts, true);
  assert.equal(out.byFamily.get('W26AA001').creatives_total, 1);
});

test('loader: a "- Copy" by name is the same creative even with its own creative id', async () => {
  const db = stubDb([row('o', nm(306, 38, 18, 9), { creative: 'c1', created: '2026-09-19T00:00:00Z' }), row('c', `${nm(306, 38, 18, 9)} - Copy`, { creative: 'c2', created: '2026-10-09T00:00:00Z' })]);
  const s = (await lc.loadLastCreativeDates(FAM, { db, today: TODAY })).byFamily.get('W26AA001');
  assert.equal(s.creatives_total, 1); assert.equal(s.last_creative_uploaded_date, '2026-09-18');
});

test('loader: an undated duplicate of an old creative is unavailable rather than dated by its own creation', async () => {
  const db = stubDb([row('c', 'Old hero cut - Copy', { creative: 'c2', created: '2026-10-09T00:00:00Z' })], [{ meta_ad_id: 'o', meta_creative_id: 'c1', ad_name: 'Old hero cut', created_time: '2025-11-01T00:00:00Z' }]);
  const s = (await lc.loadLastCreativeDates(FAM, { db, today: TODAY })).byFamily.get('W26AA001');
  assert.equal(s.last_creative_uploaded_date, null); assert.equal(s.unavailable_reason, 'no_dated_creative');
});

test('loader: the query is read-only, reliable matches only, DPAs and excluded ads left out, ANY delivery status', async () => {
  const db = stubDb([]); await lc.loadLastCreativeDates(FAM, { db, today: TODAY });
  const sql = db.seen.join('\n');
  assert.match(sql, /match_status IN \('confirmed', 'auto_matched'\)/); assert.match(sql, /excluded_from_intelligence/); assert.match(sql, /meta_ad_products/);
  assert.doesNotMatch(sql, /effective_status = 'ACTIVE'/, 'paused and archived creative is included');
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|ALTER|DROP)\b/i);
  assert.ok(/dpa|DPA|dynamic/i.test(require('../src/lib/metaDpa').dpaPredicate('m', 'c')), 'the same DPA exclusion the rest of Planning uses');
});

// ── display ─────────────────────────────────────────────────────────────────
test('display: 18 Sep / 2026 in the table, 18 September 2026 in the panel, a dash when unavailable; the label never claims a Meta upload', () => {
  const k = E.lastCreative({ last_creative: { last_creative_uploaded_date: '2026-09-18', creatives_total: 2, creatives_dated: 2, creatives_undated: 0 } });
  assert.deepEqual([k.known, k.day, k.year, k.long], [true, '18 Sep', '2026', '18 September 2026']);
  assert.match(k.title, /not a verified Meta upload date/);
  const none = E.lastCreative({ last_creative: { last_creative_uploaded_date: null, unavailable_reason: 'no_dated_creative' } });
  assert.equal(none.known, false); assert.match(none.title, /not available/);
  assert.equal(E.lastCreative({}).known, false);
  const warn = E.lastCreative({ last_creative: { last_creative_uploaded_date: '2026-09-18', creatives_total: 3, creatives_undated: 1, possibly_newer_undated: true } });
  assert.equal(warn.uncertain, true); assert.match(warn.caveat, /may be newer/);
  assert.equal(E.creativeDate({ original_date: '2026-09-18' }).long, '18 September 2026');
  assert.equal(E.creativeDate({ original_date: null, original_date_reason: 'original_undated' }).known, false);
});

test('wiring: Key metrics gain Last creative; the panel shows Last Creative Uploaded; Recent live ads shows the original date next to first delivery; the engine never reads it', () => {
  const root = path.join(__dirname, '..');
  const pl = fs.readFileSync(path.join(root, 'public', 'planning.js'), 'utf8');
  const cell = pl.slice(pl.indexOf('function plMetricsCell'), pl.indexOf('function plStatusCell'));
  const order = ['Sales 30D', 'Stock on hand', 'Live ads', 'Last creative'].map((k) => cell.indexOf(`<small>${k}`));
  assert.ok(order.every((i, n) => i > -1 && (n === 0 || i > order[n - 1])), 'Sales 30D, Stock on hand, Live ads, Last creative');
  assert.match(pl, /Last Creative Uploaded/); assert.match(pl, /<th>Creative date<\/th>/); assert.match(pl, /first delivery \$\{plEsc\(PE\.longDate\(c\.first_delivery\)\)\}/);
  const head = pl.slice(pl.indexOf('function plTableHtml'), pl.indexOf('const PL_EMPTY'));
  assert.deepEqual([...head.matchAll(/th\('([^']+)'/g)].map((m) => m[1]), ['Product', 'Key metrics', 'Creative status', 'Priority', 'Action'], 'the table columns are unchanged');
  for (const f of ['planningOpportunities.js', 'planningPrimary.js', 'creativeRecency.js', 'planningDemand.js']) assert.doesNotMatch(fs.readFileSync(path.join(root, 'src', 'lib', f), 'utf8'), /last_creative|lastCreative/, `${f} does not read the date`);
  const ld = fs.readFileSync(path.join(root, 'src', 'lib', 'planningOpportunitiesLoader.js'), 'utf8');
  const run = ld.slice(ld.indexOf('const runMode'), ld.indexOf('const coreEvals'));
  assert.doesNotMatch(run, /lastCreative/, 'it is attached to the finished items, never passed to opp.evaluate');
  assert.match(ld, /last_creative: lastCreative/);
});
