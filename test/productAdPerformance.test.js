// Batch 12: judging a product's existing Meta creative (performing / underperforming / declining / insufficient / unrated / unavailable) and the roll-up
// to effective coverage. Pure: approved benchmarks come from the real defaults (MOF CPA <= $60 green, to $72 orange, over red); nothing is invented.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/lib/productAdPerformance');

const B = (spend, purchases, impressions = 20000, clicks = 400, value = 0) => ({ spend, purchases, impressions, clicks, value: value || purchases * 150 });
const judge = (total, funnel, over = {}) => P.judgeCreative({ total, recent: over.recent || total, prior: over.prior || total, delivery_rows: over.rows === undefined ? 14 : over.rows, funnel }, {});

test('no delivery at all -> unavailable (never "underperforming")', () => {
  assert.equal(judge(B(0, 0, 0, 0), 'MOF', { rows: 0 }).state, 'unavailable');
  assert.equal(judge(B(0, 0, 0, 0), 'MOF', { rows: 5 }).state, 'unavailable');
});
test('approved MOF CPA bands: <= $60 performing, $60-72 marginally underperforming, > $72 clearly underperforming', () => {
  assert.equal(judge(B(300, 6), 'MOF').state, 'performing');       // $50
  assert.equal(judge(B(300, 6), 'MOF').benchmark, 'green');
  assert.equal(judge(B(60 * 5, 5), 'MOF').state, 'performing');    // exactly $60 (inclusive)
  const o = judge(B(335, 5), 'MOF');                               // $67
  assert.equal(o.state, 'underperforming'); assert.equal(o.severity, 'marginal'); assert.equal(o.benchmark, 'orange');
  const r = judge(B(425, 5), 'MOF');                               // $85
  assert.equal(r.state, 'underperforming'); assert.equal(r.severity, 'clear'); assert.equal(r.benchmark, 'red');
  assert.match(r.reasons[0], /over the approved MOF CPA limit/);
});
test('a low-spend ad with no purchases is NOT underperforming: insufficient evidence', () => {
  const a = judge(B(20, 0, 3000), 'MOF');
  assert.equal(a.state, 'insufficient'); assert.match(a.reasons[0], /not enough to judge/);
  const b = judge(B(65, 0, 9000), 'MOF'); // $65 with no purchase: a later purchase could still land it at $65 (orange), so not yet over the red limit
  assert.equal(b.state, 'insufficient');
});
test('zero purchases but spend already beyond the approved red limit: judged underperforming (any CPA it could reach is red)', () => {
  const x = judge(B(90, 0, 12000), 'MOF');
  assert.equal(x.state, 'underperforming'); assert.equal(x.severity, 'clear'); assert.match(x.reasons[0], /spent with no purchase/);
});
test('not enough spend / impressions to judge, even with a good-looking CPA', () => {
  assert.equal(judge(B(40, 2, 8000), 'MOF').state, 'insufficient', 'two purchases on $40 is too little spend to call performing');
  assert.equal(judge(B(300, 6, 500, 20), 'MOF').state, 'insufficient', 'impressions below the minimum');
});
test('no approved benchmark for TOF / TOM CPA: enough data is "unrated", never performing or underperforming', () => {
  for (const f of ['TOF', 'TOM']) { const x = judge(B(400, 2), f); assert.equal(x.state, 'unrated', f); assert.match(x.reasons[0], /no approved/i); }
  assert.equal(judge(B(400, 2), null).state, 'unrated');
  assert.match(judge(B(400, 2), null).reasons[0], /unknown or mixed/);
});
test('declining: clearly worse than its OWN earlier results (CPA, ROAS or CTR), labelled as relative, not as a target', () => {
  const prior = B(300, 6); const recent = B(300, 3);                  // CPA $50 -> $100
  const d = P.judgeCreative({ total: B(600, 9), recent, prior, delivery_rows: 14, funnel: 'MOF' }, {});
  assert.equal(d.state, 'declining'); assert.equal(d.decline.metric, 'CPA'); assert.match(d.reasons[0], /compares the ad with itself, not with a target/);
  assert.ok(d.reasons.some((t) => /within the approved MOF CPA limit before/.test(t)), 'it was green before and is now over');
  const roasFall = P.judgeCreative({ total: B(600, 9, 40000, 800, 1800), recent: { spend: 300, impressions: 20000, clicks: 400, purchases: 3, value: 600 }, prior: { spend: 300, impressions: 20000, clicks: 400, purchases: 3, value: 1200 }, delivery_rows: 14, funnel: 'TOF' }, {});
  assert.equal(roasFall.state, 'declining'); assert.equal(roasFall.decline.metric, 'ROAS'); assert.equal(roasFall.severity, 'relative', 'no approved TOF benchmark: purely relative');
  const ctr = P.judgeCreative({ total: B(400, 0, 40000, 400), recent: B(200, 0, 20000, 120), prior: B(200, 0, 20000, 280), delivery_rows: 14, funnel: 'TOF' }, {});
  assert.equal(ctr.state, 'declining'); assert.equal(ctr.decline.metric, 'CTR');
});
test('a small wobble is not a decline; and a half with too little spend is never compared', () => {
  assert.notEqual(P.judgeCreative({ total: B(600, 9), recent: B(300, 5), prior: B(300, 6), delivery_rows: 14, funnel: 'MOF' }, {}).state, 'declining');
  assert.notEqual(P.judgeCreative({ total: B(330, 5), recent: B(300, 2), prior: B(30, 3), delivery_rows: 14, funnel: 'MOF' }, {}).state, 'declining', 'the earlier half had only $30');
});
test('the decline threshold and evidence minimums are configurable', () => {
  const m = { total: B(600, 9), recent: B(300, 4), prior: B(300, 5), delivery_rows: 14, funnel: 'MOF' }; // CPA 60 -> 75: +25%
  assert.equal(P.judgeCreative(m, { config: { trend_decline_pct: 25 } }).state, 'declining');
  assert.notEqual(P.judgeCreative(m, { config: { trend_decline_pct: 40 } }).state, 'declining');
  assert.equal(P.judgeCreative({ total: B(70, 1, 5000), recent: B(70, 1, 5000), prior: B(0, 0, 0), delivery_rows: 3, funnel: 'MOF' }, { config: { min_spend: 100 } }).state, 'insufficient');
});
test('config validation: bounds enforced, bad values reported and ignored', () => {
  const r = P.resolveConfig({ min_spend: -5, window_days: 30, trend_days: 20, trend_decline_pct: 25 });
  assert.equal(r.config.min_spend, P.DEFAULTS.min_spend); assert.ok(r.issues.some((i) => /min_spend/.test(i)));
  assert.equal(r.config.window_days, 30); assert.equal(r.config.trend_days, 15, 'two halves must fit inside the window');
  assert.deepEqual(P.resolveConfig({}).config, P.DEFAULTS);
});

