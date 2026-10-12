// Batch 12: the weekly video plan engine. Scenario tests from the brief (pure; every input is a fixture, nothing is live data).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../src/lib/weeklyVideoPlan');
const cfgLib = require('../src/lib/creativePlanningConfig');
const P = require('../src/lib/productAdPerformance');
const L = require('../src/lib/launchStatus');
const CFG = cfgLib.resolve({}).config;
const TODAY = '2026-10-12';
const SETTINGS = { weekly_video_target: 25, min_active_ads: 5, high_stock_min_soh: 100 };

const cr = (state, severity, extra = {}) => ({ key: Math.random().toString(36).slice(2), state, severity, concept: extra.concept || 'TRY ON', creator: extra.creator || 'Mark', spend: 200 });
const SEASON = { none: { status: 'year_round', label: 'Year-round', outlook: { boost: 'none', text: 'No seasonal lift expected in the next two weeks.' } }, now: { status: 'in_season', label: 'In season', outlook: { boost: 'strong', entering: 'now', text: 'In season now (1.4× its usual level).' } }, imm: { status: 'coming_into_season', label: 'Coming into season', outlook: { boost: 'strong', entering: 'immediate', text: 'Entering its stronger selling period within 7 days.' } }, sec: { status: 'coming_into_season', label: 'Coming into season', outlook: { boost: 'small', entering: 'secondary', text: 'Entering its stronger selling period in 8-14 days: a smaller boost.' } }, later: { status: 'coming_into_season', label: 'Coming into season', outlook: { boost: 'none', entering: 'later', text: 'Its stronger period is more than 14 days away: kept as an insight, not a reason to shoot this week.' } }, out: { status: 'out_of_season', label: 'Out of season', outlook: { boost: 'none', text: 'No seasonal lift expected in the next two weeks.' } } };
const LAUNCHED = { status: 'launched', eligible: true, needs_check: false };
let seq = 0;
function fam(o = {}) {
  seq += 1;
  const creatives = o.creatives || [];
  const performance = o.noPerf ? null : P.summarizeProduct(creatives, { activeAds: o.activeAds ?? creatives.length, pendingAds: o.pending || 0 });
  return {
    key: o.key || `P${seq}`, name: o.name || `PRODUCT ${seq}`, category: 'TEES', style_codes: [`W26XX${String(seq).padStart(3, '0')}BLK`], colourways: [],
    launch: o.launch || LAUNCHED,
    stock: o.stock === undefined ? { known: true, units: 300 } : o.stock,
    sales: o.sales === undefined ? { available: true, units30: 60, units365: 600 } : o.sales,
    coverage: o.coverage === undefined ? { known: true, active_ads: creatives.length, min: 5, possible: o.possible || 0, unattributed: o.unattributed || 0, uncertain: !!o.uncertain } : o.coverage,
    performance, creatives, creative_age_days: o.age === undefined ? 30 : o.age,
    season: o.season === undefined ? SEASON.none : o.season,
    planned: o.planned || { this_week: 0, in_pipeline: 0, in_production: 0, completed: 0, by_source: {} },
    overrides: o.overrides || [],
  };
}
// a realistic WNDRR-shaped range so demand percentiles exist: 12 launched in-stock products with spread of 30-day units
const FILLER = () => Array.from({ length: 12 }, (_, i) => fam({ name: `FILLER ${i}`, sales: { available: true, units30: 5 + i * 6, units365: (5 + i * 6) * 12 }, creatives: Array.from({ length: 6 }, () => cr('performing')), season: SEASON.none }));
const plan = (families, over = {}) => W.buildWeeklyVideoPlan({ families: [...FILLER(), ...families], settings: { ...SETTINGS, ...(over.settings || {}) }, config: over.config || CFG, today: TODAY, planned_other: over.planned_other || 0 });
const find = (p, name) => p.products.find((x) => x.name === name);

