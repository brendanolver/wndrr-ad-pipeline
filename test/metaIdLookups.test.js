// Meta Graph API compatibility (deadline 27 Oct 2026): the root `GET /?ids=a,b,c` request is replaced by one `GET /{id}?fields=` per object, with the same { id: object } result,
// partial successes preserved, and failed ad-identity lookups reported (sync completeness) instead of silently swallowed.
// Meta's "cannot be loaded" error (100/33) is ambiguous (deleted / no permission / another account / invalid id), so NOTHING is ever classified as permanently deleted from an error.
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
const guard = require('../src/lib/metaRequestGuard');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', f), 'utf8');
const ok200 = (data) => ({ status: 200, data });
const err = (status, code, subcode, message = 'x') => ({ status, data: { error: { code, error_subcode: subcode, message } } });
const CANNOT_LOAD = () => err(400, 100, 33, '(#100) Object does not exist, cannot be loaded due to missing permissions, or does not support this operation');
const INVALID_ID = () => err(400, 100, null, 'Invalid parameter');
const PERMISSION = () => err(403, 200, null, '(#200) Requires ads_read permission');
const OTHER_ACCOUNT = () => err(400, 10, null, '(#10) Application does not have permission for this action');
const RATE = () => err(400, 80004, 2446079, 'too many calls');
const AUTH = () => err(400, 190, null, 'Error validating access token');
const BOOM = () => err(500, 1, null, 'An unknown error occurred');
// a fake metaGet: handlers keyed by id; records every call
const fakeGet = (handlers, calls = []) => async (p, params) => {
  const id = decodeURIComponent(p.slice(1));
  calls.push({ path: p, params });
  const h = handlers[id];
  if (!h) return CANNOT_LOAD();
  return typeof h === 'function' ? h() : h;
};
test.beforeEach(() => guard.reset());

