'use strict';
// Planning, plain-English layer (Batch 28). PURE: it reads the recommendation objects the engine already produced (GET /api/opportunities) and phrases them for someone who
// does not know Meta Ads. It never recalculates demand, stock, season, coverage, effectiveness or priority, and it invents no evidence: every sentence is built from fields
// the engine returned (facts, gap, status, revival, pipeline ...), and when the evidence is missing or uncertain the sentence says so.
// Works in the browser (window.PlanningExplain) and in Node (require), so the wording is unit-tested.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlanningExplain = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  // The eight engine statuses collapse into four reader-facing categories. Nothing is removed: the engine status stays on the item and is shown in the detail.
  const CATEGORY = {
    needs: { key: 'needs', label: 'Needs creative', tab: 'Needs creative' },
    covered: { key: 'covered', label: 'Covered / monitoring', tab: 'Covered / monitoring' },
    not_recommended: { key: 'not_recommended', label: 'Not recommended', tab: 'Not recommended' },
    insufficient: { key: 'insufficient', label: 'Insufficient data', tab: 'Insufficient data' },
  };
  const CATEGORY_ORDER = ['needs', 'covered', 'not_recommended', 'insufficient'];
  const STATUS_CATEGORY = {
    act: 'needs',
    // fine as they are: enough effective creative, sales still holding, creative still gathering data, or a concept already on its way
    covered: 'covered', momentum_ok: 'covered', testing: 'covered', in_production: 'covered',
    // the engine could not confirm the creative position (or lacked sales / stock / launch data): never a guess
    insufficient_data: 'insufficient', unavailable: 'insufficient', launch_unknown: 'insufficient',
    // a reason NOT to shoot now
    out_of_season: 'not_recommended', weak_demand: 'not_recommended', low_stock: 'not_recommended', too_new: 'not_recommended',
    no_proven_demand: 'not_recommended', not_recent: 'not_recommended', not_launched: 'not_recommended',
  };
  const categoryOf = (item) => STATUS_CATEGORY[item && item.status] || 'not_recommended';

  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
  const fmt = (n) => Number(n).toLocaleString('en-AU');
  const f = (item) => (item && item.facts) || {};

  // "Selling consistently (75 units in 30 days)": the wording follows the engine's own demand level; a short window is stated as such.
  function sellingClause(item) {
    const x = f(item);
    const level = x.demand_level;
    const lead = level === 'strong' ? 'Selling strongly' : level === 'steady' ? 'Selling consistently' : level === 'weak' || level === 'very_weak' ? 'Selling slowly' : 'Selling';
    const u30 = num(x.units30);
    if (x.demand_basis === 'since_launch' && num(x.days_on_sale)) {
      // a part period is never presented as a full month: say how many days it has been on sale
      if (num(x.since_launch_units) !== null) return `${lead} (${plural(num(x.since_launch_units), 'unit')} in ${plural(num(x.days_on_sale), 'day')} on sale)`;
      if (num(x.units30_equivalent) !== null) return `${lead} (about ${plural(Math.round(num(x.units30_equivalent)), 'unit')} a month, from ${plural(num(x.days_on_sale), 'day')} on sale)`;
    }
    if (u30 === null) return lead;
    return `${lead} (${plural(u30, 'unit')} in 30 days)`;
  }

  // What is wrong (or unknown) with the creative, phrased from the engine's own gap type and counts.
  function creativeClause(item, cfg = {}) {
    const x = f(item);
    const gap = item && item.gap;
    const type = (gap && gap.type) || item.opportunity_type;
    const min = num(cfg.min_performing_creatives) || 3;
    const n = num(x.unique_creatives);
    switch (type) {
      case 'confirmed_gap': return "we haven't identified any active ads for it";
      case 'creative_gap': return "we haven't identified any active ads for it";
      case 'underperforming': return `${num(x.weak) || 0} of ${plural(n || 0, 'active creative')} ${(num(x.weak) || 0) === 1 ? 'is' : 'are'} over the approved cost-per-purchase limit and fewer than ${min} are performing`;
      case 'fatigue': return `${plural(num(x.declining) || 0, 'creative')} ${(num(x.declining) || 0) === 1 ? 'is' : 'are'} showing signs of fatigue and fewer than ${min} are performing well`;
      case 'concentration': {
        const sh = num(x.top_creative_spend_share);
        return sh !== null ? `${Math.round(sh)}% of ad spend is on a single creative` : 'almost all ad spend is on a single creative';
      }
      case 'diversity': return `the active creative covers only ${plural(num(x.distinct_concepts) || 0, 'distinct concept')}`;
      case 'stale': {
        const d = num(x.newest_creative_days);
        return `the active creative is old${d !== null ? ` (the newest launched ${plural(d, 'day')} ago)` : ''} with little delivery`;
      }
      case 'thin': return `only ${num(x.performing) || 0} of the ${min} performing creatives we want are in place`;
      default: return null;
    }
  }

  // WHY IT NEEDS CREATIVE (one short sentence) for an actionable item; the assessment sentence for everything else.
  function reasonFor(item, cfg = {}) {
    if (!item) return '';
    const x = f(item);
    const cat = categoryOf(item);
    if (cat === 'needs') {
      const clause = creativeClause(item, cfg);
      const paused = item.gap && item.gap.type === 'confirmed_gap' && /performed before/.test(item.gap.text || '');
      if (item.mode === 'momentum' || item.opportunity_type === 'protect_momentum') {
        const age = num(item.launch_age_days) !== null ? num(item.launch_age_days) : num(x.launch_age_days);
        const sell = sellingClause(item);
        const lead = `New launch${age !== null ? ` (${plural(age, 'day')} ago)` : ''}, ${sell.charAt(0).toLowerCase()}${sell.slice(1)}`;
        return `${lead}${clause ? `, but ${clause}` : ''}.`;
      }
      if (item.mode === 'revival' || item.opportunity_type === 'revive') {
        const r = item.revival && num(item.revival.ratio_pct);
        const tier = item.revival && item.revival.tier ? `${item.revival.tier === 'platinum' ? 'Platinum' : 'Rocket'} product` : 'Proven product';
        return `${tier} still selling (${plural(num(x.units30) || 0, 'unit')} in 30 days)${r !== null && r !== undefined ? ` at ${r}% of its launch pace` : ''}${clause ? `, but ${clause}` : ''}.`;
      }
      if (!clause) return `${item.reason || 'New creative would help this product.'}`;
      return `${sellingClause(item)}, but ${clause}.${paused ? ' Creative that worked before is now paused.' : ''}`;
    }
    switch (item.status) {
      case 'covered': {
        const n = num(x.unique_creatives);
        return `Enough effective creative is running${num(x.performing) !== null && n !== null ? ` (${num(x.performing)} of ${plural(n, 'creative')} performing)` : ''}.`;
      }
      case 'momentum_ok': return 'Sales are holding up since launch, so the creative in place is working.';
      case 'testing': return `${plural(num(x.testing) || 1, 'creative')} launched recently ${(num(x.testing) || 1) === 1 ? 'is' : 'are'} still gathering data, so it is too early to judge.`;
      case 'in_production': return 'A concept for this product is already in the Shoot Plan pipeline.';
      case 'insufficient_data':
      case 'unavailable': {
        if (x.matching === 'uncertain') return `Creative coverage could not be confirmed: ${plural(num(x.matching_pending) || 0, 'active ad')} awaiting review in Ad Matching may belong to this product.`;
        return "We can't confidently assess this product's creative coverage yet.";
      }
      case 'launch_unknown': return "We can't confirm this product's launch date yet, so no recommendation is made.";
      case 'out_of_season': return 'Out of season in Australia right now, so new creative is not a priority.';
      case 'weak_demand': return num(x.units30) !== null ? `Only ${plural(num(x.units30), 'unit')} sold in 30 days, which is not enough demand to justify new creative.` : (item.reason || 'Sales are too low to justify new creative.');
      case 'low_stock': return num(x.stock_units) !== null ? `Only ${plural(num(x.stock_units), 'unit')} in stock, which is too little to justify new creative.` : (item.reason || 'Stock is too low to justify new creative.');
      case 'too_new': return item.reason || 'Too early to judge: it has only just started selling.';
      case 'not_launched': return 'Not launched yet, so there is nothing to promote.';
      default: return item.reason || '';
    }
  }

  // The sentence that says WHY, with the real numbers (expanded details, section A)
  function whyWithNumbers(item) {
    const x = f(item);
    const bits = [];
    if (x.demand_basis === 'since_launch' && num(x.days_on_sale) && num(x.since_launch_units) !== null) bits.push(`${plural(num(x.since_launch_units), 'unit')} sold in ${plural(num(x.days_on_sale), 'day')} on sale`);
    else if (num(x.units30) !== null) bits.push(`${plural(num(x.units30), 'unit')} sold in 30 days${num(x.units7) !== null ? ` (${num(x.units7)} in the last 7)` : ''}`);
    if (num(x.stock_units) !== null) bits.push(`${fmt(num(x.stock_units))} in stock${num(x.cover_weeks) !== null ? ` (about ${num(x.cover_weeks)} weeks of cover)` : ''}`);
    if (num(x.unique_creatives) !== null) bits.push(x.matching === 'uncertain' ? `${plural(num(x.unique_creatives), 'confirmed active creative')} (${plural(num(x.matching_pending) || 0, 'ad')} awaiting review)` : `${plural(num(x.unique_creatives), 'active creative')}, ${num(x.performing) || 0} effective`);
    return bits.length ? `${bits.join('; ')}.` : '';
  }

  // The headline recommendation (expanded details, section A)
  function recommendationFor(item) {
    const cat = categoryOf(item);
    if (cat === 'needs') {
      if (item.mode === 'momentum') return 'Protect this launch: add it to the next shoot.';
      return 'Add this product to the next shoot.';
    }
    if (cat === 'covered') return item.status === 'in_production' ? 'A concept is already in production. No new creative is needed unless you want another.' : 'No new creative is needed right now. Keep monitoring.';
    if (cat === 'insufficient') return 'Check the data before planning creative for this product.';
    return 'Not recommended for this week.';
  }

  // General direction supported by the evidence. NOT an auto-created concept: the engine's own product-specific direction (if any) is shown after it.
  function directionFor(item) {
    const out = [];
    const type = (item.gap && item.gap.type) || item.opportunity_type;
    if (categoryOf(item) === 'needs') {
      if (type === 'confirmed_gap' || type === 'creative_gap') out.push('There is no active creative to build on, so a first concept is the starting point.');
      else if (type === 'underperforming') out.push('Try an angle that differs from the creatives that are over the approved cost-per-purchase limit.');
      else if (type === 'fatigue') out.push('Refresh the leading creative with new variations rather than running it unchanged.');
      else if (type === 'concentration') out.push('Add new concepts alongside the leading creative instead of replacing it, so results do not depend on one ad.');
      else if (type === 'diversity') out.push('Add a concept that is genuinely different from the ones already running.');
      else if (type === 'stale') out.push('Replace the old creative with something new.');
      else if (type === 'thin') out.push('Add another concept so more than one creative can carry this product.');
    }
    if (item.direction && item.direction.text) out.push(item.direction.text);
    return out;
  }

  // Key facts (expanded details, section B): label / value pairs, "Not available" where the engine does not know
  function keyFacts(item) {
    const x = f(item);
    const na = 'Not available';
    const uncertain = x.matching === 'uncertain';
    const v = (n, suffix = '') => (num(n) === null ? na : `${fmt(num(n))}${suffix}`);
    const creat = (n) => (num(x.active_ads) === null ? na : `${fmt(num(n) || 0)}${uncertain ? ` (+${num(x.matching_pending) || 0} awaiting review)` : ''}`);
    const nd = num(x.newest_creative_days);
    return [
      ['Available stock', v(x.stock_units, ' units')],
      ['Sales, last 7 days', v(x.units7)],
      ['Sales, last 30 days', v(x.units30)],
      ['Stock coverage', num(x.cover_weeks) === null ? na : `${num(x.cover_weeks)} weeks`],
      ['Active creative', creat(x.unique_creatives)],
      ['Effective creative', num(x.active_ads) === null ? na : fmt(num(x.performing) || 0)],
      ['Testing creative', num(x.active_ads) === null ? na : fmt(num(x.testing) || 0)],
      ['Unrated creative', num(x.active_ads) === null ? na : fmt(num(x.unrated) || 0)],
      ['Last new creative', nd === null ? 'None found' : nd === 0 ? 'Today' : `${plural(nd, 'day')} ago`],
    ];
  }

  // A short, subtle stock warning for the table (null when there is nothing to warn about)
  function stockWarning(item) {
    const x = f(item);
    if (['short', 'short_restock'].includes(x.stock_band) && num(x.cover_weeks) !== null) return `${num(x.cover_weeks)}w cover`;
    if (x.stock_band === 'short' || x.stock_band === 'short_restock') return 'Low cover';
    return null;
  }

  // Existing production activity (section D): from the item's pipeline summary only
  function productionActivity(item, stageLabels = {}) {
    const p = item && item.pipeline;
    if (!p || !p.planned) return { active: false, text: 'Nothing is in production for this product.' };
    const order = ['planned', 'awaiting_production', 'filmed', 'edited', 'approved', 'uploaded'];
    const st = p.by_stage || {};
    const parts = order.filter((k) => st[k]).map((k) => `${st[k]} ${(stageLabels[k] || k.replace('_', ' ')).toLowerCase()}`);
    return { active: true, count: p.planned, text: `${plural(p.planned, 'concept')} already in the Shoot Plan pipeline${parts.length ? ` (${parts.join(', ')})` : ''}.` };
  }

  // Top summary counts: real counts from the engine lists, nothing else.
  function summaryCounts(mode, data, momentum) {
    const list = (data && data.items) || [];
    const needs = list.filter((i) => categoryOf(i) === 'needs').length;
    const review = list.filter((i) => categoryOf(i) === 'insufficient').length;
    const mom = momentumItemsFor(mode, momentum);
    return { needs, protect: mom.filter((i) => i.actionable).length, review };
  }
  // Protect Momentum is an opportunity type inside Core and High Stocks: official Core products on Core, everything else (labelled "Not Core") on High Stocks.
  const momentumItemsFor = (mode, momentum) => ((momentum && momentum.items) || []).filter((i) => (mode === 'core' ? !!i.is_core : !i.is_core));

  // Weekly strip: concepts planned against the target, kept distinct from products selected and from concepts carried over from earlier weeks
  function weeklySummary(progress, productsSelected, fallbackTarget) {
    const target = progress ? num(progress.target) : num(fallbackTarget);
    const planned = progress ? (num(progress.planned) || 0) : 0;
    const remaining = progress ? (num(progress.remaining) !== null ? num(progress.remaining) : Math.max(0, (target || 0) - planned)) : null;
    const carried = progress && progress.carryover ? (num(progress.carryover.count) || 0) : 0;
    return { loaded: !!progress, planned, target, remaining, carried, products: productsSelected || 0 };
  }

  // Everything the Opportunity filter offers, derived from the loaded items (never a fixed list of products)
  const TYPE_LABEL = {
    confirmed_gap: 'No active creative', creative_gap: 'No active creative', underperforming: 'Underperforming creative', fatigue: 'Creative fatigue', concentration: 'Creative concentration',
    diversity: 'Low concept diversity', stale: 'Old creative', thin: 'Thin coverage', revive: 'Revive momentum', protect_momentum: 'Protect Momentum',
  };
  const typeLabelOf = (item) => (item.mode === 'momentum' || item.opportunity_type === 'protect_momentum' ? 'Protect Momentum' : TYPE_LABEL[(item.gap && item.gap.type) || item.opportunity_type] || null);

  return { CATEGORY, CATEGORY_ORDER, STATUS_CATEGORY, categoryOf, sellingClause, creativeClause, reasonFor, whyWithNumbers, recommendationFor, directionFor, keyFacts, stockWarning, productionActivity, summaryCounts, momentumItemsFor, weeklySummary, TYPE_LABEL, typeLabelOf };
}));
