// Current DEMAND and STOCK sufficiency for Planning recommendations. Pure: no database, no network, no clock.
//
// DEMAND is judged on absolute units first, then on direction:
//   level  very_weak < opp_min_recent_units <= weak < demand_steady_units <= steady < demand_strong_units <= strong     (units in 30 days)
//   trend  the last 7 days against the weekly pace of the days before them, confirmed by the last 14 days. It needs a change of at least trend_pct AND at least
//          trend_min_weekly_units a week, so 2 -> 1 is noise while 100 -> 70 is a real weakening of a strong product. Never percentage alone.
// A recent launch (on sale for fewer than 30 days) is NOT compared with a full month: its units are divided by the days it has actually been on sale and scaled
// to a 30-day equivalent, flagged as partial, and a launch with fewer than momentum_min_days_live days of sales is "too early" rather than weak.
//
// STOCK establishes whether there is enough inventory to justify creative. It never makes a product MORE urgent for being large:
//   cover = sellable units / the current weekly pace (the higher of the 30-day and 14-day pace, so a product that is speeding up is not flattered)
//   short   cover < stock_min_cover_weeks (the stock would not outlast production and a test), unless a restock on order closes the gap
//   healthy stock_min_cover_weeks .. stock_overstock_weeks          full points
//   slow    stock_overstock_weeks .. stock_excess_weeks             half points: it is a slow mover, stock is not a reason to shoot
//   excess  beyond stock_excess_weeks                               no points; with only weak demand the product is not recommended at all
// Size availability is a WARNING only (and only where ApparelMagic exposes stock by size): a broken size run removes some stock points.
const num = (v) => Number(v) || 0;
const r1 = (x) => Math.round(x * 10) / 10;

function weekly(units, days) { return days > 0 ? num(units) / (days / 7) : 0; }

// s: { available, units7, units14 (null = unknown), units30, days_live (null = established), since_launch (units since the official launch, when known) }
function demandOf(s, cfg) {
  if (!s || !s.available) return { available: false, level: 'unknown', trend: 'unknown', basis: null, eq30: null, weekly: null, pace_weekly: null, evidence: ['Sales data has not loaded.'] };
  const u7 = num(s.units7); const u30 = num(s.units30);
  const u14 = s.units14 === null || s.units14 === undefined ? null : num(s.units14);
  const live = Number.isFinite(Number(s.days_live)) && s.days_live !== null ? Math.max(1, Math.floor(Number(s.days_live))) : null;
  const evidence = [];
  let basis = '30d'; let eq30 = u30; let windowDays = 30; let partial = false;
  if (live !== null && live < 30) {
    if (live < cfg.momentum_min_days_live) {
      return { available: true, level: 'too_early', trend: 'unknown', basis: 'since_launch', partial: true, live_days: live, units7: u7, units30: u30, eq30: null, weekly: null, pace_weekly: null, evidence: [`On sale for only ${live} day${live === 1 ? '' : 's'}: sales are not judged until ${cfg.momentum_min_days_live} days of selling, so a part-week is never compared with a full month.`] };
    }
    basis = 'since_launch'; windowDays = live; partial = true;
    eq30 = (u30 / live) * 30;
    evidence.push(`On sale for ${live} days: ${Math.round(u30)} units since launch is ${r1(u30 / live)} a day, or about ${Math.round(eq30)} in a 30-day equivalent (a partial period is normalised, not compared with a full month).`);
  }
  const weeklyEq = (eq30 * 7) / 30;
  const r14 = u14 === null ? null : u14 / 2;
  const level = eq30 < cfg.opp_min_recent_units ? 'very_weak' : eq30 < cfg.demand_steady_units ? 'weak' : eq30 < cfg.demand_strong_units ? 'steady' : 'strong';

  // trend: the last 7 days against the weekly pace of the rest of the window
  let trend = 'unknown'; let base = null; let base14 = null;
  const restDays = windowDays - 7;
  if (restDays >= 7 && u30 >= cfg.opp_min_recent_units && (basis === '30d' || live >= 10)) {
    base = weekly(u30 - u7, restDays);
    const rest14 = windowDays - 14;
    base14 = u14 !== null && rest14 >= 7 ? weekly(u30 - u14, rest14) : null;
    const pct = cfg.trend_pct / 100; const minW = cfg.trend_min_weekly_units;
    const up7 = u7 >= base * (1 + pct) && u7 - base >= minW;
    const dn7 = u7 <= base * (1 - pct) && base - u7 >= minW;
    const up14 = base14 === null || r14 >= base14 * (1 + pct / 2);
    const dn14 = base14 === null || r14 <= base14 * (1 - pct / 2);
    trend = up7 && up14 ? 'improving' : dn7 && dn14 ? 'weakening' : 'stable';
    evidence.push(`Last 7 days: ${Math.round(u7)} units against about ${r1(base)} a week before (${trend}${base14 === null ? '' : `; last 14 days ${Math.round(u14)} units`}). A change counts only if it is at least ${cfg.trend_pct}% and ${cfg.trend_min_weekly_units} units a week.`);
  } else if (level !== 'very_weak') {
    evidence.push('Not enough days or units to judge direction.');
  }
  const pace = Math.max(weeklyEq, r14 === null ? 0 : r14);
  return { available: true, level, trend, basis, partial, live_days: live, units7: u7, units14: u14, units30: u30, eq30: Math.round(eq30 * 10) / 10, weekly: r1(weeklyEq), pace_weekly: r1(pace), base_weekly: base === null ? null : r1(base), evidence };
}

