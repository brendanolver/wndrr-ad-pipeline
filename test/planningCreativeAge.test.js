'use strict';
// Batch 31: the AGE of a unique creative follows the ORIGINAL execution, never the newest duplicated Meta ad. Real grouping / judging / recency / engine code over a stubbed database.
// (Root cause: Planning loads only ACTIVE, matched ads. When the original instance of a creative is paused, archived or not yet reviewed, only the duplicate is in the group, so the group's
// first delivery was the duplicate's: a creative that had run for weeks was called "early testing".)
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const perf = require('../src/lib/productAdPerformance');
const recency = require('../src/lib/creativeRecency');
const nameCopies = require('../src/lib/metaNameCopies');
const health = require('../src/lib/metaFunnelHealth');
const opp = require('../src/lib/planningOpportunities');
const E = require('../public/planningExplain');
const { CFG, TODAY, day, salesOf, base } = require('./_planningFixtures');

const RULES = health.effectiveRules(); const CODED = health.COLOUR_CODED;
const fam = { key: 'W26AA001', codes: ['W26AA001'] };
let seq = 0;
// an ACTIVE, matched ad row as the loader returns it
const ad = (o = {}) => {
  seq += 1; const spend = o.thin ? 12 : (o.spend === undefined ? 400 : o.spend); const pur = o.thin ? 0 : (o.purchases === undefined ? 10 : o.purchases);
  return { meta_ad_id: o.id || `a${seq}`, ad_name: o.name || `Ad ${seq}`, meta_creative_id: o.creative === undefined ? `cr${seq}` : o.creative, effective_status: 'ACTIVE', created_time: `${day(o.createdAge || o.first || 30)}T00:00:00Z`, funnel: o.funnel || 'MOF', concept_type_id: null,
    first_day: o.first === undefined ? day(30) : day(o.first), last_day: day(1), life_spend: spend, concept_label: o.concept || null, creator_name: null, creative_style_id: null, media_type: 'video', product_codes: ['W26AA001'], delivery_rows: 14,
    t_spend: spend, t_imp: o.thin ? 500 : 40000, t_clk: 800, t_pur: pur, t_val: pur * 120, f_spend: 0, f_imp: 0, f_clk: 0, f_pur: 0, f_val: 0, g_spend: 0, g_imp: 0, g_clk: 0, g_pur: 0, g_val: 0, r_spend: 0, r_imp: 0, r_clk: 0, r_pur: 0, r_val: 0, p_spend: 0, p_imp: 0, p_clk: 0, p_pur: 0, p_val: 0 };
};
// an instance of the creative as the origins lookup sees it (ANY status / match state)
const inst = (o) => ({ meta_ad_id: o.id, meta_creative_id: o.creative === undefined ? null : o.creative, ad_name: o.name || o.id, created_time: `${day(o.createdAge)}T00:00:00Z`, first_day: o.first === undefined || o.first === null ? null : day(o.first) });
const stub = (rows, origins) => ({ query: async (sql) => (/creative-origins/.test(sql) ? { rows: origins } : /MIN\(insight_date\)/.test(sql) ? { rows: [{ d: day(300), n: day(1) }] } : { rows }) });
const load = async (rows, origins = []) => (await perf.loadProductAdPerformance([fam], { db: stub(rows, origins), rules: RULES, coded: CODED, today: TODAY, nameCopies })).get(fam.key);
const phaseOf = (c) => recency.phaseOf(c, TODAY, CFG);

