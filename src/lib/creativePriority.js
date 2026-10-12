// Creative priority: ONE explainable assessment that combines the four things Planning should weigh --
//   1. stock availability        (the same ApparelMagic sellable units as the High Stocks page)
//   2. seasonal demand           (data-driven; see lib/seasonality.js)
//   3. active Meta ad coverage   (distinct ACTIVE ads per product vs the minimum, default 5; see lib/activeAdCoverage.js)
//   4. current sales performance (the seller class the Core plan already computes)
// plus the exceptions that may override it (an upcoming drop, a confirmed restock, a major promotion, a strategic launch, a manual priority).
//
// It does NOT replace the existing recommendation engine: it annotates its cards (and the High Stock list) with a level, a score adjustment and a
// plain-language list of reasons. Pure: no database, no network, no dates read from the clock. A factor whose data is missing contributes nothing
// and says so; nothing is ever guessed to fill a gap.
const cfg = require('./creativePriorityConfig');

const LEVELS = ['Low', 'Medium', 'High'];
const rank = (l) => LEVELS.indexOf(l);
const num = (v) => Number(v) || 0;
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
const fmt = (n) => Number(n).toLocaleString('en-AU');

const SEASON_LABEL = {
  in_season: 'In season', coming_into_season: 'Coming into season', out_of_season: 'Out of season', year_round: 'Year-round', shoulder: 'Shoulder season',
  insufficient_data: 'Seasonality: insufficient data', unavailable: 'Seasonal data unavailable',
};

// stock: { known, units } -> band
function stockBand(stock, { highMin = Infinity, gate = cfg.STOCK_GATE_UNITS } = {}) {
  if (!stock || !stock.known) return { band: 'unknown', units: null };
  const u = Math.max(0, Math.round(num(stock.units)));
  if (u === 0) return { band: 'out', units: 0 };
  if (u < gate) return { band: 'low', units: u };
  if (u >= highMin) return { band: 'high', units: u };
  return { band: 'ok', units: u };
}

// coverage: { known, active_ads, min } -> { band, needs_creative }
function coverageBand(cov) {
  if (!cov || !cov.known) return { band: 'unknown', needs_creative: false };
  const n = Math.max(0, Math.round(num(cov.active_ads))); const min = Math.max(1, Math.round(num(cov.min) || cfg.MIN_ACTIVE_ADS_DEFAULT));
  if (n >= min) return { band: 'ok', needs_creative: false, n, min };
  return { band: n === 0 ? 'zero' : n <= 2 ? 'one_two' : 'three_four', needs_creative: true, n, min };
}

// sales: { available, seller_class: 'strong'|'weak'|'neutral', trend: 'up'|'down'|'flat'|null }
function salesBand(sales) {
  if (!sales || !sales.available) return 'unknown';
  return ['strong', 'weak', 'neutral'].includes(sales.seller_class) ? sales.seller_class : 'neutral';
}

// An override applies when it has not expired. `today` is 'YYYY-MM-DD'.
const activeOverrides = (list, today) => (list || []).filter((o) => o && cfg.OVERRIDE_KINDS[o.kind] && (!o.until || !today || String(o.until) >= today));

