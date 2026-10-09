// Pure (no database, no Meta) tests for batch 7: the approved concept list and the historical-spelling aliases.
// The seed in db/schema.sql is parsed and compared with the mapping table exactly as it was supplied, so the shipped data cannot drift from it.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused'; // pool is lazy; never connected here
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const vocab = require('../src/lib/metaMatchingVocab');
const inv = require('../src/lib/metaConceptInventory');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const code = (f) => read(f).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

// the table exactly as supplied: [historical, approved | null = removed, do not merge]
const TABLE = [
  ['STYLING', 'STYLING'], ['Styling', 'STYLING'], ['AESTHETIC STYLING', 'STYLING'], ['AESTHETIC STYLNG', 'STYLING'], ['WHITE WALL STYLING', 'STYLING'],
  ['INTERVIEW FIT CHECK', 'FIT CHECK'], ['WAREHOUSE TALK THROUGH', null], ['REPLY TO COMMENT', 'HATE COMMENT'], ['HATE COMMENT', 'HATE COMMENT'],
  ['E-COMM GRAPHIC', 'E-COMM'], ['E-COMM SPLIT', 'E-COMM'], ['CONCRETE FLAT LAY', 'CONCRETE FLATLAY'], ['CONCRETE FLAT LAYS', 'CONCRETE FLATLAY'],
  ['CONCRETE FLATLAY', 'CONCRETE FLATLAY'], ['*CONCRETE FLATLAY', 'CONCRETE FLATLAY'], ['Concrete Flatlay', 'CONCRETE FLATLAY'], ['CONCRETE FLAT LAY VIDEO', 'CONCRETE FLATLAY'],
  ['POSTER DROP', 'POSTER'], ['CAMPAIGN VIDEO', 'CAMPAIGN'], ['CAMPAIGN', 'CAMPAIGN'], ['GWP - GRAPHIC', 'GWP'], ['GWP - VIDEO', 'GWP'], ['NOTES', 'NOTES APP'],
  ['GREEN SCREEN VIDEO', 'GREEN SCREEN'], ['GREEN SCREEN TALK THROUGH', 'GREEN SCREEN'], ['UGC VIDEO', 'UGC'], ['EGC VIDEO', 'UGC'], ['ITW', 'IN THE WILD'],
  ['AESTHETIC IN THE WILD', 'IN THE WILD'], ['SNAPCHAT FILTER', 'SNAPCHAT'], ['TRANSITION', 'MEME TRANSITION'], ['RUG DROP TRY-ON', 'RUG DROP'], ['RUG DROP TRY ON', 'RUG DROP'],
  ['BTS VS THE SHOOT', 'BTS VS THE SHOT'], ['TALKTHROUGH', 'TALK THROUGH'], ['Talkthrough', 'TALK THROUGH'], ['FLATLAY PHOTO', 'FLAT LAY'],
];
const APPROVED = ['STYLING', 'FIT CHECK', 'HATE COMMENT', 'E-COMM', 'CONCRETE FLATLAY', 'POSTER', 'CAMPAIGN', 'GWP', 'NOTES APP', 'GREEN SCREEN', 'UGC', 'IN THE WILD', 'SNAPCHAT', 'MEME TRANSITION', 'RUG DROP', 'BTS VS THE SHOT', 'TALK THROUGH', 'FLAT LAY'];

