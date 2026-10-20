'use strict';
// Creative Insights redesign: the wording and colours come from the concept records the insights engine returns (no rating, count or threshold is recalculated), and the page keeps every
// piece of technical evidence behind one collapsed section.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const PE = require('../public/planningExplain');

const pl = fs.readFileSync(path.join(__dirname, '..', 'public', 'planning.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
const fn = (name) => { const i = pl.indexOf(`function ${name}(`); return pl.slice(i, pl.indexOf('\n}\n', i) + 2); };
const f = (o) => ({ funnel: 'MOF', benchmarked: true, approved_cpa_limit: 40, creatives: 3, performing: 2, underperforming: 1, insufficient: 0, unrated: 0, spend: 2680, purchases: 89, cpa: 30.1, status: 'promising', requirements: null, ...o });
const req = (o = {}) => ({ creatives: { need: 3, have: 2, ok: false }, products: { need: 3, have: 3, ok: true }, spend: { need: 2000, have: 2680, ok: true }, purchases: { need: 30, have: 89, ok: true }, consistent: { have: '2 performing vs 1 underperforming', ok: true }, dominance: { limit_pct: 60, top_pct: 40, ok: true }, ...o });
const concept = (o = {}) => ({ key: 'k', label: 'Founder Story', status: 'promising', products_tested: 3, unique_creatives: 4, funnels: [f({ requirements: req() }), f({ funnel: 'TOF', benchmarked: false, approved_cpa_limit: null, performing: 0, underperforming: 0, unrated: 1, creatives: 1, spend: 600, purchases: 12, cpa: 50, status: null })], ...o });

test('status labels and tones: green winner, amber promising, grey mixed / insufficient, red underperforming', () => {
  assert.deepEqual(PE.INSIGHT_STATUS, { established: 'Established Winner', promising: 'Promising Test', mixed: 'Mixed Performance', weak: 'Underperforming', insufficient: 'Insufficient Evidence' });
  assert.deepEqual(PE.INSIGHT_TONE, { established: 'green', promising: 'amber', mixed: 'grey', weak: 'red', insufficient: 'grey' });
});

test('why: at most two sentences, built from the concept\'s own numbers, and never a verdict for an unbenchmarked funnel', () => {
  const w = PE.insightWhy(concept());
  assert.equal((w.match(/\.(\s|$)/g) || []).length, 2, w);
  assert.match(w, /2 performing and 1 over the approved \$40 CPA limit/); assert.match(w, /funnel CPA \$30/); assert.match(w, /TOF performance cannot yet be assessed against an approved benchmark/); assert.match(w, /broader evidence is still limited \(2 of 3 performing creatives\)/);
  // all creatives in the funnel performing: the plain phrasing
  const one = PE.insightWhy(concept({ status: 'insufficient', funnels: [f({ funnel: 'TOM', creatives: 1, performing: 1, underperforming: 0, cpa: 21, approved_cpa_limit: 30 })] }));
  assert.match(one, /^1 TOM creative is performing at a \$21 CPA against the approved \$30 benchmark\./);
  // changing the data changes the sentence (nothing is hardcoded)
  assert.notEqual(PE.insightWhy(concept({ funnels: [f({ performing: 3, underperforming: 0, cpa: 18, requirements: req() })] })), w);
  assert.match(PE.insightWhy(concept({ status: 'weak', funnels: [f({ performing: 0, underperforming: 2, status: 'weak' })] })), /2 over the approved \$40 CPA limit[\s\S]*no creative is performing/i);
  assert.match(PE.insightWhy(concept({ status: 'established', funnels: [f({ status: 'established', requirements: req() })] })), /meets the approved evidence requirements/);
  assert.match(PE.insightWhy(concept({ status: 'insufficient', funnels: [f({ funnel: 'TOF', benchmarked: false, performing: 0, underperforming: 0, status: null })] })), /^No creative has been rated against an approved benchmark yet\./);
});

test('funnel cards: only funnels with data; colour only from an approved-benchmark verdict; CPAs are never combined', () => {
  const cards = PE.insightFunnelCards(concept({ funnels: [f({ requirements: req() }), f({ funnel: 'TOM', benchmarked: false, creatives: 2, performing: 0, underperforming: 0, spend: 100, purchases: 5, cpa: 20, status: null }), f({ funnel: 'TOF', creatives: 0 })] }));
  assert.deepEqual(cards.map((c) => c.funnel), ['TOM', 'MOF'], 'the empty funnel is not shown; order TOM, TOF, MOF');
  const tom = cards[0]; assert.equal(tom.tone, 'grey'); assert.match(tom.bench, /No approved benchmark: not assessed/); assert.equal(tom.performing, null, 'no performing count without a benchmark'); assert.equal(tom.cpa, '$20');
  const mof = cards[1]; assert.equal(mof.tone, 'amber'); assert.equal(mof.cpa, '$30'); assert.equal(mof.purchases, 89); assert.equal(mof.performing, 2); assert.equal(mof.rated, 3);
  assert.equal(PE.insightFunnelCards(concept({ funnels: [f({ performing: 0, underperforming: 0, status: null })] }))[0].tone, 'grey', 'benchmarked but nothing rated: grey, "not enough delivery"');
  assert.equal(PE.insightFunnelCards(concept({ funnels: [f({ status: 'weak', performing: 0, underperforming: 2 })] }))[0].tone, 'red');
  assert.equal(PE.insightFunnelCards(concept({ funnels: [f({ status: 'established' })] }))[0].tone, 'green');
});

test('table funnel: the benchmarked funnel with rated creatives, else the funnel with the most spend; one funnel, never a blend', () => {
  assert.deepEqual(PE.insightKeyFunnel(concept()), { funnel: 'MOF', cpa: 30.1, benchmarked: true });
  assert.deepEqual(PE.insightKeyFunnel(concept({ funnels: [f({ funnel: 'TOF', benchmarked: false, performing: 0, underperforming: 0, spend: 600, cpa: 50 }), f({ funnel: 'TOM', benchmarked: false, performing: 0, underperforming: 0, spend: 100, cpa: 20 })] })), { funnel: 'TOF', cpa: 50, benchmarked: false });
  assert.equal(PE.insightKeyFunnel(concept({ funnels: [f({ cpa: null })] })), null);
});

test('short creative names: the readable title of the Meta ad name; the full name is kept in the detail', () => {
  assert.equal(PE.shortCreativeName('#101_26-WK39_20-09_OFFEND BEACH SHORT_UGC_MOF_Founder Story - Hook 101'), 'Founder Story - Hook 101');
  assert.equal(PE.shortCreativeName('Plain Name Without Underscores'), 'Plain Name Without Underscores');
  assert.ok(PE.shortCreativeName(`x_${'long word '.repeat(20)}`).length <= 46);
  assert.equal(PE.shortCreativeName(null), 'Unnamed creative');
});

test('page: summary cards count the concept records; four-part expanded view; every technical item sits in the collapsed evidence section', () => {
  const render = fn('plRenderInsights');
  assert.match(render, /counts\[c\.status\]|counts\[c\.status\] = /); assert.match(render, /all\.length, 'Concepts Analysed'/); assert.match(render, /Established Winners[\s\S]*Promising Concepts/);
  assert.match(render, /% of Meta spend has a concept assigned/);
  assert.doesNotMatch(render, /Judged against the approved benchmarks only/, 'the long benchmark note is not on the main page');
  assert.match(fn('plInsInfoHtml'), /Judged against the approved benchmarks only/);
  const detail = fn('plInsDetailHtml');
  assert.ok(detail.indexOf('Why is this concept performing this way?') < detail.indexOf('plInsFunnelCardsHtml(c)') && detail.indexOf('plInsFunnelCardsHtml(c)') < detail.indexOf('plInsProductsHtml(c)') && detail.indexOf('plInsProductsHtml(c)') < detail.indexOf('plInsSuggestionsHtml(c)') && detail.indexOf('plInsSuggestionsHtml(c)') < detail.indexOf('Detailed Performance &amp; Creative Evidence'), 'summary, funnel cards, products, where to test next, then the evidence');
  assert.doesNotMatch(detail, /Met<|Not met|requirements|plInsCreativesHtml/, 'no checklist or creative list in the main part of the view');
  const ev = fn('plInsEvidenceHtml');
  for (const k of ['Full funnel breakdown', 'Benchmark criteria and evaluation', 'Evidence and matching', 'Individual creatives', 'plInsRequirementsHtml', 'plInsCreativesHtml']) assert.ok(ev.includes(k), k);
  assert.match(fn('plInsRequirementsHtml'), /Met<\/b>|'Not met'/);
  const cr = fn('plInsCreativesHtml'); for (const k of ['ccThumbHtml(id)', 'PE.shortCreativeName(x.name)', 'data-cc-open', 'Meta ad name &amp; ID', 'ad_list']) assert.ok(cr.includes(k), k);
});

test('where to test next: the engine\'s own suggestions, the existing Shoot Plan add, no new suitability rule', () => {
  const s = fn('plInsSuggestionsHtml');
  assert.match(s, /No suitable products identified yet\./); assert.match(s, /data-ins-add=/); assert.match(s, /plInThisWeeksPlan\(it\)/); assert.match(s, /not yet a proven winner/);
  assert.match(pl, /plQuickAdd\(itemKey, \{ concept: conceptLabel/, 'the add is still plQuickAdd with the concept, as before');
  assert.doesNotMatch(s, /stock_units\s*[<>]|units30\s*[<>]|planning_status\s*===\s*'(?!act)/, 'no suitability or stock rule is applied in the page');
});

test('products tested: CPA only when the concept ran in one funnel (CPAs from different funnels are never combined)', () => {
  const p = fn('plInsProductsHtml'); assert.match(p, /single = PE\.insightFunnelCards\(c\)\.length === 1/); assert.match(p, /single && p\.purchases > 0/);
});

test('styling: white cards, soft tones, no full-row backgrounds', () => {
  assert.match(css, /\.ins2-badge\[data-tone="green"\]/); assert.match(css, /\.ins2-badge\[data-tone="amber"\]/); assert.match(css, /\.ins2-badge\[data-tone="red"\]/);
  assert.doesNotMatch(css.slice(css.indexOf('Creative Insights: summary cards')), /\.ins2-table tr[^{]*\{[^}]*background/);
});
