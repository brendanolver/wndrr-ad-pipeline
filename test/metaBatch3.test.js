// Pure (no database, no Meta) tests for batch 3: funnel health stays inactive, unique-creative activity, the Pre-2026 archive
// rule + proof of coverage, ApparelMagic front/back pictures, preview fetch economy, and static guards.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused'; // pool is lazy; never connected here
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const health = require('../src/lib/metaFunnelHealth');
const archive = require('../src/lib/metaCreativeArchive');
const activity = require('../src/lib/metaCreativeActivity');
const plan = require('../src/lib/coreCreativePlan');
const am = require('../src/lib/apparelmagic');
const creative = require('../src/lib/metaAdCreative');
const pullLib = require('../src/lib/metaActivityPull');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const code = (f) => read(f).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ── funnel health: ONLY the WNDRR-confirmed rules, on ONLY the metrics WNDRR colour-codes ─────────────────
//   TOF: Frequency, Reach   TOM: CPA, Reach   MOF: CPA, Reach        (everything else is always neutral)
const D4 = { days: 4 }; // a 4-calendar-day range
const c = (f, m, v, ctx = D4) => health.classify(f, m, v, ctx);
const METRIC_LIST = ['cpa', 'frequency', 'reach'];
test('health: the colour-coded metrics per funnel are exactly TOF Frequency+Reach, TOM CPA+Reach, MOF CPA+Reach', () => {
  assert.deepEqual(health.COLOUR_CODED, { TOF: ['frequency', 'reach'], TOM: ['cpa', 'reach'], MOF: ['cpa', 'reach'] });
  const st = health.status();
  assert.deepEqual(st.colour_coded, { TOF: ['frequency', 'reach'], TOM: ['cpa', 'reach'], MOF: ['cpa', 'reach'] });
  assert.deepEqual(st.pending_benchmarks.sort(), ['MOF reach', 'TOF reach', 'TOM cpa', 'TOM reach']);
});
test('health: TOF CPA is NOT colour-coded any more -- no red (or any colour) at any value or range', () => {
  for (const v of [10, 150, 200, 200.01, 250, 350, 5000]) for (const days of [1, 4, 7, 30]) assert.equal(c('TOF', 'cpa', v, { days }), null, `TOF CPA ${v} / ${days}d`);
  assert.equal(health.RULES.TOF.cpa, undefined, 'no TOF CPA rule exists');
  assert.equal(health.status().defined.TOF.cpa, undefined);
});
test('health: TOF Frequency under 2 is green in a ~4-day period; 2 and above stays neutral (no red/orange invented)', () => {
  assert.equal(c('TOF', 'frequency', 1.99), 'green');
  assert.equal(c('TOF', 'frequency', 1.2), 'green');
  assert.equal(c('TOF', 'frequency', 2), null);
  assert.equal(c('TOF', 'frequency', 2.4), null);
  assert.equal(c('TOF', 'frequency', 5), null);
  assert.deepEqual(health.RULES.TOF.frequency, { period: 'approx_4_days', green: { lt: 2 } });
});
test('health: TOF Reach is colour-coded but has NO benchmark yet -- neutral at every value', () => {
  assert.ok(health.COLOUR_CODED.TOF.includes('reach'));
  assert.equal(health.RULES.TOF.reach, null);
  for (const v of [0, 1000, 50000, 1e7]) for (const days of [1, 4, 30]) assert.equal(c('TOF', 'reach', v, { days }), null);
  assert.equal(health.status().defined.TOF.reach, null);
});
test('health: TOM CPA is colour-coded but has NO benchmark yet (never inferred from TOF or MOF) -- neutral at every value', () => {
  assert.ok(health.COLOUR_CODED.TOM.includes('cpa'));
  assert.equal(health.RULES.TOM.cpa, null);
  for (const v of [5, 40, 50, 60, 150, 250, 500]) assert.equal(c('TOM', 'cpa', v), null, `TOM CPA ${v}`);
  assert.equal(health.status().defined.TOM.cpa, null);
});
test('health: TOM Frequency is NOT colour-coded any more -- no colour at any value or range', () => {
  for (const v of [1.5, 2, 2.5, 3, 3.01, 6]) for (const days of [1, 3, 4, 5, 7, 30]) assert.equal(c('TOM', 'frequency', v, { days }), null, `TOM Frequency ${v} / ${days}d`);
  assert.equal(health.RULES.TOM.frequency, undefined);
  assert.equal(health.status().defined.TOM.frequency, undefined);
});
test('health: TOM Reach is colour-coded but has NO benchmark yet -- neutral at every value', () => {
  assert.ok(health.COLOUR_CODED.TOM.includes('reach'));
  assert.equal(health.RULES.TOM.reach, null);
  for (const v of [0, 1000, 50000, 1e7]) assert.equal(c('TOM', 'reach', v), null);
});
test('health: MOF CPA $40 to $60 inclusive is green on ANY range; below $40 and above $60 stay neutral', () => {
  assert.equal(c('MOF', 'cpa', 40), 'green');
  assert.equal(c('MOF', 'cpa', 50), 'green');
  assert.equal(c('MOF', 'cpa', 60), 'green');
  assert.equal(c('MOF', 'cpa', 39.99), null);
  assert.equal(c('MOF', 'cpa', 30), null, 'a $30 CPA is not bad merely because it is outside the range');
  assert.equal(c('MOF', 'cpa', 60.01), null);
  assert.equal(c('MOF', 'cpa', 120), null);
  assert.deepEqual(health.RULES.MOF.cpa, { period: null, green: { min: 40, max: 60 } });
  for (const days of [1, 4, 7, 30]) assert.equal(c('MOF', 'cpa', 50, { days }), 'green', `${days} days`);
});
test('health: MOF Reach is colour-coded but has NO benchmark yet; MOF Frequency stays neutral (not colour-coded)', () => {
  assert.ok(health.COLOUR_CODED.MOF.includes('reach'));
  assert.equal(health.RULES.MOF.reach, null);
  for (const v of [0, 1000, 50000]) assert.equal(c('MOF', 'reach', v), null);
  assert.ok(!health.COLOUR_CODED.MOF.includes('frequency'));
  assert.equal(health.RULES.MOF.frequency, undefined);
  for (const v of [0.5, 1, 2, 3, 8]) assert.equal(c('MOF', 'frequency', v), null);
});
test('health: the ONLY colours that can ever appear are TOF Frequency (green) and MOF CPA (green)', () => {
  const got = [];
  for (const f of ['TOF', 'TOM', 'MOF']) for (const m of METRIC_LIST) for (const days of [1, 3, 4, 5, 7, 30]) for (const v of [0, 0.5, 1, 1.5, 1.99, 2, 2.5, 3, 4, 10, 30, 39.99, 40, 50, 60, 60.01, 100, 150, 200, 201, 500, 12000, 1e6]) {
    const r = c(f, m, v, { days }); if (r) got.push(`${f} ${m} ${r}`);
  }
  assert.deepEqual([...new Set(got)].sort(), ['MOF cpa green', 'TOF frequency green']);
});
test('health: Unknown / Mixed / missing funnel gets nothing, whatever the number', () => {
  for (const f of ['unknown', 'multiple', null, undefined, 'BOF', '028']) {
    for (const m of METRIC_LIST) for (const v of [1, 50, 250]) assert.equal(c(f, m, v), null, `${f}/${m}/${v}`);
  }
});
test('health: no value / no purchases -> neutral (never judged)', () => {
  for (const v of [null, undefined, '', NaN]) { assert.equal(c('TOF', 'frequency', v), null); assert.equal(c('MOF', 'cpa', v), null); assert.equal(c('TOM', 'cpa', v), null); assert.equal(c('TOF', 'reach', v), null); }
});
test('health: there are NO orange ranges anywhere in the shipped rules', () => {
  for (const f of health.JUDGED_FUNNELS) for (const m of health.METRICS) {
    const r = health.RULES[f][m];
    if (r) assert.equal(r.orange, undefined, `${f}/${m}`);
  }
  for (const f of ['TOF', 'TOM', 'MOF']) for (const m of METRIC_LIST) for (const v of [0.5, 1, 1.5, 2, 2.5, 3, 4, 10, 30, 40, 50, 60, 100, 150, 200, 201, 500]) {
    assert.notEqual(c(f, m, v), 'orange');
  }
});
test('health: Frequency is judged ONLY for a ~4-day period (3-5 calendar days); other lengths are neutral', () => {
  assert.deepEqual(health.APPROX_4_DAYS, { target_days: 4, min_days: 3, max_days: 5 });
  for (const days of [3, 4, 5]) assert.equal(c('TOF', 'frequency', 1.5, { days }), 'green', `${days}d TOF`);
  for (const days of [1, 2, 6, 7, 8, 14, 30, 90, null, undefined]) assert.equal(c('TOF', 'frequency', 1.5, { days }), null, `${days}d TOF`);
  assert.equal(health.classify('TOF', 'frequency', 1.5), null, 'no period given -> not judged');
});
test('health: Frequency benchmarks are NOT scaled or extrapolated to other lengths', () => {
  // if "TOF < 2 over 4 days" were scaled to 8 days, 3.9 would be green; it must stay neutral
  assert.equal(c('TOF', 'frequency', 3.9, { days: 8 }), null);
  assert.equal(c('TOF', 'frequency', 1.0, { days: 8 }), null);
  assert.equal(c('TOF', 'frequency', 0.9, { days: 2 }), null);
  const src = code('src/lib/metaFunnelHealth.js');
  assert.doesNotMatch(src, /days\s*\/\s*4|\*\s*\(?days|target_days\s*\*|scale/i, 'no scaling arithmetic on the period');
});
test('health: the period is counted from the real dates (an actual 4-day custom range qualifies, a preset name does not matter)', () => {
  assert.equal(health.rangeDays({ since: '2026-10-01', until: '2026-10-04' }), 4);
  assert.equal(health.rangeDays({ since: '2026-10-01', until: '2026-10-01' }), 1);
  assert.equal(health.rangeDays({ since: '2026-09-01', until: '2026-09-30' }), 30);
  assert.equal(health.isApprox4Days(health.rangeDays({ since: '2026-10-01', until: '2026-10-04' })), true);
  assert.equal(health.isApprox4Days(health.rangeDays({ since: '2026-10-01', until: '2026-10-07' })), false, 'Last 7 days is not ~4 days');
  assert.equal(health.status({ range: { since: '2026-10-01', until: '2026-10-04' } }).period.frequency_judged, true);
  assert.equal(health.status({ range: { since: '2026-10-01', until: '2026-10-30' } }).period.frequency_judged, false);
});
test('health: only confirmed rules are described, and the system is active', () => {
  const st = health.status();
  assert.equal(st.active, true);
  assert.match(st.defined.TOF.frequency, /green under 2 \(about 4 days\)/);
  assert.equal(st.defined.TOF.reach, null);
  assert.equal(st.defined.TOM.cpa, null);
  assert.equal(st.defined.TOM.reach, null);
  assert.match(st.defined.MOF.cpa, /green 40–60/);
  assert.equal(st.defined.MOF.reach, null);
  assert.deepEqual(Object.keys(st.defined.TOF).sort(), ['frequency', 'reach']);
  assert.deepEqual(Object.keys(st.defined.TOM).sort(), ['cpa', 'reach']);
  assert.deepEqual(Object.keys(st.defined.MOF).sort(), ['cpa', 'reach']);
});
test('health: a missing benchmark can be added through RULES alone (the metric is already colour-coded); bad rules are ignored', () => {
  const rules = { TOF: { reach: { period: null, green: { gte: 10000 } }, frequency: health.RULES.TOF.frequency }, TOM: { cpa: { period: null, red: { gt: 100 }, orange: { gt: 80, lte: 100 } } }, MOF: { cpa: { period: null, green: { min: 60, max: 40 } } } };
  assert.equal(health.classify('TOF', 'reach', 12000, D4, { rules }), 'green', 'TOF Reach benchmark added in RULES only');
  assert.equal(health.classify('TOF', 'reach', 9000, D4, { rules }), null);
  assert.equal(health.classify('TOM', 'cpa', 90, D4, { rules }), 'orange', 'TOM CPA benchmark added in RULES only');
  assert.equal(health.classify('TOM', 'cpa', 120, D4, { rules }), 'red');
  assert.equal(health.classify('MOF', 'cpa', 50, D4, { rules }), null, 'a malformed rule is ignored, not guessed');
  assert.equal(health.classify('TOF', 'reach', 12000, D4, { rules, enabled: false }), null);
  // a rule for a metric that is NOT colour-coded is ignored until the metric is added to COLOUR_CODED
  const stray = { TOF: { cpa: { period: null, red: { gt: 200 } } } };
  assert.equal(health.classify('TOF', 'cpa', 300, D4, { rules: stray }), null);
  assert.equal(health.classify('TOF', 'cpa', 300, D4, { rules: stray, coded: { TOF: ['cpa'] } }), 'red');
  // the pending-benchmark list follows the rules
  assert.deepEqual(health.status({ rules }).pending_benchmarks.sort(), ['MOF reach', 'TOM reach']);
});

// ── unique creative activity ──────────────────────────────────────────
const TODAY = '2026-10-07';
const adRow = (id, creativeKey, o = {}) => ({ ad: { id, creative_key: creativeKey, created: o.created || '2026-08-01', effective_status: o.status || 'ACTIVE', w: { m: { spend: o.spend ?? 10 } }, ...o.extra } });
const act = (o) => ({ ads_total: 5, ads_active_status: 5, ads_delivering: 5, ads_new_active: 0, first_created: '2026-06-01', last_delivery: '2026-10-05', ...o });

test('activity: the same creative duplicated into 5 ads counts as ONE active creative; ads may exceed creatives', () => {
  const ps = { code: 'P', entries: ['a1', 'a2', 'a3', 'a4', 'a5'].map((i) => adRow(i, 'CR1')) };
  const facts = plan.creativeFacts(ps, TODAY, null, { byCreative: new Map([['CR1', act({})]]), insights_last_day: '2026-10-06' });
  assert.equal(facts.active_unique_creatives, 1);
  assert.equal(facts.running_creatives, 1);
  assert.equal(facts.active_ads, 5);
  assert.ok(facts.active_ads > facts.active_unique_creatives);
  assert.equal(facts.creatives_total, 1);
});
test('activity: one creative running in several funnels/campaigns is still ONE creative (funnel plays no part)', () => {
  const ps = { code: 'P', entries: [adRow('a1', 'CR1', { extra: { campaign: 'TOF' } }), adRow('a2', 'CR1', { extra: { campaign: 'MOF' } }), adRow('a3', 'CR2')] };
  const facts = plan.creativeFacts(ps, TODAY, null, { byCreative: new Map([['CR1', act({ ads_total: 2, ads_delivering: 2 })], ['CR2', act({ ads_total: 1, ads_delivering: 1 })]]), insights_last_day: '2026-10-06' });
  assert.equal(facts.active_unique_creatives, 2);
  assert.equal(facts.active_ads, 3);
});
test('activity: a creative counts as active through an UNCLASSIFIED duplicate (exact creative id, any ad)', () => {
  // the only included ad is paused with no spend; an unclassified copy of the same creative is delivering
  const ps = { code: 'P', entries: [adRow('a1', 'CR1', { status: 'PAUSED', spend: 0 })] };
  const facts = plan.creativeFacts(ps, TODAY, null, { byCreative: new Map([['CR1', act({ ads_total: 2, ads_active_status: 1, ads_delivering: 1 })]]), insights_last_day: '2026-10-06' });
  assert.equal(facts.active_unique_creatives, 1);
  assert.equal(facts.active_ads, 1);
});
test('activity: a creative with no delivery in the window is historical, not active', () => {
  const ps = { code: 'P', entries: [adRow('a1', 'CR1'), adRow('a2', 'CR2')] };
  const facts = plan.creativeFacts(ps, TODAY, null, { byCreative: new Map([['CR1', act({ ads_delivering: 0, ads_active_status: 1, ads_new_active: 0, last_delivery: '2026-05-01' })], ['CR2', act({})]]), insights_last_day: '2026-10-06' });
  assert.equal(facts.active_unique_creatives, 1);
  assert.equal(facts.historical_unique_creatives, 1);
});
test('activity: stale stored Insights fall back to status and SAY so (status_only)', () => {
  const v = activity.verdict(act({ ads_active_status: 2, ads_delivering: 0 }), { today: TODAY, insights_last_day: '2026-09-01' });
  assert.deepEqual([v.active, v.basis], [true, 'status_only']);
  const fresh = activity.verdict(act({ ads_active_status: 2, ads_delivering: 0, ads_new_active: 0 }), { today: TODAY, insights_last_day: '2026-10-06' });
  assert.equal(fresh.active, false);
  const brandNew = activity.verdict(act({ ads_delivering: 0, ads_new_active: 1 }), { today: TODAY, insights_last_day: '2026-10-06' });
  assert.deepEqual([brandNew.active, brandNew.basis], [true, 'new_active_ad']);
});
test('last new creative: unique-creative level, earliest creation across EVERY ad of the exact creative', () => {
  // the included copy was created in August but the original (not included / other family) was created in March
  const ps = { code: 'P', entries: [adRow('copy', 'CR1', { created: '2026-08-20' }), adRow('other', 'CR2', { created: '2026-05-10' })] };
  const facts = plan.creativeFacts(ps, TODAY, null, { byCreative: new Map([['CR1', act({ first_created: '2026-03-02' })], ['CR2', act({ first_created: '2026-05-10' })]]), insights_last_day: '2026-10-06' });
  assert.equal(facts.last_new_creative.date, '2026-05-10', 'the duplicate does not make the creative look new');
  assert.match(facts.last_new_creative.source, /Earliest Meta ad created/);
});
test('last new creative: an old creative keeps the older-history warning', () => {
  const ps = { code: 'P', entries: [adRow('a', 'CR1', { created: '2025-01-01' })] };
  const facts = plan.creativeFacts(ps, TODAY, null, { byCreative: new Map([['CR1', act({ first_created: '2025-01-01', ads_delivering: 0, ads_active_status: 0 })]]), insights_last_day: '2026-10-06' });
  assert.equal(facts.recency_basis, 'older_than_window');
});
test('activity: an ad with no creative id can only count as itself and is reported as unidentified', () => {
  const ps = { code: 'P', entries: [adRow('lonely', 'lonely')] };
  const facts = plan.creativeFacts(ps, TODAY, null, { byCreative: new Map(), insights_last_day: '2026-10-06' });
  assert.equal(facts.unidentified_creatives, 1);
});
test('activity: the same creative in several AD SETS still counts once', () => {
  const ps = { code: 'P', entries: ['a1', 'a2', 'a3'].map((i, n) => adRow(i, 'CR1', { extra: { adset: `set${n}` } })) };
  const facts = plan.creativeFacts(ps, TODAY, null, { byCreative: new Map([['CR1', act({ ads_total: 3, ads_delivering: 3 })]]), insights_last_day: '2026-10-06' });
  assert.equal(facts.active_unique_creatives, 1);
  assert.equal(facts.active_ads, 3);
});
test('planning: the creative-volume recommendation follows UNIQUE creatives -- 9 active ads of 1 creative still asks for more', () => {
  const family = { key: 'P', product_code: 'P', name: 'Test Tee', category: 'TEES', image_url: null };
  const ps = { sales: { seller_class: 'strong', tier_label: 'platinum', vel30: 5, trend: null, units_7d: 5, units_30d: 20, units_365d: 200 }, e: { spend: 100, purchases: 5 }, m: { spend: 50 } };
  const stock = { known: true, units: 100, pass: true, size: { available: false, warning: null, level: null } };
  const facts = (unique, ads) => ({ active_unique_creatives: unique, running_creatives: unique, active_ads: ads, creatives_total: unique, new_creatives_90d: 2, last_new_creative: { date: '2026-09-25', source: 'x', days_ago: 12 }, recency_basis: 'known', newest_running_days: 12, oldest_running_days: 40, active_basis: 'delivery', historical_unique_creatives: 0 });
  const few = plan.recommendFamily({ family, ps, facts: facts(1, 9), stock, benchmarkCpa: 40, salesAvailable: true });
  assert.ok(few && few.type === 'shoot_fresh', 'one unique creative across 9 ads is NOT enough');
  assert.match(few.why, /only 1 unique creative is running \(across 9 Meta ads\)/);
  const enough = plan.recommendFamily({ family, ps, facts: facts(3, 3), stock, benchmarkCpa: 40, salesAvailable: true });
  assert.equal(enough, null, 'three unique creatives (3 ads) IS enough for a strong, fresh product');
  const enoughFewAds = plan.recommendFamily({ family, ps, facts: facts(3, 3), stock, benchmarkCpa: 40, salesAvailable: true });
  assert.equal(enoughFewAds, null);
});
test('planning: the shoot recommendation is driven by active UNIQUE creatives, not ads', () => {
  const src = code('src/lib/coreCreativePlan.js');
  assert.match(src, /facts\.active_unique_creatives >= cfg\.USABLE_MIN_CREATIVES/);
  assert.doesNotMatch(src, /enough = facts\.active_ads/);
  assert.equal(require('../src/lib/coreCreativePlanConfig').USABLE_MIN_CREATIVES, 3, 'threshold untouched');
  assert.equal(require('../src/lib/coreCreativePlanConfig').STOCK.min_sellable_units, 30, 'stock threshold untouched');
});

// ── Pre-2026 archive: proof of coverage + the per-creative rule ──────────────
const CUT = '2026-01-01';
const F = (o) => ({ ads_total: 3, ads_active: 0, created_unknown: 0, created_since_cutoff: 0, last_delivery: '2025-09-01', pulled_delivery: false, ...o });
const PROVEN = { proven: true };
test('archive: provably pre-2026-only creative IS archived', () => assert.equal(archive.isArchived(F({}), PROVEN, CUT), true));
test('archive: a 2025 original with a 2026 duplicate that ran is NOT archived (any duplicate)', () => {
  assert.equal(archive.isArchived(F({ last_delivery: '2026-08-15' }), PROVEN, CUT), false);
});
test('archive: delivery recorded only in Meta\'s activity check keeps the creative', () => assert.equal(archive.isArchived(F({ pulled_delivery: true }), PROVEN, CUT), false));
test('archive: an ACTIVE ad, an ad created in 2026, or an unknown created date keeps the creative', () => {
  assert.equal(archive.isArchived(F({ ads_active: 1 }), PROVEN, CUT), false);
  assert.equal(archive.isArchived(F({ created_since_cutoff: 1 }), PROVEN, CUT), false);
  assert.equal(archive.isArchived(F({ created_unknown: 1 }), PROVEN, CUT), false);
});
test('archive: without proof of coverage NOTHING is archived (absence of a 2026 row is not proof)', () => {
  assert.equal(archive.isArchived(F({ last_delivery: null }), { proven: false }, CUT), false);
  assert.equal(archive.isArchived(F({ last_delivery: null }), null, CUT), false);
});
test('proof: stored Insights that start AFTER the cutoff prove nothing', () => {
  const p = archive.computeProof({ runs: [{ since: '2026-06-01', until: '2026-10-06' }], pull: null, today: TODAY });
  assert.equal(p.proven, false);
  assert.match(p.reason, /only reach back to 2026-06-01/);
});
test('proof: contiguous stored syncs from before the cutoff to within 14 days of today DO prove it', () => {
  const p = archive.computeProof({ runs: [{ since: '2025-11-01', until: '2026-03-31' }, { since: '2026-04-01', until: '2026-10-06' }], pull: null, today: TODAY });
  assert.equal(p.proven, true);
  assert.equal(p.basis, 'local_insights');
});
test('proof: a gap in the stored syncs breaks the chain (no proof across a hole)', () => {
  const p = archive.computeProof({ runs: [{ since: '2025-11-01', until: '2026-03-31' }, { since: '2026-05-01', until: '2026-10-06' }], pull: null, today: TODAY });
  assert.equal(p.proven, false);
});
test('proof: stored Insights that ended long ago are stale, not proof', () => {
  const p = archive.computeProof({ runs: [{ since: '2025-11-01', until: '2026-06-30' }], pull: null, today: TODAY });
  assert.equal(p.proven, false);
  assert.match(p.reason, /end on 2026-06-30/);
});
test('proof: a completed Meta activity check from the cutoff to yesterday proves it; an old one does not', () => {
  assert.equal(archive.computeProof({ runs: [], pull: { id: 7, since: CUT, until: '2026-10-06' }, today: TODAY }).basis, 'activity_pull');
  assert.equal(archive.computeProof({ runs: [], pull: { id: 7, since: CUT, until: '2026-07-01' }, today: TODAY }).proven, false);
  // an old check extended by contiguous local syncs reaches today
  const ext = archive.computeProof({ runs: [{ since: '2026-07-02', until: '2026-10-06' }], pull: { id: 7, since: CUT, until: '2026-07-01' }, today: TODAY });
  assert.equal(ext.proven, true);
  // a check that does not start by the cutoff is not evidence of the cutoff
  assert.equal(archive.computeProof({ runs: [], pull: { id: 7, since: '2026-02-01', until: '2026-10-06' }, today: TODAY }).proven, false);
});
test('proof: no data at all -> unproven with a clear reason', () => {
  const p = archive.computeProof({ runs: [], pull: null, today: TODAY });
  assert.equal(p.proven, false);
  assert.match(p.reason, /No Insights have been synced/);
});

// ── the bounded Meta check: exactly what it asks for ───────────────────────
test('activity check request: read-only, three fields, one aggregate row per ad, no daily breakdown', () => {
  const r = pullLib.describeRequest('2026-10-07');
  assert.equal(r.method, 'GET');
  assert.equal(r.read_only, true);
  assert.equal(r.writes_to_meta, false);
  assert.deepEqual(r.params, { level: 'ad', fields: 'ad_id,spend,impressions', time_range: { since: '2026-01-01', until: '2026-10-06' }, limit: 500 });
  assert.equal(r.params.time_increment, undefined);
  assert.deepEqual(pullLib.monthChunks('2026-01-01', '2026-03-15'), [{ since: '2026-01-01', until: '2026-01-31' }, { since: '2026-02-01', until: '2026-02-28' }, { since: '2026-03-01', until: '2026-03-15' }]);
  assert.equal(pullLib.isTooMuchData(new Error('Please reduce the amount of data you\'re asking for')), true);
});
test('archive/pull modules: GET only, no writes to ads, Insights, classifications or matching', () => {
  for (const f of ['metaActivityPull', 'metaCreativeArchive']) {
    const src = code(`src/lib/${f}.js`);
    assert.doesNotMatch(src, /method:\s*['"](POST|PUT|DELETE|PATCH)['"]|metaPost|apparelmagic/i, f);
    assert.doesNotMatch(src, /(INSERT INTO|UPDATE|DELETE FROM)\s+(meta_ads|meta_ad_insights_daily|meta_ad_classifications|meta_ad_products|meta_ad_suggestions|meta_catalogue)/i, f);
  }
  assert.doesNotMatch(code('src/lib/metaCreativeArchive.js'), /require\('\.\/metaAds'\)/, 'the proof/rule module never talks to Meta');
});
test('the archive never touches matching rules, the rules version or relevance', () => {
  const m = read('src/lib/metaAdMatching.js');
  assert.match(m, /const BASE_RULES_VERSION = 3;/);
  const rel = read('src/lib/metaMatchingRelevance.js');
  assert.equal(rel, rel, 'relevance module present');
  assert.doesNotMatch(code('src/lib/metaMatchingRelevance.js'), /archive/i, 'relevance logic is unchanged by the archive');
});

// ── ApparelMagic product pictures: ONE composite image is the normal case ──────────────
test('images: one catalogue picture (the normal WNDRR case) is a single image, shown once, with no back slot', () => {
  const r = am.pickFrontBack(am.extractImages({ images: [{ img: 'https://x/composite.jpg', is_catalog_image: '1' }] }));
  assert.equal(r.layout, 'single');
  assert.equal(r.main.url, 'https://x/composite.jpg');
  assert.equal(r.back, null);
  assert.equal(r.count, 1);
});
test('images: several UNLABELLED pictures -> the catalogue image only; order never makes a second one a "back"', () => {
  const r = am.pickFrontBack(am.extractImages({ images: [{ img: 'https://x/1.jpg', is_catalog_image: '1' }, { img: 'https://x/2.jpg' }, { img: 'https://x/3.jpg' }] }));
  assert.equal(r.layout, 'single');
  assert.equal(r.main.url, 'https://x/1.jpg');
  assert.equal(r.main.basis, 'catalog');
  assert.equal(r.back, null);
});
test('images: separate front + back are used only when the records say so (label or file name)', () => {
  const byLabel = am.pickFrontBack(am.extractImages({ images: [{ img: 'https://x/2.jpg', description: 'Back view' }, { img: 'https://x/1.jpg', description: 'Front', is_catalog_image: '1' }] }));
  assert.deepEqual([byLabel.layout, byLabel.front.url, byLabel.front.basis, byLabel.back.url, byLabel.back.basis], ['front_back', 'https://x/1.jpg', 'label', 'https://x/2.jpg', 'label']);
  const byName = am.pickFrontBack(am.extractImages({ images: [{ img: 'https://x/style_front.jpg' }, { img: 'https://x/style_back.jpg' }] }));
  assert.deepEqual([byName.layout, byName.front.basis, byName.back.basis], ['front_back', 'filename', 'filename']);
});
test('images: a lone "front" label or a lone "back" label does not create a two-pane layout or duplicate an image', () => {
  const onlyFront = am.pickFrontBack(am.extractImages({ images: [{ img: 'https://x/a_front.jpg' }, { img: 'https://x/b.jpg' }] }));
  assert.equal(onlyFront.layout, 'single'); assert.equal(onlyFront.main.url, 'https://x/a_front.jpg'); assert.equal(onlyFront.back, null);
  const onlyBack = am.pickFrontBack(am.extractImages({ images: [{ img: 'https://x/a_back.jpg' }, { img: 'https://x/b.jpg' }] }));
  assert.equal(onlyBack.layout, 'single'); assert.equal(onlyBack.main.url, 'https://x/b.jpg');
  for (const r of [onlyFront, onlyBack]) assert.ok(!r.back || r.back.url !== r.main.url);
  assert.deepEqual(am.pickFrontBack([]), { layout: 'none', main: null, front: null, back: null, count: 0 });
});
test('planning tile: a composite image renders ONCE across the image area, never as Front | No back image', () => {
  const app = read('public/app.js');
  assert.match(app, /function cpImagesHtml/);
  assert.match(app, /im\.layout === 'front_back' && im\.front && im\.back/);
  assert.doesNotMatch(app, /No \$\{label\.toLowerCase\(\)\} image/, 'no per-slot "No back image" placeholder exists any more');
  assert.match(app, /No product image/);
  const css = read('public/styles.css');
  assert.match(css, /\.cp-img img\{[^}]*object-fit:contain/);
  assert.doesNotMatch(css, /\.cp-img img\{[^}]*object-fit:cover/);
});

// ── preview fetch economy ────────────────────────────────────────────────
function fakeMeta(delay = 0) {
  const calls = [];
  const metaGet = async (p, q) => {
    calls.push(p + (q && q.fields ? `?${q.fields.slice(0, 18)}` : ''));
    if (delay) await new Promise((r) => setTimeout(r, delay));
    if (/\/previews$/.test(p)) return { status: 200, data: { data: [{ body: '<iframe src="https://business.facebook.com/ads/api/preview_iframe.php?d=1"></iframe>' }] } };
    if (/^\/(ad\d+)$/.test(p)) return { status: 200, data: { preview_shareable_link: 'https://fb.me/adspreview/facebook/TOKEN' } };
    return { status: 200, data: { id: 'cr1', thumbnail_url: 'https://scontent.fbcdn.net/t.jpg', image_url: 'https://scontent.fbcdn.net/i.jpg' } };
  };
  return { calls, metaGet };
}
test('preview fetch: the independent Meta calls run concurrently, not one after another', async () => {
  const m = fakeMeta(60);
  const t0 = Date.now();
  const out = await creative.fetchFromMeta('ad1', 'cr1', { metaGet: m.metaGet, accountPath: () => 'act_1' });
  const ms = Date.now() - t0;
  assert.equal(m.calls.length, 3);
  assert.ok(ms < 150, `3 x 60 ms calls took ${ms} ms (sequential would be ~180+)`);
  assert.equal(out.kind, 'image');
  assert.ok(out.timings_ms.creative >= 55 && out.timings_ms.preview >= 55, 'per-step timings are reported');
});
test('preview fetch: a stored share link is reused (that call is skipped)', async () => {
  const m = fakeMeta();
  const out = await creative.fetchFromMeta('ad1', 'cr1', { metaGet: m.metaGet, accountPath: () => 'act_1' }, { knownShareLink: 'https://fb.me/adspreview/facebook/KNOWN' });
  assert.equal(m.calls.length, 2);
  assert.equal(out.share_link, 'https://fb.me/adspreview/facebook/KNOWN');
  assert.equal(out.diagnostics.share_link, 'reused');
});
test('preview fetch: a sibling ad of the SAME creative supplies the creative-level pieces (only the ad-specific preview is fetched)', async () => {
  const m = fakeMeta();
  const base = { kind: 'video', object_type: 'VIDEO', thumbnail_url: 'https://scontent.fbcdn.net/t.jpg', main: { type: 'video', video_url: 'https://video.fbcdn.net/v.mp4', image_url: null, poster_url: null }, cards: [] };
  const out = await creative.fetchFromMeta('ad2', 'cr1', { metaGet: m.metaGet, accountPath: () => 'act_1' }, { base, knownShareLink: 'https://fb.me/adspreview/facebook/K' });
  assert.equal(m.calls.length, 1, 'only /previews');
  assert.equal(out.kind, 'video');
  assert.equal(out.main.video_url, 'https://video.fbcdn.net/v.mp4');
  assert.match(out.preview_iframe_src, /preview_iframe\.php/);
  assert.equal(out.source, 'meta_sibling');
});
test('preview: browser reuses an already-loaded preview, shares one in-flight fetch, and warms only on hover intent', () => {
  const app = read('public/app.js');
  assert.match(app, /const apCache = new Map\(\)/);
  assert.match(app, /apInflight\.has\(adId\)\) return apInflight\.get\(adId\)/);
  assert.match(app, /setTimeout\(\(\) => apPrefetch\(id\), 250\)/);
  assert.match(app, /prefetch=1/);
  assert.doesNotMatch(app, /querySelectorAll\('\[data-thumb-ad\]'\)\.forEach\([^)]*apPrefetch/, 'no bulk prefetch over the table');
  assert.match(read('public/index.html'), /rel="preconnect" href="https:\/\/business\.facebook\.com"/);
});
test('preview prefetch is gated by the META_AUTO_SYNC switch and only the server decides to reach Meta', () => {
  const src = code('src/lib/metaAdCreative.js');
  assert.match(src, /if \(prefetch\) \{[\s\S]*?autoEnabled[\s\S]*?return null;/);
});

// ── layout / structure guards ──────────────────────────────────────────────
test('Meta Performance: Funnel is its own FIRST column, then Creative, then Ad Name', () => {
  const html = read('public/index.html');
  const m = /<table class="mp-table mp-perf">[\s\S]*?<tr>([\s\S]*?)<\/tr>/.exec(html);
  const heads = [...m[1].matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((x) => x[1].trim());
  assert.deepEqual(heads, ['Funnel', 'Creative', 'Ad Name', 'Status', 'Amount Spent', 'Purchases', 'CPA', 'Adds to Cart', 'Cost / ATC', 'Outbound CTR', 'Reach', 'Frequency']);
  const app = read('public/app.js');
  assert.match(app, /<td class="mp-funnel-cell">\$\{mpFunnelBadge\(a\.funnel\)\}<\/td>\s*<td class="mp-creative-cell">\$\{ccThumbHtml/);
  assert.doesNotMatch(app, /mp-campaign-line"><span class="mp-funnel/, 'funnel is no longer under the ad name');
});
test('Inspiration stage folders cover every record (Other catches what names none of the four stages)', () => {
  const app = read('public/app.js');
  assert.match(app, /const BF_INSP_STAGES = \[/);
  assert.match(app, /return keys\.length \? keys : \['other'\]/);
  for (const label of ['Hype', 'Live', 'Mid Sale', 'Last Chance', 'Other / Uncategorised']) assert.ok(app.includes(label), label);
});
test('Inspiration: deterministic recovery has no name search; the manual workflow is a separate module', () => {
  assert.doesNotMatch(code('src/lib/inspirationMetaLink.js'), /ILIKE|ad_name|similarity|levenshtein|jaccard/i);
  assert.match(code('src/lib/inspirationManualLink.js'), /manualLink/);
  assert.match(read('public/app.js'), /Link to Meta creative/);
});
test('conflict resolution and matching rules are untouched by this batch', () => {
  assert.match(code('src/lib/metaCreativeConflict.js'), /resolveConflict/);
  assert.equal(require('../src/lib/metaCreativeIdentity').METHOD, 'creative_inherited');
});

// ── batch 4: Last 3 / Last 4 Days, composite regression for unique creatives ───────────────────
const perf = require('../src/lib/metaPerformance');
test('presets: Last 3 Days and Last 4 Days exist and are the N COMPLETE days ending yesterday (inclusive, same convention as Last 7)', () => {
  assert.ok(perf.PRESETS.includes('last_3') && perf.PRESETS.includes('last_4'));
  assert.deepEqual(perf.resolvePreset('last_3', '2026-10-08'), { since: '2026-10-05', until: '2026-10-07' });
  assert.deepEqual(perf.resolvePreset('last_4', '2026-10-08'), { since: '2026-10-04', until: '2026-10-07' });
  assert.deepEqual(perf.resolvePreset('last_7', '2026-10-08'), { since: '2026-10-01', until: '2026-10-07' });
  assert.equal(health.rangeDays(perf.resolvePreset('last_3', '2026-10-08')), 3);
  assert.equal(health.rangeDays(perf.resolvePreset('last_4', '2026-10-08')), 4);
  assert.equal(perf.parseRangeParams({ preset: 'last_3' }).label, 'Last 3 Days');
  assert.equal(perf.parseRangeParams({ preset: 'last_4' }).label, 'Last 4 Days');
  assert.equal(perf.parseRangeParams({ preset: 'last_4', compare: '1' }).compareRange.until, perf.addDays(perf.parseRangeParams({ preset: 'last_4' }).range.since, -1));
});
test('presets: Last 3 and Last 4 Days qualify for the Frequency rule; Last 7 does not; the thresholds are unchanged', () => {
  const day = (name) => health.rangeDays(perf.resolvePreset(name, '2026-10-08'));
  for (const name of ['last_3', 'last_4']) {
    assert.equal(health.classify('TOF', 'frequency', 1.5, { days: day(name) }), 'green', `${name} TOF`);
    assert.equal(health.classify('TOF', 'frequency', 2, { days: day(name) }), null, `${name} TOF at 2`);
    assert.equal(health.classify('TOM', 'frequency', 2.5, { days: day(name) }), null, `${name}: TOM Frequency is no longer colour-coded`);
  }
  assert.equal(health.classify('TOF', 'frequency', 1.5, { days: day('last_7') }), null, 'TOF Frequency is neutral on Last 7 Days');
  assert.equal(health.classify('TOF', 'cpa', 250, { days: day('last_7') }), null, 'TOF CPA is no longer colour-coded');
  assert.equal(health.classify('MOF', 'cpa', 50, { days: day('last_7') }), 'green', 'MOF CPA $40-$60 is green on Last 7 Days');
  assert.equal(health.classify('MOF', 'cpa', 40, { days: day('last_7') }), 'green');
  assert.equal(health.classify('MOF', 'cpa', 60, { days: day('last_7') }), 'green');
  assert.deepEqual(health.RULES.MOF.cpa, { period: null, green: { min: 40, max: 60 } });
  assert.deepEqual(health.RULES.TOF.frequency, { period: 'approx_4_days', green: { lt: 2 } });
  assert.deepEqual(health.APPROX_4_DAYS, { target_days: 4, min_days: 3, max_days: 5 });
});
test('the Last 3 / Last 4 buttons exist in the date bar', () => {
  const html = read('public/index.html');
  assert.match(html, /data-preset="last_3">Last 3 Days</);
  assert.match(html, /data-preset="last_4">Last 4 Days</);
});
test('planning: 3 unique creatives across 13 Meta ads = 3 pieces of creative (counts, wording and recommendation)', () => {
  // Creative A in 5 ads, B in 4, C in 4: the active ads are 13 but the creatives are 3
  const mk = (key, n) => Array.from({ length: n }, (_, i) => adRow(`${key}${i}`, key, { extra: { adset: `set${i}`, campaign: `camp${i}` } }));
  const ps = { code: 'P', entries: [...mk('CRA', 5), ...mk('CRB', 4), ...mk('CRC', 4)] };
  const activity = { byCreative: new Map([['CRA', act({ ads_total: 5, ads_delivering: 5 })], ['CRB', act({ ads_total: 4, ads_delivering: 4 })], ['CRC', act({ ads_total: 4, ads_delivering: 4 })]]), insights_last_day: '2026-10-07' };
  const facts = plan.creativeFacts(ps, '2026-10-08', null, activity);
  assert.equal(facts.active_unique_creatives, 3);
  assert.equal(facts.active_ads, 13);
  const family = { key: 'P', product_code: 'P', name: 'Test Tee', category: 'TEES', image_url: null };
  const sales = { sales: { seller_class: 'strong', tier_label: 'platinum', vel30: 5, trend: null, units_7d: 5, units_30d: 20, units_365d: 200 }, e: { spend: 100, purchases: 5 }, m: { spend: 50 } };
  const stock = { known: true, units: 100, pass: true, size: { available: false, warning: null, level: null } };
  const withFresh = (f) => ({ ...f, last_new_creative: { date: '2026-09-25', source: 'x', days_ago: 13 }, recency_basis: 'known' });
  assert.equal(plan.recommendFamily({ family, ps: sales, facts: withFresh(facts), stock, benchmarkCpa: 40, salesAvailable: true }), null, '3 unique creatives (13 ads) is treated as 3 pieces of creative: enough');
  const two = plan.recommendFamily({ family, ps: sales, facts: withFresh({ ...facts, active_unique_creatives: 2, running_creatives: 2 }), stock, benchmarkCpa: 40, salesAvailable: true });
  assert.ok(two && two.type === 'shoot_fresh' && /only 2 unique creatives are running \(across 13 Meta ads\)/.test(two.why), '2 unique creatives across the same 13 ads still asks for more');
  // wording in the UI
  const app = read('public/app.js');
  assert.match(app, /Unique creatives running/);
  assert.match(app, /Meta ad\$\{cr\.active_ads === 1 \? '' : 's'\} using/);
  assert.match(app, /unique creative\$\{[^}]*\} running across \$\{cr\.active_ads\} Meta ad/);
  assert.doesNotMatch(app, /ACTIVE CREATIVES|Active creatives<\/dt>/i);
});
test('ad matching: All ads is a chip, the working view is remembered, and the table is compact', () => {
  const app = read('public/app.js');
  assert.match(app, /\['all', 'All ads', 'all_ads', 'ads'\]/);
  assert.match(app, /wndrr\.matching\.view/);
  assert.match(app, /pageSize: 50/);
  const css = read('public/styles.css');
  assert.match(css, /\.mm-table td\{padding:2px 8px/);
  assert.match(css, /\.mm-table td\.mp-name \.cc-thumb\{width:28px;height:28px/);
});
test('the archive activity check is only ever started by its explicit button', () => {
  const app = read('public/app.js');
  const posts = [...app.matchAll(/meta-archive\/pull/g)].length;
  assert.equal(posts, 1, 'one call site');
  assert.match(app, /const ok = await confirmDialog\(`This makes a read-only request to Meta[\s\S]{0,900}?\n\s+if \(!ok\) return;[\s\S]{0,200}?meta-archive\/pull/);
  assert.doesNotMatch(code('src/server.js'), /metaActivityPull|startPull\(/);
});
