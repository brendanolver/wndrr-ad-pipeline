// Planning confidence (Batch 27 pre-deployment fixes): proportionate uncertainty from unidentified Meta ads, High priority for short selling windows, and stock runway.
// Every input is a fixture. No database, no network, no live data.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused'; // pool is lazy; never connected here
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const opp = require('../src/lib/planningOpportunities');
const dm = require('../src/lib/planningDemand');
const cfgLib = require('../src/lib/creativePlanningConfig');
const coverage = require('../src/lib/activeAdCoverage');
const { measureLeadTime } = require('../src/lib/productionLeadTime');
const { CFG, TODAY, cr, salesOf, base } = require('./_planningFixtures');

const run = (p, mode = 'core', cfg = CFG) => opp.evaluate(p, cfg, TODAY, mode);
const strong = salesOf(150, { units7: 40, units14: 75 });
const cov = (o = {}) => ({ known: true, active_ads: 0, possible: 0, unresolved: 0, unresolved_share_pct: 0, uncertain: false, min: 5, ...o });
const perf3 = () => [cr('a', 'performing', { age: 60, spend: 700, purchases: 15, concept: 'TRY ON' }), cr('b', 'performing', { age: 40, spend: 600, purchases: 13, concept: 'UGC' }), cr('c', 'performing', { age: 20, spend: 500, purchases: 11, concept: 'FLAT LAY' })];
const weakCreative = () => [cr('a', 'underperforming', { age: 100, severity: 'clear', spend: 600, purchases: 5, concept: 'A' })];

// ── proportionate uncertainty from unidentified Meta ads ───────────────────────────────────────────
test('uncertainty is weighed by the share of recent spend the unidentified ads carry, with configurable lines', () => {
  assert.equal(opp.unresolvedAssessment(cov(), CFG).level, 'none');
  assert.equal(opp.unresolvedAssessment(cov({ unresolved: 1, unresolved_share_pct: 0.4 }), CFG).level, 'low');
  assert.equal(opp.unresolvedAssessment(cov({ unresolved: 2, unresolved_share_pct: 2.5 }), CFG).level, 'medium');
  assert.equal(opp.unresolvedAssessment(cov({ unresolved: 4, unresolved_share_pct: 12 }), CFG).level, 'high');
  assert.equal(opp.unresolvedAssessment(cov({ unresolved: 1, unresolved_share_pct: null }), CFG).level, 'high', 'an unknown share cannot be ruled out');
  const loose = cfgLib.resolve({ unresolved_spend_note_pct: 10, unresolved_spend_block_pct: 30 }).config;
  assert.equal(opp.unresolvedAssessment(cov({ unresolved: 2, unresolved_share_pct: 2.5 }), loose).level, 'low', 'the lines are settings');
  const r = cfgLib.resolve({ unresolved_spend_note_pct: 8, unresolved_spend_block_pct: 5 });
  assert.ok(r.issues.some((i) => /unresolved_spend_note_pct must be below/.test(i))); assert.ok(r.config.unresolved_spend_note_pct < r.config.unresolved_spend_block_pct);
});

test('BEFORE / AFTER: zero unresolved ads -> High; one low-spend unresolved ad -> still High with a warning (it used to suppress everything)', () => {
  const none = run(base({ sales: strong, coverage: cov() }));
  assert.equal(none.status, 'act'); assert.equal(none.priority, 'High'); assert.equal(none.facts.unresolved_level, 'none');
  const low = run(base({ sales: strong, coverage: cov({ unresolved: 1, unresolved_share_pct: 0.4 }) }));
  assert.equal(low.status, 'act'); assert.equal(low.priority, 'High', 'one small unidentified ad no longer turns every recommendation into "not enough data"');
  assert.equal(low.facts.unresolved_level, 'low'); assert.equal(low.facts.matching, 'confirmed');
  const w = low.why.find((x) => x.k === 'matching').text;
  assert.match(w, /1 recently delivering Meta ad could not be identified, carrying 0\.4% of recent spend/); assert.match(w, /data-quality warning only/);
  assert.equal(low.score, none.score, 'a warning does not change the score');
});

