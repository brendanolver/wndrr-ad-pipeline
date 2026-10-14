// Creative OPPORTUNITIES: which products genuinely need new creative THIS WEEK, and why. One engine behind Core, High Stocks and Protect Momentum.
//
// PURPOSE: every item in the actionable list is something the team can act on immediately, with the reason stated from data. Anything that is NOT an action
// still has a status that says why (testing / in production / already covered / not enough data / out of season / low stock / not selling), so nothing is
// silently dropped and nothing is padded in to reach a number.
//
// THREE EVALUATION MODES (a product can be evaluated in several internally; the loader picks ONE primary result, see planningOpportunitiesLoader.js):
//   core       an official Core product (ApparelMagic group AA CORE STYLES): current demand + creative need
//   revival    High Stocks: a Platinum / Rocket product (Demand Planning's classification) that has lost momentum AND still sells enough to be revived
//   momentum   Protect Momentum: a recent launch (official mid_code date within momentum_window_days) selling well with too little effective creative.
//              No decline, no Platinum/Rocket and no 56 days of history are required: its sales are normalised per day on sale.
//
// GATES, in order (the first that applies decides a non-action status):
//   1. launched         ApparelMagic mid_code (lib/launchStatus.js). Not launched / not known -> never an opportunity.
//   2. stock            below opp_min_stock_units sellable units -> low_stock
//   3. sales            not loaded -> insufficient_data (never a guess)
//   4. season           lib/seasonRelevance.js: out of season -> out_of_season, unless current demand is compelling (units AND creative evidence): see seasonException
//   5. demand           core: at least opp_min_recent_units in 30 days. revival: at least revival_min_recent_units, and at least revival_min_pace_pct of its own launch pace.
//                       momentum: at least demand_steady_units (30-day equivalent, normalised for days on sale)
//        revival also: Platinum / Rocket tier, a readable first-28-day baseline, 56+ days of selling (so the first and latest 28 days do not overlap), the last
//                       28 days below revival_decline_pct of the first 28 days, and revival_min_cover_weeks of stock
//   6. stock sufficiency enough weeks of cover for creative to pay off; a LOT of stock with only weak demand is not a reason: see planningDemand.js
//   7. creative         lib/productAdPerformance.js verdicts (approved benchmarks only), lib/creativeEvidence.js (concentration, diversity), read through
//                       lib/creativeRecency.js; concepts already testing or in production count as supply but do not block a strongly selling product
// PRIORITY is a 0-100 score of demand, creative need, stock, season and (per mode) history, with explicit caps (weak demand, incomplete data, disagreeing sales
// sources, an out-of-season exception): High needs strong or steady demand AND complete data. Every component is returned in score_parts.
// Pure: no database, no network, no clock (today is passed in).
const recency = require('./creativeRecency');
const { LIVE_LABEL } = recency;
const { MEDIA_LABEL } = require('./metaNameParsing');
const demandLib = require('./planningDemand');
const evidenceLib = require('./creativeEvidence');

const num = (v) => Number(v) || 0;
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
const money = (v) => `$${Math.round(num(v)).toLocaleString('en-AU')}`;
const units = (v) => Math.round(num(v)).toLocaleString('en-AU');

const STATUS_LABEL = {
  act: 'Needs creative now', testing: 'New creative', in_production: 'In production', covered: 'Enough effective creative', insufficient_data: 'Needs review',
  out_of_season: 'Out of season', low_stock: 'Low stock', weak_demand: 'Not selling enough', not_launched: 'Not launched', launch_unknown: 'Launch not confirmed',
  no_proven_demand: 'No proven demand', too_new: 'Too new to compare', momentum_ok: 'No decline to revive', unavailable: 'Data unavailable', not_recent: 'Not a recent launch',
};
const OPP_LABEL = {
  confirmed_gap: 'Creative gap', creative_gap: 'Creative gap', underperforming: 'Underperforming creative', fatigue: 'Creative fatigue', concentration: 'Concentrated creative', diversity: 'Low concept diversity',
  stale: 'Stale creative', thin: 'Thin creative coverage', revive: 'Revive momentum', protect_momentum: 'Protect momentum',
};

// SCORE: documented in docs/planning-intelligence.md. Points are hardcoded on purpose (they are weights, not thresholds); every cutoff lives in creativePlanningConfig.
const SCORE = {
  demand: { strong: 32, steady: 20, weak: 8, very_weak: 0, improving: 6, weakening: -6, max: 38 },
  need: { confirmed_gap: 28, fatigue: 24, underperforming_clear: 22, underperforming_marginal: 14, concentration: 18, diversity: 12, stale: 14, thin: 8, supply_penalty: -8 },
  season: { in_season: 15, shoulder: 8, neutral: 6, exception: 3, out_of_season: 0 },
  core_tier: { platinum: 6, rocket: 4 }, revival_tier: { platinum: 10, rocket: 7 }, recoverability: [[35, 8], [20, 6], [10, 3], [0, 0]],
  momentum_launch: { strong: 8, steady: 4 }, recency: { none: 3, stale: 5, aged: 2 },
};

// ACCOUNT-level uncertainty from unidentified Meta ads (recently delivering ads whose name / campaign / creative lookup failed). Nothing identifies WHICH product such an ad
// belongs to, so it is weighed by the share of recent non-DPA spend it carries (configurable lines, see creativePlanningConfig), not treated as a blanket unknown:
//   none    nothing unidentified
//   low     below unresolved_spend_note_pct: a data-quality warning only
//   medium  from the note line: a "no creative running" finding is held at Medium
//   high    from unresolved_spend_block_pct (or share unknown): a "no creative running" finding becomes "not enough data"; findings resting on existing creative problems are held at Medium
function unresolvedAssessment(cov, cfg) {
  const n = num(cov && cov.unresolved);
  if (!n) return { n: 0, level: 'none', share: 0 };
  const share = cov.unresolved_share_pct === undefined || cov.unresolved_share_pct === null ? null : num(cov.unresolved_share_pct);
  const level = share === null || share >= cfg.unresolved_spend_block_pct ? 'high' : share >= cfg.unresolved_spend_note_pct ? 'medium' : 'low';
  return { n, level, share };
}
const unresolvedText = (u) => `${plural(u.n, 'recently delivering Meta ad')} could not be identified${u.share === null ? '' : `, carrying ${u.share}% of recent spend`} (${u.level} account-level uncertainty)`;

// percentile bands over the candidates being compared: shown as "rank among peers" (information only: the decision uses ABSOLUTE units, see planningDemand.js)
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

