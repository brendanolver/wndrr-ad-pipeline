// Pure (no database, no Meta) tests for the UX batch: campaign funnel parsing, freshness policy + refresh gating,
// thumbnails summary, Inspiration deterministic linking, and static guards on the new modules.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused'; // pool is lazy; never connected here
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const funnel = require('../src/lib/metaCampaignFunnel');
const policy = require('../src/lib/metaFreshnessPolicy');
const thumbs = require('../src/lib/metaCreativeThumbs');
const insp = require('../src/lib/inspirationMetaLink');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const code = (f) => read(f).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ── campaign funnel ───────────────────────────────────────────────
test('funnel: literal TOF / TOM / MOF tokens only', () => {
  assert.equal(funnel.classify('WNDRR | TOF | Prospecting').funnel, 'TOF');
  assert.equal(funnel.classify('wndrr_tom_retarget').funnel, 'TOM');
  assert.equal(funnel.classify('MOF-sale').funnel, 'MOF');
});
test('funnel: numbered / unrecognised structures stay unknown (never invented)', () => {
  for (const n of ['028', 'CAMPAIGN 081', 'Scale 028 - Sale', 'tofu campaign', 'BOF 12', 'Prospecting', '', null, undefined]) {
    assert.equal(funnel.classify(n).funnel, 'unknown', String(n));
  }
  assert.deepEqual(funnel.classify('Scale 028 - Sale').numeric_tokens, ['028']); // surfaced for later mapping, not interpreted
});
test('funnel: more than one literal token is "multiple", not a guess', () => {
  assert.equal(funnel.classify('TOF+MOF test').funnel, 'multiple');
});
test('funnel: census reports patterns without mapping numbers', () => {
  const c = funnel.census([{ name: 'A TOF' }, { name: 'B 028' }, { name: 'C 028' }, { name: 'D 081' }]);
  assert.equal(c.by_funnel.TOF, 1);
  assert.equal(c.by_funnel.unknown, 3);
  assert.equal(c.numeric_tokens[0].token, '028');
  assert.equal(c.numeric_tokens[0].campaigns, 2);
});

// ── freshness policy ──────────────────────────────────────────────
const TODAY = '2026-10-07';
test('policy: today refreshes often, recently ended less often, old periods never automatically (additive)', () => {
  assert.equal(policy.additiveTtlMs({ since: '2026-10-01', until: '2026-10-07' }, TODAY), 15 * 60 * 1000);
  assert.equal(policy.additiveTtlMs({ since: '2026-10-01', until: '2026-10-05' }, TODAY), 3 * 3600 * 1000);
  assert.equal(policy.additiveTtlMs({ since: '2026-08-01', until: '2026-08-31' }, TODAY), null);
});
test('policy: exact reach has its own, longer, ttls', () => {
  assert.equal(policy.reachTtlMs({ since: '2026-10-07', until: '2026-10-07' }, TODAY), 30 * 60 * 1000);
  assert.equal(policy.reachTtlMs({ since: '2026-10-01', until: '2026-10-05' }, TODAY), 6 * 3600 * 1000);
  assert.equal(policy.reachTtlMs({ since: '2026-08-01', until: '2026-08-31' }, TODAY), 7 * 24 * 3600 * 1000);
});
test('policy: an automatic refresh never reaches back further than 7 days (no backfill)', () => {
  assert.deepEqual(policy.refreshableWindow({ since: '2026-01-01', until: '2026-10-07' }, TODAY), { since: '2026-10-01', until: '2026-10-07' });
  assert.equal(policy.refreshableWindow({ since: '2026-08-01', until: '2026-08-31' }, TODAY), null);
  assert.deepEqual(policy.refreshableWindow({ since: '2026-10-05', until: '2026-10-20' }, TODAY), { since: '2026-10-05', until: '2026-10-07' });
});