test('BEFORE / AFTER: material unidentified spend: a "no creative running" finding is held at Medium (2.5%), and becomes "not enough data" when it is large (12%)', () => {
  const medium = run(base({ sales: strong, coverage: cov({ unresolved: 2, unresolved_share_pct: 2.5 }) }));
  assert.equal(medium.status, 'act'); assert.equal(medium.priority, 'Medium');
  assert.match(medium.caps.join(' '), /2 recently delivering Meta ads could not be identified, carrying 2\.5% of recent spend \(medium account-level uncertainty\)/);
  const high = run(base({ sales: strong, coverage: cov({ unresolved: 5, unresolved_share_pct: 12 }) }));
  assert.equal(high.status, 'insufficient_data'); assert.equal(high.actionable, false);
  assert.match(high.reason, /carrying 12% of recent spend \(high account-level uncertainty\)/); assert.match(high.reason, /the line for this is 5% of recent spend/);
  assert.equal(high.facts.matching, 'uncertain'); assert.equal(high.facts.unresolved_share_pct, 12);
});

test('a product with confirmed effective creative is unaffected, at any level of uncertainty', () => {
  for (const share of [0.4, 2.5, 12, null]) {
    const o = run(base({ sales: strong, creatives: perf3(), coverage: cov({ active_ads: 3, unresolved: 3, unresolved_share_pct: share }) }));
    assert.equal(o.status, 'covered', `share ${share}`);
  }
});

test('a product with a confirmed creative gap is the one that depends on the "nothing is running" assumption; existing creative problems are supported by independent evidence', () => {
  const gap = (share) => run(base({ sales: strong, coverage: cov({ unresolved: 4, unresolved_share_pct: share }) }));
  assert.equal(gap(0.3).priority, 'High'); assert.equal(gap(3).priority, 'Medium'); assert.equal(gap(9).status, 'insufficient_data');
  const weak = (share) => run(base({ sales: strong, creatives: weakCreative(), coverage: cov({ active_ads: 1, unresolved: 4, unresolved_share_pct: share }) }));
  assert.equal(weak(9).status, 'act', 'underperforming creative is real evidence even if some ads are unidentified');
  assert.equal(weak(9).priority, 'Medium', 'but at high uncertainty it is held at Medium: the full creative picture is not known');
  assert.equal(weak(0.3).priority, 'High');
  assert.equal(weak(3).priority, 'High', 'medium uncertainty only matters to a finding that rests on absence');
});

test('strong commercial demand with uncertain creative coverage is not hidden: it shows as "not enough data" with the reason and the line, never as a confirmed gap', () => {
  const o = run(base({ sales: strong, coverage: cov({ unresolved: 6, unresolved_share_pct: 18 }) }));
  assert.equal(o.status, 'insufficient_data'); assert.equal(o.demand.level, 'strong');
  const m = o.eligibility.find((e) => e.key === 'matching');
  assert.equal(m.ok, false); assert.match(m.text, /6 recently delivering Meta ads could not be identified, carrying 18% of recent spend/);
  assert.equal(o.gap, null, 'no creative-gap claim is made');
});

test('a product with suggested Meta matches keeps its own (product-specific) uncertainty, independent of the account-level one', () => {
  const o = run(base({ sales: strong, coverage: cov({ possible: 2, unresolved: 0, uncertain: true }) }));
  assert.equal(o.status, 'insufficient_data'); assert.match(o.reason, /2 active Meta ads awaiting review/);
  const both = run(base({ sales: strong, coverage: cov({ possible: 2, unresolved: 1, unresolved_share_pct: 0.4, uncertain: true }) }));
  assert.equal(both.status, 'insufficient_data');
});