// the creative gap, from the recency summary + distribution: { type, severity, text } | null when no CONFIRMED gap exists.
// Types, most urgent first: confirmed_gap, fatigue, underperforming, concentration, diversity, stale, thin. (confirmed_underperformance is kept as an alias of underperforming.)
function gapOf(sum, p, cfg, ev = null, demand = null) {
  const min = cfg.min_performing_creatives;
  if (sum.total === 0) {
    const paused = ((p.history && p.history.winners) || []).filter((w) => !w.running_now);
    return { type: 'confirmed_gap', severity: 'high', text: `No unique creative is running for this product (confirmed ads only).${paused.length ? ` ${plural(paused.length, 'creative')} that performed before ${paused.length === 1 ? 'is' : 'are'} paused or finished.` : ''}` };
  }
  const bits = [];
  if (sum.performing) bits.push(`${sum.performing} performing`);
  if (sum.declining) bits.push(`${sum.declining} showing credible fatigue`);
  if (sum.softening) bits.push(`${sum.softening} softening but still within benchmark`);
  if (sum.weak) bits.push(`${sum.weak} over the approved CPA limit${sum.clear_weak ? ` (${sum.clear_weak} clearly)` : ''}`);
  if (sum.stale && !sum.weak) bits.push(`${sum.stale} old with little delivery`);
  if (sum.testing) bits.push(`${sum.testing} still testing`);
  if (sum.unrated) bits.push(`${sum.unrated} with no approved benchmark`);
  if (sum.unjudged) bits.push(`${sum.unjudged} with too little data to judge`);
  const roll = `${plural(sum.total, 'unique creative')}: ${bits.join(', ')}.`;
  const topKey = ev && ev.top ? ev.top.key : null;
  const topFatigued = topKey && (sum.list || []).some((c) => c.key === topKey && c.state === 'declining');
  if (sum.declining > 0 && (sum.performing < min || topFatigued)) return { type: 'fatigue', severity: 'high', text: `Credible creative fatigue${topFatigued ? ' in the leading ad' : ''}: ${roll}` };
  if (sum.weak > 0 && sum.performing < min) return { type: 'underperforming', severity: sum.clear_weak ? 'high' : 'medium', text: `Confirmed underperformance: ${roll}` };
  const demandOk = !demand || ['steady', 'strong'].includes(demand.level);
  if (ev && ev.concentrated && demandOk) return { type: 'concentration', severity: 'medium', text: `Creative delivery is concentrated: ${ev.notes.find((n) => /carries|only one creative/.test(n)) || ''} ${roll}`.replace(/\s+/g, ' ').trim() };
  if (ev && ev.low_diversity && demandOk) return { type: 'diversity', severity: 'medium', text: `Too little concept diversity: ${ev.notes.find((n) => /share/.test(n)) || ''} ${roll}`.replace(/\s+/g, ' ').trim() };
  if (sum.stale > 0 && sum.performing === 0) {
    const age = sum.newest_age_days;
    return { type: 'stale', severity: 'medium', text: `Creative is old: ${roll}${age !== null ? ` The newest was launched ${plural(age, 'day')} ago.` : ''}` };
  }
  // Batch 30: coverage is judged from ALL the creatives in play, never from one unresolved condition. A creative with no approved benchmark for its funnel, or one still in its first days,
  // is still a creative that exists and delivers: it is not performing, but it is not a problem either. Only when too few creatives are in play (fewer than the number wanted) is coverage thin,
  // and a product that depends on a SINGLE creative is a real gap whatever that creative's age.
  const inPlay = sum.performing + sum.unrated + sum.testing;
  if (sum.weak === 0 && sum.declining === 0 && inPlay > 0 && inPlay < min) {
    const single = inPlay <= 1;
    return { type: 'thin', severity: single ? 'medium' : 'low', single, text: `${single ? 'Depends on a single creative' : 'Thin coverage'}: ${plural(inPlay, 'creative')} in play (${min} wanted). ${roll}` };
  }
  return null; // enough creatives in play and nothing wrong, or no creative has enough delivery to say anything: nothing confirmed
}

// a creative direction ONLY where the product's own data supports one
function directionOf(p, sum) {
  const winners = ((p.history && p.history.winners) || []).filter((w) => w.concept && !w.running_now);
  if (winners.length) {
    const w = winners[0];
    return { basis: 'product_history', text: `Re-make or refresh the "${w.concept}" concept${w.media ? ` (${String(w.media).toLowerCase()})` : ''}: it previously ran at ${w.cpa !== null && w.cpa !== undefined ? `${money(w.cpa)} CPA ` : ''}on ${money(w.spend)} spend and is paused or no longer running.` };
  }
  const perf = (sum.list || []).find((c) => (c.phase === 'performing' || c.phase === 'recent_performing') && c.concept);
  if (perf) return { basis: 'current_performer', text: `Build on the "${perf.concept}" concept: it is performing for this product${perf.cpa ? ` (${money(perf.cpa)} CPA)` : ''}. Try a genuinely different concept alongside it.` };
  const weak = (sum.list || []).filter((c) => (c.phase === 'weak' || c.phase === 'recent_weak') && c.severity !== 'marginal' && c.concept);
  if (weak.length) return { basis: 'avoid', text: `Try something other than the "${weak[0].concept}" concept: it is clearly over the approved CPA limit for this product.` };
  return null;
}

// dates the page quotes: always a real date, and always says which date it is (a creation date is not a start date)
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (ymd) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || '')); return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : null; };
function startedText(c) {
  const ago = c.age_days === null || c.age_days === undefined ? '' : ` (${plural(c.age_days, 'day')} ago)`;
  if (c.started_basis === 'first_delivery') return `began delivering on ${longDate(c.started)}${ago}`;
  if (c.started_basis === 'created') return `was created on ${longDate(c.started)}${ago}; its first delivery date is not available`;
  if (c.started_basis === 'first_stored_delivery') return `has delivery stored from ${longDate(c.started)}, but that is where our stored history may begin, so its real start is unknown`;
  return 'has no start date available';
}

function priorityOf(score, cfg) {
  const hi = cfg && cfg.priority_high_min !== undefined ? cfg.priority_high_min : 65;
  const md = cfg && cfg.priority_medium_min !== undefined ? cfg.priority_medium_min : 45;
  return score >= hi ? 'High' : score >= md ? 'Medium' : 'Low';
}

