// Creative preview + Reach/Frequency helpers: URL safety, normalisation of Meta's creative shapes, cache
// expiry, and the Reach cache's status/summary rules. Pure (no database / network).
//   npm test
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused'; // pool is lazy; never connected here
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/lib/metaAdCreative');
const store = require('../src/lib/metaReachStore');

const oe = (h) => Math.floor((Date.now() + h * 3600 * 1000) / 1000).toString(16);
const cdn = (p, h = 5) => `https://scontent-syd2-1.xx.fbcdn.net/v/${p}?_nc=1&oe=${oe(h)}`;
const IFRAME = 'https://business.facebook.com/ads/api/preview_iframe.php?d=AQL&t=AQI';

test('only https Meta / Instagram URLs without a credential are kept', () => {
  assert.ok(c.safeUrl('https://scontent.xx.fbcdn.net/a.jpg'));
  assert.equal(c.safeUrl('http://scontent.xx.fbcdn.net/a.jpg'), null);
  assert.equal(c.safeUrl('https://evil.example.com/a.jpg'), null);
  assert.equal(c.safeUrl('https://scontent.xx.fbcdn.net/a.jpg?access_token=SECRET'), null);
  assert.equal(c.safeUrl('javascript:alert(1)'), null);
  assert.equal(c.safeUrl(null), null);
});

test('the preview iframe must be Meta\'s preview_iframe.php and carry no token', () => {
  assert.equal(c.iframeSrcFrom(`<iframe src="${IFRAME.replace(/&/g, '&amp;')}"></iframe>`), IFRAME);
  assert.equal(c.iframeSrcFrom('<iframe src="https://evil.com/ads/api/preview_iframe.php?d=1"></iframe>'), null);
  assert.equal(c.iframeSrcFrom(`<iframe src="${IFRAME}&access_token=X"></iframe>`), null);
  assert.equal(c.iframeSrcFrom('<iframe src="https://business.facebook.com/other?d=1"></iframe>'), null);
});

test('video, carousel (pictures, image hashes, videos) and image creatives normalise to playable media', () => {
  const v = c.normalise({ creative: { video_id: 'v1', thumbnail_url: cdn('t.jpg') }, shareLink: 'https://fb.me/abc', previewBody: `<iframe src="${IFRAME}"></iframe>`, videos: { v1: { source: cdn('v.mp4'), picture: cdn('p.jpg'), length: 31 } }, imageUrls: {} });
  assert.equal(v.kind, 'video');
  assert.ok(v.main.video_url && v.main.poster_url);
  assert.equal(v.share_link, 'https://fb.me/abc');
  const car = c.normalise({ creative: { object_story_spec: { link_data: { child_attachments: [{ picture: cdn('1.jpg'), name: 'One' }, { image_hash: 'h2', name: 'Two' }, { video_id: 'v9', name: 'Three' }] } } }, shareLink: null, previewBody: null, videos: { v9: { source: cdn('v9.mp4'), picture: cdn('v9.jpg') } }, imageUrls: { h2: cdn('2.jpg') } });
  assert.equal(car.kind, 'carousel');
  assert.equal(car.cards.length, 3);
  assert.ok(car.cards[1].image_url && car.cards[2].video_url);
  const img = c.normalise({ creative: { object_type: 'SHARE', image_url: cdn('i.jpg'), thumbnail_url: cdn('t.jpg') }, shareLink: null, previewBody: null, videos: {}, imageUrls: {} });
  assert.equal(img.kind, 'image');
});

test('unsafe URLs are dropped and never echoed', () => {
  const bad = c.normalise({ creative: { image_url: 'https://scontent.xx.fbcdn.net/a.jpg?access_token=SECRET', thumbnail_url: 'https://evil.example.com/x.jpg' }, shareLink: 'https://fb.me/x?access_token=SECRET', previewBody: null, videos: {}, imageUrls: {} });
  assert.equal(bad.kind, 'unknown');
  assert.doesNotMatch(JSON.stringify(bad), /SECRET/);
});

test('cache expiry follows the signed URL (capped at 6h, floor 10 min)', () => {
  const m = (u) => c.expiresAtFor(u, Date.now()).getTime() - Date.now();
  assert.ok(m([cdn('a', 2)]) > 100 * 60000 && m([cdn('a', 2)]) < 120 * 60000);
  assert.ok(m([cdn('a', 48)]) <= 6 * 3600 * 1000 + 1000);
  assert.ok(m(['https://scontent.xx.fbcdn.net/a?oe=10000000']) >= 9 * 60000);
});

test('Reach is never summed: summary is null + a reason until an exact pull exists', () => {
  const none = store.summaryFrom({ state: 'not_loaded', account: null, pulled_at: null, stale: false, includes_today: false, last_error: null });
  assert.equal(none.available, false);
  assert.equal(none.reach, null);
  assert.match(none.reason, /not additive|loaded from Meta on request/);
  const ready = store.summaryFrom({ state: 'ready', account: { reach: 4200, frequency: 2.5, impressions: 10500 }, pulled_at: '2026-10-07T00:00:00Z', stale: true, includes_today: true, last_error: null });
  assert.equal(ready.reach, 4200);
  assert.equal(ready.stale, true);
  assert.equal(store.summaryFrom({ state: 'failed', account: null, last_error: { message: 'Meta rate limit reached.' } }).reason, 'Meta rate limit reached.');
});

test('cache freshness: ranges that include recent days refresh sooner than past ranges', () => {
  // live rule: lib/metaFreshnessPolicy.reachTtlMs (today 30 min, recently ended 6 h, older 7 days)
  assert.equal(store.freshnessMs({ since: '2026-10-01', until: '2026-10-07' }, '2026-10-07'), 30 * 60 * 1000);
  assert.equal(store.freshnessMs({ since: '2026-10-01', until: '2026-10-06' }, '2026-10-07'), 6 * 60 * 60 * 1000);
  assert.equal(store.freshnessMs({ since: '2026-08-01', until: '2026-08-20' }, '2026-10-07'), store.FRESH_MS_PAST);
  assert.equal(store.addDaysYmd('2026-10-01', -1), '2026-09-30');
});
