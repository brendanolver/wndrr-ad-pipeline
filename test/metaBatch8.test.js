// Pure tests for batch 8: no concept headings, and the full-modal rapid review session.
// The end-to-end behaviour (real browser, real database) is covered by the sandbox suite b8-ui; these pin the pure rules and the static guarantees.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const code = (f) => read(f).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
function frontEndFn(name) {
  const app = read('public/app.js');
  const i = app.indexOf(`function ${name}(`);
  assert.ok(i >= 0, name);
  let depth = 0; let j = app.indexOf('{', i);
  for (let k = j; k < app.length; k++) { if (app[k] === '{') depth++; else if (app[k] === '}') { depth--; if (!depth) { j = k; break; } } }
  return app.slice(i, j + 1);
}

// a minimal context `c` that records what mmAutofill applied
function makeCtx({ products = [], nps = false, concept = [], media = [], creator = [], style = [] } = {}) {
  const applied = [];
  const mk = (arr) => ({ get: () => arr });
  return {
    applied,
    c: {
      productPicker: mk(products), conceptPicker: mk(concept), mediaPicker: mk(media), creatorPicker: mk(creator), stylePicker: mk(style),
      nps: { checked: nps },
      apply: (field, x) => applied.push([field, x.id]),
    },
  };
}
const autofill = () => new Function('MM_AUTOFILL_MIN', `${frontEndFn('mmAutofill')}; return mmAutofill;`)(0.6);

test('autofill: Exact and Likely suggestions fill their own fields; Weak ones never do', () => {
  const af = autofill();
  const ws = { suggestions: {
    product: [{ id: 'p1', confidence: 0.95 }],
    concept: [{ id: 'c1', confidence: 0.7 }],
    media_type: [{ id: 'm1', confidence: 0.6 }],
    creator: [{ id: 'cr1', confidence: 0.59 }],           // Weak -> not filled
    creative_style: [{ id: 's1', confidence: 0.3 }],       // Weak -> not filled
  } };
  const { c, applied } = makeCtx();
  const filled = af(ws, c);
  assert.deepEqual(applied.map((a) => a[0]), ['product', 'concept', 'media_type']);
  assert.deepEqual(filled, ['Product', 'Concept', 'Media']);
});
test('autofill: nothing is invented, and a field that already has a value (or Not product-specific) is left alone', () => {
  const af = autofill();
  const { c, applied } = makeCtx({});
  assert.deepEqual(af({ suggestions: {} }, c), []);
  assert.deepEqual(af({}, c), []);
  assert.deepEqual(applied, []);
  const full = makeCtx({ products: [{ key: 'P' }], concept: [{ key: 'x' }], media: [{ key: 'v' }], creator: ['A'], style: [{ key: 's' }] });
  af({ suggestions: { product: [{ id: 'p', confidence: 1 }], concept: [{ id: 'c', confidence: 1 }], media_type: [{ id: 'm', confidence: 1 }], creator: [{ id: 'k', confidence: 1 }], creative_style: [{ id: 's', confidence: 1 }] } }, full.c);
  assert.deepEqual(full.applied, [], 'existing values are never overwritten');
  const nps = makeCtx({ nps: true });
  af({ suggestions: { product: [{ id: 'p', confidence: 1 }] } }, nps.c);
  assert.deepEqual(nps.applied, [], 'a product is not filled over an explicit Not product-specific');
});
test('autofill: an unreliable product leaves Product empty so the person must choose one', () => {
  const af = autofill();
  const { c, applied } = makeCtx();
  const filled = af({ suggestions: { product: [{ id: 'p1', confidence: 0.4 }], concept: [{ id: 'c1', confidence: 0.9 }] } }, c);
  assert.deepEqual(applied.map((a) => a[0]), ['concept']);
  assert.ok(!filled.includes('Product'));
});
test('autofill: a set of products is filled together only when they share one set group', () => {
  const af = autofill();
  const { c, applied } = makeCtx();
  af({ suggestions: { product: [
    { id: 'a', confidence: 0.9, evidence: { set_group: 'G' } },
    { id: 'b', confidence: 0.9, evidence: { set_group: 'G' } },
    { id: 'z', confidence: 0.9, evidence: { set_group: 'H' } },
    { id: 'w', confidence: 0.3, evidence: { set_group: 'G' } },
  ] } }, c);
  assert.deepEqual(applied.map((a) => a[1]), ['a', 'b'], 'same group, reliable only');
});