// ── request construction ──────────────────────────────────────────────────────────────────────────
test('no request is built from the removed root `?ids=` pattern, and no deprecated parameter is sent', () => {
  const src = read('metaAds.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /ids:\s*ids\.join/, 'metaGetByIds must not send `ids=`');
  assert.doesNotMatch(src, /metaGet\(\s*['"]\/['"]/, 'no root-level GET /');
  for (const f of ['metaAds.js', 'metaSync.js', 'metaCreativeThumbs.js', 'inspirationMetaLink.js', 'metaAdCreative.js', 'metaInsightsDiagnostics.js', 'metaRangeReach.js', 'metaCampaigns.js', 'metaRequestGuard.js']) {
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

// ── classification: nothing is ever "permanently deleted" because of an error ──────────────────────
test('error classification: an ambiguous refusal is "inaccessible" (unknown cause), never "not found" / deleted', () => {
  const cls = (r) => metaAds.classifyObjectFailure(r);
  assert.equal(cls(CANNOT_LOAD()), 'inaccessible', '100/33 may be a deleted object OR a permission problem OR another account');
  assert.equal(cls(INVALID_ID()), 'inaccessible', 'an invalid id');
  assert.equal(cls(PERMISSION()), 'inaccessible', 'a permission failure for this object');
  assert.equal(cls(OTHER_ACCOUNT()), 'inaccessible', 'an object on another account');
  assert.equal(cls(err(404, null, null)), 'inaccessible');
  assert.equal(cls(AUTH()), 'auth');
  assert.equal(cls(RATE()), 'rate_limited');
  assert.equal(cls(BOOM()), 'error');
  assert.equal(cls({ status: 200, data: 'not json' }), 'error');
  ['not_found', 'deleted', 'permanent'].forEach((w) => assert.doesNotMatch(read('metaAds.js').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''), new RegExp(`kind: '${w}'`)));
});

test('mixed results: successes are preserved and each failure keeps its own kind (confirmed absence is not claimed for any of them)', async () => {
  const data = await metaAds.metaGetByIds(['OK', 'CANNOT', 'INVALID', 'PERM', 'OTHER', 'FLAKY', 'EMPTY'], 'id', {}, { get: fakeGet({ OK: ok200({ id: 'OK' }), CANNOT: CANNOT_LOAD(), INVALID: INVALID_ID(), PERM: PERMISSION(), OTHER: OTHER_ACCOUNT(), FLAKY: BOOM(), EMPTY: ok200({}) }) });
  assert.deepEqual(Object.keys(data), ['OK']);
  const f = data[metaAds.metaGetByIds.FAILURES];
  for (const id of ['CANNOT', 'INVALID', 'PERM', 'OTHER', 'EMPTY']) assert.equal(f[id].kind, 'inaccessible', id);
  assert.equal(f.CANNOT.code, 100); assert.equal(f.CANNOT.subcode, 33);
  assert.equal(f.FLAKY.kind, 'error'); assert.equal(f.FLAKY.status, 500);
  assert.equal(f.OK, undefined);
});

test('a network error on one object is a failed read of that object only, and never carries a token or URL', async () => {
  const get = async (p) => { if (p === '/B') throw new Error('socket hang up https://graph.facebook.com/x?access_token=SECRET'); return ok200({ id: 'A' }); };
  const r = await metaAds.metaGetByIdsDetailed(['A', 'B'], 'id', {}, { get });
  assert.deepEqual(Object.keys(r.data), ['A']);
  assert.equal(r.failures.B.kind, 'error');
  assert.doesNotMatch(r.failures.B.message, /SECRET|graph\.facebook/);
});

test('every id refused: an empty map is returned (not an exception), each reported as unresolved "inaccessible"', async () => {
  const data = await metaAds.metaGetByIds(['X', 'Y'], 'id', {}, { get: fakeGet({}) });
  assert.deepEqual(Object.keys(data), []);
  assert.deepEqual(Object.values(data[metaAds.metaGetByIds.FAILURES]).map((f) => f.kind), ['inaccessible', 'inaccessible']);
});

test('complete failure of reads: when nothing could be read and a read FAILED, it throws and carries the failures', async () => {
  await assert.rejects(metaAds.metaGetByIds(['A', 'B'], 'id', {}, { get: fakeGet({ A: BOOM(), B: BOOM() }) }), (e) => {
    assert.equal(e.name, 'MetaApiError'); assert.equal(e.status, 500); assert.equal(e.rateLimited, false);
    assert.deepEqual(Object.keys(e.failures).sort(), ['A', 'B']);
    return true;
  });
});

test('a systemic failure (no success after 10 attempts, e.g. a token without permission) stops asking instead of sending the rest', async () => {
  const calls = [];
  const ids = Array.from({ length: 60 }, (_, i) => `S${i}`);
  const data = await metaAds.metaGetByIds(ids, 'id', {}, { get: fakeGet({}, calls), concurrency: 1 });
  assert.equal(calls.length, 10, 'stopped after 10 consecutive failures with no success');
  const f = data[metaAds.metaGetByIds.FAILURES];
  assert.equal(Object.values(f).filter((x) => x.kind === 'skipped').length, 50, 'the rest are reported as not asked, not as failed or deleted');
  // a success resets the count: a flaky run is not mistaken for a systemic one
  const calls2 = [];
  const h = {}; ids.forEach((id, i) => { h[id] = i % 5 === 4 ? ok200({ id }) : CANNOT_LOAD(); });
  await metaAds.metaGetByIds(ids, 'id', {}, { get: fakeGet(h, calls2), concurrency: 1 });
  assert.equal(calls2.length, 60);
});

// ── authentication, rate limit, retry, concurrency ────────────────────────────────────────────────
test('rate limit: stops at once, throws a rateLimited MetaApiError, keeps what was read, never retries or asks for the rest, and starts the shared cooldown', async () => {
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
  assert.ok(guard.isCoolingDown(), 'every other Meta caller now waits');
});

test('authentication error: aborts like a rate limit (nothing else would work), is not a missing object, and does not start the rate-limit cooldown', async () => {
  const calls = [];
  await assert.rejects(metaAds.metaGetByIds(['A', 'B', 'C'], 'id', {}, { get: fakeGet({ A: AUTH(), B: ok200({ id: 'B' }), C: ok200({ id: 'C' }) }, calls), concurrency: 1 }), (e) => {
    assert.equal(e.metaCode, 190); assert.equal(e.rateLimited, false);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(guard.isCoolingDown(), false);
});

test('concurrency is bounded (never more than the cap in flight) and a failed object does not retry', async () => {
  let inFlight = 0; let peak = 0; const seen = {};
  const get = async (p) => { seen[p] = (seen[p] || 0) + 1; inFlight += 1; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight -= 1; return p === '/F3' ? BOOM() : ok200({ id: p.slice(1) }); };
  const r = await metaAds.metaGetByIdsDetailed(Array.from({ length: 20 }, (_, i) => `F${i}`), 'id', {}, { get });
  assert.ok(peak <= 4 && peak >= 2, `peak in flight ${peak}`);
  assert.equal(Object.keys(r.data).length, 19); assert.equal(r.failures.F3.kind, 'error');
  assert.equal(seen['/F3'], 1, 'no retry');
});

// ── ad identity lookups and sync completeness ─────────────────────────────────────────────────────
// a fake database for meta_ad_identity_lookups (+ the held-back query)
const fakeDb = (seed = {}) => {
  const rows = new Map(Object.entries(seed)); const log = [];
  return { rows, log, query: async (sql, params) => {
    log.push([sql.replace(/\s+/g, ' ').trim(), params]);
    if (/INSERT INTO meta_ad_identity_lookups/.test(sql)) { const prev = rows.get(params[0]); rows.set(params[0], { state: params[1], attempts: prev ? prev.attempts + 1 : 1, code: params[2], message: params[3], last_attempt_at: Date.now() }); }
    if (/DELETE FROM meta_ad_identity_lookups/.test(sql)) rows.delete(params[0]);
    if (/SELECT meta_ad_id FROM meta_ad_identity_lookups/.test(sql)) return { rows: params[0].filter((id) => rows.has(id) && rows.get(id).attempts >= params[1] && Date.now() - rows.get(id).last_attempt_at < params[2] * 3600000).map((meta_ad_id) => ({ meta_ad_id })) };
    return { rows: [] };
  } };
};
const mkGet = (handlers, calls, o = {}) => (ids, fields, params) => metaAds.metaGetByIds(ids, fields, params, { get: fakeGet(handlers, calls), ...o });

test('missing ad identity lookup: resolved ads are stored through the existing upsert, with the exact AD_FIELDS', async () => {
  const db = fakeDb(); const upserts = []; const calls = [];
  const out = await metaSync.lookupMissingAds(['A1', 'A2'], { db, metaGetByIds: mkGet({ A1: ok200({ id: 'A1', name: 'n1', effective_status: 'ACTIVE', campaign_id: 'c1', adset_id: 's1', creative: { id: 'cr1' }, created_time: '2026-10-01' }), A2: ok200({ id: 'A2', name: 'n2' }) }, calls), upsertAd: async (a) => { upserts.push(a); return true; } });
  assert.deepEqual(out, { requested: 2, resolved: 2, unresolved: 0, inaccessible: 0, failed: 0, deferred: 0, calls: 2, failed_ids: [] });
  assert.deepEqual(upserts[0], { meta_ad_id: 'A1', meta_adset_id: 's1', meta_campaign_id: 'c1', meta_creative_id: 'cr1', ad_name: 'n1', effective_status: 'ACTIVE', created_time: '2026-10-01' });
  assert.equal(calls[0].params.fields, 'id,name,effective_status,campaign_id,adset_id,creative{id},created_time', 'field selection unchanged');
});

test('partial success: resolved ads are kept; a refused ad and a failed read are BOTH recorded as unresolved (never as deleted)', async () => {
  const db = fakeDb(); const upserts = [];
  const out = await metaSync.lookupMissingAds(['OK', 'FLAKY', 'CANNOT', 'PERM'], { db, metaGetByIds: mkGet({ OK: ok200({ id: 'OK', name: 'n' }), FLAKY: BOOM(), CANNOT: CANNOT_LOAD(), PERM: PERMISSION() }), upsertAd: async (a) => { upserts.push(a.meta_ad_id); } });
  assert.deepEqual(upserts, ['OK']);
  assert.equal(out.resolved, 1); assert.equal(out.unresolved, 3); assert.equal(out.failed, 3); assert.equal(out.inaccessible, 2);
  assert.equal(db.rows.get('FLAKY').state, 'error'); assert.equal(db.rows.get('CANNOT').state, 'inaccessible'); assert.equal(db.rows.get('PERM').state, 'inaccessible');
  assert.equal(db.rows.has('OK'), false);
  assert.ok([...db.rows.values()].every((r) => r.state !== 'not_found'), 'no code path records an ad as not found');
});

test('complete batch failure: every ad is recorded as unresolved, nothing is stored, the lookup does not throw (the ads stay shells for the next sync)', async () => {
  const db = fakeDb(); const upserts = [];
  const out = await metaSync.lookupMissingAds(['A', 'B', 'C'], { db, metaGetByIds: mkGet({ A: BOOM(), B: BOOM(), C: BOOM() }), upsertAd: async (a) => { upserts.push(a); } });
  assert.equal(upserts.length, 0); assert.equal(out.failed, 3); assert.equal(out.resolved, 0);
  assert.deepEqual([...db.rows.keys()].sort(), ['A', 'B', 'C']);
});

test('a previously unresolved identity that becomes available is resolved, stored and its record cleared; repeated failures count attempts', async () => {
  const db = fakeDb(); const deps = (h) => ({ db, metaGetByIds: mkGet(h), upsertAd: async () => true, limits: { maxAutoAttempts: 99 } });
  await metaSync.lookupMissingAds(['A'], deps({ A: CANNOT_LOAD() }));
  await metaSync.lookupMissingAds(['A'], deps({ A: CANNOT_LOAD() }));
  assert.equal(db.rows.get('A').attempts, 2); assert.equal(db.rows.get('A').state, 'inaccessible');
  const out = await metaSync.lookupMissingAds(['A'], deps({ A: ok200({ id: 'A', name: 'now visible' }) }));
  assert.equal(out.resolved, 1); assert.equal(db.rows.has('A'), false);
});

test('retries are bounded: after the allowed attempts an ad is not asked on every sync, only after the back-off, and stays visible as unresolved', async () => {
  const db = fakeDb({ STUCK: { state: 'inaccessible', attempts: 3, last_attempt_at: Date.now() - 3600000 }, OLD: { state: 'inaccessible', attempts: 3, last_attempt_at: Date.now() - 48 * 3600000 }, FEW: { state: 'error', attempts: 1, last_attempt_at: Date.now() } });
  const calls = [];
  const out = await metaSync.lookupMissingAds(['STUCK', 'OLD', 'FEW', 'NEW'], { db, metaGetByIds: mkGet({ STUCK: CANNOT_LOAD(), OLD: CANNOT_LOAD(), FEW: CANNOT_LOAD(), NEW: ok200({ id: 'NEW', name: 'n' }) }, calls), upsertAd: async () => true, limits: { maxAutoAttempts: 3, retryHours: 24 } });
  assert.deepEqual(calls.map((c) => c.path).sort(), ['/FEW', '/NEW', '/OLD'], 'STUCK (3 attempts, asked an hour ago) is held back; OLD (48 h ago) and FEW (1 attempt) are asked');
  assert.equal(out.deferred, 1); assert.ok(out.unresolved >= 1);
  assert.equal(metaSync.describeCompleteness(out).completeness, 'partial', 'a held-back ad keeps the run partial: it is unresolved, not resolved');
});

test('a burst of new ads is bounded per sync: the rest are deferred, reported, and nothing is lost', async () => {
  const db = fakeDb(); const calls = [];
  const ids = Array.from({ length: 10 }, (_, i) => `N${i}`); const h = {}; ids.forEach((id) => { h[id] = ok200({ id, name: 'n' }); });
  const out = await metaSync.lookupMissingAds(ids, { db, metaGetByIds: mkGet(h, calls), upsertAd: async () => true, limits: { maxPerSync: 4 } });
  assert.equal(calls.length, 4); assert.equal(out.resolved, 4); assert.equal(out.deferred, 6); assert.equal(out.unresolved, 6);
  assert.match(metaSync.describeCompleteness(out).note, /6 not asked this time/);
});

test('rate limit during the lookup: ads read before the stop are stored, then the sync aborts (rate-limit handling unchanged)', async () => {
  const db = fakeDb(); const upserts = [];
  const handlers = { A: ok200({ id: 'A', name: 'n' }), B: RATE(), C: ok200({ id: 'C', name: 'n' }) };
  await assert.rejects(metaSync.lookupMissingAds(['A', 'B', 'C'], { db, metaGetByIds: (ids, f, p) => metaAds.metaGetByIds(ids, f, p, { get: fakeGet(handlers), concurrency: 1 }), upsertAd: async (a) => { upserts.push(a.meta_ad_id); } }), (e) => e.rateLimited === true);
  assert.deepEqual(upserts, ['A']);
});

test('sync completeness: any unresolved identity makes a run PARTIAL (status is left alone); only a fully resolved run is complete', () => {
  const partial = metaSync.describeCompleteness({ requested: 40, failed: 3, inaccessible: 2, deferred: 1 });
  assert.equal(partial.completeness, 'partial');
  assert.match(partial.note, /4 of 40 ad identities are unresolved/); assert.match(partial.note, /2 refused by Meta \(cause unknown: deleted, no permission or another account\)/);
  assert.match(partial.note, /1 failed to read/); assert.match(partial.note, /1 not asked this time/); assert.match(partial.note, /None is treated as deleted/);
  assert.equal(metaSync.describeCompleteness({ requested: 10, failed: 0, inaccessible: 0, deferred: 0 }).completeness, 'complete');
  const src = read('metaSync.js');
  assert.match(src, /status = 'success', finished_at = now\(\),\s*completeness = \$7/, 'the run is still recorded as success; completeness is recorded beside it');
  assert.match(src, /lookup_inaccessible = \$10, completeness_note = \$11, lookup_deferred = \$12/);
});

test('the schema change is additive and idempotent, and existing runs read as unknown (NULL), not complete', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const add = schema.slice(schema.indexOf('Batch 27 follow-up: sync COMPLETENESS'), schema.indexOf("-- 'inventory' = the explicit full ad-inventory refresh"));
  assert.match(add, /ADD COLUMN IF NOT EXISTS completeness VARCHAR\(10\) CHECK \(completeness IN \('complete', 'partial'\)\);/);
  assert.match(add, /ADD COLUMN IF NOT EXISTS lookup_inaccessible INTEGER;/);
  assert.doesNotMatch(add, /DEFAULT 'complete'/, 'old rows must not be reported as complete');
  assert.doesNotMatch(add, /DROP TABLE|DELETE FROM|TRUNCATE|DROP COLUMN/i);
  assert.match(add, /CREATE TABLE IF NOT EXISTS meta_ad_identity_lookups/);
  assert.match(add, /CHECK \(state IN \('error', 'inaccessible', 'not_found'\)\)/);
  assert.ok(schema.indexOf('meta_ad_identity_lookups') < schema.indexOf('Approved Ad Matching concepts + historical-spelling aliases'), 'before the metaBatch7 marker');
});

// ── shared guard: cooldown, priority, budget, negative cache ──────────────────────────────────────
test('shared cooldown: one rate-limit response stops every lower-priority read until the retry time, with Meta\'s own hint when it gave one', () => {
  const t0 = 1_000_000;
  assert.equal(guard.lowPriorityBlock(t0), null);
  assert.equal(guard.noteRateLimit({ rateLimited: true, retryAfterSeconds: 90 }, t0), true);
  const b = guard.lowPriorityBlock(t0 + 10_000);
  assert.equal(b.reason, 'cooldown'); assert.equal(b.seconds, 80);
  assert.equal(guard.lowPriorityBlock(t0 + 91_000), null, 'resumes afterwards');
  guard.reset(); guard.noteRateLimit({ rateLimited: true }, t0);
  assert.equal(guard.cooldownSecondsLeft(t0), guard.DEFAULT_COOLDOWN_SECONDS, 'no hint: the default cooldown');
  assert.equal(guard.noteRateLimit({ rateLimited: false }, t0), false, 'only a rate-limit error starts it');
});

test('priority: while a reporting sync runs, lower-priority reads do not call Meta; the sync itself is never blocked by them', async () => {
  assert.equal(guard.lowPriorityBlock(), null);
  let seen;
  await metaSync.__withPriority(async () => { seen = guard.lowPriorityBlock(); });
  assert.equal(seen.reason, 'sync');
  assert.equal(guard.lowPriorityBlock(), null, 'released afterwards, even when the job throws');
  await assert.rejects(metaSync.__withPriority(async () => { throw new Error('boom'); }));
  assert.equal(guard.priorityActive(), false);
  const src = read('metaSync.js');
  assert.match(src, /const runSync = \(args\) => withPriority\(\(\) => runSyncUnguarded\(args\)\)/);
  assert.match(src, /const refreshInventory = \(args\) => withPriority/);
});

test('reporting sync continues after the cooldown: the sync refuses to start only while Meta asked to wait, then runs; lookups are never starved', () => {
  const t0 = 5_000_000;
  guard.noteRateLimit({ rateLimited: true, retryAfterSeconds: 60 }, t0);
  assert.equal(guard.isCoolingDown(t0 + 30_000), true);
  assert.equal(guard.isCoolingDown(t0 + 61_000), false, 'cooldown over: the next sync starts normally');
  assert.match(read('metaSync.js'), /function assertNotRateLimited\(\) \{\s*const remaining = guard\.cooldownSecondsLeft\(\);/);
});

test('lower-priority lookups have a per-minute budget, so a burst of page views is bounded', () => {
  const t0 = 9_000_000;
  assert.equal(guard.takeBudget(100, t0, 120), 100);
  assert.equal(guard.takeBudget(100, t0 + 1000, 120), 20, 'only what is left in this minute');
  assert.equal(guard.takeBudget(10, t0 + 2000, 120), 0);
  assert.equal(guard.takeBudget(100, t0 + 61_000, 120), 100, 'a new minute');
});

test('a failure that keeps happening backs off further each time (1 min, 5, 15, 60) and a success starts it again from the first step', () => {
  let t = 3_000_000;
  const steps = [];
  for (let i = 0; i < 5; i += 1) { guard.negativeSet('thumb', 'CX', 'error', t); const e = guard.negativeGet('thumb', 'CX', t); steps.push((e.until - t) / 60000); t = e.until + 1000; }
  assert.deepEqual(steps, [1, 5, 15, 60, 60]);
  guard.negativeClear('thumb', 'CX'); guard.negativeSet('thumb', 'CX', 'error', t);
  assert.equal((guard.negativeGet('thumb', 'CX', t).until - t) / 60000, 1);
  // at most one request per creative per step: 100 persistently failing creatives cost 100 + 100 + 100 + 100 requests in the first hour at the very worst, not 100 per page view
});

test('negative cache: a failed read is not repeated straight away, is short-lived, per kind, and is memory only (never stored as "unavailable")', () => {
  const t0 = 2_000_000;
  guard.negativeSet('thumb', 'C1', 'error', t0); guard.negativeSet('thumb', 'C2', 'inaccessible', t0);
  assert.ok(guard.negativeGet('thumb', 'C1', t0 + 30_000)); assert.equal(guard.negativeGet('thumb', 'C1', t0 + 61_000), null, 'a transient failure: one minute');
  assert.ok(guard.negativeGet('thumb', 'C2', t0 + 9 * 60_000)); assert.equal(guard.negativeGet('thumb', 'C2', t0 + 11 * 60_000), null, 'a refusal: ten minutes at first');
  assert.equal(guard.negativeGet('share', 'C1', t0), null, 'per kind of lookup');
  assert.doesNotMatch(read('metaRequestGuard.js'), /INSERT|UPDATE|pool\.|require\('\.\/db'\)/);
});

// ── thumbnails and share links ────────────────────────────────────────────────────────────────────
const thumbDb = (cachedRows = []) => {
  const written = [];
  return { written, query: async (sql, params) => {
    if (/INSERT INTO meta_creative_thumbs/.test(sql)) { written.push(params); return { rows: [] }; }
    if (/FROM meta_ads/.test(sql)) return { rows: [{ meta_ad_id: 'A1', meta_creative_id: 'C1' }, { meta_ad_id: 'A2', meta_creative_id: 'C2' }, { meta_ad_id: 'A3', meta_creative_id: 'C3' }].filter((r) => (params[0] || []).includes(r.meta_ad_id)) };
    return { rows: /FROM meta_creative_thumbs/.test(sql) ? cachedRows : [] };
  } };
};
const thumbDeps = (db, handlers, calls) => ({ db, configured: () => true, autoEnabled: () => true, metaGetByIds: (ids, f, p) => metaAds.metaGetByIds(ids, f, p, { get: fakeGet(handlers, calls) }) });
const cover = (id) => ok200({ id, object_type: 'SHARE', thumbnail_url: `https://scontent.xx.fbcdn.net/v/${id}.jpg?oe=7FFFFFFF`, video_id: null });
const NOW = Date.parse('2026-10-13T00:00:00Z');

test('normal thumbnail retrieval: covers are stored and returned; one read per uncached creative', async () => {
  const db = thumbDb(); const calls = [];
  const out = await thumbs.getThumbs(['A1', 'A2'], { now: NOW }, thumbDeps(db, { C1: cover('C1'), C2: cover('C2') }, calls));
  assert.equal(out.thumbs.A1.state, 'ok'); assert.match(out.thumbs.A1.thumb_url, /C1\.jpg/);
  assert.deepEqual(db.written.map((w) => w[0]).sort(), ['C1', 'C2']);
  assert.equal(calls.length, 2); assert.equal(out.stats.meta_calls, 2);
});

test('failed thumbnail retrieval: a refused or failed read is never stored as "unavailable" (memory only), the refused one shows the neutral placeholder, the failed one stays pending', async () => {
  const db = thumbDb();
  const out = await thumbs.getThumbs(['A1', 'A2', 'A3'], { now: NOW }, thumbDeps(db, { C1: cover('C1'), C2: CANNOT_LOAD(), C3: BOOM() }));
  assert.equal(out.thumbs.A1.state, 'ok');
  assert.equal(out.thumbs.A2.state, 'unavailable', 'refused: placeholder for a few minutes only');
  assert.equal(out.thumbs.A3.state, 'pending', 'failed read: unknown, asked again later');
  assert.deepEqual(db.written.map((w) => w[0]), ['C1'], 'nothing is written to the database for the refused or failed creatives');
});

test('repeated page loads do not repeat failed lookups: a persistent failure is asked once, then not again until its short negative cache expires', async () => {
  const calls = [];
  const deps = (db) => thumbDeps(db, { C1: cover('C1'), C2: CANNOT_LOAD(), C3: BOOM() }, calls);
  await thumbs.getThumbs(['A1', 'A2', 'A3'], { now: NOW }, deps(thumbDb()));
  const first = calls.length;
  await thumbs.getThumbs(['A1', 'A2', 'A3'], { now: NOW }, deps(thumbDb()));
  await thumbs.getThumbs(['A1', 'A2', 'A3'], { now: NOW }, deps(thumbDb()));
  assert.equal(first, 3);
  assert.equal(calls.length, 5, 'two more page loads: only C1 (this fake never caches its cover) is asked again each time; C2 and C3, which failed, are not');
  assert.ok(calls.slice(3).every((c) => c.path === '/C1'));
});

test('large thumbnails: same rules, and the larger size is requested', async () => {
  const seen = [];
  const db = thumbDb(); const handlers = { C1: cover('C1'), C2: cover('C2'), C3: BOOM() };
  const out = await thumbs.getLargeThumbs(['A1', 'A3'], { now: NOW }, { ...thumbDeps(db, handlers), metaGetByIds: (ids, f, p) => { seen.push(p); return metaAds.metaGetByIds(ids, f, p, { get: fakeGet(handlers) }); } });
  assert.deepEqual(seen[0], thumbs.LARGE_PARAMS);
  assert.equal(out.thumbs.A1.state, 'ok'); assert.equal(out.thumbs.A3.state, 'pending');
  assert.ok(!db.written.some((w) => w[0] === 'C3'));
});

test('thumbnail rate limit: stops at once, reports it, the shared cooldown starts, and the next page view does not call Meta at all until it passes', async () => {
  const calls = [];
  const handlers = { C1: RATE(), C2: cover('C2'), C3: cover('C3') };
  const out = await thumbs.getThumbs(['A1', 'A2', 'A3'], { now: NOW }, thumbDeps(thumbDb(), handlers, calls));
  assert.equal(out.stats.rate_limited, true); assert.ok(guard.isCoolingDown());
  const before = calls.length;
  const next = await thumbs.getThumbs(['A1', 'A2', 'A3'], { now: NOW }, thumbDeps(thumbDb(), handlers, calls));
  assert.equal(calls.length, before, 'no request while Meta asked us to wait');
  assert.match(next.stats.paused, /Meta asked us to wait/); assert.equal(next.thumbs.A1.state, 'pending');
});

test('thumbnail authentication failure: nothing else is asked, nothing is cached as unavailable, and no rate-limit cooldown is started', async () => {
  const calls = [];
  const db = thumbDb();
  const out = await thumbs.getThumbs(['A1', 'A2', 'A3'], { now: NOW }, { ...thumbDeps(db, { C1: AUTH(), C2: cover('C2'), C3: cover('C3') }, calls), metaGetByIds: (ids, f, p) => metaAds.metaGetByIds(ids, f, p, { get: fakeGet({ C1: AUTH(), C2: cover('C2'), C3: cover('C3') }, calls), concurrency: 1 }) });
  assert.equal(db.written.length, 0); assert.equal(guard.isCoolingDown(), false);
  assert.equal(calls.length, 1); assert.equal(out.thumbs.A1.state, 'pending');
});

test('thumbnails do not call Meta while a sync runs; covers already cached are still served', async () => {
  const calls = [];
  const out = await metaSync.__withPriority(() => thumbs.getThumbs(['A1', 'A2'], { now: NOW }, thumbDeps(thumbDb(), { C1: cover('C1'), C2: cover('C2') }, calls)));
  assert.equal(calls.length, 0); assert.match(out.stats.paused, /sync is running/);
  const after = await thumbs.getThumbs(['A1', 'A2'], { now: NOW }, thumbDeps(thumbDb(), { C1: cover('C1'), C2: cover('C2') }, calls));
  assert.equal(calls.length, 2); assert.equal(after.thumbs.A1.state, 'ok');
});

test('thumbnail partial results under the per-minute budget: the covers within budget load, the rest are "pending" with the reason, nothing is lost', async () => {
  const handlers = {}; const calls = [];
  const rows = Array.from({ length: 5 }, (_, i) => ({ meta_ad_id: `A${i}`, meta_creative_id: `C${i}` }));
  rows.forEach((r) => { handlers[r.meta_creative_id] = cover(r.meta_creative_id); });
  const db = { written: [], query: async (sql, params) => { if (/INSERT INTO meta_creative_thumbs/.test(sql)) { db.written.push(params[0]); return { rows: [] }; } return { rows: /FROM meta_ads/.test(sql) ? rows : [] }; } };
  process.env.META_LOW_PRIORITY_LOOKUPS_PER_MINUTE = '3';
  try {
    const out = await thumbs.getThumbs(rows.map((r) => r.meta_ad_id), { now: NOW }, thumbDeps(db, handlers, calls));
    assert.equal(calls.length, 3); assert.equal(Object.values(out.thumbs).filter((t) => t.state === 'ok').length, 3);
    assert.equal(Object.values(out.thumbs).filter((t) => t.state === 'pending').length, 2);
    assert.match(out.stats.paused, /limited to a fixed number a minute/);
  } finally { delete process.env.META_LOW_PRIORITY_LOOKUPS_PER_MINUTE; }
});

test('share links: stored when present; a refused ad is NOT recorded as "without a link"; failed reads are counted separately and not repeated straight away', async () => {
  const stored = []; const calls = [];
  const db = { query: async (sql, params) => {
    if (/INSERT INTO meta_ad_share_links/.test(sql)) { stored.push(params); return { rows: [] }; }
    return { rows: [{ meta_ad_id: 'A1' }, { meta_ad_id: 'A2' }, { meta_ad_id: 'A3' }, { meta_ad_id: 'A4' }] };
  } };
  const handlers = { A1: ok200({ id: 'A1', preview_shareable_link: 'https://fb.me/e/x' }), A2: CANNOT_LOAD(), A3: BOOM(), A4: ok200({ id: 'A4' }) };
  const deps = { db, configured: () => true, metaGetByIds: (ids, f, p) => metaAds.metaGetByIds(ids, f, p, { get: fakeGet(handlers, calls) }) };
  const out = await inspMeta.lookupShareLinks({ limit: 10 }, deps);
  assert.deepEqual(stored.map((s) => s[0]), ['A1']);
  assert.equal(out.stored, 1); assert.equal(out.without_link, 1, 'only A4: Meta answered, it simply has no link'); assert.equal(out.failed, 2); assert.equal(out.asked, 2); assert.equal(out.calls, 4);
  const again = await inspMeta.lookupShareLinks({ limit: 10 }, deps);
  assert.equal(again.calls, 2, 'the two failed reads are not asked again straight away (A1/A4 are asked because this fake stores nothing)');
});

test('share links: a rate limit stops the press, starts the shared cooldown, and a second press while it lasts calls nothing', async () => {
  const calls = [];
  const db = { query: async () => ({ rows: [{ meta_ad_id: 'A1' }, { meta_ad_id: 'A2' }] }) };
  const deps = { db, configured: () => true, metaGetByIds: (ids, f, p) => metaAds.metaGetByIds(ids, f, p, { get: fakeGet({ A1: RATE(), A2: ok200({ id: 'A2' }) }, calls), concurrency: 1 }) };
  const out = await inspMeta.lookupShareLinks({}, deps);
  assert.equal(out.rate_limited, true);
  const n = calls.length;
  const second = await inspMeta.lookupShareLinks({}, deps);
  assert.equal(calls.length, n); assert.match(second.paused, /Meta asked us to wait/);
});

test('share links: not run while a sync is running (the reporting sync has priority); default press is bounded at 200', async () => {
  const calls = [];
  const db = { query: async () => ({ rows: [{ meta_ad_id: 'A1' }] }) };
  const deps = { db, configured: () => true, metaGetByIds: (ids, f, p) => metaAds.metaGetByIds(ids, f, p, { get: fakeGet({ A1: ok200({ id: 'A1' }) }, calls) }) };
  const out = await metaSync.__withPriority(() => inspMeta.lookupShareLinks({}, deps));
  assert.equal(calls.length, 0); assert.match(out.paused, /sync is running/);
  assert.match(read('inspirationMetaLink.js'), /async function lookupShareLinks\(\{ limit = 200 \}/);
});

test('existing matching behaviour is untouched: matches, confirmations and classifications are never written by the lookup path', () => {
  const src = read('metaSync.js');
  const lookup = src.slice(src.indexOf('async function lookupMissingAds'), src.indexOf('async function fetchAndUpsertInsights'));
  assert.doesNotMatch(lookup, /match_status|meta_ad_products|meta_ad_classifications|meta_ad_suggestions/);
  assert.doesNotMatch(lookup, /DELETE FROM meta_ads|UPDATE meta_ads/);
  assert.match(lookup, /DELETE FROM meta_ad_identity_lookups WHERE meta_ad_id = \$1/, 'only the bookkeeping row is removed');
});