test('coverage loader: reports count, spend and the SHARE of recent non-DPA spend, with no state exclusion (nothing is written off as deleted)', async () => {
  const queries = [];
  const db = { query: async (sql, params) => {
    queries.push([sql, params]);
    if (/count\(\*\)::int AS ads, max\(last_seen_at\)/.test(sql)) return { rows: [{ ads: 10, last_seen: new Date('2026-10-12T00:00:00Z') }] };
    if (/FROM meta_ads m\s+JOIN \(SELECT meta_ad_id, sum\(spend\)/.test(sql)) return { rows: [{ n: 3, spend: 42 }] };
    if (/SELECT COALESCE\(sum\(d\.spend\), 0\)::float AS spend FROM meta_ad_insights_daily d JOIN meta_ads m/.test(sql)) return { rows: [{ spend: 2000 }] };
    if (/SELECT count\(DISTINCT m\.meta_ad_id\)::int AS n/.test(sql)) return { rows: [{ n: 7 }] };
    return { rows: [] };
  } };
  const out = await coverage.loadActiveAdCoverage([{ key: 'F1', codes: ['F1'] }], { db, min: 5, now: new Date('2026-10-13T00:00:00Z') });
  assert.equal(out.unresolved_identities, 3); assert.equal(out.unresolved_spend, 42); assert.equal(out.account_spend, 2000); assert.equal(out.unresolved_share_pct, 2.1);
  assert.equal(out.reliability.identities_complete, false); assert.equal(out.reliability.confirmed_or_auto, 7);
  const q = queries.find(([sql]) => /meta_ad_insights_daily/.test(sql) && /ad_name IS NULL/.test(sql));
  assert.match(q[0], /spend > 0/); assert.doesNotMatch(q[0], /not_found|meta_ad_identity_lookups/, 'a refused ad is not excluded');
  const denom = queries.find(([sql]) => /AS spend FROM meta_ad_insights_daily d JOIN meta_ads m/.test(sql));
  assert.match(denom[0], /NOT|dpa|DPA|catalog/i, 'the denominator excludes DPA spend, the spend creative coverage is about');
  assert.equal(q[1][0], '2026-09-29', 'a 14 day delivery window');
});

test('coverage loader: with nothing unresolved there is no extra query and the share is zero', async () => {
  let denominatorQueried = false;
  const db = { query: async (sql) => {
    if (/count\(\*\)::int AS ads, max\(last_seen_at\)/.test(sql)) return { rows: [{ ads: 10, last_seen: new Date('2026-10-12T00:00:00Z') }] };
    if (/FROM meta_ads m\s+JOIN \(SELECT meta_ad_id, sum\(spend\)/.test(sql)) return { rows: [{ n: 0, spend: 0 }] };
    if (/AS spend FROM meta_ad_insights_daily d JOIN meta_ads m/.test(sql)) { denominatorQueried = true; return { rows: [{ spend: 1 }] }; }
    if (/SELECT count\(DISTINCT m\.meta_ad_id\)::int AS n/.test(sql)) return { rows: [{ n: 0 }] };
    return { rows: [] };
  } };
  const out = await coverage.loadActiveAdCoverage([], { db, min: 5, now: new Date('2026-10-13T00:00:00Z') });
  assert.equal(out.unresolved_identities, 0); assert.equal(out.unresolved_share_pct, 0); assert.equal(denominatorQueried, false);
});

// ── High priority and short selling windows ────────────────────────────────────────────────────────
const launchP = (u30, days, o = {}) => base({ key: 'W26NEW', name: 'Drop Tee', is_core: false, launch_age_days: days - 1, stock: { known: true, units: 300, on_order: 0 }, sales: salesOf(u30, { units7: Math.round(u30 / days * 7), units14: Math.round(u30 / days * 14), since_launch: u30, days_live: days }), ...o });

test('Reaper-style launch: 11 units in 13 days scales to about 25 per 30 days (steady): it is held at Medium, with the reason, not High', () => {
  const o = run(launchP(11, 13), 'momentum');
  assert.equal(o.status, 'act'); assert.equal(Math.round(o.demand.eq30), 25); assert.equal(o.demand.level, 'steady'); assert.equal(o.demand.partial, true);
  assert.equal(o.priority, 'Medium');
  assert.match(o.caps.join(' '), /only 13 days of sales, scaled to about 25 units in 30 days. That is steady, not strong \(50\+\), and a short window is an estimate rather than an observation/);
  assert.ok(o.score >= CFG.priority_high_min, `the score (${o.score}) alone would have been High: it is the demand rule that holds it`);
});

test('strong recent launch -> High; moderate recent launch -> Medium; weak recent launch -> not recommended; very short history -> too early', () => {
  assert.equal(run(launchP(60, 13), 'momentum').priority, 'High');
  const moderate = run(launchP(14, 13), 'momentum'); // about 32 units in 30 days
  assert.equal(moderate.demand.level, 'steady'); assert.equal(moderate.priority, 'Medium');
  assert.equal(run(launchP(6, 13), 'momentum').status, 'weak_demand');
  const early = run(launchP(9, 3), 'momentum'); assert.equal(early.status, 'too_new');
});

test('the rule is a setting, uses the existing strong-demand line, and does not touch established products', () => {
  const off = cfgLib.resolve({ momentum_high_requires_strong: 0 }).config;
  assert.equal(run(launchP(11, 13), 'momentum', off).priority, 'High', 'switched off: the previous behaviour');
  const higher = cfgLib.resolve({ demand_strong_units: 20, demand_steady_units: 10 }).config;
  assert.equal(run(launchP(11, 13), 'momentum', higher).priority, 'High', 'it follows the strong-demand line: no new number');
  // an established product (no short window) with steady demand is unchanged by this rule
  const established = run(base({ sales: salesOf(29, { units7: 7, units14: 14 }) }));
  assert.equal(established.demand.partial, false); assert.ok(!/short window/.test(established.caps.join(' ')));
  assert.ok(cfgLib.describe(CFG).some((g) => g.fields.some((f) => f.key === 'momentum_high_requires_strong')), 'visible in Settings');
});

test('strong established bestseller -> High; sufficient effective creative -> covered; one dominant creative -> recognised; uncertain matching -> not enough data; limited stock runway -> not recommended', () => {
  assert.equal(run(base({ sales: salesOf(788, { units7: 189, units14: 294 }), stock: { known: true, units: 2800, on_order: 0 } })).priority, 'High');
  assert.equal(run(base({ sales: strong, creatives: perf3(), coverage: cov({ active_ads: 3 }) })).status, 'covered');
  const dom = run(base({ sales: strong, creatives: [cr('a', 'performing', { spend: 1800, purchases: 40, concept: 'A' }), cr('b', 'performing', { spend: 100, purchases: 2, concept: 'B' })], coverage: cov({ active_ads: 2 }) }));
  assert.equal(dom.gap.type, 'concentration');
  assert.equal(run(base({ sales: strong, coverage: cov({ possible: 3, uncertain: true }) })).status, 'insufficient_data');
  assert.equal(run(base({ sales: strong, stock: { known: true, units: 60, on_order: 0 } })).status, 'low_stock');
});

// ── stock runway ───────────────────────────────────────────────────────────────────────────────────
// Maison-style: 169 units, about 36 a week = 4.6 weeks of cover
const maison = (o = {}) => base({ stock: { known: true, units: 169, on_order: 0 }, sales: salesOf(98, { units7: 27, units14: 73 }), ...o });

test('stock runway is OFF by default (no lead time is invented): a 4.6 week product clears the 4 week minimum exactly as before', () => {
  assert.equal(CFG.creative_lead_time_days, 0);
  const o = run(maison());
  assert.equal(o.status, 'act'); assert.equal(o.stock.band, 'healthy'); assert.equal(o.stock.min_weeks, 4);
  assert.equal(dm.minCoverWeeks(CFG), 4);
});

test('with a production lead time configured, stock must outlast lead time + test period: a 4.6 week product is held back at 5 weeks needed, and the reason says so', () => {
  const c21 = cfgLib.resolve({ creative_lead_time_days: 21 }).config; // 21 + 14 test = 35 days = 5 weeks
  assert.equal(dm.minCoverWeeks(c21), 5);
  const o = run(maison(), 'core', c21);
  assert.equal(o.status, 'low_stock'); assert.match(o.reason, /only 4\.6 weeks of stock/); assert.match(o.reason, /5 needed for creative to pay off: 21 days to get new creative live plus a 14 day test period/);
  const c14 = cfgLib.resolve({ creative_lead_time_days: 14 }).config; // 28 days = 4 weeks: equal to the existing minimum
  assert.equal(run(maison(), 'core', c14).status, 'act');
  const restock = run(maison({ stock: { known: true, units: 169, on_order: 200 } }), 'core', c21);
  assert.equal(restock.status, 'act'); assert.equal(restock.stock.band, 'short_restock', 'a confirmed restock closes the gap');
});

test('production lead time is MEASURED from production timestamps for the Planning page (information only, with the number of concepts behind it)', async () => {
  const db = (row) => ({ query: async (sql, params) => { assert.match(sql, /status_history/); assert.match(sql, /'uploaded_live'/); assert.equal(params[0], 120); return { rows: [row] }; } });
  const few = await measureLeadTime(db({ n: 3, median_days: 19.34, p90_days: 31 }));
  assert.equal(few.reliable, false); assert.match(few.note, /Only 3 concepts reached "uploaded live"/); assert.equal(few.median_days, 19.3);
  const enough = await measureLeadTime(db({ n: 14, median_days: 17.04, p90_days: 29.5 }));
  assert.equal(enough.reliable, true); assert.equal(enough.median_days, 17); assert.equal(enough.p90_days, 29.5); assert.equal(enough.note, null);
  assert.equal((await measureLeadTime(db({ n: 0, median_days: null, p90_days: null }))).median_days, null);
  const loader = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'planningOpportunitiesLoader.js'), 'utf8');
  assert.match(loader, /production_lead_time: leadTime/); assert.doesNotMatch(loader, /creative_lead_time_days\s*=\s*leadTime/, 'never applied automatically');
});