test('strong sales + healthy stock + in season + only 2 confirmed ads + ageing creative -> SHOOT NOW with several videos and plain reasons', () => {
  const p = plan([fam({ name: 'TECH TRACKSHORT', sales: { available: true, units30: 120, units365: 900 }, creatives: [cr('performing'), cr('insufficient')], season: SEASON.now, age: 70 })]);
  const t = find(p, 'TECH TRACKSHORT');
  assert.equal(t.category, 'SHOOT_NOW'); assert.ok(t.recommended_videos >= 3, `videos ${t.recommended_videos}`);
  assert.match(t.headline, /^Shoot \d+ videos this week/);
  const text = t.reasons.map((r) => r.text).join('\n');
  assert.match(text, /Strong current sales/); assert.match(text, /units available/); assert.match(text, /In season now/); assert.match(text, /Only 2 confirmed active ads/); assert.match(text, /newest running creative is 70 days old/);
});
test('MANY poor-performing ads can outrank a product with FEW strong ones (having 5+ ads does not mean enough creative)', () => {
  const many = fam({ name: 'MANY WEAK', creatives: [cr('performing'), cr('underperforming', 'clear'), cr('underperforming', 'clear'), cr('underperforming', 'clear'), cr('declining', 'relative'), cr('underperforming', 'marginal'), cr('insufficient'), cr('insufficient')], age: 60 });
  const few = fam({ name: 'FEW STRONG', creatives: [cr('performing'), cr('performing'), cr('performing'), cr('performing')], coverage: { known: true, active_ads: 4, min: 5 }, age: 20 });
  const p = plan([many, few]);
  const m = find(p, 'MANY WEAK'); const f = find(p, 'FEW STRONG');
  assert.ok(m.coverage.active_ads >= 5 && m.coverage.active_ads > f.coverage.active_ads, 'the weak product has MORE active ads');
  assert.ok(m.score > f.score, `weak-ads product ${m.score} outranks strong-ads product ${f.score}`);
  assert.equal(m.category, 'SHOOT_NOW'); assert.notEqual(f.category, 'SHOOT_NOW');
  assert.match(m.reasons.map((r) => r.text).join('\n'), /weak or fading/);
});
test('strong sales + healthy-performing ads (10 strong creatives): little or no new creative', () => {
  const p = plan([fam({ name: 'ALL STRONG', sales: { available: true, units30: 150, units365: 1200 }, creatives: Array.from({ length: 10 }, () => cr('performing')), age: 12 })]);
  const t = find(p, 'ALL STRONG');
  assert.ok(['MONITOR', 'NO_ACTION'].includes(t.category) || t.recommended_videos <= 1, `${t.category} ${t.recommended_videos}`);
});
test('high stock + low sales is NOT a shoot (weak sales, no lift)', () => {
  const t = find(plan([fam({ name: 'DEAD STOCK', stock: { known: true, units: 900 }, sales: { available: true, units30: 0, units365: 20 }, creatives: [cr('insufficient')] })]), 'DEAD STOCK');
  assert.ok(['MONITOR', 'NO_ACTION'].includes(t.category)); assert.equal(t.recommended_videos, 0);
});
test('low stock + strong sales: capped to Coming up; out of stock: Monitor; a confirmed restock on order lifts it', () => {
  const low = find(plan([fam({ name: 'LOW STOCK', stock: { known: true, units: 12 }, sales: { available: true, units30: 120, units365: 900 }, creatives: [cr('performing')] })]), 'LOW STOCK');
  assert.ok(RANKOK(low.category, 'COMING_UP')); assert.match(low.caps.join(' '), /Low stock/);
  const out = find(plan([fam({ name: 'OUT', stock: { known: true, units: 0 }, sales: { available: true, units30: 120, units365: 900 }, creatives: [cr('performing')] })]), 'OUT');
  assert.ok(RANKOK(out.category, 'MONITOR')); assert.equal(out.recommended_videos, 0);
  const restock = find(plan([fam({ name: 'RESTOCK', stock: { known: true, units: 0 }, launch: { status: 'upcoming_restock', eligible: true, needs_check: false, restock: true, on_order: 200 }, sales: { available: true, units30: 120, units365: 900 }, creatives: [cr('performing')], season: SEASON.now })]), 'RESTOCK');
  assert.ok(restock.category === 'COMING_UP' || restock.category === 'SHOOT_NOW', restock.category); assert.match(restock.reasons.map((r) => r.text).join(' '), /on order/);
});
function RANKOK(actual, max) { return W.RANK[actual] <= W.RANK[max]; }
test('out-of-season product with weak sales is not recommended', () => {
  const t = find(plan([fam({ name: 'OUT OF SEASON', season: SEASON.out, sales: { available: true, units30: 2, units365: 200 }, creatives: [cr('insufficient')] })]), 'OUT OF SEASON');
  assert.ok(RANKOK(t.category, 'MONITOR'));
});
test('SEASON LOOKAHEAD: 0-7 days strong boost, 8-14 days small boost, 15+ days no boost this week', () => {
  const mk = (name, season) => fam({ name, season, sales: { available: true, units30: 40, units365: 480 }, creatives: [cr('insufficient')], coverage: { known: true, active_ads: 3, min: 5 }, age: 50 });
  const p = plan([mk('IMM', SEASON.imm), mk('SEC', SEASON.sec), mk('LATER', SEASON.later), mk('NONE', SEASON.none)]);
  const pts = (n) => find(p, n).factors.worth.find((x) => x.key === 'season').points;
  assert.equal(pts('IMM'), 12); assert.equal(pts('SEC'), 5); assert.equal(pts('LATER'), 0); assert.equal(pts('NONE'), 0);
  assert.ok(find(p, 'IMM').score > find(p, 'SEC').score && find(p, 'SEC').score > find(p, 'LATER').score);
  assert.equal(find(p, 'LATER').score, find(p, 'NONE').score, 'a season 15+ days away earns exactly nothing this week');
  assert.match(find(p, 'LATER').reasons.map((r) => r.text).join(' ') + find(p, 'LATER').factors.worth.map((x) => x.text).join(' '), /more than 14 days away/);
});
test('seasonality never overrides strong current sales: out of season but selling strongly can still deserve creative', () => {
  const t = find(plan([fam({ name: 'OFF SEASON HERO', season: SEASON.out, sales: { available: true, units30: 130, units365: 700 }, creatives: [cr('underperforming', 'clear'), cr('underperforming', 'clear'), cr('insufficient')], coverage: { known: true, active_ads: 2, min: 5 }, age: 80 })]), 'OFF SEASON HERO');
  assert.equal(t.category, 'SHOOT_NOW');
});
test('approaching peak with no stock or no demand is NOT automatically a shoot', () => {
  const noStock = find(plan([fam({ name: 'PEAK NO STOCK', season: SEASON.imm, stock: { known: true, units: 0 }, sales: { available: true, units30: 80, units365: 700 }, creatives: [cr('insufficient')] })]), 'PEAK NO STOCK');
  assert.ok(RANKOK(noStock.category, 'MONITOR'));
  const noDemand = find(plan([fam({ name: 'PEAK NO DEMAND', season: SEASON.imm, sales: { available: true, units30: 0, units365: 10 }, creatives: [cr('insufficient')] })]), 'PEAK NO DEMAND');
  assert.ok(RANKOK(noDemand.category, 'MONITOR'));
});
test('missing sales data: never a shoot (capped at Coming up) and said plainly', () => {
  const t = find(plan([fam({ name: 'NO SALES', sales: null, creatives: [cr('underperforming', 'clear'), cr('underperforming', 'clear'), cr('underperforming', 'clear')], age: 100 })]), 'NO SALES');
  assert.ok(RANKOK(t.category, 'COMING_UP')); assert.ok(t.flags.includes('sales_unavailable')); assert.match(t.caps.join(' '), /Sales data is missing/);
});
test('missing Meta data entirely: Monitor with "not enough evidence", never "needs creative"', () => {
  const t = find(plan([fam({ name: 'NO META', coverage: { known: false, min: 5 }, noPerf: true, creatives: [], age: null })]), 'NO META');
  assert.ok(RANKOK(t.category, 'MONITOR')); assert.ok(t.flags.includes('coverage_unknown') && t.flags.includes('performance_unavailable'));
});
test('insufficient ad spend: ads that cannot be judged are NOT treated as underperforming (no performance points, evidence flagged)', () => {
  const t = find(plan([fam({ name: 'LOW SPEND', creatives: [cr('insufficient'), cr('insufficient'), cr('insufficient'), cr('insufficient'), cr('insufficient')], coverage: { known: true, active_ads: 5, min: 5 } })]), 'LOW SPEND');
  assert.equal(t.factors.need.find((x) => x.key === 'performance').points, 0); assert.ok(t.flags.includes('performance_unclear'));
  assert.notEqual(t.category, 'SHOOT_NOW');
});
test('unmatched / awaiting-review ads keep coverage UNCERTAIN: no creative-gap points, not a shortage', () => {
  const t = find(plan([fam({ name: 'PENDING ADS', creatives: [cr('performing'), cr('performing')], coverage: { known: true, active_ads: 2, min: 5, possible: 2, unattributed: 3, uncertain: true } })]), 'PENDING ADS');
  const c = t.factors.need.find((x) => x.key === 'coverage');
  assert.equal(c.points, 0); assert.match(c.text, /may be incomplete/); assert.ok(t.flags.includes('coverage_uncertain'));
});
test('multiple ads reusing one creative count as ONE creative (effective coverage), so 6 ads of 2 creatives is not "healthy coverage"', () => {
  // the loader groups ads by creative id; here the summary is built from the 2 unique creatives
  const s = P.summarizeProduct([cr('underperforming', 'clear'), cr('insufficient')], { activeAds: 6 });
  assert.equal(s.unique_creatives, 2); assert.equal(s.active_ads, 6);
  const t = find(plan([fam({ name: 'DUPLICATED', creatives: [cr('underperforming', 'clear'), cr('insufficient')], activeAds: 6, coverage: { known: true, active_ads: 6, min: 5 }, age: 90 })]), 'DUPLICATED');
  assert.ok(t.need_points > 0, 'enough ADS but few unique creatives still shows need');
});
test('already planned videos: recommended 5, planned 3 -> remaining 2; fully planned -> remaining 0 and it is not recommended again', () => {
  const base = { name: 'TECH TRACKSHORT 2', sales: { available: true, units30: 140, units365: 1000 }, creatives: [cr('performing'), cr('underperforming', 'clear')], coverage: { known: true, active_ads: 2, min: 5 }, season: SEASON.now, age: 100 };
  const a = find(plan([fam({ ...base })]), 'TECH TRACKSHORT 2');
  assert.ok(a.recommended_videos >= 4); const rec = a.recommended_videos;
  const b = find(plan([fam({ ...base, planned: { this_week: 3, in_pipeline: 0, in_production: 0, completed: 0, by_source: { core: 3 } } })]), 'TECH TRACKSHORT 2');
  assert.equal(b.recommended_videos, rec); assert.equal(b.remaining, rec - 3); assert.match(b.headline, /3 already planned/);
  const c = find(plan([fam({ ...base, planned: { this_week: rec, in_pipeline: 0, in_production: 0, completed: 0, by_source: {} } })]), 'TECH TRACKSHORT 2');
  assert.equal(c.remaining, 0); assert.match(c.headline, /all planned this week/);
});
test('videos still in production from earlier weeks reduce what is needed (no double shoot)', () => {
  const base = { name: 'IN FLIGHT', sales: { available: true, units30: 140, units365: 1000 }, creatives: [cr('performing')], coverage: { known: true, active_ads: 1, min: 5 }, season: SEASON.now, age: 100 };
  const a = find(plan([fam(base)]), 'IN FLIGHT'); const b = find(plan([fam({ ...base, planned: { this_week: 0, in_pipeline: 2, in_production: 2, completed: 0, by_source: {} } })]), 'IN FLIGHT');
  assert.equal(b.net_recommended, Math.max(0, a.recommended_videos - 2)); assert.match(b.reasons.map((r) => r.text).join(' '), /still in production/);
});
test('manual overrides: raise to Shoot now with a set number of videos; hold at Monitor; expired overrides ignored', () => {
  const up = find(plan([fam({ name: 'FORCED', sales: { available: true, units30: 3, units365: 100 }, creatives: [cr('performing'), cr('performing'), cr('performing'), cr('performing'), cr('performing')], overrides: [{ kind: 'manual_high', videos: 3, note: 'Founder pick' }] })]), 'FORCED');
  assert.equal(up.category, 'SHOOT_NOW'); assert.equal(up.recommended_videos, 3); assert.equal(up.manual_videos, true);
  const hold = find(plan([fam({ name: 'HELD', sales: { available: true, units30: 140, units365: 1000 }, creatives: [cr('underperforming', 'clear'), cr('underperforming', 'clear')], coverage: { known: true, active_ads: 2, min: 5 }, season: SEASON.now, age: 100, overrides: [{ kind: 'manual_low', note: 'hold' }] })]), 'HELD');
  assert.equal(hold.category, 'MONITOR'); assert.equal(hold.recommended_videos, 0);
  const expired = find(plan([fam({ name: 'EXPIRED', sales: { available: true, units30: 140, units365: 1000 }, creatives: [cr('underperforming', 'clear'), cr('underperforming', 'clear')], coverage: { known: true, active_ads: 2, min: 5 }, season: SEASON.now, age: 100, overrides: [{ kind: 'manual_low', until: '2026-10-01' }] })]), 'EXPIRED');
  assert.equal(expired.category, 'SHOOT_NOW');
});
test('unlaunched / discontinued products are EXCLUDED (not scored); unknown launch status is flagged and cannot be Shoot now', () => {
  const p = plan([fam({ name: 'NOT LAUNCHED', launch: { status: 'unlaunched', eligible: false, detail: 'ApparelMagic launch date 2026-11-01 is still ahead.' } }), fam({ name: 'DISCONTINUED', launch: { status: 'discontinued', eligible: false } }), fam({ name: 'UNKNOWN LAUNCH', launch: { status: 'unknown', eligible: false, needs_check: true, detail: 'No launch date' }, sales: { available: true, units30: 140, units365: 1000 }, creatives: [cr('underperforming', 'clear')], age: 120 })]);
  assert.ok(!find(p, 'NOT LAUNCHED') && !find(p, 'DISCONTINUED'));
  assert.deepEqual(p.excluded.map((x) => x.name).sort(), ['DISCONTINUED', 'NOT LAUNCHED']);
  assert.ok(!find(p, 'UNKNOWN LAUNCH'), 'Batch 13: an unverified product is NOT in any category (not even Monitor)');
  assert.equal(p.verification.length, 1); assert.equal(p.verification[0].name, 'UNKNOWN LAUNCH'); assert.ok(p.needs_launch_check.length === 1);
});
test('an Upcoming Drop product is excluded and labelled as handled in Upcoming Drops (no duplicate requirement)', () => {
  const p = plan([fam({ name: 'DROP PRODUCT', launch: { status: 'unlaunched', eligible: false, in_upcoming_drop: true, detail: 'Part of the upcoming drop "Drop 24"; its creative is handled in Upcoming Drops.' } })]);
  assert.equal(p.excluded.length, 1); assert.equal(p.excluded[0].in_upcoming_drop, true);
});
test('NOT PADDED: only the genuinely worthwhile videos are recommended, and the plan says why the target is not filled', () => {
  const p = plan([fam({ name: 'ONE GOOD', sales: { available: true, units30: 140, units365: 1000 }, creatives: [cr('underperforming', 'clear'), cr('underperforming', 'clear')], coverage: { known: true, active_ads: 2, min: 5 }, season: SEASON.now, age: 100 })]);
  assert.ok(p.summary.recommended_total < p.target); assert.match(p.summary.explanation, /deliberately not filled with weak recommendations/);
  assert.ok(p.products.filter((x) => x.recommended_videos > 0).every((x) => x.category === 'SHOOT_NOW'), 'only Shoot now carries videos');
});
test('over capacity: the highest-ranked work is allocated to the target and the rest is deferred, explained', () => {
  const heavy = Array.from({ length: 10 }, (_, i) => fam({ name: `HEAVY ${i}`, sales: { available: true, units30: 150 + i, units365: 1200 }, creatives: [cr('underperforming', 'clear'), cr('underperforming', 'clear'), cr('insufficient')], coverage: { known: true, active_ads: 1, min: 5 }, season: SEASON.now, age: 100 }));
  const p = plan(heavy);
  assert.ok(p.summary.recommended_total > p.target); assert.ok(p.summary.deferred > 0); assert.match(p.summary.explanation, /fit in the remaining capacity/);
  assert.ok(p.summary.to_plan_from_recommendations <= p.summary.remaining_capacity);
  const top = p.products.filter((x) => x.category === 'SHOOT_NOW');
  assert.ok(top[0].allocated >= top[top.length - 1].allocated, 'higher-ranked products are allocated first');
});
test('weekly totals: planned counts include other sources and reduce remaining capacity', () => {
  const p = plan([fam({ name: 'X', sales: { available: true, units30: 140, units365: 1000 }, creatives: [cr('underperforming', 'clear')], coverage: { known: true, active_ads: 1, min: 5 }, season: SEASON.now, age: 100, planned: { this_week: 2, in_pipeline: 0, in_production: 0, completed: 0, by_source: { core: 2 } } })], { planned_other: 16 });
  assert.equal(p.summary.planned_total, 18); assert.equal(p.summary.remaining_capacity, 7);
});
test('the target and the sizing matrix are configurable', () => {
  const small = plan([], { settings: { weekly_video_target: 20 } }); assert.equal(small.target, 20);
  const c = cfgLib.resolve({ videos_high_need_strong: 2, max_videos_per_product: 2 }).config;
  const p = plan([fam({ name: 'CAPPED', sales: { available: true, units30: 150, units365: 1200 }, creatives: [cr('underperforming', 'clear'), cr('underperforming', 'clear'), cr('underperforming', 'clear')], coverage: { known: true, active_ads: 1, min: 5 }, season: SEASON.now, age: 100 })], { config: c });
  assert.ok(find(p, 'CAPPED').recommended_videos <= 2);
});
test('ONE headline per product: a single category, never a contradictory pair', () => {
  const p = plan([fam({ name: 'A' }), fam({ name: 'B', sales: { available: true, units30: 140, units365: 1000 }, creatives: [cr('underperforming', 'clear')], coverage: { known: true, active_ads: 1, min: 5 }, season: SEASON.now })]);
  p.products.forEach((x) => { assert.ok(W.CATEGORIES.includes(x.category)); assert.equal(typeof x.headline, 'string'); assert.equal(x.priority, undefined, 'no second priority label'); });
});
test('every recommendation carries its points and reasons (no black box)', () => {
  const t = plan([fam({ name: 'EXPLAINED', sales: { available: true, units30: 140, units365: 1000 }, creatives: [cr('underperforming', 'clear')], coverage: { known: true, active_ads: 1, min: 5 }, season: SEASON.now })]).products.find((x) => x.name === 'EXPLAINED');
  assert.ok(t.factors.need.length >= 3 && t.factors.worth.length === 3); assert.equal(t.score, t.need_points + t.worth_points);
  assert.ok(t.reasons.length >= 4);
});

