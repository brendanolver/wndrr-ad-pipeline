// Pure (no database, no Meta) tests for batch 3: funnel health stays inactive, unique-creative activity, the Pre-2026 archive
// rule + proof of coverage, ApparelMagic front/back pictures, preview fetch economy, and static guards.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused'; // pool is lazy; never connected here
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const health = require('../src/lib/metaFunnelHealth');
const archive = require('../src/lib/metaCreativeArchive');
const activity = require('../src/lib/metaCreativeActivity');
const plan = require('../src/lib/coreCreativePlan');
const am = require('../src/lib/apparelmagic');
const creative = require('../src/lib/metaAdCreative');
const pullLib = require('../src/lib/metaActivityPull');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const code = (f) => read(f).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ── funnel health: prepared, inactive, never guessed ──────────────────
test('health: inactive by default -- no colour for any funnel, any number', () => {
  assert.equal(health.ENABLED, false);
  for (const f of ['TOF', 'TOM', 'MOF', 'unknown', 'multiple', null]) {
    for (const m of ['cpa', 'frequency']) assert.equal(health.classify(f, m, 12.5), null, `${f}/${m}`);
  }
  assert.equal(health.status().active, false);
});
test('health: NO thresholds are guessed -- every shipped target is null', () => {
  for (const f of health.JUDGED_FUNNELS) for (const m of ['cpa', 'frequency']) assert.equal(health.TARGETS[f][m], null, `${f}/${m}`);
  assert.equal(health.status().defined.TOF.cpa, false);
});
test('health: once enabled with supplied targets it classifies; Unknown / Mixed are never judged; bad targets are ignored', () => {
  const targets = { TOF: { cpa: { green: [null, 20], orange: [null, 30] }, frequency: { green: [1, 2], orange: [0.5, 3] } }, TOM: { cpa: null, frequency: null }, MOF: { cpa: { green: [null, 10], orange: [null, 15] }, frequency: null } };
  const on = { targets, enabled: true };
  assert.equal(health.classify('TOF', 'cpa', 18, on), 'green');
  assert.equal(health.classify('TOF', 'cpa', 25, on), 'orange');
  assert.equal(health.classify('TOF', 'cpa', 40, on), 'red');
  assert.equal(health.classify('TOF', 'frequency', 1.5, on), 'green');
  assert.equal(health.classify('TOF', 'frequency', 2.5, on), 'orange');
  assert.equal(health.classify('TOF', 'frequency', 4, on), 'red');
  assert.equal(health.classify('MOF', 'cpa', 12, on), 'orange'); // funnels differ
  assert.equal(health.classify('TOM', 'cpa', 5, on), null); // no target for this funnel yet -> uncoloured on its own
  assert.equal(health.classify('unknown', 'cpa', 5, on), null);
  assert.equal(health.classify('multiple', 'cpa', 5, on), null);
  assert.equal(health.classify('TOF', 'cpa', null, on), null);
  assert.equal(health.classify('TOF', 'cpa', 18, { targets: { TOF: { cpa: { green: [30, 40], orange: [35, 45] } } }, enabled: true }), null); // orange must contain green
  assert.equal(health.classify('TOF', 'cpa', 18, { targets, enabled: false }), null);
});

// ── unique creative activity ──────────────────────────────────────────
const TODAY = '2026-10-07';
const adRow = (id, creativeKey, o = {}) => ({ ad: { id, creative_key: creativeKey, created: o.created || '2026-08-01', effective_status: o.status || 'ACTIVE', w: { m: { spend: o.spend ?? 10 } }, ...o.extra } });
const act = (o) => ({ ads_total: 5, ads_active_status: 5, ads_delivering: 5, ads_new_active: 0, first_created: '2026-06-01', last_delivery: '2026-10-05', ...o });

