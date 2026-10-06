// Pure regression tests for the V3 product-identity guard, phrase cleaning and
// promo guard. No database or network: a catalogue is built in memory and run
// through the real buildSuggestions + evaluateAutoMatch.
//   npm test
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused'; // pool is lazy; never connected here
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/lib/metaAdMatching');
const P = require('../src/lib/metaNameParsing');

const ctxFor = (names, extra = {}) => {
  const families = names.map((n, i) => ({ product_code: `W26T${String(i).padStart(4, '0')}`, product_name: n }));
  return {
    mappingByKey: new Map(), mappingCodesByProduct: new Map(), trustedPairs: new Map(), familyIndex: P.buildFamilyIndex(families), adSetupsByLabel: new Map(),
    families, familyByCode: new Map(families.map((f) => [f.product_code, f])), concepts: [], conceptByNorm: new Map(), creators: ['Mark'], creatorByNorm: new Map([['MARK', 'Mark']]),
    styles: [], styleByNorm: new Map(), styleById: new Map(), adSetups: [], adSetupByNorm: new Map(), adSetupById: new Map(), ...extra,
  };
};
const name = (prod, cat = 'TOPS', hook = 'HOOK') => `#1_26-WK01_01-01_${prod}_${cat}_${hook}_Video_Single_MARK_STYLING_Product`;
const evaluate = (ctx, prod, cat) => {
  const ad = { ad_name: name(prod, cat) };
  const built = M.buildSuggestions(ad, ctx);
  return { built, ev: M.evaluateAutoMatch(ad, built, ctx) };
};
// Only ONE generic-word sibling exists (the case where the old rule auto-linked wrongly).
const BASE = ['STXR 1/4 ZIP POLAR FLEECE', 'GLOBE PANEL HOOD SWEAT', 'HASHI 1/4 ZIP SHERPA FLEECE', 'RAIDER HEAVY WEIGHT TEE', 'DRIFT BOX FIT TEE',
  'ALPHA 1/4 ZIP FLEECE', 'BETA 1/4 ZIP FLEECE', 'GAMMA 1/4 ZIP FLEECE', 'DELTA PANEL HOOD', 'EPSILON PANEL HOOD', 'ZETA PANEL HOOD', 'ETA BOX FIT TEE', 'THETA BOX FIT TEE',
  'IOTA HEAVY WEIGHT TEE', 'KAPPA HEAVY WEIGHT TEE', 'LAMBDA SHERPA JACKET', 'MU SHERPA JACKET', 'NU SHERPA JACKET'];

test('HAVOK vs STXR: generic garment words must not auto-link a different product', () => {
  const { ev, built } = evaluate(ctxFor(BASE), 'HAVOK 1/4 ZIP POLAR FLEECE', '');
  assert.equal(ev.qualifies, false);
  assert.match(built.product_resolution.reason, /HAVOK/);
});

test('MAISON vs GLOBE: not auto-linked', () => {
  const { ev } = evaluate(ctxFor(BASE), 'MAISON PANEL HOOD SWEAT', '');
  assert.equal(ev.qualifies, false);
});

test('OFFCUT vs HASHI / MOTIF: not auto-linked while the OFFCUT family is absent; exact once present', () => {
  assert.equal(evaluate(ctxFor(BASE), 'OFFCUT 1/4 ZIP SHERPA FLEECE', '').ev.qualifies, false);
  assert.equal(evaluate(ctxFor([...BASE, 'MOTIF 1/4 ZIP SHERPA FLEECE']), 'OFFCUT 1/4 ZIP SHERPA FLEECE', '').ev.qualifies, false);
  const present = evaluate(ctxFor([...BASE, 'OFFCUT 1/4 ZIP SHERPA FLEECE']), 'OFFCUT 1/4 ZIP SHERPA FLEECE', '');
  assert.equal(present.ev.qualifies, true);
  assert.equal(present.ev.values.product.product_name, 'OFFCUT 1/4 ZIP SHERPA FLEECE');
});