// MAIN: input
//   stock       { known, units, on_order? }
//   highStockMin  number (planning_settings.high_stock_min_soh)
//   seasonal    assessment from seasonality.js ({ status, evidence }) | { status: 'unavailable', reason } | null
//   coverage    { known, active_ads, min }
//   sales       { available, seller_class, trend }
//   overrides   [{ kind, note, until }]
//   today       'YYYY-MM-DD'
//   existing    the engine's own card for this product, if any ({ priority, type })
function assess({ stock, highStockMin, seasonal, coverage, sales, overrides, today, existing } = {}) {
  const P = cfg.POINTS;
  const sb = stockBand(stock, { highMin: highStockMin > 0 ? highStockMin : Infinity });
  const cb = coverageBand(coverage);
  const slb = salesBand(sales);
  const seasonKey = seasonal && seasonal.status ? seasonal.status : 'unavailable';
  const factors = []; const missing = [];
  let score = 0;
  const add = (key, label, points, text) => { score += points; factors.push({ key, label, points, effect: points > 0 ? '+' : points < 0 ? '−' : '·', text }); };

  // 1. stock
  if (sb.band === 'unknown') { add('stock', 'Stock', P.stock.unknown, 'Stock is not available, so it is not weighed.'); missing.push('stock'); }
  else if (sb.band === 'out') add('stock', 'Stock', P.stock.out, 'Out of stock.');
  else if (sb.band === 'low') add('stock', 'Stock', P.stock.low, `${fmt(sb.units)} units available — below the ${cfg.STOCK_GATE_UNITS}-unit minimum.`);
  else if (sb.band === 'high') add('stock', 'Stock', P.stock.high, `${fmt(sb.units)} units available — strong stock.`);
  else add('stock', 'Stock', P.stock.ok, `${fmt(sb.units)} units available.`);

  // 2. season
  const ev = (seasonal && seasonal.evidence) || null;
  const seasonText = (() => {
    if (seasonKey === 'unavailable') return `${(seasonal && seasonal.reason) || 'Seasonal data has not loaded'}, so season is not weighed.`;
    if (seasonKey === 'insufficient_data') return `Not enough sales history to judge seasonality${ev && ev.reason ? ` (${ev.reason})` : ''}; season is not weighed.`;
    return `${SEASON_LABEL[seasonKey]}${ev ? ` — ${ev.summary}` : ''}`;
  })();
  add('season', 'Season', P.season[seasonKey] === undefined ? 0 : P.season[seasonKey], seasonText);
  if (seasonKey === 'unavailable' || seasonKey === 'insufficient_data') missing.push('season');

  // 3. coverage
  if (cb.band === 'unknown') { add('coverage', 'Creative coverage', P.coverage.unknown, 'Active Meta ad counts are not available, so coverage is not weighed.'); missing.push('coverage'); }
  else if (cb.needs_creative) add('coverage', 'Creative coverage', P.coverage[cb.band], `${plural(cb.n, 'active Meta ad')} — below the minimum of ${cb.min}. Needs creative.`);
  else add('coverage', 'Creative coverage', P.coverage.ok, `${plural(cb.n, 'active Meta ad')} — meets the minimum of ${cb.min}.`);

  // 4. sales
  if (slb === 'unknown') { add('sales', 'Sales', P.sales.unknown, 'Sales data is not available, so it is not weighed.'); missing.push('sales'); }
  else {
    const rising = sales.trend === 'up';
    const pts = (P.sales[slb] || 0) + (slb !== 'weak' && rising ? P.sales.rising_bonus : 0);
    add('sales', 'Sales', pts, slb === 'strong' ? `Selling strongly${rising ? ' and rising' : ''}.` : slb === 'weak' ? 'Selling slowly.' : `Selling steadily${rising ? ' and rising' : ''}.`);
  }

  // level from the points, then the hard rules
  let level = score >= cfg.LEVEL.high_min ? 'High' : score >= cfg.LEVEL.medium_min ? 'Medium' : 'Low';
  const caps = [];
  // High needs a reason to make creative: it needs creative (below the minimum), or the existing engine already flagged it
  if (level === 'High' && !cb.needs_creative && !(existing && ['Critical', 'High'].includes(existing.priority))) { level = 'Medium'; caps.push('Held at Medium: it already has the minimum creative coverage.'); }
  if (sb.band === 'out') { level = 'Low'; caps.push('Out of stock: not an immediate shoot.'); }
  else if (sb.band === 'low' && rank(level) > rank('Low')) { level = 'Low'; caps.push('Low stock: generally a lower shoot priority.'); }
  if (seasonKey === 'out_of_season' && slb === 'weak') { level = 'Low'; caps.push('Out of season with weak sales.'); }

  // exceptions: they may lift (or, for a manual Low, lower) the level, and say why
  const ov = activeOverrides(overrides, today);
  const exceptions = [];
  const onOrder = stock && stock.known ? Math.round(num(stock.on_order)) : 0;
  const restock = sb.band === 'out' || sb.band === 'low' ? onOrder >= cfg.RESTOCK_MIN_ON_ORDER_UNITS : false;
  if (restock) exceptions.push({ kind: 'confirmed_restock', label: cfg.OVERRIDE_KINDS.confirmed_restock.label, note: `${fmt(onOrder)} units are on order (open purchase orders).`, source: 'on_order' });
  ov.forEach((o) => exceptions.push({ kind: o.kind, label: cfg.OVERRIDE_KINDS[o.kind].label, note: o.note || null, until: o.until || null, source: 'manual' }));
  let lowered = null;
  exceptions.forEach((e) => {
    const k = cfg.OVERRIDE_KINDS[e.kind];
    if (k.min_level && rank(level) < rank(k.min_level)) { level = k.min_level; }
    if (k.max_level && rank(level) > rank(k.max_level)) { level = k.max_level; lowered = e; }
  });
  if (exceptions.length && !lowered) caps.length = 0; // a business exception outranks the caps above
  return {
    version: cfg.VERSION, level, score_delta: score, factors, missing, caps, exceptions,
    stock: { band: sb.band, units: sb.units, on_order: stock && stock.known ? onOrder : null },
    season: { status: seasonKey, label: SEASON_LABEL[seasonKey] || seasonKey },
    coverage: cb.band === 'unknown' ? { known: false, min: coverage && coverage.min ? coverage.min : cfg.MIN_ACTIVE_ADS_DEFAULT } : { known: true, active_ads: cb.n, min: cb.min, needs_creative: cb.needs_creative },
    reasons: [
      ...factors.map((f) => f.text),
      ...caps,
      ...exceptions.map((e) => `Exception — ${e.label}${e.note ? `: ${e.note}` : ''}`),
    ],
  };
}

// Map a level to a card score offset on the engine's existing scale (card.score = PRIORITY_BASE + strength): the points move a card, and a
// level adds a small tie-break so a High never sorts below a Low of the same base.
const scoreAdjust = (a) => Math.max(-60, Math.min(60, a.score_delta + ({ High: 12, Medium: 0, Low: -12 }[a.level] || 0)));

module.exports = { LEVELS, SEASON_LABEL, stockBand, coverageBand, salesBand, assess, scoreAdjust, activeOverrides };