test('activity: the same creative duplicated into 5 ads counts as ONE active creative; ads may exceed creatives', () => {
  const ps = { code: 'P', entries: ['a1', 'a2', 'a3', 'a4', 'a5'].map((i) => adRow(i, 'CR1')) };
  const facts = plan.creativeFacts(ps, TODAY, null, { byCreative: new Map([['CR1', act({})]]), insights_last_day: '2026-10-06' });
  assert.equal(facts.active_unique_creatives, 1);
  assert.equal(facts.running_creatives, 1);
  assert.equal(facts.active_ads, 5);
  assert.ok(facts.active_ads > facts.active_unique_creatives);
  assert.equal(facts.creatives_total, 1);
});
test('activity: one creative running in several funnels/campaigns is still ONE creative (funnel plays no part)', () => {
  const ps = { code: 'P', entries: [adRow('a1', 'CR1', { extra: { campaign: 'TOF' } }), adRow('a2', 'CR1', { extra: { campaign: 'MOF' } }), adRow('a3', 'CR2')] };
  const facts = plan.creativeFacts(ps, TODAY, null, { byCreative: new Map([['CR1', act({ ads_total: 2, ads_delivering: 2 })], ['CR2', act({ ads_total: 1, ads_delivering: 1 })]]), insights_last_day: '2026-10-06' });
  assert.equal(facts.active_unique_creatives, 2);
  assert.equal(facts.active_ads, 3);
});
test('activity: a creative counts as active through an UNCLASSIFIED duplicate (exact creative id, any ad)', () => {
  // the only included ad is paused with no spend; an unclassified copy of the same creative is delivering
  const ps = { code: 'P', entries: [adRow('a1', 'CR1', { status: 'PAUSED', spend: 0 })] };
  const facts = plan.creativeFacts(ps, TODAY, null, { byCreative: new Map([['CR1', act({ ads_total: 2, ads_active_status: 1, ads_delivering: 1 })]]), insights_last_day: '2026-10-06' });
  assert.equal(facts.active_unique_creatives, 1);
  assert.equal(facts.active_ads, 1);
});
test('activity: a creative with no delivery in the window is historical, not active', () => {
  const ps = { code: 'P', entries: [adRow('a1', 'CR1'), adRow('a2', 'CR2')] };
  const facts = plan.creativeFacts(ps, TODAY, null, { byCreative: new Map([['CR1', act({ ads_delivering: 0, ads_active_status: 1, ads_new_active: 0, last_delivery: '2026-05-01' })], ['CR2', act({})]]), insights_last_day: '2026-10-06' });
  assert.equal(facts.active_unique_creatives, 1);
  assert.equal(facts.historical_unique_creatives, 1);
});
test('activity: stale stored Insights fall back to status and SAY so (status_only)', () => {
  const v = activity.verdict(act({ ads_active_status: 2, ads_delivering: 0 }), { today: TODAY, insights_last_day: '2026-09-01' });
  assert.deepEqual([v.active, v.basis], [true, 'status_only']);
  const fresh = activity.verdict(act({ ads_active_status: 2, ads_delivering: 0, ads_new_active: 0 }), { today: TODAY, insights_last_day: '2026-10-06' });
  assert.equal(fresh.active, false);
  const brandNew = activity.verdict(act({ ads_delivering: 0, ads_new_active: 1 }), { today: TODAY, insights_last_day: '2026-10-06' });
  assert.deepEqual([brandNew.active, brandNew.basis], [true, 'new_active_ad']);
});
test('last new creative: unique-creative level, earliest creation across EVERY ad of the exact creative', () => {
  // the included copy was created in August but the original (not included / other family) was created in March
  const ps = { code: 'P', entries: [adRow('copy', 'CR1', { created: '2026-08-20' }), adRow('other', 'CR2', { created: '2026-05-10' })] };
  const facts = plan.creativeFacts(ps, TODAY, null, { byCreative: new Map([['CR1', act({ first_created: '2026-03-02' })], ['CR2', act({ first_created: '2026-05-10' })]]), insights_last_day: '2026-10-06' });
  assert.equal(facts.last_new_creative.date, '2026-05-10', 'the duplicate does not make the creative look new');
  assert.match(facts.last_new_creative.source, /Earliest Meta ad created/);
});
test('last new creative: an old creative keeps the older-history warning', () => {
  const ps = { code: 'P', entries: [adRow('a', 'CR1', { created: '2025-01-01' })] };
  const facts = plan.creativeFacts(ps, TODAY, null, { byCreative: new Map([['CR1', act({ first_created: '2025-01-01', ads_delivering: 0, ads_active_status: 0 })]]), insights_last_day: '2026-10-06' });
  assert.equal(facts.recency_basis, 'older_than_window');
});
test('activity: an ad with no creative id can only count as itself and is reported as unidentified', () => {
  const ps = { code: 'P', entries: [adRow('lonely', 'lonely')] };
  const facts = plan.creativeFacts(ps, TODAY, null, { byCreative: new Map(), insights_last_day: '2026-10-06' });
  assert.equal(facts.unidentified_creatives, 1);
});
test('planning: the shoot recommendation is driven by active UNIQUE creatives, not ads', () => {
  const src = code('src/lib/coreCreativePlan.js');
  assert.match(src, /facts\.active_unique_creatives >= cfg\.USABLE_MIN_CREATIVES/);
  assert.doesNotMatch(src, /enough = facts\.active_ads/);
  assert.equal(require('../src/lib/coreCreativePlanConfig').USABLE_MIN_CREATIVES, 3, 'threshold untouched');
  assert.equal(require('../src/lib/coreCreativePlanConfig').STOCK.min_sellable_units, 30, 'stock threshold untouched');
});