test('RAIDER and DRIFT (same-family, product + category) still auto-link', () => {
  const r = evaluate(ctxFor(BASE), 'RAIDER', 'HEAVY WEIGHT TEES');
  assert.equal(r.ev.qualifies, true);
  assert.equal(r.ev.values.product.product_name, 'RAIDER HEAVY WEIGHT TEE');
  const d = evaluate(ctxFor(BASE), 'DRIFT', 'BOX FIT TEE');
  assert.equal(d.ev.qualifies, true);
  assert.equal(d.ev.values.product.product_name, 'DRIFT BOX FIT TEE');
});

test('abbreviation / plural normalisation still resolves (1/4 ZIP, TEES)', () => {
  const r = evaluate(ctxFor(['Offcut Quarter Zip Sherpa Fleece', ...BASE]), 'OFFCUT 1/4 ZIP SHERPA', 'FLEECE');
  assert.equal(r.ev.qualifies, true);
});

test('same-family partial phrase still auto-links (identity words all present)', () => {
  const r = evaluate(ctxFor([...BASE, 'REFRAIN HOOD SWEAT']), 'REFRAIN HOOD', '');
  assert.equal(r.ev.qualifies, true);
  assert.equal(r.ev.values.product.product_name, 'REFRAIN HOOD SWEAT');
});

test('phrase cleaning: leading "*" and " - COLOUR" suffix are ignored', () => {
  assert.equal(P.cleanProductPhrase('*SOHO CLUB TEE - BLOOD RED'), 'SOHO CLUB TEE');
  const r = evaluate(ctxFor([...BASE, 'SOHO CLUB TEE']), '*SOHO CLUB TEE - BLOOD RED', '');
  assert.equal(r.ev.qualifies, true);
  assert.equal(r.ev.values.product.product_name, 'SOHO CLUB TEE');
});

test('WAYNE HOCKEY JERSEY / WORLD CUP TEE with no family: stays in review, nothing linked', () => {
  for (const phrase of ['WAYNE HOCKEY JERSEY', 'ENGLAND WORLD CUP TEE', 'FRANCE WORLD CUP TEE']) {
    const { ev, built } = evaluate(ctxFor(BASE), phrase, '');
    assert.equal(ev.qualifies, false, phrase);
    assert.equal(built.suggestions.some((s) => s.field === 'product'), false, `${phrase} should have no product suggestion`);
  }
});

test('promo / concept phrases (HYPE, LIVE, SALE, BUNDLE, MYSTERY BOX) are never product-linked or product-suggested', () => {
  // even if a family happened to carry one of those words
  const ctx = ctxFor([...BASE, 'HYPE TEE', 'LIVE IN TEE', 'SALE HOOD']);
  for (const phrase of ['HYPE', 'LIVE', 'SALE', 'SALE BUNDLE', 'MYSTERY BOX']) {
    const { ev, built } = evaluate(ctx, phrase, 'TEE');
    assert.equal(ev.qualifies, false, phrase);
    assert.equal(built.suggestions.some((s) => s.field === 'product'), false, `${phrase} must not produce a product suggestion`);
    assert.equal(built.product_resolution.promo, true, phrase);
  }
  assert.equal(P.isPromoPhrase('BOX FIT TEE'), false);
  assert.equal(P.isPromoPhrase('RAIDER'), false);
});

test('exact-name matches are not affected by the guard', () => {
  const r = evaluate(ctxFor(BASE), 'RAIDER HEAVY WEIGHT TEE', '');
  assert.equal(r.ev.qualifies, true);
  assert.equal(M.AUTO_RULES_VERSION, 3);
});

test('human-owned SQL protects confirmed / manual / skipped / excluded / user-classified state', () => {
  for (const frag of ["'confirmed'", 'match_confirmed_at', "match_method = 'manual'", 'matched_ad_setup_id', 'skipped_at', 'excluded_from_intelligence', 'classified_by_user_id', 'creative_style_id']) {
    assert.ok(M.HUMAN_OWNED_SQL.includes(frag), frag);
  }
});
