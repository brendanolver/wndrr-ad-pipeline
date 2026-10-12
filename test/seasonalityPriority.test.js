// Batch 11: seasonality (data-driven, Australian months) and the combined creative priority. Pure: no database, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/lib/seasonality');
const P = require('../src/lib/creativePriority');
const cfg = require('../src/lib/creativePriorityConfig');

// ── a synthetic world: the sales window always ends "today" (365 days), so the first month of the window and the month in progress are the two
//    halves of one month, exactly like the real feed ──
const pad2 = (n) => String(n).padStart(2, '0');
const ymdAdd = (ymd, n) => new Date(Date.UTC(...ymd.split('-').map(Number).map((x, i) => (i === 1 ? x - 1 : x))) + n * 86400000).toISOString().slice(0, 10);
const dim = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
function world(today, { extra = [], tweak = null, shorts = true } = {}) {
  const from = ymdAdd(today, -364);
  const window = { from, to: today };
  const startYm = from.slice(0, 7); const curYm = today.slice(0, 7);
  const all = []; for (let m = startYm; m <= curYm; m = (() => { const [y, mo] = m.split('-').map(Number); const t2 = y * 12 + mo; return `${Math.floor(t2 / 12)}-${pad2((t2 % 12) + 1)}`; })()) all.push(m);
  const cover = (m) => (m === startYm ? (dim(m) - Number(from.slice(8, 10)) + 1) / dim(m) : m === curYm ? Number(today.slice(8, 10)) / dim(m) : 1);
  const BF = `${Number(startYm.slice(0, 4)) + (Number(startYm.slice(5, 7)) <= 11 ? 0 : 1)}-11`;
  const mkS = (fn) => Object.fromEntries(all.map((m) => [m, Math.round(fn(Number(m.slice(5)), m) * (m === BF ? 3 : 1) * cover(m) * 100) / 100]));
  const shape = {
    shorts: (n) => ([12, 1, 2].includes(n) ? 90 : [11, 3].includes(n) ? 45 : n === 10 ? 30 : 12),    // spring ramp from October, peak Dec..Feb (Australian summer)
    hoodies: (n) => ([5, 6, 7, 8].includes(n) ? 90 : [4, 9].includes(n) ? 45 : 10),                   // May..Aug peak (winter)
    flat: () => 50,
  };
  const items = [
    { key: 'SHORT', cat: 'SHORTS', codes: ['S1', 'S2'], fn: shape.shorts }, { key: 'HOODIE', cat: 'HOODIES', codes: ['H1'], fn: shape.hoodies }, { key: 'TEE', cat: 'TEES', codes: ['T1'], fn: shape.flat },
    { key: 'P1', cat: 'TEES', codes: ['P1'], fn: shape.flat }, { key: 'P2', cat: 'TEES', codes: ['P2'], fn: shape.flat }, { key: 'P3', cat: 'JEANS', codes: ['P3'], fn: shape.flat },
  ].concat(extra);
  const monthly = new Map(); const groups = [];
  items.forEach((it) => { groups.push({ key: it.key, name: it.key, category: it.cat, style_codes: it.codes }); it.codes.forEach((c) => monthly.set(c, mkS((n, m) => it.fn(n, m) / it.codes.length))); });
  if (tweak) tweak(monthly, { all, mkS });
  return { monthly, groups, window, today, all };
}
const run = (w, launch = new Map()) => S.buildSeasonality({ monthlyByStyle: w.monthly, groups: w.groups, launchByStyle: launch, window: w.window, today: w.today });

