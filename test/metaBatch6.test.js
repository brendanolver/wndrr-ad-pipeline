// Pure (no database, no Meta) tests for batch 6: rapid approval, keyboard safety, creator / concept vocabulary, concept inventory.
// The end-to-end behaviour (real browser, real database) is covered by the sandbox suites b6-ui / b6-db; these pin the pure logic
// and the static guarantees (no new propagation path, no Meta call, additive schema, the safety guards are present).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused'; // pool is lazy; never connected here
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const vocab = require('../src/lib/metaMatchingVocab');
const inv = require('../src/lib/metaConceptInventory');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const code = (f) => read(f).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ── vocabulary names ────────────────────────────────────────────────────
test('vocab: names are trimmed, whitespace-collapsed and compared case-insensitively', () => {
  assert.equal(vocab.cleanName('  Sam   Smith '), 'Sam Smith');
  assert.equal(vocab.cleanName('\tJAMES\n'), 'JAMES');
  assert.equal(vocab.cleanName('   '), null);
  assert.equal(vocab.cleanName(null), null);
  assert.equal(vocab.keyOf(' JAMES '), vocab.keyOf('james'));
  assert.equal(vocab.keyOf('Try  On'), vocab.keyOf('try on'));
  assert.notEqual(vocab.keyOf('Try On'), vocab.keyOf('Tryon'), 'different spellings are different names (never merged)');
});
test('vocab: the first spelling offered wins; case-insensitive duplicates are dropped, nothing is merged', () => {
  const out = vocab.dedupe([{ name: 'Mark', source: 'roster' }, { name: 'JAMES', source: 'added' }, { name: 'james', source: 'in_use' }, { name: 'MARK', source: 'in_use' }, { name: 'Sam', source: 'in_use' }]);
  assert.deepEqual(out.map((x) => x.name), ['Mark', 'JAMES', 'Sam']);
  assert.equal(out[0].source, 'roster');
});
test('vocab: kinds, length limit and the explicit add action', () => {
  assert.deepEqual(vocab.KINDS, ['creator', 'concept']);
  assert.equal(vocab.MAX_NAME, 100);
});

// ── schema: additive, JAMES seeded, case-insensitive uniqueness in the database ──
test('schema: meta_matching_vocab is additive, unique per (kind, lower-cased name), and seeds JAMES idempotently', () => {
  const sql = read('db/schema.sql');
  const block = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS meta_matching_vocab'), sql.indexOf('-- Approved Ad Matching concepts'));
  assert.match(block, /UNIQUE \(kind, name_key\)/);
  assert.match(block, /CHECK \(kind IN \('creator', 'concept'\)\)/);
  assert.match(block, /'creator', 'JAMES', 'james'/);
  assert.match(block, /ON CONFLICT \(kind, name_key\) DO NOTHING/);
  assert.doesNotMatch(block, /\bDROP |DELETE FROM|TRUNCATE|ALTER TABLE (?!meta_matching_vocab)/i, 'the new block never drops, deletes or alters anything existing');
  assert.doesNotMatch(block, /INSERT INTO (content_creators|concept_types|meta_ad_classifications)/i, 'the seed does not write to the shared rosters or classifications');
});

