// Creative OPPORTUNITIES: which products genuinely need new creative THIS WEEK, and why. One engine behind both Core and High Stocks (Batch 14); the same
// product that qualifies for both appears ONCE (see merge in the loader).
//
// PURPOSE: every item in the actionable list is something the team can act on immediately, with the reason stated from data. Anything that is NOT an action
// still has a status that says why (testing / in production / already covered / not enough data / out of season / low stock / not selling), so nothing is
// silently dropped and nothing is padded in to reach a number.
//
// GATES, in order (the first that applies decides a non-action status):
//   1. launched          ApparelMagic mid_code (lib/launchStatus.js). Not launched / not known -> never an opportunity (reported elsewhere).
//   2. stock             below opp_min_stock_units sellable units -> low_stock (nothing to sell)
//   3. season            lib/seasonRelevance.js: out of season (unless selling strongly now) -> out_of_season
//   4. demand            (Core) fewer than opp_min_recent_units sold in the last 30 days -> weak_demand. Low sell-through is NOT taken to mean "more creative is needed".
//   5. in production     concepts for this product already planned / filming / editing / approved and not yet uploaded -> in_production (no further ask)
//   6. creative          lib/productAdPerformance.js verdicts (approved benchmarks only) read through lib/creativeRecency.js:
//        enough performing creatives                                -> covered
//        new creative still inside its test period (Meta or WNDRR's own upload record) -> testing (re-assessed after the test period)
//        Meta data unavailable, or awaiting-review ads suggested for this product could close the gap -> insufficient_data (NEVER a shoot on missing data)
//        otherwise a CONFIRMED gap: no creative / over the approved CPA / fatigue / stale -> act
// A "thin" shortfall (some performing creative, fewer than wanted, nothing weak) only becomes an action when demand is strong.
// High Stocks adds the REVIVAL gates (tier Platinum / Rocket from Demand Planning's classification, momentum lost against the product's own first 28 days,
// enough stock cover) and lists other explanations for a sales decline instead of blaming creative.
// Pure: no database, no network, no clock (today is passed in).
const recency = require('./creativeRecency');

const num = (v) => Number(v) || 0;
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
const money = (v) => `$${Math.round(num(v)).toLocaleString('en-AU')}`;
const units = (v) => Math.round(num(v)).toLocaleString('en-AU');

const STATUS_LABEL = {
  act: 'Needs creative now', testing: 'New creative testing', in_production: 'In production', covered: 'Creative is working', insufficient_data: 'Not enough data',
  out_of_season: 'Out of season', low_stock: 'Low stock', weak_demand: 'Not selling', not_launched: 'Not launched', launch_unknown: 'Launch not confirmed',
  no_proven_demand: 'No proven demand', too_new: 'Too new to compare', momentum_ok: 'Still selling well', unavailable: 'Data unavailable',
};

// percentile bands over the candidates being compared: strong / steady / weak (+ the units behind them). Percentiles come from settings.
function salesBands(products, cfg) {
  const pool = products.filter((p) => p.sales && p.sales.available && p.launch && p.launch.eligible && num(p.stock && p.stock.units) >= cfg.opp_min_stock_units);
  const vals = pool.map((p) => num(p.sales.units30)).sort((a, b) => a - b);
  const at = (pct) => (vals.length ? vals[Math.min(vals.length - 1, Math.max(0, Math.ceil((pct / 100) * vals.length) - 1))] : null);
  const hi = at(cfg.strong_sales_percentile); const lo = at(cfg.weak_sales_percentile);
  return { enough: vals.length >= 5, strong_at: hi, weak_at: lo, n: vals.length };
}
function bandOf(p, bands, cfg) {
  if (!p.sales || !p.sales.available) return 'unknown';
  const u = num(p.sales.units30);
  if (u < cfg.opp_min_recent_units) return 'weak';
  if (!bands.enough) return u >= cfg.opp_min_recent_units * 3 ? 'strong' : 'steady';
  if (u >= bands.strong_at) return 'strong';
  if (u <= bands.weak_at) return 'weak';
  return 'steady';
}

