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
// the FINAL approved vocabulary: 40 concepts in 7 groups, in the approved order
const GROUPS = [
  ['STYLING & TRY-ONS', ['STYLING', 'TRY ON', 'FACELESS TRY ON', 'RUG TRY ON', 'IKEA STORE TRY ON', 'FLAT LAY TO TRY ON', 'FIT CHECK']],
  ['TALK THROUGHS & SPEAKING', ['TALK THROUGH', 'ROLL BAR TALK THROUGH', 'HATE COMMENT', 'VOICEOVER', 'FOUNDER VIDEO']],
  ['FLAT LAYS & PRODUCT IMAGERY', ['CONCRETE FLATLAY', 'FLAT LAY', 'CONCRETE DROP', 'CLOTHES DROP', 'RUG DROP', 'E-COMM']],
  ['GRAPHICS & STATIC CREATIVES', ['TOP PICKS', 'RANGE LAYOUT', 'GRAPHIC', 'GIF', 'BILLBOARD', 'POSTER']],
  ['CAMPAIGNS & PROMOTIONS', ['NOTES APP', 'DPA', 'CAMPAIGN', 'GWP', 'AD BREAK', 'APOLOGY', 'HUMOUR']],
  ['UGC, ORGANIC & LIFESTYLE', ['UGC', 'ORGANIC REEL', 'IN THE WILD', 'GREEN SCREEN', 'SNAPCHAT', 'KMART']],
  ['TRANSITIONS & VIDEO CONCEPTS', ['MEME TRANSITION', 'BTS VS THE SHOT', 'AI ADS']],
];
const APPROVED = GROUPS.flatMap(([, cs]) => cs);

// parse the shipped seed
const sql = read('db/schema.sql');
const seed = sql.slice(sql.indexOf('-- Approved Ad Matching concepts'));
const approvedSeed = [...seed.matchAll(/\('concept', '((?:[^']|'')+)', '((?:[^']|'')+)', '((?:[^']|'')+)', (\d+), (\d+)\)/g)]
  .map((m) => ({ name: m[1].replace(/''/g, "'"), key: m[2].replace(/''/g, "'"), group: m[3].replace(/''/g, "'"), group_order: Number(m[4]), sort_order: Number(m[5]) }));