// ── creative mix ──
const M = require('../src/lib/creativeMix');
const VOCAB = { concepts: ['TRY ON', 'FLAT LAY', 'TALK THROUGH', 'UGC', 'STYLING', 'FIT CHECK'], creators: ['Mark', 'Shez'] };
test('creative mix: slots come from the approved vocabulary, each labelled evidence / gap / exploratory; no invented results', () => {
  const ev = M.poolConceptEvidence([...Array.from({ length: 4 }, () => ({ concept: 'STYLING', state: 'performing', spend: 300 })), { concept: 'STYLING', state: 'insufficient' }, ...Array.from({ length: 4 }, () => ({ concept: 'UGC', state: 'underperforming', spend: 300 })), { concept: 'FIT CHECK', state: 'insufficient' }]);
  const mix = M.suggestMix({ videos: 4, creatives: [{ concept: 'TRY ON', state: 'performing', creator: 'Mark' }, { concept: 'FLAT LAY', state: 'underperforming', creator: 'Mark' }], vocab: VOCAB, conceptEvidence: ev });
  assert.equal(mix.slots.length, 4);
  assert.equal(mix.slots[0].kind, 'new_hook'); assert.equal(mix.slots[0].concept, 'TRY ON'); assert.equal(mix.slots[0].basis, 'evidence');
  const styling = mix.slots.find((s) => s.concept === 'STYLING'); assert.ok(styling && styling.basis === 'evidence' && /4 of 4 judged creatives/.test(styling.reason));
  assert.ok(!mix.slots.some((s) => s.concept === 'UGC'), 'a concept that has mostly failed is not suggested');
  assert.ok(mix.slots.every((s) => ['evidence', 'gap', 'exploratory'].includes(s.basis)));
  assert.ok(!mix.slots.some((s) => s.concept === 'TRY ON' && s.kind === 'new_concept'), 'no duplicate of a concept the product already runs');
  assert.match(mix.note, /evidence-based/);
});
test('creative mix: with no evidence anywhere every slot is honestly exploratory / a gap; zero videos -> no slots; a single-creator product gets a creator hint', () => {
  const mix = M.suggestMix({ videos: 3, creatives: [{ concept: 'TRY ON', state: 'insufficient', creator: 'Mark' }, { concept: 'TRY ON', state: 'insufficient', creator: 'Mark' }, { concept: 'TRY ON', state: 'insufficient', creator: 'Mark' }], vocab: VOCAB, conceptEvidence: new Map() });
  assert.ok(mix.slots.every((s) => s.basis !== 'evidence')); assert.ok(mix.slots.some((s) => s.creator_hint));
  assert.deepEqual(M.suggestMix({ videos: 0, vocab: VOCAB }).slots, []);
  assert.equal(M.suggestMix({ videos: 2, vocab: { concepts: [], creators: [] } }).slots.length, 2);
});


