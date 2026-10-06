// V4.1 regression tests: the SAME WNDRR product family sold under several
// ApparelMagic product codes / seasons is ONE logical family for matching, while
// genuinely different families that an ad cannot tell apart stay in Needs Review.
// Pure (no database / network): real buildCatalogue + collapseFamilies + matcher.
//   npm test
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused'; // pool is lazy; never connected here
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/lib/metaAdMatching');
const C = require('../src/lib/metaMatchingCatalogue');

// The production pattern: names that exist locally (current code) AND under older season codes in ApparelMagic.
const DUP_NAMES = ['CREDIT PANEL HEAVY WEIGHT TEE', 'ATELIER RUGBY SWEAT', 'PALADIN PANEL BOX FIT TEE', 'INSTITUTE HOOD SWEAT', 'REVIVAL HEAVY WEIGHT TEE',
  'LOCAL BOX FIT TEE', 'HEXED BOX FIT TEE', 'SHODO BOX FIT TEE', 'BORDERLESS BOX FIT TEE', 'REFRAIN HOOD SWEAT', 'CHANNEL PANEL BOX FIT TEE'];
// Other local products (also give the generic garment words >= 3 distinct lead words, like the real catalogue).
const OTHER_LOCAL = ['STXR 1/4 ZIP POLAR FLEECE', 'GLOBE PANEL HOOD SWEAT', 'RAIDER HEAVY WEIGHT TEE', 'ALPHA 1/4 ZIP FLEECE', 'BETA 1/4 ZIP FLEECE', 'GAMMA 1/4 ZIP FLEECE',
  'DELTA PANEL HOOD', 'EPSILON PANEL HOOD', 'ZETA PANEL HOOD', 'ETA BOX FIT TEE', 'THETA BOX FIT TEE', 'IOTA HEAVY WEIGHT TEE', 'KAPPA HEAVY WEIGHT TEE'];
const AM_ONLY = ['HAVOK 1/4 ZIP POLAR FLEECE', 'MAISON PANEL HOOD', 'WAYNE HOCKEY JERSEY', 'ENGLAND WORLD CUP TEE', 'FRANCE WORLD CUP TEE', 'OFFCUT 1/4 ZIP SHERPA FLEECE'];

// style code = W<yy><2 letters><3 digits><3 letters>; product code = first 8 characters
const styleCode = (yy, i) => `W${yy}${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}001BLK`;

const localStyles = [...DUP_NAMES, ...OTHER_LOCAL].map((n, i) => ({ style_code: styleCode('26', i), name: n }));
const idxOf = (n) => [...DUP_NAMES, ...OTHER_LOCAL].indexOf(n);
const amMap = (entries) => new Map(entries.map(([c, n, extra]) => [c, { productName: n, ...(extra || {}) }]));
function amEntries() {
  const rows = [];
  [...DUP_NAMES, ...OTHER_LOCAL].forEach((n, i) => { rows.push([styleCode('26', i), n]); if (DUP_NAMES.includes(n)) { rows.push([styleCode('25', i), n], [styleCode('24', i), n]); } });
  AM_ONLY.forEach((n, i) => { rows.push([styleCode('25', 100 + i), n]); if (i % 2 === 0) rows.push([styleCode('24', 100 + i), n]); });
  return rows;
}
const catalogue = C.buildCatalogue({ amCatalogue: amMap(amEntries()), localStyles });
const logical = C.collapseFamilies(catalogue.families);

const mkCtx = (families, extra = {}) => ({
  mappingByKey: new Map(), mappingCodesByProduct: new Map(), trustedPairs: new Map(), adSetupsByLabel: new Map(), ...M.familyStructures(families),
  concepts: [], conceptByNorm: new Map(), creators: ['Mark'], creatorByNorm: new Map([['MARK', 'Mark']]),
  styles: [], styleByNorm: new Map(), styleById: new Map(), adSetups: [], adSetupByNorm: new Map(), adSetupById: new Map(), ...extra,
});
// V3 = the local styles only, exactly as listProductFamilies would return them (no member_codes, no collapsing).
const v3Local = [...DUP_NAMES, ...OTHER_LOCAL].map((n) => ({ product_code: styleCode('26', idxOf(n)).slice(0, 8), product_name: n }));
const V3 = mkCtx(v3Local);
const V4 = mkCtx(logical);
const adName = (prod, cat = 'TOPS') => `#1_26-WK01_01-01_${prod}_${cat}_HOOK_Video_Single_MARK_STYLING_Product`;
const evaluate = (ctx, prod, cat) => { const ad = { ad_name: adName(prod, cat) }; const built = M.buildSuggestions(ad, ctx); return { built, ev: M.evaluateAutoMatch(ad, built, ctx) }; };
const localCode = (n) => styleCode('26', idxOf(n)).slice(0, 8);