// ── refresh orchestration with injected deps (no DB / Meta) ───────────────────
process.env.META_AD_ACCOUNT_ID = '999'; process.env.META_ACCESS_TOKEN = 'x';
const freshness = require('../src/lib/metaFreshness');
function harness(over = {}) {
  const calls = { sync: [], pull: [], camp: 0 };
  const db = { query: async (sql) => (/meta_campaigns/.test(sql) ? { rows: [{ at: null, n: 0 }] } : { rows: [] }) };
  const deps = {
    now: Date.parse('2026-10-07T03:00:00Z'), db, wait: true, configured: () => true, autoEnabled: () => true,
    runSync: async (a) => { calls.sync.push(a); return {}; },
    startPull: async (r) => { calls.pull.push(r); return {}; },
    refreshCampaigns: async () => { calls.camp += 1; return {}; },
    ...over,
  };
  return { calls, deps };
}
const RANGE = { since: '2026-10-01', until: '2026-10-07' };
test('refresh: META_AUTO_SYNC off blocks automatic (page-triggered) refreshes entirely', async () => {
  freshness.resetForTests();
  const h = harness({ autoEnabled: () => false });
  const r = await freshness.startRefresh(RANGE, { auto: true }, h.deps).catch((e) => ({ err: e }));
  assert.equal(r.auto_enabled, false);
  assert.deepEqual(r.started, []);
  assert.equal(h.calls.sync.length + h.calls.pull.length + h.calls.camp, 0);
});
test('refresh: the manual (force) button still works with the switch off', async () => {
  freshness.resetForTests();
  const h = harness({ autoEnabled: () => false });
  const r = await freshness.startRefresh(RANGE, { force: true }, h.deps);
  assert.ok(r.started.includes('additive'));
  assert.equal(h.calls.sync.length, 1);
  assert.deepEqual(h.calls.sync[0], { since: '2026-10-01', until: '2026-10-07', runType: 'default', userId: null });
});
test('refresh: duplicate requests do not make duplicate Meta calls', async () => {
  freshness.resetForTests();
  const h = harness({ wait: false });
  let release; const gate = new Promise((res) => { release = res; });
  h.deps.runSync = async (a) => { h.calls.sync.push(a); await gate; return {}; };
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => freshness.startRefresh(RANGE, { auto: true }, h.deps)));
  release();
  assert.equal(h.calls.sync.length, 1);
  assert.equal([a, b, c].filter((x) => x.started.includes('additive')).length, 1);
  // and a prompt second attempt after it finished is throttled too
  await new Promise((res) => setTimeout(res, 20));
  const d = await freshness.startRefresh(RANGE, { auto: true }, h.deps);
  assert.ok(!d.started.includes('additive'));
  assert.equal(h.calls.sync.length, 1);
});
test('refresh: old periods are not automatically refreshed (no backfill) but range reach still is, range-level', async () => {
  freshness.resetForTests();
  const h = harness();
  const old = { since: '2026-08-01', until: '2026-08-31' };
  const r = await freshness.startRefresh(old, { auto: true }, h.deps);
  assert.ok(!r.started.includes('additive'));
  assert.equal(h.calls.sync.length, 0);
  assert.equal(h.calls.pull.length, 1);
  assert.deepEqual(h.calls.pull[0], old); // the exact range -- never daily rows
});
test('refresh: a sync failure is tolerated and backs off', async () => {
  freshness.resetForTests();
  const h = harness();
  h.deps.runSync = async () => { throw new Error('boom'); };
  await freshness.startRefresh(RANGE, { auto: true }, h.deps).catch(() => {});
  const again = await freshness.startRefresh(RANGE, { auto: true }, h.deps);
  assert.ok(!again.started.includes('additive'));
});

// ── thumbnails ────────────────────────────────────────────────────
test('thumbs: summarise never guesses a kind or a picture', () => {
  assert.equal(thumbs.summarise(null).thumb_url, null);
  assert.equal(thumbs.summarise({ thumbnail_url: 'https://cdn.example/x.jpg' }).kind, 'image');
  assert.equal(thumbs.summarise({ video_id: '1', thumbnail_url: 'https://cdn.example/x.jpg' }).kind, 'video');
  assert.equal(thumbs.summarise({ object_story_spec: { link_data: { child_attachments: [{ picture: 'https://cdn.example/a.jpg' }, { picture: 'https://cdn.example/b.jpg' }] } } }).kind, 'carousel');
  assert.equal(thumbs.summarise({ thumbnail_url: 'javascript:alert(1)' }).thumb_url, null);
  assert.equal(thumbs.summarise({ thumbnail_url: 'https://evil.example/x.jpg' }).thumb_url, null); // only Meta/Instagram CDN hosts
  assert.ok(thumbs.summarise({ thumbnail_url: 'https://scontent.fbcdn.net/x.jpg' }).thumb_url);
  assert.equal(thumbs.BATCH, 50);
});