const aliasBlock = seed.slice(seed.indexOf('INSERT INTO meta_matching_concept_aliases'));
const aliasSeed = [...aliasBlock.matchAll(/\('((?:[^']|'')+)', '((?:[^']|'')+)', (NULL|'(?:[^']|'')+'), (true|false)\)/g)]
  .map((m) => ({ alias: m[1].replace(/''/g, "'"), alias_key: m[2].replace(/''/g, "'"), approved_name: m[3] === 'NULL' ? null : m[3].slice(1, -1).replace(/''/g, "'"), removed: m[4] === 'true' }));
const resolver = () => vocab.makeConceptResolver(approvedSeed.map((a, i) => ({ name: a.name, vocab_id: i + 1, concept_type_id: null })), aliasSeed);

test('seed: EXACTLY 40 approved concepts, spelled as supplied, with consistent keys', () => {
  assert.equal(APPROVED.length, 40);
  assert.equal(approvedSeed.length, 40);
  assert.deepEqual(approvedSeed.map((a) => a.name), APPROVED, 'same 40, same order');
  for (const a of approvedSeed) assert.equal(a.key, vocab.keyOf(a.name), `${a.name} key`);
  assert.equal(new Set(approvedSeed.map((a) => a.key)).size, 40, 'no case-insensitive duplicates');
  assert.ok(!approvedSeed.some((a) => /WAREHOUSE|AESTHETIC STYLING|^TRANSITION$|^ITW$|^NOTES$/i.test(a.name)), 'removed concepts and historical spellings are not on the approved list');
  assert.ok(approvedSeed.some((a) => a.name === 'BTS VS THE SHOT') && !approvedSeed.some((a) => /BTS VS THE SHOOT/.test(a.name)), 'BTS VS THE SHOT is the approved spelling');
});
test('seed: EXACTLY 7 groups in the approved order, each concept in its approved group and position', () => {
  const groups = [...new Set(approvedSeed.map((a) => a.group))];
  assert.deepEqual(groups, GROUPS.map(([g]) => g));
  assert.equal(groups.length, 7);
  assert.deepEqual(GROUPS.map(([, cs]) => cs.length), [7, 5, 6, 6, 7, 6, 3]);
  GROUPS.forEach(([g, cs], gi) => {
    const inGroup = approvedSeed.filter((a) => a.group === g);
    assert.deepEqual(inGroup.map((a) => a.name), cs, g);
    for (const a of inGroup) assert.equal(a.group_order, gi + 1, `${a.name} group order`);
  });
  approvedSeed.forEach((a, i) => assert.equal(a.sort_order, i + 1, `${a.name} position`));
  assert.match(seed, /ALTER TABLE meta_matching_vocab ADD COLUMN IF NOT EXISTS group_name/, 'grouping columns are additive');
  assert.match(seed, /ON CONFLICT \(kind, name_key\) DO UPDATE SET group_name = EXCLUDED\.group_name, group_order = EXCLUDED\.group_order, sort_order = EXCLUDED\.sort_order;/, 'a re-run only (re)assigns group + position, never the name');
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
  assert.doesNotMatch(seed, /\b(DELETE|TRUNCATE|DROP TABLE)\b/i);
  assert.deepEqual([...seed.matchAll(/ALTER TABLE (\w+)/g)].map((m) => m[1]), ['meta_matching_vocab', 'meta_matching_vocab', 'meta_matching_vocab'], 'only the vocabulary table is altered, additively');
  assert.doesNotMatch(seed.replace(/ON CONFLICT[^;]*;/g, ''), /\bUPDATE\b/i, 'no UPDATE of ads or classifications');
  assert.doesNotMatch(seed, /INSERT INTO (?!meta_matching_vocab|meta_matching_concept_aliases)/i);
  assert.match(seed, /ON CONFLICT \(kind, name_key\) DO UPDATE SET group_name/, 'baseline seed only assigns group + position on conflict');
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
  assert.match(lib, /suggestions\.concept = mapConceptSuggestions\(conceptResolve, suggestions\.concept\)/);
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
  const approved = GROUPS.flatMap(([g, cs]) => cs.map((n) => ({ name: n, origin: 'approved', active: true, group: g })));
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
  assert.equal(out.approved_rollup.length, 40);
  assert.deepEqual(out.approved_rollup.find((r) => r.concept === 'STYLING'), { concept: 'STYLING', group: 'STYLING & TRY-ONS', position: null, creatives: 2, ads: 4, spellings: ['AESTHETIC STYLING', 'Styling'] });
  assert.equal(out.removed_rollup.creatives, 4);
  assert.equal(out.unmapped_rollup.spellings[0], 'TOTALLY NEW');
  assert.equal(out.totals.approved_concepts, 40);
  assert.equal(out.totals.spellings_mapped_to_approved, 1);
  assert.equal(out.totals.spellings_removed, 1);
  assert.equal(out.totals.spellings_unmapped, 1);
  assert.match(inv.inventoryCsv(out).split('\n')[0], /approved_as_status,approved_as,variants_of$/);
});

// ── grouped dropdowns (both editors), search, keyboard, legacy display ──
test('both editors use the SAME grouped concept picker and the same vocabulary source', () => {
  const app = code('public/app.js');
  const full = app.slice(app.indexOf('const conceptPicker = mmPicker'), app.indexOf('const creatorPicker = mmPicker'));
  const rapid = app.slice(app.indexOf("mmPicker(host('concept')"), app.indexOf("mmPicker(host('creator')"));
  for (const [name, src] of [['full editor', full], ['rapid editor', rapid]]) {
    assert.match(src, /groupOf: \(x\) => x\.group/, `${name}: grouped`);
    assert.match(src, /options: options\.concepts\.map\(mmConceptItem\)/, `${name}: the same options list`);
    assert.match(src, /addNew: mmAddConcept/, `${name}: can still add a concept`);
    assert.match(src, /mmConceptPill\(/, `${name}: assigned concept shown through the same display rule`);
  }
  assert.equal((app.match(/await api\('\/meta-ad-matching\/options'\)|api\('\/meta-ad-matching\/options'\)/g) || []).length, 1, 'one options source');
});
test('picker: group headings are never options; search covers every concept and historical spellings; arrows + Enter work', () => {
  const app = code('public/app.js');
  const picker = app.slice(app.indexOf('function mmPicker'), app.indexOf('// ── Matching workspace'));
  assert.match(picker, /class="mm-opt-group" role="presentation"/, 'headings are presentational');
  assert.doesNotMatch(picker.slice(picker.indexOf('class="mm-opt-group"'), picker.indexOf('class="mm-opt-group"') + 160), /data-e=/, 'a heading carries no entry index, so it cannot be chosen');
  assert.match(picker, /o\.dataset\.e === undefined\) return/, 'a click on a heading does nothing');
  assert.match(picker, /return grouped \? rows : rows\.slice\(0, 8\)/, 'a grouped list shows every match (not capped at 8)');
  assert.match(picker, /\(o\.aliases \|\| \[\]\)\.find/, 'a historical spelling finds its approved concept');
  assert.match(picker, /e\.key === 'ArrowDown' \|\| e\.key === 'ArrowUp'/);
  assert.match(picker, /choose\(entries\[active\] \|\| null\)/);
  assert.match(picker, /role="combobox"/);
});
test('assigned concepts: aliases display as the approved concept, unmapped / removed stay visible as legacy; nothing is rewritten', () => {
  const lib = code('src/lib/metaAdMatching.js');
  const disp = lib.slice(lib.indexOf('function displayAssignedConcept'), lib.indexOf('function mapConceptSuggestions'));
  assert.match(disp, /status === 'alias'\) return \{ label: m\.name, legacy: false, mapped_from: stored/);
  assert.match(disp, /return \{ label: stored, legacy: true, mapped_from: null, removed: m\.status === 'removed' \}/);
  assert.doesNotMatch(disp, /\b(INSERT|UPDATE|DELETE)\b|pool\.query/);
  const app = code('public/app.js');
  assert.match(app, /confirmed_concept_legacy \? ' <small class="mm-legacy"/, 'the table flags legacy concepts');
  assert.match(app, /tag: c\.removed \? 'legacy · removed' : 'legacy'/, 'the editor pill says legacy / removed');
});