// ── Batch 13: refined quantities and the explanation ────────────────────────────────────
const crs = (n, state, severity) => Array.from({ length: n }, () => cr(state, severity));
test('HIGH DEMAND + MANY UNIQUE CREATIVES that are not fatigued: capped (a product with 29 creatives does not get 5 more just because it sells)', () => {
  const many = fam({ name: 'RAIDER', units: 499, sales: { available: true, units30: 117, units365: 900 }, creatives: [...crs(8, 'performing'), ...crs(9, 'underperforming', 'clear'), ...crs(8, 'insufficient'), ...crs(4, 'insufficient')], activeAds: 40, age: 20 });
  const p = plan([many]); const t = find(p, 'RAIDER');
  assert.equal(t.performance.unique_creatives, 29); assert.equal(t.saturated, true); assert.equal(t.fatigued, false);
  assert.ok(t.recommended_videos <= CFG.videos_when_saturated, `capped at ${CFG.videos_when_saturated}, got ${t.recommended_videos}`);
  assert.ok(t.quantity_steps.some((s) => s.key === 'saturated'));
  assert.match(t.explain.quantity.text, /29 unique creatives are already running and they are not fatigued/);
});
test('HIGH DEMAND + FATIGUED creative: fresh creative IS justified (the saturation cap does not apply)', () => {
  const tired = fam({ name: 'TIRED', sales: { available: true, units30: 130, units365: 900 }, creatives: [...crs(6, 'declining', 'relative'), ...crs(8, 'underperforming', 'clear'), ...crs(2, 'performing')], activeAds: 16, age: 100 });
  const t = find(plan([tired]), 'TIRED');
  assert.equal(t.saturated, true); assert.equal(t.fatigued, true); assert.ok(t.recommended_videos > CFG.videos_when_saturated, `got ${t.recommended_videos}`);
});
test('HIGH DEMAND + POOR creative -> high priority with several videos; HIGH DEMAND + STRONG creative -> few or none', () => {
  const poor = fam({ name: 'POOR', sales: { available: true, units30: 130, units365: 900 }, creatives: [cr('underperforming', 'clear'), cr('underperforming', 'clear'), cr('insufficient')], coverage: { known: true, active_ads: 3, min: 5 }, age: 80 });
  const strong = fam({ name: 'STRONG', sales: { available: true, units30: 130, units365: 900 }, creatives: crs(6, 'performing'), age: 14 });
  const p = plan([poor, strong]);
  assert.equal(find(p, 'POOR').category, 'SHOOT_NOW'); assert.ok(find(p, 'POOR').recommended_videos >= 3);
  assert.ok(find(p, 'STRONG').recommended_videos <= 1);
});
test('HIGH DEMAND but INSUFFICIENT Meta data: not read as a shortage; the explanation says the picture is unclear', () => {
  const unclear = fam({ name: 'UNCLEAR', sales: { available: true, units30: 130, units365: 900 }, creatives: [cr('insufficient'), cr('insufficient')], activeAds: 2, pending: 4, uncertain: true });
  const t = find(plan([unclear]), 'UNCLEAR');
  assert.match(t.explain.creative.text, /without enough data to judge/); assert.match(t.explain.creative.text, /awaiting match review/);
});
test('LOW DEMAND + HIGH STOCK (slow mover): stock is not a reason to invest, at most one video, never Shoot now without a seasonal lift, and the explanation says how many weeks of cover', () => {
  const slow = fam({ name: 'SLOW', units: 291, sales: { available: true, units30: 8, units365: 200 }, creatives: [cr('underperforming', 'clear'), cr('insufficient')], coverage: { known: true, active_ads: 2, min: 5 }, age: 90 });
  const t = find(plan([slow]), 'SLOW');
  assert.equal(t.slow_mover, true); assert.notEqual(t.category, 'SHOOT_NOW'); assert.ok(t.recommended_videos <= CFG.videos_slow_mover);
  assert.match(t.explain.data.find((x) => x.label === 'Stock').text, /weeks of cover/);
  assert.equal(t.factors.worth.find((x) => x.key === 'stock').points, 0);
});
test('OUT-OF-SEASON high-stock product that already meets the active-ad minimum is not an immediate shoot', () => {
  const oos = fam({ name: 'REFRAIN', units: 456, sales: { available: true, units30: 40, units365: 900 }, creatives: crs(7, 'performing'), activeAds: 7, season: { status: 'out_of_season', label: 'Out of season', outlook: { boost: 'none', text: 'Out of season.' } }, age: 30 });
  const t = find(plan([oos]), 'REFRAIN');
  assert.notEqual(t.category, 'SHOOT_NOW'); assert.equal(t.coverage.active_ads, 7);
});
test('a product ALREADY SCHEDULED for production: planned / in-pipeline videos reduce what remains, and the explanation says so', () => {
  const sched = fam({ name: 'SCHEDULED', sales: { available: true, units30: 130, units365: 900 }, creatives: [cr('underperforming', 'clear'), cr('underperforming', 'clear')], coverage: { known: true, active_ads: 2, min: 5 }, age: 90, planned: { this_week: 2, in_pipeline: 1, in_production: 1, completed: 0, by_source: {} } });
  const t = find(plan([sched]), 'SCHEDULED');
  assert.equal(t.net_recommended, t.recommended_videos - 1); assert.equal(t.remaining, Math.max(0, t.net_recommended - 2));
  assert.match(t.explain.planned.text, /2 videos already planned this week/); assert.match(t.explain.quantity.text, /1 video from earlier weeks still in production is subtracted/);
});
test('the explanation names the data behind the decision, counts performing / weak / untested creatives, and never claims a cause for poor performance', () => {
  const t = find(plan([fam({ name: 'EXPLAINED', sales: { available: true, units30: 120, units365: 900 }, creatives: [cr('performing'), cr('underperforming', 'clear'), cr('underperforming', 'clear'), cr('insufficient')], coverage: { known: true, active_ads: 4, min: 5 }, age: 70 })]), 'EXPLAINED');
  const e = t.explain;
  assert.match(e.priority, /^Prioritised because of/); assert.deepEqual(e.data.map((x) => x.label), ['Sales', 'Stock', 'Season', 'Launch']);
  assert.equal(e.creative.counts.performing, 1); assert.equal(e.creative.counts.weak, 2); assert.equal(e.creative.counts.insufficient, 1); assert.equal(e.creative.counts.unique, 4);
  assert.match(e.quantity.text, /Sizing table/); assert.ok(e.cautions.some((c) => /not proof that creative is the cause/.test(c)));
  assert.doesNotMatch(JSON.stringify(e), /because the creative is bad|caused by|due to poor creative/i);
});
test('DUPLICATE product across planning sources: one family, one recommendation (colourways are not separate recommendations)', () => {
  const two = fam({ name: 'TWO COLOURS', colourways: [{ style_code: 'W26TC001BLK', colour_label: 'Black', soh: 150 }, { style_code: 'W26TC001WHT', colour_label: 'White', soh: 150 }], units: 300, creatives: [cr('underperforming', 'clear')] });
  const p = plan([two]);
  assert.equal(p.products.filter((x) => x.name === 'TWO COLOURS').length, 1);
});
test('the ~47-video / 25-target case: recommendations above the target are allocated by rank and the surplus is deferred, never padded and never silently dropped', () => {
  const many = Array.from({ length: 12 }, (_, i) => fam({ name: `HOT ${i}`, sales: { available: true, units30: 150 + i, units365: 1200 }, creatives: [cr('underperforming', 'clear'), cr('underperforming', 'clear')], coverage: { known: true, active_ads: 2, min: 5 }, age: 90 }));
  const p = plan(many);
  assert.ok(p.summary.recommended_total > p.target, `${p.summary.recommended_total} > ${p.target}`);
  assert.equal(p.summary.to_plan_from_recommendations, p.target); assert.ok(p.summary.deferred > 0); assert.match(p.summary.explanation, /deferred/);
});