test('premise: before collapsing, a same-name product under 3 codes is a 3-way tie (this was the V4 loss)', () => {
  const raw = mkCtx(catalogue.families); // one family per CODE, as in the snapshot rows
  const { ev, built } = evaluate(raw, 'CREDIT PANEL HEAVY WEIGHT TEE');
  assert.equal(ev.qualifies, false);
  assert.equal(built.product_resolution.reason, 'More than one plausible product family');
});

test('1. same canonical name under several ApparelMagic codes: an explicit ad name auto-matches the logical family', () => {
  DUP_NAMES.forEach((n) => {
    const { ev } = evaluate(V4, n);
    assert.equal(ev.qualifies, true, n);
    assert.equal(ev.values.product.product_name, n);
    assert.equal(ev.auto_fields.product.basis, 'catalogue_exact');
  });
});

test('1b. every underlying product code is retained as a member / alias for traceability', () => {
  const { ev } = evaluate(V4, 'CREDIT PANEL HEAVY WEIGHT TEE');
  const i = idxOf('CREDIT PANEL HEAVY WEIGHT TEE');
  const members = [styleCode('24', i), styleCode('25', i), styleCode('26', i)].map((c) => c.slice(0, 8)).sort();
  assert.deepEqual(ev.auto_fields.product.member_codes, members);
  members.forEach((c) => assert.equal(V4.familyByCode.get(c).product_name, 'CREDIT PANEL HEAVY WEIGHT TEE')); // each old code resolves to the logical family
  assert.equal(logical.reduce((n, f) => n + f.member_codes.length, 0), catalogue.families.length); // nothing dropped
});

test('2. the same family across different years is not ambiguous because of year / code', () => {
  const am = amMap([[styleCode('23', 300), 'NOMAD SHERPA JACKET'], [styleCode('24', 301), 'NOMAD SHERPA JACKET'], [styleCode('25', 302), 'NOMAD SHERPA JACKET'], [styleCode('26', 303), 'NOMAD SHERPA JACKET'], ...amEntries().map(([c, n]) => [c, n])]);
  const cat = C.buildCatalogue({ amCatalogue: am, localStyles });
  const ctx = mkCtx(C.collapseFamilies(cat.families));
  const { ev } = evaluate(ctx, 'NOMAD SHERPA JACKET');
  assert.equal(ev.qualifies, true);
  assert.equal(ev.auto_fields.product.member_codes.length, 4);
});

test('2b. the representative is deterministic and NOT "newest year wins" (input order never matters)', () => {
  const rows = [[styleCode('26', 310), 'ORBIT TRACK SHORT'], [styleCode('23', 311), 'ORBIT TRACK SHORT'], [styleCode('25', 312), 'ORBIT TRACK SHORT'], ...amEntries()];
  const a = C.collapseFamilies(C.buildCatalogue({ amCatalogue: amMap(rows), localStyles }).families);
  const b = C.collapseFamilies(C.buildCatalogue({ amCatalogue: amMap([...rows].reverse()), localStyles }).families);
  const pick = (list) => list.find((f) => f.product_name === 'ORBIT TRACK SHORT');
  assert.equal(pick(a).product_code, pick(b).product_code);
  assert.equal(pick(a).product_code, styleCode('23', 311).slice(0, 8)); // lowest code (all else equal) -- not the newest 26
  assert.notEqual(pick(a).product_code, styleCode('26', 310).slice(0, 8));
});

test('2c. a code the app already knows (local style) is the representative, so existing links do not move', () => {
  DUP_NAMES.forEach((n) => assert.equal(logical.find((f) => f.product_name === n).product_code, localCode(n), n));
});

test('3. genuinely different names the phrase cannot tell apart stay in Needs Review', () => {
  const am = amMap([[styleCode('26', 400), 'VERTEX PANEL HOOD'], [styleCode('25', 401), 'VERTEX PANEL HOOD'], [styleCode('26', 402), 'VERTEX PANEL HOODIE'], ...amEntries()]);
  const ctx = mkCtx(C.collapseFamilies(C.buildCatalogue({ amCatalogue: am, localStyles }).families));
  const { ev, built } = evaluate(ctx, 'VERTEX PANEL');
  assert.equal(ev.qualifies, false);
  assert.equal(built.product_resolution.reason, 'More than one plausible product family');
  // ... but each of those two products by its own full name is still unambiguous
  assert.equal(evaluate(ctx, 'VERTEX PANEL HOOD').ev.qualifies, true);
  assert.equal(evaluate(ctx, 'VERTEX PANEL HOODIE').ev.qualifies, true);
});