test('concept headings are gone from every concept selector, but the 40 concepts and their order are untouched', () => {
  const app = code('public/app.js');
  assert.doesNotMatch(app, /mm-opt-group|groupOf/);
  assert.doesNotMatch(read('public/styles.css'), /mm-opt-group/);
  const conceptPickers = app.match(/conceptPicker = mmPicker\([\s\S]{0,400}?\}\);/g) || [];
  assert.equal(conceptPickers.length, 1);
  assert.match(conceptPickers[0], /longList: true/);
  // the server list is unchanged: still the approved order
  assert.match(read('src/lib/metaMatchingVocab.js'), /ORDER BY group_order NULLS LAST, sort_order NULLS LAST, name/);
  const sql = read('db/schema.sql');
  assert.equal((sql.match(/\('concept', '/g) || []).length >= 40, true, 'the 40 approved concepts are still seeded');
});

test('the inline rapid editor is gone; the full modal is the only review surface', () => {
  const app = code('public/app.js');
  for (const dead of ['mmRvSelect', 'mmRvForm', 'mmRvConfirm', 'mmRvOnTick', 'mmRvAdvance', 'mm-rv-tick', 'mm-tickcell', 'mm-rv-panel']) assert.doesNotMatch(app, new RegExp(dead), dead);
  assert.doesNotMatch(read('public/index.html'), /mm-th-tick/);
  for (const live of ['mmSessStart', 'mmSessOpen', 'mmSessNext', 'mmSessConfirm', 'mmSessSkip', 'mmSessClose', 'mmSessOnClosed', 'mmAutofill']) assert.match(app, new RegExp(`function ${live}\\b`), live);
  assert.match(app, /id="mm-sess-confirm"/); assert.match(app, /Confirm &amp; Next/); assert.match(app, /Skip &amp; Next/); assert.match(app, /Close review/i);
  assert.match(app, /closeModal[\s\S]{0,400}mmSessOnClosed\(\)/, 'closing the modal ends the session');
});
test('the session reuses the existing confirm path and adds no new write, sync, or propagation path', () => {
  const app = code('public/app.js');
  const sess = app.slice(app.indexOf('async function mmSessConfirm'), app.indexOf("document.getElementById('mm-rv-start').addEventListener"));
  assert.match(sess, /\/meta-ad-matching\/ads\/\$\{encodeURIComponent\(id\)\}\/confirm/);
  assert.match(sess, /mmRvPayload\(f\)/, 'rapid:true payload, so no trusted-pair re-evaluation of other creatives');
  assert.match(sess, /\/skip/);
  assert.doesNotMatch(sess, /creative-inheritance|reprocess-backlog|meta-archive|catalogue|inspiration|\/sync|\/refresh|\/suggest/i);
  assert.doesNotMatch(sess, /graph\.facebook|META_/);
  const open = app.slice(app.indexOf('async function openMatchWorkspace'), app.indexOf('function renderMatchWorkspace(ws'));
  assert.match(open, /refresh=0/, 'review mode reads stored suggestions only (no recompute, no writes)');
});
test('unique creatives: one review per exact meta_creative_id, and a handled creative is never shown twice', () => {
  const app = code('public/app.js');
  assert.match(app, /const mmRvKey = \(id\) => \(mmRv\.rows\.get\(id\) \|\| \{\}\)\.meta_creative_id \|\| id/);
  const cand = app.slice(app.indexOf('function mmSessCandidates'), app.indexOf('function mmSessBarHtml'));
  assert.match(cand, /!s\.seen\.has\(mmRvKey\(id\)\)/);
  assert.match(cand, /mmRvReviewable\(id\)/);
  assert.match(app.slice(app.indexOf('async function mmSessOpen'), app.indexOf('function mmAutofill')), /s\.seen\.add\(mmRvKey\(id\)\)/);
});
test('Enter never confirms from a field, a dropdown or a button, and the picker blurs after a pick', () => {
  const app = code('public/app.js');
  const kb = app.slice(app.indexOf("document.addEventListener('keydown', (e) => {\n  const s = mmRv.sess;"));
  assert.match(kb, /input:not\(\[type="checkbox"\]\)/);
  assert.match(kb, /s\.enterBlockedUntil/);
  assert.match(app, /if \(opts\.blurOnPick\) input\.blur\(\)/);
  assert.match(app, /MM_RV_ENTER_GUARD_MS = 500/);
});
