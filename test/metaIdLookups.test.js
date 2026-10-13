// Meta Graph API compatibility (deadline 27 Oct 2026): the root `GET /?ids=a,b,c` request is replaced by one `GET /{id}?fields=` per object, with the same
// { id: object } result, partial successes preserved, and failed ad-identity lookups reported (sync completeness) instead of silently swallowed.
// Everything is mocked: no network, no credentials, no database.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused'; // pool is lazy; never connected here
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const metaAds = require('../src/lib/metaAds');
const metaSync = require('../src/lib/metaSync');
const thumbs = require('../src/lib/metaCreativeThumbs');
const inspMeta = require('../src/lib/inspirationMetaLink');
const coverage = require('../src/lib/activeAdCoverage');
const opp = require('../src/lib/planningOpportunities');
const { CFG, TODAY, base, salesOf } = require('./_planningFixtures');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', f), 'utf8');
const ok200 = (data) => ({ status: 200, data });
const err = (status, code, subcode, message = 'x') => ({ status, data: { error: { code, error_subcode: subcode, message } } });
const NOT_FOUND = () => err(400, 100, 33, '(#100) Object does not exist, cannot be loaded due to missing permissions, or does not support this operation');
const RATE = () => err(400, 80004, 2446079, 'too many calls');
const AUTH = () => err(400, 190, null, 'Error validating access token');
const BOOM = () => err(500, 1, null, 'An unknown error occurred');
// a fake metaGet: handlers keyed by id; records every call
const fakeGet = (handlers, calls = []) => async (p, params) => {
  const id = decodeURIComponent(p.slice(1));
  calls.push({ path: p, params });
  const h = handlers[id];
  if (!h) return NOT_FOUND();
  return typeof h === 'function' ? h() : h;
};