// MAIN. mode: 'core' | 'revival' | 'momentum'.  → opportunity (always returned; check .status / .actionable)
function evaluate(p, cfg, today, mode = 'core') {
  const sum = recency.summarize(p.creatives || [], today, cfg, { uploads: (p.pipeline && p.pipeline.uploaded) || [], insightsLastDay: p.insights_last_day || null });
  const ev = evidenceLib.distribution(sum.list, cfg);
  // a recent launch is measured from its OFFICIAL launch date: units since launch (not the 30-day window, which can include pre-launch orders) over the days on sale
  const recentLaunch = mode === 'momentum' && Number.isFinite(Number(p.launch_age_days)) && p.sales && p.sales.available;
  const liveDays = recentLaunch ? Number(p.launch_age_days) + 1 : (p.sales && p.sales.days_live !== undefined ? p.sales.days_live : null);
  const sinceLaunch = recentLaunch && p.sales.since_launch !== undefined && p.sales.since_launch !== null ? num(p.sales.since_launch) : null;
  const dIn = p.sales && p.sales.available ? {
    available: true,
    units7: sinceLaunch !== null && liveDays < 30 ? Math.min(num(p.sales.units7), sinceLaunch) : p.sales.units7,
    units14: p.sales.units14 === undefined || p.sales.units14 === null ? null : (sinceLaunch !== null && liveDays < 30 ? Math.min(num(p.sales.units14), sinceLaunch) : p.sales.units14),
    units30: sinceLaunch !== null && liveDays < 30 ? sinceLaunch : p.sales.units30,
    days_live: recentLaunch ? liveDays : (p.sales.days_live === undefined ? null : p.sales.days_live), since_launch: sinceLaunch,
  } : { available: false };
  const demand = demandLib.demandOf(dIn, cfg);
  const stockInfo = (extraPace) => demandLib.stockOf(p.stock && p.stock.known ? { known: true, units: p.stock.units, on_order: p.stock.on_order } : { known: false }, extraPace === undefined ? demand.pace_weekly : extraPace, cfg, p.stock && p.stock.sizes ? p.stock.sizes : null);
  let stk = stockInfo();
  const dq = p.data_quality || {};
  const trace = [];
  const gate = (key, ok, text) => { trace.push({ key, ok, text }); return ok; };

  const base = {
    key: p.key, name: p.name, category: p.category || null, image_url: p.image_url || null, codes: p.codes || [], style_codes: p.style_codes || [], is_core: !!p.is_core,
    kind: mode === 'revival' ? 'high_stock' : mode === 'momentum' ? 'momentum' : 'core', mode,
    recency: { by_phase: sum.by, newest_age_days: sum.newest_age_days, newest_source: sum.newest_source, testing_until: sum.testing_until },
    pipeline: p.pipeline ? { planned: p.pipeline.in_flight || 0, by_stage: p.pipeline.by_stage || {}, uploaded_recent: (p.pipeline.uploaded || []).length, this_week: p.pipeline.this_week || 0 } : null,
  };
  const unr = unresolvedAssessment(p.coverage, cfg);
  // Demand Planning's classification is the authoritative strong-demand signal (it is read, never recreated here)
  const tierQualifies = !!(cfg.demand_tier_qualifies && p.tier && ['platinum', 'rocket'].includes(p.tier.tier));
  let qualifiedBy = null;
  const factsOf = (extra = {}) => {
    const u30 = p.sales && p.sales.available ? Math.round(num(p.sales.units30)) : null;
    return {
      stock_units: p.stock && p.stock.known ? Math.round(num(p.stock.units)) : null, on_order: p.stock ? Math.round(num(p.stock.on_order)) : null,
      cover_weeks: stk.known ? stk.cover_weeks : null, stock_band: stk.band || null,
      units7: p.sales && p.sales.available ? Math.round(num(p.sales.units7)) : null, units14: p.sales && p.sales.available && p.sales.units14 !== undefined && p.sales.units14 !== null ? Math.round(num(p.sales.units14)) : null, units30: u30,
      demand_level: demand.level, sales_trend: demand.trend, demand_basis: demand.basis, units30_equivalent: demand.eq30 === undefined ? null : demand.eq30, weekly_pace: demand.pace_weekly === undefined ? null : demand.pace_weekly,
      days_on_sale: demand.live_days === undefined ? null : demand.live_days, since_launch_units: p.sales && p.sales.since_launch !== undefined ? p.sales.since_launch : null,
      initial28: p.sales && p.sales.initial28 !== undefined ? p.sales.initial28 : null, recent28: p.sales && p.sales.recent28 !== undefined ? p.sales.recent28 : null,
      sales_band: p.salesBand || 'unknown', tier: p.tier ? p.tier.tier : null, tier_index: p.tier ? p.tier.index : null,
      season: p.season ? p.season.label : null, season_source: p.season ? p.season.source : null, season_state: p.season ? p.season.state : null,
      active_ads: p.coverage && p.coverage.known ? p.coverage.active_ads : null, unique_creatives: sum.total, creatives_in_play: sum.performing + sum.unrated + sum.testing,
      live_creatives: sum.live, live_instances: sum.live_instances, live_starting: sum.live_starting, live_stalled: sum.live_stalled, live_unknown: sum.live_unknown, live_window_days: sum.live_window_days, performing: sum.performing, weak: sum.weak, declining: sum.declining, softening: sum.softening, testing: sum.testing,
      unrated: sum.unrated, unjudged: sum.unjudged, newest_creative_days: sum.newest_age_days, newest_creative_source: sum.newest_source, testing_until: sum.testing_until,
      top_creative_spend_share: ev.top_spend_share, top_creative_purchase_share: ev.top_purchase_share, meaningful_creatives: ev.meaningful, distinct_concepts: ev.distinct_concepts,
      matching: p.coverage && p.coverage.known ? (num(p.coverage.possible) > 0 || ['medium', 'high'].includes(unr.level) ? 'uncertain' : 'confirmed') : 'unknown', unresolved_level: unr.level, unresolved_share_pct: unr.share === undefined ? null : unr.share, matching_pending: p.coverage ? num(p.coverage.possible) : null, unresolved_identities: p.coverage ? num(p.coverage.unresolved) : null,
      launch_age_days: p.launch_age_days === undefined ? null : p.launch_age_days, launch_date: p.launch_date || null, size_warning: stk.size_note || null,
      stock_total_units: p.stock && p.stock.total_units !== undefined ? Math.round(num(p.stock.total_units)) : null, colourways_total: p.stock && p.stock.colourways ? p.stock.colourways.total : null, colourways_active: p.stock && p.stock.colourways ? p.stock.colourways.active : null, colourways_viable: p.stock && p.stock.colourways ? p.stock.colourways.viable : null,
      demand_qualified_by: qualifiedBy, tier_qualifies: tierQualifies,
      creative_conditions: sum.conditions, not_delivering: sum.not_delivering, unrated_funnels: sum.unrated_funnels, unrated_without_funnel: sum.unrated_without_funnel, newest_started: sum.newest_started, pending_uploads: (sum.pending_uploads || []).map((u) => u.date),
      sales_complete: dq.sales_complete === undefined ? null : dq.sales_complete, sales_sources_disagree: !!(dq.discrepancy && dq.discrepancy.flag),
      ...extra,
    };
  };
  const creativesOut = sum.list.map((c) => ({ key: c.key, name: c.name || null, format: c.media ? (MEDIA_LABEL[c.media] || String(c.media)) : null, live_status: c.live_status || null, live_label: LIVE_LABEL[c.live_status] || null, phase: c.phase, label: c.label, age_days: c.age_days, concept: c.concept || null, cpa: c.cpa || null, spend: c.spend, purchases: c.purchases, ads: c.ad_count, state: c.state, softening: !!(c.trend && c.trend.softening), reasons: c.reasons || [],
      condition: c.condition || null, funnel: c.funnel || null, mixed_funnels: !!c.mixed_funnels, started: c.started || null, started_basis: c.started_basis || null, created: c.created ? String(c.created instanceof Date ? c.created.toISOString() : c.created).slice(0, 10) : null,
      first_delivery: c.first_delivery || null, last_delivery: c.last_delivery || null, lifetime_spend: c.lifetime_spend === undefined ? null : c.lifetime_spend, ad_ids: (c.ads_list || []).slice(0, 3) }));
  const done = (status, reason, extra = {}) => ({
    ...base, status, status_label: STATUS_LABEL[status] || status, actionable: status === 'act', needs_review: false, stock_issue: null, priority: null, score: 0, headline: reason, why: [], reason,
    gap: null, direction: null, opportunity_type: null, opportunity_label: null, creatives: creativesOut, ...extra,
    demand, stock: stk, season: p.season || null, evidence: ev, data_quality: dq, eligibility: trace.slice(), facts: factsOf(extra.facts || {}),
  });

  // 1. launched
  if (!gate('launched', !!(p.launch && p.launch.eligible), p.launch ? p.launch.detail : 'Launch status is unknown.')) {
    return done(p.launch && p.launch.needs_check ? 'launch_unknown' : 'not_launched', p.launch ? p.launch.detail : 'Launch status is unknown.');
  }
  if (mode === 'momentum') {
    const age = p.launch_age_days;
    if (!gate('recent_launch', age !== null && age !== undefined && age >= 0 && age <= cfg.momentum_window_days, age === null || age === undefined ? 'No official launch date (ApparelMagic mid_code) to measure a recent launch from.' : `Launched ${plural(age, 'day')} ago (official mid_code date); a recent launch is within ${cfg.momentum_window_days} days.`)) {
      return done('not_recent', age === null || age === undefined ? 'It has no official launch date (ApparelMagic mid_code), so it cannot be treated as a recent launch.' : `Launched ${plural(age, 'day')} ago: older than the ${cfg.momentum_window_days}-day Protect Momentum window.`);
    }
  }
  // 2. stock: AVAILABLE sellable units only (incoming stock, reorders and open purchase orders never count), in colourways that can be shot now
  if (!p.stock || !p.stock.known) { gate('stock_known', false, 'Stock has not loaded.'); return done('unavailable', 'Stock has not loaded, so the product cannot be assessed.'); }
  const onOrderNote = num(p.stock.on_order) > 0 ? ` ${units(p.stock.on_order)} on order ${num(p.stock.on_order) === 1 ? 'does' : 'do'} not count: not available to sell yet.` : '';
  if (!gate('stock_minimum', num(p.stock.units) >= cfg.opp_min_stock_units, `${units(p.stock.units)} available sellable units (${units(cfg.opp_min_stock_units)} needed before creative is worth making).`)) {
    return done('low_stock', `${units(p.stock.units)} available sellable units, below the ${units(cfg.opp_min_stock_units)} needed before creative is worth making.${onOrderNote}`, { stock_issue: 'below_minimum' });
  }
  const cws = p.stock.colourways || null;
  if (cfg.stock_require_viable_colourway && cws && !gate('colourway_viable', cws.viable >= 1, `${cws.viable} of ${plural(cws.total, 'colourway')} can be shot now (active, ${units(cfg.opp_min_stock_units)}+ available, sizes not broken).`)) {
    const broken = cfg.stock_block_broken_sizes && p.stock.sizes && p.stock.sizes.available && p.stock.sizes.level === 'broken';
    return done('low_stock', `The family has ${units(p.stock.units)} available units, but no single colourway can be shot now: none is active with ${units(cfg.opp_min_stock_units)}+ available units and a usable size run.${broken ? ` ${p.stock.sizes.warning}.` : ''}`, { stock_issue: broken ? 'broken_sizes' : 'no_viable_colourway' });
  }
  // 3. sales
  if (!gate('sales_loaded', !!(p.sales && p.sales.available), 'Recent sales have loaded.')) return done('insufficient_data', 'Sales data has not loaded, so demand cannot be judged.');
  const u30 = num(p.sales.units30);
  if (demand.level === 'too_early') { gate('days_on_sale', false, demand.evidence[0]); return done('too_new', demand.evidence[0]); }

  // 4. season: out of season is excluded unless CURRENT demand AND creative evidence justify an exception (absolute units, never a percentile)
  let season = p.season || null;
  if (season && !season.relevant) {
    const creativeEvidence = sum.performing > 0 || ((p.history && p.history.winners) || []).length > 0;
    const compelling = demand.level === 'strong' && num(demand.eq30) >= cfg.season_override_units && demand.trend !== 'weakening' && creativeEvidence;
    if (compelling) {
      season = { ...season, relevant: true, exception: true, label: 'Out of season (exception)', weight: 0.2, reasons: [...(season.reasons || []), `Exception: it still sells ${units(demand.eq30)} units in 30 days (${cfg.season_override_units}+ needed), is not weakening, and there is creative evidence that works for it, so current demand outranks the calendar.`] };
      gate('season', true, `Out of season but compelling current demand: ${units(demand.eq30)} units in 30 days with creative evidence.`);
    } else {
      gate('season', false, `${season.label}. ${(season.reasons || [])[0] || ''} Exception needs ${cfg.season_override_units}+ units in 30 days, demand that is not weakening, and creative evidence; it has ${units(num(demand.eq30))} units${creativeEvidence ? '' : ' and no creative evidence'}.`);
      return done('out_of_season', `${season.label}. ${(season.reasons || [])[0] || ''}`.trim(), { season });
    }
  } else if (season) gate('season', true, `${season.label}.`);

  // 5. demand + mode gates
  let revival = null;
  if (mode === 'revival') {
    if (p.tierState !== 'ok') { gate('tier', false, 'Platinum / Rocket classification unavailable.'); return done('unavailable', 'The Platinum / Rocket classification is unavailable (the Report Pipeline that feeds it is not configured or has not loaded), so proven demand cannot be checked.'); }
    if (!gate('tier', !!(p.tier && ['platinum', 'rocket'].includes(p.tier.tier)), `Demand Planning classes it as ${p.tier ? p.tier.tier : 'unclassified'}.`)) return done('no_proven_demand', `No proven demand: Demand Planning classifies it as ${p.tier ? p.tier.tier.charAt(0).toUpperCase() + p.tier.tier.slice(1) : 'unclassified'}, not Platinum or Rocket. High stock alone is not a reason for more creative.`);
    qualifiedBy = 'tier';
    const age = p.sales.age_days;
    if (!gate('baseline', !(age === null || age === undefined || p.sales.initial28 === null || p.sales.initial28 === undefined), 'Its first 28 days of sales are readable.')) return done('insufficient_data', 'Its first 28 days of sales cannot be read, so launch performance cannot be compared with now.');
    if (!gate('history_56', age >= cfg.revival_min_age_days, `${plural(age, 'day')} of selling history (${cfg.revival_min_age_days} needed so the first and latest 28 days do not overlap).`)) return done('too_new', `Selling for only ${plural(age, 'day')}: needs ${cfg.revival_min_age_days} before its first 28 days and latest 28 days can be compared.`);
    const ratio = p.sales.initial28 > 0 ? num(p.sales.recent28) / p.sales.initial28 : null;
    const pct = ratio === null ? null : Math.round(ratio * 100);
    const weeks = demandLib.stockOf({ known: true, units: p.stock.units, on_order: p.stock.on_order }, demand.pace_weekly, cfg).cover_weeks; // the ONE coverage calculation: available units / weekly pace (the higher of the 30-day-equivalent and 14-day rates)
    revival = { tier: p.tier.tier, index: p.tier.index, initial28: p.sales.initial28, recent28: num(p.sales.recent28), ratio_pct: pct, weeks, age_days: age, source: 'Shopify export (Demand Planning)' };
    if (!gate('momentum_lost', !(ratio !== null && ratio * 100 >= cfg.revival_decline_pct), `Last 28 days are ${pct === null ? 'n/a' : `${pct}%`} of the first 28 days (revival considered below ${cfg.revival_decline_pct}%).`)) {
      return done('momentum_ok', `${p.tier.tier === 'platinum' ? 'Platinum' : 'Rocket'}: the last 28 days sold ${units(num(p.sales.recent28))} against ${units(p.sales.initial28)} in its first 28 days (${pct}% of launch pace), above the ${cfg.revival_decline_pct}% line, so it has not lost momentum.`, { revival });
    }
    // current demand: a historically strong product must STILL sell enough to be a realistic revival, and not be so far below its own launch pace that nothing is left to revive
    if (!gate('revival_demand', u30 >= cfg.revival_min_recent_units, `${units(u30)} units in the last 30 days (${cfg.revival_min_recent_units} needed to be a realistic revival).`)) {
      return done('weak_demand', `Only ${units(u30)} unit${u30 === 1 ? '' : 's'} sold in the last 30 days (a revival needs ${cfg.revival_min_recent_units}). It was ${p.tier.tier === 'platinum' ? 'Platinum' : 'Rocket'} once, but there is too little current demand to revive: past success is not a reason for urgent creative.`, { revival });
    }
    if (!gate('revival_pace', pct === null || pct >= cfg.revival_min_pace_pct, `Selling at ${pct === null ? 'n/a' : `${pct}%`} of its launch pace (${cfg.revival_min_pace_pct}% needed).`)) {
      return done('weak_demand', `It is selling at only ${pct}% of its own launch pace (${cfg.revival_min_pace_pct}% is the lowest worth reviving): a deeper decline is not a stronger opportunity.`, { revival });
    }
    if (!gate('revival_cover', weeks === null || weeks >= cfg.revival_min_cover_weeks, `${weeks === null ? 'n/a' : `${weeks} weeks`} of stock at the current pace (${cfg.revival_min_cover_weeks} needed).`)) {
      return done('low_stock', `${units(p.stock.units)} units is only ${weeks} weeks of stock at the current pace (${cfg.revival_min_cover_weeks} needed to justify a refresh).`, { revival, stock_issue: 'short_runway' });
    }
  } else if (mode === 'momentum') {
    // A creative gap alone never qualifies a launch. It needs Demand Planning's Platinum / Rocket signal, or STRONG selling per day on sale (the existing strong line, normalised for a part period).
    const need = cfg.launch_requires_strong_demand ? 'strong' : 'steady';
    const ok = demand.level === 'strong' || (!cfg.launch_requires_strong_demand && demand.level === 'steady');
    if (tierQualifies && demand.level !== 'very_weak') qualifiedBy = 'tier';
    else if (ok) qualifiedBy = 'strong_launch';
    if (!gate('momentum_demand', !!qualifiedBy, `${units(demand.eq30)} units in a 30-day equivalent: ${need} demand needs ${units(need === 'strong' ? cfg.demand_strong_units : cfg.demand_steady_units)}+, or a Platinum / Rocket classification from Demand Planning (${p.tier ? p.tier.tier : 'unclassified'}).`)) {
      return done('weak_demand', `A recent launch (${plural(p.launch_age_days, 'day')} on sale) selling about ${units(demand.eq30)} units in a 30-day equivalent: not the ${need} demand (${units(need === 'strong' ? cfg.demand_strong_units : cfg.demand_steady_units)}+) or Platinum / Rocket classification that justifies a new shoot. Being new, or having no creative yet, is not enough on its own.`);
    }
  } else {
    // Core: Platinum / Rocket (Demand Planning) qualifies while it is still selling; every other product needs steady selling. A creative gap alone never qualifies a product.
    if (tierQualifies && demand.level !== 'very_weak') qualifiedBy = 'tier';
    // a part-period of sales scaled up to 30 days is an ESTIMATE: it qualifies like a launch does (strong, or a Platinum / Rocket tier), never as steady selling
    else if (demand.level === 'strong' || (demand.level === 'steady' && !(demand.partial && cfg.launch_requires_strong_demand))) qualifiedBy = 'steady_sales';
    if (!gate('core_demand', !!qualifiedBy, `${units(u30)} units in the last 30 days: needs steady selling (${cfg.demand_steady_units}+), or a Platinum / Rocket classification from Demand Planning (${p.tier ? p.tier.tier : 'unclassified'}) with at least ${cfg.opp_min_recent_units} sales.`)) {
      return done('weak_demand', demand.partial && demand.level === 'steady' ? `Only ${units(u30)} unit${u30 === 1 ? '' : 's'} sold in ${plural(demand.live_days, 'day')} on sale (about ${units(demand.eq30)} in a 30-day equivalent, an estimate): that is steady at best, not the strong demand (${units(cfg.demand_strong_units)}+) or Platinum / Rocket classification that justifies a new shoot. A creative gap on its own is not a reason.` : `Only ${units(u30)} unit${u30 === 1 ? '' : 's'} sold in the last 30 days: not steady selling (${cfg.demand_steady_units}+) and not a Platinum / Rocket product. A creative gap on its own is not a reason for a new shoot.`);
    }
  }

  // 6. stock sufficiency
  stk = stockInfo();
  if (!gate('stock_cover', !['short'].includes(stk.band), (stk.notes || []).join(' '))) {
    return done('low_stock', `${units(p.stock.units)} available units is only ${stk.cover_weeks} weeks of stock at the current pace (${stk.min_weeks === undefined ? cfg.stock_min_cover_weeks : stk.min_weeks} needed for creative to pay off${stk.min_weeks > cfg.stock_min_cover_weeks ? `: ${cfg.creative_lead_time_days} days to get new creative live plus a ${cfg.test_period_days} day test period` : ''}).${onOrderNote}`, { revival, stock_issue: 'short_runway' });
  }
  if (!gate('stock_not_excess', !(stk.band === 'excess' && demand.level === 'weak'), (stk.notes || []).join(' '))) {
    return done('weak_demand', `${units(p.stock.units)} units is ${stk.cover_weeks} weeks of stock against ${units(u30)} units a month. Large unsold stock with weak demand is not a reason for more creative: demand, not creative, is the constraint.`, { revival });
  }

  // 7. creative evidence
  const flight = p.pipeline ? num(p.pipeline.in_flight) : 0;
  const min = cfg.min_performing_creatives;
  const stagesText = () => { const st = (p.pipeline && p.pipeline.by_stage) || {}; return [['planned', 'planned'], ['awaiting_production', 'awaiting production'], ['filmed', 'filmed'], ['edited', 'edited'], ['approved', 'approved']].filter(([k]) => st[k]).map(([k, l]) => `${st[k]} ${l}`).join(', ') || 'in progress'; };
  if (!p.coverage || !p.coverage.known) {
    gate('meta_data', false, 'Meta ad data is unavailable.');
    if (flight > 0) return done('in_production', `${plural(flight, 'concept')} already in the Shoot Plan pipeline (${stagesText()}).`, { revival });
    return done('insufficient_data', 'Meta ad data is unavailable, so existing creative cannot be judged. No shoot is recommended on missing data.', { revival, needs_review: true, review_reason: 'no_meta_data' });
  }
  gate('meta_data', true, 'Meta ad data is available (Meta-reported CPA; Triple Whale is not connected and is not substituted).');
  const gap = gapOf(sum, p, cfg, ev, demand);
  const testingN = sum.testing + sum.recent_uploads;
  const inPlay = sum.performing + sum.unrated + sum.testing;
  const supply = sum.performing + sum.unrated + testingN + flight;
  const possible = num(p.coverage.possible);
  const performingEnough = sum.performing >= min;

  if (performingEnough && !gap) {
    return done('covered', `${sum.performing} of ${plural(sum.total, 'unique creative')} are performing against the approved benchmark (${min} wanted)${ev.top_spend_share !== null ? `, the leading ad carries ${ev.top_spend_share}% of the spend` : ''}${sum.newest_started ? `; the newest ${startedText({ ...sum.newest_started, started: sum.newest_started.date, started_basis: sum.newest_started.basis })}` : ''}. No new creative is needed now.`, { revival });
  }
  // Enough creatives are in play even though too few can be benchmarked (a funnel has no approved benchmark, or some are in their first days): monitor, with the real picture
  if (!gap && inPlay >= min) {
    const parts = [];
    if (sum.performing) parts.push(`${sum.performing} performing against the approved benchmark`);
    if (sum.unrated) parts.push(`${sum.unrated} that cannot be benchmarked (no approved ${sum.unrated_funnels.length ? sum.unrated_funnels.join(' / ') : 'funnel'} benchmark)`);
    if (sum.testing) parts.push(`${sum.testing} in early testing`);
    return done('covered', `${plural(sum.total, 'unique creative')} ${sum.total === 1 ? 'is' : 'are'} live: ${parts.join(', ')}. Nothing found that justifies new creative this week.`, { revival });
  }
  // Concepts already in production silence a product that is not strongly selling, and any concepts testing or in production silence it once enough creatives are in play. A creative that is
  // merely new never silences a product on its own (Batch 30): a product with too few creatives still needs more, whatever the age of the one it has.
  if ((testingN > 0 || flight > 0) && (supply >= min || ((flight + sum.recent_uploads) > 0 && demand.level !== 'strong'))) {
    if (testingN > 0) {
      const until = sum.testing_until;
      const tc = sum.list.filter((c) => c.phase === 'testing').sort((a, b) => a.age_days - b.age_days);
      const what = tc.length > 0
        ? `${tc.length === 1 ? 'A creative is' : `${tc.length} creatives are`} in early testing, in the first ${cfg.new_creative_days} days of delivery (${tc.length === 1 ? 'it' : 'the newest'} ${startedText(tc[0])})`
        : `${plural(sum.recent_uploads, 'concept')} marked uploaded in the last ${cfg.test_period_days} days (WNDRR's production record, ${(sum.pending_uploads || []).map((u) => longDate(u.date)).join(', ')}) ${sum.recent_uploads === 1 ? 'has' : 'have'} no matching Meta delivery yet`;
      return done('testing', `${what}${flight > 0 ? `, and ${plural(flight, 'concept')} ${flight === 1 ? 'is' : 'are'} in the Shoot Plan pipeline` : ''}. ${supply >= min ? `With ${sum.performing} performing that is ${supply} creatives in play (${min} wanted)` : 'Demand is not strong enough to add more now'}: no further creative is recommended until ${longDate(until) || 'the test period ends'}; it will then be re-assessed.`, { revival });
    }
    return done('in_production', `${plural(flight, 'concept')} already in the Shoot Plan pipeline (${stagesText()}). ${supply >= min ? `With ${sum.performing} performing that is ${supply} creatives in play (${min} wanted)` : 'Demand is not strong enough to add more now'}: nothing more is needed until they are uploaded and have data.`, { revival });
  }
  // unresolved suggested matches are uncertainty, never a confirmed absence of creative
  const needsComplete = gap && ['confirmed_gap', 'underperforming', 'stale', 'thin', 'concentration', 'diversity'].includes(gap.type);
  if (needsComplete && possible > 0) {
    gate('matching', false, `${plural(possible, 'active ad')} awaiting review suggested for this product.`);
    return done('insufficient_data', `Matching is uncertain: ${plural(possible, 'active Meta ad')} awaiting review ${possible === 1 ? 'is' : 'are'} suggested for this product and could change its creative count (${gap.type === 'confirmed_gap' ? 'it would not be a gap' : 'the picture may be different'}). Review them in Ad Matching first; no shoot is recommended on an incomplete count.`, { revival, needs_review: true, review_reason: 'uncertain_matching' });
  }
  // Unidentified Meta ads (see unresolvedAssessment). Only a finding that rests ENTIRELY on "nothing is running for this product" is made uncertain, and only when the unidentified
  // delivery is material; findings resting on existing creative problems stay (held at Medium when it is material). Never a speculative product match.
  const unidentifiedBlocks = unr.level === 'high' && gap && gap.type === 'confirmed_gap';
  if (unidentifiedBlocks) {
    gate('matching', false, `${unresolvedText(unr)}.`);
    return done('insufficient_data', `Matching is uncertain: ${unresolvedText(unr)} (the Meta lookup for their name, campaign and creative failed), so ${unr.n === 1 ? 'it' : 'any of them'} may be running creative for this product and a "no creative running" finding cannot be confirmed (it would not be a gap). The next Meta sync retries them; the line for this is ${cfg.unresolved_spend_block_pct}% of recent spend (Settings, Planning). No shoot is recommended on an incomplete count.`, { revival, needs_review: true, review_reason: 'unidentified_ads' });
  }
  gate('matching', true, possible > 0 ? `${plural(possible, 'suggested ad')} awaiting review (does not change this finding).` : unr.n > 0 ? `${unresolvedText(unr)}: ${unr.level === 'low' ? 'a data-quality warning, below the' : 'above the'} ${cfg.unresolved_spend_note_pct}% line.` : 'Every active ad for this product is matched or reviewed.');
  if (!gap) {
    // say WHICH evidence is missing: a missing benchmark, too little delivery, ads that are not delivering, or nothing at all. They are different problems with different fixes.
    const bits = []; let reviewReason = 'no_evidence';
    if (sum.unrated) {
      const f = sum.unrated_funnels;
      bits.push(`${plural(sum.unrated, 'creative')} ${sum.unrated === 1 ? 'has' : 'have'} performance data, but there is no approved ${f.length ? f.join(' / ') : 'funnel'} benchmark to assess ${sum.unrated === 1 ? 'it' : 'them'} against${sum.unrated_without_funnel ? ` (${plural(sum.unrated_without_funnel, 'creative')} ${sum.unrated_without_funnel === 1 ? 'runs' : 'run'} in more than one funnel or none is recorded, so no single benchmark applies)` : ''}`);
      reviewReason = 'missing_benchmark';
    }
    const thin = sum.unjudged + sum.stale;
    if (thin) { bits.push(`Insufficient delivery: ${plural(thin, 'creative')} ${thin === 1 ? 'has' : 'have'} not spent enough to assess (under ${money(cfg.min_spend)} or ${units(cfg.min_impressions)} impressions in ${cfg.window_days} days)`); if (reviewReason === 'no_evidence') reviewReason = 'insufficient_delivery'; }
    if (sum.not_delivering) { bits.push(`${plural(sum.not_delivering, 'ad')} ${sum.not_delivering === 1 ? 'is' : 'are'} active in Meta but ${sum.not_delivering === 1 ? 'has' : 'have'} no delivery stored in the last ${cfg.window_days} days`); if (reviewReason === 'no_evidence') reviewReason = 'not_delivering'; }
    const why = bits.length ? `${bits.join('; ')}.` : sum.total > 0 ? 'Its creatives cannot be assessed yet.' : 'There is no creative evidence either way.';
    return done('insufficient_data', `${why} No shoot is recommended until that is resolved.`, { revival, needs_review: true, review_reason: reviewReason });
  }
  if (gap.type === 'thin' && !gap.single && demand.level !== 'strong' && mode === 'core') {
    return done('covered', `${gap.text} Demand is ${demand.level === 'steady' ? 'steady' : 'modest'}, so a thin shortfall alone does not justify action this week.`, { revival });
  }

  // ACT: score and explain
  const parts = []; let score = 0;
  const add = (pts, label, max) => { score += pts; parts.push({ label, points: pts, ...(max ? { max } : {}) }); };
  const dBase = SCORE.demand[demand.level] || 0;
  const dTrend = demand.trend === 'improving' ? SCORE.demand.improving : demand.trend === 'weakening' ? SCORE.demand.weakening : 0;
  add(Math.max(0, Math.min(SCORE.demand.max, dBase + dTrend)), `Current demand: ${demand.level.replace('_', ' ')}${demand.trend !== 'unknown' && demand.trend !== 'stable' ? `, ${demand.trend}` : ''}`, SCORE.demand.max);
  const needKey = gap.type === 'underperforming' ? (gap.severity === 'high' ? 'underperforming_clear' : 'underperforming_marginal') : gap.type;
  add(SCORE.need[needKey] || 0, `Creative need: ${(OPP_LABEL[gap.type] || gap.type).toLowerCase()}`, 28);
  if (supply > 0 && supply < min) add(SCORE.need.supply_penalty, `${plural(supply, 'creative')} already testing or in production`);
  add(stk.points, `Stock: ${stk.band.replace('_', ' ')}${stk.cover_weeks !== null && stk.cover_weeks !== undefined ? ` (${stk.cover_weeks} weeks)` : ''}`, 10);
  const sKey = !season ? 'neutral' : season.exception ? 'exception' : season.state;
  add(SCORE.season[sKey] === undefined ? 0 : SCORE.season[sKey], `Season: ${season ? season.label.toLowerCase() : 'not assessed'}`, 15);
  if (mode === 'revival') {
    add(SCORE.revival_tier[p.tier.tier] || 0, `${p.tier.tier === 'platinum' ? 'Platinum' : 'Rocket'} classification`, 10);
    const rec = SCORE.recoverability.find(([min0]) => (revival.ratio_pct === null ? 0 : revival.ratio_pct) >= min0);
    add(rec ? rec[1] : 0, `Recoverability: still at ${revival.ratio_pct === null ? 'n/a' : `${revival.ratio_pct}%`} of launch pace (a deeper decline earns less, not more)`, 8);
  } else if (mode === 'momentum') {
    add(SCORE.momentum_launch[demand.level] || 0, 'Launch strength', 8);
  } else if (p.tier && SCORE.core_tier[p.tier.tier]) add(SCORE.core_tier[p.tier.tier], `${p.tier.tier === 'platinum' ? 'Platinum' : 'Rocket'} classification`, 6);
  if (sum.newest_age_days === null) add(SCORE.recency.none, 'No new creative on record', 5);
  else if (sum.newest_age_days >= cfg.stale_creative_days) add(SCORE.recency.stale, 'No new creative for a long time', 5);
  else if (sum.newest_age_days >= cfg.recent_creative_days) add(SCORE.recency.aged, 'No recent creative', 5);
  score = Math.min(100, Math.max(0, score));

  // caps: High needs strong or steady demand AND complete, consistent data
  let priority = priorityOf(score, cfg); const caps = [];
  const cap = (text) => { if (priority === 'High') priority = 'Medium'; caps.push(text); };
  if (demand.level === 'weak') cap('Held at Medium: demand is only modest.');
  if (['slow', 'excess'].includes(stk.band)) cap(`Held at Medium: ${stk.cover_weeks} weeks of stock is more than ${stk.band === 'slow' ? cfg.stock_overstock_weeks : cfg.stock_excess_weeks} weeks, so it is a slow mover. Plenty of stock is not a reason for urgent creative.`);
  if (dq.sales_complete === false) cap(`Held at Medium: recent sales may be under-counted (${(dq.sales_notes || ['some daily sales requests failed'])[0]}).`);
  if (dq.discrepancy && dq.discrepancy.flag) cap(`Held at Medium: the two sales sources disagree (${dq.discrepancy.text}).`);
  if (season && season.exception) cap('Held at Medium: out of season, qualifying only on an exception.');
  if (mode === 'revival' && demand.level !== 'strong' && demand.trend === 'weakening') cap('Held at Medium: a revival whose sales are still weakening.');
  if (unr.level === 'medium' && gap.type === 'confirmed_gap') cap(`Held at Medium: ${unresolvedText(unr)}, so "no creative running" rests on an assumption that none of them is for this product.`);
  if (unr.level === 'high' && gap.type !== 'confirmed_gap') cap(`Held at Medium: ${unresolvedText(unr)}; the creative problem found is real, but the full creative picture is not.`);
  // a short selling window scaled to 30 days is an estimate: High needs strong demand then (steady demand stays Medium). Uses the existing strong-demand line, no new number.
  if (cfg.momentum_high_requires_strong && demand.partial && demand.level === 'steady') cap(`Held at Medium: only ${demand.live_days} days of sales, scaled to about ${Math.round(demand.eq30)} units in 30 days. That is steady, not strong (${cfg.demand_strong_units}+), and a short window is an estimate rather than an observation.`);
  if (dq.sales_complete === false || (dq.discrepancy && dq.discrepancy.flag)) { /* priority already capped */ }
  const dir = directionOf(p, sum);
  const age = sum.newest_age_days;

  // explanations: one plain sentence, then the evidence
  const demandWord = demand.level === 'strong' ? 'Strong' : demand.level === 'steady' ? 'Steady' : 'Modest';
  const stockWord = stk.band === 'healthy' ? 'sufficient stock' : stk.band === 'slow' ? 'plenty of stock' : stk.band === 'short_restock' ? 'stock with a restock on order' : 'stock';
  const creativeWord = { confirmed_gap: 'no effective creative running', underperforming: 'existing creative underperforming', fatigue: 'credible creative fatigue', concentration: 'creative delivery concentrated in one ad', diversity: 'too little concept diversity', stale: 'only old creative that is no longer delivering', thin: 'limited effective creative' }[gap.type];
  const trendWord = demand.trend === 'improving' ? ' and improving' : demand.trend === 'weakening' ? ' but weakening' : '';
  let summary;
  if (mode === 'revival') summary = `Previously successful ${p.tier.tier === 'platinum' ? 'Platinum' : 'Rocket'} product still selling ${units(u30)} units a month (${revival.ratio_pct === null ? 'n/a' : `${revival.ratio_pct}%`} of its launch pace) with ${stockWord} and ${creativeWord}.`;
  else if (mode === 'momentum') summary = `${demandWord} recent launch (${plural(p.launch_age_days, 'day')} on sale${trendWord}) with ${stockWord} and ${creativeWord}.`;
  else summary = `${demandWord} recent sales${trendWord}, ${stockWord} and ${creativeWord}.`;
  const why = [];
  why.push({ k: 'summary', text: summary });
  why.push({ k: 'gap', text: gap.text });
  why.push({ k: 'performing', text: `${sum.performing} of the ${min} performing creatives wanted are in place${supply > sum.performing ? `; ${supply - sum.performing} more ${supply - sum.performing === 1 ? 'is' : 'are'} testing or in production` : ''}.` });
  why.push({ k: 'recent', text: age === null ? 'Last new creative: none found (neither a matched Meta ad nor an upload record).' : `Last new creative: ${plural(age, 'day')} ago (${sum.newest_source === 'production' ? "WNDRR's production record" : 'Meta ad creation date'}). ${age > cfg.test_period_days ? 'It is past its test period, so it has been judged.' : ''}`.trim() });
  why.push({ k: 'demand', text: `${demand.evidence.join(' ')}${demand.basis === '30d' ? ` ${units(u30)} units in 30 days${p.sales.units7 !== undefined ? `, ${units(p.sales.units7)} in 7 days` : ''}.` : ''} (Source: ApparelMagic online sales.)` });
  if (mode === 'revival') why.push({ k: 'revival', text: `${revival.tier === 'platinum' ? 'Platinum' : 'Rocket'} (index ${revival.index}): ${units(revival.initial28)} units in its first 28 days, ${units(revival.recent28)} in the latest 28 (${revival.ratio_pct === null ? 'no baseline' : `${revival.ratio_pct}% of launch pace`}). (Source: Shopify export, Demand Planning.) A drop in sales is not automatically creative fatigue.` });
  why.push({ k: 'stock', text: (stk.notes || []).join(' ') });
  why.push({ k: 'season', text: `${season ? season.reasons.join(' ') : 'Season not assessed.'}` });
  if (ev.notes.length) why.push({ k: 'distribution', text: ev.notes.join(' ') });
  why.push({ k: 'matching', text: (possible > 0 ? `${plural(possible, 'suggested ad')} still awaiting review for this product; the findings above rest on confirmed ads.` : 'Every active ad for this product is matched or reviewed (confirmed or auto-matched ads only; DPAs are not counted).') + (unr.n > 0 ? ` Account-level: ${unresolvedText(unr)}${unr.level === 'low' ? '. That is a data-quality warning only.' : '; this finding is held at Medium until they are identified.'}` : '') });
  if (flight > 0) why.push({ k: 'production', text: `${plural(flight, 'concept')} already in the Shoot Plan pipeline (${stagesText()}); this would be additional, not a duplicate.` });
  if (dir) why.push({ k: 'direction', text: dir.text });
  const other = [];
  if (mode === 'revival') {
    if (season && season.state !== 'in_season') other.push(`Season: ${season.label.toLowerCase()}, which can lower sales regardless of creative.`);
    if (sum.performing >= 1) other.push(`${plural(sum.performing, 'creative')} ${sum.performing === 1 ? 'is' : 'are'} still performing, so creative fatigue does not explain the whole decline.`);
    if (p.coverage.active_ads < (p.coverage.min || 5)) other.push(`Only ${plural(p.coverage.active_ads, 'active ad')} support it, so reach may be limited rather than creative being worn out.`);
    other.push('Meta spend, price, markdowns, size availability and stock-outs are not measured here and could also explain the change.');
  }
  const headline = {
    confirmed_gap: `No effective creative running · ${units(u30)} units in 30 days`,
    fatigue: `Credible creative fatigue · ${units(u30)} units in 30 days`,
    underperforming: `${sum.weak} creative${sum.weak === 1 ? '' : 's'} over the approved CPA limit, ${sum.performing} performing`,
    concentration: `Delivery concentrated: leading ad carries ${ev.top_spend_share === null ? 'most' : `${ev.top_spend_share}%`} of spend`,
    diversity: `${ev.meaningful} creatives but ${ev.distinct_concepts} concept${ev.distinct_concepts === 1 ? '' : 's'}`,
    stale: `Creative is old${age !== null ? ` (newest ${age} days)` : ''} and none is performing`,
    thin: `Only ${sum.performing} of ${min} wanted creatives performing`,
  }[gap.type];
  const oppType = mode === 'revival' ? 'revive' : mode === 'momentum' ? 'protect_momentum' : gap.type;
  return {
    ...base, status: 'act', status_label: STATUS_LABEL.act, actionable: true, priority, score, score_parts: parts, caps,
    opportunity_type: oppType, opportunity_label: OPP_LABEL[oppType],
    headline: mode === 'revival' ? `${revival.tier === 'platinum' ? 'Platinum' : 'Rocket'} at ${revival.ratio_pct === null ? 'n/a' : `${revival.ratio_pct}%`} of launch pace · ${headline}` : mode === 'momentum' ? `Recent launch (${plural(p.launch_age_days, 'day')}) · ${headline}` : headline,
    why, reason: gap.text, gap, direction: dir, other_explanations: other, revival,
    demand, stock: stk, season, evidence: ev, data_quality: dq, eligibility: trace.slice(), facts: factsOf({}),
    creatives: creativesOut,
  };
}

