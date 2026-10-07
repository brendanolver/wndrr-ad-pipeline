// Creative-level identity: one creative -> one classification. Pure decision logic (no database / network).
//   npm test
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused'; // pool is lazy; never connected here
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const id = require('../src/lib/metaCreativeIdentity');

const row = (adId, o = {}) => ({
  meta_ad_id: adId, not_product_specific: false, concept_type_id: null, concept_label: null, creator_name: null, media_type: null,
  codes: ['W26AA001'], products: [{ product_code: 'W26AA001', product_name: 'ALPHA TEE' }], ...o,
});

test('no human decision on the creative -> nothing to inherit', () => {
  assert.deepEqual(id.evaluateGroup([]), { state: 'none', human_ads: 0 });
});

test('one human decision is the source, carrying its products, concept, creator and media', () => {
  const g = id.evaluateGroup([row('a1', { concept_label: 'TRYON', creator_name: 'Mark', media_type: 'video' })]);
  assert.equal(g.state, 'source');
  assert.equal(g.source.from_meta_ad_id, 'a1');
  assert.equal(g.source.concept_label, 'TRYON');
  assert.equal(g.source.creator_name, 'Mark');
  assert.deepEqual(g.source.products.map((p) => p.product_code), ['W26AA001']);
  assert.match(g.source.signature, /^[0-9a-f]{16}$/);
});

test('several people agreeing is still one source; blanks are filled from the others, never invented', () => {
  const g = id.evaluateGroup([row('a2', { concept_label: null, creator_name: 'Mark' }), row('a1', { concept_label: 'TRYON' })]);
  assert.equal(g.state, 'source');
  assert.equal(g.human_ads, 2);
  assert.equal(g.source.from_meta_ad_id, 'a2'); // most recently confirmed first
  assert.equal(g.source.concept_label, 'TRYON');
  assert.equal(g.source.creator_name, 'Mark');
  assert.equal(g.source.media_type, null);
});

test('different products on the same creative is a CONFLICT -- nothing is chosen silently', () => {
  const g = id.evaluateGroup([row('a1'), row('a2', { codes: ['W26BB001'], products: [{ product_code: 'W26BB001', product_name: 'BRAVO TEE' }] })]);
  assert.equal(g.state, 'conflict');
  assert.deepEqual(g.conflict_on, ['product']);
  assert.equal(g.source, undefined);
});

test('"not product-specific" vs a product is a conflict', () => {
  const g = id.evaluateGroup([row('a1'), row('a2', { not_product_specific: true, codes: [], products: [] })]);
  assert.equal(g.state, 'conflict');
});

test('two different concepts is a conflict; the same concept in different case is not', () => {
  assert.equal(id.evaluateGroup([row('a1', { concept_label: 'TRYON' }), row('a2', { concept_label: 'FLATLAY' })]).state, 'conflict');
  assert.equal(id.evaluateGroup([row('a1', { concept_label: 'TryOn ' }), row('a2', { concept_label: 'tryon' })]).state, 'source');
});

test('the same product SET in a different order is not a conflict', () => {
  const two = (a, b) => row('x', { codes: [a, b].sort(), products: [a, b].map((c) => ({ product_code: c, product_name: c })) });
  assert.equal(id.evaluateGroup([two('W26AA001', 'W26BB001'), two('W26BB001', 'W26AA001')]).state, 'source');
});

test('signature changes when the classification changes (so inherited copies refresh)', () => {
  const a = id.evaluateGroup([row('a1', { concept_label: 'TRYON' })]).source.signature;
  const b = id.evaluateGroup([row('a1', { concept_label: 'FLATLAY' })]).source.signature;
  assert.notEqual(a, b);
});

test('identity is the exact meta_creative_id only: no fuzzy / name-based matching in the module', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'metaCreativeIdentity.js'), 'utf8');
  assert.match(src, /meta_creative_id = \$1/);
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /ILIKE|similarity|jaccard|levenshtein|ad_name/i);
});

test('inherited ads are machine-owned: written as auto_matched / creative_inherited, never confirmed', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'metaCreativeIdentity.js'), 'utf8');
  assert.match(src, /match_status = 'auto_matched', match_method = \$2/);
  // writes: every UPDATE meta_ads SET ... in the module sets auto_matched / unmatched, never confirmed or the confirmation stamps
  const updates = [...src.matchAll(/UPDATE meta_ads SET([\s\S]*?)WHERE/g)].map((m) => m[1]);
  assert.ok(updates.length >= 2);
  updates.forEach((u) => assert.doesNotMatch(u, /'confirmed'|match_confirmed_at|match_confirmed_by_user_id|matched_ad_setup_id/));
  assert.equal(id.METHOD, 'creative_inherited');
});