test('documentation of the launch-cohort endpoint is accurate: it can trigger external reads on a cold cache and never calls Meta', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'opportunities.js'), 'utf8');
  assert.doesNotMatch(src, /Read-only; nothing is written or fetched/);
  assert.match(src, /NOT free of external reads/); assert.match(src, /\?fresh=1/); assert.match(src, /never\s+\/\/ calls Meta|never calls Meta/);
});

test('equal scores are listed with the bigger commercial opportunity first (order only: no score or priority changes)', () => {
  const mk = (name, u30) => run(base({ name, key: name, sales: salesOf(u30, { units7: Math.round(u30 / 4.3), units14: Math.round(u30 / 2.15) }), stock: { known: true, units: u30 * 4, on_order: 0 } }));
  const items = [mk('Accent', 151), mk('Hexed', 70), mk('Soho', 788)];
  assert.deepEqual(items.map((i) => i.score), [items[0].score, items[0].score, items[0].score], 'strong sellers of very different size tie: demand points stop at the strong line');
  assert.deepEqual(items.slice().sort(opp.compareItems).map((i) => i.name), ['Soho', 'Accent', 'Hexed']);
  const lower = mk('Zed', 30); lower.score = items[0].score - 5;
  assert.equal([lower, items[0]].sort(opp.compareItems)[0].name, 'Accent', 'score still outranks volume');
  const covered = { name: 'A', status: 'covered', score: 0, facts: { units30: 900 } };
  assert.equal([covered, items[2]].sort(opp.compareItems)[0].name, 'Soho', 'actionable items still come first');
});