// Display order of the result lists: actionable first (by status), then score, then, among EQUAL scores, the higher 30-day units, then name. Demand points stop growing at the strong line,
// so strong sellers of very different size can tie on score; the tie-break shows the bigger commercial opportunity first. It is only an ORDER: no score or priority changes.
const STATUS_RANK = { act: 0, testing: 1, in_production: 2, insufficient_data: 3, covered: 4, momentum_ok: 4, out_of_season: 5, weak_demand: 6, low_stock: 7, too_new: 8, no_proven_demand: 9, not_recent: 10, unavailable: 11, launch_unknown: 12, not_launched: 13 };
function compareItems(a, b) {
  const ra = STATUS_RANK[a.status] === undefined ? 99 : STATUS_RANK[a.status]; const rb = STATUS_RANK[b.status] === undefined ? 99 : STATUS_RANK[b.status];
  return (ra - rb) || (b.score - a.score) || (num(b.facts && b.facts.units30) - num(a.facts && a.facts.units30)) || String(a.name).localeCompare(String(b.name));
}

// run the engine over every candidate; computes the peer-rank bands first. mode: 'core' | 'revival' | 'momentum'
function assessAll(products, cfg, today, mode = 'core') {
  const bands = salesBands(products, cfg);
  const out = products.map((p) => {
    const salesBand = bandOf(p, bands, cfg);
    return evaluate({ ...p, salesBand }, cfg, today, mode);
  });
  return { bands, items: out };
}

module.exports = { STATUS_LABEL, OPP_LABEL, SCORE, salesBands, bandOf, coverWeeks, gapOf, directionOf, evaluate, assessAll, priorityOf, unresolvedAssessment, compareItems };