// weeks of stock at the current pace (30-day units); null when nothing is selling
const coverWeeks = (stock, u30) => (num(u30) > 0 ? Math.round((num(stock) / (num(u30) / (30 / 7))) * 10) / 10 : null);

// the creative gap, from the recency summary: { type, text, severity } | null when no CONFIRMED gap exists
function gapOf(sum, p, cfg) {
  const min = cfg.min_performing_creatives;
  const parts = [];
  if (sum.total === 0) return { type: 'confirmed_gap', severity: 'high', text: 'No unique creative is running for this product (confirmed ads only).' };
  const bits = [];
  if (sum.performing) bits.push(`${sum.performing} performing`);
  if (sum.declining) bits.push(`${sum.declining} declining against ${sum.declining === 1 ? 'its' : 'their'} own results`);
  if (sum.weak) bits.push(`${sum.weak} over the approved CPA limit${sum.clear_weak ? ` (${sum.clear_weak} clearly)` : ''}`);
  if (sum.stale && !sum.weak) bits.push(`${sum.stale} old with little delivery`);
  if (sum.testing) bits.push(`${sum.testing} still testing`);
  if (sum.unrated) bits.push(`${sum.unrated} with no approved benchmark`);
  if (sum.unjudged) bits.push(`${sum.unjudged} with too little data to judge`);
  const roll = `${plural(sum.total, 'unique creative')}: ${bits.join(', ')}.`;
  if (sum.declining > 0 && sum.performing < min) return { type: 'fatigue', severity: 'high', text: `Creative fatigue: ${roll}` };
  if (sum.weak > 0 && sum.performing < min) return { type: 'confirmed_underperformance', severity: sum.clear_weak ? 'high' : 'medium', text: `Confirmed underperformance: ${roll}` };
  if (sum.stale > 0 && sum.performing === 0) {
    const age = sum.newest_age_days;
    return { type: 'stale', severity: 'medium', text: `Creative is old: ${roll}${age !== null ? ` The newest was launched ${plural(age, 'day')} ago.` : ''}` };
  }
  if (sum.performing > 0 && sum.performing < min && sum.weak === 0 && sum.declining === 0) return { type: 'thin', severity: 'low', text: `Thin coverage: ${plural(sum.performing, 'creative')} performing, ${min} wanted. ${roll}` };
  return null; // only unrated / unjudged creatives: nothing confirmed
}

// a creative direction ONLY where the product's own data supports one
function directionOf(p, sum) {
  const winners = ((p.history && p.history.winners) || []).filter((w) => w.concept && !w.running_now);
  if (winners.length) {
    const w = winners[0];
    return { basis: 'product_history', text: `Re-make or refresh the "${w.concept}" concept${w.media ? ` (${String(w.media).toLowerCase()})` : ''}: it previously ran at ${w.cpa !== null && w.cpa !== undefined ? `${money(w.cpa)} CPA ` : ''}on ${money(w.spend)} spend and is no longer running.` };
  }
  const perf = (sum.list || []).find((c) => (c.phase === 'performing' || c.phase === 'recent_performing') && c.concept);
  if (perf) return { basis: 'current_performer', text: `Build on the "${perf.concept}" concept: it is performing for this product${perf.cpa ? ` (${money(perf.cpa)} CPA)` : ''}.` };
  const weak = (sum.list || []).filter((c) => (c.phase === 'weak' || c.phase === 'recent_weak') && c.severity !== 'marginal' && c.concept);
  if (weak.length) return { basis: 'avoid', text: `Try something other than the "${weak[0].concept}" concept: it is clearly over the approved CPA limit for this product.` };
  return null;
}