// ── concept inventory: unique creatives are counted separately from Meta ads ──
test('inventory: pure aggregation keeps unique creatives and Meta ads apart and never merges variants', () => {
  const usage = [
    { concept: 'Try On', source: 'confirmed', creatives: 1, ads: 1 },
    { concept: 'Try On', source: 'inherited', creatives: 1, ads: 2 },
    { concept: 'Try On', source: null, creatives: 1, ads: 3 },          // ONE creative across THREE ads (not 2 creatives)
    { concept: 'try on', source: 'suggested', creatives: 2, ads: 2 },
    { concept: 'try on', source: null, creatives: 2, ads: 2 },
    { concept: 'Try-On', source: 'auto_matched', creatives: 1, ads: 4 },
    { concept: 'Try-On', source: null, creatives: 1, ads: 4 },
    { concept: 'Unboxing', source: 'confirmed', creatives: 5, ads: 9 },
    { concept: 'Unboxing', source: null, creatives: 5, ads: 9 },
  ];
  const out = inv.buildInventory({ usage, setups: [{ concept: 'Unboxing', setups: 2, linked_ads: 3 }], vocabulary: [{ name: 'Unboxing', origin: 'approved', active: true }, { name: 'Never Used', origin: 'approved', active: true }] });
  const row = (n) => out.concepts.find((c) => c.concept === n);
  assert.equal(row('Try On').total_creatives, 1);
  assert.equal(row('Try On').total_ads, 3);
  assert.deepEqual(row('Try On').sources.inherited, { creatives: 1, ads: 2 });
  assert.deepEqual(row('Try On').sources.auto_matched, { creatives: 0, ads: 0 });
  assert.equal(row('Unboxing').vocabulary.match, 'exact');
  assert.deepEqual(row('Unboxing').ad_setups, { setups: 2, linked_ads: 3 });
  assert.equal(row('Never Used').total_ads, 0, 'a listed concept nobody uses still appears with zero counts');
  assert.equal(row('Try On').vocabulary.match, 'none');
  // three exact spellings stay three concepts, reported together as ONE variant group
  assert.equal(out.concepts.filter((c) => /^try.?on$/i.test(c.concept)).length, 3);
  assert.equal(out.variant_groups.length, 1);
  assert.deepEqual(out.variant_groups[0].variants.map((v) => v.concept).sort(), ['Try On', 'Try-On', 'try on']);
  assert.deepEqual(row('try on').variants_of.sort(), ['Try On', 'Try-On']);
  assert.equal(out.totals.distinct_concepts, 5);
  assert.equal(out.totals.distinct_after_ignoring_case_and_punctuation, 3);
  assert.equal(inv.variantKey('Try-On'), inv.variantKey('try  on'));
  assert.equal(inv.variantKey('Hype & Sale'), inv.variantKey('hype and sale'));
  assert.notEqual(inv.variantKey('Try On'), inv.variantKey('Tryon'), 'only case / punctuation / "&" are treated as variants');
  const csv = inv.inventoryCsv({ concepts: out.concepts });
  assert.match(csv.split('\n')[0], /^concept,total_unique_creatives,total_meta_ads/);
  assert.equal(csv.trim().split('\n').length, out.concepts.length + 1);
});
test('inventory: read-only SQL (no writes) and no Meta call', () => {
  const src = code('src/lib/metaConceptInventory.js');
  assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b/i);
  assert.doesNotMatch(src, /metaAds|graph\.facebook|fetch\(/);
  const route = code('src/routes/metaAdMatching.js');
  assert.match(route, /router\.get\('\/concept-inventory'/);
});

// ── server: same endpoint, same protected inheritance, no new propagation path ──
test('rapid review uses the existing confirm endpoint and the existing creative inheritance (nothing weaker, nothing new)', () => {
  const lib = code('src/lib/metaAdMatching.js');
  const confirm = lib.slice(lib.indexOf('async function confirmMapping'), lib.indexOf('async function reapplyTrustedPair'));
  assert.match(confirm, /syncCreativeFor\(metaAdId\)/, 'confirming still hands the decision to the protected creative-group sync');
  assert.match(confirm, /const rapid = input\.rapid === true/);
  assert.match(confirm, /if \(!rapid && !notProductSpecific && productCodes\.length === 1\)[\s\S]{0,120}reapplyTrustedPair/, 'trusted-pair re-evaluation of OTHER creatives runs for the full editor only, never for rapid confirms');
  assert.doesNotMatch(confirm, /require_complete/, 'no concept (or other) completeness rule is enforced beyond the product / Not product-specific rule');
  assert.match(confirm, /Choose at least one product, or mark the ad "Not product-specific"/, 'the one required-field rule keeps its wording');
  const app = code('public/app.js');
  const rv = app.slice(app.indexOf('const mmRv = {'), app.indexOf('async function mmOpenInventory'));
  assert.match(rv, /\/meta-ad-matching\/ads\/\$\{encodeURIComponent\(id\)\}\/confirm/);
  assert.doesNotMatch(rv, /creative-inheritance|\/suggest|reprocess-backlog|meta-archive|catalogue|inspiration/i, 'the rapid module never calls Apply, backlog, archive, catalogue or Inspiration endpoints');
  assert.doesNotMatch(rv, /graph\.facebook|META_/);
});
test('the review batch is a read: selects only, and never writes or refreshes suggestions', () => {
  const lib = code('src/lib/metaAdMatching.js');
  const batch = lib.slice(lib.indexOf('async function getReviewBatch'), lib.indexOf('async function searchAdSetups'));
  assert.doesNotMatch(batch, /\b(INSERT|UPDATE|DELETE)\b/);
  assert.doesNotMatch(batch, /refreshSuggestions|loadContext|metaAds/);
  const route = code('src/routes/metaAdMatching.js');
  assert.match(route, /router\.get\('\/review-batch'/);
  assert.match(route, /router\.post\('\/vocab\/creators'/);
  assert.match(route, /router\.post\('\/vocab\/concepts'/);
});
test('a creative a person already classified, or that is in conflict, is never offered for rapid confirmation', () => {
  const lib = code('src/lib/metaAdMatching.js');
  const batch = lib.slice(lib.indexOf('async function getReviewBatch'), lib.indexOf('async function searchAdSetups'));
  for (const reason of ['excluded', 'confirmed', 'auto_matched', 'linked_ad_setup', 'creative_conflict', 'creative_already_classified']) assert.match(batch, new RegExp(`'${reason}'`), reason);
  assert.match(batch, /resolveGroup/, 'uses the shared identity rule');
});

// ── keyboard + readiness: the rules, extracted from the shipped front end and run ──
function frontEndFn(name) {
  const app = read('public/app.js');
  const i = app.indexOf(`function ${name}(`);
  assert.ok(i >= 0, name);
  let depth = 0; let j = app.indexOf('{', i);
  for (let k = j; k < app.length; k++) { if (app[k] === '{') depth++; else if (app[k] === '}') { depth--; if (!depth) { j = k; break; } } }
  return app.slice(i, j + 1);
}
test('readiness: a valid product OR Not product-specific is the only requirement; concept / creator / media / style are optional', () => {
  // eslint-disable-next-line no-new-func
  const ready = new Function(`${frontEndFn('mmRvReadiness')}; return mmRvReadiness;`)();
  const p = [{ key: 'P1', label: 'Tee' }]; const c = { label: 'Try On' };
  assert.equal(ready({ nps: false, products: p, concept: c }).ready, true);
  assert.equal(ready({ nps: false, products: p, concept: null }).ready, true, 'a product with no concept is confirmable');
  assert.equal(ready({ nps: false, products: p, concept: null, creator: null, media: null, style: null }).ready, true);
  assert.equal(ready({ nps: true, products: [], concept: null }).ready, true, 'Not product-specific needs no concept');
  assert.equal(ready({ nps: false, products: [], concept: c }).ready, false, 'a concept alone is not enough');
  assert.equal(ready({ nps: false, products: [], concept: null }).ready, false, 'no product and not Not product-specific cannot be confirmed');
  assert.match(ready({ nps: false, products: [], concept: null }).why, /product/i);
});
test('the rapid payload carries rapid:true, links no Ad Setup, and sends no concept when none was chosen', () => {
  // eslint-disable-next-line no-new-func
  const payload = new Function('mmConceptPayload', `${frontEndFn('mmRvPayload')}; return mmRvPayload;`)((x) => (x ? (x.concept_type_id ? { concept_type_id: x.concept_type_id } : { label: x.label }) : null));
  const out = payload({ nps: false, products: [{ key: 'P1', label: 'Tee' }], concept: { label: 'B', concept_type_id: null }, creator: 'JAMES', media: { key: 'video' }, style: null });
  assert.deepEqual(out, { product_codes: ['P1'], not_product_specific: false, concept: { label: 'B' }, creative_style_id: null, creator_name: 'JAMES', media_type: 'video', ad_setup_id: null, rapid: true });
  const bare = payload({ nps: false, products: [{ key: 'P1' }], concept: null, creator: null, media: null, style: null });
  assert.equal(bare.concept, null, 'no placeholder concept is invented');
  assert.equal(bare.creator_name, null);
  assert.equal(bare.media_type, null);
  const nps = payload({ nps: true, products: [{ key: 'P1' }], concept: null, creator: null, media: null, style: null });
  assert.equal(nps.not_product_specific, true);
  assert.deepEqual(nps.product_codes, []);
  assert.equal(nps.concept, null);
  assert.equal(nps.rapid, true);
});
test('keyboard safety (review modal): Enter confirms only outside a field / dropdown, never repeats, never with another dialog open or modifiers', () => {
  const app = code('public/app.js');
  const kb = app.slice(app.indexOf("document.addEventListener('keydown', (e) => {\n  const s = mmRv.sess;"));
  assert.ok(kb.length > 100, 'handler found');
  const handler = kb.slice(0, kb.indexOf('\n});') + 4);
  assert.match(handler, /e\.key !== 'Enter'/);
  assert.match(handler, /const typing = /, 'a text field / dropdown is detected');
  assert.match(handler, /if \(typing\) \{ if \(modal\.contains\(t\)\) s\.enterBlockedUntil = Date\.now\(\) \+ MM_RV_ENTER_GUARD_MS; return; \}/, 'an Enter used by a field or dropdown never confirms, and blocks the next 500 ms');
  assert.match(handler, /modal-backdrop\.show/, 'another dialog on top stops it');
  assert.match(handler, /e\.ctrlKey \|\| e\.metaKey \|\| e\.altKey/);
  assert.match(handler, /e\.repeat/, 'a held key never confirms twice');
  assert.match(handler, /e\.isComposing/);
  assert.match(handler, /t\.closest\('button, a, \[role="button"\]'\)/, 'a focused button acts natively, not twice');
  assert.match(handler, /mmSessConfirm\(\)/);
  const fn = app.slice(app.indexOf('async function mmSessConfirm'), app.indexOf('async function mmSessSkip'));
  assert.match(fn, /mmRv\.busy \|\| Date\.now\(\) < mmRv\.cooldownUntil/, 'in-flight and cooldown guards');
  assert.match(fn, /mmRvReadiness\(f\)/, 'a classification with no product (and not Not product-specific) is refused before any request');
  assert.match(fn, /return false;\s*\}\s*mmRv\.busy = true/, 'a refused confirmation stays on the same creative (no advance)');
  assert.match(fn, /mmRv\.cooldownUntil = Date\.now\(\) \+ MM_RV_COOLDOWN_MS/);
  assert.match(app, /MM_RV_COOLDOWN_MS = 400/);
  assert.match(fn, /await mmSessNext\(id\)/, 'moves on to the next unique creative only after a successful confirmation');
  assert.match(fn, /if \(!ok\) \{\s*if \(ctx\.errEl\) ctx\.errEl\.textContent = msg/, 'a failed confirmation keeps the creative and explains');
});
test('the full editor and the rapid editor offer an explicit Add for new creators / concepts (no silent free text for these)', () => {
  const app = code('public/app.js');
  assert.match(app, /addNew: mmAddConcept/);
  assert.match(app, /addNew: mmAddCreator/);
  assert.match(app, /Add “\$\{escapeHtml\(term\)\}” as a new/);
  assert.match(app, /\/meta-ad-matching\/vocab\/creators/);
  assert.match(app, /\/meta-ad-matching\/vocab\/concepts/);
  assert.doesNotMatch(app.slice(app.indexOf('const creatorPicker')), /^[\s\S]{0,300}allowFree: true/, 'the creator picker no longer takes silent free text');
});
test('opening the concept inventory only reads; nothing in this batch starts the archive check or any refresh', () => {
  const app = code('public/app.js');
  const open = app.slice(app.indexOf('async function mmOpenInventory'), app.indexOf("document.getElementById('mm-open-inventory')"));
  assert.match(open, /\/meta-ad-matching\/concept-inventory/);
  assert.doesNotMatch(open, /method: 'POST'|meta-archive|\/suggest|refresh/i);
});