test('matching rules, version and identity guard are untouched; inherited ads are excluded from rules-version runs and their dry run', () => {
  const m = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'metaAdMatching.js'), 'utf8');
  assert.match(m, /const BASE_RULES_VERSION = 3;/);
  assert.match(m, /const AUTO_RULES_VERSION = BASE_RULES_VERSION;/);
  // the three rules-version selections (backlog run, backlog status, preview) all skip creative_inherited ads
  assert.equal((m.match(/match_method IS DISTINCT FROM 'creative_inherited'/g) || []).length, 3);
  // human-owned protection is still the single shared definition
  assert.match(m, /const HUMAN_OWNED_SQL = `\(CASE/);
  assert.match(m, /inheritForAd\(client, ad\.meta_ad_id/);
});

test('Ad Matching queue stays local: no Meta client, no ApparelMagic WRITE', () => {
  const code = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code('lib/metaAdMatching.js'), /require\(['"]\.\/(metaAds|metaSync)['"]\)/);
  assert.doesNotMatch(code('routes/metaAdMatching.js'), /metaAds|metaSync/);
});

// ---- ONE shared inheritance-eligibility rule ----
const human = "(CASE WHEN m.match_status = 'confirmed' THEN 'confirmed' END)";

test('decide(): eligible + new decision -> apply; already in line -> unchanged; not eligible -> skip with the reason', () => {
  const group = { source: { signature: 'sig1', from_meta_ad_id: 'src' } };
  assert.deepEqual(id.decide({ eligible: true, match_method: null, auto_fields: null }, group), { action: 'apply' });
  assert.deepEqual(id.decide({ eligible: true, match_method: 'creative_inherited', auto_fields: { inherited: { signature: 'sig1', from_meta_ad_id: 'src' } } }, group), { action: 'unchanged' });
  assert.deepEqual(id.decide({ eligible: true, match_method: 'creative_inherited', auto_fields: { inherited: { signature: 'OLD', from_meta_ad_id: 'src' } } }, group), { action: 'apply' }, 'a changed decision is re-applied');
  assert.deepEqual(id.decide({ eligible: false, ineligible_reason: 'skipped' }, group), { action: 'skip', reason: 'skipped' });
  assert.deepEqual(id.decide({ eligible: false, ineligible_reason: 'rejected_by_person' }, group), { action: 'skip', reason: 'rejected_by_person' });
});

test('the eligibility SQL = right status AND not person-owned AND not rejected; reasons mirror it', () => {
  const sql = id.eligibleSql(human);
  assert.match(sql, /match_status IN \('unmatched', 'suggested', 'auto_matched'\)/);
  assert.match(sql, /\(CASE WHEN m\.match_status = 'confirmed' THEN 'confirmed' END\)\) IS NULL/);
  assert.match(sql, /c\.auto_match_blocked_at IS NULL/);
  const why = id.ineligibleReasonSql(human);
  assert.match(why, /'confirmed'/);
  assert.match(why, /'rejected_by_person'/);
});

test('Apply, the workload panel and the queue all use that one rule (no second definition)', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', f), 'utf8');
  const identity = read('metaCreativeIdentity.js');
  const matching = read('metaAdMatching.js');
  // Apply (applyToAd) and its dry run (previewGroup) take eligibility from the shared helper
  assert.equal((identity.match(/eligibleSql\(humanOwnedSql\)/g) || []).length >= 2, true);
  const codeOnly = identity.replace(/\/\/.*$/gm, '');
  assert.equal((codeOnly.match(/auto_match_blocked_at/g) || []).length, 2, 'the rejected-by-person test lives only inside the two shared helpers');
  // workload + queue (via the covered-units SELECT) use the same helper
  assert.match(matching, /creativeIdentity\.eligibleSql\(HUMAN_OWNED_SQL\)/);
  assert.equal((matching.match(/coveredUnitsSelect\(\)/g) || []).length, 2, 'queue and workload share one covered-units definition');
  assert.match(matching, /creativeIdentity\.previewAll\(/, 'the panel\'s "Apply to N" is the real dry run of Apply');
});

test('every filter chip reads a count field the queue returns, and says its unit', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const matching = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'metaAdMatching.js'), 'utf8');
  const chips = [...app.matchAll(/\['([a-z_]+)', '([^']+)', '([a-z_]+)', '(creatives|ads)'\]/g)];
  assert.equal(chips.length, 9);
  chips.forEach(([, , , field]) => assert.match(matching, new RegExp(`AS ${field}\\b`), `counts.${field} exists`));
  const unit = Object.fromEntries(chips.map((m) => [m[2], m[4]]));
  ['To do', 'Needs review', 'Unmatched', 'Will inherit', 'Historical', 'Creative conflicts'].forEach((l) => assert.equal(unit[l], 'creatives', l));
  ['Matched', 'Not product-specific', 'Excluded'].forEach((l) => assert.equal(unit[l], 'ads', l));
  assert.equal(chips.find((m) => m[1] === 'conflict')[3], 'conflicts', 'the conflict chip reads `conflicts` (it used to read an undefined `conflict`)');
});