// the 6 facts the card quotes, kept together so the UI never has to compute anything
function factsOf(p, sum, cfg, extra = {}) {
  const u30 = p.sales && p.sales.available ? Math.round(num(p.sales.units30)) : null;
  return {
    stock_units: p.stock && p.stock.known ? Math.round(num(p.stock.units)) : null, on_order: p.stock ? Math.round(num(p.stock.on_order)) : null,
    cover_weeks: p.stock && p.stock.known && u30 !== null ? coverWeeks(p.stock.units, u30) : null,
    units7: p.sales && p.sales.available ? Math.round(num(p.sales.units7)) : null, units30: u30,
    initial28: p.sales && p.sales.initial28 !== undefined ? p.sales.initial28 : null, recent28: p.sales && p.sales.recent28 !== undefined ? p.sales.recent28 : null,
    sales_band: p.salesBand || 'unknown', tier: p.tier ? p.tier.tier : null, tier_index: p.tier ? p.tier.index : null,
    season: p.season ? p.season.label : null, season_source: p.season ? p.season.source : null,
    active_ads: p.coverage && p.coverage.known ? p.coverage.active_ads : null, unique_creatives: sum.total, performing: sum.performing, weak: sum.weak, declining: sum.declining, testing: sum.testing,
    unrated: sum.unrated, unjudged: sum.unjudged, newest_creative_days: sum.newest_age_days, newest_creative_source: sum.newest_source, testing_until: sum.testing_until,
    ...extra,
  };
}

function priorityOf(score) { return score >= 65 ? 'High' : score >= 45 ? 'Medium' : 'Low'; }