// ── Pre-2026 archive: proof of coverage + the per-creative rule ──────────────
const CUT = '2026-01-01';
const F = (o) => ({ ads_total: 3, ads_active: 0, created_unknown: 0, created_since_cutoff: 0, last_delivery: '2025-09-01', pulled_delivery: false, ...o });
const PROVEN = { proven: true };
test('archive: provably pre-2026-only creative IS archived', () => assert.equal(archive.isArchived(F({}), PROVEN, CUT), true));
test('archive: a 2025 original with a 2026 duplicate that ran is NOT archived (any duplicate)', () => {
  assert.equal(archive.isArchived(F({ last_delivery: '2026-08-15' }), PROVEN, CUT), false);
});
test('archive: delivery recorded only in Meta\'s activity check keeps the creative', () => assert.equal(archive.isArchived(F({ pulled_delivery: true }), PROVEN, CUT), false));
test('archive: an ACTIVE ad, an ad created in 2026, or an unknown created date keeps the creative', () => {
  assert.equal(archive.isArchived(F({ ads_active: 1 }), PROVEN, CUT), false);
  assert.equal(archive.isArchived(F({ created_since_cutoff: 1 }), PROVEN, CUT), false);
  assert.equal(archive.isArchived(F({ created_unknown: 1 }), PROVEN, CUT), false);
});
test('archive: without proof of coverage NOTHING is archived (absence of a 2026 row is not proof)', () => {
  assert.equal(archive.isArchived(F({ last_delivery: null }), { proven: false }, CUT), false);
  assert.equal(archive.isArchived(F({ last_delivery: null }), null, CUT), false);
});
test('proof: stored Insights that start AFTER the cutoff prove nothing', () => {
  const p = archive.computeProof({ runs: [{ since: '2026-06-01', until: '2026-10-06' }], pull: null, today: TODAY });
  assert.equal(p.proven, false);
  assert.match(p.reason, /only reach back to 2026-06-01/);
});
test('proof: contiguous stored syncs from before the cutoff to within 14 days of today DO prove it', () => {
  const p = archive.computeProof({ runs: [{ since: '2025-11-01', until: '2026-03-31' }, { since: '2026-04-01', until: '2026-10-06' }], pull: null, today: TODAY });
  assert.equal(p.proven, true);
  assert.equal(p.basis, 'local_insights');
});
test('proof: a gap in the stored syncs breaks the chain (no proof across a hole)', () => {
  const p = archive.computeProof({ runs: [{ since: '2025-11-01', until: '2026-03-31' }, { since: '2026-05-01', until: '2026-10-06' }], pull: null, today: TODAY });
  assert.equal(p.proven, false);
});
test('proof: stored Insights that ended long ago are stale, not proof', () => {
  const p = archive.computeProof({ runs: [{ since: '2025-11-01', until: '2026-06-30' }], pull: null, today: TODAY });
  assert.equal(p.proven, false);
  assert.match(p.reason, /end on 2026-06-30/);
});
test('proof: a completed Meta activity check from the cutoff to yesterday proves it; an old one does not', () => {
  assert.equal(archive.computeProof({ runs: [], pull: { id: 7, since: CUT, until: '2026-10-06' }, today: TODAY }).basis, 'activity_pull');
  assert.equal(archive.computeProof({ runs: [], pull: { id: 7, since: CUT, until: '2026-07-01' }, today: TODAY }).proven, false);
  // an old check extended by contiguous local syncs reaches today
  const ext = archive.computeProof({ runs: [{ since: '2026-07-02', until: '2026-10-06' }], pull: { id: 7, since: CUT, until: '2026-07-01' }, today: TODAY });
  assert.equal(ext.proven, true);
  // a check that does not start by the cutoff is not evidence of the cutoff
  assert.equal(archive.computeProof({ runs: [], pull: { id: 7, since: '2026-02-01', until: '2026-10-06' }, today: TODAY }).proven, false);
});
test('proof: no data at all -> unproven with a clear reason', () => {
  const p = archive.computeProof({ runs: [], pull: null, today: TODAY });
  assert.equal(p.proven, false);
  assert.match(p.reason, /No Insights have been synced/);
});

