// Pure regression tests for V4: the matching catalogue builder / fingerprint /
// validation and the token-indexed phrase matcher. No database or network.
//   npm test
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused'; // pool is lazy; never connected here
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/lib/metaAdMatching');
const P = require('../src/lib/metaNameParsing');
const C = require('../src/lib/metaMatchingCatalogue');

const amRow = (name) => ({ productName: name });
const amMap = (rows) => new Map(rows.map(([code, name]) => [code, amRow(name)]));
const sig = (cands) => JSON.stringify(cands.map((c) => [c.family.product_code, c.confidence, c.kind, c.ties, c.rank]));

test('buildCatalogue groups colourways into one family per 8-char product code', () => {
  const b = C.buildCatalogue({ amCatalogue: amMap([['W26HV001BLK', 'HAVOK 1/4 ZIP POLAR FLEECE'], ['W26HV001RED', 'HAVOK 1/4 ZIP POLAR FLEECE']]), localStyles: [] });
  assert.equal(b.families.length, 1);
  assert.equal(b.families[0].product_code, 'W26HV001');
  assert.equal(b.families[0].colourways, 2);
});

test('buildCatalogue: AM name wins, local-only styles are merged, odd codes are excluded and counted', () => {
  const b = C.buildCatalogue({
    amCatalogue: amMap([['W26HV001BLK', 'HAVOK 1/4 ZIP POLAR FLEECE'], ['SHIPPROTECT', 'Shipping protection']]),
    localStyles: [{ style_code: 'W26HV001BLK', name: 'OLD LOCAL NAME' }, { style_code: 'W26ZZ001BLK', name: 'LOCAL ONLY DROP' }],
  });
  const by = Object.fromEntries(b.families.map((f) => [f.product_code, f]));
  assert.equal(by.W26HV001.product_name, 'HAVOK 1/4 ZIP POLAR FLEECE');
  assert.equal(by.W26ZZ001.source, 'local');
  assert.equal(b.stats.am_style_rows_excluded, 1);
});

test('fingerprint is deterministic, order-independent and changes when a product changes', () => {
  const rows = [['W26AA001BLK', 'ALPHA TEE'], ['W26BB001BLK', 'BETA TEE']];
  const a = C.buildCatalogue({ amCatalogue: amMap(rows), localStyles: [] });
  const b = C.buildCatalogue({ amCatalogue: amMap([...rows].reverse()), localStyles: [] });
  assert.equal(a.fingerprint, b.fingerprint);
  assert.match(a.fingerprint, /^[0-9a-f]{64}$/);
  const c = C.buildCatalogue({ amCatalogue: amMap([...rows, ['W26CC001BLK', 'GAMMA TEE']]), localStyles: [] });
  assert.notEqual(a.fingerprint, c.fingerprint);
  const d = C.buildCatalogue({ amCatalogue: amMap([['W26AA001BLK', 'ALPHA TEE'], ['W26BB001BLK', 'BETA TEES']]), localStyles: [] });
  assert.notEqual(a.fingerprint, d.fingerprint);
});

test('validateCatalogue refuses a tiny, empty or truncated catalogue', () => {
  const b = C.buildCatalogue({ amCatalogue: amMap([['W26AA001BLK', 'ALPHA TEE'], ['W26BB001BLK', 'BETA TEE']]), localStyles: [] });
  assert.equal(C.validateCatalogue(b).ok, false); // far below MIN_FAMILIES
  assert.equal(C.validateCatalogue(b, { minFamilies: 2 }).ok, true);
  assert.equal(C.validateCatalogue(b, { minFamilies: 2, previous: { am_family_count: 100 } }).ok, false); // truncated vs previous
  assert.equal(C.validateCatalogue(C.buildCatalogue({ amCatalogue: null, localStyles: [] }), { minFamilies: 1 }).ok, false);
});

