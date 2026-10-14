// Planning opportunity engine (Core / High Stocks revival / Protect momentum): the 25 scenarios from the Batch 27 brief plus the rules around them.
// Every input is a fixture; see test/_planningFixtures.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const opp = require('../src/lib/planningOpportunities');
const season = require('../src/lib/seasonRelevance');
const recency = require('../src/lib/creativeRecency');
const dpa = require('../src/lib/metaDpa');
const launch = require('../src/lib/launchStatus');
const cfgLib = require('../src/lib/creativePlanningConfig');
const { TODAY, CFG, launched, day, cr, seasonOf, salesOf, base } = require('./_planningFixtures');

const run = (p, mode = 'core', cfg = CFG) => opp.evaluate(p, cfg, TODAY, mode);
const perf3 = [cr('a', 'performing', { age: 60 }), cr('b', 'performing', { age: 40 }), cr('c', 'performing', { age: 20 })];
const strong = salesOf(150, { units7: 40, units14: 75 });
const revSales = (o = {}) => salesOf(66, { initial28: 275, recent28: 66, age_days: 200, ...o });
const hs = (o = {}) => base({ is_core: false, tier: { tier: 'platinum', index: 188 }, sales: revSales(), stock: { known: true, units: 400, on_order: 0 }, ...o });
const winterName = 'Maison Hood Sweat';

// ── 1-2. Platinum: very low current sales vs meaningful current demand ──────────────────────────────
test('1. a PLATINUM product with very low current sales is never an urgent opportunity, however far it has fallen (3 units, 6% of launch pace)', () => {
  const o = run(hs({ sales: revSales({ units7: 1, units14: 2, units30: 3, initial28: 50, recent28: 3 }), season: seasonOf('Pulse Box Fit Tee', 'TEES') }), 'revival');
  assert.equal(o.status, 'weak_demand'); assert.equal(o.actionable, false); assert.equal(o.priority, null); assert.match(o.reason, /too little current demand to revive/);
});
test('1b. a deeper decline never scores higher than a shallower one (monotonic: the revival score does not reward decline)', () => {
  const score = (initial28) => run(hs({ sales: revSales({ units30: 40, recent28: 40, initial28 }) }), 'revival');
  const shallow = score(70); const deep = score(300); // 57% vs 13% of launch pace
  assert.equal(shallow.status, 'momentum_ok'); // 57% is above the 50% line: not a revival at all
  const mid = score(120); const low = score(330); // 33% vs 12%
  assert.equal(mid.status, 'act'); assert.equal(low.status, 'act');
  assert.ok(mid.score >= low.score, `a 33% product (${mid.score}) must not score below a 12% one (${low.score})`);
  assert.equal(run(hs({ sales: revSales({ units30: 40, recent28: 40, initial28: 1400 }) }), 'revival').status, 'weak_demand', '3% of launch pace is too far gone to revive');
});
test('2. a PLATINUM product that still sells meaningfully and has lost momentum -> a revival opportunity, with the launch-pace comparison explained', () => {
  const o = run(hs({ creatives: [cr('a', 'underperforming', { age: 120, severity: 'clear' })], coverage: { known: true, active_ads: 1, possible: 0, uncertain: false, min: 5 } }), 'revival');
  assert.equal(o.status, 'act'); assert.equal(o.opportunity_type, 'revive'); assert.equal(o.revival.ratio_pct, 24);
  const text = o.why.map((w) => w.text).join('\n');
  assert.match(text, /275 units in its first 28 days, 66 in the latest 28 \(24% of launch pace\)/); assert.match(text, /not automatically creative fatigue/);
  assert.ok(o.other_explanations.some((x) => /not measured here/.test(x)));
});

// ── 3-4. Out of season ──────────────────────────────────────────────────────────────────────────────
test('3. an OUT-OF-SEASON product with weak demand is not actionable', () => {
  const o = run(base({ name: 'Hoxton Trackpant', category: 'TRACKPANTS', season: seasonOf('Hoxton Trackpant', 'TRACKPANTS'), sales: salesOf(17), stock: { known: true, units: 559, on_order: 0 } }));
  assert.equal(o.status, 'out_of_season'); assert.equal(o.actionable, false); assert.match(o.reason, /Out of season/);
});
test('4. an out-of-season product qualifies only on COMPELLING current demand AND creative evidence: stated, and never High', () => {
  const s = seasonOf('Hoxton Trackpant', 'TRACKPANTS');
  const withEvidence = run(base({ name: 'Hoxton Trackpant', season: s, sales: salesOf(90, { units7: 24, units14: 46 }), creatives: [cr('a', 'performing', { age: 90 })], coverage: { known: true, active_ads: 1, possible: 0, uncertain: false, min: 5 } }));
  assert.equal(withEvidence.status, 'act'); assert.equal(withEvidence.season.exception, true); assert.match(withEvidence.why.find((w) => w.k === 'season').text, /Exception: it still sells 90 units/);
  assert.notEqual(withEvidence.priority, 'High'); assert.ok(withEvidence.caps.some((c) => /out of season/.test(c)));
  const noCreative = run(base({ name: 'Hoxton Trackpant', season: s, sales: salesOf(90, { units7: 24, units14: 46 }), creatives: [] }));
  assert.equal(noCreative.status, 'out_of_season', 'strong sales alone are not enough: creative evidence is needed too');
  const lessSales = run(base({ name: 'Hoxton Trackpant', season: s, sales: salesOf(40), creatives: [cr('a', 'performing', { age: 90 })] }));
  assert.equal(lessSales.status, 'out_of_season', 'below the 60-unit exception');
  const weakening = run(base({ name: 'Hoxton Trackpant', season: s, sales: salesOf(90, { units7: 6, units14: 24 }), creatives: [cr('a', 'performing', { age: 90 })] }));
  assert.equal(weakening.status, 'out_of_season', 'a weakening product does not get the exception');
});