test('seasonality: complete months exclude the partial window-start month and the month in progress (unless folded)', () => {
  assert.deepEqual(S.completeMonths('2025-10-13', '2026-10-12'), ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
  assert.equal(S.completeMonths('2025-10-13', '2026-10-12', { foldStart: true }).length, 12);
  assert.deepEqual(S.completeMonths('2025-10-01', '2026-10-12').length, 12, 'a window that starts on the 1st keeps that month');
});
test('seasonality: the two halves of the month in progress are folded into one real month (when they cover at least 80% of it)', () => {
  const r = run(world('2026-10-12'));
  assert.equal(r.months.length, 12);
  assert.equal(r.months[0], '2025-10');
  assert.notEqual(r.groups.get('SHORT').evidence.index_by_month.Oct, null, 'October has a real observation, not an interpolation');
});
test('seasonality: Australian seasons come from the DATA -- shorts in season / coming in, hoodies out of season, flat tees year-round', () => {
  const oct = run(world('2026-10-12'));
  assert.equal(oct.available, true);
  assert.ok(['in_season', 'coming_into_season'].includes(oct.groups.get('SHORT').status), JSON.stringify(oct.groups.get('SHORT').evidence));
  assert.equal(oct.groups.get('HOODIE').status, 'out_of_season', JSON.stringify(oct.groups.get('HOODIE').evidence));
  assert.equal(oct.groups.get('TEE').status, 'year_round', 'a flat product stays year-round even though the whole store spiked in November');
  assert.equal(oct.groups.get('SHORT').level, 'family');
  const aug = run(world('2026-08-12'));
  assert.equal(aug.groups.get('HOODIE').status, 'in_season');
  assert.equal(aug.groups.get('SHORT').status, 'out_of_season', 'still winter: the spring ramp has not begun and is not within 4-8 weeks');
  const sep = run(world('2026-09-25'));
  assert.equal(sep.groups.get('SHORT').status, 'coming_into_season', 'late September: the next 4-8 weeks reach the ramp: ' + JSON.stringify(sep.groups.get('SHORT').evidence.horizon_index));
});
test('seasonality: the same product reads differently as the calendar moves (December: shorts in season, hoodies out; July: the reverse)', () => {
  const dec = run(world('2026-12-05'));
  assert.equal(dec.groups.get('SHORT').status, 'in_season');
  assert.equal(dec.groups.get('HOODIE').status, 'out_of_season');
  const jul = run(world('2026-07-10'));
  assert.equal(jul.groups.get('HOODIE').status, 'in_season');
  assert.equal(jul.groups.get('SHORT').status, 'out_of_season');
});
test('seasonality: a store-wide promotion (Black Friday) is cancelled out by comparing with the store-wide level', () => {
  const tee = run(world('2026-10-12')).groups.get('TEE').evidence;
  assert.ok(tee.index_by_month.Nov >= 0.9 && tee.index_by_month.Nov <= 1.15, `tee Nov index ${tee.index_by_month.Nov}`);
  assert.equal(run(world('2026-10-12')).baseline, 'median_product');
});
test('seasonality: the evidence explains itself and is honest about one year of data', () => {
  const e = run(world('2026-10-12')).groups.get('SHORT').evidence;
  assert.match(e.summary, /peaks .*(Dec|Jan|Feb)/);
  assert.match(e.summary, /next 4–8 weeks/);
  assert.equal(e.confidence, 'limited');
  assert.match(e.caveats.join(' '), /one observed cycle/);
  assert.equal(e.years_of_data, 1);
  assert.ok(e.horizon_index >= e.current_index);
});
test('seasonality: months before a launch are NOT weak demand -- a recent launch falls back to its category, clearly labelled', () => {
  const w = world('2026-10-12', { extra: [{ key: 'NEWSHORT', cat: 'SHORTS', codes: ['N1'], fn: () => 80 }], tweak: (monthly, { all, mkS }) => { monthly.set('N1', mkS((n, m) => (m >= '2026-07' ? 80 : 0))); } });
  const r = run(w, new Map([['N1', '2026-07-20']]));
  const ns = r.groups.get('NEWSHORT');
  assert.equal(ns.level, 'category', 'too little history of its own: the SHORTS category pattern is used');
  assert.equal(ns.status, r.categories.get('SHORTS').status);
  assert.match(ns.evidence.summary, /category pattern/);
  assert.ok(ns.evidence.own_reason);
});
test('seasonality: a product with too little sales is insufficient -- never silently assigned a season', () => {
  const w = world('2026-10-12', { extra: [{ key: 'TINY', cat: 'GADGETS', codes: ['X1'], fn: () => 0 }], tweak: (monthly, { mkS }) => { monthly.set('X1', mkS((n, m) => (m === '2026-03' ? 5 : 0))); } });
  const r = run(w);
  assert.equal(r.groups.get('TINY').status, 'insufficient_data');
  assert.ok(r.groups.get('TINY').evidence.reason);
});
test('seasonality: a month with almost no sales between two normal months is a possible STOCKOUT, not a trough', () => {
  const w = world('2026-10-12', { tweak: (monthly, { mkS }) => { monthly.set('T1', mkS((n, m) => (m === '2026-02' ? 0 : 50))); } });
  const r = run(w);
  const e = r.groups.get('TEE').evidence;
  assert.equal(r.groups.get('TEE').status, 'year_round', JSON.stringify(e));
  assert.match(e.caveats.join(' '), /Feb.*possible stockout/);
  assert.equal(e.index_by_month.Feb === null || e.index_by_month.Feb > 0.5, true, 'the zero month is left out, not read as 0');
});
test('seasonality: a one-off spike is capped and cannot create a season', () => {
  const w = world('2026-05-12', { tweak: (monthly, { mkS }) => { monthly.set('T1', mkS((n, m) => (m === '2026-02' ? 700 : 50))); } });
  const r = run(w);
  assert.match(r.groups.get('TEE').evidence.caveats.join(' '), /Feb was a one-off spike and was capped/);
  assert.notEqual(r.groups.get('TEE').status, 'in_season');
});
test('seasonality: unavailable (not "insufficient") when the history has not loaded or is too short', () => {
  const w = world('2026-10-12');
  assert.equal(S.buildSeasonality({ monthlyByStyle: new Map(), groups: w.groups, window: w.window, today: '2026-10-12' }).available, false);
  const short = S.buildSeasonality({ monthlyByStyle: w.monthly, groups: w.groups, window: { from: '2026-06-20', to: '2026-10-12' }, today: '2026-10-12' });
  assert.equal(short.available, false);
  assert.match(short.reason, /complete months/);
});
test('seasonality: with too few products for a median the store total is the baseline, and it still works', () => {
  const w = world('2026-10-12');
  const few = { ...w, groups: w.groups.slice(0, 3) };
  const r = run(few);
  assert.equal(r.baseline, 'store_total');
  assert.equal(r.available, true);
});
test('seasonality: no network, no database, no clock inside the module (dates are passed in)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'lib', 'seasonality.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /require\(|fetch\(|https?\.|Date\.now|new Date\(\)/);
});

// ── combined priority ──
const sales = { available: true, seller_class: 'strong', trend: 'up' };
const season = (status) => ({ status, evidence: { summary: 'peaks Nov–Jan; now 0.9×, next 4–8 weeks 1.4×', reason: 'x' } });
const base0 = { stock: { known: true, units: 320, on_order: 0 }, highStockMin: 100, seasonal: season('coming_into_season'), coverage: { known: true, active_ads: 2, min: 5 }, sales, overrides: [], today: '2026-10-12' };
const lvl = (o) => P.assess({ ...base0, ...o });
test('priority: HIGH = strong stock + coming into season + strong rising sales + fewer than 5 active ads, with reasons in plain language', () => {
  const a = lvl({});
  assert.equal(a.level, 'High');
  assert.match(a.reasons.join('\n'), /320 units available — strong stock/);
  assert.match(a.reasons.join('\n'), /Coming into season/);
  assert.match(a.reasons.join('\n'), /2 confirmed active Meta ads — below the minimum of 5, and no awaiting-review ad could close the gap. Needs creative/);
  assert.match(a.reasons.join('\n'), /Selling strongly and rising/);
  assert.equal(a.coverage.needs_creative, true);
});
test('priority: MEDIUM = adequate stock, moderate demand, coverage below target', () => {
  const a = lvl({ stock: { known: true, units: 60 }, seasonal: season('shoulder'), sales: { available: true, seller_class: 'neutral', trend: 'flat' }, coverage: { known: true, active_ads: 4, min: 5 } });
  assert.equal(a.level, 'Medium', JSON.stringify(a.factors));
});
test('priority: LOW = out of season, weak demand, low stock', () => {
  const a = lvl({ stock: { known: true, units: 10 }, seasonal: season('out_of_season'), sales: { available: true, seller_class: 'weak', trend: 'down' }, coverage: { known: true, active_ads: 1, min: 5 } });
  assert.equal(a.level, 'Low');
  assert.match(a.reasons.join('\n'), /below the 30-unit minimum/);
});
test('priority: out of stock is never an immediate shoot -- Low whatever else is true', () => {
  const a = lvl({ stock: { known: true, units: 0, on_order: 0 } });
  assert.equal(a.level, 'Low');
  assert.match(a.reasons.join('\n'), /Out of stock: not an immediate shoot/);
});
test('priority: an out-of-stock product with a confirmed restock on order is NOT held back (exception, explained)', () => {
  const a = lvl({ stock: { known: true, units: 0, on_order: 400 } });
  assert.ok(['Medium', 'High'].includes(a.level), a.level);
  assert.equal(a.exceptions[0].kind, 'confirmed_restock');
  assert.match(a.reasons.join('\n'), /Exception — Confirmed restock: 400 units are on order/);
  assert.equal(lvl({ stock: { known: true, units: 0, on_order: 5 } }).level, 'Low', 'a handful on order is not a confirmed restock');
});
test('priority: out of season is NOT excluded when sales are strong (current strength can justify creative)', () => {
  const a = lvl({ seasonal: season('out_of_season') });
  assert.notEqual(a.level, 'Low', 'strong stock + strong sales + needs creative still counts');
  assert.ok(a.factors.find((f) => f.key === 'season').points < 0, 'but the season weighs against it');
});
test('priority: coverage boundary -- 4 active ads needs creative, 5 meets the minimum (and 0 / none)', () => {
  assert.equal(P.coverageBand({ known: true, active_ads: 4, min: 5 }).needs_creative, true);
  assert.equal(P.coverageBand({ known: true, active_ads: 5, min: 5 }).needs_creative, false);
  assert.equal(P.coverageBand({ known: true, active_ads: 0, min: 5 }).band, 'zero');
  assert.equal(P.coverageBand({ known: true, active_ads: 2, min: 3 }).needs_creative, true, 'the threshold is the configured minimum, not a constant');
  assert.equal(P.coverageBand({ known: true, active_ads: 3, min: 3 }).needs_creative, false);
  assert.equal(P.coverageBand({ known: false }).band, 'unknown');
});
test('priority: meeting the minimum coverage means High is held at Medium (unless the engine already flagged it)', () => {
  const a = lvl({ coverage: { known: true, active_ads: 6, min: 5 } });
  assert.equal(a.level, 'Medium');
  assert.match(a.reasons.join('\n'), /already has the minimum creative coverage/);
  assert.equal(lvl({ coverage: { known: true, active_ads: 6, min: 5 }, existing: { priority: 'High' } }).level, 'High');
});
test('priority: Needs Creative is not Shoot Immediately -- a product with 2 active ads that is out of season with weak sales and low stock stays Low', () => {
  const a = lvl({ stock: { known: true, units: 12 }, seasonal: season('out_of_season'), sales: { available: true, seller_class: 'weak' }, coverage: { known: true, active_ads: 2, min: 5 } });
  assert.equal(a.coverage.needs_creative, true);
  assert.equal(a.level, 'Low');
});
test('priority: MISSING data is never invented -- each missing factor contributes nothing and says so', () => {
  const a = lvl({ seasonal: { status: 'unavailable', reason: 'Seasonal data has not loaded' }, coverage: { known: false }, stock: { known: false }, sales: null });
  assert.deepEqual(a.missing.sort(), ['coverage', 'sales', 'season', 'stock']);
  assert.equal(a.score_delta, 0);
  assert.match(a.reasons.join('\n'), /Seasonal data has not loaded, so season is not weighed/);
  assert.match(a.reasons.join('\n'), /Active Meta ad counts are not available/);
  assert.equal(a.level, 'Low');
  const ins = lvl({ seasonal: { status: 'insufficient_data', evidence: { reason: '4 months on sale (needs 9)', summary: '' } } });
  assert.match(ins.reasons.join('\n'), /Not enough sales history to judge seasonality \(4 months on sale/);
  assert.ok(ins.missing.includes('season'));
});
test('priority: overrides -- an upcoming drop / major promotion / strategic launch / manual priority lift the level and are explained; a manual Low lowers it; expired ones are ignored', () => {
  const weak = { stock: { known: true, units: 12 }, seasonal: season('out_of_season'), sales: { available: true, seller_class: 'weak' }, coverage: { known: true, active_ads: 3, min: 5 } };
  assert.equal(lvl(weak).level, 'Low');
  const promo = lvl({ ...weak, overrides: [{ kind: 'major_promotion', note: 'Black Friday hero' }] });
  assert.equal(promo.level, 'High');
  assert.match(promo.reasons.join('\n'), /Exception — Major promotion: Black Friday hero/);
  assert.equal(lvl({ ...weak, overrides: [{ kind: 'upcoming_drop' }] }).level, 'Medium');
  assert.equal(lvl({ ...weak, overrides: [{ kind: 'manual_high', note: 'founder request' }] }).level, 'High');
  assert.equal(lvl({ ...weak, overrides: [{ kind: 'major_promotion', until: '2026-10-01' }] }).level, 'Low', 'expired on 1 Oct');
  assert.equal(lvl({ ...weak, overrides: [{ kind: 'major_promotion', until: '2026-10-12' }] }).level, 'High', 'still valid on its last day');
  assert.equal(lvl({ overrides: [{ kind: 'manual_low', note: 'on hold' }] }).level, 'Low');
  assert.equal(lvl({ overrides: [{ kind: 'nonsense' }] }).level, 'High', 'an unknown kind is ignored');
});
test('priority: stock bands use the SAME units as High Stocks (gate 30; high = planning high_stock_min_soh)', () => {
  assert.equal(P.stockBand({ known: true, units: 0 }).band, 'out');
  assert.equal(P.stockBand({ known: true, units: 29 }).band, 'low');
  assert.equal(P.stockBand({ known: true, units: 30 }, { highMin: 100 }).band, 'ok');
  assert.equal(P.stockBand({ known: true, units: 100 }, { highMin: 100 }).band, 'high');
  assert.equal(P.stockBand({ known: false }).band, 'unknown');
  assert.equal(cfg.STOCK_GATE_UNITS, require('../src/lib/coreCreativePlanConfig').STOCK.min_sellable_units, 'the gate is the Core plan\'s own');
});
test('priority: no network, no database, no clock inside the module', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'lib', 'creativePriority.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /fetch\(|https?\.|Date\.now|new Date\(\)|pool\.query/);
});