// ── request construction ──────────────────────────────────────────────────────────────────────────
test('no request is built from the removed root `?ids=` pattern, and no deprecated parameter is sent', () => {
  const src = read('metaAds.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /ids:\s*ids\.join/, 'metaGetByIds must not send `ids=`');
  assert.doesNotMatch(src, /metaGet\(\s*['"]\/['"]/, 'no root-level GET /');
  for (const f of ['metaAds.js', 'metaSync.js', 'metaCreativeThumbs.js', 'inspirationMetaLink.js', 'metaAdCreative.js', 'metaInsightsDiagnostics.js', 'metaRangeReach.js', 'metaCampaigns.js']) {
    const s = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(s, /['"`]?(pretty|date_format|If-None-Match|etag)['"`]?\s*[:=]/i, `${f} sends a deprecated parameter`);
    assert.doesNotMatch(s, /\bdebug\s*:\s*['"]/, `${f} sends debug=`);
  }
  assert.match(read('metaAds.js'), /const GRAPH_API_VERSION = 'v21\.0'/, 'the Graph API version is deliberately unchanged');
});

test('one GET per object: path is /{id}, the same fields and extra params are sent, ids are de-duplicated, nothing else is added', async () => {
  const calls = [];
  const r = await metaAds.metaGetByIdsDetailed(['A1', 'A2', 'A1'], 'id,name', { thumbnail_width: '256' }, { get: fakeGet({ A1: ok200({ id: 'A1', name: 'one' }), A2: ok200({ id: 'A2', name: 'two' }) }, calls) });
  assert.equal(r.calls, 2);
  assert.deepEqual(calls.map((c) => c.path).sort(), ['/A1', '/A2']);
  calls.forEach((c) => assert.deepEqual(c.params, { thumbnail_width: '256', fields: 'id,name' }));
});

test('ids are URL-encoded so an odd id can never change the path', async () => {
  const calls = [];
  await metaAds.metaGetByIdsDetailed(['a/b?c=1'], 'id', {}, { get: async (p) => { calls.push(p); return ok200({ id: 'x' }); } });
  assert.equal(calls[0], '/a%2Fb%3Fc%3D1');
});

// ── result contract ───────────────────────────────────────────────────────────────────────────────
test('success: the { id: object } map is returned exactly as before (field values untouched)', async () => {
  const data = await metaAds.metaGetByIds(['A1', 'A2'], 'id,name', {}, { get: fakeGet({ A1: ok200({ id: 'A1', name: 'one', creative: { id: 'C1' } }), A2: ok200({ id: 'A2', name: 'two' }) }) });
  assert.deepEqual(Object.keys(data).sort(), ['A1', 'A2']);
  assert.deepEqual(data.A1, { id: 'A1', name: 'one', creative: { id: 'C1' } });
  assert.deepEqual(Object.keys(data[metaAds.metaGetByIds.FAILURES]), [], 'no failures to report');
});

test('missing fields: an object that lacks some requested fields is returned as Meta sent it', async () => {
  const data = await metaAds.metaGetByIds(['A1'], 'id,name,campaign_id', {}, { get: fakeGet({ A1: ok200({ id: 'A1' }) }) });
  assert.deepEqual(data.A1, { id: 'A1' });
});

test('mixed results: successes are preserved and each failure is classified (deleted / inaccessible is not the same as a failed read)', async () => {
  const data = await metaAds.metaGetByIds(['OK', 'GONE', 'FLAKY', 'EMPTY'], 'id', {}, { get: fakeGet({ OK: ok200({ id: 'OK' }), GONE: NOT_FOUND(), FLAKY: BOOM(), EMPTY: ok200({}) }) });
  assert.deepEqual(Object.keys(data), ['OK']);
  const f = data[metaAds.metaGetByIds.FAILURES];
  assert.equal(f.GONE.kind, 'not_found'); assert.equal(f.GONE.code, 100); assert.equal(f.GONE.subcode, 33);
  assert.equal(f.FLAKY.kind, 'error'); assert.equal(f.FLAKY.status, 500);
  assert.equal(f.EMPTY.kind, 'not_found', 'an empty object means there is nothing to read');
  assert.equal(f.OK, undefined);
});

test('a network error on one object is a failed read of that object only', async () => {
  const get = async (p) => { if (p === '/B') throw new Error('socket hang up https://graph.facebook.com/x?access_token=SECRET'); return ok200({ id: 'A' }); };
  const r = await metaAds.metaGetByIdsDetailed(['A', 'B'], 'id', {}, { get });
  assert.deepEqual(Object.keys(r.data), ['A']);
  assert.equal(r.failures.B.kind, 'error');
  assert.doesNotMatch(r.failures.B.message, /SECRET|graph\.facebook/, 'URLs and tokens never reach a stored message');
});

test('every id deleted / inaccessible: an empty map is returned (not an exception), each reported as not_found', async () => {
  const data = await metaAds.metaGetByIds(['X', 'Y'], 'id', {}, { get: fakeGet({}) });
  assert.deepEqual(Object.keys(data), []);
  assert.deepEqual(Object.values(data[metaAds.metaGetByIds.FAILURES]).map((f) => f.kind), ['not_found', 'not_found']);
});

test('complete failure: when nothing could be read and a read FAILED, it throws (as the old whole-request failure did) and carries the failures', async () => {
  await assert.rejects(metaAds.metaGetByIds(['A', 'B'], 'id', {}, { get: fakeGet({ A: BOOM(), B: BOOM() }) }), (e) => {
    assert.equal(e.name, 'MetaApiError'); assert.equal(e.status, 500); assert.equal(e.rateLimited, false);
    assert.deepEqual(Object.keys(e.failures).sort(), ['A', 'B']);
    return true;
  });
});

// ── authentication, rate limit, retry, concurrency ────────────────────────────────────────────────
test('rate limit: stops at once, throws a rateLimited MetaApiError, keeps what was read, never retries or asks for the rest', async () => {
  const calls = [];
  const handlers = { A: ok200({ id: 'A' }), B: RATE() };
  for (let i = 0; i < 30; i += 1) handlers[`Z${i}`] = ok200({ id: `Z${i}` });
  await assert.rejects(metaAds.metaGetByIds(['A', 'B', ...Object.keys(handlers).filter((k) => k.startsWith('Z'))], 'id', {}, { get: fakeGet(handlers, calls), concurrency: 1 }), (e) => {
    assert.equal(e.rateLimited, true); assert.equal(e.metaCode, 80004);
    assert.deepEqual(Object.keys(e.partial), ['A'], 'what was read before the stop is preserved');
    return true;
  });
  assert.equal(calls.filter((c) => c.path === '/B').length, 1, 'the limited request is not retried');
  assert.equal(calls.length, 2, 'no further object is requested after the rate limit');
});

test('authentication error: aborts like a rate limit (nothing else would work) and is not classified as a missing object', async () => {
  const calls = [];
  await assert.rejects(metaAds.metaGetByIds(['A', 'B', 'C'], 'id', {}, { get: fakeGet({ A: AUTH(), B: ok200({ id: 'B' }), C: ok200({ id: 'C' }) }, calls), concurrency: 1 }), (e) => {
    assert.equal(e.metaCode, 190); assert.equal(e.rateLimited, false);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(metaAds.classifyObjectFailure(AUTH()), 'auth');
  assert.equal(metaAds.classifyObjectFailure(RATE()), 'rate_limited');
  assert.equal(metaAds.classifyObjectFailure(NOT_FOUND()), 'not_found');
  assert.equal(metaAds.classifyObjectFailure(err(404, null, null)), 'not_found');
  assert.equal(metaAds.classifyObjectFailure(BOOM()), 'error');
});

test('concurrency is bounded (never more than the cap in flight) and a failed object does not retry', async () => {
  let inFlight = 0; let peak = 0; const seen = {};
  const get = async (p) => { seen[p] = (seen[p] || 0) + 1; inFlight += 1; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight -= 1; return p === '/F3' ? BOOM() : ok200({ id: p.slice(1) }); };
  const ids = Array.from({ length: 20 }, (_, i) => `F${i}`);
  const r = await metaAds.metaGetByIdsDetailed(ids, 'id', {}, { get });
  assert.ok(peak <= 4 && peak >= 2, `peak in flight ${peak}`);
  assert.equal(Object.keys(r.data).length, 19); assert.equal(r.failures.F3.kind, 'error');
  assert.equal(seen['/F3'], 1, 'no retry');
});

// ── ad identity lookups and sync completeness ─────────────────────────────────────────────────────
const fakeDb = () => {
  const rows = new Map(); const log = [];
  return { rows, log, query: async (sql, params) => {
    log.push([sql.replace(/\s+/g, ' ').trim(), params]);
    if (/INSERT INTO meta_ad_identity_lookups/.test(sql)) { const prev = rows.get(params[0]); rows.set(params[0], { state: params[1], attempts: prev ? prev.attempts + 1 : 1, code: params[2], message: params[3] }); }
    if (/DELETE FROM meta_ad_identity_lookups/.test(sql)) rows.delete(params[0]);
    return { rows: [] };
  } };
};
const mkGet = (handlers, calls) => (ids, fields, params) => metaAds.metaGetByIds(ids, fields, params, { get: fakeGet(handlers, calls) });

test('missing ad identity lookup: resolved ads are stored through the existing upsert, with the exact AD_FIELDS', async () => {
  const db = fakeDb(); const upserts = []; const calls = [];
  const out = await metaSync.lookupMissingAds(['A1', 'A2'], { db, metaGetByIds: mkGet({ A1: ok200({ id: 'A1', name: 'n1', effective_status: 'ACTIVE', campaign_id: 'c1', adset_id: 's1', creative: { id: 'cr1' }, created_time: '2026-10-01' }), A2: ok200({ id: 'A2', name: 'n2' }) }, calls), upsertAd: async (a) => { upserts.push(a); return true; } });
  assert.deepEqual(out, { requested: 2, resolved: 2, unresolved: 0, not_found: 0, failed: 0, calls: 2, failed_ids: [] });
  assert.deepEqual(upserts[0], { meta_ad_id: 'A1', meta_adset_id: 's1', meta_campaign_id: 'c1', meta_creative_id: 'cr1', ad_name: 'n1', effective_status: 'ACTIVE', created_time: '2026-10-01' });
  assert.equal(calls[0].params.fields, 'id,name,effective_status,campaign_id,adset_id,creative{id},created_time', 'field selection unchanged');
});

test('partial batch failure: resolved ads are kept, failed lookups are RECORDED and counted (they used to vanish silently)', async () => {
  const db = fakeDb(); const upserts = [];
  const out = await metaSync.lookupMissingAds(['OK', 'FLAKY', 'GONE'], { db, metaGetByIds: mkGet({ OK: ok200({ id: 'OK', name: 'n' }), FLAKY: BOOM(), GONE: NOT_FOUND() }), upsertAd: async (a) => { upserts.push(a.meta_ad_id); } });
  assert.deepEqual(upserts, ['OK']);
  assert.equal(out.resolved, 1); assert.equal(out.unresolved, 2); assert.equal(out.failed, 1); assert.equal(out.not_found, 1); assert.deepEqual(out.failed_ids, ['FLAKY']);
  assert.equal(db.rows.get('FLAKY').state, 'error'); assert.equal(db.rows.get('GONE').state, 'not_found'); assert.equal(db.rows.has('OK'), false);
});

test('complete batch failure: every ad is recorded as unresolved, nothing is stored, the lookup does not throw (the ads stay shells for the next sync)', async () => {
  const db = fakeDb(); const upserts = [];
  const out = await metaSync.lookupMissingAds(['A', 'B', 'C'], { db, metaGetByIds: mkGet({ A: BOOM(), B: BOOM(), C: BOOM() }), upsertAd: async (a) => { upserts.push(a); } });
  assert.equal(upserts.length, 0); assert.equal(out.failed, 3); assert.equal(out.resolved, 0);
  assert.deepEqual([...db.rows.keys()].sort(), ['A', 'B', 'C']);
});

test('a later successful lookup clears the record, and a repeated failure counts attempts', async () => {
  const db = fakeDb(); const deps = (h) => ({ db, metaGetByIds: mkGet(h), upsertAd: async () => true });
  await metaSync.lookupMissingAds(['A'], deps({ A: BOOM() }));
  await metaSync.lookupMissingAds(['A'], deps({ A: BOOM() }));
  assert.equal(db.rows.get('A').attempts, 2);
  await metaSync.lookupMissingAds(['A'], deps({ A: ok200({ id: 'A', name: 'n' }) }));
  assert.equal(db.rows.has('A'), false);
});

test('rate limit during the lookup: ads read before the stop are stored, then the sync aborts (rate-limit handling unchanged)', async () => {
  const db = fakeDb(); const upserts = [];
  const handlers = { A: ok200({ id: 'A', name: 'n' }), B: RATE(), C: ok200({ id: 'C', name: 'n' }) };
  await assert.rejects(metaSync.lookupMissingAds(['A', 'B', 'C'], { db, metaGetByIds: (ids, f, p) => metaAds.metaGetByIds(ids, f, p, { get: fakeGet(handlers), concurrency: 1 }), upsertAd: async (a) => { upserts.push(a.meta_ad_id); } }), (e) => e.rateLimited === true);
  assert.deepEqual(upserts, ['A']);
});

test('sync completeness: failed lookups make a run PARTIAL (status is left alone); deleted ads and a clean run are complete', () => {
  const partial = metaSync.describeCompleteness({ requested: 40, failed: 3, not_found: 2 });
  assert.equal(partial.completeness, 'partial'); assert.match(partial.note, /3 of 40 ad identity lookups failed/); assert.match(partial.note, /cannot be matched to a product/); assert.match(partial.note, /2 more no longer exist/);
  assert.equal(metaSync.describeCompleteness({ requested: 10, failed: 0, not_found: 0 }).completeness, 'complete');
  const gone = metaSync.describeCompleteness({ requested: 10, failed: 0, not_found: 4 });
  assert.equal(gone.completeness, 'complete'); assert.match(gone.note, /4 ads seen in Insights no longer exist/);
  const src = read('metaSync.js');
  assert.match(src, /status = 'success', finished_at = now\(\),\s*completeness = \$7/, 'the run is still recorded as success; completeness is recorded beside it');
  assert.match(src, /ads_unresolved = \$8, lookup_failed = \$9, lookup_not_found = \$10, completeness_note = \$11/);
});

test('the schema change is additive and idempotent, and existing runs read as unknown (NULL), not complete', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const add = schema.slice(schema.indexOf('Batch 27 follow-up: sync COMPLETENESS'), schema.indexOf('CREATE TABLE IF NOT EXISTS meta_ad_identity_lookups') + 700);
  assert.match(add, /ADD COLUMN IF NOT EXISTS completeness VARCHAR\(10\) CHECK \(completeness IN \('complete', 'partial'\)\);/);
  assert.doesNotMatch(add, /DEFAULT 'complete'/, 'old rows must not be reported as complete');
  assert.doesNotMatch(add, /DROP |DELETE FROM|TRUNCATE/i);
  assert.match(add, /CREATE TABLE IF NOT EXISTS meta_ad_identity_lookups/);
  assert.ok(schema.indexOf('meta_ad_identity_lookups') < schema.indexOf('Approved Ad Matching concepts + historical-spelling aliases'), 'before the metaBatch7 marker');
});

// ── thumbnails and share links ────────────────────────────────────────────────────────────────────
const thumbDb = (cachedRows = []) => {
  const written = [];
  return { written, query: async (sql, params) => {
    if (/INSERT INTO meta_creative_thumbs/.test(sql)) { written.push(params); return { rows: [] }; }
    if (/FROM meta_ads/.test(sql)) return { rows: [{ meta_ad_id: 'A1', meta_creative_id: 'C1' }, { meta_ad_id: 'A2', meta_creative_id: 'C2' }, { meta_ad_id: 'A3', meta_creative_id: 'C3' }] };
    return { rows: /FROM meta_creative_thumbs/.test(sql) ? cachedRows : [] };
  } };
};
const thumbDeps = (db, handlers) => ({ db, configured: () => true, autoEnabled: () => true, metaGetByIds: (ids, f, p) => metaAds.metaGetByIds(ids, f, p, { get: fakeGet(handlers) }) });
const cover = (id) => ok200({ id, object_type: 'SHARE', thumbnail_url: `https://scontent.xx.fbcdn.net/v/${id}.jpg?oe=7FFFFFFF`, video_id: null });

test('thumbnails: covers are stored; a deleted creative is cached as unavailable; a FAILED read is not remembered as unavailable', async () => {
  const db = thumbDb();
  const out = await thumbs.getThumbs(['A1', 'A2', 'A3'], { now: Date.parse('2026-10-13T00:00:00Z') }, thumbDeps(db, { C1: cover('C1'), C2: NOT_FOUND(), C3: BOOM() }));
  assert.equal(out.thumbs.A1.state, 'ok'); assert.match(out.thumbs.A1.thumb_url, /C1\.jpg/);
  assert.equal(out.thumbs.A2.state, 'unavailable', 'deleted: permanently unavailable');
  assert.equal(out.thumbs.A3.state, 'pending', 'unknown (read failed): asked again later');
  const written = db.written.map((w) => w[0]).sort();
  assert.deepEqual(written, ['C1', 'C2'], 'nothing is cached for the creative whose read failed');
  assert.equal(out.stats.meta_calls, 3, 'one read per creative');
});

test('large thumbnails: same rules, and the larger size is requested', async () => {
  const seen = [];
  const db = thumbDb();
  const out = await thumbs.getLargeThumbs(['A1', 'A3'], { now: Date.parse('2026-10-13T00:00:00Z') }, { ...thumbDeps(db, { C1: cover('C1'), C2: cover('C2'), C3: BOOM() }), metaGetByIds: (ids, f, p) => { seen.push(p); return metaAds.metaGetByIds(ids, f, p, { get: fakeGet({ C1: cover('C1'), C2: cover('C2'), C3: BOOM() }) }); } });
  assert.deepEqual(seen[0], thumbs.LARGE_PARAMS);
  assert.equal(out.thumbs.A1.state, 'ok');
  assert.equal(out.thumbs.A3.state, 'pending');
  assert.ok(!db.written.some((w) => w[0] === 'C3'));
});

test('thumbnails: when every creative read fails the batch is skipped exactly as a failed batch always was (nothing cached, no exception)', async () => {
  const db = thumbDb();
  const out = await thumbs.getThumbs(['A1'], { now: Date.parse('2026-10-13T00:00:00Z') }, thumbDeps(db, { C1: BOOM() }));
  assert.equal(db.written.length, 0); assert.equal(out.thumbs.A1.state, 'pending');
});

test('share links: stored when present; deleted ads count as "without link"; failed reads are counted separately and left to be looked up again', async () => {
  const stored = [];
  const db = { query: async (sql, params) => {
    if (/INSERT INTO meta_ad_share_links/.test(sql)) { stored.push(params); return { rows: [] }; }
    return { rows: [{ meta_ad_id: 'A1' }, { meta_ad_id: 'A2' }, { meta_ad_id: 'A3' }] };
  } };
  const handlers = { A1: ok200({ id: 'A1', preview_shareable_link: 'https://fb.me/e/x' }), A2: NOT_FOUND(), A3: BOOM() };
  const out = await inspMeta.lookupShareLinks({ limit: 10 }, { db, configured: () => true, metaGetByIds: (ids, f, p) => metaAds.metaGetByIds(ids, f, p, { get: fakeGet(handlers) }) });
  assert.deepEqual(stored.map((s) => s[0]), ['A1']);
  assert.equal(out.stored, 1); assert.equal(out.without_link, 1); assert.equal(out.failed, 1); assert.equal(out.asked, 2); assert.equal(out.calls, 3);
});

test('share links: a rate limit stops the press and reports it (unchanged)', async () => {
  const db = { query: async () => ({ rows: [{ meta_ad_id: 'A1' }, { meta_ad_id: 'A2' }] }) };
  const out = await inspMeta.lookupShareLinks({}, { db, configured: () => true, metaGetByIds: (ids, f, p) => metaAds.metaGetByIds(ids, f, p, { get: fakeGet({ A1: RATE(), A2: ok200({ id: 'A2' }) }), concurrency: 1 }) });
  assert.equal(out.rate_limited, true);
});

// ── Planning data confidence ──────────────────────────────────────────────────────────────────────
const strong = salesOf(150, { units7: 40, units14: 75 });
const run = (p) => opp.evaluate(p, CFG, TODAY, 'core');

test('Planning: ads whose identity could not be read are uncertainty, never a confirmed absence of creative', () => {
  const cov = (unresolved) => ({ known: true, active_ads: 0, possible: 0, unresolved, uncertain: false, min: 5 });
  const none = run(base({ sales: strong, creatives: [], coverage: cov(0) }));
  assert.equal(none.status, 'act'); assert.equal(none.gap.type, 'confirmed_gap'); assert.equal(none.facts.matching, 'confirmed');
  const unsure = run(base({ sales: strong, creatives: [], coverage: cov(3) }));
  assert.equal(unsure.status, 'insufficient_data'); assert.equal(unsure.actionable, false);
  assert.match(unsure.reason, /Matching is uncertain: 3 recently delivering Meta ads could not be identified/);
  assert.match(unsure.reason, /no shoot is recommended on an incomplete count/);
  assert.equal(unsure.facts.matching, 'uncertain'); assert.equal(unsure.facts.unresolved_identities, 3);
});

test('Planning: unresolved identities do not disturb a product that is already well covered, nor the existing suggested-match uncertainty', () => {
  const { cr } = require('./_planningFixtures');
  const perf = [cr('a', 'performing', { age: 60, spend: 700, purchases: 15, concept: 'TRY ON' }), cr('b', 'performing', { age: 40, spend: 600, purchases: 13, concept: 'UGC' }), cr('c', 'performing', { age: 20, spend: 500, purchases: 11, concept: 'FLAT LAY' })];
  assert.equal(run(base({ sales: strong, creatives: perf, coverage: { known: true, active_ads: 3, possible: 0, unresolved: 4, uncertain: false, min: 5 } })).status, 'covered');
  const suggested = run(base({ sales: strong, creatives: [], coverage: { known: true, active_ads: 0, possible: 2, unresolved: 0, uncertain: true, min: 5 } }));
  assert.equal(suggested.status, 'insufficient_data'); assert.match(suggested.reason, /2 active Meta ads awaiting review/);
});

test('Planning: coverage loader reports unresolved identities (delivering shells that Meta has not said are gone) and keeps its existing counts', async () => {
  const queries = [];
  const db = { query: async (sql, params) => {
    queries.push([sql, params]);
    if (/count\(\*\)::int AS ads, max\(last_seen_at\)/.test(sql)) return { rows: [{ ads: 10, last_seen: new Date('2026-10-12T00:00:00Z') }] };
    if (/meta_ad_identity_lookups/.test(sql)) return { rows: [{ n: 2 }] };
    if (/SELECT count\(DISTINCT m\.meta_ad_id\)::int AS n/.test(sql)) return { rows: [{ n: 7 }] };
    return { rows: [] };
  } };
  const out = await coverage.loadActiveAdCoverage([{ key: 'F1', codes: ['F1'] }], { db, min: 5, now: new Date('2026-10-13T00:00:00Z') });
  assert.equal(out.unresolved_identities, 2); assert.equal(out.reliability.unresolved_identities, 2); assert.equal(out.reliability.identities_complete, false);
  assert.equal(out.reliability.confirmed_or_auto, 7);
  const q = queries.find(([sql]) => /meta_ad_identity_lookups/.test(sql));
  assert.match(q[0], /m\.ad_name IS NULL/); assert.match(q[0], /<> 'not_found'/); assert.match(q[0], /d\.spend > 0/);
  assert.equal(q[1][0], '2026-09-29', 'a 14 day delivery window');
});

test('existing matching behaviour is untouched: matches, confirmations and classifications are never written by the lookup path', () => {
  const src = read('metaSync.js');
  const lookup = src.slice(src.indexOf('async function lookupMissingAds'), src.indexOf('async function fetchAndUpsertInsights'));
  assert.doesNotMatch(lookup, /match_status|meta_ad_products|meta_ad_classifications|meta_ad_suggestions/);
  assert.doesNotMatch(lookup, /DELETE FROM meta_ads|UPDATE meta_ads/);
  assert.match(lookup, /DELETE FROM meta_ad_identity_lookups WHERE meta_ad_id = \$1/, 'only the bookkeeping row is removed');
});