// ── 5-7. Protect momentum ──────────────────────────────────────────────────────────────────────────
const launchP = (o = {}) => base({ key: 'W26NEW1', name: 'Drop Box Fit Tee', is_core: false, launch_age_days: 12, sales: salesOf(60, { units7: 30, units14: 60, since_launch: 60, days_live: 13 }), stock: { known: true, units: 300, on_order: 0 }, ...o });
test('5. a STRONG recent launch with no effective creative -> Protect momentum: no decline, tier or 56 days of history needed', () => {
  const o = run(launchP(), 'momentum');
  assert.equal(o.status, 'act'); assert.equal(o.opportunity_type, 'protect_momentum'); assert.equal(o.kind, 'momentum'); assert.equal(o.tier, undefined);
  assert.match(o.why[0].text, /Strong recent launch \(12 days on sale/); assert.equal(o.facts.demand_basis, 'since_launch');
  assert.equal(run(launchP(), 'revival').status === 'act', false, 'the revival path still needs its own history');
});
test('5b. a recent launch is normalised per day on sale: 13 days of selling is never compared with a full 30-day month', () => {
  const o = run(launchP({ sales: salesOf(26, { units7: 14, units14: 26, since_launch: 26, days_live: 13 }) }), 'momentum');
  assert.equal(o.demand.basis, 'since_launch'); assert.equal(o.demand.partial, true);
  assert.equal(Math.round(o.demand.eq30), 60, '26 units over 13 days is about 60 in a 30-day equivalent');
  assert.equal(o.demand.level, 'strong');
});
test('6. a WEAK recent launch is not recommended just for being new; one on sale only a few days is "too early", not weak', () => {
  const weak = run(launchP({ sales: salesOf(6, { units7: 3, units14: 6, since_launch: 6, days_live: 13 }) }), 'momentum');
  assert.equal(weak.status, 'weak_demand'); assert.match(weak.reason, /Being new, or having no creative yet, is not enough on its own/);
  const early = run(launchP({ launch_age_days: 2, sales: salesOf(9, { units7: 9, units14: 9, since_launch: 9, days_live: 3 }) }), 'momentum');
  assert.equal(early.status, 'too_new'); assert.match(early.reason, /not judged until 5 days of selling/);
});
test('6b. outside the recent-launch window, or with no official launch date, it is not a Protect momentum candidate', () => {
  assert.equal(run(launchP({ launch_age_days: 90 }), 'momentum').status, 'not_recent');
  assert.equal(run(launchP({ launch_age_days: null }), 'momentum').status, 'not_recent');
  assert.equal(run(launchP({ launch: { status: 'unlaunched', eligible: false, detail: 'ApparelMagic launch date 2026-11-02 is still ahead.' } }), 'momentum').status, 'not_launched');
});
test('7. a recent launch with INSUFFICIENT effective creative is recommended even where an established product with the same creative would not be', () => {
  const thin = [cr('a', 'performing', { age: 10 }), cr('b', 'unrated', { age: 9 })];
  const o = run(launchP({ creatives: thin, coverage: { known: true, active_ads: 2, possible: 0, uncertain: false, min: 5 } }), 'momentum');
  assert.equal(o.status, 'act'); assert.equal(o.gap.type, 'thin');
  const core = run(launchP({ is_core: true, creatives: thin, sales: salesOf(30), coverage: { known: true, active_ads: 2, possible: 0, uncertain: false, min: 5 } }), 'core');
  assert.equal(core.status, 'covered', 'a thin shortfall on steady demand does not justify action for an established product');
});

// ── 8-9. Distribution and poor performance ─────────────────────────────────────────────────────────
test('8. a strong seller with ONE DOMINANT creative is not "covered", even with three performing ads', () => {
  const dominant = [cr('a', 'performing', { age: 60, spend: 1800, purchases: 40, concept: 'TRY ON' }), cr('b', 'performing', { age: 50, spend: 120, purchases: 3, concept: 'TRY ON' }), cr('c', 'performing', { age: 40, spend: 80, purchases: 2, concept: 'TRY ON' })];
  const o = run(base({ sales: strong, creatives: dominant, coverage: { known: true, active_ads: 3, possible: 0, uncertain: false, min: 5 } }));
  assert.equal(o.status, 'act'); assert.equal(o.gap.type, 'concentration'); assert.match(o.headline, /Delivery concentrated: leading ad carries 90%/);
  assert.equal(Math.round(o.evidence.top_purchase_share), 89);
  const balanced = [cr('a', 'performing', { spend: 700, purchases: 15, concept: 'TRY ON' }), cr('b', 'performing', { spend: 600, purchases: 13, concept: 'UGC' }), cr('c', 'performing', { spend: 500, purchases: 11, concept: 'FLAT LAY' })];
  assert.equal(run(base({ sales: strong, creatives: balanced, coverage: { known: true, active_ads: 3, possible: 0, uncertain: false, min: 5 } })).status, 'covered');
});
test('8b. several performing ads that are all ONE concept are low diversity (judged only when concepts are recorded)', () => {
  const same = [cr('a', 'performing', { spend: 600, concept: 'UGC' }), cr('b', 'performing', { spend: 550, concept: 'UGC' }), cr('c', 'performing', { spend: 500, concept: 'UGC' })];
  const o = run(base({ sales: strong, creatives: same, coverage: { known: true, active_ads: 3, possible: 0, uncertain: false, min: 5 } }));
  assert.equal(o.gap.type, 'diversity');
  const unknown = same.map((c) => ({ ...c, concept: null }));
  assert.equal(run(base({ sales: strong, creatives: unknown, coverage: { known: true, active_ads: 3, possible: 0, uncertain: false, min: 5 } })).status, 'covered', 'unclassified ads are "unknown", never "the same"');
});
test('9. a product with MANY ads but poor performance is a gap: ad count is not coverage', () => {
  const o = run(base({ sales: strong, coverage: { known: true, active_ads: 12, possible: 0, uncertain: false, min: 5 }, creatives: Array.from({ length: 6 }, (_, i) => cr(`w${i}`, 'underperforming', { age: 100 + i, severity: 'clear', cpa: 90, concept: `C${i}` })) }));
  assert.equal(o.status, 'act'); assert.equal(o.gap.type, 'underperforming');
});

// ── 10-12. Testing, production, matching ───────────────────────────────────────────────────────────
test('10. a creative in its first days is early testing; it does not silence a product that still lacks creative, but enough creative in play does', () => {
  const quiet = run(base({ sales: salesOf(30), creatives: [cr('a', 'insufficient', { age: 3, spend: 20 }), cr('b', 'underperforming', { age: 120, severity: 'clear' })], coverage: { known: true, active_ads: 2, possible: 0, uncertain: false, min: 5 } }));
  assert.equal(quiet.status, 'act', 'Batch 30: a newly launched ad never places the whole product in monitoring while the product is short of creative');
  assert.equal(quiet.gap.type, 'underperforming');
  assert.ok(quiet.score_parts.some((p) => /already testing or in production/.test(p.label) && p.points < 0), 'it is scored lower for what is already in play');
  const day5 = run(base({ sales: strong, creatives: [cr('a', 'insufficient', { age: 5, spend: 20 }), cr('b', 'underperforming', { age: 120, severity: 'clear' })], coverage: { known: true, active_ads: 2, possible: 0, uncertain: false, min: 5 } }));
  assert.equal(day5.facts.creative_conditions.insufficient_delivery, 1, 'from day 5 it is assessed: insufficient delivery, not "early"'); assert.equal(day5.facts.creative_conditions.new, 0);
  const enough = run(base({ sales: strong, creatives: [cr('a', 'performing', { age: 90 }), cr('b', 'performing', { age: 80 }), cr('c', 'insufficient', { age: 4, spend: 10 }), cr('d', 'underperforming', { age: 100, severity: 'clear' })] }));
  assert.equal(enough.status, 'testing', 'performing + early testing reaches the wanted number: wait for the data'); assert.match(enough.reason, /in early testing, in the first 4 days of delivery/);
  assert.doesNotMatch(enough.reason, /too early to judge|gathering data/i);
});
test('10b. an upload recorded only in WNDRR production (not yet matched to a Meta ad) also counts as testing', () => {
  const o = run(base({ sales: salesOf(30), creatives: [], pipeline: { in_flight: 0, by_stage: {}, uploaded: [{ date: day(3), concept: 'UGC' }], this_week: 0 } }));
  assert.equal(o.status, 'testing'); assert.match(o.reason, /production record/);
});
test('11. UNRESOLVED suggested Meta matches are uncertainty, never a confirmed absence of creative', () => {
  const none = run(base({ sales: strong, creatives: [], coverage: { known: true, active_ads: 0, possible: 3, uncertain: false, min: 5 } }));
  assert.equal(none.status, 'insufficient_data'); assert.match(none.reason, /Matching is uncertain: 3 active Meta ads awaiting review/); assert.equal(none.facts.matching, 'uncertain');
  const gap = run(base({ sales: strong, creatives: [], coverage: { known: true, active_ads: 0, possible: 0, uncertain: false, min: 5 } }));
  assert.equal(gap.status, 'act'); assert.equal(gap.gap.type, 'confirmed_gap'); assert.equal(gap.facts.matching, 'confirmed');
  assert.equal(run(base({ sales: strong, creatives: perf3, coverage: { known: true, active_ads: 3, possible: 4, uncertain: false, min: 5 } })).status, 'covered', 'enough performing creative stays covered whatever is awaiting review');
});
test('12. PAUSED historical winners are evidence, not coverage: the gap is real, the direction comes from the winner, and it counts as creative evidence for a season exception', () => {
  const winners = [{ concept: 'TRY ON', media: 'VIDEO', cpa: 41, spend: 3200, running_now: false }];
  const o = run(base({ sales: strong, creatives: [], history: { winners } }));
  assert.equal(o.status, 'act'); assert.equal(o.gap.type, 'confirmed_gap'); assert.match(o.gap.text, /1 creative that performed before is paused or finished/);
  assert.equal(o.direction.basis, 'product_history'); assert.match(o.direction.text, /"TRY ON".*paused or no longer running/);
  const s = seasonOf('Hoxton Trackpant', 'TRACKPANTS');
  const ex = run(base({ name: 'Hoxton Trackpant', season: s, sales: salesOf(90, { units7: 24, units14: 46 }), creatives: [], history: { winners } }));
  assert.equal(ex.status, 'act'); assert.equal(ex.season.exception, true);
});

// ── 13-14. Data quality and benchmarks ─────────────────────────────────────────────────────────────
test('13. INCOMPLETE sales data: missing sales are insufficient data; a partial read can never produce High priority', () => {
  assert.equal(run(base({ sales: { available: false } })).status, 'insufficient_data');
  const full = run(base({ sales: strong }));
  assert.equal(full.priority, 'High');
  const partial = run(base({ sales: strong, data_quality: { sales_complete: false, sales_notes: ['3 of the last 30 days could not be read from ApparelMagic'], discrepancy: null } }));
  assert.equal(partial.status, 'act'); assert.equal(partial.priority, 'Medium'); assert.match(partial.caps.join(' '), /under-counted/);
  const disagree = run(base({ sales: strong, data_quality: { sales_complete: true, discrepancy: { flag: true, text: 'ApparelMagic 140 against Shopify 60' } } }));
  assert.equal(disagree.priority, 'Medium'); assert.match(disagree.caps.join(' '), /two sales sources disagree/);
});
test('14. MISSING funnel benchmarks: unrated creatives are neither good nor bad, no benchmark is invented, and concentration is still found', () => {
  // Batch 30: unrated creatives are still creatives in play. Two of them are thin coverage; enough of them is monitoring. Neither is good nor bad.
  const o = run(base({ sales: strong, creatives: [cr('a', 'unrated', { age: 90 }), cr('b', 'unrated', { age: 80 })] }));
  assert.equal(o.status, 'act'); assert.equal(o.gap.type, 'thin'); assert.match(o.reason, /2 creatives in play \(3 wanted\)/); assert.doesNotMatch(o.reason, /underperform|over the approved/i);
  const tom = run(base({ sales: strong, creatives: ['a', 'b', 'c'].map((k, i) => ({ ...cr(k, 'unrated', { age: 90 - i }), funnel: 'TOM' })) }));
  assert.equal(tom.status, 'covered'); assert.match(tom.reason, /3 that cannot be benchmarked \(no approved TOM benchmark\)/); assert.doesNotMatch(tom.reason, /gathering data/);
  const conc = run(base({ sales: strong, creatives: [cr('a', 'unrated', { spend: 1500, purchases: 30, concept: 'X' }), cr('b', 'unrated', { spend: 100, purchases: 2, concept: 'Y' })], coverage: { known: true, active_ads: 2, possible: 0, uncertain: false, min: 5 } }));
  assert.equal(conc.status, 'act'); assert.equal(conc.gap.type, 'concentration', 'concentration does not depend on a CPA benchmark');
});

// ── 15. Already in production ──────────────────────────────────────────────────────────────────────
test('15. concepts already in production count as supply; they block a product that is covered by them, not a strong seller that needs more', () => {
  const pipe = (n) => ({ in_flight: n, by_stage: { planned: 1, filmed: Math.max(0, n - 1) }, uploaded: [], this_week: n });
  const three = run(base({ sales: strong, creatives: [cr('a', 'underperforming', { age: 90, severity: 'clear' })], pipeline: pipe(3) }));
  assert.equal(three.status, 'in_production'); assert.match(three.reason, /3 concepts already in the Shoot Plan pipeline \(1 planned, 2 filmed\)/);
  const one = run(base({ sales: strong, creatives: [cr('a', 'underperforming', { age: 90, severity: 'clear' })], pipeline: pipe(1) }));
  assert.equal(one.status, 'act', 'one concept in production does not block every other opportunity for a strongly selling product'); assert.match(one.why.find((w) => w.k === 'production').text, /additional, not a duplicate/);
  const modest = run(base({ sales: salesOf(30), creatives: [cr('a', 'underperforming', { age: 90, severity: 'clear' })], pipeline: pipe(1) }));
  assert.equal(modest.status, 'in_production');
});

// ── 16-17. Core identity and one primary recommendation ────────────────────────────────────────────
test('16. a CORE product failing its demand check stays a Core result: a High Stocks revival can never replace it', () => {
  const primary = require('../src/lib/planningPrimary');
  const p = hs({ is_core: true, sales: revSales({ units30: 2, units7: 0, units14: 1, recent28: 2, initial28: 150 }), season: seasonOf('Revoked Cargo Pant', 'PANTS') });
  const core = run(p, 'core'); const rev = run(p, 'revival');
  assert.equal(core.status, 'weak_demand'); assert.equal(rev.status, 'weak_demand');
  const pick = primary.choosePrimary({ is_core: true, core, revival: rev });
  assert.equal(pick.primary.mode, 'core'); assert.equal(pick.placement, 'core'); assert.equal(pick.primary.status, 'weak_demand');
  // even a (hypothetical) revival ACT does not replace a Core result that is not an action
  const fakeRev = { ...rev, status: 'act', actionable: true, score: 90, priority: 'High', label: 'x' };
  const pick2 = primary.choosePrimary({ is_core: true, core, revival: fakeRev });
  assert.equal(pick2.primary.mode, 'core'); assert.equal(pick2.also.length, 1); assert.equal(pick2.also[0].mode, 'revival');
});
test('17. a product qualifying for several opportunity types shows ONE primary recommendation and lists the others', () => {
  const primary = require('../src/lib/planningPrimary');
  const mk = (mode, score, o = {}) => ({ mode, status: 'act', actionable: true, score, priority: 'High', headline: mode, ...o });
  const core = primary.choosePrimary({ is_core: true, core: mk('core', 70), revival: mk('revival', 95), momentum: mk('momentum', 90) });
  assert.equal(core.primary.mode, 'core'); assert.equal(core.placement, 'core'); assert.deepEqual(core.also.map((a) => a.mode).sort(), ['momentum', 'revival']);
  const nonCore = primary.choosePrimary({ is_core: false, revival: mk('revival', 80), momentum: mk('momentum', 85) });
  assert.equal(nonCore.primary.mode, 'momentum'); assert.equal(nonCore.placement, 'momentum'); assert.equal(nonCore.also.length, 1);
  const tie = primary.choosePrimary({ is_core: false, revival: mk('revival', 80), momentum: mk('momentum', 80) });
  assert.equal(tie.primary.mode, 'revival', 'ties go to the revival');
  const coreMomentum = primary.choosePrimary({ is_core: true, core: { mode: 'core', status: 'covered', actionable: false }, momentum: mk('momentum', 85) });
  assert.equal(coreMomentum.placement, 'core', 'an official Core product keeps its Core identity when it is a Protect momentum candidate'); assert.equal(coreMomentum.primary.mode, 'momentum');
  const none = primary.choosePrimary({ is_core: false, revival: { mode: 'revival', status: 'too_new', actionable: false }, momentum: { mode: 'momentum', status: 'weak_demand', actionable: false } });
  assert.equal(none.primary.mode, 'momentum', 'when neither acts, the more informative status is shown');
});

// ── 18-19. Stock ───────────────────────────────────────────────────────────────────────────────────
test('18. INSUFFICIENT stock: too few units, or too little cover for creative to pay off, is not a recommendation (and incoming stock does not change that)', () => {
  assert.equal(run(base({ stock: { known: true, units: 12, on_order: 200 }, sales: strong })).status, 'low_stock');
  const short = run(base({ stock: { known: true, units: 60, on_order: 0 }, sales: salesOf(100, { units7: 25, units14: 50 }) }));
  assert.equal(short.status, 'low_stock'); assert.match(short.reason, /only 2.4 weeks of stock/);
  // Batch 29: incoming stock never counts as available, so an open order does not rescue a short runway
  const restocked = run(base({ stock: { known: true, units: 60, on_order: 300 }, sales: salesOf(100, { units7: 25, units14: 50 }) }));
  assert.equal(restocked.status, 'low_stock'); assert.equal(restocked.stock_issue, 'short_runway'); assert.match(restocked.reason, /300 on order do not count/);
});
test('19. VERY HIGH stock cover earns no extra priority, and with weak demand it is not a reason to recommend at all', () => {
  const low = run(base({ stock: { known: true, units: 600, on_order: 0 }, sales: salesOf(12) }));
  assert.equal(low.status, 'weak_demand'); assert.match(low.reason, /not steady selling/); // weak sellers are excluded before stock cover is even considered
  const healthy = run(base({ stock: { known: true, units: 150, on_order: 0 }, sales: strong }));
  const excess = run(base({ stock: { known: true, units: 4000, on_order: 0 }, sales: strong }));
  assert.equal(healthy.stock.band, 'healthy'); assert.equal(excess.stock.band, 'excess');
  assert.ok(excess.score < healthy.score, `150 weeks of cover (${excess.score}) must not outscore healthy cover (${healthy.score})`);
  assert.equal(excess.score_parts.find((p) => /^Stock/.test(p.label)).points, 0);
});

// ── 20-21. Trend ───────────────────────────────────────────────────────────────────────────────────
test('20. IMPROVING recent sales score higher than the same total with a stable pace; and absolute volume matters, not only percentages', () => {
  const stable = run(base({ sales: salesOf(80, { units7: 19, units14: 37 }) })); const improving = run(base({ sales: salesOf(80, { units7: 34, units14: 50 }) }));
  assert.equal(stable.demand.trend, 'stable'); assert.equal(improving.demand.trend, 'improving'); assert.ok(improving.score > stable.score);
  const dm = require('../src/lib/planningDemand');
  assert.equal(dm.demandOf({ available: true, units7: 14, units14: 40, units30: 120 }, CFG).trend, 'weakening', '100 -> 70 a week is a real weakening of a strong product');
  assert.equal(dm.demandOf({ available: true, units7: 1, units14: 6, units30: 12 }, CFG).trend, 'stable', '10 -> 2 units in a month is too small a change in absolute units to call');
});
test('21. DECLINING recent sales: a weakening product is scored lower, and a weakening revival cannot be High', () => {
  const weakening = run(base({ sales: salesOf(80, { units7: 6, units14: 20 }) })); const stable = run(base({ sales: salesOf(80, { units7: 19, units14: 37 }) }));
  assert.equal(weakening.demand.trend, 'weakening'); assert.ok(weakening.score < stable.score);
  const rev = run(hs({ sales: revSales({ units7: 3, units14: 11, units30: 36, recent28: 34, initial28: 150 }), creatives: [] }), 'revival');
  assert.equal(rev.status, 'act'); assert.equal(rev.demand.level, 'steady'); assert.equal(rev.demand.trend, 'weakening');
  assert.notEqual(rev.priority, 'High'); assert.ok(rev.caps.some((c) => /still weakening/.test(c)));
});

// ── 22-24. The 56-day rule and valid history ───────────────────────────────────────────────────────
test('22. a product launched fewer than 56 days ago cannot be a High Stocks revival, but can be a Protect momentum candidate', () => {
  const young = hs({ sales: revSales({ age_days: 30, initial28: 200, recent28: 60 }), launch_age_days: 30 });
  const rev = run(young, 'revival'); assert.equal(rev.status, 'too_new'); assert.match(rev.reason, /needs 56 before its first 28 days and latest 28 days can be compared/);
  const mom = run({ ...young, sales: salesOf(70, { units7: 20, units14: 40, since_launch: 70, days_live: 31, age_days: 30 }) }, 'momentum');
  assert.equal(mom.status, 'act');
});
test('23. a product with 56+ days of valid history is evaluated as a revival; the 56-day setting is configurable', () => {
  assert.equal(run(hs({ sales: revSales({ age_days: 56 }) }), 'revival').status, 'act');
  assert.equal(run(hs({ sales: revSales({ age_days: 55 }) }), 'revival').status, 'too_new');
  const cfg = cfgLib.resolve({ revival_min_age_days: 90 }).config;
  assert.equal(run(hs({ sales: revSales({ age_days: 60 }) }), 'revival', cfg).status, 'too_new');
});
test('24. INCOMPLETE historical sales windows: an unreadable first 28 days is "not enough data", never a guess', () => {
  const o = run(hs({ sales: revSales({ initial28: null, age_days: null }) }), 'revival');
  assert.equal(o.status, 'insufficient_data'); assert.match(o.reason, /first 28 days of sales cannot be read/);
});

// ── 25. DPA ────────────────────────────────────────────────────────────────────────────────────────
test('25. DPA-only coverage is not creative coverage: with the DPAs excluded the product has no unique creative', () => {
  const o = run(base({ sales: strong, creatives: [], coverage: { known: true, active_ads: 0, possible: 0, uncertain: false, min: 5 } }));
  assert.equal(o.gap.type, 'confirmed_gap'); assert.match(o.why.find((w) => w.k === 'matching').text, /DPAs are not counted/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'productAdPerformance.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'activeAdCoverage.js'), 'utf8');
  assert.match(src, /dpaLib\.dpaPredicate\('m', 'c'\)/); assert.match(src, /dpaLib\.notDpaStandalone\('m'\)/);
});

// ── the rules around them ──────────────────────────────────────────────────────────────────────────
test('no product name is hardcoded into the recommendation logic', () => {
  const names = ['Revoked', 'Booster', 'Junction', 'Pulse', 'Revival Hood', 'United Hood', 'Slammed', 'Offend', 'Rothman', 'Starter', 'Soho', 'Accent', 'Hexed', 'Maison', 'Casa Del Dolor'];
  ['planningOpportunities', 'planningOpportunitiesLoader', 'planningDemand', 'planningSales', 'planningPrimary', 'creativeEvidence', 'seasonRelevance', 'creativePlanningConfig'].forEach((f) => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', `${f}.js`), 'utf8');
    names.forEach((n) => assert.equal(new RegExp(`\\b${n}\\b`, 'i').test(src.replace(/\/\/.*$/gm, '')), false, `${f} mentions ${n}`));
  });
});
test('the priority cut-offs are configurable and validated', () => {
  const o = run(base({ sales: strong }), 'core', cfgLib.resolve({ priority_high_min: 99 }).config);
  assert.notEqual(o.priority, 'High');
  const r = cfgLib.resolve({ priority_high_min: 40, priority_medium_min: 60 });
  assert.ok(r.issues.some((i) => /priority_medium_min must be below/.test(i))); assert.ok(r.config.priority_medium_min < r.config.priority_high_min);
  assert.ok(cfgLib.resolve({ demand_steady_units: 80, demand_strong_units: 50 }).issues.length);
});
test('demand bands are absolute: steady and strong need real units; weak demand can never be High', () => {
  const dm = require('../src/lib/planningDemand');
  assert.equal(dm.demandOf({ available: true, units7: 1, units14: 2, units30: 5 }, CFG).level, 'very_weak');
  assert.equal(dm.demandOf({ available: true, units7: 3, units14: 6, units30: 15 }, CFG).level, 'weak');
  assert.equal(dm.demandOf({ available: true, units7: 6, units14: 11, units30: 30 }, CFG).level, 'steady');
  assert.equal(dm.demandOf({ available: true, units7: 14, units14: 27, units30: 60 }, CFG).level, 'strong');
  // weak demand alone no longer qualifies (Batch 29); a Platinum product that still sells qualifies on Demand Planning's signal, and is held at Medium
  assert.equal(run(base({ sales: salesOf(15), stock: { known: true, units: 120, on_order: 0 } })).status, 'weak_demand');
  const weakHigh = run(base({ tier: { tier: 'platinum', index: 180 }, sales: salesOf(15), stock: { known: true, units: 120, on_order: 0 } }));
  assert.equal(weakHigh.status, 'act'); assert.notEqual(weakHigh.priority, 'High'); assert.match(weakHigh.caps.join(' '), /demand is only modest/);
});
test('a thin shortfall (some performing creative, fewer than wanted, nothing weak) only acts for an established product when demand is strong', () => {
  const thin = [cr('a', 'performing', { age: 100, concept: 'A' }), cr('b', 'performing', { age: 90, concept: 'B' })];
  assert.equal(run(base({ sales: strong, creatives: thin, coverage: { known: true, active_ads: 2, possible: 0, uncertain: false, min: 5 } })).gap.type, 'thin');
  const mid = run(base({ sales: salesOf(30), creatives: thin, coverage: { known: true, active_ads: 2, possible: 0, uncertain: false, min: 5 } }));
  assert.notEqual(mid.status, 'act'); assert.match(mid.reason, /thin shortfall alone does not justify action/);
});
test('the direction comes only from the product\'s own history or current performers; none is invented', () => {
  const o = run(base({ sales: strong, creatives: [cr('a', 'underperforming', { age: 100, severity: 'clear' })], history: { winners: [{ concept: 'TRY ON', media: 'VIDEO', cpa: 41, spend: 3200, running_now: false }] } }));
  assert.equal(o.direction.basis, 'product_history'); assert.match(o.direction.text, /\$41 CPA/);
  assert.equal(run(base({ sales: strong, creatives: [] })).direction, null);
});
test('Meta data unavailable is never read as underperformance; launch problems go to verification, not an opportunity', () => {
  assert.equal(run(base({ sales: strong, coverage: { known: false, min: 5 } })).status, 'insufficient_data');
  const l = launch.assessFamily({ styles: [{ style_code: 'W26IA020FBK', launchDate: null, qty: 34 }] }, TODAY);
  assert.equal(run(base({ launch: l, is_core: false })).status, 'launch_unknown');
  const future = launch.assessFamily({ styles: [{ style_code: 'W26IA006BLK', launchDate: new Date('2026-11-02T00:00:00Z'), qty: 57, shopify: { status: 'ACTIVE', published_at: '2026-08-24T23:02:00Z' } }] }, TODAY);
  assert.equal(run(base({ launch: future, sales: strong })).status, 'not_launched');
});
test('there is no padding: only genuine opportunities are actionable, however few', () => {
  const ps = [base({ key: 'A', sales: strong }), ...Array.from({ length: 9 }, (_, i) => base({ key: `F${i}`, sales: salesOf(40), creatives: perf3 }))];
  const { items } = opp.assessAll(ps, CFG, TODAY);
  assert.equal(items.filter((i) => i.actionable).length, 1); assert.equal(items.length, 10);
});
test('every actionable item explains itself: summary, evidence and a score that adds up', () => {
  const o = run(base({ sales: strong }));
  assert.match(o.why[0].text, /^Strong recent sales, sufficient stock and no effective creative running\.$/);
  ['summary', 'gap', 'demand', 'stock', 'season', 'matching'].forEach((k) => assert.ok(o.why.some((w) => w.k === k), k));
  assert.ok(o.eligibility.length >= 6 && o.eligibility.every((e) => e.ok), 'every rule that was met is listed');
  assert.equal(Math.min(100, o.score_parts.reduce((s, p) => s + p.points, 0)), o.score);
});

test('every actionable item carries an opportunity label for every kind of gap (the table column depends on it)', () => {
  const gaps = [base({ sales: strong }), base({ sales: strong, creatives: [cr('a', 'underperforming', { age: 100, severity: 'clear' })] }),
    base({ sales: strong, creatives: [cr('a', 'performing', { spend: 1800, purchases: 40, concept: 'A' }), cr('b', 'performing', { spend: 100, purchases: 2, concept: 'B' })], coverage: { known: true, active_ads: 2, possible: 0, uncertain: false, min: 5 } }),
    base({ sales: strong, creatives: [cr('a', 'performing', { spend: 600, concept: 'U' }), cr('b', 'performing', { spend: 550, concept: 'U' }), cr('c', 'performing', { spend: 500, concept: 'U' })], coverage: { known: true, active_ads: 3, possible: 0, uncertain: false, min: 5 } }),
    base({ sales: strong, creatives: [cr('a', 'performing', { age: 100, concept: 'A' }), cr('b', 'performing', { age: 90, concept: 'B' })], coverage: { known: true, active_ads: 2, possible: 0, uncertain: false, min: 5 } })];
  const types = new Set();
  gaps.forEach((p) => { const o = run(p); assert.equal(o.status, 'act'); assert.ok(o.opportunity_label, `label for ${o.opportunity_type}`); types.add(o.opportunity_type); });
  assert.deepEqual([...types].sort(), ['concentration', 'confirmed_gap', 'diversity', 'thin', 'underperforming']);
  Object.keys(opp.OPP_LABEL).forEach((k) => assert.ok(opp.OPP_LABEL[k]));
});

// ── seasonal relevance ─────────────────────────────────────────────────────────────────────────────
test('season: WNDRR naming is recognised (S/S, 1/4, tees, shorts, sweats, trackpants, jeans)', () => {
  const cls = (name, category = null) => season.classify({ name, category }).class;
  for (const n of ['Starter S/S Shirt', 'Soho Tees', 'Accent Regular Fit Tee', 'Offend Beach Short', 'Rothman Sport Short', 'Accent Mesh Short', 'Hexed Box Fit Tee', 'Linen Short Sleeve Shirt']) assert.equal(cls(n), 'summer', n);
  for (const n of ['Soho 1/4 Zips', 'Maison 1/4 Zip Sweat', 'Quarter Zip Top', 'Basic L/S Tee Shirt']) assert.equal(cls(n), n === 'Basic L/S Tee Shirt' ? 'summer' : 'transitional', n);
  for (const n of ['Pulse Crew Sweat', 'Revival Hood Sweat', 'Slammed Hood Sweat', 'Junction Baggy Trackpant', 'Heavy Fleece Crew']) assert.equal(cls(n), 'winter', n);
  for (const n of ['Booster Carpenter Jean', 'Revoked Cargo Pant', 'Bronco Baggy Jean', 'Wide Leg Trouser']) assert.equal(cls(n), 'neutral', n);
  assert.equal(cls('Plain Item', 'SWEATS'), 'winter', 'the category text is read as well as the name');
});
test('season: Australian months: summer items in season Oct-Mar, winter items May-Aug, 1/4 zips never excluded, pants neutral', () => {
  const state = (name, month, extra = {}) => season.assess({ name, month, ...extra }).state;
  assert.equal(state('Camp Short', 10), 'in_season'); assert.equal(state('Camp Short', 7), 'out_of_season');
  assert.equal(state('Hoxton Trackpant', 10), 'out_of_season'); assert.equal(state('Hoxton Trackpant', 6), 'in_season');
  for (let m = 1; m <= 12; m += 1) assert.notEqual(state('Soho 1/4 Zip', m), 'out_of_season', `1/4 zip in month ${m}`);
  assert.equal(state('Soho 1/4 Zip', 10), 'shoulder'); assert.equal(state('Soho 1/4 Zip', 6), 'in_season');
  for (let m = 1; m <= 12; m += 1) assert.equal(state('Booster Carpenter Jean', m), 'neutral');
});
test('season: a Black Friday / Christmas peak is a promotion, not a season', () => {
  const ev = { current_index: 0.9, horizon_months: ['2026-11', '2026-12'], peaks: [{ month: 'Nov', index: 1.8 }, { month: 'Dec', index: 1.6 }] };
  const promo = season.assess({ name: 'Maison Hood Sweat', month: 10, data: 'coming_into_season', dataEvidence: ev });
  assert.equal(promo.state, 'out_of_season'); assert.match(promo.pattern_note, /Black Friday \/ Christmas promotion months/);
  const real = season.assess({ name: 'Maison Hood Sweat', month: 10, data: 'coming_into_season', dataEvidence: { ...ev, horizon_months: ['2026-11', '2027-01'] } });
  assert.equal(real.state, 'in_season', 'a coming season that is not only the promotion months is believed');
});
test('season: one year of "in season" data at a low index does not overrule the Australian rule; a strong one does, and says so', () => {
  const weak = season.assess({ name: 'Maison Hood Sweat', month: 10, data: 'in_season', dataEvidence: { current_index: 1.12, peaks: [{ month: 'Jul', index: 1.4 }] } });
  assert.equal(weak.state, 'out_of_season'); assert.match(weak.pattern_note, /below the 125%/);
  const strongData = season.assess({ name: 'Maison Hood Sweat', month: 10, data: 'in_season', dataEvidence: { current_index: 1.4, peaks: [{ month: 'Oct', index: 1.4 }] } });
  assert.equal(strongData.state, 'in_season'); assert.equal(strongData.source, 'sales_pattern'); assert.match(strongData.reasons.join(' '), /category rule would say the opposite/);
  const promoPeaks = season.assess({ name: 'Maison Hood Sweat', month: 10, data: 'in_season', dataEvidence: { current_index: 1.4, peaks: [{ month: 'Nov', index: 1.9 }, { month: 'Dec', index: 1.7 }] } });
  assert.equal(promoPeaks.state, 'out_of_season');
});
test('season: the measured sales pattern still wins when it says OUT, with the disagreement shown', () => {
  const s = season.assess({ category: 'TEES', name: 'Box Fit Tee', month: 10, data: 'out_of_season' });
  assert.equal(s.state, 'out_of_season'); assert.equal(s.source, 'sales_pattern'); assert.match(s.reasons.join(' '), /category rule would say the opposite/);
});

// ── creative recency ───────────────────────────────────────────────────────────────────────────────
test('recency phases: testing / recent / established / declining / stale, and no data is never "weak"', () => {
  const ph = (c) => recency.phaseOf(c, TODAY, CFG).phase;
  assert.equal(ph(cr('a', 'insufficient', { age: 4 })), 'testing'); assert.equal(ph(cr('a', 'insufficient', { age: 5 })), 'unjudged', 'from day 5 it is assessed: insufficient delivery, never too early'); assert.equal(ph(cr('a', 'insufficient', { age: 40 })), 'unjudged'); assert.equal(ph(cr('a', 'insufficient', { age: 200 })), 'stale');
  assert.equal(ph(cr('a', 'underperforming', { age: 10 })), 'recent_weak'); assert.equal(ph(cr('a', 'underperforming', { age: 60 })), 'weak'); assert.equal(ph(cr('a', 'underperforming', { age: 150 })), 'stale');
  assert.equal(ph(cr('a', 'performing', { age: 10 })), 'recent_performing'); assert.equal(ph(cr('a', 'performing', { age: 200 })), 'performing');
  assert.equal(ph(cr('a', 'declining', { age: 200 })), 'declining'); assert.equal(ph(cr('a', 'unrated', { age: 200 })), 'unrated');
  const sum = recency.summarize([cr('a', 'performing', { trend: { softening: true } }), cr('b', 'performing')], TODAY, CFG);
  assert.equal(sum.performing, 2); assert.equal(sum.softening, 1, 'a softening ad still counts as performing');
});

// ── DPA detection ──────────────────────────────────────────────────────────────────────────────────
test('DPA detection: whole-word DPA in the ad or campaign name, catalogue-sales objective, or a person\'s classification; no substring false positives', () => {
  for (const ad_name of ['DPA - Catalogue', '[DPA] All Products', 'WNDRR_DPA_BAU', 'dpa catalogue retargeting', 'Catalogue | DPA']) assert.equal(dpa.isDpa({ ad_name }), true, ad_name);
  assert.equal(dpa.dpaReason({ campaign_name: 'MOF | DPA | Catalogue' }), 'campaign_name'); assert.equal(dpa.dpaReason({ ad_name: 'x', objective: 'PRODUCT_CATALOG_SALES' }), 'objective'); assert.equal(dpa.dpaReason({ ad_name: 'x', concept_label: 'dpa' }), 'classified');
  for (const ad_name of ['ADPAD Heavy Weight Tee', 'Updating Tee DPAX', 'Heavy Weight Tee - Try On', 'Sandpaper Tee', '', null]) assert.equal(dpa.isDpa({ ad_name }), false, String(ad_name));
  assert.equal(dpa.parseDpaMode({}), 'exclude'); assert.equal(dpa.parseDpaMode({ dpa: 'include' }), 'include'); assert.equal(dpa.parseDpaMode({ dpa: 'x' }), 'exclude');
});
