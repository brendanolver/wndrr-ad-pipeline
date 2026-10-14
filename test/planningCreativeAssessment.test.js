'use strict';
// Batch 30: creative AGE assessments, assessing ALL of a product's creatives, per-funnel verdicts, the priority / stock-coverage fixes and the weak-demand correction.
// Fixture data only; the real grouping (productAdPerformance.judgeAcrossFunnels), recency and engine code are used.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const perf = require('../src/lib/productAdPerformance');
const recency = require('../src/lib/creativeRecency');
const opp = require('../src/lib/planningOpportunities');
const dm = require('../src/lib/planningDemand');
const health = require('../src/lib/metaFunnelHealth');
const cfgLib = require('../src/lib/creativePlanningConfig');
const E = require('../public/planningExplain');
const { CFG, TODAY, day, cr, salesOf, base } = require('./_planningFixtures');

const RULES = health.effectiveRules(); const CODED = health.COLOUR_CODED;
const run = (p, mode = 'core', cfg = CFG) => opp.evaluate(p, cfg, TODAY, mode);
const strong = salesOf(150, { units7: 40, units14: 75 });
const cov = (n) => ({ known: true, active_ads: n, possible: 0, unresolved: 0, unresolved_share_pct: 0, uncertain: false, min: 5 });
const v = (key, state, o = {}) => ({ ...cr(key, state, { age: o.age === undefined ? 120 : o.age }), first_delivery: day(o.age === undefined ? 120 : o.age), first_delivery_truncated: false, last_delivery: day(1), ...o });
const phase = (c) => recency.phaseOf(c, TODAY, CFG);