// stock: { known, units, on_order }, pace: units a week (null/0 = nothing selling), sizes: sizeHealth() result | null
function stockOf(stock, pace, cfg, sizes = null) {
  if (!stock || !stock.known) return { known: false, band: 'unknown', points: 0, cover_weeks: null, notes: ['Stock has not loaded.'] };
  const units = Math.max(0, Math.round(num(stock.units))); const onOrder = Math.max(0, Math.round(num(stock.on_order)));
  const cover = pace > 0 ? r1(units / pace) : null;
  const coverWithOrder = pace > 0 ? r1((units + onOrder) / pace) : null;
  const notes = [];
  let band; let points;
  if (units < cfg.opp_min_stock_units) { band = 'low'; points = 0; notes.push(`${units} sellable units is below the ${cfg.opp_min_stock_units} needed before creative is worth making.`); }
  else if (cover === null) { band = 'no_sales'; points = 4; notes.push('Nothing is selling, so there is no pace to measure cover against.'); }
  else if (cover < cfg.stock_min_cover_weeks) {
    const restocked = onOrder > 0 && coverWithOrder >= cfg.stock_min_cover_weeks;
    band = restocked ? 'short_restock' : 'short'; points = restocked ? 6 : Math.round(10 * (cover / Math.max(cfg.stock_min_cover_weeks, 0.1)));
    notes.push(`${cover} weeks of stock at the current pace${restocked ? `, ${onOrder} more on order (${coverWithOrder} weeks with it)` : ''}: ${restocked ? 'a restock is confirmed' : `less than the ${cfg.stock_min_cover_weeks} needed for creative to pay off`}.`);
  } else if (cover <= cfg.stock_overstock_weeks) { band = 'healthy'; points = 10; notes.push(`${cover} weeks of stock at the current pace: enough to justify creative.`); }
  else if (cover <= cfg.stock_excess_weeks) { band = 'slow'; points = 5; notes.push(`${cover} weeks of stock: more than ${cfg.stock_overstock_weeks}, so it is a slow mover. Plenty of stock is not a reason for more creative.`); }
  else { band = 'excess'; points = 0; notes.push(`${cover} weeks of stock: more than ${cfg.stock_excess_weeks}. Stock this large earns no points: the constraint is demand, not creative.`); }
  let sizeNote = null;
  if (sizes && sizes.available && sizes.level && sizes.level !== 'ok') {
    const cut = sizes.level === 'broken' ? 4 : 2; points = Math.max(0, points - cut);
    sizeNote = sizes.warning; notes.push(`${sizes.warning}.`);
  }
  return { known: true, units, on_order: onOrder, cover_weeks: cover, cover_with_order_weeks: coverWithOrder, band, points, size: sizes && sizes.available ? { level: sizes.level, warning: sizes.warning, available_sizes: sizes.available_sizes, total_sizes: sizes.total_sizes } : null, size_note: sizeNote, notes };
}

module.exports = { demandOf, stockOf, weekly };