test('age: an original and a later duplicate (original paused): the creative is as old as the ORIGINAL, not the duplicate', async () => {
  // the duplicate (a new Meta ad, same creative id) began delivering yesterday; the original delivered from 23 days ago but is paused, so it is not loaded
  const rows = [ad({ id: 'dup', creative: 'same', first: 1, name: 'Reaper try-on', thin: true })];
  const without = await load(rows, []);
  assert.equal(phaseOf(without.creatives[0]).phase, 'testing', 'what the dated-from-the-duplicate code used to say (the defect)');
  const out = await load(rows, [inst({ id: 'dup', creative: 'same', createdAge: 1, first: 1 }), inst({ id: 'orig', creative: 'same', createdAge: 25, first: 23 })]);
  const c = out.creatives[0];
  assert.equal(out.creatives.length, 1, 'still ONE unique creative'); assert.equal(c.ads.length, 1, 'the paused original is not added to the group: counts and performance are unchanged');
  assert.equal(c.first_delivery, day(23)); assert.equal(c.first_delivery_from_other_instance, true); assert.equal(c.instances_total, 2);
  const p = phaseOf(c); assert.notEqual(p.phase, 'testing'); assert.equal(p.started, day(23)); assert.equal(p.age_days, 23); assert.equal(p.started_basis, 'first_delivery');
});
test('age: duplicates across campaigns with different delivery dates use the EARLIEST reliable first delivery', async () => {
  const rows = [ad({ id: 'd1', creative: 'same', first: 12 }), ad({ id: 'd2', creative: 'same', first: 1 }), ad({ id: 'd3', creative: 'same', first: 3 })];
  const out = await load(rows, [inst({ id: 'orig', creative: 'same', createdAge: 40, first: 35 }), inst({ id: 'd1', creative: 'same', createdAge: 12, first: 12 })]);
  assert.equal(out.creatives.length, 1); assert.equal(out.creatives[0].ad_count, 3);
  assert.equal(out.creatives[0].first_delivery, day(35)); assert.equal(phaseOf(out.creatives[0]).age_days, 35);
  const noOrigin = await load(rows, []);
  assert.equal(noOrigin.creatives[0].first_delivery, day(12), 'with no other instance, the earliest loaded instance still wins (unchanged)');
});
test('age: a duplicate across FUNNELS is one creative: its age follows the original and each funnel keeps its own performance context', async () => {
  const rows = [ad({ id: 'm', creative: 'same', funnel: 'MOF', first: 1, spend: 400, purchases: 10 }), ad({ id: 't', creative: 'same', funnel: 'TOF', first: 1, spend: 900, purchases: 3 })];
  const out = await load(rows, [inst({ id: 'orig', creative: 'same', createdAge: 50, first: 45 })]);
  const c = out.creatives[0];
  assert.equal(out.creatives.length, 1); assert.equal(c.first_delivery, day(45));
  const by = Object.fromEntries(c.funnel_results.map((f) => [f.funnel, f.state]));
  assert.deepEqual(by, { MOF: 'performing', TOF: 'unrated' }, 'performance is still judged per funnel');
});
test('age: a "- Copy" duplicate that got its own creative id is dated from the original found by name', async () => {
  const rows = [ad({ id: 'copy', creative: 'new-id', first: 1, name: 'Reaper hero - Copy' })];
  const out = await load(rows, [inst({ id: 'orig', creative: 'old-id', name: 'Reaper hero', createdAge: 30, first: 28 })]);
  assert.equal(out.creatives[0].first_delivery, day(28));
  const unrelated = await load(rows, [inst({ id: 'other', creative: 'other-id', name: 'Reaper hero v2', createdAge: 30, first: 28 })]);
  assert.equal(unrelated.creatives[0].first_delivery, day(1), 'a different name is not the same creative: no fuzzy matching');
});
test('age: a genuinely different creative execution gets its OWN first delivery, even for the same product / concept', async () => {
  const rows = [ad({ id: 'a', creative: 'one', first: 40, concept: 'TRY ON' }), ad({ id: 'b', creative: 'two', first: 1, concept: 'TRY ON', thin: true })];
  const out = await load(rows, [inst({ id: 'a', creative: 'one', createdAge: 40, first: 40 }), inst({ id: 'b', creative: 'two', createdAge: 1, first: 1 })]);
  assert.equal(out.creatives.length, 2);
  const byKey = Object.fromEntries(out.creatives.map((c) => [c.key, c]));
  assert.equal(phaseOf(byKey['c:two']).phase, 'testing', 'the genuinely new execution is early testing'); assert.equal(byKey['c:two'].first_delivery, day(1));
  assert.equal(byKey['c:one'].first_delivery, day(40));
});
test('age: when the original has no stored delivery, an earlier-created original means the creative cannot be called new (disclosed, never invented)', async () => {
  const rows = [ad({ id: 'dup', creative: 'same', first: 1, thin: true })];
  const out = await load(rows, [inst({ id: 'dup', creative: 'same', createdAge: 1, first: 1 }), inst({ id: 'orig', creative: 'same', createdAge: 25, first: null })]);
  const c = out.creatives[0]; const p = phaseOf(c);
  assert.notEqual(p.phase, 'testing'); assert.equal(p.started_basis, 'created'); assert.equal(p.started, day(25));
  assert.match(E.startedPhrase({ date: p.started, basis: p.started_basis, age_days: p.age_days }), /created on .*first delivery date is not available/);
});
test('age: a creative with several instances and mixed delivery keeps its live status from the loaded instances and the earliest start', async () => {
  const stalled = ad({ id: 's', creative: 'same', first: 20 }); stalled.last_day = day(20);
  const live = ad({ id: 'l', creative: 'same', first: 1 });
  const out = await load([stalled, live], [inst({ id: 'o', creative: 'same', createdAge: 60, first: 55 })]);
  const c = out.creatives[0];
  assert.equal(c.first_delivery, day(55)); assert.equal(c.last_delivery, day(1));
  const sum = recency.summarize(out.creatives, TODAY, CFG, { insightsLastDay: day(1) });
  assert.equal(sum.live, 1); assert.equal(sum.by.testing, 0);
});
test('age: the product assessment after deduplication (Reaper Carpenter Short shape): a duplicate no longer makes a covered product "early testing"', async () => {
  const est = ['e1', 'e2', 'e3'].map((k, i) => ad({ id: k, creative: k, first: 60 - i, concept: `C${i}` }));
  const dup = ad({ id: 'dup', creative: 'orig-creative', first: 1, name: 'Reaper try-on', concept: 'TRY ON', thin: true });
  const evalWith = async (origins) => {
    const ev = await load([...est, dup], origins);
    return opp.evaluate(base({ sales: salesOf(164, { units7: 38, units14: 76 }), coverage: { known: true, active_ads: 4, possible: 0, unresolved: 0, unresolved_share_pct: 0, min: 5 }, creatives: ev.creatives, insights_last_day: ev.insights_last_day }), CFG, TODAY, 'core');
  };
  const after = await evalWith([inst({ id: 'orig', creative: 'orig-creative', createdAge: 30, first: 28 })]);
  assert.equal(after.facts.creative_conditions.new, 0, 'the duplicate is not an early-testing creative'); assert.equal(after.facts.unique_creatives, 4);
  assert.doesNotMatch(E.reasonFor(after, CFG), /early testing|1 day ago/);
  const before = await evalWith([]);
  assert.equal(before.facts.creative_conditions.new, 1, 'without the origin lookup the duplicate would have counted as new');
});
test('age: the origin lookup never adds ads to a group, never fails Planning, and reads only the local database', async () => {
  const failing = { query: async (sql) => { if (/creative-origins/.test(sql)) throw new Error('boom'); return /MIN\(insight_date\)/.test(sql) ? { rows: [{ d: day(300), n: day(1) }] } : { rows: [ad({ id: 'x', creative: 'k', first: 3 })] }; } };
  const out = (await perf.loadProductAdPerformance([fam], { db: failing, rules: RULES, coded: CODED, today: TODAY, nameCopies })).get(fam.key);
  assert.equal(out.creatives.length, 1); assert.equal(out.creatives[0].first_delivery, day(3), 'falls back to the loaded instances');
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'lib', 'productAdPerformance.js'), 'utf8');
  const q = src.slice(src.indexOf('/* creative-origins */'), src.indexOf('[[...ids]'));
  assert.doesNotMatch(q, /\b(INSERT|UPDATE|DELETE)\b/i);
});