// ── CREATIVE AGE: 0-4 days early testing, 5+ days assessed ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('age: the rule is a setting (4 days); days 0 to 4 are early testing, from day 5 the creative is assessed', () => {
  assert.equal(CFG.new_creative_days, 4);
  [1, 4].forEach((age) => { const p = phase(v('a', 'insufficient', { age, spend: 20 })); assert.equal(p.phase, 'testing', `${age} days old`); assert.equal(p.condition, 'new'); });
  const five = phase(v('a', 'insufficient', { age: 5, spend: 20 }));
  assert.equal(five.phase, 'unjudged', 'day 5: assessed, and delivery is insufficient'); assert.equal(five.label, 'Insufficient delivery'); assert.equal(five.condition, 'insufficient_delivery');
  const twelve = phase(v('a', 'insufficient', { age: 12, spend: 20 }));
  assert.equal(twelve.phase, 'unjudged'); assert.equal(twelve.label, 'Insufficient delivery', 'the real issue is delivery, never "too early"');
  const wider = cfgLib.resolve({ new_creative_days: 7 }).config;
  assert.equal(recency.phaseOf(v('a', 'insufficient', { age: 6, spend: 20 }), TODAY, wider).phase, 'testing');
});
test('age: a new creative with enough evidence is assessed at once; an older creative with too little delivery stays inconclusive', () => {
  const early = phase(v('a', 'performing', { age: 2 }));
  assert.notEqual(early.phase, 'testing'); assert.equal(early.condition, 'performing', 'sufficient evidence supports a verdict before day 5');
  assert.equal(phase(v('a', 'underperforming', { age: 3, severity: 'clear' })).condition, 'underperforming');
  const old = phase(v('a', 'insufficient', { age: 40, spend: 10 }));
  assert.equal(old.phase, 'unjudged'); assert.equal(old.condition, 'insufficient_delivery', 'after day 5 an under-delivering creative is inconclusive, not new');
  assert.equal(phase(v('a', 'insufficient', { age: 200, spend: 10 })).phase, 'stale');
});
test('age: no assessment says "too early to judge" any more', () => {
  const src = ['public/planningExplain.js', 'src/lib/planningOpportunities.js', 'src/lib/creativeRecency.js', 'public/planning.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
  assert.doesNotMatch(src, /Too early to judge\.'|too early to judge\.`|Too early to judge\./);
  const o = run(base({ sales: strong, coverage: cov(3), creatives: [v('a', 'performing', { age: 90 }), v('b', 'performing', { age: 80 }), v('c', 'insufficient', { age: 2, spend: 10 }), v('d', 'underperforming', { age: 100, severity: 'clear' })] }));
  assert.equal(o.status, 'testing'); assert.doesNotMatch(E.reasonFor(o, CFG), /too early/i); assert.match(E.reasonFor(o, CFG), /early testing/);
});

// ── ASSESSING ALL CREATIVES: one condition never dominates the product ─────────────────────────────────────────────────────────────────────────────────────────────────────────
test('multi-creative: one new creative never overrides the established creatives (Soho Club Tee shape: many creatives, a few new)', () => {
  const established = ['a', 'b', 'c', 'd', 'e', 'f'].map((k, i) => v(k, 'performing', { age: 90 - i, concept: `C${i}` }));
  const fresh = ['n1', 'n2', 'n3', 'n4'].map((k) => v(k, 'insufficient', { age: 3, spend: 15 }));
  const o = run(base({ sales: salesOf(709, { units7: 165, units14: 330 }), stock: { known: true, units: 2678, on_order: 0 }, coverage: cov(10), creatives: [...established, ...fresh] }));
  assert.equal(o.status, 'covered', 'six performing creatives are assessed on their own evidence; four new ones do not make it "too early"');
  assert.equal(o.facts.performing, 6); assert.equal(o.facts.creative_conditions.new, 4);
  assert.doesNotMatch(E.reasonFor(o, CFG), /too early/i); assert.equal(E.reasonFor(o, CFG), 'Existing creative coverage is sufficient for now. 6 creatives are performing, with others still being assessed.'); assert.match(E.conditionsSummary(o), /10 unique creatives/, 'the counts live in the expanded row');
});
test('multi-creative: a missing TOF benchmark never overrides rated MOF creatives; unrated creatives count as creatives in play', () => {
  const mof = ['a', 'b'].map((k, i) => ({ ...v(k, 'performing', { age: 60 - i, concept: `M${i}` }), funnel: 'MOF' }));
  const tof = ['t1', 't2', 't3', 't4'].map((k, i) => ({ ...v(k, 'unrated', { age: 70 - i, concept: `T${i}` }), funnel: 'TOF' }));
  const o = run(base({ sales: strong, coverage: cov(6), creatives: [...mof, ...tof] }));
  assert.equal(o.status, 'covered'); assert.equal(o.facts.performing, 2); assert.equal(o.facts.unrated, 4); assert.equal(o.facts.creatives_in_play, 6);
  assert.equal(E.reasonFor(o, CFG), 'Existing creative coverage is sufficient for now. 2 creatives are performing, with others still being assessed.');
  assert.match(E.conditionsSummary(o), /2 performing against the approved benchmark, 4 with no approved TOF benchmark/);
});
test('multi-creative: performing and underperforming creatives together are both reported; one weak creative does not make every creative weak', () => {
  const o = run(base({ sales: strong, coverage: cov(4), creatives: [v('a', 'performing', { age: 90 }), v('b', 'performing', { age: 80 }), v('c', 'underperforming', { age: 70, severity: 'clear' }), v('d', 'underperforming', { age: 60, severity: 'clear' })] }));
  assert.equal(o.status, 'act'); assert.equal(o.gap.type, 'underperforming');
  assert.equal(o.facts.performing, 2); assert.equal(o.facts.weak, 2);
  assert.match(E.reasonFor(o, CFG), /2 of 4 active creatives are over the approved cost-per-purchase limit/, 'it counts the weak ones against ALL four, not as "the product is weak"');
});
test('multi-creative: a product whose only creative is new still needs creative (Slammed Box Fit Tee shape); several in play do not', () => {
  const only = run(base({ sales: salesOf(37, { units7: 9, units14: 18 }), stock: { known: true, units: 233, on_order: 0, colourways: { total: 2, active: 2, viable: 2 } }, coverage: cov(1), creatives: [v('n', 'insufficient', { age: 2, spend: 12 })] }));
  assert.equal(only.status, 'act', 'a newly launched ad must not place the whole product in Covered / monitoring'); assert.equal(only.gap.single, true);
  assert.match(E.reasonFor(only, CFG), /it depends on a single creative/);
  const three = run(base({ sales: salesOf(37, { units7: 9, units14: 18 }), coverage: cov(3), creatives: [v('a', 'unrated', { age: 50 }), v('b', 'unrated', { age: 40 }), v('n', 'insufficient', { age: 2, spend: 12 })] }));
  assert.equal(three.status, 'covered');
});
test('multi-creative: nothing assessable (every creative under-delivers) is Needs review with the real reason, not a recommendation', () => {
  const o = run(base({ sales: strong, coverage: cov(2), creatives: [v('a', 'insufficient', { age: 30, spend: 10 }), v('b', 'insufficient', { age: 40, spend: 5 })] }));
  assert.equal(o.status, 'insufficient_data'); assert.equal(o.review_reason, 'insufficient_delivery');
  assert.match(E.reasonFor(o, CFG), /^Insufficient delivery: /);
});

// ── per-funnel verdicts ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const pool = (spend, purchases, impressions = 50000) => ({ total: { spend, impressions, clicks: 900, purchases, value: purchases * 100 }, recent: { spend: spend / 2, impressions: impressions / 2, clicks: 450, purchases: purchases / 2, value: 0 }, prior: { spend: spend / 2, impressions: impressions / 2, clicks: 450, purchases: purchases / 2, value: 0 }, fatigue_recent: { spend: 0, impressions: 0, clicks: 0, purchases: 0, value: 0 }, fatigue_prior: { spend: 0, impressions: 0, clicks: 0, purchases: 0, value: 0 }, delivery_rows: 14 });
const groupOf = (pools) => { const g = perf.newGroup('x'); pools.forEach(([f, p]) => g.pools.set(f, p)); [...pools].forEach(([, p]) => ['total', 'recent', 'prior', 'fatigue_recent', 'fatigue_prior'].forEach((w) => Object.keys(p[w]).forEach((m) => { g[w][m] += p[w][m]; }))); g.delivery_rows = 14; return g; };
test('funnels: ONE creative in two funnels is one creative judged within each; it is never unrated merely because one funnel has no benchmark', () => {
  const g = groupOf([['MOF', pool(400, 10)], ['TOF', pool(900, 3)]]);
  const r = perf.judgeAcrossFunnels(g, { rules: RULES, coded: CODED, cfg: perf.DEFAULTS });
  assert.equal(r.state, 'performing', 'judged in its rated MOF funnel (CPA $40 within the approved $60)');
  const by = Object.fromEntries(r.funnel_results.map((f) => [f.funnel, f]));
  assert.equal(by.MOF.state, 'performing'); assert.equal(by.TOF.state, 'unrated', 'the TOF result is kept, with no verdict');
  assert.equal(by.TOF.cpa, 300, 'TOF CPA is its own, never blended with MOF');
  assert.equal(r.spend, 1300); assert.equal(r.purchases, 13, 'totals stay whole for concentration and diversity');
  const mixed = perf.judgeAcrossFunnels(groupOf([['MOF', pool(1000, 5)], ['TOM', pool(300, 5)]]), { rules: RULES, coded: CODED, cfg: perf.DEFAULTS });
  assert.equal(mixed.state, 'underperforming', 'MOF CPA $200 is over the approved limit; TOM has no benchmark and cannot rescue or sink it');
  const single = perf.judgeAcrossFunnels(groupOf([['MOF', pool(400, 10)]]), { rules: RULES, coded: CODED, cfg: perf.DEFAULTS });
  assert.equal(single.state, 'performing'); assert.equal(single.funnel_results.length, 1);
});

// ── PRIORITY, stock coverage and weak demand ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const hsP = (o = {}) => base({ is_core: false, tier: { tier: 'platinum', index: 188 }, sales: salesOf(71, { initial28: 275, recent28: 71, age_days: 200, units7: 18, units14: 36 }), stock: { known: true, units: 431, on_order: 0 }, ...o });
test('priority: slow stock (more than 26 weeks of cover) never earns High priority, and the tooltip says why (Rothman shape)', () => {
  const o = run(hsP({ stock: { known: true, units: 600, on_order: 0 }, coverage: cov(0), creatives: [] }), 'revival');
  assert.equal(o.status, 'act'); assert.equal(o.stock.band, 'slow');
  assert.notEqual(o.priority, 'High'); assert.ok(o.caps.some((c) => /slow mover/.test(c)), 'the cap that held the priority back is stated');
  const healthy = run(hsP({ coverage: cov(0), creatives: [] }), 'revival');
  assert.equal(healthy.stock.band, 'healthy');
  assert.ok(!healthy.caps.some((c) => /slow mover/.test(c)));
  const pl = fs.readFileSync(path.join(__dirname, '..', 'public', 'planning.js'), 'utf8');
  assert.match(pl, /function plPrioTitle[\s\S]*it\.caps/, 'the badge tooltip lists the score parts and every cap');
});
test('coverage: ONE stock-coverage calculation (available units / weekly pace) is used by the stock rows, the key facts and the revival check', () => {
  const o = run(hsP({ coverage: cov(0), creatives: [] }), 'revival');
  const pace = o.demand.pace_weekly;
  assert.equal(o.facts.cover_weeks, Math.round((431 / pace) * 10) / 10);
  assert.equal(o.revival.weeks, o.facts.cover_weeks, 'the revival evidence and the stock row can no longer disagree (35.9 vs 25.6)');
  assert.match(o.stock.notes.join(' '), new RegExp(`\\(${pace} units a week\\)`), 'the pace used is always stated');
  assert.match(E.keyFacts(o).find((r) => r[0] === 'Stock coverage')[1], /weeks at [\d.]+ units a week/);
  assert.equal(dm.stockOf({ known: true, units: 100, on_order: 900 }, 10, CFG).cover_weeks, 10, 'on-order stock never changes the coverage');
});
test('weak demand: a product with 16 units in about 21 days on sale is not recommended however much stock or however few ads (Accent Mesh Short shape)', () => {
  const partial = salesOf(16, { units7: 5, units14: 11, days_live: 21, since_launch: 16 });
  const o = run(base({ sales: partial, stock: { known: true, units: 202, on_order: 0, colourways: { total: 2, active: 2, viable: 2 } }, coverage: cov(0), creatives: [], launch_age_days: 20 }));
  assert.equal(o.status, 'weak_demand'); assert.equal(o.demand.partial, true);
  assert.match(o.reason, /steady at best, not the strong demand/);
  assert.equal(E.categoryOf(o), 'hidden');
  const full = run(base({ sales: salesOf(30, { units7: 7, units14: 14 }), coverage: cov(0), creatives: [] }));
  assert.equal(full.status, 'act', 'a full 30-day window of steady sales still qualifies: the rule only stops estimates from passing as steady selling');
  const off = cfgLib.resolve({ launch_requires_strong_demand: 0 }).config;
  assert.equal(run(base({ sales: partial, stock: { known: true, units: 202, on_order: 0 }, coverage: cov(0), creatives: [], launch_age_days: 20 }), 'core', off).status, 'act', 'a setting, not a hidden rule');
});

// ── UI wiring ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('ui: Priority exists only in Needs creative and + Add in all three; Priority is sortable; Live ads shows only the number; the page has four sections', () => {
  const pl = fs.readFileSync(path.join(__dirname, '..', 'public', 'planning.js'), 'utf8');
  assert.match(pl, /priority: \{[^}]*only: 'needs'/); assert.match(pl, /const showPrio = cat === 'needs'/, 'Batch 32: Priority is a column only in Needs creative');
  assert.match(pl.slice(pl.indexOf('function plActionCell'), pl.indexOf('// sorting')), /data-opp-add/, 'the Add action exists in every category');
  assert.match(pl, /\$\{cur === 'needs' \? `<label class="pl-f"><span>Priority/, 'the Priority filter is also only offered in Needs creative');
  const cell = pl.slice(pl.indexOf('function plMetricsCell'), pl.indexOf('function plStatusCell')).replace(/\/\/.*$/gm, '');
  const live = cell.slice(cell.indexOf('pt-live'));
  assert.doesNotMatch(live, /Meta ad|running as/, 'Live ads in the key metrics is the number and nothing else');
  assert.match(live, /\$\{live\}<small>Live ads<\/small>/, 'the box holds the number and its label only');
  assert.doesNotMatch(pl.slice(pl.indexOf('function plLiveAdsHtml'), pl.indexOf('function plColourwaysHtml')), /Meta ads?<\/th>|running as/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  for (const sec of ['core', 'high-stocks', 'creative-insights', 'shoot-plan']) assert.equal((html.match(new RegExp(`data-pl-nav="${sec}"`, 'g')) || []).length, 2, `${sec} is in both the top navigation and the sidebar`);
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /const PLANNING_STEPS = \['core', 'high-stocks', 'creative-insights', 'shoot-plan'\]/);
  assert.doesNotMatch(pl, /Plan this colourway/);
});