test('token index returns EXACTLY the same candidates, order and ties as a full scan', () => {
  const fams = [];
  const lead = ['ORBIT', 'NOVA', 'ZULU', 'KILO', 'RIOT', 'HAVOK', 'MAISON', 'WAYNE'];
  const tail = ['BOX FIT TEE', '1/4 ZIP FLEECE', 'PANEL HOOD', 'HEAVY WEIGHT TEE', 'SHERPA JACKET', 'HOCKEY JERSEY'];
  for (let i = 0; i < 400; i++) fams.push({ product_code: `W26X${String(i).padStart(4, '0')}`, product_name: `${lead[i % lead.length]}${i % 30} ${tail[i % tail.length]}` });
  fams.push({ product_code: 'W25DU001', product_name: 'DUPE HOODIE' }, { product_code: 'W26DU001', product_name: 'DUPE HOODIE' });
  const idx = P.buildFamilyIndex(fams);
  const plain = idx.slice(); // slice() drops the token index -> full scan
  assert.ok(idx.byToken && !plain.byToken);
  const vocab = [...lead.map((l, i) => l + (i * 3)), ...tail.join(' ').split(' '), 'DUPE', 'HOODIE', 'TEES', 'POLAR', 'UNKNOWNWORD'];
  let seed = 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  for (let i = 0; i < 800; i++) {
    const ph = Array.from({ length: 1 + (rnd() % 5) }, () => vocab[rnd() % vocab.length]).join(' ');
    assert.equal(sig(P.matchProductPhrase(ph, idx)), sig(P.matchProductPhrase(ph, plain)), `phrase "${ph}"`);
  }
});

// ── V3 behaviour is unchanged on a large (AM-sized) catalogue ───────────
const bigCtx = (extraNames = []) => {
  const lead = ['ORBIT', 'NOVA', 'ZULU', 'KILO', 'RIOT', 'ECHO', 'DELTA', 'SIGMA'];
  const tail = ['BOX FIT TEE', '1/4 ZIP FLEECE', 'PANEL HOOD', 'HEAVY WEIGHT TEE', 'SHERPA JACKET'];
  const names = [];
  for (let i = 0; i < 2200; i++) names.push(`${lead[i % lead.length]}${i % 280} ${tail[i % tail.length]}`);
  names.push(...extraNames);
  const families = names.map((n, i) => ({ product_code: `W26T${String(i).padStart(4, '0')}`, product_name: n }));
  return {
    mappingByKey: new Map(), mappingCodesByProduct: new Map(), trustedPairs: new Map(), familyIndex: P.buildFamilyIndex(families), adSetupsByLabel: new Map(),
    families, familyByCode: new Map(families.map((f) => [f.product_code, f])), concepts: [], conceptByNorm: new Map(), creators: ['Mark'], creatorByNorm: new Map([['MARK', 'Mark']]),
    styles: [], styleByNorm: new Map(), styleById: new Map(), adSetups: [], adSetupByNorm: new Map(), adSetupById: new Map(),
  };
};
const adName = (prod) => `#1_26-WK01_01-01_${prod}_TOPS_HOOK_Video_Single_MARK_STYLING_Product`;
const evalName = (ctx, prod) => { const ad = { ad_name: adName(prod) }; const built = M.buildSuggestions(ad, ctx); return { built, ev: M.evaluateAutoMatch(ad, built, ctx) }; };

test('V4 catalogue: a product present in the catalogue auto-links by exact name', () => {
  const ctx = bigCtx(['HAVOK 1/4 ZIP POLAR FLEECE', 'STXR 1/4 ZIP POLAR FLEECE']);
  const { ev } = evalName(ctx, 'HAVOK 1/4 ZIP POLAR FLEECE');
  assert.equal(ev.qualifies, true);
  assert.equal(ev.values.product.product_name, 'HAVOK 1/4 ZIP POLAR FLEECE');
});

test('V3 identity guard still blocks a generic-word near-match on a 2,200-family catalogue', () => {
  const ctx = bigCtx(['STXR 1/4 ZIP POLAR FLEECE']);
  const { ev } = evalName(ctx, 'HAVOK 1/4 ZIP POLAR FLEECE');
  assert.equal(ev.qualifies, false);
});

test('same product name under two product codes is NOT auto-linked (stays in review; no year tie-break)', () => {
  const ctx = bigCtx(['DUPE HOODIE', 'DUPE HOODIE']); // two codes, identical name
  const { ev, built } = evalName(ctx, 'DUPE HOODIE');
  assert.equal(ev.qualifies, false);
  assert.match(built.product_resolution.reason || '', /More than one plausible/);
});

test('promo / concept phrases still never link a product on a large catalogue', () => {
  const ctx = bigCtx(['MYSTERY BOX HOODIE']);
  assert.equal(evalName(ctx, 'BLACK FRIDAY SALE').ev.qualifies, false);
});

test('effective rules version stays 3 while no snapshot is active (legacy export unchanged)', () => {
  assert.equal(M.BASE_RULES_VERSION, 3);
  assert.equal(M.AUTO_RULES_VERSION, 3);
});
