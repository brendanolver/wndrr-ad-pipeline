'use strict';
// Planning, plain-English layer (Batch 28). PURE: it reads the recommendation objects the engine already produced (GET /api/opportunities) and phrases them for someone who
// does not know Meta Ads. It never recalculates demand, stock, season, coverage, effectiveness or priority, and it invents no evidence: every sentence is built from fields
// the engine returned (facts, gap, status, revival, pipeline ...), and when the evidence is missing or uncertain the sentence says so.
// Works in the browser (window.PlanningExplain) and in Node (require), so the wording is unit-tested.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlanningExplain = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  // The engine's statuses collapse into THREE visible categories (Batch 29). Everything else is "hidden": the underlying assessment is kept (and re-assessed on every refresh, so a product returns
  // by itself when stock or demand recovers), but it is not shown in the recommendation lists.
  const CATEGORY = {
    needs: { key: 'needs', label: 'Needs creative', tab: 'Needs creative' },
    covered: { key: 'covered', label: 'Covered / monitoring', tab: 'Covered / monitoring' },
    review: { key: 'review', label: 'Needs review', tab: 'Needs review' },
  };
  const CATEGORY_ORDER = ['needs', 'covered', 'review'];
  // A status alone does not decide the category; categoryOf() reads the item (needs_review marks an unresolved EVIDENCE problem on a product that already passed stock, demand and season)
  const STATUS_CATEGORY = {
    act: 'needs',
    covered: 'covered', testing: 'covered', in_production: 'covered',
    insufficient_data: 'review', // only when item.needs_review (see categoryOf); otherwise a data-quality matter, kept out of the lists
    // not shown in Core / High Stocks: not selling enough, not enough stock to shoot, broken sizing, out of season, no decline to revive, too new, not launched / launch not confirmed, data unavailable
    out_of_season: 'hidden', weak_demand: 'hidden', low_stock: 'hidden', too_new: 'hidden', no_proven_demand: 'hidden', not_recent: 'hidden', not_launched: 'hidden', momentum_ok: 'hidden', launch_unknown: 'hidden', unavailable: 'hidden',
  };
  function categoryOf(item) {
    const st = item && item.status;
    const c = STATUS_CATEGORY[st] || 'hidden';
    if (st === 'insufficient_data') return item.needs_review ? 'review' : 'hidden';
    return c;
  }
  const isVisible = (item) => categoryOf(item) !== 'hidden';

  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
  const fmt = (n) => Number(n).toLocaleString('en-AU');
  const f = (item) => (item && item.facts) || {};

  // Real dates, always labelled with WHICH date they are (a creation date is not a start date; overall sales are not Meta performance).
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const longDate = (ymd) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || '')); return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : null; };
  const agoText = (d) => (d === null || d === undefined ? '' : d === 0 ? ' (today)' : ` (${plural(d, 'day')} ago)`);
  // "began delivering on 18 September 2026 (30 days ago)" / "was created on ... ; its first delivery date is not available"
  function startedPhrase(st) {
    if (!st || !st.date) return 'has no start date available';
    if (st.basis === 'first_delivery') return `began delivering on ${longDate(st.date)}${agoText(st.age_days)}`;
    if (st.basis === 'created') return `was created on ${longDate(st.date)}${agoText(st.age_days)}; its first delivery date is not available`;
    return `has delivery stored from ${longDate(st.date)}, but our stored history may begin there, so its real start is unknown`;
  }
  const launchPhrase = (x) => (x.launch_date && longDate(x.launch_date) ? `launched ${longDate(x.launch_date)}${agoText(num(x.launch_age_days))}` : null);

  // The creative picture, never collapsed into one generic statement: each condition counted on its own.
  // LIVE ADS: unique creatives (never Meta ad instances) that are active AND delivered within the live window. Not counted when delivery cannot be judged or matching is unresolved.
  function liveAds(item) {
    const x = f(item);
    const win = num(x.live_window_days) || 7;
    const known = num(x.live_creatives) !== null && num(x.active_ads) !== null && !x.live_unknown;
    const pending = x.matching === 'uncertain' ? (num(x.matching_pending) || 0) : 0;
    if (!known) return { known: false, count: null, instances: null, stalled: 0, starting: 0, pending, window: win, title: x.live_unknown ? `Delivery cannot be judged: the newest stored Meta delivery day is too old.` : 'Meta ad data is unavailable.' };
    const count = num(x.live_creatives) || 0; const instances = num(x.live_instances) || 0; const stalled = num(x.live_stalled) || 0; const starting = num(x.live_starting) || 0;
    const lines = [];
    if (instances > count) lines.push(`${plural(instances, 'Meta ad')}`);
    if (stalled) lines.push(`+${stalled} not delivering`);
    if (starting) lines.push(`+${starting} just launched`);
    if (pending) lines.push(`+${pending} unreviewed`);
    const title = `${plural(count, 'unique creative')} delivered in the last ${plural(win, 'day')}${instances > count ? `, running as ${plural(instances, 'Meta ad')} (duplicates are one creative)` : ''}.${stalled ? ` ${plural(stalled, 'more active creative')} ${stalled === 1 ? 'has' : 'have'} not delivered in that time.` : ''}${starting ? ` ${plural(starting, 'creative')} launched in the last 3 days and ${starting === 1 ? 'has' : 'have'} no data yet.` : ''}${pending ? ` ${plural(pending, 'active ad')} awaiting review in Ad Matching may belong to this product, so the count may be incomplete.` : ''}`;
    return { known: true, count, instances, stalled, starting, pending, window: win, lines, title };
  }

  function conditionsSummary(item) {
    const x = f(item); const c = x.creative_conditions;
    if (!c || !num(x.unique_creatives)) return null;
    const parts = [];
    if (c.performing) parts.push(`${c.performing} performing against the approved benchmark`);
    if (c.underperforming) parts.push(`${c.underperforming} over the approved limit`);
    if (c.fatigued) parts.push(`${c.fatigued} showing signs of fatigue`);
    if (c.new) parts.push(`${c.new} in early testing`);
    if (c.missing_benchmark) parts.push(`${c.missing_benchmark} with no approved ${(x.unrated_funnels || []).join(' / ') || 'funnel'} benchmark`);
    if (c.insufficient_delivery) parts.push(`${c.insufficient_delivery} with insufficient delivery`);
    if (c.not_delivering) parts.push(`${c.not_delivering} active but not delivering`);
    const lv = liveAds(item);
    const liveBit = lv.known ? ` (${lv.count} delivering now${lv.instances > lv.count ? `, running as ${plural(lv.instances, 'Meta ad')}` : ''})` : '';
    return parts.length ? `${plural(num(x.unique_creatives), 'unique creative')}${liveBit}: ${parts.join(', ')}.` : null;
  }

  // "Selling consistently (75 units in 30 days)": the wording follows the engine's own demand level; a short window is stated as such.
  function sellingClause(item) {
    const x = f(item);
    const level = x.demand_level;
    const lead = level === 'strong' ? 'Selling strongly' : level === 'steady' ? 'Selling consistently' : level === 'weak' || level === 'very_weak' ? 'Selling slowly' : 'Selling';
    const u30 = num(x.units30);
    if (x.demand_basis === 'since_launch' && num(x.days_on_sale)) {
      // a part period is never presented as a full month: say how many days it has been on sale
      if (num(x.since_launch_units) !== null) return `${lead} (${plural(Math.round(num(x.since_launch_units)), 'unit')} in ${plural(num(x.days_on_sale), 'day')} on sale)`;
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
      case 'thin': {
        const n = num(x.creatives_in_play); const single = (gap && gap.single) || (n !== null && n <= 1);
        if (n === null) return `only ${plural(num(x.performing) || 0, 'performing creative')} ${(num(x.performing) || 0) === 1 ? 'is' : 'are'} in place (${min} wanted)`;
        return single ? 'it depends on a single creative' : `it has only ${plural(n, 'creative')} in play (${min} wanted)`;
      }
      default: return null;
    }
  }

  // WHY IT NEEDS CREATIVE (one short sentence) for an actionable item; the assessment sentence for the others.
  function reasonFor(item, cfg = {}) {
    if (!item) return '';
    const x = f(item);
    const cat = categoryOf(item);
    if (cat === 'needs') {
      const clause = creativeClause(item, cfg);
      const paused = item.gap && item.gap.type === 'confirmed_gap' && /performed before/.test(item.gap.text || '');
      const tier = x.demand_qualified_by === 'tier' && x.tier ? (x.tier === 'platinum' ? 'Platinum' : x.tier === 'rocket' ? 'Rocket' : null) : null;
      if (item.mode === 'momentum' || item.opportunity_type === 'protect_momentum') {
        const age = num(item.launch_age_days) !== null ? num(item.launch_age_days) : num(x.launch_age_days);
        const sell = sellingClause(item);
        const when = launchPhrase({ launch_date: item.launch_date || x.launch_date, launch_age_days: age }) || (age !== null ? `${plural(age, 'day')} ago` : null);
        const lead = `New launch${when ? ` (${when})` : ''}, ${sell.charAt(0).toLowerCase()}${sell.slice(1)}`;
        return `${lead}${clause ? `, but ${clause}` : ''}.`;
      }
      if (item.mode === 'revival' || item.opportunity_type === 'revive') {
        const r = item.revival && num(item.revival.ratio_pct);
        const t = item.revival && item.revival.tier ? `${item.revival.tier === 'platinum' ? 'Platinum' : 'Rocket'} product` : 'Proven product';
        return `${t} still selling (${plural(num(x.units30) || 0, 'unit')} in 30 days)${r !== null && r !== undefined ? ` at ${r}% of its launch pace` : ''}${clause ? `, but ${clause}` : ''}.`;
      }
      if (!clause) return `${item.reason || 'New creative would help this product.'}`;
      const sell = sellingClause(item);
      return `${tier ? `${tier} product. ` : ''}${sell}, but ${clause}.${paused ? ' Creative that worked before is now paused.' : ''}`;
    }
    switch (item.status) {
      case 'covered': {
        const pic = conditionsSummary(item);
        const min = num(cfg.min_performing_creatives) || 3;
        if (pic && num(x.performing) !== null && num(x.performing) >= min) return `Enough effective creative is running. ${pic}`;
        if (pic) return `${pic} Enough creatives are in play and none is clearly failing, so no new creative is needed this week.`;
        return item.reason || 'Enough creative is in play.';
      }
      // Overall sales are product demand: they say nothing about whether Meta creative is working.
      case 'momentum_ok': return 'Sales have held up since launch. That is product demand, not evidence about Meta creative.';
      case 'testing': {
        const st = x.newest_started; const n = (x.creative_conditions && x.creative_conditions.new) || num(x.testing) || 0;
        if (n > 0 && st) { const pic = conditionsSummary(item); return `${n === 1 ? 'A creative is' : `${n} creatives are`} in early testing: ${n === 1 ? 'it' : 'the newest'} ${startedPhrase({ date: st.date, basis: st.basis, age_days: st.age_days })}.${pic ? ` ${pic}` : ''} Enough creative is in play for now.`; }
        const pu = (x.pending_uploads || []).map(longDate).filter(Boolean);
        if (pu.length) return `${pu.length === 1 ? 'A concept was' : `${pu.length} concepts were`} marked uploaded on ${pu.join(', ')} (production record); no matching Meta delivery found yet.`;
        return 'New creative is in early testing and enough creative is in play for now.';
      }
      case 'in_production': return 'A concept for this product is already in the Shoot Plan pipeline.';
      case 'insufficient_data':
      case 'unavailable': {
        const c = x.creative_conditions || {};
        switch (item.review_reason) {
          case 'uncertain_matching': return `Creative coverage could not be confirmed: ${plural(num(x.matching_pending) || 0, 'active ad')} awaiting review in Ad Matching may belong to this product.`;
          case 'unidentified_ads': return "Some Meta ads couldn't be identified, so we can't confirm whether this product has creative running.";
          case 'missing_benchmark': {
            const fs = (x.unrated_funnels || []).join(' / ');
            const n = num(x.unrated) || c.missing_benchmark || 0;
            return `${n === 1 ? 'This ad has' : `These ${n} ads have`} performance data, but there is no approved ${fs || 'funnel'} benchmark to assess ${n === 1 ? 'it' : 'them'} against.`;
          }
          case 'insufficient_delivery': return `Insufficient delivery: ${(c.insufficient_delivery || 0) === 1 ? 'the live creative has' : `${c.insufficient_delivery || 'the live'} creatives have`} not spent enough (or had enough impressions) to assess.`;
          case 'not_delivering': return `${plural(c.not_delivering || num(x.not_delivering) || 0, 'ad')} ${(c.not_delivering || 0) === 1 ? 'is' : 'are'} active in Meta but not delivering, so there is no performance to assess.`;
          case 'no_meta_data': return 'Meta ad data is unavailable, so creative coverage could not be checked.';
          case 'no_evidence': return 'There is no Meta creative evidence for this product either way.';
          default:
            if (x.matching === 'uncertain') return `Creative coverage could not be confirmed: ${plural(num(x.matching_pending) || 0, 'active ad')} awaiting review in Ad Matching may belong to this product.`;
            return "We can't confidently assess this product's creative coverage yet.";
        }
      }
      case 'launch_unknown': return "We can't confirm this product's launch date yet, so no recommendation is made.";
      case 'out_of_season': return 'Out of season in Australia right now, so new creative is not a priority.';
      case 'weak_demand': return num(x.units30) !== null ? `Only ${plural(num(x.units30), 'unit')} sold in 30 days, which is not enough demand to justify new creative.` : (item.reason || 'Sales are too low to justify new creative.');
      case 'low_stock': return stockRestriction(item).text || (item.reason || 'Stock is too low to justify new creative.');
      case 'too_new': return item.reason || 'It has only just started selling: too few days of sales to judge demand.';
      case 'not_launched': return 'Not launched yet, so there is nothing to promote.';
      default: return item.reason || '';
    }
  }

  // Why a product cannot be shot now (stock): for already-planned work this is a WARNING, never a removal.
  function stockRestriction(item) {
    const x = f(item);
    const issue = item && item.stock_issue;
    if (!item || item.status !== 'low_stock') return { restricted: false, text: null, issue: null };
    if (issue === 'below_minimum' && num(x.stock_units) !== null) return { restricted: true, issue, text: `Only ${plural(num(x.stock_units), 'unit')} available, below the minimum needed to shoot.` };
    if (issue === 'short_runway') return { restricted: true, issue, text: `Only ${num(x.cover_weeks) !== null ? `${num(x.cover_weeks)} weeks` : 'a short time'} of available stock at the current sales pace.` };
    if (issue === 'broken_sizes') return { restricted: true, issue, text: 'Sizing is broken: too many sizes are low or sold out.' };
    if (issue === 'no_viable_colourway') return { restricted: true, issue, text: 'No single colourway has the stock and sizes to shoot now.' };
    return { restricted: true, issue: issue || 'stock', text: item.reason || 'Stock is too low to shoot now.' };
  }

  // The sentence that says WHY, with the real numbers (expanded details, section A)
  function whyWithNumbers(item) {
    const x = f(item);
    const bits = [];
    if (x.demand_basis === 'since_launch' && num(x.days_on_sale) && num(x.since_launch_units) !== null) bits.push(`${plural(Math.round(num(x.since_launch_units)), 'unit')} sold in ${plural(num(x.days_on_sale), 'day')} on sale`);
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
    if (cat === 'covered') return item.status === 'in_production' ? 'A concept is already in production. No new creative is needed unless you want another.' : item.status === 'testing' ? 'Wait for the new creative to gather data before planning more.' : 'No new creative is needed right now. Keep monitoring.';
    if (cat === 'review') return 'Resolve the evidence issue before planning creative for this product.';
    return 'No new creative is recommended for this product right now.';
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
    const c = x.creative_conditions || {};
    const st = x.newest_started;
    return [
      ['Available stock', v(x.stock_units, ' units')],
      ['Sales, last 7 days', v(x.units7)],
      ['Sales, last 30 days', v(x.units30)],
      ['Stock coverage', num(x.cover_weeks) === null ? na : `${num(x.cover_weeks)} weeks`],
      ['Live ads', (() => { const lv = liveAds(item); return lv.known ? `${lv.count} unique${lv.instances > lv.count ? ` (${plural(lv.instances, 'Meta ad')})` : ''}${lv.stalled ? `, ${lv.stalled} active not delivering` : ''}${lv.pending ? ` (+${lv.pending} awaiting review)` : ''}` : na; })()],
      ['Active creative', creat(x.unique_creatives)],
      ['Effective creative', num(x.active_ads) === null ? na : fmt(num(x.performing) || 0)],
      ['New creative', num(x.active_ads) === null ? na : fmt(num(c.new !== undefined ? c.new : x.testing) || 0)],
      ['Unrated creative', num(x.active_ads) === null ? na : fmt(num(x.unrated) || 0)],
      ['Product launched', launchPhrase(x) ? launchPhrase(x).replace(/^launched /, '') : na],
      ['Latest creative started', st ? `${longDate(st.date)}${agoText(st.age_days)}${st.basis === 'first_delivery' ? '' : st.basis === 'created' ? ', ad created (first delivery date not available)' : ', stored history may begin here'}` : 'None found'],
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
    const review = list.filter((i) => categoryOf(i) === 'review').length;
    const mom = momentumItemsFor(mode, data, momentum);
    return { needs, protect: mom.filter((i) => i.actionable).length, review };
  }
  // Protect Momentum is an opportunity type inside Core and High Stocks, not a status or a page. The engine places an official Core product's Protect Momentum result in the
  // Core list (it keeps its Core identity); a non-Core recent launch is placed in the separate momentum list. So: Core = Core-list items whose primary type is Protect Momentum;
  // High Stocks = the non-Core recent launches (shown labelled "Not Core: recent launch").
  const isMomentum = (i) => !!i && (i.mode === 'momentum' || i.opportunity_type === 'protect_momentum');
  function momentumItemsFor(mode, data, momentum) {
    const own = ((data && data.items) || []).filter(isMomentum);
    const placed = ((momentum && momentum.items) || []).filter((i) => (mode === 'core' ? !!i.is_core : !i.is_core));
    const seen = new Set(); const out = [];
    own.concat(placed).forEach((i) => { if (!seen.has(i.key)) { seen.add(i.key); out.push(i); } });
    return out;
  }

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

  return { liveAds, CATEGORY, CATEGORY_ORDER, STATUS_CATEGORY, categoryOf, isVisible, longDate, startedPhrase, conditionsSummary, stockRestriction, sellingClause, creativeClause, reasonFor, whyWithNumbers, recommendationFor, directionFor, keyFacts, stockWarning, productionActivity, summaryCounts, momentumItemsFor, weeklySummary, TYPE_LABEL, typeLabelOf };
}));