// ── the bounded Meta check: exactly what it asks for ───────────────────────
test('activity check request: read-only, three fields, one aggregate row per ad, no daily breakdown', () => {
  const r = pullLib.describeRequest('2026-10-07');
  assert.equal(r.method, 'GET');
  assert.equal(r.read_only, true);
  assert.equal(r.writes_to_meta, false);
  assert.deepEqual(r.params, { level: 'ad', fields: 'ad_id,spend,impressions', time_range: { since: '2026-01-01', until: '2026-10-06' }, limit: 500 });
  assert.equal(r.params.time_increment, undefined);
  assert.deepEqual(pullLib.monthChunks('2026-01-01', '2026-03-15'), [{ since: '2026-01-01', until: '2026-01-31' }, { since: '2026-02-01', until: '2026-02-28' }, { since: '2026-03-01', until: '2026-03-15' }]);
  assert.equal(pullLib.isTooMuchData(new Error('Please reduce the amount of data you\'re asking for')), true);
});
test('archive/pull modules: GET only, no writes to ads, Insights, classifications or matching', () => {
  for (const f of ['metaActivityPull', 'metaCreativeArchive']) {
    const src = code(`src/lib/${f}.js`);
    assert.doesNotMatch(src, /method:\s*['"](POST|PUT|DELETE|PATCH)['"]|metaPost|apparelmagic/i, f);
    assert.doesNotMatch(src, /(INSERT INTO|UPDATE|DELETE FROM)\s+(meta_ads|meta_ad_insights_daily|meta_ad_classifications|meta_ad_products|meta_ad_suggestions|meta_catalogue)/i, f);
  }
  assert.doesNotMatch(code('src/lib/metaCreativeArchive.js'), /require\('\.\/metaAds'\)/, 'the proof/rule module never talks to Meta');
});
test('the archive never touches matching rules, the rules version or relevance', () => {
  const m = read('src/lib/metaAdMatching.js');
  assert.match(m, /const BASE_RULES_VERSION = 3;/);
  const rel = read('src/lib/metaMatchingRelevance.js');
  assert.equal(rel, rel, 'relevance module present');
  assert.doesNotMatch(code('src/lib/metaMatchingRelevance.js'), /archive/i, 'relevance logic is unchanged by the archive');
});

// ── ApparelMagic front / back pictures ──────────────────────────────────
test('images: labelled front/back are used as labelled', () => {
  const r = am.pickFrontBack(am.extractImages({ images: [{ img: 'https://x/2.jpg', description: 'Back view' }, { img: 'https://x/1.jpg', description: 'Front', is_catalog_image: '1' }] }));
  assert.equal(r.front.url, 'https://x/1.jpg'); assert.equal(r.front.basis, 'label');
  assert.equal(r.back.url, 'https://x/2.jpg'); assert.equal(r.back.basis, 'label');
});
test('images: file names that say front/back are used', () => {
  const r = am.pickFrontBack(am.extractImages({ images: [{ img: 'https://x/style_front.jpg' }, { img: 'https://x/style_back.jpg' }] }));
  assert.deepEqual([r.front.basis, r.back.basis], ['filename', 'filename']);
});
test('images: unlabelled pictures -> catalogue image as front, the next as back, marked positional; a single picture has no back', () => {
  const two = am.pickFrontBack(am.extractImages({ images: [{ img: 'https://x/1.jpg', is_catalog_image: '1' }, { img: 'https://x/2.jpg' }] }));
  assert.equal(two.front.basis, 'catalog'); assert.equal(two.back.basis, 'position');
  const one = am.pickFrontBack(am.extractImages({ images: [{ img: 'https://x/1.jpg' }] }));
  assert.equal(one.back, null);
  assert.deepEqual(am.pickFrontBack([]), { front: null, back: null, count: 0 });
});
test('planning tile renders FRONT and BACK panes with the whole garment (contain, not crop)', () => {
  const app = read('public/app.js');
  assert.match(app, /function cpImagesHtml/);
  assert.match(app, /pane\('Front', front\)\}\$\{pane\('Back', im\.back\)/);
  assert.match(read('public/styles.css'), /\.cp-img img\{[^}]*object-fit:contain/);
  assert.doesNotMatch(read('public/styles.css'), /\.cp-img img\{[^}]*object-fit:cover/);
  assert.match(app, /No \$\{label\.toLowerCase\(\)\} image/);
});

// ── preview fetch economy ────────────────────────────────────────────────
function fakeMeta(delay = 0) {
  const calls = [];
  const metaGet = async (p, q) => {
    calls.push(p + (q && q.fields ? `?${q.fields.slice(0, 18)}` : ''));
    if (delay) await new Promise((r) => setTimeout(r, delay));
    if (/\/previews$/.test(p)) return { status: 200, data: { data: [{ body: '<iframe src="https://business.facebook.com/ads/api/preview_iframe.php?d=1"></iframe>' }] } };
    if (/^\/(ad\d+)$/.test(p)) return { status: 200, data: { preview_shareable_link: 'https://fb.me/adspreview/facebook/TOKEN' } };
    return { status: 200, data: { id: 'cr1', thumbnail_url: 'https://scontent.fbcdn.net/t.jpg', image_url: 'https://scontent.fbcdn.net/i.jpg' } };
  };
  return { calls, metaGet };
}
test('preview fetch: the independent Meta calls run concurrently, not one after another', async () => {
  const m = fakeMeta(60);
  const t0 = Date.now();
  const out = await creative.fetchFromMeta('ad1', 'cr1', { metaGet: m.metaGet, accountPath: () => 'act_1' });
  const ms = Date.now() - t0;
  assert.equal(m.calls.length, 3);
  assert.ok(ms < 150, `3 x 60 ms calls took ${ms} ms (sequential would be ~180+)`);
  assert.equal(out.kind, 'image');
  assert.ok(out.timings_ms.creative >= 55 && out.timings_ms.preview >= 55, 'per-step timings are reported');
});
test('preview fetch: a stored share link is reused (that call is skipped)', async () => {
  const m = fakeMeta();
  const out = await creative.fetchFromMeta('ad1', 'cr1', { metaGet: m.metaGet, accountPath: () => 'act_1' }, { knownShareLink: 'https://fb.me/adspreview/facebook/KNOWN' });
  assert.equal(m.calls.length, 2);
  assert.equal(out.share_link, 'https://fb.me/adspreview/facebook/KNOWN');
  assert.equal(out.diagnostics.share_link, 'reused');
});
test('preview fetch: a sibling ad of the SAME creative supplies the creative-level pieces (only the ad-specific preview is fetched)', async () => {
  const m = fakeMeta();
  const base = { kind: 'video', object_type: 'VIDEO', thumbnail_url: 'https://scontent.fbcdn.net/t.jpg', main: { type: 'video', video_url: 'https://video.fbcdn.net/v.mp4', image_url: null, poster_url: null }, cards: [] };
  const out = await creative.fetchFromMeta('ad2', 'cr1', { metaGet: m.metaGet, accountPath: () => 'act_1' }, { base, knownShareLink: 'https://fb.me/adspreview/facebook/K' });
  assert.equal(m.calls.length, 1, 'only /previews');
  assert.equal(out.kind, 'video');
  assert.equal(out.main.video_url, 'https://video.fbcdn.net/v.mp4');
  assert.match(out.preview_iframe_src, /preview_iframe\.php/);
  assert.equal(out.source, 'meta_sibling');
});
test('preview: browser reuses an already-loaded preview, shares one in-flight fetch, and warms only on hover intent', () => {
  const app = read('public/app.js');
  assert.match(app, /const apCache = new Map\(\)/);
  assert.match(app, /apInflight\.has\(adId\)\) return apInflight\.get\(adId\)/);
  assert.match(app, /setTimeout\(\(\) => apPrefetch\(id\), 250\)/);
  assert.match(app, /prefetch=1/);
  assert.doesNotMatch(app, /querySelectorAll\('\[data-thumb-ad\]'\)\.forEach\([^)]*apPrefetch/, 'no bulk prefetch over the table');
  assert.match(read('public/index.html'), /rel="preconnect" href="https:\/\/business\.facebook\.com"/);
});
test('preview prefetch is gated by the META_AUTO_SYNC switch and only the server decides to reach Meta', () => {
  const src = code('src/lib/metaAdCreative.js');
  assert.match(src, /if \(prefetch\) \{[\s\S]*?autoEnabled[\s\S]*?return null;/);
});

// ── layout / structure guards ──────────────────────────────────────────────
test('Meta Performance: Funnel is its own FIRST column, then Creative, then Ad Name', () => {
  const html = read('public/index.html');
  const m = /<table class="mp-table mp-perf">[\s\S]*?<tr>([\s\S]*?)<\/tr>/.exec(html);
  const heads = [...m[1].matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((x) => x[1].trim());
  assert.deepEqual(heads, ['Funnel', 'Creative', 'Ad Name', 'Status', 'Amount Spent', 'Purchases', 'CPA', 'Adds to Cart', 'Cost / ATC', 'Outbound CTR', 'Reach', 'Frequency']);
  const app = read('public/app.js');
  assert.match(app, /<td class="mp-funnel-cell">\$\{mpFunnelBadge\(a\.funnel\)\}<\/td>\s*<td class="mp-creative-cell">\$\{ccThumbHtml/);
  assert.doesNotMatch(app, /mp-campaign-line"><span class="mp-funnel/, 'funnel is no longer under the ad name');
});
test('Inspiration stage folders cover every record (Other catches what names none of the four stages)', () => {
  const app = read('public/app.js');
  assert.match(app, /const BF_INSP_STAGES = \[/);
  assert.match(app, /return keys\.length \? keys : \['other'\]/);
  for (const label of ['Hype', 'Live', 'Mid Sale', 'Last Chance', 'Other / Uncategorised']) assert.ok(app.includes(label), label);
});
test('Inspiration: deterministic recovery has no name search; the manual workflow is a separate module', () => {
  assert.doesNotMatch(code('src/lib/inspirationMetaLink.js'), /ILIKE|ad_name|similarity|levenshtein|jaccard/i);
  assert.match(code('src/lib/inspirationManualLink.js'), /manualLink/);
  assert.match(read('public/app.js'), /Link to Meta creative/);
});
test('conflict resolution and matching rules are untouched by this batch', () => {
  assert.match(code('src/lib/metaCreativeConflict.js'), /resolveConflict/);
  assert.equal(require('../src/lib/metaCreativeIdentity').METHOD, 'creative_inherited');
});