// MAIN. mode: 'core' | 'revival'.  → opportunity (always returned; check .status / .actionable)
function evaluate(p, cfg, today, mode = 'core') {
  const sum = recency.summarize(p.creatives || [], today, cfg, { uploads: (p.pipeline && p.pipeline.uploaded) || [] });
  const base = {
    key: p.key, name: p.name, category: p.category || null, image_url: p.image_url || null, codes: p.codes || [], style_codes: p.style_codes || [], is_core: !!p.is_core,
    kind: mode === 'revival' ? 'high_stock' : 'core', recency: { by_phase: sum.by, newest_age_days: sum.newest_age_days, newest_source: sum.newest_source, testing_until: sum.testing_until },
    pipeline: p.pipeline ? { planned: p.pipeline.in_flight || 0, by_stage: p.pipeline.by_stage || {}, uploaded_recent: (p.pipeline.uploaded || []).length, this_week: p.pipeline.this_week || 0 } : null,
  };
  const done = (status, reason, extra = {}) => ({
    ...base, status, status_label: STATUS_LABEL[status] || status, actionable: status === 'act', priority: null, score: 0, headline: reason, why: [], reason,
    facts: factsOf(p, sum, cfg, extra.facts || {}), gap: null, direction: null, ...extra, facts: factsOf(p, sum, cfg, extra.facts || {}),
  });

  // 1. launched
  if (!p.launch || !p.launch.eligible) {
    return done(p.launch && p.launch.needs_check ? 'launch_unknown' : 'not_launched', p.launch ? p.launch.detail : 'Launch status is unknown.');
  }
  // 2. stock
  if (!p.stock || !p.stock.known) return done('unavailable', 'Stock has not loaded, so the product cannot be assessed.');
  if (num(p.stock.units) < cfg.opp_min_stock_units) {
    return done('low_stock', `${units(p.stock.units)} sellable units, below the ${units(cfg.opp_min_stock_units)} needed before creative is worth making.${num(p.stock.on_order) > 0 ? ` ${units(p.stock.on_order)} are on order.` : ''}`);
  }
  // 3. season
  if (p.season && !p.season.relevant) return done('out_of_season', `${p.season.label}. ${p.season.reasons[0] || ''}`.trim(), { season: p.season });
  // sales evidence
  if (!p.sales || !p.sales.available) return done('insufficient_data', 'Sales data has not loaded, so demand cannot be judged.');
  const u30 = num(p.sales.units30);

  let revival = null;
  if (mode === 'revival') {
    // tier / history gates
    if (p.tierState !== 'ok') return done('unavailable', 'The Platinum / Rocket classification is unavailable (the Report Pipeline that feeds it is not configured or has not loaded), so proven demand cannot be checked.');
    if (!p.tier || !['platinum', 'rocket'].includes(p.tier.tier)) return done('no_proven_demand', `No proven demand: Demand Planning classifies it as ${p.tier ? p.tier.tier.charAt(0).toUpperCase() + p.tier.tier.slice(1) : 'unclassified'}, not Platinum or Rocket. High stock alone is not a reason for more creative.`);
    const age = p.sales.age_days;
    if (age === null || age === undefined || p.sales.initial28 === null || p.sales.initial28 === undefined) return done('insufficient_data', 'Its first 28 days of sales cannot be read, so launch performance cannot be compared with now.');
    if (age < cfg.revival_min_age_days) return done('too_new', `Selling for only ${plural(age, 'day')}: needs ${cfg.revival_min_age_days} before its first 28 days and latest 28 days can be compared.`);
    const ratio = p.sales.initial28 > 0 ? num(p.sales.recent28) / p.sales.initial28 : null;
    const pct = ratio === null ? null : Math.round(ratio * 100);
    const weeks = coverWeeks(p.stock.units, p.sales.recent28 !== null && p.sales.recent28 !== undefined ? p.sales.recent28 : u30);
    revival = { tier: p.tier.tier, index: p.tier.index, initial28: p.sales.initial28, recent28: num(p.sales.recent28), ratio_pct: pct, weeks, age_days: age };
    if (ratio !== null && ratio * 100 >= cfg.revival_decline_pct) {
      return done('momentum_ok', `${p.tier.tier === 'platinum' ? 'Platinum' : 'Rocket'}: the last 28 days sold ${units(num(p.sales.recent28))} against ${units(p.sales.initial28)} in its first 28 days (${pct}% of launch pace), above the ${cfg.revival_decline_pct}% line, so it has not lost momentum.`, { revival });
    }
    if (weeks !== null && weeks < cfg.revival_min_cover_weeks) {
      return done('low_stock', `${units(p.stock.units)} units is only ${weeks} weeks of stock at the current pace (${cfg.revival_min_cover_weeks} needed to justify a refresh).`, { revival });
    }
  } else if (u30 < cfg.opp_min_recent_units) {
    return done('weak_demand', `Only ${units(u30)} unit${u30 === 1 ? '' : 's'} sold in the last 30 days (a product needs ${cfg.opp_min_recent_units} to count as having demand). Slow sales on their own are not a reason for more creative.`);
  }

  // 5. already in production
  const flight = p.pipeline ? num(p.pipeline.in_flight) : 0;
  if (flight > 0 && sum.performing < cfg.min_performing_creatives) {
    const st = (p.pipeline && p.pipeline.by_stage) || {};
    const stages = [['planned', 'planned'], ['awaiting_production', 'awaiting production'], ['filmed', 'filmed'], ['edited', 'edited'], ['approved', 'approved']].filter(([k]) => st[k]).map(([k, l]) => `${st[k]} ${l}`).join(', ');
    return done('in_production', `${plural(flight, 'concept')} already in the Shoot Plan pipeline (${stages || 'in progress'}). Nothing more is needed until they are uploaded and have data.`, { revival });
  }

  // 6. creative evidence
  if (!p.coverage || !p.coverage.known) return done('insufficient_data', 'Meta ad data is unavailable, so existing creative cannot be judged. No shoot is recommended on missing data.', { revival });
  const gap = gapOf(sum, p, cfg);
  if (sum.performing >= cfg.min_performing_creatives && !(sum.declining >= sum.performing)) {
    return done('covered', `${sum.performing} of ${plural(sum.total, 'unique creative')} are performing against the approved benchmark (${cfg.min_performing_creatives} wanted)${sum.newest_age_days !== null ? `; the newest was launched ${plural(sum.newest_age_days, 'day')} ago` : ''}. No new creative is needed now.`, { revival });
  }
  if (sum.testing > 0 || sum.recent_uploads > 0) {
    const until = sum.testing_until;
    const what = sum.testing > 0 ? `${plural(sum.testing, 'creative')} launched in the last ${cfg.test_period_days} days ${sum.testing === 1 ? 'is' : 'are'} still gathering data` : `${plural(sum.recent_uploads, 'concept')} uploaded in the last ${cfg.test_period_days} days (WNDRR's production record) ${sum.recent_uploads === 1 ? 'is' : 'are'} still gathering data`;
    return done('testing', `${what}. No further creative is recommended until ${until || 'the test period ends'}; it will then be re-assessed.`, { revival });
  }
  if (p.coverage.uncertain && sum.performing < cfg.min_performing_creatives) {
    return done('insufficient_data', `Matching is uncertain: ${plural(p.coverage.possible, 'active Meta ad')} awaiting review ${p.coverage.possible === 1 ? 'is' : 'are'} suggested for this product and could change its creative count. Review them in Ad Matching first; no shoot is recommended on an incomplete count.`, { revival });
  }
  if (!gap) {
    const why = sum.total > 0 && sum.unrated === sum.total ? 'Its creatives have data but no approved benchmark applies to their funnel, so they cannot be called good or bad.' : sum.total > 0 ? 'Its creatives have too little delivery to judge.' : 'There is no creative evidence either way.';
    return done('insufficient_data', `${why} No shoot is recommended on missing data.`, { revival });
  }
  if (gap.type === 'thin' && p.salesBand !== 'strong' && mode !== 'revival') {
    return done('covered', `${gap.text} Demand is ${p.salesBand === 'steady' ? 'steady' : 'not strong'}, so a thin shortfall alone does not justify action this week.`, { revival });
  }

  // ACT: score and explain
  const score = (() => {
    let s = 0; const parts = [];
    const add = (pts, label) => { s += pts; parts.push({ label, points: pts }); };
    if (mode === 'revival') {
      add(p.tier.tier === 'platinum' ? 22 : 16, `${p.tier.tier === 'platinum' ? 'Platinum' : 'Rocket'} classification`);
      const drop = revival.ratio_pct === null ? 0 : Math.max(0, Math.min(25, Math.round((cfg.revival_decline_pct - revival.ratio_pct) / 2) + 8));
      add(drop, 'Momentum lost against launch pace');
    } else {
      add(p.salesBand === 'strong' ? 30 : 15, p.salesBand === 'strong' ? 'Strong current sales' : 'Steady current sales');
      if (p.tier && ['platinum', 'rocket'].includes(p.tier.tier)) add(p.tier.tier === 'platinum' ? 8 : 5, `${p.tier.tier === 'platinum' ? 'Platinum' : 'Rocket'} classification`);
    }
    add({ confirmed_gap: 30, fatigue: 28, confirmed_underperformance: gap.severity === 'high' ? 24 : 14, stale: 18, thin: 10 }[gap.type] || 0, { confirmed_gap: 'No creative running', fatigue: 'Creative fatigue', confirmed_underperformance: 'Confirmed underperformance', stale: 'Old creative', thin: 'Thin coverage' }[gap.type]);
    const w = coverWeeks(p.stock.units, mode === 'revival' ? (revival.recent28 || u30) : u30);
    add(w === null ? 6 : w >= 8 ? 10 : w >= 4 ? 5 : 0, 'Stock cover');
    add(p.season && p.season.state === 'in_season' ? 10 : p.season && p.season.exception ? 5 : p.season && p.season.state === 'shoulder' ? 4 : 0, 'Season');
    if (sum.newest_age_days === null) add(4, 'No new creative on record');
    else if (sum.newest_age_days >= cfg.stale_creative_days) add(6, 'No new creative for a long time');
    else if (sum.newest_age_days >= cfg.recent_creative_days) add(3, 'No recent creative');
    return { score: Math.min(100, s), parts };
  })();
  const dir = directionOf(p, sum);
  const age = sum.newest_age_days;
  const why = [];
  why.push({ k: 'gap', text: gap.text });
  why.push({ k: 'performing', text: `${sum.performing} of the ${cfg.min_performing_creatives} performing creatives wanted are in place.` });
  why.push({ k: 'recent', text: age === null ? 'Last new creative: none found (neither a matched Meta ad nor an upload record).' : `Last new creative: ${plural(age, 'day')} ago (${sum.newest_source === 'production' ? "WNDRR's production record" : 'Meta ad creation date'}). ${age > cfg.test_period_days ? 'It is past its test period, so it has been judged.' : ''}`.trim() });
  if (mode === 'revival') {
    why.push({ k: 'demand', text: `${revival.tier === 'platinum' ? 'Platinum' : 'Rocket'} (index ${revival.index}): ${units(revival.initial28)} units in its first 28 days, ${units(revival.recent28)} in the last 28 (${revival.ratio_pct === null ? 'no baseline' : `${revival.ratio_pct}% of launch pace`}).` });
    why.push({ k: 'stock', text: `${units(p.stock.units)} units left${revival.weeks !== null ? `, about ${revival.weeks} weeks at the current pace` : ' with no current sales pace to measure cover'}.` });
  } else {
    why.push({ k: 'demand', text: `${p.salesBand === 'strong' ? 'Selling strongly' : 'Selling steadily'}: ${units(u30)} units in the last 30 days, ${units(p.stock.units)} in stock${coverWeeks(p.stock.units, u30) !== null ? ` (about ${coverWeeks(p.stock.units, u30)} weeks)` : ''}.` });
  }
  why.push({ k: 'season', text: p.season ? `${p.season.label}.` : 'Season not assessed.' });
  if (dir) why.push({ k: 'direction', text: dir.text });
  const other = [];
  if (mode === 'revival') {
    if (p.season && p.season.state !== 'in_season') other.push(`Season: ${p.season.label.toLowerCase()}, which can lower sales regardless of creative.`);
    if (sum.performing >= 1) other.push(`${plural(sum.performing, 'creative')} is still performing, so creative fatigue does not explain the whole decline.`);
    if (p.coverage.active_ads < (p.coverage.min || 5)) other.push(`Only ${plural(p.coverage.active_ads, 'active ad')} support it, so reach may be limited rather than creative being worn out.`);
    other.push('Price, markdowns, size availability and site changes are not measured here and could also explain the change.');
  }
  const headline = {
    confirmed_gap: `No creative running · ${units(u30)} units in 30 days`,
    fatigue: `Creative fading: ${sum.declining} declining · ${units(u30)} units in 30 days`,
    confirmed_underperformance: `${sum.weak} creative${sum.weak === 1 ? '' : 's'} over the approved CPA limit, ${sum.performing} performing`,
    stale: `Creative is old${age !== null ? ` (newest ${age} days)` : ''} and none is performing`,
    thin: `Only ${sum.performing} of ${cfg.min_performing_creatives} wanted creatives performing`,
  }[gap.type];
  return {
    ...base, status: 'act', status_label: STATUS_LABEL.act, actionable: true, priority: priorityOf(score.score), score: score.score, score_parts: score.parts,
    headline: mode === 'revival' ? `${revival.tier === 'platinum' ? 'Platinum' : 'Rocket'} lost momentum (${revival.ratio_pct === null ? 'n/a' : `${revival.ratio_pct}% of launch pace`}) · ${headline}` : headline,
    why, reason: gap.text, gap, direction: dir, other_explanations: other, revival, facts: factsOf(p, sum, cfg, {}),
    creatives: sum.list.map((c) => ({ key: c.key, phase: c.phase, label: c.label, age_days: c.age_days, concept: c.concept || null, cpa: c.cpa || null, spend: c.spend, ads: c.ad_count })),
  };
}

// run the engine over every candidate; computes sales bands first. kinds: 'core' (default) or 'revival'
function assessAll(products, cfg, today, mode = 'core') {
  const bands = salesBands(products, cfg);
  const out = products.map((p) => {
    const salesBand = bandOf(p, bands, cfg);
    return evaluate({ ...p, salesBand }, cfg, today, mode);
  });
  return { bands, items: out };
}

module.exports = { STATUS_LABEL, salesBands, bandOf, coverWeeks, gapOf, directionOf, evaluate, assessAll, priorityOf };