// parse the shipped seed
const sql = read('db/schema.sql');
const seed = sql.slice(sql.indexOf('-- Approved Ad Matching concepts'));
const approvedSeed = [...seed.matchAll(/\('concept', '((?:[^']|'')+)', '((?:[^']|'')+)'\)/g)].map((m) => ({ name: m[1].replace(/''/g, "'"), key: m[2].replace(/''/g, "'") }));
const aliasBlock = seed.slice(seed.indexOf('INSERT INTO meta_matching_concept_aliases'));
const aliasSeed = [...aliasBlock.matchAll(/\('((?:[^']|'')+)', '((?:[^']|'')+)', (NULL|'(?:[^']|'')+'), (true|false)\)/g)]
  .map((m) => ({ alias: m[1].replace(/''/g, "'"), alias_key: m[2].replace(/''/g, "'"), approved_name: m[3] === 'NULL' ? null : m[3].slice(1, -1).replace(/''/g, "'"), removed: m[4] === 'true' }));
const resolver = () => vocab.makeConceptResolver(approvedSeed.map((a, i) => ({ name: a.name, vocab_id: i + 1, concept_type_id: null })), aliasSeed);

test('seed: exactly the 18 approved concepts, spelled as supplied, with consistent keys', () => {
  assert.deepEqual(approvedSeed.map((a) => a.name).sort(), [...APPROVED].sort());
  for (const a of approvedSeed) assert.equal(a.key, vocab.keyOf(a.name), `${a.name} key`);
  assert.equal(new Set(approvedSeed.map((a) => a.key)).size, 18, 'no case-insensitive duplicates');
  assert.ok(!approvedSeed.some((a) => /WAREHOUSE/i.test(a.name)), 'the removed concept is not on the approved list');
});
test('seed: every alias key matches the app\'s own key function; only WAREHOUSE TALK THROUGH is removed; nothing is its own alias', () => {
  assert.ok(aliasSeed.length >= 25);
  for (const a of aliasSeed) assert.equal(a.alias_key, vocab.keyOf(a.alias), a.alias);
  assert.equal(new Set(aliasSeed.map((a) => a.alias_key)).size, aliasSeed.length, 'alias keys are unique');
  assert.deepEqual(aliasSeed.filter((a) => a.removed).map((a) => a.alias), ['WAREHOUSE TALK THROUGH']);
  for (const a of aliasSeed) assert.ok(a.removed ? a.approved_name === null : APPROVED.includes(a.approved_name), `${a.alias} -> ${a.approved_name}`);
  for (const a of aliasSeed) assert.ok(!APPROVED.some((x) => vocab.keyOf(x) === a.alias_key), `${a.alias} is an approved concept, not an alias`);
});
test('mapping: every one of the supplied rows resolves exactly as supplied', () => {
  const resolve = resolver();
  for (const [hist, appr] of TABLE) {
    const r = resolve(hist);
    if (appr === null) { assert.equal(r.status, 'removed', hist); assert.equal(r.name, null, hist); } else { assert.equal(r.name, appr, hist); assert.ok(['approved', 'alias'].includes(r.status), hist); }
  }
  assert.equal(TABLE.length, 37);
});
test('mapping: case and spacing never matter; unknown text is left exactly as it is; nothing is guessed', () => {
  const resolve = resolver();
  assert.equal(resolve('  styling ').name, 'STYLING');
  assert.equal(resolve('aesthetic    styling').status, 'alias');
  assert.deepEqual([resolve('SOME NEW IDEA').status, resolve('SOME NEW IDEA').name], ['unlisted', 'SOME NEW IDEA']);
  assert.equal(resolve('').status, 'empty');
  assert.equal(resolve('STYLINGS').status, 'unlisted', 'a near-miss that is not in the table is NOT auto-corrected');
  assert.equal(resolve('FLAT LAY').name, 'FLAT LAY');
  assert.equal(resolve('CONCRETE FLATLAY').name, 'CONCRETE FLATLAY');
  assert.notEqual(resolve('FLATLAY PHOTO').name, resolve('CONCRETE FLAT LAY').name, 'FLAT LAY and CONCRETE FLATLAY remain separate concepts');
  assert.equal(resolve('GREEN SCREEN TALK THROUGH').name, 'GREEN SCREEN');
  assert.equal(resolve('TALKTHROUGH').name, 'TALK THROUGH');
  assert.equal(resolve('WAREHOUSE TALK THROUGH').status, 'removed', 'removed means removed: not merged into TALK THROUGH or anything else');
});
test('seed SQL is additive: it writes only the two vocabulary tables and never touches an ad or a classification', () => {
  assert.doesNotMatch(seed, /\b(UPDATE|DELETE|TRUNCATE|DROP TABLE|ALTER TABLE)\b/i);
  assert.doesNotMatch(seed, /INSERT INTO (?!meta_matching_vocab|meta_matching_concept_aliases)/i);
  assert.match(seed, /ON CONFLICT \(kind, name_key\) DO NOTHING/);
  assert.match(seed, /ON CONFLICT \(alias_key\) DO NOTHING/);
  assert.match(seed, /CHECK \(\(removed AND approved_name IS NULL\) OR \(NOT removed AND approved_name IS NOT NULL\)\)/);
});

// ── the list that is offered, and where aliases are applied ──
test('Ad Matching offers the approved vocabulary, not the concept_types records', () => {
  const src = code('src/lib/metaMatchingVocab.js');
  const list = src.slice(src.indexOf('async function listConcepts'), src.indexOf('function makeConceptResolver'));
  assert.match(list, /FROM meta_matching_vocab WHERE kind = 'concept'/);
  assert.match(list, /FROM concept_types WHERE active/, 'concept_types is consulted only to attach an id to an approved concept of the same name');
  assert.doesNotMatch(list, /\.\.\.types\.rows\.map/, 'concept_types rows are not themselves offered');
  assert.doesNotMatch(src, /INSERT INTO concept_types|UPDATE concept_types|DELETE FROM concept_types/);
});
test('aliases are applied only when a suggestion or inventory row is READ; no classification or stored suggestion is rewritten', () => {
  const lib = code('src/lib/metaAdMatching.js');
  const mapper = lib.slice(lib.indexOf('function mapConceptLabel'), lib.indexOf('async function getQueue'));
  assert.doesNotMatch(mapper, /\b(INSERT|UPDATE|DELETE)\b|pool\.query/);
  const batch = lib.slice(lib.indexOf('async function getReviewBatch'), lib.indexOf('async function searchAdSetups'));
  assert.match(batch, /conceptResolve\(c\.value_label\)/);
  assert.match(batch, /m\.status === 'removed'\) continue/, 'a removed concept is skipped, never suggested');
  assert.doesNotMatch(batch, /\b(INSERT|UPDATE|DELETE)\b/);
  assert.match(lib, /suggestions\.concept = mapConceptSuggestions\(await vocab\.loadConceptResolver\(\), suggestions\.concept\)/);
  const invSrc = code('src/lib/metaConceptInventory.js');
  assert.doesNotMatch(invSrc, /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b/i, 'the inventory stays read-only');
  assert.doesNotMatch(lib.slice(lib.indexOf('async function reapplyTrustedPair'), lib.indexOf('async function ensureAd')), /vocab\./, 'no matching rule was touched');
});
test('confirming a historical spelling saves the approved concept; unlisted text still saves as typed', () => {
  const lib = code('src/lib/metaAdMatching.js');
  const confirm = lib.slice(lib.indexOf('async function confirmMapping'), lib.indexOf('async function reapplyTrustedPair'));
  assert.match(confirm, /known\.status === 'approved' \|\| known\.status === 'alias'/);
  assert.match(confirm, /else conceptLabel = typed/, 'legacy text is kept as typed');
});

// ── inventory: approved-as + roll-up (pure) ──
test('inventory: each spelling shows its approved concept, spellings stay separate, and the roll-up is the SQL\'s distinct-creative figure', () => {
  const approved = APPROVED.map((n) => ({ name: n, origin: 'approved', active: true }));
  const usage = [
    { concept: 'Styling', source: null, creatives: 2, ads: 3 }, { concept: 'AESTHETIC STYLING', source: null, creatives: 1, ads: 1 },
    { concept: 'WAREHOUSE TALK THROUGH', source: null, creatives: 4, ads: 6 }, { concept: 'TOTALLY NEW', source: null, creatives: 1, ads: 1 },
  ];
  const rollup = [{ approved: 'STYLING', removed: false, creatives: 2, ads: 4, spellings: ['Styling', 'AESTHETIC STYLING'] }, { approved: null, removed: true, creatives: 4, ads: 6, spellings: ['WAREHOUSE TALK THROUGH'] }, { approved: null, removed: false, creatives: 1, ads: 1, spellings: ['TOTALLY NEW'] }];
  const out = inv.buildInventory({ usage, setups: [], vocabulary: approved, aliases: aliasSeed, rollup });
  const row = (n) => out.concepts.find((c) => c.concept === n);
  assert.deepEqual(row('Styling').approved_as, { status: 'approved', name: 'STYLING' });
  assert.deepEqual(row('AESTHETIC STYLING').approved_as, { status: 'alias', name: 'STYLING' });
  assert.equal(row('WAREHOUSE TALK THROUGH').approved_as.status, 'removed');
  assert.equal(row('TOTALLY NEW').approved_as.status, 'none');
  assert.ok(row('Styling') && row('AESTHETIC STYLING'), 'spellings are listed separately by exact text');
  assert.equal(out.approved_rollup.length, 18);
  assert.deepEqual(out.approved_rollup.find((r) => r.concept === 'STYLING'), { concept: 'STYLING', creatives: 2, ads: 4, spellings: ['AESTHETIC STYLING', 'Styling'] });
  assert.equal(out.removed_rollup.creatives, 4);
  assert.equal(out.unmapped_rollup.spellings[0], 'TOTALLY NEW');
  assert.equal(out.totals.approved_concepts, 18);
  assert.equal(out.totals.spellings_mapped_to_approved, 1);
  assert.equal(out.totals.spellings_removed, 1);
  assert.equal(out.totals.spellings_unmapped, 1);
  assert.match(inv.inventoryCsv(out).split('\n')[0], /approved_as_status,approved_as,variants_of$/);
});
