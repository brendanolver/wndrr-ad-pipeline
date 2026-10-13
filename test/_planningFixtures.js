// Shared fixtures for the Planning engine tests: every input is a fixture (no database, no network, no live data); the dates are fixed so results are reproducible.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const season = require('../src/lib/seasonRelevance');
const cfgLib = require('../src/lib/creativePlanningConfig');
const TODAY = '2026-10-12';
const CFG = cfgLib.resolve({}).config;
const launched = { status: 'launched', eligible: true, needs_check: false, detail: 'ApparelMagic launch date 2026-03-01 has passed.' };
const day = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
// a creative verdict as productAdPerformance + creativeRecency see it
const cr = (key, state, o = {}) => ({ key, state, created: day(o.age === undefined ? 120 : o.age), severity: o.severity || null, spend: o.spend === undefined ? 400 : o.spend, purchases: o.purchases === undefined ? 8 : o.purchases, cpa: o.cpa || null, concept: o.concept || null, ad_count: 1, ...o });
const seasonOf = (name, category = null, extra = {}) => season.assess({ category, name, month: 10, ...extra });
const inSeason = seasonOf('Box Fit Tee', 'TEES');
const salesOf = (u30, extra = {}) => ({ available: true, units7: Math.round(u30 / 4.3), units14: Math.round(u30 / 2.15), units30: u30, units365: u30 * 10, initial28: null, recent28: null, age_days: 300, ...extra });
const base = (o = {}) => ({
  key: 'W26AA001', name: 'Test Box Fit Tee', category: 'TEES', codes: ['W26AA001'], style_codes: ['W26AA001BLK'], is_core: true, launch: launched, launch_age_days: null,
  stock: { known: true, units: 300, on_order: 0 }, sales: salesOf(80), tier: null, tierState: 'ok', season: inSeason,
  coverage: { known: true, active_ads: 0, possible: 0, uncertain: false, min: 5 }, creatives: [], pipeline: { in_flight: 0, by_stage: {}, uploaded: [], this_week: 0 }, history: { winners: [] },
  data_quality: { sales_complete: true, discrepancy: null }, ...o,
});
module.exports = { TODAY, CFG, launched, day, cr, seasonOf, inSeason, salesOf, base };