const cr = (state, severity) => ({ key: Math.random().toString(36), state, severity });
test('effective coverage: 8 active ads, 2 performing, 4 weak, 2 insufficient -> thin (needs more creative), explained', () => {
  const s = P.summarizeProduct([cr('performing'), cr('performing'), cr('underperforming', 'clear'), cr('underperforming', 'clear'), cr('underperforming', 'marginal'), cr('declining', 'relative'), cr('insufficient'), cr('insufficient')], { activeAds: 8 });
  assert.equal(s.unique_creatives, 8); assert.equal(s.performing, 2); assert.equal(s.weak, 4); assert.equal(s.insufficient, 2);
  assert.equal(s.assessment, 'thin'); assert.equal(s.performing_gap, 1);
  assert.match(s.text, /2 of 8 unique creatives are performing \(3 wanted\); 4 weak or fading/);
});
test('effective coverage: 10 strong creatives -> healthy; mixed when many are also weak; thin evidence is "unclear", never a shortage', () => {
  assert.equal(P.summarizeProduct(Array.from({ length: 10 }, () => cr('performing')), {}).assessment, 'healthy');
  assert.equal(P.summarizeProduct([cr('performing'), cr('performing'), cr('performing'), cr('underperforming', 'clear'), cr('underperforming', 'clear'), cr('declining', 'relative'), cr('declining', 'relative')], {}).assessment, 'mixed');
  const unclear = P.summarizeProduct([cr('insufficient'), cr('insufficient'), cr('insufficient'), cr('unrated')], {});
  assert.equal(unclear.assessment, 'unclear'); assert.equal(unclear.evidence, 'thin');
  assert.equal(P.summarizeProduct([], {}).assessment, 'no_creative');
});
test('awaiting-review ads keep the summary explicitly uncertain', () => {
  const s = P.summarizeProduct([cr('performing')], { pendingAds: 3, activeAds: 1 });
  assert.equal(s.uncertain, true); assert.equal(s.pending_review_ads, 3);
});