// ── Inspiration: deterministic only ───────────────────────────────
const ADS = new Set(['111111', '222222']);
const idx = new Map([['https://fb.me/adspreview/facebook/AAA', new Set(['111111'])], ['https://fb.me/adspreview/facebook/DUP', new Set(['111111', '222222'])]]);
test('inspiration: exact share link or explicit ad_id only', () => {
  const rows = [
    { id: 1, title: 'x', video_url: 'https://fb.me/adspreview/facebook/AAA' },
    { id: 2, title: 'y', video_url: 'https://www.facebook.com/ads/library/?ad_id=222222' },
    { id: 3, title: 'z', video_url: '' },
    { id: 4, title: 'w', video_url: 'https://fb.me/adspreview/facebook/UNKNOWN' },
    { id: 5, title: 'v', video_url: 'https://fb.me/adspreview/facebook/DUP' },
    { id: 6, title: 'u', video_url: 'https://youtube.com/watch?v=1' },
    { id: 7, title: 'already', video_url: 'https://fb.me/adspreview/facebook/AAA', meta_ad_id: '222222' },
  ];
  const out = Object.fromEntries(insp.classifyAll(rows, idx, ADS).map((c) => [c.id, c]));
  assert.equal(out[1].state, 'recoverable'); assert.equal(out[1].candidate_ad_id, '111111'); assert.equal(out[1].basis, 'share_link_exact');
  assert.equal(out[2].state, 'recoverable'); assert.equal(out[2].basis, 'ad_id_in_url');
  assert.equal(out[3].state, 'no_url');
  assert.equal(out[4].state, 'meta_link_not_yet_matched');
  assert.equal(out[5].state, 'ambiguous');
  assert.equal(out[6].state, 'other_link');
  assert.equal(out[7].state, 'linked'); // never re-pointed
});
test('inspiration: a title identical to an ad name never links anything (no name matching)', () => {
  const out = insp.classifyAll([{ id: 1, title: 'Linen Shirt Try-on', video_url: '' }], idx, ADS)[0];
  assert.equal(out.state, 'no_url');
  assert.doesNotMatch(code('src/lib/inspirationMetaLink.js'), /ILIKE|similarity|jaccard|levenshtein|ad_name/i);
});

// ── static guards ───────────────────────────────────────────────
test('new modules never write to Meta (GET only) and never touch ApparelMagic', () => {
  for (const f of ['metaCreativeThumbs', 'metaCampaigns', 'metaFreshness', 'inspirationMetaLink', 'metaCampaignFunnel', 'metaCreativeConflict']) {
    const src = code(`src/lib/${f}.js`);
    assert.doesNotMatch(src, /method:\s*['"](POST|PUT|DELETE|PATCH)['"]|metaPost|apparelmagic/i, f);
  }
});
test('page-triggered refresh is gated by the same switch as the scheduler', () => {
  const src = code('src/lib/metaFreshness.js');
  assert.match(src, /autoSync\.enabled\(\)/);
  assert.match(src, /auto && !force && !autoEnabled\(deps\)/);
  assert.doesNotMatch(src, /metaAutoSync'\)\.(start|schedule)|setInterval|backfill\(/);
});
test('conflict resolution is its own module; automatic inheritance still cannot confirm or read names', () => {
  assert.match(code('src/lib/metaCreativeConflict.js'), /resolveConflict/);
  assert.doesNotMatch(code('src/lib/metaCreativeIdentity.js'), /resolveConflict|getConflictDetail/);
  const r = code('src/routes/metaAdMatching.js');
  assert.match(r, /conflicts\/:creativeId\/resolve/);
});
test('the matching rules version and rules module are untouched by this batch', () => {
  const m = read('src/lib/metaAdMatching.js');
  assert.match(m, /const BASE_RULES_VERSION = 3;/);
});
