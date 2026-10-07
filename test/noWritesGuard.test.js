// Static guard: the Meta / ApparelMagic code paths used by Reach, creative preview and the Core plan only ever READ.
// (Meta: GETs through metaAds.metaGet; ApparelMagic: amRequest('GET'). Local database writes are separate and expected.)
//   npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');

test('new Meta modules make only GET reads (no POST/DELETE, no direct https calls)', () => {
  ['lib/metaAdCreative.js', 'lib/metaRangeReach.js', 'lib/metaReachStore.js', 'routes/adCreative.js', 'lib/coreCreativePlan.js', 'routes/coreCreativePlan.js'].forEach((f) => {
    const src = read(f);
    assert.doesNotMatch(src, /https?\.request|method:\s*['"](POST|PUT|PATCH|DELETE)['"]|\bfetch\(|axios|node-fetch/i, f);
  });
  assert.doesNotMatch(read('lib/metaAds.js'), /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/, 'the shared Meta client has no write verbs');
});

test('the Core plan modules never import the Meta client (they read the local DB and cached ApparelMagic only)', () => {
  ['lib/coreCreativePlan.js', 'routes/coreCreativePlan.js'].forEach((f) => assert.doesNotMatch(read(f), /require\(['"].*metaAds['"]\)/, f));
});

test('every ApparelMagic request in the client is a GET', () => {
  const src = read('lib/apparelmagic.js');
  const calls = [...src.matchAll(/amRequest\(\s*['"](\w+)['"]/g)].map((m) => m[1]);
  assert.ok(calls.length >= 1);
  assert.ok(calls.every((m) => m === 'GET'), `amRequest verbs: ${calls.join(',')}`);
});

test('Meta Matching V4 files are not touched by name: rules version and snapshot logic stay as shipped', () => {
  const m = read('lib/metaAdMatching.js');
  assert.match(m, /const BASE_RULES_VERSION = 3;/);
  assert.match(m, /const AUTO_RULES_VERSION = BASE_RULES_VERSION;/);
});