test('3b. different names are never merged by collapsing (word order and extra words matter)', () => {
  const fams = C.collapseFamilies([
    { product_code: 'W26AA001', product_name: 'CREDIT PANEL TEE', colourways: 1, source: 'apparelmagic' },
    { product_code: 'W26AB001', product_name: 'CREDIT PANEL BOX TEE', colourways: 1, source: 'apparelmagic' },
    { product_code: 'W25AC001', product_name: 'Credit Panel Tees', colourways: 2, source: 'apparelmagic' }, // case + plural only
    { product_code: 'W26AD001', product_name: '', colourways: 1, source: 'apparelmagic' }, // unnameable: never grouped
    { product_code: 'W26AE001', product_name: '', colourways: 1, source: 'apparelmagic' },
  ]);
  assert.equal(fams.length, 4);
  const merged = fams.find((f) => f.member_codes.length > 1);
  assert.deepEqual(merged.member_codes, ['W25AC001', 'W26AA001']);
  assert.deepEqual(merged.name_variants, ['CREDIT PANEL TEE', 'Credit Panel Tees']);
});

test('4. HAVOK resolves to HAVOK, never STXR', () => {
  const { ev } = evaluate(V4, 'HAVOK 1/4 ZIP POLAR FLEECE', '');
  assert.equal(ev.qualifies, true);
  assert.equal(ev.values.product.product_name, 'HAVOK 1/4 ZIP POLAR FLEECE');
  const v3 = evaluate(V3, 'HAVOK 1/4 ZIP POLAR FLEECE', ''); // V3 (no AM catalogue): blocked, never linked to STXR
  assert.equal(v3.ev.qualifies, false);
});

test('5. MAISON resolves to MAISON, never GLOBE', () => {
  const { ev } = evaluate(V4, 'MAISON PANEL HOOD', '');
  assert.equal(ev.qualifies, true);
  assert.equal(ev.values.product.product_name, 'MAISON PANEL HOOD');
  assert.equal(evaluate(V3, 'MAISON PANEL HOOD', '').ev.qualifies, false);
});

test('6. OFFCUT, WAYNE, ENGLAND and FRANCE keep resolving to their own families', () => {
  ['OFFCUT 1/4 ZIP SHERPA FLEECE', 'WAYNE HOCKEY JERSEY', 'ENGLAND WORLD CUP TEE', 'FRANCE WORLD CUP TEE'].forEach((n) => {
    const { ev } = evaluate(V4, n, '');
    assert.equal(ev.qualifies, true, n);
    assert.equal(ev.values.product.product_name, n);
  });
});

test('7. every correct V3 auto-match survives with the SAME product code (duplicate codes never cost an auto-match)', () => {
  let checked = 0;
  [...DUP_NAMES, ...OTHER_LOCAL].forEach((n) => {
    const a = evaluate(V3, n);
    if (!a.ev.qualifies) return;
    const b = evaluate(V4, n);
    assert.equal(b.ev.qualifies, true, `${n} lost`);
    assert.equal(b.ev.values.product.product_code, a.ev.values.product.product_code, `${n} moved`);
    checked += 1;
  });
  assert.ok(checked >= DUP_NAMES.length);
});

test('7b. human evidence on an older code of the same family is not a "conflict" with the exact name match', () => {
  const n = 'CREDIT PANEL HEAVY WEIGHT TEE';
  const old = styleCode('24', idxOf(n)).slice(0, 8);
  const ctx = mkCtx(logical, { trustedPairs: new Map([[`${n}||TOPS`, new Map([[old, 3]])]]) });
  const { ev, built } = evaluate(ctx, n);
  assert.equal(ev.qualifies, true, built.product_resolution.reason);
  assert.equal(built.product_resolution.basis, 'confirmed_pair');
  assert.equal(ev.values.product.product_code, old); // the person's chosen code is kept
});

test('V3 path is untouched: local families carry no members and never collapse', () => {
  assert.equal(V3.families.length, DUP_NAMES.length + OTHER_LOCAL.length);
  assert.ok(V3.families.every((f) => !f.member_codes));
  assert.equal(V3.familyByCode.size, V3.families.length);
});

test('catalogue stats report the collapse so the preview can be audited', () => {
  assert.equal(catalogue.stats.logical_families, logical.length);
  assert.equal(catalogue.stats.collapsed_groups, DUP_NAMES.length + Math.ceil(AM_ONLY.length / 2));
  assert.ok(catalogue.stats.collapsed_groups_top.every((g) => g.codes.length > 1 && g.representative));
  assert.equal(catalogue.fingerprint, C.buildCatalogue({ amCatalogue: amMap(amEntries().reverse()), localStyles }).fingerprint); // fingerprint still per code, order-independent
});
